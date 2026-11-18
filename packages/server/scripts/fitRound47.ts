/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 第 47 回合：`BlueRound47` 的公開特徵在預設後驗之外還有沒有資訊（殘差）。真人局（`games_cache.json`，嚴格重播）每個忠臣座位、
 * 第 2–4 局第 1 次提議的投票點，對另外 9 人記 [預設後驗 p、特徵、是不是紅]，寫成 CSV；擬合（logistic：logit P(紅) = b0 + a·logit(p) + Σ w·特徵）
 * 在 `docs/ai/optimization_loop.md` 第 47 回合的指令裡用 numpy 做。只輸出彙總用的數字列，沒有玩家名。
 *
 *   cd packages/server && npx tsx scripts/fitRound47.ts --out rows.csv [--strong-s 55] [--limit N]
 */
import * as fs from 'fs';
import { DEFAULT_AGENT_TUNING } from '../src/ai/AgentTuning';
import { bayesOptionsOf, bayesRedShare } from '../src/ai/belief/BayesBelief';
import { buildReplayObservation, seatId } from '../src/ai/benchmark/replayObservation';
import { campOf } from '../src/ai/benchmark/sheetsReplay';
import { hideLobbyOrder } from '../src/bots/simulation/aiRead';
import { publicFeatures47 } from '../src/ai/BlueRound47';
import { loadHuman } from './beliefCalibrationCurve';

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

function main(): void {
  const out = arg('--out');
  if (!out) throw new Error('--out PATH');
  const strongS = Number(arg('--strong-s') ?? 55);
  const limit = Number(arg('--limit') ?? 0);
  const opts = bayesOptionsOf({ ...DEFAULT_AGENT_TUNING });
  const games = loadHuman();
  const lines = ['strong,round,p,missed,b0,b2,ignore,r1succ,red'];
  let n = 0;
  for (const [gi, { game, s }] of games.entries()) {
    if (limit && gi >= limit) break;
    const strong = s !== null && s >= strongS ? 1 : 0;
    for (let seat = 1; seat <= game.playerCount; seat++) {
      if (game.seatRoles[seat - 1] !== 'loyal') continue;
      for (const round of [2, 3, 4]) {
        const i = game.proposals.findIndex((p) => p.round === round && p.attempt === 1 && !p.forced);
        if (i < 0) continue;
        const obs = hideLobbyOrder(buildReplayObservation(game, seat, { kind: 'team_vote', proposal: i }));
        const sh = bayesRedShare(obs, opts);
        const f = publicFeatures47(obs);
        for (let t = 1; t <= game.playerCount; t++) {
          if (t === seat) continue;
          const id = seatId(t);
          const p = sh.get(id);
          if (p === undefined || p <= 1e-9 || p >= 1 - 1e-9) continue;
          const x = f.get(id)!;
          const red = campOf(game.seatRoles[t - 1]) === 'evil' ? 1 : 0;
          lines.push([strong, round, p.toFixed(6), x.missed, x.shareBucket === 0 ? 1 : 0, x.shareBucket === 2 ? 1 : 0, x.ignore, x.r1succ ? 1 : 0, red].join(','));
          n++;
        }
      }
    }
  }
  fs.writeFileSync(out, lines.join('\n') + '\n');
  console.log(`wrote ${n} rows from ${games.length} games`);
}
main();
