/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * Homogeneous self-play — what happens to bot-vs-bot win rates when EVERY
 * seat uses a tuning (as on the live server and in the website practice
 * mode), not only one side as in `selfPlayStrength.ts`?
 *
 *   USE_FORWARD_REASONING=true pnpm --filter @avalon/server exec tsx scripts/selfPlayHomogeneous.ts \
 *     --flag NAME[=V] [--flag ...] [--base NAME[=V] ...] [--games 5000] [--seed S]
 *
 * Every seed is played twice from the identical seating + roles: all ten
 * seats on the baseline (`--base`, on top of legacy like selfPlayStrength)
 * and all ten on the variant (`--flag`, on top of legacy). Seeding is the
 * same as `selfPlayStrength.ts` (setup PRNG from (seed, index), decision
 * PRNG from (seed, index, seat, context)), so the baseline game equals that
 * script's control game C for the same seed and index. Reports red win
 * rates and the paired difference (variant − baseline) with a 95% interval.
 *
 * Also counts how leaders build on the previous team (descriptive only,
 * no randomness consumed; same definitions as `teamReuseStudy.ts`): the
 * first proposal after a successful / failed mission against that mission
 * team, later proposals of a round against the proposal just rejected —
 * "kept whole" (every reference seat kept, plus the extra seat when the
 * team grows) and "one seat changed". `AgentTuning.teamReuse`,
 * docs/ai/strength_benchmark.md 第 11.4 節.
 */

import { HeuristicAgent } from '../src/ai/HeuristicAgent';
import { SelfPlayEngine } from '../src/ai/SelfPlayEngine';
import { LEGACY_AGENT_TUNING, describeAgentTuning, parseTuningFlag, resolveAgentTuning, type AgentTuning } from '../src/ai/AgentTuning';
import { seededRandom, withSeededRandom } from '../src/ai/benchmark/agreement';
import { getForwardTelemetry } from '../src/ai/forward/ForwardAgent';
import { DEFAULT_TEAM_REUSE_OPTIONS, setTeamReuseOptions, teamReuseOptionsFromEnv } from '../src/ai/TeamReuse';
import type { AgentAction, AvalonAgent, PlayerObservation } from '../src/ai/types';

interface Args {
  flags: Partial<AgentTuning>;
  base: Partial<AgentTuning>;
  games: number;
  seed: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { flags: {}, base: {}, games: 5000, seed: 20261012 };
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
      default: throw new Error(`unknown argument ${a}`);
    }
  }
  if (!Number.isFinite(args.games) || args.games <= 0) throw new Error('--games must be a positive integer');
  return args;
}

type Context = 'R1 later' | 'R2+ later' | 'first after success' | 'first after fail';
interface Shape { n: number; whole: number; one: number }

class SeededAgent implements AvalonAgent {
  readonly agentType = 'heuristic' as const;
  private readonly inner: HeuristicAgent;
  gameSeed = '';

  constructor(readonly agentId: string, tuning: AgentTuning, private readonly shapes: Map<string, Shape>) {
    this.inner = new HeuristicAgent(agentId, undefined, undefined, tuning);
  }

  private seedFor(obs: PlayerObservation, extra = ''): string {
    return [
      this.gameSeed, obs.myPlayerId, obs.gamePhase, `R${obs.currentRound}`, `A${obs.failCount}`,
      `V${obs.voteHistory.length}`, `Q${obs.questHistory.length}`, `L${obs.lakeHistory?.length ?? 0}`,
      obs.proposedTeam.join(','), extra,
    ].join('|');
  }

  onGameStart(obs: PlayerObservation): void { this.inner.onGameStart(obs); }

  act(obs: PlayerObservation): AgentAction {
    const action = withSeededRandom(this.seedFor(obs), () => this.inner.act(obs));
    if (action.type === 'team_select' && obs.voteHistory.length > 0) this.countShape(obs, action.teamIds);
    return action;
  }

  private countShape(obs: PlayerObservation, team: readonly string[]): void {
    const round = obs.currentRound ?? 1;
    const sameRound = obs.voteHistory.filter((v) => v.round === round);
    const lastQuest = obs.questHistory[obs.questHistory.length - 1];
    let ctx: Context;
    let ref: readonly string[];
    if (round === 1) { ctx = 'R1 later'; ref = sameRound[sameRound.length - 1]?.team ?? []; }
    else if (sameRound.length > 0) { ctx = 'R2+ later'; ref = sameRound[sameRound.length - 1].team; }
    else if (lastQuest) { ctx = lastQuest.result === 'fail' ? 'first after fail' : 'first after success'; ref = lastQuest.team; }
    else return;
    const H = new Set(team);
    const P = new Set(ref);
    const grow = Math.max(0, H.size - P.size);
    const changed = Math.max(0, [...H].filter((x) => !P.has(x)).length - grow);
    for (const key of [ctx, `${ctx} ${obs.myTeam}`]) {
      const s = this.shapes.get(key) ?? { n: 0, whole: 0, one: 0 };
      s.n++;
      if (changed === 0) s.whole++;
      if (changed === 1) s.one++;
      this.shapes.set(key, s);
    }
  }

