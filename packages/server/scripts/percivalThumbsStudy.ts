/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * Percival and his two thumbs (Merlin / Morgana) — human data
 * (Edward 2026-10-14, docs/ai/percival_thumbs.md).
 *
 *   pnpm --filter @avalon/server exec tsx scripts/percivalThumbsStudy.ts \
 *     [--player ED --player Sin] [--agent] [--legacy] [--flag NAME[=V] ...] \
 *     [--json out.json] [--cache PATH]
 *
 * Reads `sheets_cache.json` → `牌譜` with the strict replay parser of the
 * agreement benchmark (`parseReplayGame`). The captain rotates from seat 1 on
 * every proposal (seat 10 last), so a thumb "acts before Percival" when its
 * seat is lower than his: configuration C2 / C1 / C0 = how many thumbs lead a
 * proposal before Percival's first captain turn. Bins fixed before any
 * outcome was looked at:
 *   - configuration C2 / C1 / C0;
 *   - Percival's seat group: 1–4 (first turn = an R1 talk proposal, P1–P4),
 *     5 (first turn = the forced R1 5th proposal, which goes on the mission),
 *     6–10 (first turn in R2 or later, after the R1 mission); also seat 1..10;
 *   - each thumb's seat group (same three groups), Merlin's × Morgana's;
 *   - for later proposals, the public / private evidence that tells the
 *     thumbs apart (own lake on a thumb > exactly one thumb on a failed
 *     mission > another holder's lake claim on a thumb > none).
 * Sections (every rate with n and a Wilson 95% interval):
 *   (a) configuration counts; (b) Percival's first proposal: 0 / 1 / 2 thumbs
 *   against a random team with the same number of other seats, and with one
 *   thumb, whether it is the real Merlin; earlier thumbs' teams with him on
 *   them; (c) outcome blocks (任務 = 三藍, 刺殺 = 三藍活 | 三藍, 遊戲 = 三藍活)
 *   by configuration × thumbs on the first proposal, plus whether that
 *   proposal passed and its mission succeeded; (d) later proposals by round,
 *   configuration and evidence; (e) Percival's lake: thumb laked vs a random
 *   valid target, which thumb, the claim, outcome blocks.
 * With `--agent` it replays the Percival seat of every game through the
 * production agent (`HeuristicAgent.act` / `pickLakeTarget`, same seeding as
 * the agreement benchmark; `--flag` / `--legacy` as there) and prints the
 * agent's thumb choices on the same decisions plus the targeted agreement:
 * same thumb set as the human (none / Merlin / Morgana / both), exact team,
 * Jaccard; lake target.
 *
 * Output is aggregate only; `--player NAME` adds rows for that player's
 * Percival games under the label given (the public docs use the ED / Sin
 * labels only). Names are never printed.
 */

import * as fs from 'fs';
import * as path from 'path';
import { rowsFromSheet, parseReplayGame, type ReplayGame } from '../src/ai/benchmark/sheetsReplay';
import { seatId, validLakeTargetSeats } from '../src/ai/benchmark/replayObservation';
import { computeTopPerformers, cohortKey } from '../src/ai/benchmark/cohorts';
import { replayGame, jaccard } from '../src/ai/benchmark/agreement';
import { HeuristicAgent } from '../src/ai/HeuristicAgent';
import {
  LEGACY_AGENT_TUNING,
  describeAgentTuning,
  parseTuningFlag,
  resolveAgentTuning,
  type AgentTuning,
} from '../src/ai/AgentTuning';
import { getForwardTelemetry } from '../src/ai/forward/ForwardAgent';
import { setEvilLakeHumanOptions, evilLakeHumanOptionsFromEnv } from '../src/ai/LakePolicy';
import { setVouchFollowUpOptions, vouchFollowUpOptionsFromEnv } from '../src/ai/RedLakeFollowUp';
import { goodVouchOptionsFromEnv, setGoodVouchOptions } from '../src/ai/GoodLakeFollowUp';
import { setTeamReuseOptions, teamReuseOptionsFromEnv } from '../src/ai/TeamReuse';
import { redR1TeammateOptionsFromEnv, setRedR1TeammateOptions } from '../src/ai/RedR1Teammate';

interface Args {
  players: string[];
  json?: string;
  cache: string;
  agent: boolean;
  legacy: boolean;
  flags: Partial<AgentTuning>;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    players: [],
    cache: path.resolve(__dirname, '..', 'sheets_cache.json'),
    agent: false,
    legacy: false,
    flags: {},
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case '--player': args.players.push(...next().split(',').map((s) => s.trim()).filter(Boolean)); break;
      case '--json': args.json = next(); break;
      case '--cache': args.cache = path.resolve(next()); break;
      case '--agent': args.agent = true; break;
      case '--legacy': args.legacy = true; break;
      case '--flag': Object.assign(args.flags, parseTuningFlag(next())); break;
      case '--help': case '-h':
        console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
        process.exit(0);
        break;
      default: throw new Error(`unknown argument ${a}`);
    }
  }
  return args;
}

// ── Statistics ─────────────────────────────────────────────────

export interface Rate {
  k: number;
  n: number;
  rate: number;
  low: number;
  high: number;
}

