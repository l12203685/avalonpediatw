/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * Good Lady-of-the-Lake follow-up study — after a blue holder declares a
 * seat, does the holder keep its word on later teams and votes?
 * (strength_benchmark.md 第 10 節, 2026-10-13 round 3: `goodVouchFollowUp`.)
 *
 *   pnpm --filter @avalon/server exec tsx scripts/goodLakeFollowUpStudy.ts \
 *     [--player ED --player Sin] [--json out.json] [--cache PATH] \
 *     [--no-agent] [--flag NAME[=V] ...] [--base NAME[=V] ...]
 *   USE_FORWARD_REASONING=true pnpm --filter @avalon/server exec tsx scripts/goodLakeFollowUpStudy.ts \
 *     --selfplay N --seed S [--seats 7..10] [--flag ...] [--base ...] [--json out.json]
 *
 * Replay mode (default; `sheets_cache.json` → `牌譜`, the strict replay of
 * the agreement benchmark, games with a valid lake chain only). For every
 * good seat that declared a lake, every later proposal is classified by
 * the holder's position (leader / on the team / off the team) and by what
 * the team does with the declared seat:
 *   (1) leads after a blue declaration: the declared seat on the team —
 *       by round, by score (blue : red before the proposal), forced fifth
 *       proposals separately, by role;
 *   (2) leads after a red declaration: the declared seat on the team;
 *   (3) votes off the team (not leader, not member; forced proposals and
 *       unreliable vote records excluded): reject rate on teams that leave
 *       out the declared-blue seat vs teams that include it, and on teams
 *       that include the declared-red seat vs teams that do not;
 *   (4) the same on the team (member, not leader);
 *   (5) the chain: seats declared by a seat the holder declared blue
 *       (holder A → B blue, then B → C): does A put C on his teams /
 *       reject teams without C (off and on the team) / keep a seat B
 *       declared red off?
 *   (6) Merlin: declared-blue seats Merlin sees as red (a lie somewhere).
 * Then, unless `--no-agent`, the same seats are replayed through
 * `HeuristicAgent.act` exactly like `agreementBenchmark.ts` (same per-seat
 * agent, same seeding, so the decisions are the benchmark's) for the
 * production default (+ `--base`) and the variant (+ `--flag`, default
 * `goodVouchFollowUp`), and the agent's teams / votes on those states are
 * scored the same way, plus agreement with the human on the targeted
 * decisions ("breaks a bound declaration" = own or chain, the scope the
 * default rule acts on), and a paired comparison baseline → variant on
 * the same decisions (teams closer / further, votes gained / lost, exact
 * McNemar p).
 *
 * Self-play mode (`--selfplay N`): plays the B (variant on the good seats,
 * baseline red) and C (baseline both sides) games of `selfPlayStrength.ts`
 * for N seeds — same seating, roles and per-decision seeding, so wins match
 * that script at 10 seats — and reports the good holders' follow-up from
 * the final public record, the 硬3 flags on blue holders and the stance
 * numbers. `--seats 7|8|9` plays smaller games (the live server plays them
 * with the lake too; `selfPlayStrength.ts` is 10 seats only).
 *
 * `--flag` / `--base` apply ON TOP OF the production default
 * (`DEFAULT_AGENT_TUNING` + `AVALON_TUNING_*`), in both modes; without them
 * the baseline is the production default with `goodVouchFollowUp=0` and the
 * variant the same with `goodVouchFollowUp=1`.
 * Output is aggregate only; `--player NAME` adds per-player rows (local use
 * only: the public docs carry the existing ED / Sin labels at most).
 */

import * as fs from 'fs';
import * as path from 'path';
import { HeuristicAgent } from '../src/ai/HeuristicAgent';
import { SelfPlayEngine } from '../src/ai/SelfPlayEngine';
import {
  describeAgentTuning,
  getDefaultAgentTuning,
  parseTuningFlag,
  resolveAgentTuning,
  type AgentTuning,
} from '../src/ai/AgentTuning';
import { replaySeat, seededRandom, withSeededRandom, type DecisionOutcome } from '../src/ai/benchmark/agreement';
import { rowsFromSheet, parseReplayGame, campOf, type ReplayGame, type ReplayProposal } from '../src/ai/benchmark/sheetsReplay';
import { buildReplayObservation, roleKnowledge, seatId } from '../src/ai/benchmark/replayObservation';
import { computeTopPerformers, cohortKey } from '../src/ai/benchmark/cohorts';
import { getForwardTelemetry } from '../src/ai/forward/ForwardAgent';
import {
  goodVouchDeclarations,
  goodVouchOptionsFromEnv,
  setGoodVouchOptions,
  type GoodVouchOptions,
} from '../src/ai/GoodLakeFollowUp';
import { analyzeLakeChain, findRule3Violators } from '../src/ai/baseline/lakeChainTracker';
import type { AgentAction, AvalonAgent, PlayerObservation, SelfPlayResult } from '../src/ai/types';

interface Args {
  players: string[];
  json?: string;
  cache: string;
  agent: boolean;
  flags: Partial<AgentTuning>;
  base: Partial<AgentTuning>;
  selfplay?: number;
  seed: number;
  seats: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    players: [],
    cache: path.resolve(__dirname, '..', 'sheets_cache.json'),
    agent: true,
    flags: {},
    base: {},
    seed: 20261012,
    seats: 10,
  };
  let anyFlag = false;
  let anyBase = false;
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
      case '--no-agent': args.agent = false; break;
      case '--flag': Object.assign(args.flags, parseTuningFlag(next())); anyFlag = true; break;
      case '--base': Object.assign(args.base, parseTuningFlag(next())); anyBase = true; break;
      case '--selfplay': args.selfplay = Number.parseInt(next(), 10); break;
      case '--seed': args.seed = Number.parseInt(next(), 10); break;
      case '--seats': args.seats = Number.parseInt(next(), 10); break;
      case '--help': case '-h':
        console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
        process.exit(0);
        break;
      default: throw new Error(`unknown argument ${a}`);
    }
  }
  if (!Number.isInteger(args.seats) || args.seats < 7 || args.seats > 10) throw new Error('--seats must be 7..10');
  if (!anyFlag) args.flags = { goodVouchFollowUp: true };
  if (!anyBase) args.base = { goodVouchFollowUp: false };
  return args;
}

