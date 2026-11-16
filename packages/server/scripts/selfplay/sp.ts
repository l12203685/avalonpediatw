/* Self-play chunk runner for parallel runs (GitHub Actions selfplay.yml, or locally).
 * One arrangement per run: blue seats = DEFAULT_AGENT_TUNING + --flag k=v ..., red seats = DEFAULT.
 * Same seeding as the optimization loop's scratchpad runner (gameSeed = `${seed}|${i}`; every decision under
 * withSeededRandom), so a chunk here is game-by-game identical to the same chunk run locally.
 *
 *   cd packages/server && USE_FORWARD_REASONING=true npx tsx scripts/selfplay/sp.ts \
 *     --seed 423001 --from 0 --games 1000 --out X.json [--flag k=v ...]
 *
 * Output (compact, no game logs): {meta, cols, rows} with one row per game:
 *   [i, blueWon 0/1, threeBlue 0/1, merlinKilled 0/1/-1(n/a), firstMissionFailed 0/1, missionsFailed, h]
 * where h = first 12 hex of sha1 over the game's proposals/quests/lakes/assassination (identity checks).
 * Logs print only progress counts (Actions logs are public).
 */
import * as fs from 'fs';
import { createHash } from 'crypto';
import type { Role } from '@avalon/shared';
import type { AgentAction, PlayerObservation } from '../../src/ai/types';
import { replayGameFromSelfPlay } from '../../src/ai/infl/strongData';

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

async function main(): Promise<void> {
  const { HeuristicAgent } = await import('../../src/ai/HeuristicAgent');
  const { SelfPlayEngine } = await import('../../src/ai/SelfPlayEngine');
  const { DEFAULT_AGENT_TUNING, parseTuningFlag, describeAgentTuning } = await import('../../src/ai/AgentTuning');
  const { seededRandom, withSeededRandom } = await import('../../src/ai/benchmark/agreement');
  const n = Number(arg('--games') ?? 1000);
  const from = Number(arg('--from') ?? 0);
  const seed = arg('--seed') ?? '423001';
  const out = arg('--out');
  if (!out) throw new Error('--out PATH');
  const variant = { ...DEFAULT_AGENT_TUNING };
  argv.forEach((a, i) => { if (a === '--flag') Object.assign(variant, parseTuningFlag(argv[i + 1])); });
  const redTuning = { ...DEFAULT_AGENT_TUNING };

  class Seat {
    readonly agentType = 'heuristic' as const;
    private readonly blue: InstanceType<typeof HeuristicAgent>;
    private readonly red: InstanceType<typeof HeuristicAgent>;
    private inner: InstanceType<typeof HeuristicAgent>;
    gameSeed = '';
    role: Role = 'loyal';
    final: PlayerObservation | null = null;
    killed: string | undefined;
    constructor(readonly agentId: string) {
      this.blue = new HeuristicAgent(agentId, undefined, undefined, { ...variant });
      this.red = new HeuristicAgent(agentId, undefined, undefined, { ...redTuning });
      this.inner = this.red;
    }
    private seedFor(obs: PlayerObservation, extra = ''): string {
      return [this.gameSeed, obs.myPlayerId, obs.gamePhase, `R${obs.currentRound}`, `A${obs.failCount}`,
        `V${obs.voteHistory.length}`, `Q${obs.questHistory.length}`, `L${obs.lakeHistory?.length ?? 0}`, obs.proposedTeam.join(','), extra].join('|');
    }
    onGameStart(obs: PlayerObservation): void {
      this.role = obs.myRole; this.final = null; this.killed = undefined;
      this.inner = obs.myTeam === 'good' ? this.blue : this.red; this.inner.onGameStart(obs);
    }
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
  const rows: (number | string)[][] = [];
  const started = Date.now();
  const originalLog = console.log;
  const originalRandom = Math.random;
  const tag = out.split('/').pop();
  console.log = (): void => undefined;
  try {
    for (let i = from; i < from + n; i++) {
      const agents = Array.from({ length: 10 }, (_, s) => new Seat(`P${s + 1}`));
      const gameSeed = `${seed}|${i}`;
      for (const a of agents) a.gameSeed = gameSeed;
      Math.random = seededRandom(`${gameSeed}|setup`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let res: any;
      try { res = await engine.runGame(agents, false); } finally { Math.random = originalRandom; }
      const final = agents[0].final;
      if (!final) throw new Error('game did not end');
      const byId = new Map(agents.map((a) => [a.agentId, a]));
      const killer = agents.find((a) => a.killed !== undefined);
      const g = replayGameFromSelfPlay(`SP${i}`, final, (id) => byId.get(id)!.role, killer?.killed);
      const tb = res.threeBlue ? 1 : 0;
      const mk = res.merlinKilled === undefined || res.merlinKilled === null ? -1 : res.merlinKilled ? 1 : 0;
      const quests = g?.quests ?? [];
      const h = g
        ? createHash('sha1').update(JSON.stringify([g.seatRoles, g.proposals.map((p) => [p.leaderSeat, p.teamSeats, p.votes]),
          quests.map((q) => [q.teamSeats, q.failCount]), g.lakes, g.assassinTargetSeat])).digest('hex').slice(0, 12)
        : 'bad';
      rows.push([i, res.winner === 'good' ? 1 : 0, tb, mk, quests.length && quests[0].failed ? 1 : 0, quests.filter((q) => q.failed).length, h]);
      if ((i + 1 - from) % 250 === 0) process.stderr.write(`[sp ${tag}] ${i + 1 - from}/${n} ${((Date.now() - started) / 1000).toFixed(0)}s\n`);
    }
  } finally { console.log = originalLog; }
  const meta = { games: rows.length, seed, from, blue: describeAgentTuning(variant), seconds: Math.round((Date.now() - started) / 1000) };
  fs.writeFileSync(out + '.tmp', JSON.stringify({ meta, cols: ['i', 'blueWon', 'threeBlue', 'merlinKilled', 'r1Failed', 'failedMissions', 'h'], rows }));
  fs.renameSync(out + '.tmp', out);
  process.stderr.write(`[sp ${tag}] done ${rows.length} games ${meta.seconds}s\n`);
  process.exit(0);
}
void main();
