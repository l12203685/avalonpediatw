/**
 * leaderboard 區塊（generate_cache.compute_leaderboard、window_start、_ranked、_board、_role_row、theory_legend、
 * date_summary 逐行移植，榜的中英文字串也一字不差）。
 *
 * 業主規則（Edward 2026-10-13）：「條件篩選可以是近期，但資料篩選不能少場」—— 誰上榜看近期出賽，數字一律看
 * 各人自己的最近 N 場；新人榜是唯一例外。篩選（Edward 2026-10-14）另外可以：
 *   hidden       只從榜上拿掉（全排名算完後拿掉、依原排序補滿 topN、重編名次；角色王的候選排除他們）
 *   isActive     改寫「近 activeDays 天有出賽」的判斷（看全部局，或不限）
 *   newcomer     改寫新人的「第 newcomerMinGames 場在近 newcomerDays 天、每局都有日期」判斷；'none' = 不出新人榜
 *   overrides    上榜條件（Edward 2026-10-28「"上榜"條件也做成可調整可變可選」）：蓋在 config.leaderboard 上，
 *                = Python 的 compute_leaderboard(cfg=…)
 * 都不給時與 Python 完全相同。
 */
import { ALL_ROLES, OUTCOME_BLUE_ALIVE, OUTCOME_BLUE_DEAD, isFinalWin, type Role } from './constants';
import type { Game, GamesDatasetConfig, LeaderboardConfig } from './dataset';
import { computeRoleSeatFinalWinRates } from './players';
import { pySlice, rate, rnd1, sortByKey } from './pyround';
import {
  missionAssassination,
  playerTimelines,
  roleWindowGames,
  roleWindowTheory,
  theoryWindow,
  theoryWindows,
  type OutcomeRates,
  type PlayerSeat,
  type RoleSeatRates,
  type RoleWindows,
  type TheoryWindow,
} from './theory';

export interface LeaderboardRow {
  rank: number;
  name: string;
  value: number;
  [key: string]: unknown;
}

export interface LeaderboardBoard {
  id: string;
  metric: string;
  title: string;
  titleEn: string;
  period: string;
  periodEn: string;
  minGames: number;
  note: string;
  noteEn: string;
  rows: LeaderboardRow[];
  [key: string]: unknown;
}

export interface DateSummary {
  parsed: number;
  unparsed: number;
  earliest: string;
  latest: string;
}

export interface LeaderboardSection {
  asOf: string;
  dates: DateSummary;
  config: Record<string, unknown>;
  boards: LeaderboardBoard[];
}

/** YYYY-MM-DD 加減天數（UTC，沒有時區問題）。 */
export function addDays(iso: string, delta: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + delta * 86_400_000).toISOString().slice(0, 10);
}

