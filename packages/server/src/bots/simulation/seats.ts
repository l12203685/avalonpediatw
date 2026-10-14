/**
 * 模擬瓦（2026-10-14）— 座位的小工具，純函式。
 *
 * 牌譜寫法：座位 1–9 寫數字，第 10 家寫 `0`；隊伍照 1…9、0 排。
 * 紅方集合用位元遮罩：第 s 家 ⇔ bit (s − 1)（第 10 家是 bit 9）。
 */

export const SEAT_COUNT = 10;
export const ALL_SEATS: readonly number[] = Array.from({ length: SEAT_COUNT }, (_, i) => i + 1);

/** 第 s 家的牌譜字元（第 10 家 → '0'）。 */
export function seatChar(seat: number): string {
  return seat === 10 ? '0' : String(seat);
}

/** 1…9 在前、10 最後。 */
export function sortSeats(seats: Iterable<number>): number[] {
  return [...seats].sort((a, b) => a - b);
}

/** 隊伍的牌譜寫法：`[4, 6, 10]` → `460`。 */
export function teamDigits(seats: Iterable<number>): string {
  return sortSeats(seats).map(seatChar).join('');
}

/** 座位清單：`[5, 7, 9]` → `5 7 9`。 */
export function seatList(seats: Iterable<number>): string {
  return sortSeats(seats).map(seatChar).join(' ');
}

export function seatBit(seat: number): number {
  return 1 << (seat - 1);
}

export function maskOf(seats: Iterable<number>): number {
  let m = 0;
  for (const s of seats) m |= seatBit(s);
  return m;
}

export function seatsOfMask(mask: number): number[] {
  return ALL_SEATS.filter((s) => (mask & seatBit(s)) !== 0);
}

/** 紅方集合的牌譜寫法：遮罩 → `1258`、`1350`。 */
export function maskDigits(mask: number): string {
  return teamDigits(seatsOfMask(mask));
}
