/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 自我對打的局紀錄（強者量尺用；docs/ai/strong_metrics.md）。跑法同 `logicAudit.ts`：10 人局、每個座位都是
 * 現行預設（DEFAULT_AGENT_TUNING，可再套 --flag）的 HeuristicAgent、正式路徑（ForwardAgent）；第 i 局的座位、角色與每個決策的
 * 亂數都由 (seed, i) 決定。每局存成 `ReplayGame`（沒有名字），給 strongLoopMetrics／strongTailLeader／strongGap 讀。
 *
 *   cd packages/server && nice npx tsx scripts/strongSelfPlay.ts --games 400 --out /tmp/sp.json [--seed 20261104] [--flag 開關=值]
 */
import * as fs from 'fs';
import type { Role } from '@avalon/shared';
import type { AgentAction, PlayerObservation } from '../src/ai/types';
import type { ReplayGame } from '../src/ai/benchmark/sheetsReplay';
import { replayGameFromSelfPlay } from '../src/ai/infl/strongData';

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

async function main(): Promise<void> {
  const { HeuristicAgent } = await import('../src/ai/HeuristicAgent');
  const { SelfPlayEngine } = await import('../src/ai/SelfPlayEngine');
  const { DEFAULT_AGENT_TUNING, parseTuningFlag, describeAgentTuning } = await import('../src/ai/AgentTuning');
  const { seededRandom, withSeededRandom } = await import('../src/ai/benchmark/agreement');
  const n = Number(arg('--games') ?? 400);
  const seed = arg('--seed') ?? '20261104';
  const out = arg('--out');
  if (!out) throw new Error('--out PATH');
  const tuning = { ...DEFAULT_AGENT_TUNING };
  argv.forEach((a, i) => { if (a === '--flag') Object.assign(tuning, parseTuningFlag(argv[i + 1])); });

  class Seat {
    readonly agentType = 'heuristic' as const;
    private readonly inner: InstanceType<typeof HeuristicAgent>;
    gameSeed = '';
    role: Role = 'loyal';
    final: PlayerObservation | null = null;
    killed: string | undefined;
    constructor(readonly agentId: string) { this.inner = new HeuristicAgent(agentId, undefined, undefined, { ...tuning }); }
    private seedFor(obs: PlayerObservation, extra = ''): string {
      return [this.gameSeed, obs.myPlayerId, obs.gamePhase, `R${obs.currentRound}`, `A${obs.failCount}`,
        `V${obs.voteHistory.length}`, `Q${obs.questHistory.length}`, `L${obs.lakeHistory?.length ?? 0}`, obs.proposedTeam.join(','), extra].join('|');
    }
    onGameStart(obs: PlayerObservation): void { this.role = obs.myRole; this.final = null; this.killed = undefined; this.inner.onGameStart(obs); }
    act(obs: PlayerObservation): AgentAction {
      const a = withSeededRandom(this.seedFor(obs), () => this.inner.act(obs));
      if (a.type === 'assassinate') this.killed = a.targetId;
      return a;
    }
    pickLakeTarget(obs: PlayerObservation, valid?: readonly string[]): string {
      return withSeededRandom(this.seedFor(obs, 'lake'), () => this.inner.pickLakeTarget(obs, valid));
    }
    declareLake(obs: PlayerObservation, target: string, truth: 'good' | 'evil' | undefined): 'good' | 'evil' | null {
      return withSeededRandom(this.seedFor(obs, `claim-${target}`), () => this.inner.declareLake(obs, target, truth));
    }
    onGameEnd(obs: PlayerObservation, won: boolean): void { this.final = obs; this.inner.onGameEnd(obs, won); }
  }

  const engine = new SelfPlayEngine();
  const games: ReplayGame[] = [];
  let rotationMismatch = 0;
  const started = Date.now();
  const originalLog = console.log;
  const originalRandom = Math.random;
  console.log = (): void => undefined; // GameEngine 每個事件都印 JSON
  try {
    for (let i = 0; i < n; i++) {
      const agents = Array.from({ length: 10 }, (_, s) => new Seat(`P${s + 1}`));
      const gameSeed = `${seed}|${i}`;
      for (const a of agents) a.gameSeed = gameSeed;
      Math.random = seededRandom(`${gameSeed}|setup`);
      try {
        await engine.runGame(agents, false);
      } finally {
        Math.random = originalRandom;
      }
      const final = agents[0].final;
      if (!final) throw new Error('game did not end');
      const byId = new Map(agents.map((a) => [a.agentId, a]));
      const killer = agents.find((a) => a.killed !== undefined);
      const g = replayGameFromSelfPlay(`SP${i}`, final, (id) => byId.get(id)!.role, killer?.killed);
      if (g) games.push(g); else rotationMismatch++;
      if ((i + 1) % 25 === 0) process.stderr.write(`[strongSelfPlay] ${i + 1}/${n} games, ${((Date.now() - started) / 1000).toFixed(0)}s\n`);
    }
  } finally {
    console.log = originalLog;
  }
  const meta = { games: games.length, rotationMismatch, seed, tuning: describeAgentTuning(tuning), seconds: Math.round((Date.now() - started) / 1000) };
  fs.writeFileSync(out, JSON.stringify({ meta, games }));
  console.log(`wrote ${out}: ${JSON.stringify(meta).slice(0, 300)}`);
  // The self-play engine leaves timers behind (as in fitBeliefLikelihoods.ts): exit once the file is written, so a chained
  // strongLoopMetrics run starts.
  process.exit(0);
}

void main();
