/** 全區塊重算計時，以及獨立複合條件驗算；輸出只有計數與時間，不輸出玩家。 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { performance } from 'node:perf_hooks';
import { computeStats, decodeGamesDataset, diffSections, type GameFilter, type StatsContext } from '@avalon/shared/stats';

const dir = process.argv[2];
if (!dir) throw new Error('請指定暫存資料集目錄');
const raw = fs.readFileSync(path.join(dir, 'games.json'));
const context = JSON.parse(fs.readFileSync(path.join(dir, 'context.json'), 'utf8')) as StatsContext;
const started = performance.now();
const decoded = decodeGamesDataset(JSON.parse(raw.toString('utf8')));
const decodeMs = performance.now() - started;
const times: number[] = [];
for (let i = 0; i < 11; i += 1) {
  const start = performance.now();
  computeStats(decoded, context, null);
  if (i) times.push(performance.now() - start);
}
times.sort((a, b) => a - b);
const result: Record<string, unknown> = {
  games: decoded.games.length, rawBytes: raw.length, gzipBytes: zlib.gzipSync(raw, { level: 9 }).length,
  decodeMs: Math.round(decodeMs * 100) / 100, repetitions: times.length,
  medianMs: Math.round((times[4] + times[5]) * 50) / 100, maxMs: Math.round(times[9] * 100) / 100,
};
if (process.argv[3]) {
  const answers = JSON.parse(fs.readFileSync(process.argv[3], 'utf8')) as Array<{
    id: string; filter: GameFilter; expected: Record<string, number>;
  }>;
  result.audits = answers.map((answer) => {
    const stats = computeStats(decoded, context, answer.filter);
    const outcomes = stats.overview.outcomeBreakdown;
    const actual = {
      games: stats.meta.games, threeRed: outcomes.threeRed, threeBlueDead: outcomes.threeBlueDead,
      threeBlueAlive: outcomes.threeBlueAlive, finalRedWins: stats.overview.final.redWins,
      listedPlayers: stats.players.players.length,
    };
    const differences = diffSections(answer.expected, actual).differences;
    if (differences) process.exitCode = 1;
    return { ...actual, differences };
  });
}
// eslint-disable-next-line no-console
console.log(JSON.stringify(result));
