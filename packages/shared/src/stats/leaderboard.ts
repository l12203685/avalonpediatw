/**
 * leaderboard 區塊（generate_cache.compute_leaderboard、window_start、_ranked、_board、_role_row、theory_legend、
 * date_summary 逐行移植，榜的中英文字串也一字不差）。
 *
 * 業主規則（Edward 2026-10-13）：「條件篩選可以是近期，但資料篩選不能少場」—— 誰上榜看近期出賽，數字一律看
 * 各人自己的最近 N 場；新人榜是唯一例外。篩選（Edward 2026-10-14）另外可以：
 *   hidden       只從榜上拿掉（全排名算完後拿掉、依原排序補滿 topN、重編名次；角色王的候選排除他們）
 *   isActive     改寫「近 activeDays 天有出賽」的判斷（看全部局，或不限）
 *   newcomer     改寫新人的「首局在近 newcomerDays 天、每局都有日期」判斷；'none' = 不出新人榜
 * 都不給時與 Python 完全相同。
 */
import { ALL_ROLES, OUTCOME_BLUE_ALIVE, OUTCOME_BLUE_DEAD, isFinalWin } from './constants';
import type { Game, GamesDatasetConfig, LeaderboardConfig } from './dataset';
import { pySlice, rate, rnd1, sortByKey } from './pyround';
import {
  playerTimelines,
  roleWindowGames,
  roleWindowTheory,
  theoryWindow,
  theoryWindows,
  type PlayerSeat,
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

function roleRow(name: string, rw: RoleWindows, last: TheoryWindow, career: TheoryWindow, careerGames: number): Row {
  return {
    name, value: rw.roleTheory, roleTheory: rw.roleTheory,
    positionTheory: last.positionTheory, overallTheory: career.roleTheory,
    finalWinRate: last.finalWinRate, games: rw.games, careerGames,
    from: rw.from, to: rw.to, sparseRoles: rw.sparseRoles, sparseSeats: last.sparseSeats,
  };
}

/** generate_cache.theory_legend：附在各榜說明後的三種理論勝率解釋（中、英）。 */
export function theoryLegend(minCell: number, cfg: LeaderboardConfig): [string, string] {
  const k = cfg.roleWindowGames;
  const kl = cfg.loyalWindowGames;
  let zh = `角色理論 = Σ 抽到該角色的機率（忠臣 4/10、其他角色各 1/10）× 本人該角色的最終勝率（每個角色看他當該角色的`
    + `最近 ${k} 場、忠臣 ${kl} 場）；位置理論 = Σ 1/10 × 本人該位置的最終勝率；整體理論 = 用生涯全部場次算的角色理論`;
  let en = `Role theory = Σ chance of being dealt the role (Loyal Servant 4/10, every other role 1/10) × the `
    + `player's final win rate as that role (over their last ${k} games in each role, ${kl} as Loyal Servant); `
    + `position theory = Σ 1/10 × their final win rate in that seat; overall theory = the role theory of their `
    + `whole career`;
  if (minCell > 0) {
    zh += `；不到 ${minCell} 場的角色或位置，用全體的最終勝率補到 ${minCell} 場`;
    en += `; a role or seat with fewer than ${minCell} games is topped up to ${minCell} at the population's final win rate`;
  }
  return [zh, en];
}

export interface LeaderboardOptions {
  hidden?: ReadonlySet<string>;
  /** 誰算「近期有出賽」（預設：時間線上最後一個有日期的局在近 activeDays 天內，as-of 當天也算）。 */
  isActive?: (name: string, seats: readonly PlayerSeat[]) => boolean;
  /** 誰算新人（取代「首局在近 newcomerDays 天、每局都有日期」；場數門檻仍看 `games`）；'none' = 不出新人榜。 */
  newcomer?: 'none' | ((name: string, seats: readonly PlayerSeat[]) => { firstPlayed: string } | null);
  /** 已經算好的 playerTimelines(games)（省一次計算；必須是同一組局的）。 */
  timelines?: Map<string, PlayerSeat[]>;
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
  const cfg = config.leaderboard;
  const hidden = options.hidden ?? new Set<string>();
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

  const window = (seats: readonly PlayerSeat[], n: number): TheoryWindow => theoryWindow(seats, roleRates, seatRates, cell, n);
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
    if (rw.fullWindows) mainRows.push(roleRow(name, rw, window(pySlice(seats, -n), n), window(seats, 0), seats.length));
  }
  boards.push(board(
    'main', 'roleTheory', '角色理論勝率排行', 'Role-theory win rate', rolePeriod, rolePeriodEn, roleGames,
    `近 ${activeDays} 天內有出賽、六個特殊角色各至少 ${k} 場、忠臣至少 ${kl} 場；位置理論與最終勝率看最近 ${n} 場；${legend}`,
    `Played in the last ${activeDays} days, at least ${k} games in each special role and ${kl} as Loyal Servant; `
    + `position theory and final win rate over the last ${n} games; ${legendEn}`,
    ranked(mainRows, topN), { roleWindowGames: windows },
  ));

  // position：最近 mainGames 場的位置理論。
  const positionRows: Row[] = [];
  for (const [name, seats] of listed) {
    if (seats.length < n) continue;
    const last = window(pySlice(seats, -n), n);
    positionRows.push({
      name, value: last.positionTheory, positionTheory: last.positionTheory,
      overallTheory: window(seats, 0).roleTheory, finalWinRate: last.finalWinRate, games: last.games,
      careerGames: seats.length, from: last.from, to: last.to, sparseSeats: last.sparseSeats,
    });
  }
  boards.push(board(
    'position', 'positionTheory', '位置理論勝率排行', 'Position-theory win rate',
    `各人最近 ${n} 場`, `Each player's last ${n} games`, n,
    `近 ${activeDays} 天內有出賽、生涯至少 ${n} 場；${legend}`,
    `Played in the last ${activeDays} days, at least ${n} career games; ${legendEn}`,
    ranked(positionRows, topN), { windowGames: n },
  ));

  // overall：整體理論 = 生涯的角色理論。
  const overallRows: Row[] = [];
  for (const [name, seats] of listed) {
    if (seats.length < overallMin) continue;
    const career = window(seats, 0);
    overallRows.push({
      name, value: career.roleTheory, overallTheory: career.roleTheory,
      positionTheory: career.positionTheory, finalWinRate: career.finalWinRate, games: career.games,
      careerGames: seats.length, from: career.from, to: career.to,
      sparseRoles: career.sparseRoles, sparseSeats: career.sparseSeats,
    });
  }
  boards.push(board(
    'overall', 'overallTheory', '整體理論勝率排行', 'Overall theory win rate',
    '各人生涯全部場次', "Each player's whole career", overallMin,
    `近 ${activeDays} 天內有出賽、生涯至少 ${overallMin} 場；整體理論、位置理論、最終勝率都看生涯全部場次；${legend}`,
    `Played in the last ${activeDays} days, at least ${overallMin} career games; overall theory, position `
    + `theory and final win rate over the whole career; ${legendEn}`,
    ranked(overallRows, topN),
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
    `近 ${activeDays} 天內有出賽、六個特殊角色各至少 ${2 * k} 場、忠臣至少 ${2 * kl} 場；各角色最近 ${k} 場（忠臣 ${kl} 場）`
    + `的角色理論勝率 − 每個角色再之前同樣場數的，只列有進步的人；${legend}`,
    `Played in the last ${activeDays} days, at least ${2 * k} games in each special role and ${2 * kl} as Loyal `
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
    `近 ${activeDays} 天內有出賽、至少 ${aMin} 次刺殺；刺中率 = 三藍死 /（三藍死 + 三藍活），`
    + `看各人當刺客、任務做到三藍的最近 ${aN} 局（三紅沒有刺殺，不算）`,
    `Played in the last ${activeDays} days, at least ${aMin} assassinations; hit rate = 三藍死 / (三藍死 + 三藍活) `
    + `over the last ${aN} games as Assassin that reached three successful missions (三紅 games have no assassination)`,
    ranked(assassinRows, topN), { windowGames: aN },
  ));

  // newcomers（例外）：首局在近 newcomerDays 天的人的全部場次。
  const d = cfg.newcomerDays;
  const m = cfg.newcomerMinGames;
  const newStart = windowStart(asOf, d);
  const newcomerRows: Row[] = [];
  if (options.newcomer !== 'none') {
    for (const [name, seats] of timelines) {
      if (hidden.has(name) || seats.length < Math.max(m, 1)) continue;
      let first: string;
      if (typeof options.newcomer === 'function') {
        const who = options.newcomer(name, seats);
        if (!who) continue;
        first = who.firstPlayed;
      } else {
        if (seats.some((s) => !s.date)) continue;
        first = seats.reduce((a, s) => (s.date < a ? s.date : a), seats[0].date);
        if (newStart !== null && first < newStart) continue;
      }
      const career = window(seats, 0);
      newcomerRows.push({ ...roleRow(name, roleWindows(seats), career, career, seats.length), firstPlayed: first });
    }
  }
  const periodStart = newStart ?? '';
  boards.push(board(
    'newcomers', 'roleTheory', '新人榜', 'Newcomers',
    `${periodStart} ～ ${asOf} 首次出賽`, `First game ${periodStart} to ${asOf}`, m,
    `首次出賽在近 ${d} 天內、至少 ${m} 場；例外：新人場數少，角色理論用他每個角色的全部場次（最多最近 ${k} 場、`
    + `忠臣 ${kl} 場），位置理論與最終勝率用他的全部場次，場數越少越接近全體平均；${legend}`,
    `First game within the last ${d} days, at least ${m} games; the exception: a newcomer has few games, so role `
    + `theory takes all of their games in each role (at most the last ${k}, ${kl} as Loyal Servant) and position theory `
    + `and final win rate all of their games; the fewer there are the closer the numbers stay to the population; `
    + `${legendEn}`,
    ranked(newcomerRows, topN), { windowDays: d, allGames: true },
  ));

  // roleTitles：每個角色，該角色最近 roleTitleGames 場最終勝率並列最高的人皆得稱號。
  const tMin = cfg.roleTitleMinGames;
  const tN = cfg.roleTitleGames;
  const titleRows: LeaderboardRow[] = [];
  for (const role of ALL_ROLES) {
    const candidates: Array<[string, number, number, number]> = [];
    for (const [name, seats] of listed) {
      const inRole = seats.filter((s) => s.role === role);
      if (inRole.length < Math.max(tMin, 1)) continue;
      const last = pySlice(inRole, -tN);
      const wins = last.filter((s) => isFinalWin(role, s.outcome)).length;
      candidates.push([name, last.length, wins, inRole.length]);
    }
    if (!candidates.length) continue;
    const best = Math.max(...candidates.map((c) => rate(c[2], c[1])));
    const holders = sortByKey(candidates.filter((c) => rate(c[2], c[1]) === best), (c) => [-c[1], -c[3], c[0]]);
    for (const [name, gamesN, wins, career] of holders) {
      titleRows.push({
        rank: titleRows.length + 1, role, name, value: best, games: gamesN, wins, careerRoleGames: career,
      });
    }
  }
  boards.push(board(
    'roleTitles', 'finalWinRate', '角色王', 'Role champions',
    `各人該角色最近 ${tN} 場`, `Each player's last ${tN} games in the role`, tMin,
    `近 ${activeDays} 天內有出賽、生涯該角色至少 ${tMin} 場；比各人該角色最近 ${tN} 場的最終勝率，同率者並列、各得稱號`,
    `Played in the last ${activeDays} days, at least ${tMin} career games in the role; best final win rate over `
    + `the last ${tN} games in it, players tied at the top all get the title`,
    titleRows, { windowGames: tN },
  ));

  return {
    asOf,
    dates: dateSummary(games),
    config: { theoryWindows: theoryWindows(cfg), ...cfg },
    boards: boards.filter((b) => b.rows.length),
  };
}
