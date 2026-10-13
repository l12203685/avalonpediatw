/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * Red leaders and their visible teammates — human data for the
 * `redR1Teammate` switch (2026-10-13 round 3, strength_benchmark.md 第 12 節).
 *
 *   pnpm --filter @avalon/server exec tsx scripts/redR1TeammateStudy.ts \
 *     [--player ED --player Sin] [--agent] [--legacy] [--flag NAME[=V] ...] \
 *     [--json out.json] [--cache PATH]
 *
 * Reads `sheets_cache.json` → `牌譜` with the strict replay parser of the
 * agreement benchmark (`parseReplayGame`) and, for every proposal led by a red
 * who sees teammates (assassin / Morgana / Mordred; Oberon sees nobody and is
 * left out), records whether the team includes a visible teammate:
 *   (a) R1: by role, attempt (forced 5th proposal apart), clockwise seat
 *       distance to the nearest teammate, whether the previous R1 proposal
 *       had a teammate on it, and against two reference levels — a random
 *       team (2 of the 9 other seats) and "built like a blue leader" (the
 *       share of blue leaders' R1 teams at the same attempt that contain a
 *       seat at the same clockwise distances);
 *   (b) what follows: the R1 mission by the number of visible reds on it
 *       (fail rate, fail-card count; two reds on it by pair), R1 votes on
 *       red-led proposals, and later suspicion of the R1 red leader (on R2-R3
 *       teams of blue leaders, laked by a blue holder, the red camp's win);
 *   (c) R2+: the same inclusion rate by round, role and attempt, with the
 *       random-team level for each team size.
 * With `--agent` it also replays every R1 red-leader proposal through the
 * production agent (`HeuristicAgent.act`, same seeding as the agreement
 * benchmark; `--flag` / `--legacy` as there) and scores agreement on the
 * targeted decision: teammate included or not, exact team, Jaccard.
 *
 * Every rate is printed with n and a Wilson 95% interval. Output is aggregate
 * only; `--player NAME` adds per-player rows (the public docs use the ED / Sin
 * labels only).
 */

import * as fs from 'fs';
import * as path from 'path';
import { rowsFromSheet, parseReplayGame, campOf, type ReplayGame, type ReplayProposal } from '../src/ai/benchmark/sheetsReplay';
import { seatId } from '../src/ai/benchmark/replayObservation';
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
import { HUMAN_R1_TEAMMATE_RATE, redR1TeammateOptionsFromEnv, setRedR1TeammateOptions } from '../src/ai/RedR1Teammate';

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

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
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

/** P(a uniformly random set of `pick` seats out of `pool` contains ≥ 1 of `k` marked seats). */
export function randomInclusion(pool: number, pick: number, k: number): number {
  const choose = (n: number, r: number): number => {
    if (r < 0 || r > n) return 0;
    let out = 1;
    for (let i = 1; i <= r; i++) out = (out * (n - r + i)) / i;
    return out;
  };
  return 1 - choose(pool - k, pick) / choose(pool, pick);
}

// ── Records ────────────────────────────────────────────────────

const SEEING_RED_ROLES = new Set(['assassin', 'morgana', 'mordred']);

/** Clockwise seat distance from `from` to `to` (1..n-1). */
function cw(from: number, to: number, n: number): number {
  return ((to - from) % n + n) % n;
}

export interface RedLeaderProposal {
  gameId: string;
  name: string;
  role: string;
  round: number;
  attempt: number;
  forced: boolean;
  proposalIndex: number;
  leaderSeat: number;
  /** Visible teammates' seats (the other seeing reds). */
  teammateSeats: number[];
  /** Clockwise distances leader → each teammate. */
  teammateDistances: number[];
  /** Number of visible teammates on the team. */
  teammatesOnTeam: number;
  withTeammate: boolean;
  /** Team size of the round. */
  teamSize: number;
  /** Attempt ≥ 2: the previous proposal of the round had a visible teammate of this leader on it. */
  prevHadTeammate: boolean | null;
  /** Attempt ≥ 2: the previous proposal of the round had this leader on it. */
  prevHadLeader: boolean | null;
  wentOnMission: boolean;
  approveCount: number | null;
  plusCount: number | null;
}

function collectRedLeaderProposals(games: readonly ReplayGame[]): RedLeaderProposal[] {
  const out: RedLeaderProposal[] = [];
  for (const game of games) {
    const n = game.playerCount;
    const seeing = game.seatRoles
      .map((r, i) => (SEEING_RED_ROLES.has(r) ? i + 1 : 0))
      .filter((s) => s > 0);
    game.proposals.forEach((p, idx) => {
      const role = game.seatRoles[p.leaderSeat - 1];
      if (!SEEING_RED_ROLES.has(role)) return;
      const mates = seeing.filter((s) => s !== p.leaderSeat);
      const onTeam = p.teamSeats.filter((s) => mates.includes(s)).length;
      const prev: ReplayProposal | undefined = p.attempt > 1 ? game.proposals[idx - 1] : undefined;
      out.push({
        gameId: game.id,
        name: game.names[p.leaderSeat - 1] ?? '',
        role,
        round: p.round,
        attempt: p.attempt,
        forced: p.forced,
        proposalIndex: idx,
        leaderSeat: p.leaderSeat,
        teammateSeats: mates,
        teammateDistances: mates.map((s) => cw(p.leaderSeat, s, n)),
        teammatesOnTeam: onTeam,
        withTeammate: onTeam > 0,
        teamSize: p.teamSeats.length,
        prevHadTeammate: prev ? prev.teamSeats.some((s) => mates.includes(s)) : null,
        prevHadLeader: prev ? prev.teamSeats.includes(p.leaderSeat) : null,
        wentOnMission: p.wentOnMission,
        approveCount: p.votesReliable ? p.approveCount : null,
        plusCount: p.votesReliable ? p.plusSeats.length : null,
      });
    });
  }
  return out;
}

/**
 * "Built like a blue leader": for each attempt, the clockwise-distance sets of
 * blue leaders' R1 teams; the expectation for a red leader with teammates at
 * distances D is the share of those teams holding a seat at a distance in D.
 */
function blueR1DistanceSets(games: readonly ReplayGame[]): Map<number, number[][]> {
  const byAttempt = new Map<number, number[][]>();
  for (const game of games) {
    for (const p of game.proposals) {
      if (p.round !== 1) continue;
      if (campOf(game.seatRoles[p.leaderSeat - 1]) !== 'good') continue;
      const ds = p.teamSeats.filter((s) => s !== p.leaderSeat).map((s) => cw(p.leaderSeat, s, game.playerCount));
      const list = byAttempt.get(p.attempt) ?? [];
      list.push(ds);
      byAttempt.set(p.attempt, list);
    }
  }
  return byAttempt;
}

function blueLikeExpectation(sets: Map<number, number[][]>, attempt: number, distances: readonly number[]): number {
  const list = sets.get(attempt) ?? [];
  if (list.length === 0) return 0;
  return list.filter((ds) => ds.some((d) => distances.includes(d))).length / list.length;
}

// ── Sections ───────────────────────────────────────────────────

interface Section {
  title: string;
  rows: Array<{ label: string; rate?: Rate; text?: string }>;
  note?: string;
}

function printSections(label: string, sections: readonly Section[]): void {
  console.log(`\n================ ${label} ================`);
  for (const s of sections) {
    console.log(`\n${s.title}`);
    for (const r of s.rows) console.log(`  ${r.label.padEnd(52)} ${r.rate ? fmt(r.rate) : (r.text ?? '')}`);
    if (s.note) console.log(`  (${s.note})`);
  }
}

function r1Sections(items: readonly RedLeaderProposal[], blueSets: Map<number, number[][]>): Section[] {
  const r1 = items.filter((x) => x.round === 1);
  const inc = (x: RedLeaderProposal): boolean => x.withTeammate;
  const nearest = (x: RedLeaderProposal): number => Math.min(...x.teammateDistances.map((d) => Math.min(d, 10 - d)));
  const blueLike = mean(r1.map((x) => blueLikeExpectation(blueSets, x.attempt, x.teammateDistances)));
  const random = randomInclusion(9, 2, 2);
  const sections: Section[] = [
    {
      title: 'R1 red leader (sees teammates): team includes a visible teammate',
      rows: [
        { label: 'all R1 proposals', rate: rateOf(r1, inc) },
        { label: 'attempts 1–4 ("talk"; 0.2–0.7% of them pass)', rate: rateOf(r1.filter((x) => !x.forced), inc) },
        { label: 'forced 5th proposal (goes on the mission)', rate: rateOf(r1.filter((x) => x.forced), inc) },
        { label: 'assassin', rate: rateOf(r1.filter((x) => x.role === 'assassin'), inc) },
        { label: 'morgana', rate: rateOf(r1.filter((x) => x.role === 'morgana'), inc) },
        { label: 'mordred', rate: rateOf(r1.filter((x) => x.role === 'mordred'), inc) },
        { label: 'two teammates on the team', rate: rateOf(r1, (x) => x.teammatesOnTeam === 2) },
        { label: 'reference: random team (2 of 9, 2 teammates)', text: pct(random) },
        { label: 'reference: built like a blue leader (same attempt)', text: pct(blueLike) },
      ],
    },
    {
      title: 'R1 by attempt (leader seat = attempt; the 5th is forced and goes)',
      rows: [1, 2, 3, 4, 5].map((a) => {
        const sub = r1.filter((x) => x.attempt === a);
        const bl = mean(sub.map((x) => blueLikeExpectation(blueSets, x.attempt, x.teammateDistances)));
        return { label: `attempt ${a}${a === 5 ? ' (forced)' : ''} — blue-like ${pct(bl)}`, rate: rateOf(sub, inc) };
      }),
    },
    {
      title: 'R1 by nearest teammate (seats either way)',
      rows: [1, 2, 3, 4, 5].map((d) => {
        const sub = r1.filter((x) => nearest(x) === d);
        const bl = mean(sub.map((x) => blueLikeExpectation(blueSets, x.attempt, x.teammateDistances)));
        return { label: `nearest teammate ${d} seat(s) away — blue-like ${pct(bl)}`, rate: rateOf(sub, inc) };
      }),
    },
    {
      title: 'R1 by teammate in the next seats clockwise (leader+1 / leader+2)',
      rows: [
        { label: 'a teammate at leader+1', rate: rateOf(r1.filter((x) => x.teammateDistances.includes(1)), inc) },
        { label: 'a teammate at leader+2 (none at +1)', rate: rateOf(r1.filter((x) => x.teammateDistances.includes(2) && !x.teammateDistances.includes(1)), inc) },
        { label: 'a teammate at leader−1 (none at +1/+2)', rate: rateOf(r1.filter((x) => x.teammateDistances.includes(9) && !x.teammateDistances.includes(1) && !x.teammateDistances.includes(2)), inc) },
        { label: 'none within ±2', rate: rateOf(r1.filter((x) => !x.teammateDistances.some((d) => d <= 2 || d >= 8)), inc) },
      ],
    },
    {
      title: 'R1 attempt ≥ 2 by the previous proposal of the round',
      rows: [
        { label: 'previous team had a teammate of this leader', rate: rateOf(r1.filter((x) => x.prevHadTeammate === true), inc) },
        { label: 'previous team had none', rate: rateOf(r1.filter((x) => x.prevHadTeammate === false), inc) },
        { label: 'previous team had this leader', rate: rateOf(r1.filter((x) => x.prevHadLeader === true), inc) },
        { label: 'previous team did not have this leader', rate: rateOf(r1.filter((x) => x.prevHadLeader === false), inc) },
      ],
    },
  ];
  return sections;
}

function r2PlusSections(items: readonly RedLeaderProposal[]): Section[] {
  const inc = (x: RedLeaderProposal): boolean => x.withTeammate;
  return [{
    title: 'R2+ red leader: team includes a visible teammate (random-team level in the label)',
    rows: [
      ...[2, 3, 4, 5].map((r) => {
        const sub = items.filter((x) => x.round === r);
        const size = sub[0]?.teamSize ?? 0;
        return { label: `R${r} (team ${size}; random ${pct(randomInclusion(9, Math.max(0, size - 1), 2))})`, rate: rateOf(sub, inc) };
      }),
      ...['assassin', 'morgana', 'mordred'].map((role) => ({
        label: `R2+ ${role}`, rate: rateOf(items.filter((x) => x.round >= 2 && x.role === role), inc),
      })),
      { label: 'R2+ forced proposals', rate: rateOf(items.filter((x) => x.round >= 2 && x.forced), inc) },
      { label: 'R2+ non-forced proposals', rate: rateOf(items.filter((x) => x.round >= 2 && !x.forced), inc) },
    ],
  }];
}

// ── (b) What follows ───────────────────────────────────────────

interface R1Follow {
  name: string;
  role: string;
  withTeammate: boolean;
  /** R2-R3 proposals by blue leaders, and how many include the R1 red leader. */
  blueTeams: number;
  blueTeamsWithLeader: number;
  /** The R1 red leader was laked by a blue holder. */
  lakedByBlue: boolean;
  redWon: boolean;
}

function collectFollow(games: readonly ReplayGame[], items: readonly RedLeaderProposal[]): R1Follow[] {
  const byId = new Map(games.map((g) => [g.id, g]));
  const out: R1Follow[] = [];
  // One record per (game, red leader) — use the leader's last R1 proposal.
  const last = new Map<string, RedLeaderProposal>();
  for (const x of items) if (x.round === 1) last.set(`${x.gameId}|${x.leaderSeat}`, x);
  for (const x of last.values()) {
    const g = byId.get(x.gameId);
    if (!g) continue;
    const later = g.proposals.filter((p) => (p.round === 2 || p.round === 3) && campOf(g.seatRoles[p.leaderSeat - 1]) === 'good');
    out.push({
      name: x.name,
      role: x.role,
      withTeammate: x.withTeammate,
      blueTeams: later.length,
      blueTeamsWithLeader: later.filter((p) => p.teamSeats.includes(x.leaderSeat)).length,
      lakedByBlue: g.lakes.some((l) => l.targetSeat === x.leaderSeat && campOf(g.seatRoles[l.holderSeat - 1]) === 'good'),
      redWon: g.winner === 'evil',
    });
  }
  return out;
}

function followSections(items: readonly RedLeaderProposal[], follow: readonly R1Follow[], games: readonly ReplayGame[]): Section[] {
  const r1 = items.filter((x) => x.round === 1);
  const sections: Section[] = [];
  // R1 votes on red-led, non-forced proposals with reliable votes.
  const voted = r1.filter((x) => !x.forced && x.approveCount !== null);
  const vrow = (label: string, sub: readonly RedLeaderProposal[]): { label: string; text: string } => ({
    label,
    text: `approve ${mean(sub.map((x) => x.approveCount ?? 0)).toFixed(2)} / 10, off-team approvals ${mean(sub.map((x) => x.plusCount ?? 0)).toFixed(2)}, passed ${pct(sub.filter((x) => x.wentOnMission).length / Math.max(1, sub.length))} (n=${sub.length})`,
  });
  sections.push({
    title: 'R1 votes on red-led proposals (not forced, votes reliable)',
    rows: [vrow('with a teammate', voted.filter((x) => x.withTeammate)), vrow('without', voted.filter((x) => !x.withTeammate))],
  });
  // R1 mission by visible reds on it.
  type Mission = { seeing: number; oberon: boolean; failCount: number; failed: boolean; pair: string; redLeader: boolean };
  const missions: Mission[] = [];
  for (const g of games) {
    const q = g.quests.find((x) => x.round === 1);
    const p = g.proposals.find((x) => x.round === 1 && x.wentOnMission);
    if (!q || !p) continue;
    const seeingRoles = q.teamSeats.map((s) => g.seatRoles[s - 1]).filter((r) => SEEING_RED_ROLES.has(r)).sort();
    missions.push({
      seeing: seeingRoles.length,
      oberon: q.teamSeats.some((s) => g.seatRoles[s - 1] === 'oberon'),
      failCount: q.failCount,
      failed: q.failed,
      pair: seeingRoles.join('+'),
      redLeader: SEEING_RED_ROLES.has(g.seatRoles[p.leaderSeat - 1]),
    });
  }
  const mrow = (label: string, sub: readonly Mission[]): { label: string; text: string } => {
    const dist = [0, 1, 2, 3].map((k) => sub.filter((m) => m.failCount === k).length);
    return { label, text: `failed ${fmt(rateOf(sub, (m) => m.failed))}; fail cards 0/1/2/3 = ${dist.join(' / ')}` };
  };
  const noOb = missions.filter((m) => !m.oberon);
  sections.push({
    title: 'R1 mission by visible reds on it (no Oberon on it)',
    rows: [
      mrow('0 seeing reds', noOb.filter((m) => m.seeing === 0)),
      mrow('1 seeing red', noOb.filter((m) => m.seeing === 1)),
      mrow('2 seeing reds', noOb.filter((m) => m.seeing === 2)),
      mrow('  assassin+morgana', noOb.filter((m) => m.pair === 'assassin+morgana')),
      mrow('  assassin+mordred', noOb.filter((m) => m.pair === 'assassin+mordred')),
      mrow('  mordred+morgana', noOb.filter((m) => m.pair === 'mordred+morgana')),
      mrow('2 seeing reds, red leader', noOb.filter((m) => m.seeing === 2 && m.redLeader)),
      mrow('1 seeing red, red leader', noOb.filter((m) => m.seeing === 1 && m.redLeader)),
      mrow('3 seeing reds', noOb.filter((m) => m.seeing === 3)),
    ],
  });
  // Later suspicion of the R1 red leader.
  const srow = (label: string, sub: readonly R1Follow[]): { label: string; text: string } => {
    const teams = sub.reduce((a, f) => a + f.blueTeams, 0);
    const withL = sub.reduce((a, f) => a + f.blueTeamsWithLeader, 0);
    return {
      label,
      text: `on R2-R3 blue-led teams ${fmt(wilsonRate(withL, teams))}; laked by blue ${fmt(rateOf(sub, (f) => f.lakedByBlue))}; red won ${fmt(rateOf(sub, (f) => f.redWon))}`,
    };
  };
  sections.push({
    title: 'Later, the R1 red leader (last R1 proposal of that leader)',
    rows: [srow('teammate on the R1 team', follow.filter((f) => f.withTeammate)), srow('no teammate', follow.filter((f) => !f.withTeammate))],
    note: 'descriptive; the choice responds to the table, so win rates are confounded',
  });
  return sections;
}

// ── Agent replay (targeted agreement) ──────────────────────────

interface AgentRow {
  name: string;
  role: string;
  humanWith: boolean;
  agentWith: boolean;
  exact: boolean;
  jac: number;
  attempt: number;
}

function agentReplay(games: readonly ReplayGame[], tuning: AgentTuning): AgentRow[] {
  const out: AgentRow[] = [];
  for (const g of games) {
    const seats = [...new Set(g.proposals
      .filter((p) => p.round === 1 && SEEING_RED_ROLES.has(g.seatRoles[p.leaderSeat - 1]))
      .map((p) => p.leaderSeat))];
    if (seats.length === 0) continue;
    const outcomes = replayGame(g, seats, { makeAgent: (id) => new HeuristicAgent(id, undefined, undefined, tuning) });
    for (const o of outcomes) {
      if (o.type !== 'team' || o.round !== 1) continue;
      const mates = g.seatRoles.map((r, i) => (SEEING_RED_ROLES.has(r) && i + 1 !== o.seat ? i + 1 : 0)).filter((s) => s > 0);
      const human = o.human.split(',').map(Number);
      const agent = o.agent.split(',').filter(Boolean).map(Number);
      out.push({
        name: o.name,
        role: o.role,
        humanWith: human.some((s) => mates.includes(s)),
        agentWith: agent.some((s) => mates.includes(s)),
        exact: o.match,
        jac: jaccard(agent.map(seatId), human.map(seatId)),
        attempt: o.attempt ?? 0,
      });
    }
  }
  return out;
}

function agentSections(rows: readonly AgentRow[]): Section[] {
  const agree = (x: AgentRow): boolean => x.humanWith === x.agentWith;
  return [{
    title: 'Agent on R1 red-leader proposals: teammate included / agreement',
    rows: [
      { label: 'agent includes a teammate', rate: rateOf(rows, (x) => x.agentWith) },
      { label: 'human includes a teammate', rate: rateOf(rows, (x) => x.humanWith) },
      { label: 'same choice (teammate or not)', rate: rateOf(rows, agree) },
      { label: '  when the human included one', rate: rateOf(rows.filter((x) => x.humanWith), agree) },
      { label: '  when the human did not', rate: rateOf(rows.filter((x) => !x.humanWith), agree) },
      { label: '  forced (5th) proposal', rate: rateOf(rows.filter((x) => x.attempt === 5), agree) },
      {
        label: 'expected same choice, talk p = 48.0% (no draw luck)',
        text: ((): string => {
          const p = HUMAN_R1_TEAMMATE_RATE.talk;
          const talk = rows.filter((x) => x.attempt !== 5);
          const exp = talk.reduce((a, x) => a + (x.humanWith ? p : 1 - p), 0)
            + rows.filter((x) => x.attempt === 5 && !x.humanWith).length;
          return `${pct(exp / Math.max(1, rows.length))} (n=${rows.length}; forced proposals scored as "no teammate")`;
        })(),
      },
      { label: 'exact team', rate: rateOf(rows, (x) => x.exact) },
      { label: 'Jaccard (mean)', text: `${pct(mean(rows.map((x) => x.jac)))} (n=${rows.length})` },
    ],
  }];
}

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
  const items = collectRedLeaderProposals(games);
  const blueSets = blueR1DistanceSets(games);
  const follow = collectFollow(games, items);
  console.log(`replayable 10p games: ${games.length}; proposals led by a seeing red: ${items.length} (R1 ${items.filter((x) => x.round === 1).length})`);

  const result: Record<string, Section[]> = {};
  type Keep = (name: string, role: string) => boolean;
  const cohorts: Array<[string, Keep]> = [
    ['population', (): boolean => true],
    ['top/role', (name: string, role: string): boolean => top.members.has(cohortKey(name, role))],
    ...args.players.map((p): [string, Keep] => [p, (name: string): boolean => name === p]),
  ];
  for (const [label, keep] of cohorts) {
    const sub = items.filter((x) => keep(x.name, x.role));
    const sections = [...r1Sections(sub, blueSets), ...r2PlusSections(sub)];
    if (label === 'population') sections.push(...followSections(items, follow, games));
    else sections.push(...followSections(sub, follow.filter((f) => keep(f.name, f.role)), []).filter((s) => !s.title.startsWith('R1 mission')));
    result[label] = sections;
    printSections(`${label} (red-led proposals n=${sub.length})`, sections);
  }

  if (args.agent) {
    const tuning = resolveAgentTuning(args.flags, args.legacy ? { ...LEGACY_AGENT_TUNING } : undefined);
    // Benchmark-only knob for `redR1Teammate` (AVALON_RED_R1_TEAMMATE_VARIANT); the server never reads it.
    const r1Options = redR1TeammateOptionsFromEnv();
    setRedR1TeammateOptions(r1Options);
    if (tuning.redR1Teammate) console.log(`redR1Teammate options: ${JSON.stringify(r1Options)}`);
    const agentRows = agentReplay(games, tuning);
    console.log(`\nagent tuning: ${describeAgentTuning(tuning)}`);
    const t = getForwardTelemetry();
    console.log(`forward telemetry: ${t.totalDecisions} decisions via ForwardAgent, ${t.fallbacks} fallbacks`);
    for (const [label, keep] of cohorts) {
      const sections = agentSections(agentRows.filter((x) => keep(x.name, x.role)));
      result[`${label} agent`] = sections;
      printSections(`${label} — agent`, sections);
    }
  }
  if (args.json) {
    fs.writeFileSync(path.resolve(args.json), JSON.stringify({ generatedBy: 'packages/server/scripts/redR1TeammateStudy.ts', games: games.length, cohorts: result }, null, 2));
    console.log(`wrote ${path.resolve(args.json)}`);
  }
}

main();
