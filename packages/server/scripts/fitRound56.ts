/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 第 56 回合：任務牌分「隊上有沒有奧伯倫」（`missionRole56`，`MISSION_OBERON_56`）的擬合。
 * 真人局（games_cache.json，網站數據分析的那一批，10 人局）每一個任務：回合 × 隊上紅數 × 隊上有沒有奧伯倫 → 失敗張數的次數。
 * 輸出 JSON（只有次數，沒有玩家名）；`--strong-s 65` 另外算高強度局。
 *
 *   cd packages/server && npx tsx scripts/fitRound56.ts [--dataset games_cache.json]
 */
import * as fs from 'fs';
import * as path from 'path';
import { replayGamesFromDataset } from '../src/ai/benchmark/datasetReplay';
import { EVIL_ROLES } from '../src/ai/benchmark/sheetsReplay';

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const root = path.resolve(__dirname, '..');
const raw = JSON.parse(fs.readFileSync(arg('--dataset') ?? path.join(root, 'games_cache.json'), 'utf8'));
const { games } = replayGamesFromDataset(raw);
const strongS = Number(arg('--strong-s') ?? 65);
const all: Record<string, number[]> = {};
const strong: Record<string, number[]> = {};
let n = 0;
for (const d of games) {
  const g = d.game;
  if (g.playerCount !== 10) continue;
  n++;
  const red = (s: number): boolean => EVIL_ROLES.has(g.seatRoles[s - 1]);
  for (const q of g.quests) {
    const reds = q.teamSeats.filter(red).length;
    if (reds === 0) continue;
    const ob = q.teamSeats.some((s) => g.seatRoles[s - 1] === 'oberon') ? 1 : 0;
    const key = `${q.round}|${reds}|${ob}`;
    for (const t of [all, ...(d.s !== null && d.s >= strongS ? [strong] : [])]) {
      if (!t[key]) t[key] = [0, 0, 0, 0, 0, 0];
      t[key][Math.min(q.failCount, 5)]++;
    }
  }
}
console.log(JSON.stringify({ games: n, all, strong }, null, 0));
