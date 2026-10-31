/**
 * 陣容強度的篩選條件（Edward 2026-10-31：「S = 場上 PR 的平均，直接用 S 來篩選；或是人數：PR X 有 Y 人以上，X 跟 Y
 * 都可以調整；而且這兩個條件都可以複選（且／或）」）。牌譜紀錄頁籤與統計頁的複合篩選共用這一份判斷。
 *
 * - S 條件：S ≥ sMin。
 * - 人數條件：PR ≥ strongPr 的座位至少 strongCount 個（暫定與沒寫名字的座位不算）。
 * - 兩個條件各自可開關（沒給 = 關），combine 決定「且／或」；都關 = 不篩。
 * - 沒評分的局（玩家池太小、名字不夠…）：有開條件時只有 includeUnscored 才算符合。
 */
import { countStrongSeats, type GameLineup } from './dataset';

export interface LineupCondition {
  sMin?: number;
  strongPr?: number;
  strongCount?: number;
  combine?: 'and' | 'or';
  includeUnscored?: boolean;
}

/** S 條件有沒有開。 */
export function lineupSActive(c: LineupCondition): boolean {
  return typeof c.sMin === 'number';
}

/** 人數條件有沒有開（PR 與人數都要給）。 */
export function lineupCountActive(c: LineupCondition): boolean {
  return typeof c.strongPr === 'number' && typeof c.strongCount === 'number';
}

export function lineupConditionActive(c: LineupCondition): boolean {
  return lineupSActive(c) || lineupCountActive(c);
}

/** 一局（的陣容強度）是否符合條件。 */
export function matchesLineup(
  lineup: Pick<GameLineup, 's' | 'prs' | 'prov'> | null | undefined,
  c: LineupCondition,
): boolean {
  const checks: boolean[] = [];
  if (!lineupConditionActive(c)) return true;
  if (!lineup) return c.includeUnscored === true;
  if (lineupSActive(c)) checks.push(lineup.s >= (c.sMin as number));
  if (lineupCountActive(c)) checks.push(countStrongSeats(lineup, c.strongPr as number) >= (c.strongCount as number));
  return c.combine === 'or' ? checks.some(Boolean) : checks.every(Boolean);
}
