/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * Self-play strength benchmark — does an AgentTuning variant beat the
 * baseline agent in 10-player self-play?
 *
 *   pnpm --filter @avalon/server exec tsx scripts/selfPlayStrength.ts \
 *     --flag r3NormalVotePrior=0.6 [--flag ...] [--base FLAG ...] \
 *     [--games 2000] [--seed 20261012] [--json out.json] [--md out.md]
 *
 * Options:
 *   --flag NAME[=V]   variant tuning switch (repeatable; see AgentTuning.ts)
 *   --base NAME[=V]   baseline tuning switch (repeatable; default: legacy =
 *                     every switch off = behaviour before 2026-10-12)
 *   --games N         seeds (default 2000). Every seed is played three times
 *                     from the identical seating + roles: variant on the evil
 *                     seats vs baseline on the good seats (A), swapped (B),
 *                     and baseline vs baseline as the paired control (C) —
 *                     so 3N games in all
 *   --seed S          master seed (default 20261012)
 *   --json PATH       write the full result as JSON
 *   --md PATH         write the markdown summary
 *   --label TEXT      label for the markdown row (default: the flags)
 *
 * Fairness / determinism:
 *   - The engine's seat shuffle and role deal run under a PRNG seeded from
 *     (seed, game index), so both games of a pair start from the identical
 *     seating + roles.
 *   - Every agent decision runs under a PRNG seeded from (seed, game index,
 *     seat, decision context) — common random numbers: a baseline agent
 *     facing the same observation in both games makes the same choice.
 *   - Stances are read against the paired control game C (baseline on both
 *     sides): "variant as red" = evil wins in A vs evil wins in C, "variant
 *     as blue" = good wins in B vs good wins in C. Comparing A against B
 *     would be wrong — both differences are the same number, because each
 *     game has the variant on one side and the baseline on the other.
 *   - Combined = per-seed mean of (evil win in A, good win in B); exactly
 *     50% when the variant equals the baseline (the two games coincide).
 *
 * Run with USE_FORWARD_REASONING=true (production routing); the report
 * ends with the ForwardAgent telemetry line, which should say 0 fallbacks.
 * It also prints what red holders did with the lake in A and C (teammate
 * laked when legal, blue targets declared red, Oberon's hit rate) —
 * counted only, no randomness consumed, so win numbers are unaffected.
 *
 * Win definition = the engine's final result: evil wins on three fails or
 * on a Merlin kill after three successes; good wins only when Merlin
 * survives (Edward 2026-10-12 — 最終藍勝 = 三藍活).
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
import { redR1TeammateOptionsFromEnv, setRedR1TeammateOptions } from '../src/ai/RedR1Teammate';
import type { AgentAction, AvalonAgent, PlayerObservation, SelfPlayResult } from '../src/ai/types';

interface Args {
  flags: Partial<AgentTuning>;
  base: Partial<AgentTuning>;
  games: number;
  seed: number;
  json?: string;
  md?: string;
  label?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { flags: {}, base: {}, games: 2000, seed: 20261012 };
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
      case '--seed': args.seed = Number.parseInt(next(), 10); break;
      case '--json': args.json = next(); break;
      case '--md': args.md = next(); break;
      case '--label': args.label = next(); break;
      case '--help': case '-h':
        console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
        process.exit(0);
        break;
      default: throw new Error(`unknown argument ${a}`);
    }
  }
  if (!Number.isFinite(args.games) || args.games <= 0) throw new Error('--games must be a positive integer');
  return args;
}

// ── Statistics ─────────────────────────────────────────────────

export interface Interval {
  rate: number;
  low: number;
  high: number;
}

