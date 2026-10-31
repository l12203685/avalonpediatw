/**
 * 陣容強度的篩選條件（Edward 2026-10-31：「S = 場上 PR 的平均，直接用 S 來篩選；或是人數：PR X 有 Y 人以上，X 跟 Y
 * 都可以調整；而且這兩個條件都可以複選（且／或）」「當局的紅方／忠臣各自的最高／最低 ELO & PR，以及派西／梅林的
 * ELO & PR，也可以是分析維度或標籤」）。牌譜紀錄頁籤、統計頁的複合篩選與數據分析「陣容強度」共用這一份判斷。
 *
 * - S 條件：S ≥ sMin。
 * - 人數條件：PR ≥ strongPr 的座位至少 strongCount 個（暫定與沒寫名字的座位不算）。
 * - 角色條件（要知道角色）：梅林 PR ≥ merlinPrMin、派西 PR ≥ percivalPrMin、紅方最低 PR ≥ redMinPrMin、
 *   忠臣最低 PR ≥ loyalMinPrMin、紅方平均 PR − 藍方平均 PR ≥ gapMin（藍方 = 忠臣 + 派西 + 梅林，可以是負數）。
 *   需要的座位有沒寫名字的 → 這個值算不出來，條件不成立。
 * - 每個條件各自可開關（沒給 = 關），combine 決定「且／或」；都關 = 不篩。
 * - 沒評分的局（玩家池太小、名字不夠…）：有開條件時只有 includeUnscored 才算符合。
 */
import { RED_ROLES, SEATS } from './constants';
import { countStrongSeats, type Game, type GameLineup } from './dataset';

export interface LineupCondition {
  sMin?: number;
  strongPr?: number;
  strongCount?: number;
  merlinPrMin?: number;
  percivalPrMin?: number;
  redMinPrMin?: number;
  loyalMinPrMin?: number;
  gapMin?: number;
  combine?: 'and' | 'or';
  includeUnscored?: boolean;
}

/** 一局的角色與哪些座位有名字（SEATS 順序）。 */
export interface LineupSeats {
  roles: readonly string[];
  known: readonly boolean[];
}

export interface GroupStat {
  mean: number;
  max: number;
  min: number;
}

/** 依角色分組的 PR（或 Elo）。 */
export interface RoleValues {
  red: GroupStat | null;
  loyal: GroupStat | null;
  blue: GroupStat | null;
  merlin: number | null;
  percival: number | null;
  assassin: number | null;
}

export interface RoleStrength {
  pr: RoleValues;
  /** 沒有座位 Elo 的舊資料 = null。 */
  elo: RoleValues | null;
}

/** Game → 角色與有名字的座位。 */
export function gameSeats(g: Pick<Game, 'seatRoles' | 'seatPlayers'>): LineupSeats {
  return {
    roles: SEATS.map((s) => g.seatRoles.get(s) ?? '忠臣'),
    known: SEATS.map((_, i) => Boolean(g.seatPlayers[i])),
  };
}

function groupStat(values: readonly number[], idx: readonly number[], known: readonly boolean[]): GroupStat | null {
  if (idx.length === 0 || idx.some((i) => !known[i])) return null;
  const xs = idx.map((i) => values[i]);
  return { mean: xs.reduce((a, b) => a + b, 0) / xs.length, max: Math.max(...xs), min: Math.min(...xs) };
}

function roleValues(values: readonly number[], seats: LineupSeats): RoleValues {
  const where = (test: (role: string) => boolean): number[] =>
    seats.roles.map((r, i) => (test(r) ? i : -1)).filter((i) => i >= 0);
  const single = (role: string): number | null => {
    const idx = where((r) => r === role);
    return idx.length === 1 && seats.known[idx[0]] ? values[idx[0]] : null;
  };
  return {
    red: groupStat(values, where((r) => RED_ROLES.has(r)), seats.known),
    loyal: groupStat(values, where((r) => r === '忠臣'), seats.known),
    blue: groupStat(values, where((r) => !RED_ROLES.has(r)), seats.known),
    merlin: single('梅林'),
    percival: single('派西維爾'),
    assassin: single('刺客'),
  };
}

/** 紅方、忠臣、藍方的平均／最高／最低，梅林、派西、刺客個人的 PR 與 Elo。 */
export function roleStrength(lineup: Pick<GameLineup, 'prs' | 'elos'>, seats: LineupSeats): RoleStrength {
  return { pr: roleValues(lineup.prs, seats), elo: lineup.elos ? roleValues(lineup.elos, seats) : null };
}

/** 紅方平均 PR − 藍方平均 PR（算不出來 = null）。 */
export function redBlueGap(strength: RoleStrength): number | null {
  const { red, blue } = strength.pr;
  return red && blue ? red.mean - blue.mean : null;
}

/** S 條件有沒有開。 */
export function lineupSActive(c: LineupCondition): boolean {
  return typeof c.sMin === 'number';
}

/** 人數條件有沒有開（PR 與人數都要給）。 */
export function lineupCountActive(c: LineupCondition): boolean {
  return typeof c.strongPr === 'number' && typeof c.strongCount === 'number';
}

const ROLE_KEYS = ['merlinPrMin', 'percivalPrMin', 'redMinPrMin', 'loyalMinPrMin', 'gapMin'] as const;

/** 有沒有開任何角色條件。 */
export function lineupRoleActive(c: LineupCondition): boolean {
  return ROLE_KEYS.some((k) => typeof c[k] === 'number');
}

export function lineupConditionActive(c: LineupCondition): boolean {
  return lineupSActive(c) || lineupCountActive(c) || lineupRoleActive(c);
}

/** 一局（的陣容強度）是否符合條件；角色條件要給 seats（沒給 = 角色條件不成立）。 */
export function matchesLineup(
  lineup: Pick<GameLineup, 's' | 'prs' | 'prov'> & { elos?: number[] | null } | null | undefined,
  c: LineupCondition,
  seats?: LineupSeats | null,
): boolean {
  if (!lineupConditionActive(c)) return true;
  if (!lineup) return c.includeUnscored === true;
  const checks: boolean[] = [];
  if (lineupSActive(c)) checks.push(lineup.s >= (c.sMin as number));
  if (lineupCountActive(c)) checks.push(countStrongSeats(lineup, c.strongPr as number) >= (c.strongCount as number));
  if (lineupRoleActive(c)) {
    const st = seats ? roleStrength({ prs: lineup.prs, elos: lineup.elos ?? null }, seats) : null;
    const atLeast = (v: number | null | undefined, min: number | undefined): void => {
      if (typeof min === 'number') checks.push(typeof v === 'number' && v >= min);
    };
    atLeast(st?.pr.merlin, c.merlinPrMin);
    atLeast(st?.pr.percival, c.percivalPrMin);
    atLeast(st?.pr.red?.min, c.redMinPrMin);
    atLeast(st?.pr.loyal?.min, c.loyalMinPrMin);
    atLeast(st ? redBlueGap(st) : null, c.gapMin);
  }
  return c.combine === 'or' ? checks.some(Boolean) : checks.every(Boolean);
}
