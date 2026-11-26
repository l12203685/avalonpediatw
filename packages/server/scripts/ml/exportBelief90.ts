/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 第 90 回合（路線圖 Phase C）第 1 號模型的資料：真人局（`games_cache.json` 十人局，`datasetReplay` 嚴格重播）每一個忠臣／派西座位
 * 在每一次非強制提議的投票點（同 `beliefCalibrationCurve.ts` 的決策點），對另外 9 人各一列：
 *   [局序號, 時間切分（0 = 照日期前 2/3 擬合、1 = 後 1/3 驗證）, 視角座位, 決策點序號, 視角（0 忠臣、1 派西）, 回合, 目標座位,
 *    y（真的是紅）, 現行信念 p, 規則均分 p, 高端桌, ...特徵（`BELIEF_FEATURES_90`）]
 * 只寫 0 < p < 1 的點（確定點模型不動）。輸出 Float32 二進位（--out X.bin）＋同名 .json（欄名、局數）。沒有玩家名。
 *
 * --cand NAME=flag,flag（可重複）：另外記候選讀法（`bayesRedShare` 走執行期的路徑，例如 mlBelief90=1）的 p，接在列尾（給 evalBelief90.py 算樣本外分數）。
 * --split time-test 只跑驗證那一半。--shard k/n 分片。
 *
 *   cd packages/server && npx tsx scripts/ml/exportBelief90.ts --out ../../r90tmp/b90.bin [--shard 0/2] [--split time-test] [--cand M=mlBelief90=1]
 */
import { DEFAULT_COHORT_CUTS } from '@avalon/shared/stats';
import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_AGENT_TUNING, parseTuningFlag, type AgentTuning } from '../../src/ai/AgentTuning';
import { bayesOptionsOf, bayesRedShare, type BayesOptions } from '../../src/ai/belief/BayesBelief';
import { buildCertainty } from '../../src/ai/belief/Certainty';
import { buildReplayObservation, seatId } from '../../src/ai/benchmark/replayObservation';
import { campOf } from '../../src/ai/benchmark/sheetsReplay';
import { replayGamesFromDataset, type DatasetHeader, type DatasetTuple } from '../../src/ai/benchmark/datasetReplay';
import { hideLobbyOrder } from '../../src/bots/simulation/aiRead';
import { BELIEF_FEATURES_90, beliefFeatures90 } from '../../src/ai/ml/beliefFeatures90';

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const CERTAIN = 1e-9;

/** 照日期排序（沒有日期的排最前），後 1/3 = 驗證（同第 89 回合 `--split time-test`）。 */
export function timeSplit(dates: readonly string[]): boolean[] {
  const byDate = dates.map((d, gi) => ({ gi, d: d || '0000' })).sort((a, b) => a.d.localeCompare(b.d) || a.gi - b.gi);
  const late = new Set(byDate.slice(Math.floor((2 * byDate.length) / 3)).map((x) => x.gi));
  return dates.map((_, gi) => late.has(gi));
}

function main(): void {
  const out = arg('--out');
  if (!out) throw new Error('--out X.bin');
  const root = path.resolve(__dirname, '..', '..');
  const dataset = JSON.parse(fs.readFileSync(arg('--dataset') ?? path.join(root, 'games_cache.json'), 'utf8')) as DatasetHeader & { games: readonly DatasetTuple[] };
  const games = replayGamesFromDataset(dataset).games.filter((g) => g.game.playerCount === 10);
  const late = timeSplit(games.map((g) => g.date));
  const [k, nShard] = (arg('--shard') ?? '0/1').split('/').map(Number);
  const split = arg('--split') ?? 'all';
  const limit = Number(arg('--limit') ?? Infinity);
  const strongS = DEFAULT_COHORT_CUTS.sHi;
  const base: BayesOptions = bayesOptionsOf({ ...DEFAULT_AGENT_TUNING });
  const cands: { name: string; opts: BayesOptions }[] = [];
  argv.forEach((a, i) => {
    if (a !== '--cand') return;
    const s = argv[i + 1];
    const eq = s.indexOf('=');
    const t: AgentTuning = { ...DEFAULT_AGENT_TUNING };
    for (const f of s.slice(eq + 1).split(',').filter(Boolean)) Object.assign(t, parseTuningFlag(f));
    cands.push({ name: s.slice(0, eq), opts: bayesOptionsOf(t) });
  });
  const head = ['gi', 'late', 'viewer', 'point', 'percival', 'round', 'target', 'y', 'pBase', 'pUni', 'strong', ...BELIEF_FEATURES_90, ...cands.map((c) => `p_${c.name}`)];
  const fd = fs.openSync(out, 'w');
  let rows = 0;
  let nGames = 0;
  const started = Date.now();
  const buf: number[] = [];
  const flush = (): void => {
    if (!buf.length) return;
    fs.writeSync(fd, Buffer.from(new Float32Array(buf).buffer));
    buf.length = 0;
  };
  games.forEach((g, gi) => {
    if (gi % nShard !== k) return;
    if (gi >= limit) return;
    if (split === 'time-test' && !late[gi]) return;
    if (split === 'time-train' && late[gi]) return;
    const game = g.game;
    const strong = g.s !== null && g.s >= strongS ? 1 : 0;
    nGames++;
    for (let seat = 1; seat <= 10; seat++) {
      const role = game.seatRoles[seat - 1];
      if (role !== 'loyal' && role !== 'percival') continue;
      const me = seatId(seat);
      game.proposals.forEach((p, pi) => {
        if (p.forced) return;
        const obs = hideLobbyOrder(buildReplayObservation(game, seat, { kind: 'team_vote', proposal: pi }));
        const sh = bayesRedShare(obs, base);
        const view = buildCertainty(obs);
        const nw = view.worlds('L1*').length;
        const uni = new Map(obs.allPlayerIds.map((id) => [id, nw ? view.uniformRedShare(id) : 0.5] as const));
        const fx = beliefFeatures90(obs, sh, uni);
        const cp = cands.map((c) => bayesRedShare(obs, c.opts));
        fx.ids.forEach((id, r) => {
          if (id === me) return;
          const pb = sh.get(id) ?? 0.5;
          if (pb <= CERTAIN || pb >= 1 - CERTAIN) return;
          const tSeat = obs.allPlayerIds.indexOf(id) + 1;
          const y = campOf(game.seatRoles[tSeat - 1]) === 'evil' ? 1 : 0;
          buf.push(gi, late[gi] ? 1 : 0, seat, pi, role === 'percival' ? 1 : 0, p.round, tSeat, y, pb, uni.get(id) ?? 0.5, strong, ...fx.rows[r], ...cp.map((m) => m.get(id) ?? 0.5));
          rows++;
        });
      });
    }
    if (buf.length > 200000) flush();
    if (nGames % 100 === 0) process.stderr.write(`[exportBelief90 ${k}/${nShard}] ${nGames} games, ${rows} rows, ${((Date.now() - started) / 1000).toFixed(0)}s\n`);
  });
  flush();
  fs.closeSync(fd);
  fs.writeFileSync(out.replace(/\.bin$/, '') + '.json', JSON.stringify({ cols: head, rows, games: nGames, split, shard: `${k}/${nShard}`, seconds: Math.round((Date.now() - started) / 1000) }));
  console.log(`wrote ${rows} rows from ${nGames} games → ${out}`);
}

if (require.main === module) main();
