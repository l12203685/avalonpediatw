/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * Red-lake diagnosis — WHY does a red-side switch (here: the human evil
 * lake strategy, `evilLakeHumanStrategy`) change red's self-play win rate?
 * (strength_benchmark.md 第 7 節, 2026-10-13 round 2.)
 *
 *   USE_FORWARD_REASONING=true pnpm --filter @avalon/server exec tsx scripts/redLakeDiagnosis.ts \
 *     --flag ... --base ... [--seed 99 --seed 4242] [--games 5000] \
 *     [--rule3 on|off|postlake|redOnly|blueOnly] [--json out.json]
 *
 * Plays, for every seed, the two games of `selfPlayStrength.ts` that
 * matter for a red-only switch — A (variant red vs baseline blue) and C
 * (baseline vs baseline) — with the identical seating, roles and per-
 * decision random streams (same seeding code, so A / C match
 * `selfPlayStrength.ts` exactly when no ablation is set). On top of the
 * paired red difference it records, per game:
 *   - every lake (holder camp / role, target camp, claim, legal teammates);
 *   - who the good bots' 硬3 rule (`findRule3Violators`: a holder who
 *     declared someone blue but left them off a team they led → ≥ 0.85
 *     suspicion; led a team that failed → 0.5) flags, by camp and by the
 *     round before which the flag appears;
 *   - whether red holders follow up on their own vouch (the declared-blue
 *     seat on later teams they lead; their votes on teams with that seat);
 *   - reds on the missions after the first lake;
 * and prints A vs C side by side plus the seeds where A and C disagree.
 *
 * Diagnostic ablations (benchmark only; the server never sets them):
 *   --rule3 off        no 硬3 flags at all (every agent, both games)
 *   --rule3 postlake   硬3 only counts teams led after the declaration
 *   --rule3 redOnly    only red holders can be flagged (hidden roles)
 *   --rule3 blueOnly   only blue holders can be flagged
 *   AVALON_EVIL_LAKE_HUMAN_VARIANT="oberon=legacy" / "lastLake=legacy" /
 *     "target=legacy" / "claim=legacy" / "chaos=never" hand one part of the
 *     variant's red lake back to the pre-switch rule (LakePolicy).
 *
 * `--json` writes per-seed outcomes so several runs on the same seeds can
 * be compared pairwise (difference of A−C differences); `--trace 99:55`
 * prints that seed's A and C games move by move (missions, lakes, 硬3).
 */

import * as fs from 'fs';
import * as path from 'path';
import { HeuristicAgent } from '../src/ai/HeuristicAgent';
import { SelfPlayEngine } from '../src/ai/SelfPlayEngine';
import {
  LEGACY_AGENT_TUNING,
  describeAgentTuning,
  parseTuningFlag,
  resolveAgentTuning,
  type AgentTuning,
} from '../src/ai/AgentTuning';
import { seededRandom, withSeededRandom } from '../src/ai/benchmark/agreement';
import { getForwardTelemetry } from '../src/ai/forward/ForwardAgent';
import {
  DEFAULT_EVIL_LAKE_HUMAN_OPTIONS,
  evilLakeHumanOptionsFromEnv,
  setEvilLakeHumanOptions,
} from '../src/ai/LakePolicy';
import { setVouchFollowUpOptions, vouchFollowUpOptionsFromEnv } from '../src/ai/RedLakeFollowUp';
import {
  analyzeLakeChain,
  findRule3Violators,
  setRule3DiagnosticOptions,
} from '../src/ai/baseline/lakeChainTracker';
import type { AgentAction, AvalonAgent, PlayerObservation, SelfPlayResult } from '../src/ai/types';

type Rule3Mode = 'on' | 'off' | 'postlake' | 'redOnly' | 'blueOnly';