  pickLakeTarget(obs: PlayerObservation, validTargets?: readonly string[]): string {
    return withSeededRandom(this.seedFor(obs, 'lake'), () => this.inner.pickLakeTarget(obs, validTargets));
  }

  declareLake(obs: PlayerObservation, targetId: string, trueFaction: 'good' | 'evil' | undefined): 'good' | 'evil' | null {
    return withSeededRandom(this.seedFor(obs, `claim-${targetId}`), () => this.inner.declareLake(obs, targetId, trueFaction));
  }

  onGameEnd(obs: PlayerObservation, won: boolean): void { this.inner.onGameEnd(obs, won); }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const baseTuning = resolveAgentTuning(args.base, { ...LEGACY_AGENT_TUNING });
  const variantTuning = resolveAgentTuning(args.flags, { ...LEGACY_AGENT_TUNING });
  const teamReuseOptions = teamReuseOptionsFromEnv();
  setTeamReuseOptions(teamReuseOptions);
  const isDefault = JSON.stringify(teamReuseOptions) === JSON.stringify(DEFAULT_TEAM_REUSE_OPTIONS);
  process.stderr.write(`teamReuse weights${isDefault ? ' (defaults)' : ' (variant)'}: ${JSON.stringify(teamReuseOptions)}\n`);

  const engine = new SelfPlayEngine();
  const shapes = { baseline: new Map<string, Shape>(), variant: new Map<string, Shape>() };
  let baseRed = 0;
  let variantRed = 0;
  const diffs: number[] = [];
  const started = Date.now();
  const originalLog = console.log;
  const originalRandom = Math.random;
  console.log = (): void => undefined; // GameEngine prints every event on stdout
  try {
    for (let i = 0; i < args.games; i++) {
      const red: Record<'baseline' | 'variant', number> = { baseline: 0, variant: 0 };
      for (const label of ['baseline', 'variant'] as const) {
        const tuning = label === 'baseline' ? baseTuning : variantTuning;
        const agents = Array.from({ length: 10 }, (_, k) => new SeededAgent(`P${k + 1}`, tuning, shapes[label]));
        const gameSeed = `${args.seed}|${i}`;
        for (const a of agents) a.gameSeed = gameSeed;
        Math.random = seededRandom(`${gameSeed}|setup`);
        try {
          red[label] = (await engine.runGame(agents, false)).winner === 'evil' ? 1 : 0;
        } finally {
          Math.random = originalRandom;
        }
      }
      baseRed += red.baseline;
      variantRed += red.variant;
      diffs.push(red.variant - red.baseline);
      if ((i + 1) % 500 === 0 || i + 1 === args.games) {
        process.stderr.write(`${i + 1}/${args.games} seeds, ${((Date.now() - started) / 1000).toFixed(0)}s\n`);
      }
    }
  } finally {
    console.log = originalLog;
  }

  const n = diffs.length;
  const mean = diffs.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1 ? diffs.reduce((a, d) => a + (d - mean) ** 2, 0) / (n - 1) : 0;
  const half = 1.959964 * Math.sqrt(variance / n);
  const pct = (x: number): string => `${(x * 100).toFixed(2)}%`;
  const pp = (x: number): string => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(2)}pp`;
  console.log(`baseline (all ten seats): ${describeAgentTuning(baseTuning) || 'legacy'}`);
  console.log(`variant  (all ten seats): ${describeAgentTuning(variantTuning) || 'legacy'}`);
  console.log(`seed ${args.seed}; ${n} seeds × 2 games`);
  console.log(`red wins: baseline ${pct(baseRed / n)} (${baseRed}/${n}), variant ${pct(variantRed / n)} (${variantRed}/${n}); paired variant − baseline ${pp(mean)} [${pp(mean - half)}, ${pp(mean + half)}]`);
  console.log(`blue wins: baseline ${pct(1 - baseRed / n)}, variant ${pct(1 - variantRed / n)}`);
  for (const label of ['baseline', 'variant'] as const) {
    console.log(`team proposals vs the reference team (${label}):`);
    for (const [key, s] of [...shapes[label]].sort(([a], [b]) => a.localeCompare(b))) {
      console.log(`  ${key.padEnd(28)} n=${String(s.n).padEnd(7)} kept whole ${pct(s.whole / s.n)}  one seat changed ${pct(s.one / s.n)}`);
    }
  }
  const telemetry = getForwardTelemetry();
  console.log(`forward telemetry: ${telemetry.totalDecisions} decisions via ForwardAgent, ${telemetry.fallbacks} fallbacks`);
  if (telemetry.totalDecisions === 0) {
    console.warn('WARNING: ForwardAgent path not active (set USE_FORWARD_REASONING=true).');
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
