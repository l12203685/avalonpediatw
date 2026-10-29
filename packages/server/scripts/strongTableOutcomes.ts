/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 強桌的結果組成（Edward 2026-10-29：「勝率偏高的一群人玩，遊戲很難三紅作收；藍勝:紅勝約 36%:64%」）：真人 10 人局依
 * 「同桌玩家的超額勝率平均」分四組，看三紅／三藍死／三藍活、任務勝率（三藍）、刺中率。只輸出彙總數字。
 *
 *   npx tsx scripts/strongTableOutcomes.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { campOf, parseReplayGame, rowsFromSheet, type ReplayGame } from '../src/ai/benchmark/sheetsReplay';

const data = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../sheets_cache.json'), 'utf8')) as Record<string, string[][]>;
const cache = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../analysis_cache.json'), 'utf8'));
const aliases: Record<string, string> = cache.players?.aliases ?? {};
const strength = new Map<string, number>();
for (const p of cache.players.players as Array<{ name: string; totalGames: number; excessWinRate: number | null }>) {
  if (p.totalGames >= 30 && typeof p.excessWinRate === 'number') strength.set(p.name.toLowerCase(), p.excessWinRate);
}
const key = (n: string): string => (aliases[n] ?? aliases[n.toLowerCase()] ?? n).toLowerCase();

interface Row { mean: number; outcome: '三紅' | '三藍死' | '三藍活' }
const rows: Row[] = [];
for (const row of rowsFromSheet(data['牌譜'] ?? [])) {
  if (!(row['文字記錄'] ?? '').trim()) continue;
  const r = parseReplayGame(row);
  if (!r.ok || r.game.playerCount !== 10) continue;
  const g: ReplayGame = r.game;
  const vals = g.names.map((n) => strength.get(key(n))).filter((v): v is number => typeof v === 'number');
  if (vals.length < 8) continue;
  const fails = g.quests.filter((q) => q.failed).length;
  let outcome: Row['outcome'];
  if (fails >= 3) outcome = '三紅';
  else if (g.winner === 'evil') outcome = '三藍死';
  else outcome = '三藍活';
  rows.push({ mean: vals.reduce((a, b) => a + b, 0) / vals.length, outcome });
}
rows.sort((a, b) => a.mean - b.mean);
const report = (label: string, rs: Row[]): void => {
  const n = rs.length;
  const c = (o: Row['outcome']) => rs.filter((r) => r.outcome === o).length;
  const red3 = c('三紅'); const dead = c('三藍死'); const alive = c('三藍活');
  const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : '—');
  console.log(`${label.padEnd(18)} n=${String(n).padStart(4)} | 三紅 ${pct(red3, n)} 三藍死 ${pct(dead, n)} 三藍活 ${pct(alive, n)} | 任務勝率(三藍) ${pct(dead + alive, n)} 刺中率 ${pct(dead, dead + alive)} | 藍勝 ${pct(alive, n)}`);
};
console.log(`可用局數 ${rows.length}（同桌至少 8 人有 30 場以上的超額勝率）`);
report('全部', rows);
const q = Math.floor(rows.length / 4);
['最弱 1/4', '第 2 個 1/4', '第 3 個 1/4', '最強 1/4'].forEach((l, i) => report(l, rows.slice(i * q, i === 3 ? rows.length : (i + 1) * q)));
report('最強 1/10', rows.slice(Math.floor(rows.length * 0.9)));