interface Args {
  flags: Partial<AgentTuning>;
  base: Partial<AgentTuning>;
  games: number;
  seeds: number[];
  rule3: Rule3Mode;
  json?: string;
  label?: string;
  /** `seed:index` pairs whose A and C games are printed move by move. */
  trace: string[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = { flags: {}, base: {}, games: 2000, seeds: [], rule3: 'on', trace: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case '--flag': Object.assign(args.flags, parseTuningFlag(next())); break;
      case '--base': Object.assign(args.base, parseTuningFlag(next())); break;
      case '--games': args.games = Number.parseInt(next(), 10); break;
      case '--seed': args.seeds.push(Number.parseInt(next(), 10)); break;
      case '--rule3': {
        const v = next();
        if (!['on', 'off', 'postlake', 'redOnly', 'blueOnly'].includes(v)) throw new Error(`bad --rule3 ${v}`);
        args.rule3 = v as Rule3Mode;
        break;
      }
      case '--json': args.json = next(); break;
      case '--label': args.label = next(); break;
      case '--trace': args.trace.push(next()); break;
      case '--help': case '-h':
        console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
        process.exit(0);
        break;
      default: throw new Error(`unknown argument ${a}`);
    }
  }
  if (args.seeds.length === 0) args.seeds = [20261012];
  if (!Number.isFinite(args.games) || args.games <= 0) throw new Error('--games must be a positive integer');
  return args;
}

// ── Per-game record ────────────────────────────────────────────

type Camp = 'good' | 'evil';

interface LakeRec {
  round: number;
  holderCamp: Camp;
  holderRole: string;
  targetCamp: Camp;
  /** Target is a teammate the holder could see. */
  teammate: boolean;
  /** At least one visible teammate was a legal target. */
  teammateLegal: boolean;
  claim: Camp | null;
}

interface GameRec {
  evilWon: boolean;
  threeBlue: boolean;
  merlinKilled: boolean | null;
  lakes: LakeRec[];
  /** 硬3 flags (≥ 0.85) visible before the first proposal of round r (r = 3..5), by camp. */
  r3Flags: Record<string, { red: number; blue: number }>;
  /** 硬3 flags at the end of the game (≥ 0.85 / 0.5 only), by camp. */
  r3End: { red85: number; blue85: number; red50: number; blue50: number };
  /** Red holders who declared a seat blue: later teams they led, how many included it. */
  redVouchLed: number;
  redVouchLedIncl: number;
  /** Their later votes on teams containing that seat, how many approvals. */
  redVouchVotes: number;
  redVouchVotesApprove: number;
  /** Their later votes on teams WITHOUT that seat, how many rejections. */
  redVouchOffVotes: number;
  redVouchOffReject: number;
  /** The vouched seat (when red): later teams it led / how many include the red holder. */
  vouchedRedLed: number;
  vouchedRedLedIncl: number;
  /** Red holders who declared a seat red: later teams they led / how many include it. */
  redFrameLed: number;
  redFrameLedIncl: number;
  /** Same for blue holders. */
  blueVouchLed: number;
  blueVouchLedIncl: number;
  /** Reds on missions after the first lake (rounds 3+), summed; missions counted. */
  missionsAfterLake: number;
  redsOnMissionsAfterLake: number;
  /** Rule-3-flagged reds that went on a later mission (count of seat-missions). */
  flaggedRedsOnMissions: number;
  /** Proposals led by a seeing red (assassin / Morgana / Mordred) per round, and how many carry a visible teammate. */
  seeingLed: number[];
  seeingLedMate: number[];
}

function emptyGame(): GameRec {
  return {
    evilWon: false, threeBlue: false, merlinKilled: null, lakes: [], r3Flags: {},
    r3End: { red85: 0, blue85: 0, red50: 0, blue50: 0 },
    redVouchLed: 0, redVouchLedIncl: 0, redVouchVotes: 0, redVouchVotesApprove: 0,
    redVouchOffVotes: 0, redVouchOffReject: 0, vouchedRedLed: 0, vouchedRedLedIncl: 0,
    redFrameLed: 0, redFrameLedIncl: 0,
    blueVouchLed: 0, blueVouchLedIncl: 0,
    missionsAfterLake: 0, redsOnMissionsAfterLake: 0, flaggedRedsOnMissions: 0,
    seeingLed: [0, 0, 0, 0, 0, 0], seeingLedMate: [0, 0, 0, 0, 0, 0],
  };
}

