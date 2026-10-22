/**
 * 理論勝率（Edward 2026-10-13 / 10-14，docs/stats/two_stage_outcome.md「理論勝率」）——
 * generate_cache.py 的 player_timelines / theory_window / role_window_theory / player_theory 逐行移植。
 *
 *   角色理論 = Σ 抽到該角色的機率（忠臣 4/10、其他 1/10）× 本人該角色的最終勝率（各角色自己的最近 K_r 場）
 *   位置理論 = Σ 1/10 × 本人該位置的最終勝率（最近 mainGames 場）；整體理論 = 生涯的角色理論
 *   不到 theoryMinCellGames 場的格子用族群率（一位小數的公開值）補到該場數；加總用精確分數，最後五成雙一次。
 */
import { ALL_ROLES, ROLE_DEAL_TENTHS, SEATS, isFinalWin, isOutcome, seatLabel, type Role } from './constants';
import type { Game, LeaderboardConfig } from './dataset';
import { Rational } from './fraction';
import { pySlice, rate } from './pyround';

/** 玩家時間線上的一局（generate_cache.PlayerSeat）。 */
export interface PlayerSeat {
  role: string;
  /** 牌譜座位字元，"0" = 10 號位。 */
  seat: string;
  outcome: string;
  /** YYYY-MM-DD，沒有日期時為空字串。 */
  date: string;
}

export interface TheoryWindow {
  window: number;
  games: number;
  roleTheory: number;
  positionTheory: number;
  finalWinRate: number;
  from: string;
  to: string;
  sparseRoles: number;
  sparseSeats: number;
}

export interface RoleWindowCell {
  games: number;
  wins: number;
  window: number;
  rate: number;
}

export interface RoleWindows {
  roleTheory: number;
  fullWindows: boolean;
  games: number;
  sparseRoles: number;
  from: string;
  to: string;
  roles: Record<string, RoleWindowCell>;
}

/** players[].theory：roleWindows、last<mainGames>、career。 */
export type PlayerTheory = { roleWindows: RoleWindows; career: TheoryWindow } & Record<string, TheoryWindow | RoleWindows>;

export interface TheoryConfig {
  theoryMinCellGames: number;
  theoryWindows: number[];
  mainGames: number;
  activeDays: number;
  roleWindowGames: Record<string, number>;
  positionGames: number;
  overallMinGames: number;
}

/**
 * 每位玩家在有結果（三紅 / 三藍死 / 三藍活）的局中的座位，由舊到新：依 timelineDate（自己的日期，
 * 否則上一個有日期局的日期，在全部局上算好），同日依合併順序。名單順序 = 依此排序後首次出現的順序。
 */
export function playerTimelines(games: readonly Game[]): Map<string, PlayerSeat[]> {
  const keyed: Array<{ d: string; i: number; g: Game }> = [];
  games.forEach((g, i) => {
    if (isOutcome(g.outcome)) keyed.push({ d: g.timelineDate, i, g });
  });
  keyed.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : a.i - b.i));
  const out = new Map<string, PlayerSeat[]>();
  for (const { g } of keyed) {
    SEATS.forEach((seat, s) => {
      const name = g.seatPlayers[s];
      if (!name) return;
      let list = out.get(name);
      if (!list) {
        list = [];
        out.set(name, list);
      }
      list.push({ role: g.seatRoles.get(seat) as string, seat, outcome: g.outcome, date: g.date });
    });
  }
  return out;
}

/** generate_cache._cell_rate：一格的最終勝率 %，不到 minGames 場用族群率補到 minGames 場。 */
export function cellRate(wins: number, games: number, population: number, minGames: number): Rational {
  const m = Math.max(minGames, 1);
  if (games >= m) return Rational.of(100 * wins, games);
  return Rational.of(100 * wins)
    .add(Rational.of(m - games).mul(Rational.fromNumber(population)))
    .div(Rational.of(m));
}

function datedSpan(seats: readonly PlayerSeat[]): { from: string; to: string } {
  let from = '';
  let to = '';
  for (const s of seats) {
    if (!s.date) continue;
    if (!from || s.date < from) from = s.date;
    if (!to || s.date > to) to = s.date;
  }
  return { from, to };
}

