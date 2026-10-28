/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 貝氏信念的概似表（優化迴圈第 1 回合・第三階段信念引擎，2026-10-28）：從真人牌譜（1970 局可重播 10 人局）統計
 * 「在某種身分分配下，一個人做出這個動作」的機率，只存彙總次數（不含名字、不含單局紀錄）。
 *
 *   npx tsx scripts/fitBeliefLikelihoods.ts [--out src/ai/belief/likelihoods.json]
 *
 * 表（key → [次數, 總數] 或分布）：
 *   - vote：`陣營|在隊上|隊上有紅|回合段` → 贊成次數 / 總票數（非強制、票型可信的提議；回合段 r12 / r3）。
 *   - proposal：`隊長陣營|回合段|隊上紅數（不含隊長）` → 次數（隊長在自己隊上的提議）。
 *   - mission：`回合|隊上紅數` → 失敗牌張數的分布。
 *   - redLake：`目標陣營` → 紅方持湖者宣告「紅」的次數 / 總數。
 */
import * as fs from 'fs';
import * as path from 'path';
import { campOf, parseReplayGame, rowsFromSheet, type ReplayGame } from '../src/ai/benchmark/sheetsReplay';

const out = (() => {
  const i = process.argv.indexOf('--out');
  return i >= 0 ? process.argv[i + 1] : path.resolve(__dirname, '../src/ai/belief/likelihoods.json');
})();

const data = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../sheets_cache.json'), 'utf8')) as Record<string, string[][]>;
const games: ReplayGame[] = [];
for (const row of rowsFromSheet(data['牌譜'] ?? [])) {
  if (!(row['文字記錄'] ?? '').trim()) continue;
  const r = parseReplayGame(row);
  if (r.ok && r.game.playerCount === 10) games.push(r.game);
}

const vote: Record<string, [number, number]> = {};
const proposal: Record<string, number> = {};
const mission: Record<string, number[]> = {};
const redLake: Record<string, [number, number]> = {};
const bump = (t: Record<string, [number, number]>, k: string, hit: boolean) => { const v = (t[k] ??= [0, 0]); if (hit) v[0]++; v[1]++; };
const bucket = (round: number) => (round <= 2 ? 'r12' : 'r3');

for (const g of games) {
  const red = (seat: number) => campOf(g.seatRoles[seat - 1]) === 'evil';
  for (const p of g.proposals) {
    const reds = p.teamSeats.filter(red).length;
    if (p.teamSeats.includes(p.leaderSeat)) {
      const k = p.teamSeats.filter((s) => s !== p.leaderSeat && red(s)).length;
      const key = `${red(p.leaderSeat) ? 'evil' : 'good'}|${bucket(p.round)}|${k}`;
      proposal[key] = (proposal[key] ?? 0) + 1;
    }
    if (p.forced || !p.votesReliable) continue;
    for (let seat = 1; seat <= 10; seat++) {
      const key = `${red(seat) ? 'evil' : 'good'}|${p.teamSeats.includes(seat) ? 'on' : 'off'}|${reds > 0 ? 'red' : 'clean'}|${bucket(p.round)}`;
      bump(vote, key, p.votes[seat - 1]);
    }
  }
  for (const q of g.quests) {
    const key = `${q.round}|${q.teamSeats.filter(red).length}`;
    const dist = (mission[key] ??= [0, 0, 0, 0, 0, 0]);
    dist[Math.min(5, q.failCount)]++;
  }
  for (const l of g.lakes) {
    if (!red(l.holderSeat) || l.claim === null) continue;
    bump(redLake, red(l.targetSeat) ? 'evil' : 'good', l.claim === 'evil');
  }
}

const table = { source: 'sheets_cache.json 牌譜', games: games.length, fittedAt: new Date().toISOString().slice(0, 10), vote, proposal, mission, redLake };
fs.writeFileSync(out, JSON.stringify(table, null, 1) + '\n');
console.log(`wrote ${out}: ${games.length} games`);
for (const [k, [a, n]] of Object.entries(vote).sort()) console.log(`  vote ${k.padEnd(22)} ${(100 * a / n).toFixed(1)}% (${n})`);
for (const [k, d] of Object.entries(mission).sort()) console.log(`  mission ${k} fails ${d.join('/')}`);
for (const [k, [a, n]] of Object.entries(redLake)) console.log(`  redLake target ${k}: declared red ${(100 * a / n).toFixed(1)}% (${n})`);
