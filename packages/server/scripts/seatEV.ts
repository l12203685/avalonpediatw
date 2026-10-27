/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 單一座位的期望勝率（Edward 2026-10-27：「看怎麼樣的玩法可以提高期望勝率 sum（抽角機率 × 抽位置機率 × 勝率）」）。
 *
 *   USE_FORWARD_REASONING=true pnpm --filter @avalon/server exec tsx scripts/seatEV.ts \
 *     --flag teamPassRank [--flag ...] [--base NAME ...] [--games 50000] [--seed 271027] [--json out.json]
 *
 * 每一局：角色與座位照引擎隨機（10 人：梅林、派西各 1/10，忠臣 4/10，刺客、莫甘娜、莫德雷德、奧伯倫各 1/10；
 * 位置各 1/10），挑一個座位（第 i 局挑 P(i mod 10 + 1)）用變體，其他九個座位用基準；同一個發牌、同一組亂數
 * （每個決定的亂數由觀測決定）再打一局十個座位全用基準。那個座位兩局勝負的差，平均起來就是
 *
 *   Σ_角色 Σ_位置 P(角色) · P(位置) · [勝率(變體) − 勝率(基準)]
 *
 * —— 一個玩家換了玩法、其他人不變時，期望勝率的變化（最接近「機器人混在真人局裡」的情況）。
 * 也分角色、分位置回報。--flag / --base 同 selfPlayStrength.ts（基準預設 = 正式預設 DEFAULT_AGENT_TUNING）。
 *
 * 勝負 = 引擎的最終結果（三紅或三藍死 = 紅勝；三藍活 = 藍勝）。
 */
import * as fs from 'fs';
import { HeuristicAgent } from '../src/ai/HeuristicAgent';
import { SelfPlayEngine } from '../src/ai/SelfPlayEngine';
import { DEFAULT_AGENT_TUNING, describeAgentTuning, parseTuningFlag, type AgentTuning } from '../src/ai/AgentTuning';
import { seededRandom, withSeededRandom } from '../src/ai/benchmark/agreement';
import type { AgentAction, AvalonAgent, PlayerObservation } from '../src/ai/types';

interface Args { flags: Partial<AgentTuning>; base: Partial<AgentTuning>; games: number; seed: number; json?: string }

function parseArgs(argv: string[]): Args {
  const a: Args = { flags: {}, base: {}, games: 20000, seed: 271027 };
  for (let i = 0; i < argv.length; i++) {
    const next = () => argv[++i];
    switch (argv[i]) {
      case '--flag': Object.assign(a.flags, parseTuningFlag(next())); break;
      case '--base': Object.assign(a.base, parseTuningFlag(next())); break;
      case '--games': a.games = Number(next()); break;
      case '--seed': a.seed = Number(next()); break;
      case '--json': a.json = next(); break;
      default: throw new Error(`unknown argument ${argv[i]}`);
    }
  }
  return a;
}

/** 固定一種設定的 agent；每個決定的亂數由（局、座位、局面）決定，兩局同局面同亂數。 */
class SeededAgent implements AvalonAgent {
  readonly agentType = 'heuristic' as const;
  private readonly inner: HeuristicAgent;
  role = ''; seat = -1; team: 'good' | 'evil' = 'good';
  constructor(readonly agentId: string, tuning: AgentTuning, private readonly gameSeed: string) {
    this.inner = new HeuristicAgent(agentId, undefined, undefined, tuning);
  }
  private seedFor(obs: PlayerObservation, extra = ''): string {
    return [this.gameSeed, obs.myPlayerId, obs.gamePhase, `R${obs.currentRound}`, `A${obs.failCount}`,
      `V${obs.voteHistory.length}`, `Q${obs.questHistory.length}`, `L${obs.lakeHistory?.length ?? 0}`,
      obs.proposedTeam.join(','), extra].join('|');
  }
  onGameStart(obs: PlayerObservation): void {
    this.role = obs.myRole; this.team = obs.myTeam; this.seat = obs.allPlayerIds.indexOf(obs.myPlayerId) + 1;
    this.inner.onGameStart(obs);
  }
  act(obs: PlayerObservation): AgentAction { return withSeededRandom(this.seedFor(obs), () => this.inner.act(obs)); }
  pickLakeTarget(obs: PlayerObservation, valid?: readonly string[]): string {
    return withSeededRandom(this.seedFor(obs, 'lake'), () => this.inner.pickLakeTarget(obs, valid));
  }
  declareLake(obs: PlayerObservation, targetId: string, trueFaction: 'good' | 'evil' | undefined): 'good' | 'evil' | null {
    return withSeededRandom(this.seedFor(obs, `claim-${targetId}`), () => this.inner.declareLake(obs, targetId, trueFaction));
  }
  onGameEnd(obs: PlayerObservation, won: boolean): void { this.inner.onGameEnd(obs, won); }
}