/** Wilson 95% score interval. */
export function wilsonRate(k: number, n: number): Rate {
  if (n === 0) return { k, n, rate: 0, low: 0, high: 0 };
  const z = 1.959964;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { k, n, rate: p, low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

/** Newcombe (hybrid Wilson) 95% interval for the difference a − b of two independent proportions. */
export function diffInterval(a: Rate, b: Rate): { d: number; low: number; high: number } {
  const d = a.rate - b.rate;
  return {
    d,
    low: d - Math.sqrt((a.rate - a.low) ** 2 + (b.high - b.rate) ** 2),
    high: d + Math.sqrt((a.high - a.rate) ** 2 + (b.rate - b.low) ** 2),
  };
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function pp(x: number): string {
  return `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)}pp`;
}

function fmt(r: Rate): string {
  if (r.n === 0) return '— (n=0)';
  return `${pct(r.rate)} [${pct(r.low)}, ${pct(r.high)}] ${r.k}/${r.n}`;
}

function rateOf<T>(items: readonly T[], pred: (x: T) => boolean): Rate {
  return wilsonRate(items.filter(pred).length, items.length);
}

function mean(xs: readonly number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function choose(n: number, r: number): number {
  if (r < 0 || r > n) return 0;
  let out = 1;
  for (let i = 1; i <= r; i++) out = (out * (n - r + i)) / i;
  return out;
}

/** P(k of the 2 thumbs) when `others` seats are drawn at random from the 9 seats other than Percival. */
export function randomThumbShare(others: number, k: 0 | 1 | 2): number {
  const total = choose(9, others);
  if (total === 0) return 0;
  return (choose(2, k) * choose(7, others - k)) / total;
}

// ── Records ────────────────────────────────────────────────────

export type SeatGroup = 'talk' | 'forced' | 'r2plus';

/** Captain-turn group of a seat (R1 almost always has five proposals). */
export function seatGroupOf(seat: number): SeatGroup {
  return seat <= 4 ? 'talk' : seat === 5 ? 'forced' : 'r2plus';
}

const SEAT_GROUP_LABEL: Record<SeatGroup, string> = {
  talk: 'seats 1–4 (R1 talk P1–P4)',
  forced: 'seat 5 (R1 forced P5)',
  r2plus: 'seats 6–10 (R2+)',
};

export type Thumb = 'merlin' | 'morgana';
export type Evidence = 'ownLake' | 'failSplit' | 'otherLake' | 'none';

export interface ThumbChoice {
  merlinOn: boolean;
  morganaOn: boolean;
}

export function thumbSet(c: ThumbChoice): 'none' | 'merlin' | 'morgana' | 'both' {
  if (c.merlinOn && c.morganaOn) return 'both';
  if (c.merlinOn) return 'merlin';
  if (c.morganaOn) return 'morgana';
  return 'none';
}

/** Random-team level for "≥ 1 thumb" over a set of proposals ("—" when empty). */
function randomAtLeastOne(props: readonly PercivalProposal[]): string {
  return props.length === 0 ? '—' : pct(1 - mean(props.map((p) => randomThumbShare(p.others, 0))));
}

function thumbCount(c: ThumbChoice): number {
  return (c.merlinOn ? 1 : 0) + (c.morganaOn ? 1 : 0);
}

export interface AgentTeam extends ThumbChoice {
  exact: boolean;
  jac: number;
  selfOn: boolean;
}

export interface PercivalProposal extends ThumbChoice {
  index: number;
  /** 1 = Percival's first captain turn. */
  nth: number;
  round: number;
  attempt: number;
  forced: boolean;
  selfOn: boolean;
  /** Team members other than Percival. */
  others: number;
  passed: boolean;
  /** Mission result when this team went; null otherwise. */
  missionFailed: boolean | null;
  evidence: Evidence;
  /** The thumb the evidence points to as Merlin (its real identity); null when evidence = none. */
  favoured: Thumb | null;
  /**
   * Added after the first run (descriptive only, not one of the fixed bins):
   * exactly one thumb has been on a successful mission → that thumb.
   */
  successFavoured: Thumb | null;
  agent?: AgentTeam;
}

export interface EarlierThumbLead {
  thumb: Thumb;
  /** Its last proposal before Percival's first turn had Percival on it. */
  includedPercival: boolean;
}

export interface PercivalLake {
  /** 1st / 2nd / 3rd lake of the game. */
  nth: number;
  round: number;
  score: string;
  valid: number;
  thumbsValid: number;
  target: Thumb | 'other';
  claim: 'good' | 'evil' | null;
  agentTarget?: Thumb | 'other';
}

export interface PercivalRecord {
  gameId: string;
  name: string;
  seat: number;
  merlinSeat: number;
  morganaSeat: number;
  config: 0 | 1 | 2;
  seatGroup: SeatGroup;
  /** C1: which thumb leads before Percival. */
  earlierThumb: Thumb | null;
  earlierLeads: EarlierThumbLead[];
  proposals: PercivalProposal[];
  lakes: PercivalLake[];
  lakeChainValid: boolean;
  threeBlue: boolean;
  blueWin: boolean;
}

function evidenceAt(game: ReplayGame, seat: number, merlin: number, morgana: number, round: number): { evidence: Evidence; favoured: Thumb | null } {
  const lakes = game.lakes.filter((l) => l.round < round);
  const own = lakes.find((l) => l.holderSeat === seat && (l.targetSeat === merlin || l.targetSeat === morgana));
  if (own) return { evidence: 'ownLake', favoured: 'merlin' };
  const quests = game.quests.filter((q) => q.round < round && q.failed);
  const dirtyM = quests.some((q) => q.teamSeats.includes(merlin));
  const dirtyG = quests.some((q) => q.teamSeats.includes(morgana));
  if (dirtyM !== dirtyG) return { evidence: 'failSplit', favoured: dirtyM ? 'morgana' : 'merlin' };
  // Another holder's public claim on a thumb: good → that thumb, evil → the other one.
  const votes: Thumb[] = [];
  for (const l of lakes) {
    if (l.holderSeat === seat || l.claim === null) continue;
    if (l.targetSeat !== merlin && l.targetSeat !== morgana) continue;
    const t: Thumb = l.targetSeat === merlin ? 'merlin' : 'morgana';
    const other: Thumb = t === 'merlin' ? 'morgana' : 'merlin';
    votes.push(l.claim === 'good' ? t : other);
  }
  if (votes.length > 0 && votes.every((v) => v === votes[0])) return { evidence: 'otherLake', favoured: votes[0] };
  return { evidence: 'none', favoured: null };
}

function scoreBefore(game: ReplayGame, round: number): string {
  const qs = game.quests.filter((q) => q.round <= round);
  const red = qs.filter((q) => q.failed).length;
  return `${qs.length - red}:${red}`;
}

export function collectRecords(games: readonly ReplayGame[]): PercivalRecord[] {
  const out: PercivalRecord[] = [];
  for (const game of games) {
    const seat = game.seatRoles.indexOf('percival') + 1;
    const merlinSeat = game.seatRoles.indexOf('merlin') + 1;
    const morganaSeat = game.seatRoles.indexOf('morgana') + 1;
    if (seat <= 0 || merlinSeat <= 0 || morganaSeat <= 0) continue;
    const config = ((merlinSeat < seat ? 1 : 0) + (morganaSeat < seat ? 1 : 0)) as 0 | 1 | 2;
    const led = game.proposals.filter((p) => p.leaderSeat === seat);
    const first = led[0];
    const earlierLeads: EarlierThumbLead[] = [];
    if (first) {
      for (const [thumb, ts] of [['merlin', merlinSeat], ['morgana', morganaSeat]] as const) {
        const theirs = game.proposals.filter((p) => p.leaderSeat === ts && p.globalIndex < first.globalIndex);
        const last = theirs[theirs.length - 1];
        if (last) earlierLeads.push({ thumb, includedPercival: last.teamSeats.includes(seat) });
      }
    }
    const proposals: PercivalProposal[] = led.map((p, i) => {
      const q = game.quests.find((x) => x.round === p.round);
      const ev = evidenceAt(game, seat, merlinSeat, morganaSeat, p.round);
      const won = game.quests.filter((x) => x.round < p.round && !x.failed);
      const succM = won.some((x) => x.teamSeats.includes(merlinSeat));
      const succG = won.some((x) => x.teamSeats.includes(morganaSeat));
      return {
        index: p.globalIndex,
        nth: i + 1,
        round: p.round,
        attempt: p.attempt,
        forced: p.forced,
        selfOn: p.teamSeats.includes(seat),
        others: p.teamSeats.filter((s) => s !== seat).length,
        merlinOn: p.teamSeats.includes(merlinSeat),
        morganaOn: p.teamSeats.includes(morganaSeat),
        passed: p.wentOnMission,
        missionFailed: p.wentOnMission && q ? q.failed : null,
        evidence: ev.evidence,
        favoured: ev.favoured,
        successFavoured: succM !== succG ? (succM ? 'merlin' : 'morgana') : null,
      };
    });
    const lakes: PercivalLake[] = [];
    if (game.lakeChainValid) {
      game.lakes.forEach((l, i) => {
        if (l.holderSeat !== seat) return;
        const valid = validLakeTargetSeats(game, i);
        lakes.push({
          nth: i + 1,
          round: l.round,
          score: scoreBefore(game, l.round),
          valid: valid.length,
          thumbsValid: valid.filter((s) => s === merlinSeat || s === morganaSeat).length,
          target: l.targetSeat === merlinSeat ? 'merlin' : l.targetSeat === morganaSeat ? 'morgana' : 'other',
          claim: l.claim,
        });
      });
    }
    const blueMissions = game.quests.filter((q) => !q.failed).length;
    out.push({
      gameId: game.id,
      name: game.names[seat - 1] ?? '',
      seat,
      merlinSeat,
      morganaSeat,
      config,
      seatGroup: seatGroupOf(seat),
      earlierThumb: config === 1 ? (merlinSeat < seat ? 'merlin' : 'morgana') : null,
      earlierLeads,
      proposals,
      lakes,
      lakeChainValid: game.lakeChainValid,
      threeBlue: blueMissions >= 3,
      blueWin: game.winner === 'good',
    });
  }
  return out;
}

// ── Sections ───────────────────────────────────────────────────

interface Row {
  label: string;
  rate?: Rate;
  text?: string;
}

interface Section {
  title: string;
  rows: Row[];
  note?: string;
}

function printSections(label: string, sections: readonly Section[]): void {
  console.log(`\n================ ${label} ================`);
  for (const s of sections) {
    console.log(`\n${s.title}`);
    for (const r of s.rows) console.log(`  ${r.label.padEnd(60)} ${r.rate ? fmt(r.rate) : (r.text ?? '')}`);
    if (s.note) console.log(`  (${s.note})`);
  }
}

const CONFIGS: Array<0 | 1 | 2> = [2, 1, 0];
const GROUPS: SeatGroup[] = ['talk', 'forced', 'r2plus'];

function configLabel(c: number): string {
  return `C${c} (${c} thumb${c === 1 ? '' : 's'} lead before)`;
}

function firstOf(r: PercivalRecord): PercivalProposal | undefined {
  return r.proposals[0];
}

/** Thumb-count shares of a set of proposals, with the random-team level for the same number of other seats. */
function thumbRows(label: string, props: readonly PercivalProposal[], choice: (p: PercivalProposal) => ThumbChoice = (p) => p): Row[] {
  const base = [0, 1, 2].map((k) => mean(props.map((p) => randomThumbShare(p.others, k as 0 | 1 | 2))));
  const one = props.filter((p) => thumbCount(choice(p)) === 1);
  return [
    { label: `${label}: 0 thumbs (random ${pct(base[0])})`, rate: rateOf(props, (p) => thumbCount(choice(p)) === 0) },
    { label: `${label}: 1 thumb (random ${pct(base[1])})`, rate: rateOf(props, (p) => thumbCount(choice(p)) === 1) },
    { label: `${label}: 2 thumbs (random ${pct(base[2])})`, rate: rateOf(props, (p) => thumbCount(choice(p)) === 2) },
    { label: `${label}: with 1 thumb, it is Merlin (random 50%)`, rate: rateOf(one, (p) => choice(p).merlinOn) },
  ];
}

function sectionA(recs: readonly PercivalRecord[]): Section[] {
  const rows: Row[] = [];
  for (const c of CONFIGS) {
    const sub = recs.filter((r) => r.config === c);
    rows.push({ label: configLabel(c), text: `n=${sub.length} (${GROUPS.map((g) => `${g} ${sub.filter((r) => r.seatGroup === g).length}`).join(', ')})` });
  }
  rows.push({
    label: 'Percival seat 1..10',
    text: Array.from({ length: 10 }, (_, i) => `${i + 1}:${recs.filter((r) => r.seat === i + 1).length}`).join(' '),
  });
  rows.push({ label: 'no captain turn at all (game ended first)', rate: rateOf(recs, (r) => r.proposals.length === 0) });
  rows.push({ label: 'C1: the thumb leading first is Merlin', rate: rateOf(recs.filter((r) => r.config === 1), (r) => r.earlierThumb === 'merlin') });
  return [{ title: '(a) configuration (thumbs seated before Percival = lead before his first turn)', rows }];
}

function sectionB(recs: readonly PercivalRecord[]): Section[] {
  const withFirst = recs.filter((r) => firstOf(r));
  const first = (xs: readonly PercivalRecord[]): PercivalProposal[] => xs.map((r) => firstOf(r)).filter((p): p is PercivalProposal => !!p);
  const sections: Section[] = [];
  sections.push({
    title: "(b) Percival's first proposal — all",
    rows: [
      ...thumbRows('all', first(withFirst)),
      { label: 'Percival on his own team', rate: rateOf(first(withFirst), (p) => p.selfOn) },
      { label: 'that proposal went on the mission', rate: rateOf(first(withFirst), (p) => p.passed) },
    ],
  });
  // Every Percival-led R1 proposal (seat 1–5; first turn, rarely the second when R1 ends early).
  const r1All = recs.flatMap((r) => r.proposals.filter((p) => p.round === 1));
  sections.push({
    title: '(b) every Percival-led R1 proposal (no mission result yet)',
    rows: [
      ...thumbRows('R1 all', r1All),
      ...thumbRows('R1 talk (attempts 1–4)', r1All.filter((p) => !p.forced)),
      ...thumbRows('R1 forced (attempt 5)', r1All.filter((p) => p.forced)),
    ],
  });
  sections.push({
    title: "(b) first proposal by configuration",
    rows: CONFIGS.flatMap((c) => thumbRows(`C${c}`, first(withFirst.filter((r) => r.config === c)))),
  });
  sections.push({
    title: "(b) first proposal by Percival's seat group",
    rows: GROUPS.flatMap((g) => thumbRows(SEAT_GROUP_LABEL[g], first(withFirst.filter((r) => r.seatGroup === g)))),
  });
  sections.push({
    title: '(b) first proposal by configuration × seat group (≥ 1 thumb; random level for ≥ 1 in the label)',
    rows: GROUPS.flatMap((g) => CONFIGS.map((c) => {
      const props = first(withFirst.filter((r) => r.seatGroup === g && r.config === c));
      return { label: `${g} C${c} (random ${randomAtLeastOne(props)})`, rate: rateOf(props, (p) => thumbCount(p) > 0) };
    })),
  });
  sections.push({
    title: '(b) first proposal by Percival seat (≥ 1 thumb | 2 thumbs | 1 thumb = Merlin)',
    rows: Array.from({ length: 10 }, (_, i) => {
      const props = first(withFirst.filter((r) => r.seat === i + 1));
      const one = props.filter((p) => thumbCount(p) === 1);
      return {
        label: `seat ${i + 1} (random ≥1 ${randomAtLeastOne(props)})`,
        text: `${fmt(rateOf(props, (p) => thumbCount(p) > 0))} | 2: ${fmt(rateOf(props, (p) => thumbCount(p) === 2))} | M: ${fmt(rateOf(one, (p) => p.merlinOn))}`,
      };
    }),
  });
  // Thumb seat groups (hidden identity): Merlin's group × Morgana's group.
  sections.push({
    title: "(b) first proposal by the thumbs' seat groups (Merlin group × Morgana group): ≥ 1 thumb",
    rows: GROUPS.flatMap((gm) => GROUPS.map((gg) => {
      const props = first(withFirst.filter((r) => seatGroupOf(r.merlinSeat) === gm && seatGroupOf(r.morganaSeat) === gg));
      return { label: `Merlin ${gm} × Morgana ${gg}`, rate: rateOf(props, (p) => thumbCount(p) > 0) };
    })),
  });
  // C1: earlier thumb identity; thumbs' own teams with Percival on them.
  const c1 = withFirst.filter((r) => r.config === 1);
  const earlierOn = (r: PercivalRecord): boolean => {
    const p = firstOf(r)!;
    return r.earlierThumb === 'merlin' ? p.merlinOn : p.morganaOn;
  };
  const laterOn = (r: PercivalRecord): boolean => {
    const p = firstOf(r)!;
    return r.earlierThumb === 'merlin' ? p.morganaOn : p.merlinOn;
  };
  sections.push({
    title: '(b) C1: which thumb goes on the first team',
    rows: [
      { label: 'the thumb that led before him', rate: rateOf(c1, earlierOn) },
      { label: 'the thumb that leads after him', rate: rateOf(c1, laterOn) },
      { label: 'earlier thumb is Merlin: ≥ 1 thumb', rate: rateOf(c1.filter((r) => r.earlierThumb === 'merlin'), (r) => thumbCount(firstOf(r)!) > 0) },
      { label: 'earlier thumb is Morgana: ≥ 1 thumb', rate: rateOf(c1.filter((r) => r.earlierThumb === 'morgana'), (r) => thumbCount(firstOf(r)!) > 0) },
      { label: 'earlier thumb is Merlin: it is on the team', rate: rateOf(c1.filter((r) => r.earlierThumb === 'merlin'), earlierOn) },
      { label: 'earlier thumb is Morgana: it is on the team', rate: rateOf(c1.filter((r) => r.earlierThumb === 'morgana'), earlierOn) },
    ],
  });
  type Pair = { rec: PercivalRecord; lead: EarlierThumbLead };
  const pairs: Pair[] = withFirst.flatMap((rec) => rec.earlierLeads.map((lead) => ({ rec, lead })));
  const pOn = (x: Pair): boolean => (x.lead.thumb === 'merlin' ? firstOf(x.rec)!.merlinOn : firstOf(x.rec)!.morganaOn);
  sections.push({
    title: "(b) thumbs that led before Percival: did their team have him on it, and does he take them back?",
    rows: [
      { label: 'Merlin led before: her team had Percival', rate: rateOf(pairs.filter((x) => x.lead.thumb === 'merlin'), (x) => x.lead.includedPercival) },
      { label: 'Morgana led before: her team had Percival', rate: rateOf(pairs.filter((x) => x.lead.thumb === 'morgana'), (x) => x.lead.includedPercival) },
      { label: 'thumb had him on its team → he puts it on his first team', rate: rateOf(pairs.filter((x) => x.lead.includedPercival), pOn) },
      { label: 'thumb did not → he puts it on his first team', rate: rateOf(pairs.filter((x) => !x.lead.includedPercival), pOn) },
      { label: '  same, R1 talk only (Percival seats 1–4)', rate: rateOf(pairs.filter((x) => x.rec.seatGroup === 'talk' && x.lead.includedPercival), pOn) },
      { label: '  thumb did not, R1 talk only', rate: rateOf(pairs.filter((x) => x.rec.seatGroup === 'talk' && !x.lead.includedPercival), pOn) },
    ],
  });
  // First proposal at seat 6–10: evidence after the R1 mission.
  const r2 = first(withFirst.filter((r) => r.seatGroup === 'r2plus'));
  sections.push({
    title: '(b) first proposal in R2+ (seats 6–10) by evidence about the thumbs',
    rows: evidenceRows(r2),
  });
  return sections;
}

function evidenceRows(props: readonly PercivalProposal[], choice: (p: PercivalProposal) => ThumbChoice = (p) => p): Row[] {
  const rows: Row[] = [];
  for (const ev of ['ownLake', 'failSplit', 'otherLake', 'none'] as Evidence[]) {
    const sub = props.filter((p) => p.evidence === ev);
    if (ev === 'none') {
      rows.push({ label: `${ev}: ≥ 1 thumb`, rate: rateOf(sub, (p) => thumbCount(choice(p)) > 0) });
      rows.push({ label: `${ev}: with 1 thumb, it is Merlin`, rate: rateOf(sub.filter((p) => thumbCount(choice(p)) === 1), (p) => choice(p).merlinOn) });
      // Added after the first run: within "none", exactly one thumb on a successful mission.
      const ss = sub.filter((p) => p.successFavoured !== null);
      const sFav = (p: PercivalProposal): boolean => (p.successFavoured === 'merlin' ? choice(p).merlinOn : choice(p).morganaOn);
      const sOther = (p: PercivalProposal): boolean => (p.successFavoured === 'merlin' ? choice(p).morganaOn : choice(p).merlinOn);
      rows.push({ label: `${ev} + one thumb on a successful mission: it is Merlin (validity)`, rate: rateOf(ss, (p) => p.successFavoured === 'merlin') });
      rows.push({ label: `${ev} + one thumb on a successful mission: that thumb on`, rate: rateOf(ss, sFav) });
      rows.push({ label: `${ev} + one thumb on a successful mission: other thumb on`, rate: rateOf(ss, sOther) });
      rows.push({ label: `${ev}, neither split: ≥ 1 thumb`, rate: rateOf(sub.filter((p) => p.successFavoured === null), (p) => thumbCount(choice(p)) > 0) });
      rows.push({ label: `${ev}, neither split: with 1 thumb, it is Merlin`, rate: rateOf(sub.filter((p) => p.successFavoured === null && thumbCount(choice(p)) === 1), (p) => choice(p).merlinOn) });
      continue;
    }
    const favOn = (p: PercivalProposal): boolean => (p.favoured === 'merlin' ? choice(p).merlinOn : choice(p).morganaOn);
    const otherOn = (p: PercivalProposal): boolean => (p.favoured === 'merlin' ? choice(p).morganaOn : choice(p).merlinOn);
    rows.push({ label: `${ev}: evidence points to the real Merlin (validity)`, rate: rateOf(sub, (p) => p.favoured === 'merlin') });
    rows.push({ label: `${ev}: favoured thumb on the team`, rate: rateOf(sub, favOn) });
    rows.push({ label: `${ev}: other thumb on the team`, rate: rateOf(sub, otherOn) });
    rows.push({ label: `${ev}: Merlin on / Morgana on`, text: `${fmt(rateOf(sub, (p) => choice(p).merlinOn))} / ${fmt(rateOf(sub, (p) => choice(p).morganaOn))}` });
  }
  return rows;
}

/** 任務 / 刺殺 / 遊戲 blocks. */
function blockRows(label: string, recs: readonly PercivalRecord[]): Row[] {
  const tb = recs.filter((r) => r.threeBlue);
  return [{
    label,
    text: `任務 ${fmt(rateOf(recs, (r) => r.threeBlue))} · 刺殺 ${fmt(rateOf(tb, (r) => r.blueWin))} · 遊戲 ${fmt(rateOf(recs, (r) => r.blueWin))}`,
  }];
}

function blockDiff(label: string, a: readonly PercivalRecord[], b: readonly PercivalRecord[]): Row {
  const parts: string[] = [];
  for (const [name, pick, base] of [
    ['任務', (r: PercivalRecord): boolean => r.threeBlue, (xs: readonly PercivalRecord[]): readonly PercivalRecord[] => xs],
    ['刺殺', (r: PercivalRecord): boolean => r.blueWin, (xs: readonly PercivalRecord[]): readonly PercivalRecord[] => xs.filter((r) => r.threeBlue)],
    ['遊戲', (r: PercivalRecord): boolean => r.blueWin, (xs: readonly PercivalRecord[]): readonly PercivalRecord[] => xs],
  ] as const) {
    const ra = rateOf(base(a), pick);
    const rb = rateOf(base(b), pick);
    if (ra.n === 0 || rb.n === 0) {
      parts.push(`${name} —`);
      continue;
    }
    const d = diffInterval(ra, rb);
    parts.push(`${name} ${pp(d.d)} [${pp(d.low)}, ${pp(d.high)}]`);
  }
  return { label, text: parts.join(' · ') };
}

type FirstKind = 'none' | 'merlin' | 'morgana' | 'both';
const FIRST_KINDS: FirstKind[] = ['none', 'merlin', 'morgana', 'both'];

function sectionC(recs: readonly PercivalRecord[]): Section[] {
  const withFirst = recs.filter((r) => firstOf(r));
  const kind = (r: PercivalRecord): FirstKind => thumbSet(firstOf(r)!);
  const sections: Section[] = [];
  sections.push({
    title: '(c) outcome blocks, all Percival games (任務 = 三藍 · 刺殺 = 三藍活 | 三藍 · 遊戲 = 三藍活)',
    rows: [
      ...blockRows('all games', recs),
      ...CONFIGS.flatMap((c) => blockRows(configLabel(c), recs.filter((r) => r.config === c))),
      ...GROUPS.flatMap((g) => blockRows(SEAT_GROUP_LABEL[g], recs.filter((r) => r.seatGroup === g))),
    ],
  });
  const rowsFor = (label: string, xs: readonly PercivalRecord[]): Row[] => [
    ...FIRST_KINDS.flatMap((k) => blockRows(`${label} first team thumbs = ${k}`, xs.filter((r) => kind(r) === k))),
    ...blockRows(`${label} first team ≥ 1 thumb`, xs.filter((r) => kind(r) !== 'none')),
    blockDiff(`${label} ≥ 1 thumb − none`, xs.filter((r) => kind(r) !== 'none'), xs.filter((r) => kind(r) === 'none')),
  ];
  sections.push({ title: '(c) outcome blocks by thumbs on the first proposal — all', rows: rowsFor('all', withFirst) });
  for (const c of CONFIGS) {
    sections.push({ title: `(c) outcome blocks by thumbs on the first proposal — ${configLabel(c)}`, rows: rowsFor(`C${c}`, withFirst.filter((r) => r.config === c)) });
  }
  for (const g of GROUPS) {
    sections.push({ title: `(c) outcome blocks by thumbs on the first proposal — ${SEAT_GROUP_LABEL[g]}`, rows: rowsFor(g, withFirst.filter((r) => r.seatGroup === g)) });
  }
  // Config × group, ≥ 1 vs none only.
  sections.push({
    title: '(c) config × seat group: ≥ 1 thumb − none (遊戲 differences)',
    rows: GROUPS.flatMap((g) => CONFIGS.map((c) => {
      const xs = withFirst.filter((r) => r.seatGroup === g && r.config === c);
      return blockDiff(`${g} C${c} (n ≥1 ${xs.filter((r) => kind(r) !== 'none').length} / none ${xs.filter((r) => kind(r) === 'none').length})`,
        xs.filter((r) => kind(r) !== 'none'), xs.filter((r) => kind(r) === 'none'));
    })),
  });
  // Did that proposal pass; did its mission succeed.
  const passRows: Row[] = [];
  for (const g of GROUPS) {
    for (const k of FIRST_KINDS) {
      const props = withFirst.filter((r) => r.seatGroup === g && kind(r) === k).map((r) => firstOf(r)!);
      const went = props.filter((p) => p.passed);
      passRows.push({
        label: `${g} thumbs=${k}`,
        text: `passed ${fmt(rateOf(props, (p) => p.passed))} · mission succeeded ${fmt(rateOf(went, (p) => p.missionFailed === false))}`,
      });
    }
  }
  sections.push({ title: '(c) the first proposal itself: passed / its mission succeeded', rows: passRows });
  return sections;
}

function laterProps(recs: readonly PercivalRecord[]): PercivalProposal[] {
  return recs.flatMap((r) => r.proposals.slice(1));
}

function sectionD(recs: readonly PercivalRecord[]): Section[] {
  const later = laterProps(recs);
  const sections: Section[] = [];
  sections.push({ title: '(d) later proposals (2nd captain turn on) — all', rows: thumbRows('later', later) });
  sections.push({
    title: '(d) later proposals by round',
    rows: [1, 2, 3, 4, 5].flatMap((rd) => {
      const sub = later.filter((p) => p.round === rd);
      const one = sub.filter((p) => thumbCount(p) === 1);
      return [{
        label: `R${rd} (n=${sub.length})`,
        text: `0/1/2 = ${pct(rateOf(sub, (p) => thumbCount(p) === 0).rate)} / ${pct(rateOf(sub, (p) => thumbCount(p) === 1).rate)} / ${pct(rateOf(sub, (p) => thumbCount(p) === 2).rate)}; 1 = Merlin ${fmt(rateOf(one, (p) => p.merlinOn))}`,
      }];
    }),
  });
  sections.push({
    title: '(d) later proposals by configuration',
    rows: CONFIGS.flatMap((c) => thumbRows(`C${c}`, laterProps(recs.filter((r) => r.config === c)))),
  });
  sections.push({ title: '(d) later proposals by evidence that tells the thumbs apart', rows: evidenceRows(later) });
  sections.push({
    title: '(d) later proposals: Merlin on vs Morgana on (by round)',
    rows: [1, 2, 3, 4, 5].map((rd) => {
      const sub = later.filter((p) => p.round === rd);
      return { label: `R${rd}`, text: `Merlin ${fmt(rateOf(sub, (p) => p.merlinOn))} · Morgana ${fmt(rateOf(sub, (p) => p.morganaOn))}` };
    }),
  });
  return sections;
}

function sectionE(recs: readonly PercivalRecord[]): Section[] {
  const lakes = recs.flatMap((r) => r.lakes.map((l) => ({ r, l })));
  type L = (typeof lakes)[number];
  const thumbLaked = (x: L): boolean => x.l.target !== 'other';
  const randomOf = (xs: readonly L[]): number => mean(xs.map((x) => (x.l.valid > 0 ? x.l.thumbsValid / x.l.valid : 0)));
  const sections: Section[] = [];
  const rows: Row[] = [
    { label: `all Percival lakes (random ${pct(randomOf(lakes))})`, rate: rateOf(lakes, thumbLaked) },
    ...CONFIGS.map((c) => {
      const sub = lakes.filter((x) => x.r.config === c);
      return { label: `C${c} (random ${pct(randomOf(sub))})`, rate: rateOf(sub, thumbLaked) };
    }),
    ...[1, 2, 3].map((nth) => {
      const sub = lakes.filter((x) => x.l.nth === nth);
      return { label: `lake #${nth} (random ${pct(randomOf(sub))})`, rate: rateOf(sub, thumbLaked) };
    }),
    ...['2:0', '1:1', '0:2', '2:1', '1:2', '2:2'].map((s) => {
      const sub = lakes.filter((x) => x.l.score === s);
      return { label: `score ${s} (random ${pct(randomOf(sub))})`, rate: rateOf(sub, thumbLaked) };
    }),
    { label: 'laked thumb is Merlin', rate: rateOf(lakes.filter(thumbLaked), (x) => x.l.target === 'merlin') },
    { label: 'laked Merlin → claimed good', rate: rateOf(lakes.filter((x) => x.l.target === 'merlin' && x.l.claim !== null), (x) => x.l.claim === 'good') },
    { label: 'laked Morgana → claimed evil', rate: rateOf(lakes.filter((x) => x.l.target === 'morgana' && x.l.claim !== null), (x) => x.l.claim === 'evil') },
    { label: 'only one thumb still a valid target: laked it', rate: rateOf(lakes.filter((x) => x.l.thumbsValid === 1), thumbLaked) },
    { label: 'both thumbs valid targets: laked one', rate: rateOf(lakes.filter((x) => x.l.thumbsValid === 2), thumbLaked) },
  ];
  sections.push({ title: '(e) Percival holds the lake: target is a thumb (random = thumbs among valid targets)', rows });
  const recOf = (pred: (x: L) => boolean): PercivalRecord[] => lakes.filter(pred).map((x) => x.r);
  sections.push({
    title: '(e) outcome blocks by Percival lake target (one row per lake)',
    rows: [
      ...blockRows('laked Merlin', recOf((x) => x.l.target === 'merlin')),
      ...blockRows('laked Morgana', recOf((x) => x.l.target === 'morgana')),
      ...blockRows('laked a thumb', recOf(thumbLaked)),
      ...blockRows('laked a non-thumb', recOf((x) => !thumbLaked(x))),
      blockDiff('thumb − non-thumb', recOf(thumbLaked), recOf((x) => !thumbLaked(x))),
      ...[1, 2, 3].map((nth) => blockDiff(`lake #${nth}: thumb − non-thumb`,
        recOf((x) => x.l.nth === nth && thumbLaked(x)), recOf((x) => x.l.nth === nth && !thumbLaked(x)))),
    ],
    note: 'descriptive; the lake target responds to the table',
  });
  return sections;
}

// ── Agent replay ───────────────────────────────────────────────

function agentReplay(games: readonly ReplayGame[], recs: readonly PercivalRecord[], tuning: AgentTuning): void {
  const byId = new Map(recs.map((r) => [r.gameId, r]));
  for (const g of games) {
    const rec = byId.get(g.id);
    if (!rec) continue;
    const outcomes = replayGame(g, [rec.seat], { makeAgent: (id) => new HeuristicAgent(id, undefined, undefined, tuning) });
    for (const o of outcomes) {
      if (o.type === 'team') {
        const prop = rec.proposals.find((p) => p.round === o.round && p.attempt === o.attempt);
        if (!prop) throw new Error(`no Percival proposal for agent decision in game ${g.id}`);
        const agent = o.agent.split(',').filter(Boolean).map(Number);
        const human = o.human.split(',').filter(Boolean).map(Number);
        prop.agent = {
          merlinOn: agent.includes(rec.merlinSeat),
          morganaOn: agent.includes(rec.morganaSeat),
          selfOn: agent.includes(rec.seat),
          exact: o.match,
          jac: jaccard(agent.map(seatId), human.map(seatId)),
        };
      } else if (o.type === 'lakeTarget') {
        const lake = rec.lakes.find((l) => l.round === o.round);
        if (!lake) throw new Error(`no Percival lake for agent decision in game ${g.id}`);
        const t = Number(o.agent);
        lake.agentTarget = t === rec.merlinSeat ? 'merlin' : t === rec.morganaSeat ? 'morgana' : 'other';
      }
    }
  }
}

function agentSections(recs: readonly PercivalRecord[]): Section[] {
  const first = recs.map((r) => firstOf(r)).filter((p): p is PercivalProposal => !!p && !!p.agent);
  const later = laterProps(recs).filter((p) => !!p.agent);
  const all = [...first, ...later];
  const ag = (p: PercivalProposal): ThumbChoice => p.agent!;
  const sameSet = (p: PercivalProposal): boolean => thumbSet(p) === thumbSet(p.agent!);
  const sections: Section[] = [];
  sections.push({
    title: 'Agent — first proposal (agent thumbs on the same decision)',
    rows: [
      ...thumbRows('agent all', first, ag),
      ...CONFIGS.flatMap((c) => thumbRows(`agent C${c}`, first.filter((p) => recs.find((r) => firstOf(r) === p)?.config === c), ag)),
      ...GROUPS.map((g) => {
        const sub = recs.filter((r) => r.seatGroup === g).map((r) => firstOf(r)).filter((p): p is PercivalProposal => !!p && !!p.agent);
        return { label: `agent ${g}: ≥ 1 thumb`, rate: rateOf(sub, (p) => thumbCount(ag(p)) > 0) };
      }),
      ...[1, 2, 3, 4, 5].map((rd) => {
        const sub = first.filter((p) => p.round === rd);
        return { label: `agent first proposal in R${rd}: ≥ 1 thumb`, rate: rateOf(sub, (p) => thumbCount(ag(p)) > 0) };
      }),
      ...GROUPS.flatMap((g) => CONFIGS.map((c) => {
        const sub = recs.filter((r) => r.seatGroup === g && r.config === c).map((r) => firstOf(r)).filter((p): p is PercivalProposal => !!p && !!p.agent);
        return { label: `agent ${g} C${c}: ≥ 1 thumb`, rate: rateOf(sub, (p) => thumbCount(ag(p)) > 0) };
      })),
      ...((): Row[] => {
        const r1All = recs.flatMap((r) => r.proposals.filter((p) => p.round === 1 && !!p.agent));
        return [
          ...thumbRows('agent R1 all', r1All, ag),
          { label: 'agent R1 talk (attempts 1–4): ≥ 1 thumb', rate: rateOf(r1All.filter((p) => !p.forced), (p) => thumbCount(ag(p)) > 0) },
          { label: 'agent R1 forced (attempt 5): ≥ 1 thumb', rate: rateOf(r1All.filter((p) => p.forced), (p) => thumbCount(ag(p)) > 0) },
        ];
      })(),
      { label: 'agent R1 attempt 1 (no vote yet): ≥ 1 thumb', rate: rateOf(first.filter((p) => p.round === 1 && p.attempt === 1), (p) => thumbCount(ag(p)) > 0) },
      { label: 'agent R1 attempt 1: the thumb is the lower-seated one', rate: rateOf(first.filter((p) => p.round === 1 && p.attempt === 1 && thumbCount(ag(p)) === 1), (p) => {
        const r = recs.find((x) => firstOf(x) === p)!;
        const lower: Thumb = r.merlinSeat < r.morganaSeat ? 'merlin' : 'morgana';
        return lower === 'merlin' ? ag(p).merlinOn : ag(p).morganaOn;
      }) },
      { label: 'agent R1 attempts 2–5: ≥ 1 thumb', rate: rateOf(first.filter((p) => p.round === 1 && p.attempt > 1), (p) => thumbCount(ag(p)) > 0) },
    ],
  });
  sections.push({
    title: 'Agent — later proposals',
    rows: [
      ...thumbRows('agent later', later, ag),
      ...evidenceRows(later, ag),
    ],
  });
  const agreeRows = (label: string, xs: readonly PercivalProposal[]): Row[] => [
    { label: `${label}: same thumb set (none / Merlin / Morgana / both)`, rate: rateOf(xs, sameSet) },
    { label: `${label}: same thumb count (0 / 1 / 2)`, rate: rateOf(xs, (p) => thumbCount(p) === thumbCount(p.agent!)) },
    { label: `${label}: exact team`, rate: rateOf(xs, (p) => p.agent!.exact) },
    { label: `${label}: Jaccard (mean)`, text: `${pct(mean(xs.map((p) => p.agent!.jac)))} (n=${xs.length})` },
  ];
  sections.push({
    title: 'Agent — agreement on Percival-led proposals',
    rows: [
      ...agreeRows('all', all),
      ...agreeRows('first', first),
      ...agreeRows('later', later),
      ...agreeRows('R1', all.filter((p) => p.round === 1)),
      ...agreeRows('R2+', all.filter((p) => p.round >= 2)),
      ...CONFIGS.flatMap((c) => agreeRows(`first C${c}`, recs.filter((r) => r.config === c).map((r) => firstOf(r)).filter((p): p is PercivalProposal => !!p && !!p.agent))),
      {
        label: 'projection: no thumb in R1, R2+ as now — same thumb set',
        rate: rateOf(all, (p) => (p.round === 1 ? thumbSet(p) === 'none' : sameSet(p))),
      },
      { label: 'human first: 0 thumbs → agent 0 thumbs', rate: rateOf(first.filter((p) => thumbCount(p) === 0), (p) => thumbCount(ag(p)) === 0) },
      { label: 'human first: ≥ 1 thumb → agent ≥ 1 thumb', rate: rateOf(first.filter((p) => thumbCount(p) > 0), (p) => thumbCount(ag(p)) > 0) },
    ],
  });
  const lakes = recs.flatMap((r) => r.lakes).filter((l) => l.agentTarget !== undefined);
  sections.push({
    title: 'Agent — Percival lake',
    rows: [
      { label: 'agent lakes a thumb', rate: rateOf(lakes, (l) => l.agentTarget !== 'other') },
      { label: 'human lakes a thumb (same lakes)', rate: rateOf(lakes, (l) => l.target !== 'other') },
      { label: 'same "thumb or not"', rate: rateOf(lakes, (l) => (l.agentTarget !== 'other') === (l.target !== 'other')) },
    ],
  });
  return sections;
}

// ── Main ───────────────────────────────────────────────────────

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const data = JSON.parse(fs.readFileSync(args.cache, 'utf8')) as Record<string, string[][]>;
  const rows = rowsFromSheet(data['牌譜'] ?? []);
  const games: ReplayGame[] = [];
  for (const row of rows) {
    if (!(row['文字記錄'] ?? '').trim()) continue;
    const res = parseReplayGame(row);
    if (res.ok) games.push(res.game);
  }
  const top = computeTopPerformers(games);
  const recs = collectRecords(games);
  console.log(`replayable 10p games: ${games.length}; Percival games: ${recs.length}; with a lake chain: ${recs.filter((r) => r.lakeChainValid).length}`);

  type Keep = (r: PercivalRecord) => boolean;
  const cohorts: Array<[string, Keep]> = [
    ['population', (): boolean => true],
    ['top/role', (r: PercivalRecord): boolean => top.members.has(cohortKey(r.name, 'percival'))],
    ...args.players.map((p): [string, Keep] => [p, (r: PercivalRecord): boolean => r.name === p]),
  ];

  if (args.agent) {
    const tuning = resolveAgentTuning(args.flags, args.legacy ? { ...LEGACY_AGENT_TUNING } : undefined);
    // Benchmark-only knobs, read from the environment exactly as agreementBenchmark.ts does.
    setEvilLakeHumanOptions(evilLakeHumanOptionsFromEnv());
    setVouchFollowUpOptions(vouchFollowUpOptionsFromEnv());
    setGoodVouchOptions(goodVouchOptionsFromEnv());
    setTeamReuseOptions(teamReuseOptionsFromEnv());
    setRedR1TeammateOptions(redR1TeammateOptionsFromEnv());
    agentReplay(games, recs, tuning);
    console.log(`agent tuning: ${describeAgentTuning(tuning)}`);
    const t = getForwardTelemetry();
    console.log(`forward telemetry: ${t.totalDecisions} decisions via ForwardAgent, ${t.fallbacks} fallbacks`);
  }

  const result: Record<string, Section[]> = {};
  for (const [label, keep] of cohorts) {
    const sub = recs.filter(keep);
    const sections = [...sectionA(sub), ...sectionB(sub), ...sectionC(sub), ...sectionD(sub), ...sectionE(sub)];
    if (args.agent) sections.push(...agentSections(sub));
    result[label] = sections;
    printSections(`${label} (Percival games n=${sub.length})`, sections);
  }
  if (args.json) {
    fs.writeFileSync(path.resolve(args.json), JSON.stringify({ generatedBy: 'packages/server/scripts/percivalThumbsStudy.ts', games: games.length, cohorts: result }, null, 2));
    console.log(`wrote ${path.resolve(args.json)}`);
  }
}

main();
