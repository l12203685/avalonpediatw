/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 「被越多人選的人越可能是好人」（Edward 2026-10-29）在真人牌譜上成不成立：10 人局，每個玩家被「別人當隊長的提議」選進
 * 隊伍的次數（不含自己當隊長），依陣營、依角色、依被選次數分組看藍方比例。只輸出彙總數字。
 *
 *   npx tsx scripts/selectionByCamp.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { campOf, parseReplayGame, rowsFromSheet } from '../src/ai/benchmark/sheetsReplay';

const data = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../sheets_cache.json'), 'utf8')) as Record<string, string[][]>;
type Bucket = { n: number; good: number };
const byCount = new Map<string, Bucket>();
const byRole = new Map<string, { n: number; picks: number }>();
const byLeaderCamp = { good: { blue: 0, red: 0 }, evil: { blue: 0, red: 0 } };
let games = 0;
for (const row of rowsFromSheet(data['牌譜'] ?? [])) {
  if (!(row['文字記錄'] ?? '').trim()) continue;
  const r = parseReplayGame(row);
  if (!r.ok || r.game.playerCount !== 10) continue;
  const g = r.game;
  games++;
  // Window: R1–R2 (before the lake and most mission evidence) and the whole game.
  for (const [label, maxRound] of [['R1–R2', 2], ['全局', 5]] as const) {
    const picks = new Array(10).fill(0);
    for (const p of g.proposals) {
      if (p.round > maxRound) continue;
      for (const s of p.teamSeats) if (s !== p.leaderSeat) picks[s - 1]++;
      if (label === '全局') {
        const lc = campOf(g.seatRoles[p.leaderSeat - 1]) === 'evil' ? 'evil' : 'good';
        for (const s of p.teamSeats) if (s !== p.leaderSeat) byLeaderCamp[lc][campOf(g.seatRoles[s - 1]) === 'evil' ? 'red' : 'blue']++;
      }
    }
    // Rank inside the game: the most picked third / middle / least picked third.
    const order = [...picks.keys()].sort((a, b) => picks[b] - picks[a]);
    order.forEach((seat, i) => {
      const tier = i < 3 ? '被選最多的 3 人' : i < 7 ? '中間 4 人' : '被選最少的 3 人';
      const k = `${label}｜${tier}`;
      const b = byCount.get(k) ?? { n: 0, good: 0 };
      b.n++; if (campOf(g.seatRoles[seat]) !== 'evil') b.good++;
      byCount.set(k, b);
      if (label === '全局') {
        const role = g.seatRoles[seat];
        const rr = byRole.get(role) ?? { n: 0, picks: 0 };
        rr.n++; rr.picks += picks[seat];
        byRole.set(role, rr);
      }
    });
  }
}
console.log(`10 人局 ${games} 局；藍方基準 = 6/10 = 60%`);
for (const [k, b] of byCount) console.log(`${k.padEnd(20)} 藍方 ${(100 * b.good / b.n).toFixed(1)}%（${b.n} 人次）`);
console.log('\n每局被別人選進隊伍的平均次數（全局）：');
for (const [role, v] of [...byRole].sort((a, b) => b[1].picks / b[1].n - a[1].picks / a[1].n)) console.log(`  ${role.padEnd(9)} ${(v.picks / v.n).toFixed(2)}`);
const share = (o: { blue: number; red: number }) => (100 * o.blue / (o.blue + o.red)).toFixed(1);
console.log(`\n藍隊長選的隊友藍方比例 ${share(byLeaderCamp.good)}%；紅隊長選的隊友藍方比例 ${share(byLeaderCamp.evil)}%（基準：藍隊長 5/9=55.6%，紅隊長 6/9=66.7%）`);
