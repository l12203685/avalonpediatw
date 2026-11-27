/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 第 90 回合：執行期速度。真人局前 N 局（預設 40）每一個忠臣座位、每一次非強制投票點的觀察，各算一次後驗（每次都是新的觀察物件，沒有快取），
 * 現行 vs 第 1 號（疊加版）；刺殺點：現行刺客 vs 第 2 號。只印平均毫秒。
 *
 *   cd packages/server && npx tsx scripts/ml/speed90.ts [--games 40]
 */
import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_AGENT_TUNING } from '../../src/ai/AgentTuning';
import { bayesOptionsOf, bayesRedShare } from '../../src/ai/belief/BayesBelief';
import { buildReplayObservation, seatId } from '../../src/ai/benchmark/replayObservation';
import { replayGamesFromDataset, type DatasetHeader, type DatasetTuple } from '../../src/ai/benchmark/datasetReplay';
import { HeuristicAgent } from '../../src/ai/HeuristicAgent';
import { resolveAgentTuning } from '../../src/ai/AgentTuning';

const argv = process.argv.slice(2);
const n = Number(argv[argv.indexOf('--games') + 1] || 40);
const root = path.resolve(__dirname, '..', '..');
const ds = JSON.parse(fs.readFileSync(path.join(root, 'games_cache.json'), 'utf8')) as DatasetHeader & { games: readonly DatasetTuple[] };
const games = replayGamesFromDataset(ds).games.filter((g) => g.game.playerCount === 10).slice(0, n).map((g) => g.game);
const base = bayesOptionsOf({ ...DEFAULT_AGENT_TUNING });
const ml = bayesOptionsOf({ ...DEFAULT_AGENT_TUNING, mlBelief90: 1, mlBelief90Scope: 1 });
const time = (opts: typeof base): [number, number] => {
  let k = 0;
  const t0 = process.hrtime.bigint();
  for (const g of games) for (let s = 1; s <= 10; s++) {
    if (g.seatRoles[s - 1] !== 'loyal') continue;
    g.proposals.forEach((p, pi) => { if (!p.forced) { bayesRedShare(buildReplayObservation(g, s, { kind: 'team_vote', proposal: pi }), opts); k++; } });
  }
  return [Number(process.hrtime.bigint() - t0) / 1e6 / k, k];
};
time(base); time(ml); // warm up
const [a, k] = time(base);
const [b] = time(ml);
console.log(`信念：${k} 個後驗，現行 ${a.toFixed(2)} ms／個、第 1 號 ${b.toFixed(2)} ms／個（多 ${(b - a).toFixed(2)} ms）`);
const tA = resolveAgentTuning({ ...DEFAULT_AGENT_TUNING });
const tB = resolveAgentTuning({ ...DEFAULT_AGENT_TUNING, mlAssassin90: 2 });
const spots = games.filter((g) => g.assassinTargetSeat !== undefined && g.seatRoles.includes('assassin'));
const kill = (t: typeof tA): number => {
  const t0 = process.hrtime.bigint();
  for (const g of spots) { const a2 = g.seatRoles.indexOf('assassin') + 1; new HeuristicAgent(seatId(a2), undefined, undefined, t).act(buildReplayObservation(g, a2, { kind: 'assassination' })); }
  return Number(process.hrtime.bigint() - t0) / 1e6 / Math.max(1, spots.length);
};
kill(tA); kill(tB);
console.log(`刺殺：${spots.length} 個刺殺點，現行 ${kill(tA).toFixed(2)} ms、第 2 號 ${kill(tB).toFixed(2)} ms`);
