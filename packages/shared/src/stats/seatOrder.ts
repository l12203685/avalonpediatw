/** 派／梅／娜的座位順序與穿插率；分母及任務結算口徑與 compute_seat_order 相同。 */
import type { Game } from './dataset';
import { rate } from './pyround';

const LABELS = ['派梅娜', '派娜梅', '梅派娜', '梅娜派', '娜派梅', '娜梅派'];
const SHORT: Record<string, string> = { 派西維爾: '派', 梅林: '梅', 莫甘娜: '娜' };

export interface SeatPermutation {
  order: string;
  total: number;
  三藍梅活: number;
  三藍梅死: number;
  三紅: number;
  三藍梅活pct: number;
  三藍梅死pct: number;
  三紅pct: number;
  穿插任務: number;
  redWinRate: number;
  blueWinRate: number;
  merlinKillRate: number;
  穿插率: number;
  穿插紅勝率: number;
  無穿插紅勝率: number;
}

export interface SeatOrderSection {
  permutations: SeatPermutation[];
  totalGames: number;
  overallRedWinRate: number;
}

export function computeSeatOrder(games: readonly Game[]): SeatOrderSection {
  const groups = new Map(LABELS.map((label) => [label, {
    total: 0, alive: 0, dead: 0, red: 0, blue: 0, interleaved: 0, interleavedRed: 0, adjacentRed: 0,
  }]));
  for (const game of games) {
    const seats = [...game.seatRoles].filter(([seat, role]) => /^[0-9]$/.test(seat) && Boolean(SHORT[role]))
      .map(([seat, role]) => ({ seat: seat === '0' ? 10 : Number(seat), role }))
      .sort((a, b) => a.seat - b.seat);
    if (seats.length !== 3) continue;
    const group = groups.get(seats.map(({ role }) => SHORT[role]).join(''));
    if (!group) continue;
    const gaps = seats.map(({ seat }, i) => (seats[(i + 1) % 3].seat - seat + 10) % 10).sort((a, b) => a - b);
    const interleaved = gaps[0] !== 1 || gaps[1] !== 1;
    group.total += 1;
    group.alive += Number(game.outcome === '三藍活');
    group.dead += Number(game.outcome === '三藍死');
    group.red += Number(game.redWin);
    group.blue += Number(game.blueWin);
    group.interleaved += Number(interleaved);
    group.interleavedRed += Number(interleaved && game.redWin);
    group.adjacentRed += Number(!interleaved && game.redWin);
  }
  const permutations: SeatPermutation[] = [];
  let totalGames = 0;
  let totalRed = 0;
  for (const [order, s] of groups) {
    if (!s.total) continue;
    totalGames += s.total;
    totalRed += s.red;
    permutations.push({
      order, total: s.total, 三藍梅活: s.alive, 三藍梅死: s.dead, 三紅: s.red,
      三藍梅活pct: rate(s.alive, s.total), 三藍梅死pct: rate(s.dead, s.total), 三紅pct: rate(s.red, s.total),
      穿插任務: s.interleaved, redWinRate: rate(s.red, s.total), blueWinRate: rate(s.blue, s.total),
      merlinKillRate: rate(s.dead, s.total), 穿插率: rate(s.interleaved, s.total),
      穿插紅勝率: rate(s.interleavedRed, s.interleaved), 無穿插紅勝率: rate(s.adjacentRed, s.total - s.interleaved),
    });
  }
  return { permutations, totalGames, overallRedWinRate: rate(totalRed, totalGames) };
}