/** Wilson 95% score interval for k successes in n trials. */
export function wilson(k: number, n: number): Interval {
  if (n === 0) return { rate: 0, low: 0, high: 0 };
  const z = 1.959964;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { rate: p, low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

/** Normal-approximation 95% CI for the mean of paired differences (values in {-1,0,1}). */
export function pairedDiff(diffs: readonly number[]): Interval {
  const n = diffs.length;
  if (n === 0) return { rate: 0, low: 0, high: 0 };
  const mean = diffs.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1 ? diffs.reduce((a, d) => a + (d - mean) ** 2, 0) / (n - 1) : 0;
  const half = 1.959964 * Math.sqrt(variance / n);
  return { rate: mean, low: mean - half, high: mean + half };
}

// ── Red-held lake mix (descriptive) ────────────────────────────

/**
 * What red holders do with the lake, counted per arrangement (A = variant
 * red, C = baseline red). Observation only: no randomness is consumed, so
 * the win numbers are identical with or without it. "Seeing" = a red who
 * sees teammates (assassin / Morgana / Mordred); Oberon sees nobody.
 */
export interface RedLakeMix {
  /** Seeing-red lakes with ≥ 1 visible teammate legal, and how many laked one. */
  seeingTeammateLegal: number;
  seeingTeammateLaked: number;
  /** Seeing-red lakes on a blue target, and how many of those were declared red. */
  seeingBlue: number;
  seeingBlueClaimedRed: number;
  /** Oberon lakes, how many hit a red, and his blue targets declared red. */
  oberonLakes: number;
  oberonHitRed: number;
  oberonBlue: number;
  oberonBlueClaimedRed: number;
}

function emptyRedLakeMix(): RedLakeMix {
  return {
    seeingTeammateLegal: 0, seeingTeammateLaked: 0, seeingBlue: 0, seeingBlueClaimedRed: 0,
    oberonLakes: 0, oberonHitRed: 0, oberonBlue: 0, oberonBlueClaimedRed: 0,
  };
}

// ── Agents ─────────────────────────────────────────────────────

/**
 * Picks the variant or the baseline agent once the role is dealt (camp is
 * only known at `onGameStart`), and seeds `Math.random` per decision from
 * the observation so identical situations get identical randomness in
 * both games of a pair.
 */
class SwitchAgent implements AvalonAgent {
  readonly agentId: string;
  readonly agentType = 'heuristic' as const;
  private readonly variant: HeuristicAgent;
  private readonly base: HeuristicAgent;
  private inner: HeuristicAgent;
  gameSeed = '';
  /** Red-held lake counter for this game's arrangement (descriptive only). */
  lakeMix: RedLakeMix | undefined;
  private pendingLake: { oberon: boolean; teammate: boolean } | null = null;

  constructor(
    agentId: string,
    private readonly variantTeam: 'good' | 'evil',
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
    this.inner = obs.myTeam === this.variantTeam ? this.variant : this.base;
    this.inner.onGameStart(obs);
  }

  act(obs: PlayerObservation): AgentAction {
    return withSeededRandom(this.seedFor(obs), () => this.inner.act(obs));
  }

  pickLakeTarget(obs: PlayerObservation, validTargets?: readonly string[]): string {
    const target = withSeededRandom(this.seedFor(obs, 'lake'), () => this.inner.pickLakeTarget(obs, validTargets));
    this.pendingLake = null;
    if (this.lakeMix && obs.myTeam === 'evil') {
      const oberon = obs.myRole === 'oberon';
      const teammate = obs.knownEvils.includes(target);
      if (oberon) this.lakeMix.oberonLakes++;
      else if ((validTargets ?? []).some((id) => obs.knownEvils.includes(id))) {
        this.lakeMix.seeingTeammateLegal++;
        if (teammate) this.lakeMix.seeingTeammateLaked++;
      }
      this.pendingLake = { oberon, teammate };
    }
    return target;
  }

  declareLake(
    obs: PlayerObservation,
    targetId: string,
    trueFaction: 'good' | 'evil' | undefined,
  ): 'good' | 'evil' | null {
    const claim = withSeededRandom(this.seedFor(obs, `claim-${targetId}`), () =>
      this.inner.declareLake(obs, targetId, trueFaction));
    const pending = this.pendingLake;
    this.pendingLake = null;
    if (this.lakeMix && pending && !pending.teammate) {
      const m = this.lakeMix;
      if (pending.oberon && trueFaction === 'evil') m.oberonHitRed++;
      if (trueFaction === 'good') {
        if (pending.oberon) { m.oberonBlue++; if (claim === 'evil') m.oberonBlueClaimedRed++; }
        else { m.seeingBlue++; if (claim === 'evil') m.seeingBlueClaimedRed++; }
      }
    }
    return claim;
  }

  onGameEnd(obs: PlayerObservation, won: boolean): void {
    this.inner.onGameEnd(obs, won);
  }
}

// ── Runner ─────────────────────────────────────────────────────

interface GameOutcome {
  winner: 'good' | 'evil';
  threeBlue: boolean;
  merlinKilled: boolean | null;
  rounds: number;
}

type Arrangement = 'variantRed' | 'variantBlue' | 'control';

interface PairOutcome {
  /** A: variant evil, baseline good. */
  variantRed: GameOutcome;
  /** B: baseline evil, variant good. */
  variantBlue: GameOutcome;
  /** C: baseline on both sides. */
  control: GameOutcome;
}

function outcomeOf(r: SelfPlayResult): GameOutcome {
  return {
    winner: r.winner,
    threeBlue: r.threeBlue ?? false,
    merlinKilled: r.merlinKilled ?? null,
    rounds: r.rounds,
  };
}

async function playPair(
  engine: SelfPlayEngine,
  index: number,
  seed: number,
  variantTuning: AgentTuning,
  baseTuning: AgentTuning,
  lakeMix?: { variantRed: RedLakeMix; control: RedLakeMix },
): Promise<PairOutcome> {
  const out: Partial<PairOutcome> = {};
  const originalRandom = Math.random;
  for (const arrangement of ['variantRed', 'variantBlue', 'control'] as Arrangement[]) {
    const variantTeam = arrangement === 'variantRed' ? 'evil' : 'good';
    // The control game uses the baseline tuning on both sides.
    const tuning = arrangement === 'control' ? baseTuning : variantTuning;
    const agents = Array.from({ length: 10 }, (_, i) =>
      new SwitchAgent(`P${i + 1}`, variantTeam, tuning, baseTuning));
    const gameSeed = `${seed}|${index}`;
    const mix = arrangement === 'variantBlue' ? undefined : lakeMix?.[arrangement];
    for (const a of agents) { a.gameSeed = gameSeed; a.lakeMix = mix; }
    // Seat shuffle + role deal use the global Math.random.
    Math.random = seededRandom(`${gameSeed}|setup`);
    try {
      out[arrangement] = outcomeOf(await engine.runGame(agents, false));
    } finally {
      Math.random = originalRandom;
    }
  }
  return out as PairOutcome;
}

interface StanceStats {
  n: number;
  wins: number;
  ci: Interval;
}

function stance(wins: number, n: number): StanceStats {
  return { n, wins, ci: wilson(wins, n) };
}

export interface StrengthReport {
  label: string;
  variant: string;
  baseline: string;
  seed: number;
  pairs: number;
  games: number;
  elapsedSec: number;
  /** A: evil wins when the variant is red (vs baseline blue). */
  variantAsRed: StanceStats;
  /** C: evil wins when baseline plays baseline (the red-stance control). */
  controlRed: StanceStats;
  /** B: good wins when the variant is blue (vs baseline red). */
  variantAsBlue: StanceStats;
  /** C: good wins in the control (the blue-stance control). */
  controlBlue: StanceStats;
  /** Per-seed mean of (A evil win, B good win): 50% = no difference. */
  variantCombined: Interval & { wins: number; n: number };
  /** Paired difference vs the control, same stance (A − C for red, B − C for blue). */
  redDiff: Interval;
  blueDiff: Interval;
  /** Mission stage: three-red rate in A / B / C. */
  threeRed: { variantRed: StanceStats; variantBlue: StanceStats; control: StanceStats };
  /** Assassination stage (three-blue games only): Merlin-hit rate in A / B / C. */
  merlinHit: { variantRed: StanceStats; variantBlue: StanceStats; control: StanceStats };
  avgRounds: number;
  /** ForwardAgent routing telemetry for the whole run (USE_FORWARD_REASONING). */
  forwardTelemetry?: { totalDecisions: number; fallbacks: number };
  /** Red-held lake mix in A (variant red) and C (baseline red); descriptive. */
  redLakeMix?: { variantRed: RedLakeMix; control: RedLakeMix };
}

function summarise(
  label: string,
  variantTuning: AgentTuning,
  baseTuning: AgentTuning,
  seed: number,
  pairs: readonly PairOutcome[],
  elapsedSec: number,
): StrengthReport {
  const n = pairs.length;
  const evilWins = { variantRed: 0, variantBlue: 0, control: 0 };
  const threeRed = { variantRed: 0, variantBlue: 0, control: 0 };
  const threeBlue = { variantRed: 0, variantBlue: 0, control: 0 };
  const hits = { variantRed: 0, variantBlue: 0, control: 0 };
  let rounds = 0;
  const redDiffs: number[] = [];
  const blueDiffs: number[] = [];
  const combined: number[] = [];
  for (const p of pairs) {
    for (const key of ['variantRed', 'variantBlue', 'control'] as Arrangement[]) {
      const g = p[key];
      if (g.winner === 'evil') evilWins[key]++;
      if (!g.threeBlue) threeRed[key]++; else { threeBlue[key]++; if (g.merlinKilled) hits[key]++; }
      rounds += g.rounds;
    }
    const aEvil = p.variantRed.winner === 'evil' ? 1 : 0;
    const bGood = p.variantBlue.winner === 'good' ? 1 : 0;
    const cEvil = p.control.winner === 'evil' ? 1 : 0;
    redDiffs.push(aEvil - cEvil);
    blueDiffs.push(bGood - (1 - cEvil));
    combined.push((aEvil + bGood) / 2);
  }
  const combinedCi = pairedDiff(combined);
  return {
    label,
    variant: describeAgentTuning(variantTuning),
    baseline: describeAgentTuning(baseTuning),
    seed,
    pairs: n,
    games: 3 * n,
    elapsedSec,
    variantAsRed: stance(evilWins.variantRed, n),
    controlRed: stance(evilWins.control, n),
    variantAsBlue: stance(n - evilWins.variantBlue, n),
    controlBlue: stance(n - evilWins.control, n),
    variantCombined: { ...combinedCi, wins: evilWins.variantRed + (n - evilWins.variantBlue), n: 2 * n },
    redDiff: pairedDiff(redDiffs),
    blueDiff: pairedDiff(blueDiffs),
    threeRed: {
      variantRed: stance(threeRed.variantRed, n),
      variantBlue: stance(threeRed.variantBlue, n),
      control: stance(threeRed.control, n),
    },
    merlinHit: {
      variantRed: stance(hits.variantRed, threeBlue.variantRed),
      variantBlue: stance(hits.variantBlue, threeBlue.variantBlue),
      control: stance(hits.control, threeBlue.control),
    },
    avgRounds: n === 0 ? 0 : rounds / (3 * n),
  };
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function fmtStance(s: StanceStats): string {
  return `${pct(s.ci.rate)} [${pct(s.ci.low)}, ${pct(s.ci.high)}] (${s.wins}/${s.n})`;
}

function fmtDiff(d: Interval): string {
  const pp = (x: number): string => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}pp`;
  return `${pp(d.rate)} [${pp(d.low)}, ${pp(d.high)}]`;
}

function fmtCombined(r: StrengthReport): string {
  const c = r.variantCombined;
  return `${pct(c.rate)} [${pct(c.low)}, ${pct(c.high)}] (${c.wins}/${c.n})`;
}

export function markdownTable(reports: readonly StrengthReport[]): string {
  const header = '| 設定 | 局數 | 合計勝率 | 紅方立場（對照） | 紅方差 | 藍方立場（對照） | 藍方差 | 三紅率 A/B/C | 刺中率 A/B/C |';
  const sep = '|---|---|---|---|---|---|---|---|---|';
  const rows = reports.map((r) =>
    `| ${r.label} | ${r.games} | ${fmtCombined(r)} | ${pct(r.variantAsRed.ci.rate)}（${pct(r.controlRed.ci.rate)}） | ${fmtDiff(r.redDiff)} | ${pct(r.variantAsBlue.ci.rate)}（${pct(r.controlBlue.ci.rate)}） | ${fmtDiff(r.blueDiff)} | ${pct(r.threeRed.variantRed.ci.rate)} / ${pct(r.threeRed.variantBlue.ci.rate)} / ${pct(r.threeRed.control.ci.rate)} | ${pct(r.merlinHit.variantRed.ci.rate)} / ${pct(r.merlinHit.variantBlue.ci.rate)} / ${pct(r.merlinHit.control.ci.rate)} |`);
  return [header, sep, ...rows].join('\n');
}

function fmtRedLakeMix(m: RedLakeMix): string {
  const frac = (k: number, n: number): string => (n === 0 ? '—' : `${pct(k / n)} (${k}/${n})`);
  return [
    `teammate laked when legal ${frac(m.seeingTeammateLaked, m.seeingTeammateLegal)}`,
    `blue declared red: seeing reds ${frac(m.seeingBlueClaimedRed, m.seeingBlue)}, Oberon ${frac(m.oberonBlueClaimedRed, m.oberonBlue)}, all ${frac(m.seeingBlueClaimedRed + m.oberonBlueClaimedRed, m.seeingBlue + m.oberonBlue)}`,
    `Oberon target red ${frac(m.oberonHitRed, m.oberonLakes)}`,
  ].join('; ');
}

export function textReport(r: StrengthReport): string {
  return [
    `label: ${r.label}`,
    `variant: ${r.variant}`,
    `baseline: ${r.baseline}`,
    `seed ${r.seed}; ${r.pairs} seeds × 3 = ${r.games} games; ${r.elapsedSec.toFixed(0)}s; avg rounds ${r.avgRounds.toFixed(2)}`,
    `variant as red  (A) ${fmtStance(r.variantAsRed)}   control (C) ${fmtStance(r.controlRed)}   paired diff A−C ${fmtDiff(r.redDiff)}`,
    `variant as blue (B) ${fmtStance(r.variantAsBlue)}   control (C) ${fmtStance(r.controlBlue)}   paired diff B−C ${fmtDiff(r.blueDiff)}`,
    `variant combined    ${fmtCombined(r)}`,
    `three-red rate   A ${fmtStance(r.threeRed.variantRed)}   B ${fmtStance(r.threeRed.variantBlue)}   C ${fmtStance(r.threeRed.control)}`,
    `Merlin-hit rate  A ${fmtStance(r.merlinHit.variantRed)}   B ${fmtStance(r.merlinHit.variantBlue)}   C ${fmtStance(r.merlinHit.control)}`,
    ...(r.redLakeMix
      ? [
        `red lake mix A  ${fmtRedLakeMix(r.redLakeMix.variantRed)}`,
        `red lake mix C  ${fmtRedLakeMix(r.redLakeMix.control)}`,
      ]
      : []),
  ].join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const variantTuning = resolveAgentTuning(args.flags, { ...LEGACY_AGENT_TUNING });
  const baseTuning = resolveAgentTuning(args.base, { ...LEGACY_AGENT_TUNING });
  // Benchmark-only tactic mix for `evilLakeHumanStrategy`
  // (AVALON_EVIL_LAKE_HUMAN_VARIANT, e.g. "chaos=never"); the server never reads it.
  const evilLakeOptions = evilLakeHumanOptionsFromEnv();
  setEvilLakeHumanOptions(evilLakeOptions);
  // Benchmark-only knob for `evilVouchFollowUp` (AVALON_VOUCH_FOLLOW_UP_VARIANT, e.g.
  // "decisiveWindow=exempt"); the server never reads it.
  const vouchOptions = vouchFollowUpOptionsFromEnv();
  setVouchFollowUpOptions(vouchOptions);
  if (process.env.AVALON_VOUCH_FOLLOW_UP_VARIANT) process.stderr.write(`evilVouchFollowUp variant: ${JSON.stringify(vouchOptions)}\n`);
  // Benchmark-only knob for `redR1Teammate` (AVALON_RED_R1_TEAMMATE_VARIANT, e.g.
  // "talk=always"); the server never reads it.
  setRedR1TeammateOptions(redR1TeammateOptionsFromEnv());
  if (process.env.AVALON_RED_R1_TEAMMATE_VARIANT) process.stderr.write(`redR1Teammate variant: ${JSON.stringify(redR1TeammateOptionsFromEnv())}\n`);
  if (JSON.stringify(evilLakeOptions) !== JSON.stringify(DEFAULT_EVIL_LAKE_HUMAN_OPTIONS)) {
    process.stderr.write(`evilLakeHumanStrategy tactic mix: ${JSON.stringify(evilLakeOptions)}\n`);
  }
  const label = args.label ?? describeAgentTuning(variantTuning);
  const engine = new SelfPlayEngine();
  const started = Date.now();
  const pairs: PairOutcome[] = [];
  const redLakeMix = { variantRed: emptyRedLakeMix(), control: emptyRedLakeMix() };

  // GameEngine prints every event as JSON on stdout; keep the run quiet.
  const originalLog = console.log;
  console.log = (): void => undefined;
  try {
    for (let i = 0; i < args.games; i++) {
      pairs.push(await playPair(engine, i, args.seed, variantTuning, baseTuning, redLakeMix));
      if ((i + 1) % 100 === 0 || i + 1 === args.games) {
        const elapsed = (Date.now() - started) / 1000;
        const eta = (elapsed / (i + 1)) * (args.games - i - 1);
        process.stderr.write(`[${label}] ${i + 1}/${args.games} seeds, ${elapsed.toFixed(0)}s elapsed, ETA ${eta.toFixed(0)}s\n`);
      }
    }
  } finally {
    console.log = originalLog;
  }

  const report = summarise(label, variantTuning, baseTuning, args.seed, pairs, (Date.now() - started) / 1000);
  const telemetry = getForwardTelemetry();
  report.forwardTelemetry = { totalDecisions: telemetry.totalDecisions, fallbacks: telemetry.fallbacks };
  report.redLakeMix = redLakeMix;
  console.log(textReport(report));
  console.log(`forward telemetry: ${telemetry.totalDecisions} decisions via ForwardAgent, ${telemetry.fallbacks} fallbacks`);
  if (telemetry.totalDecisions === 0) {
    console.warn('WARNING: ForwardAgent path not active (set USE_FORWARD_REASONING=true) — results reflect the baseline HeuristicAgent only.');
  }
  console.log('');
  console.log(markdownTable([report]));
  if (args.json) {
    fs.writeFileSync(path.resolve(args.json), JSON.stringify(report, null, 2));
    console.log(`wrote ${path.resolve(args.json)}`);
  }
  if (args.md) {
    fs.writeFileSync(path.resolve(args.md), `${markdownTable([report])}\n`);
    console.log(`wrote ${path.resolve(args.md)}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
