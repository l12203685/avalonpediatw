/**
 * 紅方集合（worlds）的共用純函式（2026-10-14）。
 *
 * 從 `GoodLakeInfo.ts` 原樣搬出（行為不變，`GoodLakeInfo.test.ts` 守著），
 * 讓模擬瓦（`bots/simulation/logic.ts`）跟之後的機器人信念模型（task Z）共用
 * 同一套：紅方集合用位元遮罩表示，bit i 設起來 ⇔ 第 i 個位置是紅。
 * 誰先合進 main 誰擁有這個模組，另一邊改成 import。
 */

import { AVALON_CONFIG } from '@avalon/shared';

const EVIL_ROLE_NAMES = new Set(['assassin', 'morgana', 'mordred', 'oberon', 'minion']);

/** Number of reds in a standard game of `playerCount` players. */
export function evilCountFor(playerCount: number): number {
  const roles = AVALON_CONFIG[playerCount]?.roles;
  if (roles) return roles.filter((r) => EVIL_ROLE_NAMES.has(r)).length;
  return Math.ceil(playerCount / 3);
}

/**
 * Every k-subset of `pool` as a bit mask (bit `pool[i]` set), in
 * lexicographic order of the pool indices.
 */
export function combinations(pool: readonly number[], k: number): number[] {
  const out: number[] = [];
  const rec = (start: number, left: number, mask: number): void => {
    if (left === 0) { out.push(mask); return; }
    for (let i = start; i <= pool.length - left; i++) rec(i + 1, left - 1, mask | (1 << pool[i]));
  };
  rec(0, k, 0);
  return out;
}

/** Number of set bits. */
export function popcount(x: number): number {
  let c = 0;
  let v = x;
  while (v) { v &= v - 1; c++; }
  return c;
}