/** generate_cache.theory_window：這些局的角色理論、位置理論、最終勝率。`window` 原樣寫出（0 = 生涯）。 */
export function theoryWindow(
  seats: readonly PlayerSeat[],
  roleRates: Readonly<Record<string, number>>,
  seatRates: Readonly<Record<string, number>>,
  minCell: number,
  window = 0,
): TheoryWindow {
  const roleGames = new Map<string, number>();
  const roleWins = new Map<string, number>();
  const seatGames = new Map<string, number>();
  const seatWins = new Map<string, number>();
  let wins = 0;
  for (const s of seats) {
    const w = isFinalWin(s.role, s.outcome) ? 1 : 0;
    wins += w;
    roleGames.set(s.role, (roleGames.get(s.role) ?? 0) + 1);
    roleWins.set(s.role, (roleWins.get(s.role) ?? 0) + w);
    seatGames.set(s.seat, (seatGames.get(s.seat) ?? 0) + 1);
    seatWins.set(s.seat, (seatWins.get(s.seat) ?? 0) + w);
  }
  let roleTheory = Rational.ZERO;
  for (const r of ALL_ROLES) {
    const cell = cellRate(roleWins.get(r) ?? 0, roleGames.get(r) ?? 0, Number(roleRates[r] ?? 0), minCell);
    roleTheory = roleTheory.add(Rational.of(ROLE_DEAL_TENTHS[r], 10).mul(cell));
  }
  let positionTheory = Rational.ZERO;
  for (const s of SEATS) {
    const cell = cellRate(seatWins.get(s) ?? 0, seatGames.get(s) ?? 0, Number(seatRates[seatLabel(s)] ?? 0), minCell);
    positionTheory = positionTheory.add(Rational.of(1, 10).mul(cell));
  }
  const m = Math.max(minCell, 1);
  const { from, to } = datedSpan(seats);
  return {
    window,
    games: seats.length,
    roleTheory: roleTheory.roundTenth(),
    positionTheory: positionTheory.roundTenth(),
    finalWinRate: rate(wins, seats.length),
    from,
    to,
    sparseRoles: ALL_ROLES.filter((r) => (roleGames.get(r) ?? 0) < m).length,
    sparseSeats: SEATS.filter((s) => (seatGames.get(s) ?? 0) < m).length,
  };
}

/** players[].theory 的 last-N 鍵：100 → "last100"。 */
export function theoryKey(window: number): string {
  return `last${window}`;
}

/** generate_cache.theory_windows：[mainGames]（mainGames ≤ 0 時沒有）。 */
export function theoryWindows(cfg: LeaderboardConfig): number[] {
  const n = Math.trunc(Number(cfg.mainGames));
  return n > 0 ? [n] : [];
}

/** generate_cache.role_window_games：每個角色的 K_r（忠臣 loyalWindowGames，其他 roleWindowGames）。 */
export function roleWindowGames(cfg: LeaderboardConfig): Record<Role, number> {
  const out = {} as Record<Role, number>;
  for (const r of ALL_ROLES) out[r] = Math.trunc(Number(r === '忠臣' ? cfg.loyalWindowGames : cfg.roleWindowGames));
  return out;
}

/** overview.theoryConfig（generate_cache.theory_config）。 */
export function theoryConfig(cfg: LeaderboardConfig): TheoryConfig {
  return {
    theoryMinCellGames: Math.trunc(Number(cfg.theoryMinCellGames)),
    theoryWindows: theoryWindows(cfg),
    mainGames: Math.trunc(Number(cfg.mainGames)),
    activeDays: Math.trunc(Number(cfg.activeDays)),
    roleWindowGames: roleWindowGames(cfg),
    positionGames: Math.trunc(Number(cfg.mainGames)),
    overallMinGames: Math.trunc(Number(cfg.overallMinGames)),
  };
}

/**
 * generate_cache.role_window_theory：各角色自己的最近 K_r 場（previous = 再之前的 K_r 場，進步榜的基準）。
 */
export function roleWindowTheory(
  seats: readonly PlayerSeat[],
  roleRates: Readonly<Record<string, number>>,
  cfg: LeaderboardConfig,
  minCell: number,
  previous = false,
): RoleWindows {
  const windows = roleWindowGames(cfg);
  const byRole = new Map<string, PlayerSeat[]>(ALL_ROLES.map((r) => [r, []]));
  for (const s of seats) byRole.get(s.role)?.push(s);
  const m = Math.max(minCell, 1);
  let total = Rational.ZERO;
  const roles: Record<string, RoleWindowCell> = {};
  const used: PlayerSeat[] = [];
  for (const r of ALL_ROLES) {
    const k = windows[r];
    const inRole = byRole.get(r) as PlayerSeat[];
    const picked = previous ? (inRole.length > k ? pySlice(inRole, -2 * k, -k) : []) : pySlice(inRole, -k);
    const wins = picked.filter((s) => isFinalWin(s.role, s.outcome)).length;
    const cell = cellRate(wins, picked.length, Number(roleRates[r] ?? 0), minCell);
    total = total.add(Rational.of(ROLE_DEAL_TENTHS[r], 10).mul(cell));
    roles[r] = { games: picked.length, wins, window: k, rate: cell.roundTenth() };
    used.push(...picked);
  }
  const { from, to } = datedSpan(used);
  return {
    roleTheory: total.roundTenth(),
    fullWindows: ALL_ROLES.every((r) => roles[r].games >= windows[r]),
    games: used.length,
    sparseRoles: ALL_ROLES.filter((r) => roles[r].games < m).length,
    from,
    to,
    roles,
  };
}

/** generate_cache.player_theory：{roleWindows, last<mainGames>, career}。 */
export function playerTheory(
  seats: readonly PlayerSeat[],
  roleRates: Readonly<Record<string, number>>,
  seatRates: Readonly<Record<string, number>>,
  cfg: LeaderboardConfig,
): PlayerTheory {
  const minCell = Number(cfg.theoryMinCellGames);
  const out: Record<string, TheoryWindow | RoleWindows> = { roleWindows: roleWindowTheory(seats, roleRates, cfg, minCell) };
  for (const n of theoryWindows(cfg)) out[theoryKey(n)] = theoryWindow(pySlice(seats, -n), roleRates, seatRates, minCell, n);
  out.career = theoryWindow(seats, roleRates, seatRates, minCell, 0);
  return out as PlayerTheory;
}