interface Cell { n: number; winV: number; winC: number; sumD2: number }
const cell = (): Cell => ({ n: 0, winV: 0, winC: 0, sumD2: 0 });
function add(c: Cell, v: number, b: number): void { c.n++; c.winV += v; c.winC += b; c.sumD2 += (v - b) ** 2; }
function summary(c: Cell) {
  const d = (c.winV - c.winC) / Math.max(1, c.n);
  const varD = c.sumD2 / Math.max(1, c.n) - d * d;
  const se = Math.sqrt(Math.max(0, varD) / Math.max(1, c.n));
  return { n: c.n, ev: c.winV / Math.max(1, c.n), evBase: c.winC / Math.max(1, c.n), diff: d, lo: d - 1.96 * se, hi: d + 1.96 * se };
}
const pp = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(2)}pp`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const base: AgentTuning = { ...DEFAULT_AGENT_TUNING, ...args.base };
  const variant: AgentTuning = { ...base, ...args.flags };
  const engine = new SelfPlayEngine();
  const all = cell();
  const byRole: Record<string, Cell> = {};
  const bySeat: Record<string, Cell> = {};
  const started = Date.now();
  const originalRandom = Math.random;
  for (let i = 0; i < args.games; i++) {
    const gameSeed = `${args.seed}|${i}`;
    const focus = `P${(i % 10) + 1}`;
    const wins: number[] = [];
    let role = ''; let seat = -1;
    for (const useVariant of [true, false]) {
      const agents = Array.from({ length: 10 }, (_, k) =>
        new SeededAgent(`P${k + 1}`, useVariant && `P${k + 1}` === focus ? variant : base, gameSeed));
      Math.random = seededRandom(`${gameSeed}|setup`);
      try {
        const r = await engine.runGame(agents, false);
        const f = agents.find((x) => x.agentId === focus)!;
        role = f.role; seat = f.seat;
        wins.push(r.winner === f.team ? 1 : 0);
      } finally {
        Math.random = originalRandom;
      }
    }
    add(all, wins[0], wins[1]);
    add(byRole[role] ??= cell(), wins[0], wins[1]);
    add(bySeat[String(seat)] ??= cell(), wins[0], wins[1]);
    if ((i + 1) % 2000 === 0) {
      const s = summary(all);
      console.error(`${i + 1}/${args.games} ${((Date.now() - started) / 1000).toFixed(0)}s diff ${pp(s.diff)} [${pp(s.lo)}, ${pp(s.hi)}]`);
    }
  }
  const out = {
    seed: args.seed, games: args.games, variant: describeAgentTuning(variant), baseline: describeAgentTuning(base),
    flags: args.flags, elapsedSec: (Date.now() - started) / 1000,
    all, byRole, bySeat,
  };
  const s = summary(all);
  console.log(`期望勝率（單一座位，角色與位置隨機）：變體 ${(s.ev * 100).toFixed(2)}%，基準 ${(s.evBase * 100).toFixed(2)}%，差 ${pp(s.diff)} [${pp(s.lo)}, ${pp(s.hi)}]，${s.n} 局`);
  for (const [k, c] of Object.entries(byRole).sort()) { const r = summary(c); console.log(`  ${k.padEnd(9)} n=${r.n} 基準 ${(r.evBase * 100).toFixed(1)}% 差 ${pp(r.diff)} [${pp(r.lo)}, ${pp(r.hi)}]`); }
  for (const [k, c] of Object.entries(bySeat).sort((a, b) => Number(a[0]) - Number(b[0]))) { const r = summary(c); console.log(`  位置 ${k.padStart(2)} n=${r.n} 差 ${pp(r.diff)} [${pp(r.lo)}, ${pp(r.hi)}]`); }
  if (args.json) fs.writeFileSync(args.json, JSON.stringify(out, null, 1));
}

main().catch((e) => { console.error(e); process.exit(1); });