/** Shared per-game state the agents fill in (roles at start, final public history at the end). */
class GameContext {
  readonly camp = new Map<string, Camp>();
  readonly role = new Map<string, string>();
  finalObs: PlayerObservation | null = null;
  readonly rec = emptyGame();
}

// ── Agents (same seeding as selfPlayStrength.ts) ───────────────

class DiagAgent implements AvalonAgent {
  readonly agentId: string;
  readonly agentType = 'heuristic' as const;
  private readonly variant: HeuristicAgent;
  private readonly base: HeuristicAgent;
  private inner: HeuristicAgent;
  gameSeed = '';
  ctx: GameContext | null = null;
  private pending: { teammate: boolean; teammateLegal: boolean } | null = null;

  constructor(
    agentId: string,
    private readonly variantTeam: Camp,
    variantTuning: AgentTuning,
    baseTuning: AgentTuning,
  ) {
    this.agentId = agentId;
    this.variant = new HeuristicAgent(agentId, undefined, undefined, variantTuning);
    this.base = new HeuristicAgent(agentId, undefined, undefined, baseTuning);
    this.inner = this.base;
  }

  private seedFor(obs: PlayerObservation, extra = ''): string {
    return [
      this.gameSeed,
      obs.myPlayerId,
      obs.gamePhase,
      `R${obs.currentRound}`,
      `A${obs.failCount}`,
      `V${obs.voteHistory.length}`,
      `Q${obs.questHistory.length}`,
      `L${obs.lakeHistory?.length ?? 0}`,
      obs.proposedTeam.join(','),
      extra,
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
    const target = withSeededRandom(this.seedFor(obs, 'lake'), () => this.inner.pickLakeTarget(obs, validTargets));
    const visible = new Set(obs.knownEvils);
    this.pending = {
      teammate: obs.myTeam === 'evil' && visible.has(target),
      teammateLegal: obs.myTeam === 'evil' && (validTargets ?? []).some((id) => visible.has(id)),
    };
    return target;
  }

  declareLake(obs: PlayerObservation, targetId: string, trueFaction: Camp | undefined): Camp | null {
    const claim = withSeededRandom(this.seedFor(obs, `claim-${targetId}`), () =>
      this.inner.declareLake(obs, targetId, trueFaction));
    const p = this.pending ?? { teammate: false, teammateLegal: false };
    this.pending = null;
    this.ctx?.rec.lakes.push({
      round: obs.currentRound,
      holderCamp: obs.myTeam,
      holderRole: obs.myRole as string,
      targetCamp: trueFaction ?? 'good',
      teammate: p.teammate,
      teammateLegal: p.teammateLegal,
      claim,
    });
    return claim;
  }

  onGameEnd(obs: PlayerObservation, won: boolean): void {
    if (this.ctx && !this.ctx.finalObs) this.ctx.finalObs = obs;
    this.inner.onGameEnd(obs, won);
  }
}

// ── Post-game analysis of the public record ────────────────────

function truncated(obs: PlayerObservation, beforeRound: number): PlayerObservation {
  return {
    ...obs,
    voteHistory: obs.voteHistory.filter((v) => v.round < beforeRound),
    questHistory: obs.questHistory.filter((q) => q.round < beforeRound),
    lakeHistory: (obs.lakeHistory ?? []).filter((l) => l.round < beforeRound),
  };
}

function analyseGame(ctx: GameContext): void {
  const obs = ctx.finalObs;
  if (!obs) return;
  const rec = ctx.rec;
  const isRed = (id: string): boolean => ctx.camp.get(id) === 'evil';
  for (let r = 3; r <= 5; r++) {
    const flags = findRule3Violators(analyzeLakeChain(truncated(obs, r)), truncated(obs, r));
    let red = 0; let blue = 0;
    for (const [id, lvl] of flags) {
      if (lvl < 0.85) continue;
      if (isRed(id)) red++; else blue++;
    }
    rec.r3Flags[`R${r}`] = { red, blue };
  }
  const endFlags = findRule3Violators(analyzeLakeChain(obs), obs);
  const flagged85 = new Set<string>();
  for (const [id, lvl] of endFlags) {
    if (lvl >= 0.85) {
      flagged85.add(id);
      if (isRed(id)) rec.r3End.red85++; else rec.r3End.blue85++;
    } else if (isRed(id)) rec.r3End.red50++; else rec.r3End.blue50++;
  }
  for (const l of obs.lakeHistory ?? []) {
    const later = obs.voteHistory.filter((v) => v.round > l.round);
    const led = later.filter((v) => v.leader === l.holderId);
    const incl = led.filter((v) => v.team.includes(l.targetId)).length;
    if (l.declaredClaim !== 'good') {
      if (isRed(l.holderId)) { rec.redFrameLed += led.length; rec.redFrameLedIncl += incl; }
      continue;
    }
    if (isRed(l.holderId)) {
      rec.redVouchLed += led.length;
      rec.redVouchLedIncl += incl;
      // Forced 5th proposals carry synthetic unanimous votes; skip them.
      const voted = later.filter((v) => v.votes[l.holderId] !== undefined && v.attempt < 5);
      const withTarget = voted.filter((v) => v.team.includes(l.targetId));
      rec.redVouchVotes += withTarget.length;
      rec.redVouchVotesApprove += withTarget.filter((v) => v.votes[l.holderId] === true).length;
      const withoutTarget = voted.filter((v) => !v.team.includes(l.targetId));
      rec.redVouchOffVotes += withoutTarget.length;
      rec.redVouchOffReject += withoutTarget.filter((v) => v.votes[l.holderId] === false).length;
      if (isRed(l.targetId)) {
        const targetLed = later.filter((v) => v.leader === l.targetId);
        rec.vouchedRedLed += targetLed.length;
        rec.vouchedRedLedIncl += targetLed.filter((v) => v.team.includes(l.holderId)).length;
      }
    } else {
      rec.blueVouchLed += led.length;
      rec.blueVouchLedIncl += incl;
    }
  }
  const seeing = (id: string): boolean => ['assassin', 'morgana', 'mordred'].includes(ctx.role.get(id) ?? '');
  for (const v of obs.voteHistory) {
    if (!seeing(v.leader) || v.round < 1 || v.round > 5) continue;
    rec.seeingLed[v.round]++;
    if (v.team.some((id) => id !== v.leader && seeing(id))) rec.seeingLedMate[v.round]++;
  }
  const firstLakeRound = Math.min(...(obs.lakeHistory ?? []).map((l) => l.round), Number.POSITIVE_INFINITY);
  for (const q of obs.questHistory) {
    if (q.round <= firstLakeRound) continue;
    rec.missionsAfterLake++;
    rec.redsOnMissionsAfterLake += q.team.filter(isRed).length;
    const flagsBefore = findRule3Violators(analyzeLakeChain(truncated(obs, q.round)), truncated(obs, q.round));
    rec.flaggedRedsOnMissions += q.team.filter((id) => isRed(id) && (flagsBefore.get(id) ?? 0) >= 0.85).length;
  }
}

// ── Runner ─────────────────────────────────────────────────────

async function playGame(
  engine: SelfPlayEngine,
  gameSeed: string,
  variantTeam: Camp,
  variantTuning: AgentTuning,
  baseTuning: AgentTuning,
): Promise<GameRec> {
  const ctx = new GameContext();
  const agents = Array.from({ length: 10 }, (_, i) =>
    new DiagAgent(`P${i + 1}`, variantTeam, variantTuning, baseTuning));
  for (const a of agents) { a.gameSeed = gameSeed; a.ctx = ctx; }
  currentGame = ctx;
  const originalRandom = Math.random;
  Math.random = seededRandom(`${gameSeed}|setup`);
  let result: SelfPlayResult;
  try {
    result = await engine.runGame(agents, false);
  } finally {
    Math.random = originalRandom;
  }
  ctx.rec.evilWon = result.winner === 'evil';
  ctx.rec.threeBlue = result.threeBlue ?? false;
  ctx.rec.merlinKilled = result.merlinKilled ?? null;
  analyseGame(ctx);
  if (traceSeeds.has(gameSeed)) traceLines.push(...traceGame(ctx, `${gameSeed} ${variantTeam === 'evil' ? 'A' : 'C'}`));
  return ctx.rec;
}

const traceSeeds = new Set<string>();
const traceLines: string[] = [];

/** Move-by-move summary of one game (approved teams, missions, lakes, 硬3 flags). */
function traceGame(ctx: GameContext, label: string): string[] {
  const obs = ctx.finalObs;
  if (!obs) return [];
  const short: Record<string, string> = { assassin: 'ass', morgana: 'mga', mordred: 'mdr', oberon: 'obe', merlin: 'mer' };
  const tag = (id: string): string => {
    const role = ctx.role.get(id) ?? '';
    return `${id}${ctx.camp.get(id) === 'evil' ? `*${short[role] ?? role}` : role === 'merlin' ? '(mer)' : ''}`;
  };
  const out = [`── ${label}: ${ctx.rec.evilWon ? 'red' : 'blue'} wins${ctx.rec.threeBlue ? ` (three blue, Merlin ${ctx.rec.merlinKilled ? 'killed' : 'alive'})` : ''}`];
  for (let r = 1; r <= 5; r++) {
    const q = obs.questHistory.find((x) => x.round === r);
    if (!q) break;
    const props = obs.voteHistory.filter((v) => v.round === r);
    const flags = findRule3Violators(analyzeLakeChain(truncated(obs, r)), truncated(obs, r));
    const flagged = [...flags].filter(([, l]) => l >= 0.85).map(([id]) => tag(id));
    out.push(`  R${r} mission ${q.team.map(tag).join(' ')} → ${q.result} (${q.failCount})` +
      `${flagged.length ? `; 硬3 ≥0.85 before: ${flagged.join(' ')}` : ''}`);
    out.push(`     proposals: ${props.map((v) => `${v.leader}:[${v.team.join(' ')}]${v.approved ? '✓' : '✗'}`).join(' ')}`);
    for (const l of (obs.lakeHistory ?? []).filter((x) => x.round === r)) {
      out.push(`     lake: ${tag(l.holderId)} → ${tag(l.targetId)} declared ${l.declaredClaim === 'good' ? 'blue' : 'red'}`);
    }
  }
  return out;
}

let currentGame: GameContext | null = null;

function installRule3(mode: Rule3Mode): void {
  switch (mode) {
    case 'on': setRule3DiagnosticOptions(undefined); break;
    case 'off': setRule3DiagnosticOptions({ off: true }); break;
    case 'postlake': setRule3DiagnosticOptions({ postLakeOnly: true }); break;
    case 'redOnly':
      setRule3DiagnosticOptions({ holderFilter: (id) => currentGame?.camp.get(id) === 'evil' });
      break;
    case 'blueOnly':
      setRule3DiagnosticOptions({ holderFilter: (id) => currentGame?.camp.get(id) === 'good' });
      break;
  }
}

// ── Statistics ─────────────────────────────────────────────────

interface Interval { rate: number; low: number; high: number }

function pairedDiff(diffs: readonly number[]): Interval {
  const n = diffs.length;
  if (n === 0) return { rate: 0, low: 0, high: 0 };
  const mean = diffs.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1 ? diffs.reduce((a, d) => a + (d - mean) ** 2, 0) / (n - 1) : 0;
  const half = 1.959964 * Math.sqrt(variance / n);
  return { rate: mean, low: mean - half, high: mean + half };
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const pp = (x: number): string => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(2)}pp`;
const fmtDiff = (d: Interval): string => `${pp(d.rate)} [${pp(d.low)}, ${pp(d.high)}]`;
const frac = (k: number, n: number): string => (n === 0 ? '—' : `${pct(k / n)} (${k}/${n})`);

interface SeedOutcome { seed: number; index: number; a: GameRec; c: GameRec }

function sum(games: readonly GameRec[], f: (g: GameRec) => number): number {
  return games.reduce((acc, g) => acc + f(g), 0);
}

function sideReport(label: string, games: readonly GameRec[]): string[] {
  const n = games.length;
  const lakes = games.flatMap((g) => g.lakes);
  const byIdx = (i: number): LakeRec[] => games.map((g) => g.lakes[i]).filter((l): l is LakeRec => l !== undefined);
  const redHolders = lakes.filter((l) => l.holderCamp === 'evil');
  const seeing = redHolders.filter((l) => l.holderRole !== 'oberon');
  const oberon = redHolders.filter((l) => l.holderRole === 'oberon');
  const redBlue = redHolders.filter((l) => l.targetCamp === 'good');
  const blueHolders = lakes.filter((l) => l.holderCamp === 'good');
  const lines = [
    `── ${label} (${n} games) ──`,
    `red win ${frac(sum(games, (g) => (g.evilWon ? 1 : 0)), n)}; three-red ${frac(sum(games, (g) => (g.threeBlue ? 0 : 1)), n)}; ` +
      `Merlin hit ${frac(sum(games, (g) => (g.merlinKilled ? 1 : 0)), sum(games, (g) => (g.threeBlue ? 1 : 0)))}`,
    `lake holder red: 1st ${frac(byIdx(0).filter((l) => l.holderCamp === 'evil').length, byIdx(0).length)}, ` +
      `2nd ${frac(byIdx(1).filter((l) => l.holderCamp === 'evil').length, byIdx(1).length)}, ` +
      `3rd ${frac(byIdx(2).filter((l) => l.holderCamp === 'evil').length, byIdx(2).length)}`,
    `red holders: teammate laked when legal ${frac(seeing.filter((l) => l.teammate).length, seeing.filter((l) => l.teammateLegal).length)}; ` +
      `blue target declared red ${frac(redBlue.filter((l) => l.claim === 'evil').length, redBlue.length)} ` +
      `(seeing ${frac(redBlue.filter((l) => l.holderRole !== 'oberon' && l.claim === 'evil').length, redBlue.filter((l) => l.holderRole !== 'oberon').length)}, ` +
      `Oberon ${frac(redBlue.filter((l) => l.holderRole === 'oberon' && l.claim === 'evil').length, redBlue.filter((l) => l.holderRole === 'oberon').length)}); ` +
      `Oberon target red ${frac(oberon.filter((l) => l.targetCamp === 'evil').length, oberon.length)}; ` +
      `red claims "good" ${frac(redHolders.filter((l) => l.claim === 'good').length, redHolders.length)}`,
    `blue holders: ${blueHolders.length} lakes, target red ${frac(blueHolders.filter((l) => l.targetCamp === 'evil').length, blueHolders.length)}`,
    `硬3 ≥0.85 flags before R3 / R4 / R5 (games with ≥1 red flagged | ≥1 blue flagged): ` +
      ['R3', 'R4', 'R5'].map((r) =>
        `${r} ${frac(games.filter((g) => (g.r3Flags[r]?.red ?? 0) > 0).length, n)} | ${frac(games.filter((g) => (g.r3Flags[r]?.blue ?? 0) > 0).length, n)}`).join('; '),
    `硬3 at game end: red ≥0.85 ${sum(games, (g) => g.r3End.red85)}, blue ≥0.85 ${sum(games, (g) => g.r3End.blue85)}, ` +
      `red 0.5 ${sum(games, (g) => g.r3End.red50)}, blue 0.5 ${sum(games, (g) => g.r3End.blue50)} (seat-games)`,
    `vouch follow-up: red holder led after vouching ${frac(sum(games, (g) => g.redVouchLedIncl), sum(games, (g) => g.redVouchLed))} incl. the vouched seat; ` +
      `red holder approved teams with the vouched seat ${frac(sum(games, (g) => g.redVouchVotesApprove), sum(games, (g) => g.redVouchVotes))}, ` +
      `rejected teams without it ${frac(sum(games, (g) => g.redVouchOffReject), sum(games, (g) => g.redVouchOffVotes))}; ` +
      `vouched red later led incl. the holder ${frac(sum(games, (g) => g.vouchedRedLedIncl), sum(games, (g) => g.vouchedRedLed))}; ` +
      `red holder led after declaring red ${frac(sum(games, (g) => g.redFrameLedIncl), sum(games, (g) => g.redFrameLed))} incl. the framed seat; ` +
      `blue holder led ${frac(sum(games, (g) => g.blueVouchLedIncl), sum(games, (g) => g.blueVouchLed))} incl.`,
    `seeing-red leaders: team with a visible teammate ` +
      [1, 2, 3, 4, 5].map((r) => `R${r} ${frac(sum(games, (g) => g.seeingLedMate[r]), sum(games, (g) => g.seeingLed[r]))}`).join(', '),
    `missions after the first lake: ${sum(games, (g) => g.missionsAfterLake)}, reds per mission ` +
      `${(sum(games, (g) => g.redsOnMissionsAfterLake) / Math.max(1, sum(games, (g) => g.missionsAfterLake))).toFixed(3)}, ` +
      `flagged reds sent ${sum(games, (g) => g.flaggedRedsOnMissions)}`,
  ];
  return lines;
}

function flipReport(outcomes: readonly SeedOutcome[]): string[] {
  const lost = outcomes.filter((o) => !o.a.evilWon && o.c.evilWon); // variant red lost a game baseline won
  const won = outcomes.filter((o) => o.a.evilWon && !o.c.evilWon);
  const feature = (label: string, f: (o: SeedOutcome) => boolean): string =>
    `  ${label}: lost ${frac(lost.filter(f).length, lost.length)} · won ${frac(won.filter(f).length, won.length)} · all ${frac(outcomes.filter(f).length, outcomes.length)}`;
  const redFlagged = (g: GameRec): boolean => g.r3End.red85 > 0;
  const blueFlagged = (g: GameRec): boolean => g.r3End.blue85 > 0;
  const blueHeld = (g: GameRec): number => g.lakes.filter((l) => l.holderCamp === 'good').length;
  return [
    `flipped seeds: variant red lost where baseline won ${lost.length}, won where baseline lost ${won.length} (net ${won.length - lost.length})`,
    feature('red flagged ≥0.85 in A, not in C', (o) => redFlagged(o.a) && !redFlagged(o.c)),
    feature('red flagged in C, not in A', (o) => redFlagged(o.c) && !redFlagged(o.a)),
    feature('blue flagged ≥0.85 in C, not in A', (o) => blueFlagged(o.c) && !blueFlagged(o.a)),
    feature('blue flagged in A, not in C', (o) => blueFlagged(o.a) && !blueFlagged(o.c)),
    feature('fewer blue-held lakes in A than C', (o) => blueHeld(o.a) < blueHeld(o.c)),
    feature('A had a red claim on a blue', (o) => o.a.lakes.some((l) => l.holderCamp === 'evil' && l.targetCamp === 'good' && l.claim === 'evil')),
    feature('A: Oberon held the lake', (o) => o.a.lakes.some((l) => l.holderRole === 'oberon')),
    feature('A: red held the last lake', (o) => o.a.lakes[2]?.holderCamp === 'evil'),
    feature('reached three blue in A (assassination decided)', (o) => o.a.threeBlue),
    feature('reached three blue in C', (o) => o.c.threeBlue),
  ];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const variantTuning = resolveAgentTuning(args.flags, { ...LEGACY_AGENT_TUNING });
  const baseTuning = resolveAgentTuning(args.base, { ...LEGACY_AGENT_TUNING });
  const evilLakeOptions = evilLakeHumanOptionsFromEnv();
  setEvilLakeHumanOptions(evilLakeOptions);
  // Benchmark-only knob for `evilVouchFollowUp` (AVALON_VOUCH_FOLLOW_UP_VARIANT, e.g.
  // "decisiveWindow=follow"); the server never reads it.
  const vouchOptions = vouchFollowUpOptionsFromEnv();
  setVouchFollowUpOptions(vouchOptions);
  if (process.env.AVALON_VOUCH_FOLLOW_UP_VARIANT) process.stderr.write(`evilVouchFollowUp variant: ${JSON.stringify(vouchOptions)}\n`);
  const variantKnob = JSON.stringify(evilLakeOptions) === JSON.stringify(DEFAULT_EVIL_LAKE_HUMAN_OPTIONS)
    ? 'default' : process.env.AVALON_EVIL_LAKE_HUMAN_VARIANT ?? '';
  installRule3(args.rule3);
  for (const t of args.trace) traceSeeds.add(t.replace(':', '|'));
  const label = args.label ?? `${describeAgentTuning(variantTuning)} | rule3=${args.rule3} | lake=${variantKnob}`;
  const engine = new SelfPlayEngine();
  const started = Date.now();
  const outcomes: SeedOutcome[] = [];

  const originalLog = console.log;
  console.log = (): void => undefined;
  try {
    for (const seed of args.seeds) {
      for (let i = 0; i < args.games; i++) {
        const gameSeed = `${seed}|${i}`;
        const a = await playGame(engine, gameSeed, 'evil', variantTuning, baseTuning);
        const c = await playGame(engine, gameSeed, 'good', baseTuning, baseTuning);
        outcomes.push({ seed, index: i, a, c });
        if ((i + 1) % 500 === 0 || i + 1 === args.games) {
          const elapsed = (Date.now() - started) / 1000;
          process.stderr.write(`[diag ${seed}] ${i + 1}/${args.games}, ${elapsed.toFixed(0)}s\n`);
        }
      }
    }
  } finally {
    console.log = originalLog;
    setRule3DiagnosticOptions(undefined);
  }

  const telemetry = getForwardTelemetry();
  const diffs = outcomes.map((o) => (o.a.evilWon ? 1 : 0) - (o.c.evilWon ? 1 : 0));
  const threeRedDiffs = outcomes.map((o) => (o.a.threeBlue ? 0 : 1) - (o.c.threeBlue ? 0 : 1));
  console.log(`label: ${label}`);
  console.log(`variant: ${describeAgentTuning(variantTuning)}`);
  console.log(`baseline: ${describeAgentTuning(baseTuning)}`);
  console.log(`seeds ${args.seeds.join(', ')} × ${args.games}; ${outcomes.length} pairs (A + C); ${((Date.now() - started) / 1000).toFixed(0)}s`);
  console.log(`red diff A−C ${fmtDiff(pairedDiff(diffs))}; three-red diff ${fmtDiff(pairedDiff(threeRedDiffs))}`);
  for (const seed of args.seeds) {
    const sub = outcomes.filter((o) => o.seed === seed);
    console.log(`  seed ${seed}: red diff ${fmtDiff(pairedDiff(sub.map((o) => (o.a.evilWon ? 1 : 0) - (o.c.evilWon ? 1 : 0))))}`);
  }
  for (const line of sideReport('A: variant red', outcomes.map((o) => o.a))) console.log(line);
  for (const line of sideReport('C: baseline red', outcomes.map((o) => o.c))) console.log(line);
  for (const line of flipReport(outcomes)) console.log(line);
  for (const line of traceLines) console.log(line);
  console.log(`forward telemetry: ${telemetry.totalDecisions} decisions via ForwardAgent, ${telemetry.fallbacks} fallbacks`);
  if (args.json) {
    const compact = outcomes.map((o) => ({
      s: o.seed, i: o.index,
      a: o.a.evilWon ? 1 : 0, c: o.c.evilWon ? 1 : 0,
      at: o.a.threeBlue ? 1 : 0, ct: o.c.threeBlue ? 1 : 0,
      ar: o.a.r3End.red85, cr: o.c.r3End.red85, ab: o.a.r3End.blue85, cb: o.c.r3End.blue85,
    }));
    fs.writeFileSync(path.resolve(args.json), JSON.stringify({ label, args, telemetry, outcomes: compact }));
    console.log(`wrote ${path.resolve(args.json)}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