// ── Statistics ─────────────────────────────────────────────────

interface Rate { k: number; n: number; rate: number; low: number; high: number }

function wilsonRate(k: number, n: number): Rate {
  if (n === 0) return { k, n, rate: 0, low: 0, high: 0 };
  const z = 1.959964;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { k, n, rate: p, low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

function fmt(r: Rate): string {
  if (r.n === 0) return '— (n=0)';
  const p = (x: number): string => `${(x * 100).toFixed(1)}%`;
  return `${p(r.rate)} [${p(r.low)}, ${p(r.high)}] ${r.k}/${r.n}`;
}

function rateOf<T>(items: readonly T[], pred: (x: T) => boolean): Rate {
  return wilsonRate(items.filter(pred).length, items.length);
}

interface Section {
  title: string;
  rows: Array<{ label: string; value: string; rate?: Rate }>;
}

function printSections(label: string, sections: readonly Section[]): void {
  console.log(`\n================ ${label} ================`);
  for (const s of sections) {
    console.log(`\n${s.title}`);
    for (const r of s.rows) console.log(`  ${r.label.padEnd(56)} ${r.value}`);
  }
}

function rateRow(label: string, rate: Rate): { label: string; value: string; rate: Rate } {
  return { label, value: fmt(rate), rate };
}

// ── Human records: one per (good holder, later proposal) ───────

type Position = 'lead' | 'on' | 'off';

/** A proposal after a good seat's first binding lake declaration. */
export interface HolderProposal {
  gameId: string;
  /** Global proposal index in the game. */
  proposal: number;
  seat: number;
  name: string;
  role: string;
  round: number;
  attempt: number;
  forced: boolean;
  /** Blue : red mission score before the proposal. */
  score: string;
  position: Position;
  /** The holder's vote; null for forced / unreliable records. */
  vote: boolean | null;
  /** The holder's own claim and target (a seat holds the lake at most once). */
  ownClaim: 'good' | 'evil' | null;
  ownTarget: string | null;
  teamHasOwnTarget: boolean;
  /** Chain seats (declared by a seat the holder declared blue) bound at this proposal. */
  chainBlue: string[];
  chainRed: string[];
  teamMissesChainBlue: boolean;
  teamHasChainRed: boolean;
  /** Merlin: the seats bound as blue (own or chain) that Merlin sees as red. */
  merlinKnownRedBound: string[];
  /** Team of the proposal. */
  team: string[];
}

const CHAIN_FOLLOW: GoodVouchOptions = { scope: 'chain', merlin: 'follow', onTeam: 'off' };

function scoreBefore(game: ReplayGame, round: number): string {
  const qs = game.quests.filter((q) => q.round < round);
  return `${qs.filter((q) => !q.failed).length}:${qs.filter((q) => q.failed).length}`;
}

function collectHuman(games: readonly ReplayGame[]): HolderProposal[] {
  const out: HolderProposal[] = [];
  for (const game of games) {
    if (!game.lakeChainValid) continue;
    for (const lake of game.lakes) {
      if (lake.claim === null) continue;
      const seat = lake.holderSeat;
      const role = game.seatRoles[seat - 1];
      if (campOf(role) !== 'good') continue;
      const known = new Set(roleKnowledge(game, seat).knownEvils);
      game.proposals.forEach((p: ReplayProposal, idx) => {
        if (p.round <= lake.round) return;
        const obs = buildReplayObservation(game, seat, { kind: 'team_vote', proposal: idx });
        const decl = goodVouchDeclarations(obs, CHAIN_FOLLOW);
        if (!decl) return;
        const team = p.teamSeats.map(seatId);
        const teamSet = new Set(team);
        const ownTarget = seatId(lake.targetSeat);
        const position: Position = p.leaderSeat === seat ? 'lead' : p.teamSeats.includes(seat) ? 'on' : 'off';
        out.push({
          gameId: game.id,
          proposal: idx,
          seat,
          name: game.names[seat - 1] ?? '',
          role,
          round: p.round,
          attempt: p.attempt,
          forced: p.forced,
          score: scoreBefore(game, p.round),
          position,
          vote: !p.forced && p.votesReliable ? p.votes[seat - 1] : null,
          ownClaim: lake.claim,
          ownTarget,
          teamHasOwnTarget: teamSet.has(ownTarget),
          chainBlue: decl.chainBlue,
          chainRed: decl.chainRed,
          teamMissesChainBlue: decl.chainBlue.some((id) => !teamSet.has(id)),
          teamHasChainRed: decl.chainRed.some((id) => teamSet.has(id)),
          merlinKnownRedBound: role === 'merlin' ? decl.blue.filter((id) => known.has(id)) : [],
          team,
        });
      });
    }
  }
  return out;
}

const ROLES = ['merlin', 'percival', 'loyal'] as const;

function analyseHuman(all: readonly HolderProposal[]): Section[] {
  const sections: Section[] = [];
  const blueLeads = all.filter((x) => x.position === 'lead' && x.ownClaim === 'good');
  const redLeads = all.filter((x) => x.position === 'lead' && x.ownClaim === 'evil');
  const incl = (x: HolderProposal): boolean => x.teamHasOwnTarget;
  sections.push({
    title: '(1) blue holder leads after declaring a seat BLUE: the seat is on the team',
    rows: [
      rateRow('all led proposals', rateOf(blueLeads, incl)),
      rateRow('non-forced', rateOf(blueLeads.filter((x) => !x.forced), incl)),
      rateRow('forced 5th proposal', rateOf(blueLeads.filter((x) => x.forced), incl)),
      ...[3, 4, 5].map((r) => rateRow(`R${r}`, rateOf(blueLeads.filter((x) => x.round === r), incl))),
      ...uniq(blueLeads.map((x) => x.score)).map((s) => rateRow(`score blue ${s.replace(':', ' : red ')}`, rateOf(blueLeads.filter((x) => x.score === s), incl))),
      ...ROLES.map((r) => rateRow(`role ${r}`, rateOf(blueLeads.filter((x) => x.role === r), incl))),
    ],
  });
  sections.push({
    title: '(2) blue holder leads after declaring a seat RED: the seat is on the team',
    rows: [
      rateRow('all led proposals', rateOf(redLeads, incl)),
      rateRow('non-forced', rateOf(redLeads.filter((x) => !x.forced), incl)),
      rateRow('forced 5th proposal', rateOf(redLeads.filter((x) => x.forced), incl)),
      ...[3, 4, 5].map((r) => rateRow(`R${r}`, rateOf(redLeads.filter((x) => x.round === r), incl))),
      ...ROLES.map((r) => rateRow(`role ${r}`, rateOf(redLeads.filter((x) => x.role === r), incl))),
    ],
  });
  const voted = (pos: Position): HolderProposal[] => all.filter((x) => x.position === pos && x.vote !== null);
  const rejected = (x: HolderProposal): boolean => x.vote === false;
  for (const pos of ['off', 'on'] as const) {
    const v = voted(pos);
    const vb = v.filter((x) => x.ownClaim === 'good');
    const vr = v.filter((x) => x.ownClaim === 'evil');
    sections.push({
      title: `(${pos === 'off' ? 3 : 4}) holder ${pos === 'off' ? 'OFF the team (not leader, not member)' : 'ON the team (member, not leader)'} — reject rate (non-forced, reliable votes)`,
      rows: [
        rateRow('declared BLUE; team leaves the seat out', rateOf(vb.filter((x) => !x.teamHasOwnTarget), rejected)),
        rateRow('declared BLUE; team includes the seat', rateOf(vb.filter((x) => x.teamHasOwnTarget), rejected)),
        ...[3, 4, 5].map((r) => rateRow(`  … leaves it out, R${r}`, rateOf(vb.filter((x) => !x.teamHasOwnTarget && x.round === r), rejected))),
        ...ROLES.map((r) => rateRow(`  … leaves it out, role ${r}`, rateOf(vb.filter((x) => !x.teamHasOwnTarget && x.role === r), rejected))),
        rateRow('declared RED; team includes the seat', rateOf(vr.filter((x) => x.teamHasOwnTarget), rejected)),
        rateRow('declared RED; team leaves the seat out', rateOf(vr.filter((x) => !x.teamHasOwnTarget), rejected)),
      ],
    });
  }
  // (5) chain
  const chainBlueLeads = all.filter((x) => x.position === 'lead' && x.chainBlue.length > 0);
  const chainRedLeads = all.filter((x) => x.position === 'lead' && x.chainRed.length > 0);
  const chainOff = voted('off');
  const chainOn = voted('on');
  sections.push({
    title: '(5) chain — holder A declared B blue, then B declared C: what A does with C',
    rows: [
      rateRow('A leads, B declared C blue: C on the team', rateOf(chainBlueLeads, (x) => !x.teamMissesChainBlue)),
      rateRow('  … non-forced', rateOf(chainBlueLeads.filter((x) => !x.forced), (x) => !x.teamMissesChainBlue)),
      rateRow('A leads, B declared C red: C on the team', rateOf(chainRedLeads, (x) => x.teamHasChainRed)),
      rateRow('A off the team, B declared C blue; team leaves C out: reject',
        rateOf(chainOff.filter((x) => x.chainBlue.length > 0 && x.teamMissesChainBlue), rejected)),
      rateRow('A off the team, B declared C blue; team includes C: reject',
        rateOf(chainOff.filter((x) => x.chainBlue.length > 0 && !x.teamMissesChainBlue), rejected)),
      rateRow('A off the team, B declared C red; team includes C: reject',
        rateOf(chainOff.filter((x) => x.chainRed.length > 0 && x.teamHasChainRed), rejected)),
      rateRow('A off the team, B declared C red; team leaves C out: reject',
        rateOf(chainOff.filter((x) => x.chainRed.length > 0 && !x.teamHasChainRed), rejected)),
      rateRow('A on the team (member), B declared C blue; team leaves C out: reject',
        rateOf(chainOn.filter((x) => x.chainBlue.length > 0 && x.teamMissesChainBlue), rejected)),
      rateRow('A on the team (member), B declared C blue; team includes C: reject',
        rateOf(chainOn.filter((x) => x.chainBlue.length > 0 && !x.teamMissesChainBlue), rejected)),
      rateRow('A on the team (member), B declared C red; team includes C: reject',
        rateOf(chainOn.filter((x) => x.chainRed.length > 0 && x.teamHasChainRed), rejected)),
    ],
  });
  // (6) Merlin
  const merlinConflict = all.filter((x) => x.merlinKnownRedBound.length > 0);
  sections.push({
    title: '(6) Merlin — a seat bound as blue (own or chain) that Merlin sees as red',
    rows: [
      { label: 'proposals after such a declaration (any position)', value: `${merlinConflict.length}` },
      { label: 'distinct holder-games', value: `${new Set(merlinConflict.map((x) => `${x.gameId}|${x.seat}`)).size}` },
      rateRow('Merlin leads: a bound-blue seat he sees as red is on the team',
        rateOf(merlinConflict.filter((x) => x.position === 'lead'), (x) => x.team.some((id) => x.merlinKnownRedBound.includes(id)))),
    ],
  });
  return sections;
}

function uniq(xs: readonly string[]): string[] {
  return [...new Set(xs)].sort();
}

// ── Agent on the same replay states ────────────────────────────

interface AgentPoint {
  rec: HolderProposal;
  /** Agent's team (seat ids) when leading; agent's vote otherwise. */
  agentTeam?: string[];
  agentVote?: boolean;
  outcome: DecisionOutcome;
}

function agentPoints(
  games: readonly ReplayGame[],
  human: readonly HolderProposal[],
  tuning: AgentTuning,
): AgentPoint[] {
  const byKey = new Map<string, HolderProposal>();
  for (const h of human) byKey.set(`${h.gameId}|${h.seat}|${h.round}|${h.attempt}`, h);
  const seatsByGame = new Map<string, Set<number>>();
  for (const h of human) {
    const s = seatsByGame.get(h.gameId) ?? new Set<number>();
    s.add(h.seat);
    seatsByGame.set(h.gameId, s);
  }
  const out: AgentPoint[] = [];
  for (const game of games) {
    const seats = seatsByGame.get(game.id);
    if (!seats) continue;
    for (const seat of [...seats].sort((a, b) => a - b)) {
      const outcomes = replaySeat(game, seat, {
        makeAgent: (id) => new HeuristicAgent(id, undefined, undefined, tuning),
      });
      for (const o of outcomes) {
        if (o.type !== 'team' && o.type !== 'vote') continue;
        const rec = byKey.get(`${game.id}|${seat}|${o.round}|${o.attempt}`);
        if (!rec) continue;
        if (o.type === 'team') {
          const agentTeam = o.agent ? o.agent.split(',').map((s) => seatId(Number.parseInt(s, 10))) : [];
          out.push({ rec, agentTeam, outcome: o });
        } else {
          out.push({ rec, agentVote: o.agent === 'approve', outcome: o });
        }
      }
    }
  }
  return out;
}

/** The team breaks the holder's own declaration (leaves out its blue / includes its red). */
function breaksOwn(r: HolderProposal): boolean {
  return (r.ownClaim === 'good' && !r.teamHasOwnTarget) || (r.ownClaim === 'evil' && r.teamHasOwnTarget);
}

/** …or a chain declaration (the scope the default `goodVouchFollowUp` binds). */
function breaksBound(r: HolderProposal): boolean {
  return breaksOwn(r) || r.teamMissesChainBlue || r.teamHasChainRed;
}

function analyseAgent(points: readonly AgentPoint[]): Section[] {
  const leads = points.filter((p) => p.agentTeam !== undefined);
  const blueLeads = leads.filter((p) => p.rec.ownClaim === 'good');
  const redLeads = leads.filter((p) => p.rec.ownClaim === 'evil');
  const has = (p: AgentPoint): boolean => p.rec.ownTarget !== null && (p.agentTeam ?? []).includes(p.rec.ownTarget);
  const votes = points.filter((p) => p.agentVote !== undefined);
  const off = votes.filter((p) => p.rec.position === 'off');
  const on = votes.filter((p) => p.rec.position === 'on');
  const offMissBlue = off.filter((p) => p.rec.ownClaim === 'good' && !p.rec.teamHasOwnTarget);
  const offWithRed = off.filter((p) => p.rec.ownClaim === 'evil' && p.rec.teamHasOwnTarget);
  const onMissBlue = on.filter((p) => p.rec.ownClaim === 'good' && !p.rec.teamHasOwnTarget);
  const agentRejects = (p: AgentPoint): boolean => p.agentVote === false;
  const match = (p: AgentPoint): boolean => p.outcome.match;
  const meanJ = (ps: readonly AgentPoint[]): string => {
    if (ps.length === 0) return '— (n=0)';
    const m = ps.reduce((a, p) => a + (p.outcome.jaccard ?? 0), 0) / ps.length;
    return `${(m * 100).toFixed(1)}% (n=${ps.length})`;
  };
  const chainLeads = leads.filter((p) => p.rec.chainBlue.length > 0);
  return [
    {
      title: '(A1) agent leads after the holder declared a seat BLUE: the seat on the agent\'s team',
      rows: [
        rateRow('all', rateOf(blueLeads, has)),
        rateRow('non-forced', rateOf(blueLeads.filter((p) => !p.rec.forced), has)),
        rateRow('forced 5th proposal', rateOf(blueLeads.filter((p) => p.rec.forced), has)),
        ...ROLES.map((r) => rateRow(`role ${r}`, rateOf(blueLeads.filter((p) => p.rec.role === r), has))),
      ],
    },
    {
      title: '(A2) agent leads after the holder declared a seat RED: the seat on the agent\'s team',
      rows: [rateRow('all', rateOf(redLeads, has))],
    },
    {
      title: '(A3) agent votes (human states): reject rate',
      rows: [
        rateRow('off the team, declared BLUE left out', rateOf(offMissBlue, agentRejects)),
        rateRow('off the team, declared BLUE included', rateOf(off.filter((p) => p.rec.ownClaim === 'good' && p.rec.teamHasOwnTarget), agentRejects)),
        rateRow('off the team, declared RED included', rateOf(offWithRed, agentRejects)),
        rateRow('on the team, declared BLUE left out', rateOf(onMissBlue, agentRejects)),
        rateRow('off the team, chain BLUE left out', rateOf(off.filter((p) => p.rec.chainBlue.length > 0 && p.rec.teamMissesChainBlue), agentRejects)),
        rateRow('off the team, chain RED included', rateOf(off.filter((p) => p.rec.teamHasChainRed), agentRejects)),
        rateRow('on the team, a bound declaration broken (own or chain)', rateOf(on.filter((p) => breaksBound(p.rec)), agentRejects)),
      ],
    },
    {
      title: '(A4) agreement with the human on the targeted decisions',
      rows: [
        { label: 'team after own declaration: Jaccard (mean)', value: meanJ(leads) },
        rateRow('team after own declaration: exact', rateOf(leads, match)),
        { label: '  … non-forced: Jaccard (mean)', value: meanJ(leads.filter((p) => !p.rec.forced)) },
        { label: '  … chain seat bound: Jaccard (mean)', value: meanJ(chainLeads) },
        rateRow('vote off the team, team breaks the declaration', rateOf([...offMissBlue, ...offWithRed], match)),
        rateRow('vote off the team, team keeps the declaration', rateOf(off.filter((p) => !breaksOwn(p.rec)), match)),
        rateRow('vote on the team, team breaks the declaration', rateOf(on.filter((p) => breaksOwn(p.rec)), match)),
        rateRow('vote off the team, team breaks a bound declaration (own or chain)', rateOf(off.filter((p) => breaksBound(p.rec)), match)),
        rateRow('vote on the team, team breaks a bound declaration (own or chain)', rateOf(on.filter((p) => breaksBound(p.rec)), match)),
        rateRow('every vote after own declaration', rateOf(votes, match)),
      ],
    },
  ];
}

/** Exact two-sided McNemar p (binomial, p = 1/2) for b vs c discordant pairs. */
function mcnemarP(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  let term = Math.pow(0.5, n); // C(n, 0) / 2^n
  let tail = term;
  for (let i = 1; i <= k; i++) {
    term *= (n - i + 1) / i;
    tail += term;
  }
  return Math.min(1, 2 * tail);
}

/**
 * Paired baseline → variant on the same human states (same seat, same
 * proposal): how many teams moved closer to / further from the human's
 * (Jaccard), and how many votes became / stopped being the human's.
 */
function pairedSection(base: readonly AgentPoint[], variant: readonly AgentPoint[]): Section {
  const key = (p: AgentPoint): string =>
    `${p.rec.gameId}|${p.rec.seat}|${p.rec.round}|${p.rec.attempt}|${p.agentTeam !== undefined ? 'T' : 'V'}`;
  const byKey = new Map(variant.map((p) => [key(p), p]));
  let missing = 0;
  let closer = 0; let further = 0; let same = 0; let exactGain = 0; let exactLoss = 0;
  const votes = { offBreak: [0, 0, 0], onBreak: [0, 0, 0], all: [0, 0, 0] }; // [n, gained, lost]
  for (const b of base) {
    const v = byKey.get(key(b));
    if (!v) { missing++; continue; }
    if (b.agentTeam !== undefined) {
      const jb = b.outcome.jaccard ?? 0;
      const jv = v.outcome.jaccard ?? 0;
      if (jv > jb + 1e-12) closer++; else if (jv < jb - 1e-12) further++; else same++;
      if (v.outcome.match && !b.outcome.match) exactGain++;
      if (!v.outcome.match && b.outcome.match) exactLoss++;
      continue;
    }
    const buckets = [votes.all];
    if (b.rec.position === 'off' && breaksBound(b.rec)) buckets.push(votes.offBreak);
    if (b.rec.position === 'on' && breaksBound(b.rec)) buckets.push(votes.onBreak);
    for (const t of buckets) {
      t[0]++;
      if (v.outcome.match && !b.outcome.match) t[1]++;
      if (!v.outcome.match && b.outcome.match) t[2]++;
    }
  }
  const voteRow = (label: string, [n, g, l]: number[]): { label: string; value: string } => ({
    label, value: `${g} / ${l} (n=${n}; McNemar p = ${mcnemarP(g, l).toPrecision(2)})`,
  });
  return {
    title: '(P) paired baseline → variant on the same decisions',
    rows: [
      { label: 'teams after own declaration: closer / further / same', value: `${closer} / ${further} / ${same} (Jaccard; exact match +${exactGain} −${exactLoss}; McNemar p = ${mcnemarP(closer, further).toPrecision(2)})` },
      voteRow('votes off the team, a bound declaration broken: gained / lost', votes.offBreak),
      voteRow('votes on the team, a bound declaration broken: gained / lost', votes.onBreak),
      voteRow('every vote after own declaration: gained / lost', votes.all),
      ...(missing > 0 ? [{ label: 'baseline decisions without a variant pair', value: `${missing}` }] : []),
    ],
  };
}

// ── Self-play (B and C games of selfPlayStrength.ts) ────────────

type Camp = 'good' | 'evil';

class GameContext {
  readonly camp = new Map<string, Camp>();
  readonly role = new Map<string, string>();
  finalObs: PlayerObservation | null = null;
}

/** Same seeding as `selfPlayStrength.ts`'s `SwitchAgent`. */
class StudyAgent implements AvalonAgent {
  readonly agentId: string;
  readonly agentType = 'heuristic' as const;
  private readonly variant: HeuristicAgent;
  private readonly base: HeuristicAgent;
  private inner: HeuristicAgent;
  gameSeed = '';
  ctx: GameContext | null = null;

  constructor(agentId: string, private readonly variantTeam: Camp, variantTuning: AgentTuning, baseTuning: AgentTuning) {
    this.agentId = agentId;
    this.variant = new HeuristicAgent(agentId, undefined, undefined, variantTuning);
    this.base = new HeuristicAgent(agentId, undefined, undefined, baseTuning);
    this.inner = this.base;
  }

  private seedFor(obs: PlayerObservation, extra = ''): string {
    return [
      this.gameSeed, obs.myPlayerId, obs.gamePhase, `R${obs.currentRound}`, `A${obs.failCount}`,
      `V${obs.voteHistory.length}`, `Q${obs.questHistory.length}`, `L${obs.lakeHistory?.length ?? 0}`,
      obs.proposedTeam.join(','), extra,
    ].join('|');
  }

  onGameStart(obs: PlayerObservation): void {
    this.ctx?.camp.set(obs.myPlayerId, obs.myTeam);
    this.ctx?.role.set(obs.myPlayerId, obs.myRole as string);
    this.inner = obs.myTeam === this.variantTeam ? this.variant : this.base;
    this.inner.onGameStart(obs);
  }

  act(obs: PlayerObservation): AgentAction {
    return withSeededRandom(this.seedFor(obs), () => this.inner.act(obs));
  }

  pickLakeTarget(obs: PlayerObservation, validTargets?: readonly string[]): string {
    return withSeededRandom(this.seedFor(obs, 'lake'), () => this.inner.pickLakeTarget(obs, validTargets));
  }

  declareLake(obs: PlayerObservation, targetId: string, trueFaction: Camp | undefined): Camp | null {
    return withSeededRandom(this.seedFor(obs, `claim-${targetId}`), () => this.inner.declareLake(obs, targetId, trueFaction));
  }

  onGameEnd(obs: PlayerObservation, won: boolean): void {
    if (this.ctx && !this.ctx.finalObs) this.ctx.finalObs = obs;
    this.inner.onGameEnd(obs, won);
  }
}

interface SelfPlayTally {
  games: number;
  goodWins: number;
  threeBlue: number;
  merlinHit: number;
  /** Good holder declared blue → later teams it led / incl. the seat (non-forced / forced). */
  blueLed: number; blueLedIncl: number; blueLedForced: number; blueLedForcedIncl: number;
  /** Good holder declared red → later teams it led / incl. the seat. */
  redLed: number; redLedIncl: number;
  /** Good holder off the team, non-forced: team without the declared-blue seat / rejected. */
  offMissBlue: number; offMissBlueReject: number;
  offWithBlue: number; offWithBlueReject: number;
  offWithRed: number; offWithRedReject: number;
  /** Blue holders flagged by 硬3 (≥ 0.85) at the end of the game / blue holders who declared blue. */
  blueHolders: number; blueHoldersFlagged: number;
  /**
   * …of the flagged ones, those with at least one team led after the
   * declaration that leaves a declared-blue seat out (they may also have
   * pre-declaration teams that would flag them).
   */
  blueHoldersFlaggedPost: number;
  /** Red seats flagged by 硬3 at the end / red seats. */
  redFlagged: number;
}

function emptyTally(): SelfPlayTally {
  return {
    games: 0, goodWins: 0, threeBlue: 0, merlinHit: 0,
    blueLed: 0, blueLedIncl: 0, blueLedForced: 0, blueLedForcedIncl: 0, redLed: 0, redLedIncl: 0,
    offMissBlue: 0, offMissBlueReject: 0, offWithBlue: 0, offWithBlueReject: 0, offWithRed: 0, offWithRedReject: 0,
    blueHolders: 0, blueHoldersFlagged: 0, blueHoldersFlaggedPost: 0, redFlagged: 0,
  };
}

function tallyGame(t: SelfPlayTally, ctx: GameContext, result: SelfPlayResult): void {
  t.games++;
  if (result.winner === 'good') t.goodWins++;
  if (result.threeBlue) { t.threeBlue++; if (result.merlinKilled) t.merlinHit++; }
  const obs = ctx.finalObs;
  if (!obs) return;
  const isGood = (id: string): boolean => ctx.camp.get(id) === 'good';
  for (const l of obs.lakeHistory ?? []) {
    if (l.declaredClaim === 'none') continue;
    if (!isGood(l.holderId)) continue;
    const later = obs.voteHistory.filter((v) => v.round > l.round);
    const led = later.filter((v) => v.leader === l.holderId);
    if (l.declaredClaim === 'good') {
      for (const v of led) {
        const inc = v.team.includes(l.targetId);
        if (v.attempt >= 5) { t.blueLedForced++; if (inc) t.blueLedForcedIncl++; } else { t.blueLed++; if (inc) t.blueLedIncl++; }
      }
    } else {
      t.redLed += led.length;
      t.redLedIncl += led.filter((v) => v.team.includes(l.targetId)).length;
    }
    const off = later.filter((v) => v.attempt < 5 && v.leader !== l.holderId && !v.team.includes(l.holderId)
      && v.votes[l.holderId] !== undefined);
    for (const v of off) {
      const inc = v.team.includes(l.targetId);
      const rej = v.votes[l.holderId] === false;
      if (l.declaredClaim === 'good') {
        if (inc) { t.offWithBlue++; if (rej) t.offWithBlueReject++; } else { t.offMissBlue++; if (rej) t.offMissBlueReject++; }
      } else if (inc) { t.offWithRed++; if (rej) t.offWithRedReject++; }
    }
  }
  const chain = analyzeLakeChain(obs);
  const flags = findRule3Violators(chain, obs);
  for (const [holder] of chain.declaredBlueByHolder) {
    if (!isGood(holder)) continue;
    t.blueHolders++;
    if ((flags.get(holder) ?? 0) >= 0.85) {
      t.blueHoldersFlagged++;
      // Flagged by a team led after the declaration?
      const lakeRound = Math.min(...(obs.lakeHistory ?? []).filter((l) => l.holderId === holder).map((l) => l.round));
      const targets = chain.declaredBlueByHolder.get(holder) ?? new Set<string>();
      const post = obs.voteHistory.some((v) => v.leader === holder && v.round > lakeRound
        && [...targets].some((tg) => !v.team.includes(tg)));
      if (post) t.blueHoldersFlaggedPost++;
    }
  }
  for (const [id, lvl] of flags) if (lvl >= 0.85 && !isGood(id)) t.redFlagged++;
}

function selfPlaySections(label: string, t: SelfPlayTally): Section {
  return {
    title: label,
    rows: [
      rateRow('good final win', wilsonRate(t.goodWins, t.games)),
      rateRow('three-blue (missions)', wilsonRate(t.threeBlue, t.games)),
      rateRow('Merlin hit (three-blue games)', wilsonRate(t.merlinHit, t.threeBlue)),
      rateRow('blue holder declared BLUE → leads (non-forced) incl. the seat', wilsonRate(t.blueLedIncl, t.blueLed)),
      rateRow('  … forced 5th proposal incl. the seat', wilsonRate(t.blueLedForcedIncl, t.blueLedForced)),
      rateRow('blue holder declared RED → leads incl. the seat', wilsonRate(t.redLedIncl, t.redLed)),
      rateRow('off the team, declared BLUE left out: reject', wilsonRate(t.offMissBlueReject, t.offMissBlue)),
      rateRow('off the team, declared BLUE included: reject', wilsonRate(t.offWithBlueReject, t.offWithBlue)),
      rateRow('off the team, declared RED included: reject', wilsonRate(t.offWithRedReject, t.offWithRed)),
      rateRow('blue holders (declared blue) flagged by 硬3 ≥ 0.85 at the end', wilsonRate(t.blueHoldersFlagged, t.blueHolders)),
      rateRow('  … flagged by a team led after the declaration', wilsonRate(t.blueHoldersFlaggedPost, t.blueHolders)),
      { label: 'red seats flagged by 硬3 ≥ 0.85 at the end (per game)', value: (t.redFlagged / Math.max(1, t.games)).toFixed(3) },
    ],
  };
}

async function runSelfPlay(args: Args, variantTuning: AgentTuning, baseTuning: AgentTuning): Promise<Record<string, SelfPlayTally>> {
  const engine = new SelfPlayEngine();
  const tallies = { variantBlue: emptyTally(), control: emptyTally() };
  let bMinusC = 0;
  const originalLog = console.log;
  const started = Date.now();
  console.log = (): void => undefined;
  try {
    for (let i = 0; i < (args.selfplay ?? 0); i++) {
      const gameSeed = `${args.seed}|${i}`;
      const wins: Record<string, boolean> = {};
      for (const arrangement of ['variantBlue', 'control'] as const) {
        const tuning = arrangement === 'control' ? baseTuning : variantTuning;
        const ctx = new GameContext();
        const agents = Array.from({ length: args.seats }, (_, k) => new StudyAgent(`P${k + 1}`, 'good', tuning, baseTuning));
        for (const a of agents) { a.gameSeed = gameSeed; a.ctx = ctx; }
        const originalRandom = Math.random;
        Math.random = seededRandom(`${gameSeed}|setup`);
        let result: SelfPlayResult;
        try {
          result = await engine.runGame(agents, false);
        } finally {
          Math.random = originalRandom;
        }
        tallyGame(tallies[arrangement], ctx, result);
        wins[arrangement] = result.winner === 'good';
      }
      bMinusC += (wins.variantBlue ? 1 : 0) - (wins.control ? 1 : 0);
      if ((i + 1) % 250 === 0) {
        process.stderr.write(`[selfplay] ${i + 1}/${args.selfplay} seeds, ${((Date.now() - started) / 1000).toFixed(0)}s\n`);
      }
    }
  } finally {
    console.log = originalLog;
  }
  console.log(`self-play seed ${args.seed}, ${args.seats} seats, ${args.selfplay} seeds; B − C good wins: ${bMinusC} games (${((100 * bMinusC) / Math.max(1, args.selfplay ?? 1)).toFixed(2)}pp)`);
  return tallies;
}

// ── Main ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const options = goodVouchOptionsFromEnv();
  setGoodVouchOptions(options);
  if (process.env.AVALON_GOOD_VOUCH_VARIANT) process.stderr.write(`goodVouchFollowUp variant: ${JSON.stringify(options)}\n`);
  const baseTuning = resolveAgentTuning(args.base, getDefaultAgentTuning());
  const variantTuning = resolveAgentTuning(args.flags, baseTuning);
  console.log(`baseline: ${describeAgentTuning(baseTuning)}`);
  console.log(`variant:  ${describeAgentTuning(variantTuning)}`);
  const result: Record<string, unknown> = {};

  if (args.selfplay !== undefined) {
    const tallies = await runSelfPlay(args, variantTuning, baseTuning);
    printSections('self-play — good holders (B = variant blue vs baseline red; C = baseline both sides)', [
      selfPlaySections('B (variant on the good seats)', tallies.variantBlue),
      selfPlaySections('C (control)', tallies.control),
    ]);
    const tel = getForwardTelemetry();
    console.log(`forward telemetry: ${tel.totalDecisions} decisions via ForwardAgent, ${tel.fallbacks} fallbacks`);
    result.selfplay = tallies;
  } else {
    const data = JSON.parse(fs.readFileSync(args.cache, 'utf8')) as Record<string, string[][]>;
    const rows = rowsFromSheet(data['牌譜'] ?? []);
    const games: ReplayGame[] = [];
    for (const row of rows) {
      if (!(row['文字記錄'] ?? '').trim()) continue;
      const res = parseReplayGame(row);
      if (res.ok) games.push(res.game);
    }
    const top = computeTopPerformers(games);
    const human = collectHuman(games);
    console.log(`replayable 10p games: ${games.length}; with a valid lake chain: ${games.filter((g) => g.lakeChainValid).length}`);
    console.log(`good holders with a declaration: ${new Set(human.map((h) => `${h.gameId}|${h.seat}`)).size}; later proposals: ${human.length}`);
    const cohortOf = (items: readonly HolderProposal[]): Array<[string, HolderProposal[]]> => [
      ['population', [...items]],
      ['top/role', items.filter((h) => top.members.has(cohortKey(h.name, h.role)))],
      ...args.players.map((p): [string, HolderProposal[]] => [p, items.filter((h) => h.name === p)]),
    ];
    for (const [label, items] of cohortOf(human)) {
      const sections = analyseHuman(items);
      result[`human ${label}`] = sections;
      printSections(`humans — ${label} (proposals after a good holder's declaration n=${items.length})`, sections);
    }
    if (args.agent) {
      const cohortPoints = (points: readonly AgentPoint[]): Array<[string, AgentPoint[]]> => [
        ['population', [...points]],
        ['top/role', points.filter((p) => top.members.has(cohortKey(p.rec.name, p.rec.role)))],
        ...args.players.map((pl): [string, AgentPoint[]] => [pl, points.filter((p) => p.rec.name === pl)]),
      ];
      const pointsByTag: Record<string, AgentPoint[]> = {};
      for (const [tag, tuning] of [['baseline', baseTuning], ['variant', variantTuning]] as const) {
        const points = agentPoints(games, human, tuning);
        pointsByTag[tag] = points;
        for (const [label, items] of cohortPoints(points)) {
          const sections = analyseAgent(items);
          result[`agent ${tag} ${label}`] = sections;
          printSections(`agent ${tag} (${describeAgentTuning(tuning)}) on human states — ${label}`, sections);
        }
      }
      const variantCohorts = new Map(cohortPoints(pointsByTag.variant));
      for (const [label, items] of cohortPoints(pointsByTag.baseline)) {
        const section = pairedSection(items, variantCohorts.get(label) ?? []);
        result[`paired ${label}`] = [section];
        printSections(`paired baseline → variant — ${label}`, [section]);
      }
      const tel = getForwardTelemetry();
      console.log(`\nforward telemetry: ${tel.totalDecisions} decisions via ForwardAgent, ${tel.fallbacks} fallbacks`);
    }
  }
  if (args.json) {
    fs.writeFileSync(path.resolve(args.json), JSON.stringify({ generatedBy: 'packages/server/scripts/goodLakeFollowUpStudy.ts', options, result }, null, 2));
    console.log(`wrote ${path.resolve(args.json)}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