/** 兩個 YYYY-MM-DD 相差幾天（b − a）。 */
export function daysBetween(a: string, b: string): number {
  const ms = (iso: string): number => {
    const [y, m, d] = iso.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((ms(b) - ms(a)) / 86_400_000);
}

/** generate_cache.window_start：`days` 天窗口（含 end）的第一天；0 = 全部（null）。 */
export function windowStart(end: string, days: number): string | null {
  return days > 0 ? addDays(end, -(days - 1)) : null;
}

/** generate_cache.date_summary：leaderboard.dates。 */
export function dateSummary(games: readonly Pick<Game, 'date'>[]): DateSummary {
  const dated = games.map((g) => g.date).filter((d) => d).sort();
  return {
    parsed: dated.length,
    unparsed: games.length - dated.length,
    earliest: dated.length ? dated[0] : '',
    latest: dated.length ? dated[dated.length - 1] : '',
  };
}

type Row = Record<string, unknown> & { name: string; value: number; games: number; careerGames?: number };

/** generate_cache._ranked：依值、局數、生涯局數（多的先）、名字。 */
function ranked(rows: Row[], topN: number): LeaderboardRow[] {
  return sortByKey(rows, (r) => [-r.value, -r.games, -(r.careerGames ?? 0), r.name])
    .slice(0, topN)
    .map((row, i) => ({ rank: i + 1, ...row }));
}

function board(
  id: string, metric: string, title: string, titleEn: string, period: string, periodEn: string, minGames: number,
  note: string, noteEn: string, rows: LeaderboardRow[], extra: Record<string, unknown> = {},
): LeaderboardBoard {
  return { id, metric, title, titleEn, period, periodEn, minGames, note, noteEn, ...extra, rows };
}

function roleRow(
  name: string, rw: RoleWindows, last: TheoryWindow, career: TheoryWindow, careerGames: number, outcomes: OutcomeRates,
): Row {
  return {
    name, value: rw.roleTheory, roleTheory: rw.roleTheory,
    positionTheory: last.positionTheory, overallTheory: career.overallTheory as number,
    finalWinRate: last.finalWinRate, ...outcomes, games: rw.games, careerGames,
    from: rw.from, to: rw.to, sparseRoles: rw.sparseRoles, sparseSeats: last.sparseSeats,
  };
}

/** generate_cache.theory_legend：附在各榜說明後的三種理論勝率（與任務 / 刺殺勝率）解釋（中、英）。 */
export function theoryLegend(minCell: number, cfg: LeaderboardConfig): [string, string] {
  const k = cfg.roleWindowGames;
  const kl = cfg.loyalWindowGames;
  let zh = `角色理論 = Σ 抽到該角色的機率（忠臣 4/10、其他角色各 1/10）× 本人該角色的最終勝率（每個角色看他當該角色的`
    + `最近 ${k} 場、忠臣 ${kl} 場）；位置理論 = Σ 1/10 × 本人該位置的最終勝率；整體理論 = Σ 抽到該角色的機率 × 1/10 × `
    + `本人在該位置當該角色的最終勝率（位置 × 角色共 70 格，看生涯全部場次）；任務勝率 = 自己陣營贏得任務`
    + `（紅方三紅、藍方三藍）；刺殺勝率 = 三藍局中紅方刺中梅林、藍方梅林躲過`;
  let en = `Role theory = Σ chance of being dealt the role (Loyal Servant 4/10, every other role 1/10) × the `
    + `player's final win rate as that role (over their last ${k} games in each role, ${kl} as Loyal Servant); `
    + `position theory = Σ 1/10 × their final win rate in that seat; overall theory = Σ chance of the role × 1/10 `
    + `× their final win rate as that role in that seat (70 role × seat cells, whole career); mission win rate = `
    + `their camp won the missions (red 三紅, blue 三藍); assassination win rate = in 三藍 games, red hit Merlin / `
    + `blue Merlin survived`;
  if (minCell > 0) {
    zh += `；不到 ${minCell} 場的角色、位置或格子，用全體的最終勝率補到 ${minCell} 場`;
    en += `; a role, seat or cell with fewer than ${minCell} games is topped up to ${minCell} at the `
      + `population's final win rate`;
  }
  return [zh, en];
}

/**
 * generate_cache.role_title_windows：角色王每個角色的視窗——`active`（上榜名單裡近期有出賽的人）中玩過該角色的
 * 人至少一半有完整視窗（忠臣 loyalTitleGames、其他 roleTitleGames）就用它，否則用退回視窗（Edward 2026-10-28）。
 */
export function roleTitleWindows(
  active: ReadonlyArray<readonly [string, readonly PlayerSeat[]]>,
  cfg: LeaderboardConfig,
): Record<Role, number> {
  const out = {} as Record<Role, number>;
  for (const role of ALL_ROLES) {
    const [full, fallback] = role === '忠臣'
      ? [cfg.loyalTitleGames, cfg.loyalTitleFallbackGames]
      : [cfg.roleTitleGames, cfg.roleTitleFallbackGames];
    const counts = active.map(([, seats]) => seats.filter((s) => s.role === role).length).filter((n) => n > 0);
    const enough = counts.filter((n) => n >= full).length;
    out[role] = Math.trunc(Number(2 * enough >= counts.length ? full : fallback));
  }
  return out;
}

export interface LeaderboardOptions {
  hidden?: ReadonlySet<string>;
  /** 誰算「近期有出賽」（預設：時間線上最後一個有日期的局在近 activeDays 天內，as-of 當天也算）。 */
  isActive?: (name: string, seats: readonly PlayerSeat[]) => boolean;
  /**
   * 誰算新人（取代「第 newcomerMinGames 場在近 newcomerDays 天、每局都有日期」；場數門檻仍看 `games`）；
   * 'none' = 不出新人榜。
   */
  newcomer?: 'none' | ((name: string, seats: readonly PlayerSeat[]) => { firstPlayed: string; qualifiedOn: string } | null);
  /** 已經算好的 playerTimelines(games)（省一次計算；必須是同一組局的）。 */
  timelines?: Map<string, PlayerSeat[]>;
  /** overview.roleSeatFinalWinRates（沒給就從局算）。 */
  roleSeatRates?: RoleSeatRates;
  /** 上榜條件（篩選的 options.leaderboard）：蓋在 config.leaderboard 上，只影響排行。 */
  overrides?: Partial<LeaderboardConfig>;
}

/** generate_cache.compute_leaderboard：空的榜不輸出。 */
export function computeLeaderboard(
  games: readonly Game[],
  asOf: string,
  roleRates: Readonly<Record<string, number>>,
  seatRates: Readonly<Record<string, number>>,
  config: GamesDatasetConfig,
  options: LeaderboardOptions = {},
): LeaderboardSection {
  const cfg: LeaderboardConfig = { ...config.leaderboard, ...(options.overrides ?? {}) } as LeaderboardConfig;
  const hidden = options.hidden ?? new Set<string>();
  const roleSeatRates = options.roleSeatRates ?? computeRoleSeatFinalWinRates(games);
  const topN = cfg.topN;
  const activeDays = cfg.activeDays;
  const cell = cfg.theoryMinCellGames;
  const [legend, legendEn] = theoryLegend(cell, cfg);
  const timelines = options.timelines ?? playerTimelines(games);
  const activeFrom = windowStart(asOf, activeDays);
  const isActive = options.isActive ?? ((_name: string, seats: readonly PlayerSeat[]): boolean => {
    let last = '';
    for (const s of seats) if (s.date && s.date > last) last = s.date;
    return Boolean(last) && (activeFrom === null || last >= activeFrom);
  });
  const active: Array<[string, PlayerSeat[]]> = [];
  for (const [name, seats] of timelines) if (isActive(name, seats)) active.push([name, seats]);
  const listed = active.filter(([name]) => !hidden.has(name));
  const activeZh = activeDays > 0 ? `近 ${activeDays} 天內有出賽` : '不限近期出賽';
  const activeEn = activeDays > 0 ? `Played in the last ${activeDays} days` : 'Any player (no recent-activity rule)';

  const window = (seats: readonly PlayerSeat[], n: number, career = false): TheoryWindow =>
    theoryWindow(seats, roleRates, seatRates, cell, n, career ? roleSeatRates : undefined);
  const roleWindows = (seats: readonly PlayerSeat[], previous = false): RoleWindows =>
    roleWindowTheory(seats, roleRates, cfg, cell, previous);

  const boards: LeaderboardBoard[] = [];
  const n = cfg.mainGames;
  const k = cfg.roleWindowGames;
  const kl = cfg.loyalWindowGames;
  const overallMin = cfg.overallMinGames;
  const windows = roleWindowGames(cfg);
  const roleGames = Object.values(windows).reduce((a, b) => a + b, 0);
  const rolePeriod = `各角色近 ${k} 場、忠臣近 ${kl} 場`;
  const rolePeriodEn = `Each role's last ${k} games (Loyal Servant: last ${kl})`;

  // main：各角色窗的角色理論，角色窗全滿才上榜。
  const mainRows: Row[] = [];
  for (const [name, seats] of listed) {
    const rw = roleWindows(seats);
    if (rw.fullWindows) {
      mainRows.push(roleRow(name, rw, window(pySlice(seats, -n), n), window(seats, 0, true), seats.length,
        missionAssassination(pySlice(seats, -n))));
    }
  }
  boards.push(board(
    'main', 'roleTheory', '角色理論勝率排行', 'Role-theory win rate', rolePeriod, rolePeriodEn, roleGames,
    `${activeZh}、六個特殊角色各至少 ${k} 場、忠臣至少 ${kl} 場；位置理論、最終勝率、任務勝率、刺殺勝率看最近 ${n} 場、`
    + `整體理論看生涯；${legend}`,
    `${activeEn}, at least ${k} games in each special role and ${kl} as Loyal Servant; position theory, final, `
    + `mission and assassination win rates over the last ${n} games, overall theory over the career; ${legendEn}`,
    ranked(mainRows, topN), { roleWindowGames: windows },
  ));

  // position：最近 mainGames 場的位置理論。
  const positionRows: Row[] = [];
  for (const [name, seats] of listed) {
    if (seats.length < n) continue;
    const last = window(pySlice(seats, -n), n);
    positionRows.push({
      name, value: last.positionTheory, positionTheory: last.positionTheory,
      overallTheory: window(seats, 0, true).overallTheory as number, finalWinRate: last.finalWinRate,
      ...missionAssassination(pySlice(seats, -n)), games: last.games,
      careerGames: seats.length, from: last.from, to: last.to, sparseSeats: last.sparseSeats,
    });
  }
  boards.push(board(
    'position', 'positionTheory', '位置理論勝率排行', 'Position-theory win rate',
    `各人最近 ${n} 場`, `Each player's last ${n} games`, n,
    `${activeZh}、生涯至少 ${n} 場；最終勝率、任務勝率、刺殺勝率也看最近 ${n} 場、整體理論看生涯；${legend}`,
    `${activeEn}, at least ${n} career games; final, mission and assassination win rates over the same `
    + `${n} games, overall theory over the career; ${legendEn}`,
    ranked(positionRows, topN), { windowGames: n },
  ));

  // overall：整體理論 = 生涯的角色 × 位置。
  const overallRows: Row[] = [];
  for (const [name, seats] of listed) {
    if (seats.length < overallMin) continue;
    const career = window(seats, 0, true);
    overallRows.push({
      name, value: career.overallTheory as number, overallTheory: career.overallTheory,
      roleTheory: career.roleTheory, positionTheory: career.positionTheory,
      finalWinRate: career.finalWinRate, ...missionAssassination(seats), games: career.games,
      careerGames: seats.length, from: career.from, to: career.to,
      sparseRoles: career.sparseRoles, sparseSeats: career.sparseSeats,
      sparseCells: career.sparseCells, populationShare: career.populationShare,
    });
  }
  const m5 = Math.max(cell, 1);
  boards.push(board(
    'overall', 'overallTheory', '整體理論勝率排行', 'Overall theory win rate',
    '各人生涯全部場次', "Each player's whole career", overallMin,
    `${activeZh}、生涯至少 ${overallMin} 場；每一列的數字都看生涯全部場次；位置 × 角色共 70 格，多數人很多格不到 `
    + `${m5} 場、用全體在該位置該角色的最終勝率補（「全體補值」欄 = 整體理論裡全體補的比重），`
    + `補得越多越接近全體平均；${legend}`,
    `${activeEn}, at least ${overallMin} career games; every number over the whole career; there are 70 role `
    + `× seat cells and most players have fewer than ${m5} games in many of them, topped up at the `
    + `population's final win rate in that cell (the population-share column = how much of the overall theory `
    + `that is), so the more is topped up the closer it stays to the population; ${legendEn}`,
    ranked(overallRows, topN),
  ));

  // theory：一張表的所有理論勝率（網站的「理論勝率」分頁；Edward 2026-10-28）。窗撐不起的數字標出來，不混用：
  // 生涯不到 overallMinGames 場的整體理論 = null、角色窗沒打滿 fullWindows = false、最近 N 場不足 games < windowGames。
  const tMin = cfg.theoryMinGames;
  const needRw = Boolean(cfg.requireRoleWindows);
  const theoryRows: Row[] = [];
  for (const [name, seats] of listed) {
    if (seats.length < tMin) continue;
    const rw = roleWindows(seats);
    if (needRw && !rw.fullWindows) continue;
    const last = window(pySlice(seats, -n), n);
    const career = window(seats, 0, true);
    const overallOk = seats.length >= overallMin;
    theoryRows.push({
      name, value: rw.roleTheory, roleTheory: rw.roleTheory,
      positionTheory: last.positionTheory, overallTheory: overallOk ? career.overallTheory : null,
      finalWinRate: last.finalWinRate, ...missionAssassination(pySlice(seats, -n)),
      games: last.games, careerGames: seats.length, roleGames: rw.games, fullWindows: rw.fullWindows,
      from: last.from, to: last.to, sparseRoles: rw.sparseRoles, sparseSeats: last.sparseSeats,
      sparseCells: overallOk ? career.sparseCells : null,
      populationShare: overallOk ? career.populationShare : null,
    });
  }
  const [windowZh, windowEn] = n > 0 ? [`最近 ${n} 場`, `the last ${n} games`] : ['生涯全部場次', 'the whole career'];
  const whoZh = activeZh + (tMin > 0 ? `、生涯至少 ${tMin} 場` : '') + (needRw ? `、六個特殊角色各至少 ${k} 場、忠臣至少 ${kl} 場` : '');
  const whoEn = activeEn + (tMin > 0 ? `, at least ${tMin} career games` : '')
    + (needRw ? `, at least ${k} games in each special role and ${kl} as Loyal Servant` : '');
  boards.push(board(
    'theory', 'roleTheory', '理論勝率', 'Theory win rates',
    `角色理論：${rolePeriod}；其他：${windowZh}`, `Role theory: ${rolePeriodEn}; the rest: ${windowEn}`,
    tMin,
    `${whoZh}；角色理論看各角色窗（沒打滿的變淡）、位置理論、最終勝率、任務勝率、刺殺勝率看${windowZh}`
    + `（場數不夠的變淡）、整體理論看生涯（生涯不到 ${overallMin} 場的不算，顯示 —）；${legend}`,
    `${whoEn}; role theory over the role windows (dimmed when not full), position theory, final, mission and `
    + `assassination win rates over ${windowEn} (dimmed when shorter), overall theory over the career (— below `
    + `${overallMin} career games); ${legendEn}`,
    ranked(theoryRows, theoryRows.length),
    { roleWindowGames: windows, windowGames: n, overallMinGames: overallMin, requireRoleWindows: needRw },
  ));

  // improved：各角色窗 vs 再之前同樣場數（兩者都要打滿）。
  const improvedRows: Row[] = [];
  for (const [name, seats] of listed) {
    const now = roleWindows(seats);
    const before = roleWindows(seats, true);
    if (!(now.fullWindows && before.fullWindows)) continue;
    const delta = rnd1(now.roleTheory - before.roleTheory);
    if (delta <= 0) continue;
    improvedRows.push({
      name, value: delta, recentRoleTheory: now.roleTheory, priorRoleTheory: before.roleTheory,
      recentGames: now.games, priorGames: before.games, games: now.games, careerGames: seats.length,
    });
  }
  boards.push(board(
    'improved', 'roleTheoryDelta', '進步榜', 'Most improved',
    `${rolePeriod} vs 再之前同樣場數`, `${rolePeriodEn} vs the same number of games before them`, 2 * roleGames,
    `${activeZh}、六個特殊角色各至少 ${2 * k} 場、忠臣至少 ${2 * kl} 場；各角色最近 ${k} 場（忠臣 ${kl} 場）`
    + `的角色理論勝率 − 每個角色再之前同樣場數的，只列有進步的人；${legend}`,
    `${activeEn}, at least ${2 * k} games in each special role and ${2 * kl} as Loyal `
    + `Servant; role theory over each role's last ${k} games (${kl} as Loyal Servant) minus that over the games `
    + `before them in each role, improvers only; ${legendEn}`,
    ranked(improvedRows, topN), { roleWindowGames: windows },
  ));

  // assassin：最近 assassinAttempts 次刺殺（當刺客、任務做到三藍的局）的刺中率。
  const aN = cfg.assassinAttempts;
  const aMin = cfg.assassinMinAttempts;
  const assassinRows: Row[] = [];
  for (const [name, seats] of listed) {
    const attempts = pySlice(
      seats.filter((s) => s.role === '刺客' && (s.outcome === OUTCOME_BLUE_DEAD || s.outcome === OUTCOME_BLUE_ALIVE)),
      -aN,
    );
    if (attempts.length < Math.max(aMin, 1)) continue;
    const hits = attempts.filter((s) => s.outcome === OUTCOME_BLUE_DEAD).length;
    const dated = attempts.map((s) => s.date).filter((d) => d);
    assassinRows.push({
      name, value: rate(hits, attempts.length), hits, attempts: attempts.length,
      games: attempts.length, careerGames: seats.length,
      from: dated.length ? dated.reduce((a, b) => (b < a ? b : a)) : '',
      to: dated.length ? dated.reduce((a, b) => (b > a ? b : a)) : '',
    });
  }
  boards.push(board(
    'assassin', 'hitRate', '刺客刺中率', 'Assassin hit rate',
    `各人最近 ${aN} 次刺殺`, `Each player's last ${aN} assassinations`, aMin,
    `${activeZh}、至少 ${aMin} 次刺殺；刺中率 = 三藍死 /（三藍死 + 三藍活），`
    + `看各人當刺客、任務做到三藍的最近 ${aN} 局（三紅沒有刺殺，不算）`,
    `${activeEn}, at least ${aMin} assassinations; hit rate = 三藍死 / (三藍死 + 三藍活) `
    + `over the last ${aN} games as Assassin that reached three successful missions (三紅 games have no assassination)`,
    ranked(assassinRows, topN), { windowGames: aN },
  ));

  // newcomers（例外）：第一次累積到 newcomerMinGames 場在近 newcomerDays 天的人的全部場次（Edward 2026-10-26
  // 「以初次超過門檻場數當作標準」：很久以前打過幾場、最近才打滿門檻的人也是新人）。
  const d = cfg.newcomerDays;
  const m = cfg.newcomerMinGames;
  const newStart = windowStart(asOf, d);
  const newcomerRows: Row[] = [];
  if (options.newcomer !== 'none') {
    for (const [name, seats] of timelines) {
      if (hidden.has(name) || seats.length < Math.max(m, 1)) continue;
      let first: string;
      let qualified: string;
      if (typeof options.newcomer === 'function') {
        const who = options.newcomer(name, seats);
        if (!who) continue;
        first = who.firstPlayed;
        qualified = who.qualifiedOn;
      } else {
        if (seats.some((s) => !s.date)) continue;
        const dates = seats.map((s) => s.date).sort();
        first = dates[0];
        qualified = dates[Math.max(m, 1) - 1];
        if (newStart !== null && qualified < newStart) continue;
      }
      const career = window(seats, 0, true);
      newcomerRows.push({
        ...roleRow(name, roleWindows(seats), career, career, seats.length, missionAssassination(seats)),
        firstPlayed: first, qualifiedOn: qualified,
      });
    }
  }
  const periodStart = newStart ?? '';
  boards.push(board(
    'newcomers', 'roleTheory', '新人榜', 'Newcomers',
    `${periodStart} ～ ${asOf} 打滿 ${m} 場`, `Reached ${m} games ${periodStart} to ${asOf}`, m,
    `第一次累積到 ${m} 場是在近 ${d} 天內（以前打過幾場也算新人）；例外：新人場數少，角色理論用他每個角色的全部場次（最多最近 ${k} 場、`
    + `忠臣 ${kl} 場），位置理論與最終勝率用他的全部場次，場數越少越接近全體平均；${legend}`,
    `Reached ${m} games for the first time within the last ${d} days (a few earlier games still count as new); the exception: a newcomer has few games, so role `
    + `theory takes all of their games in each role (at most the last ${k}, ${kl} as Loyal Servant) and position theory `
    + `and final win rate all of their games; the fewer there are the closer the numbers stay to the population; `
    + `${legendEn}`,
    ranked(newcomerRows, topN), { windowDays: d, allGames: true },
  ));

  // roleTitles：每個角色的視窗 W_r（roleTitleWindows），打滿 W_r 場才列，最近 W_r 場最終勝率並列最高的人皆得稱號。
  // roleTop（Edward 2026-10-30「角色王可以列出每一個角色對應的勝率 TOP10 的玩家嗎？」）：同一批候選、同一個勝率，
  // 每個角色前 topN 名；名次依勝率（同率同名次），同率時排序同稱號（場數、該角色生涯場數多的先、名字）。
  const titleWindows = roleTitleWindows(listed, cfg);
  const titleRows: LeaderboardRow[] = [];
  const roleTop: Record<string, LeaderboardRow[]> = {};
  for (const role of ALL_ROLES) {
    const w = Math.max(titleWindows[role], 1);
    const candidates: Array<[string, number, number, number]> = [];
    for (const [name, seats] of listed) {
      const inRole = seats.filter((s) => s.role === role);
      if (inRole.length < w) continue;
      const last = pySlice(inRole, -w);
      const wins = last.filter((s) => isFinalWin(role, s.outcome)).length;
      candidates.push([name, last.length, wins, inRole.length]);
    }
    if (!candidates.length) continue;
    const ordered = sortByKey(candidates, (c) => [-rate(c[2], c[1]), -c[1], -c[3], c[0]]).slice(0, topN);
    roleTop[role] = ordered.map(([name, gamesN, wins, career]) => {
      const value = rate(wins, gamesN);
      return {
        rank: 1 + candidates.filter((c) => rate(c[2], c[1]) > value).length,
        name, value, games: gamesN, wins, careerRoleGames: career,
      };
    });
    const best = Math.max(...candidates.map((c) => rate(c[2], c[1])));
    const holders = sortByKey(candidates.filter((c) => rate(c[2], c[1]) === best), (c) => [-c[1], -c[3], c[0]]);
    for (const [name, gamesN, wins, career] of holders) {
      titleRows.push({
        rank: titleRows.length + 1, role, name, value: best, games: gamesN, wins, careerRoleGames: career,
        qualified: candidates.length,
      });
    }
  }
  const others = ALL_ROLES.filter((r) => r !== '忠臣').map((r) => titleWindows[r]);
  const lw = titleWindows['忠臣'];
  let tPeriod: string;
  let tPeriodEn: string;
  if (new Set(others).size === 1) {
    tPeriod = `忠臣近 ${lw} 場、其他角色近 ${others[0]} 場`;
    tPeriodEn = `Last ${lw} games as Loyal Servant, ${others[0]} in each other role`;
  } else {
    const list = ALL_ROLES.filter((r) => r !== '忠臣').map((r) => `${r} ${titleWindows[r]}`).join('、');
    tPeriod = `忠臣近 ${lw} 場；${list} 場`;
    tPeriodEn = `Last ${lw} games as Loyal Servant; other roles: see each row`;
  }
  const lt = cfg.loyalTitleGames;
  const lf = cfg.loyalTitleFallbackGames;
  const rt = cfg.roleTitleGames;
  const rf = cfg.roleTitleFallbackGames;
  const auto = lt !== lf || rt !== rf;
  const ruleZh = auto
    ? `每個角色的場數：忠臣 ${lt} 場、其他角色 ${rt} 場，有出賽過該角色的人不到一半打滿時改用忠臣 ${lf} 場、其他角色 ${rf} 場`
    : `每個角色的場數固定：忠臣 ${lt} 場、其他角色 ${rt} 場`;
  const ruleEn = auto
    ? `games per role: ${lt} as Loyal Servant and ${rt} in each other role, or ${lf} / ${rf} when fewer than half `
      + `of the players who have played the role have that many`
    : `fixed games per role: ${lt} as Loyal Servant, ${rt} in each other role`;
  boards.push(board(
    'roleTitles', 'finalWinRate', '角色王', 'Role champions',
    tPeriod, tPeriodEn, Math.min(...Object.values(titleWindows)),
    `${activeZh}、該角色至少打滿該角色的場數；比各人該角色最近這些場的最終勝率，同率者並列、各得稱號，`
    + `每個角色另列前 ${topN} 名；${ruleZh}`,
    `${activeEn}, a full window in the role; best final win rate over the last games of that window, players `
    + `tied at the top all get the title, and each role lists its top ${topN}; ${ruleEn}`,
    titleRows, { roleWindowGames: titleWindows, roleTop },
  ));

  return {
    asOf,
    dates: dateSummary(games),
    config: { theoryWindows: theoryWindows(cfg), ...cfg },
    boards: boards.filter((b) => b.rows.length),
  };
}
