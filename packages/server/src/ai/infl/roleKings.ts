/**
 * 「角色王」群組（Edward 2026-11-04）：每個角色（梅林、派西、忠臣、刺客、莫甘娜、莫德雷德、奧伯倫）在牌譜裡
 * 該角色勝率最高的前 N 名（N = 3、5），該角色至少 `minGames` 場才有資格（預設 30）。只比他們「玩那個角色」的局。
 *
 * `benchmark/cohorts.ts` 的 top/role 是收縮勝率（經驗貝氏 K）取前 10；這裡用同一個函式、`priorStrength: 0`
 * （= 原始勝率）取前 N，不改原檔。公開 repo：輸出只用「角色王#名次」，不寫名字（`label`）。
 */
import type { Role } from '@avalon/shared';
import type { ReplayGame } from '../benchmark/sheetsReplay';
import { BENCHMARK_ROLES, cohortKey, computeTopPerformers } from '../benchmark/cohorts';

export const ROLE_ZH: Record<string, string> = {
  merlin: '梅林', percival: '派西', loyal: '忠臣', assassin: '刺客', morgana: '莫甘娜', mordred: '莫德雷德', oberon: '奧伯倫',
};

export interface RoleKingCohort {
  topN: number;
  minGames: number;
  /** `${name}|${role}` → 名次（1 起）。只在記憶體裡，不輸出名字。 */
  rank: Map<string, number>;
  /** 每個角色入選者的（場數、勝率），依名次；不含名字。 */
  byRole: Record<string, { games: number; winRate: number }[]>;
}

export function roleKings(games: readonly ReplayGame[], topN: number, minGames = 30, shrink: number | 'auto' = 0): RoleKingCohort {
  const top = computeTopPerformers(games, { minGames, perRole: topN, priorStrength: shrink });
  const rank = new Map<string, number>();
  const byRole: RoleKingCohort['byRole'] = {};
  for (const role of BENCHMARK_ROLES) {
    const list = top.byRole[role] ?? [];
    list.forEach((r, k) => rank.set(cohortKey(r.name, r.role), k + 1));
    byRole[role] = list.map((r) => ({ games: r.games, winRate: r.rawWinRate }));
  }
  return { topN, minGames, rank, byRole };
}

export function isRoleKing(c: RoleKingCohort, name: string, role: Role | string): boolean {
  return name !== '' && c.rank.has(cohortKey(name, role));
}

/** 公開用的稱呼：「梅林王#1」。 */
export function roleKingLabel(role: string, rank: number): string {
  return `${ROLE_ZH[role] ?? role}王#${rank}`;
}

/** 兩個群組的名單重疊（敏感度：門檻或收縮改了之後前 N 名換了幾個）。 */
export function overlap(a: RoleKingCohort, b: RoleKingCohort, role: string): number {
  let n = 0;
  for (const [k] of a.rank) if (k.endsWith(`|${role}`) && b.rank.has(k)) n++;
  return n;
}
