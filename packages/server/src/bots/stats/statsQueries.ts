/**
 * Stats queries — reads analysis_cache.json through the existing
 * services/sheetsAnalysis.ts accessors (never re-parses the file) and hands
 * the data to the pure formatters in statsReplies.ts. Shared by the Discord
 * slash commands, the LINE text commands and the weekly digest.
 *
 * Every function resolves to a ready-to-send string and never throws: a
 * missing / unreadable cache becomes a short "暫時讀不到" reply.
 */

import crypto from 'crypto';
import {
  getAllPlayerStats,
  getChemistry,
  getLeaderboard,
  getOverview,
  getPlayerAliases,
  getPlayerArchetype,
  getPlayerByName,
  getPlayerPlaystyle,
  getPlayerStrength,
  getRatingBoard,
} from '../../services/sheetsAnalysis';
import type { LeaderboardBoard, OverviewData, PlayerStats, TheoryBaselines } from '../../services/sheetsAnalysis';
import type { NameMatch } from './statsReplies';
import {
  STATS_COMMAND_USAGE,
  STATS_PAGE_URL,
  DIGEST_IMPROVED_SIZE,
  DIGEST_NEWCOMERS_SIZE,
  boardQualifier,
  chemistryRoster,
  configRoleWindows,
  findBoard,
  findSamePlayerName,
  findTypedPlayerName,
  formatChemistry,
  formatLeaderboard,
  formatNameProblem,
  formatNotInChemistry,
  formatPlayerCard,
  formatStatsUnavailable,
  findTheoryBoard,
  LEADERBOARD_SIZE,
  improvedLines,
  leaderboardScope,
  lookupPair,
  matchPlayerName,
  newcomersLine,
  newcomersQualifier,
  normalizeName,
  roleTitleGroups,
  roleTitlesLine,
  selectLeaderboard,
} from './statsReplies';
import { digestDateLabel } from './weeklyDigest';
import {
  chartPct,
  chartSigned,
  renderWeeklyChartPng,
  stripLeadingEmoji,
  type WeeklyChartBarPanel,
  type WeeklyChartData,
  type WeeklyChartRoleKing,
} from './weeklyChart';

async function safely(label: string, run: () => Promise<string>): Promise<string> {
  try {
    return await run();
  } catch (err) {
    console.error(`[stats] ${label} failed:`, err);
    return formatStatsUnavailable();
  }
}

/** Player names, most games first (so ambiguous lists show regulars first). */
function namesByGames(players: readonly PlayerStats[]): string[] {
  return players
    .slice()
    .sort((a, b) => b.totalGames - a.totalGames)
    .map((p) => p.name);
}

// ─── /戰績 ───────────────────────────────────────────────────────────────

export async function playerCardReply(query: string): Promise<string> {
  return safely('player card', async () => {
    const [players, aliases] = await Promise.all([getAllPlayerStats(), getPlayerAliases()]);
    // An old name in players.aliases (player_aliases.json) finds the official name's card.
    const match = matchPlayerName(query, namesByGames(players), aliases);
    if (match.kind !== 'found') return formatNameProblem(match);

    const player = (await getPlayerByName(match.name)) ?? players.find((p) => p.name === match.name);
    if (!player) return formatNameProblem({ kind: 'none', query });

    const [archetype, strength, playstyle, leaderboard] = await Promise.all([
      getPlayerArchetype(match.name).catch(() => null),
      getPlayerStrength(match.name).catch(() => null),
      getPlayerPlaystyle(match.name).catch(() => null),
      getLeaderboard().catch(() => null),
    ]);
    const minCell = leaderboard?.config?.theoryMinCellGames;
    // 新人榜 ranks role theory over windows that are not full: the card names the rank instead of
    // saying the player is not ranked.
    const newcomer = findTheoryBoard(leaderboard, 'newcomers')?.rows.find((r) => r.name === player.name);
    return formatPlayerCard({
      player,
      archetype: archetype ? { data: archetype.data } : null,
      strength: strength?.data ?? null,
      playstyle: playstyle ? { data: playstyle.data, labels: playstyle.labels } : null,
      caseVariants: match.caseVariants,
      alias: match.alias,
      minCellGames: typeof minCell === 'number' ? minCell : undefined,
      newcomerRank: typeof newcomer?.rank === 'number' ? newcomer.rank : null,
    });
  });
}

// ─── /排行 ───────────────────────────────────────────────────────────────

/**
 * Leaderboard text; throws when the cache cannot be read (digest must not
 * post an error). The main board comes from the cache's `leaderboard`
 * section (see selectLeaderboard for the fallbacks); with `digest` the 進步榜
 * Top 5, the 角色王 line and the 新人榜 line are appended (when the cache has them).
 */
export async function leaderboardText(
  opts: { header?: string; footerLines?: string[]; digest?: boolean } = {},
): Promise<string> {
  const [overview, leaderboard] = await Promise.all([getOverview(), getLeaderboard()]);
  const main = selectLeaderboard(leaderboard, overview);

  const sections: string[][] = [];
  if (opts.digest) {
    const improved = improvedLines(findBoard(leaderboard, 'improved'));
    if (improved.length > 0) sections.push(improved);
    const titles = roleTitlesLine(findBoard(leaderboard, 'roleTitles'));
    if (titles) sections.push([titles]);
    const newcomers = newcomersLine(
      findBoard(leaderboard, 'newcomers'),
      undefined,
      configRoleWindows(leaderboard?.config, overview?.theoryConfig as Record<string, unknown> | undefined),
    );
    if (newcomers) sections.push([newcomers]);
  }
  return formatLeaderboard(overview, main, { header: opts.header, sections, footerLines: opts.footerLines });
}

export async function leaderboardReply(): Promise<string> {
  return safely('leaderboard', () => leaderboardText());
}

/**
 * The window /排行 ranks by, for /help and /指令 (statsReplies.leaderboardScope): 「各角色近 10 場、忠臣近
 * 40 場」 on a schemaVersion-4 cache, 「各人最近 100 場」 on a schemaVersion-3 one; null when the cache
 * cannot be read or predates the theory rates (the help text then names no window). Never throws.
 */
export async function leaderboardScopeText(): Promise<string | null> {
  try {
    const [overview, leaderboard] = await Promise.all([getOverview(), getLeaderboard()]);
    return leaderboardScope(leaderboard, overview);
  } catch (err) {
    console.error('[stats] help scope failed:', err);
    return null;
  }
}

/**
 * Monday digest: dated header, main board Top 10 (角色理論, 各角色近 10 場、忠臣近 40 場),
 * 進步榜 Top 5, 角色王, 新人榜 (each only when the cache has it; later sections
 * are dropped first when the text would exceed the cap) and a how-to-look-up
 * line. Throws on cache errors.
 */
export async function weeklyDigestText(now: number = Date.now()): Promise<string> {
  return leaderboardText({
    header: `📅 每週排行（${digestDateLabel(now)}）`,
    digest: true,
    footerLines: [`查個人：${STATS_COMMAND_USAGE.player}｜兩人默契：${STATS_COMMAND_USAGE.chemistry}`],
  });
}

/** "角色理論勝率排行 Top 10（qualifier）" → title without the emoji, and the bracket as the note. */
function splitViewTitle(title: string): { title: string; note: string | null } {
  const bare = stripLeadingEmoji(title);
  const m = /^(.*?)（(.*)）$/u.exec(bare);
  return m ? { title: columnTitle(m[1].trim()), note: m[2].trim() || null } : { title: columnTitle(bare), note: null };
}

/** A column heading: "角色理論勝率排行 Top 10" → "角色理論勝率 Top 10" (three columns share 1080 px). */
function columnTitle(title: string): string {
  return title.replace(/排行(?=\s*Top\b|$)/u, '').trim();
}

/** P(role) in 10-player Avalon (the generator's legend: 忠臣 4/10, the six special roles 1/10 each). */
const ROLE_PROBABILITY: Readonly<Record<string, number>> = {
  刺客: 1 / 10,
  莫甘娜: 1 / 10,
  莫德雷德: 1 / 10,
  奧伯倫: 1 / 10,
  派西維爾: 1 / 10,
  梅林: 1 / 10,
  忠臣: 4 / 10,
};
const SEATS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'];

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * 全體 when the cache has no rating.theoryBaselines (owner 2026-11-10: the average instead of 50%): each theory rate computed for
 * the whole population — every game of every player — with the same formula the generator applies to
 * one player, fed the population's own final win rates from the overview (the very rates it tops sparse
 * cells up with):
 *   角色理論 = Σ_role P(role) × roleFinalWinRates[role]
 *   位置理論 = Σ_seat 1/10 × seatFinalWinRates[seat]
 *   整體理論 = Σ_role Σ_seat P(role) × 1/10 × roleSeatFinalWinRates[role][seat]
 * i.e. the rate of a player whose every role / seat equals the population's. Each is null when a cell
 * is missing (older cache) — the chart then draws no baseline.
 */
export function populationTheoryAverages(
  overview: Pick<OverviewData, 'roleFinalWinRates' | 'seatFinalWinRates' | 'roleSeatFinalWinRates'> | null | undefined,
): { role: number | null; position: number | null; overall: number | null } {
  const roles = Object.entries(ROLE_PROBABILITY);
  const roleRates = overview?.roleFinalWinRates;
  const role = roleRates && roles.every(([r]) => finite(roleRates[r])) ? roles.reduce((sum, [r, p]) => sum + p * roleRates[r], 0) : null;
  const seatRates = overview?.seatFinalWinRates;
  const position = seatRates && SEATS.every((st) => finite(seatRates[st])) ? SEATS.reduce((sum, st) => sum + seatRates[st] / 10, 0) : null;
  const cells = overview?.roleSeatFinalWinRates;
  const overall =
    cells && roles.every(([r]) => SEATS.every((st) => finite(cells[r]?.[st])))
      ? roles.reduce((sum, [r, p]) => sum + SEATS.reduce((acc, st) => acc + (p * cells[r][st]) / 10, 0), 0)
      : null;
  return { role, position, overall };
}

/** Sides for the 角色王 card tint, and the order the cards are laid out in. */
const RED_ROLES = ['刺客', '莫甘娜', '莫德雷德', '奧伯倫'];
const BLUE_ROLES = ['梅林', '派西維爾', '忠臣'];
/** 角色王 ranks shown per role (owner 2026-11-10: Top 3). */
const ROLE_KING_TOP = 3;
/** 新人榜 rows on the chart (it sits beside 進步榜 Top 5; the text digest keeps DIGEST_NEWCOMERS_SIZE). */
const CHART_NEWCOMERS_SIZE = 5;

/**
 * 角色王 cards: per role the ranks ≤ 3 of `roleTop` (the cache's per-role Top 10 by the same rule as the
 * title — rank = 1 + players with a higher rate, ties share it), holders of a rank on one line. A cache
 * without `roleTop` (before 2026-10-30), or a role missing from it, falls back to the title holders (#1).
 * Red roles first, then blue, then anything else, each in the usual order.
 */
function roleKingEntries(board: LeaderboardBoard | null): WeeklyChartRoleKing[] {
  const holders = roleTitleGroups(board);
  if (!board || holders.length === 0) return [];
  const byRole = new Map<string, WeeklyChartRoleKing>();
  const sideOf = (role: string): WeeklyChartRoleKing['side'] => (RED_ROLES.includes(role) ? 'red' : BLUE_ROLES.includes(role) ? 'blue' : null);
  for (const g of holders) {
    if (byRole.has(g.role)) continue; // a role's holders share one rate: one group
    byRole.set(g.role, { role: g.role, side: sideOf(g.role), ranks: [{ rank: 1, names: g.names, valueLabel: chartPct(g.value) }] });
  }
  for (const [role, rows] of Object.entries(board.roleTop ?? {})) {
    if (!Array.isArray(rows) || rows.length === 0) continue;
    const ranks: WeeklyChartRoleKing['ranks'] = [];
    rows.forEach((row, i) => {
      const rank = typeof row.rank === 'number' ? row.rank : i + 1;
      if (rank > ROLE_KING_TOP) return;
      const same = ranks.find((x) => x.rank === rank);
      if (same) same.names.push(row.name);
      else ranks.push({ rank, names: [row.name], valueLabel: chartPct(row.value) });
    });
    if (ranks.length > 0) byRole.set(role, { role, side: sideOf(role), ranks });
  }
  const order = [...RED_ROLES, ...BLUE_ROLES];
  const pos = (role: string): number => (order.includes(role) ? order.indexOf(role) : order.length);
  return [...byRole.values()].sort((a, b) => pos(a.role) - pos(b.role));
}

/**
 * A theory board (位置理論 / 整體理論) as a Top 10 bar panel: bar = the row's `key` rate (else the board's
 * sort value), title = the cache's title + 「Top N」, qualifier = boardQualifier (period + the note's first
 * clause). null when the cache has no such theory board.
 */
function theoryBoardPanel(
  leaderboard: Parameters<typeof findTheoryBoard>[0],
  id: 'position' | 'overall',
  key: 'positionTheory' | 'overallTheory',
): WeeklyChartBarPanel | null {
  const board = findTheoryBoard(leaderboard, id);
  if (!board) return null;
  const rows = board.rows.slice(0, LEADERBOARD_SIZE).map((r, i) => {
    const own = r[key];
    const value = typeof own === 'number' && Number.isFinite(own) ? own : typeof r.value === 'number' && Number.isFinite(r.value) ? r.value : null;
    return { rank: typeof r.rank === 'number' ? r.rank : i + 1, name: r.name, value, valueLabel: chartPct(value) };
  });
  return { title: columnTitle(`${board.title} Top ${rows.length}`), note: boardQualifier(board) || null, rows };
}

type Metric = 'role' | 'position' | 'overall';
type Tiers = NonNullable<WeeklyChartBarPanel['tiers']>;

/**
 * The chart's reference values (Edward 2026-11-10): 全體 = the whole sample scored as one player and the
 * three Elo-PR tiers' long-term values, both from the cache's rating.theoryBaselines; without it (older
 * cache) 全體 comes from the population formula and there are no tiers.
 */
export function chartBaselines(
  baselines: TheoryBaselines | null | undefined,
  overview: Parameters<typeof populationTheoryAverages>[0],
): { all: Record<Metric, number | null>; tiers: Record<Metric, Tiers> | null } {
  const fallback = populationTheoryAverages(overview);
  const metrics: Metric[] = ['role', 'position', 'overall'];
  const val = (v: unknown): number | null => (finite(v) ? v : null);
  const all = Object.fromEntries(metrics.map((m) => [m, val(baselines?.all?.[m]) ?? fallback[m]])) as Record<Metric, number | null>;
  const t = baselines?.tiers;
  const tiers = t
    ? (Object.fromEntries(
        metrics.map((m) => [m, { high: val(t.pr80plus?.[m]), mid: val(t.pr20to80?.[m]), low: val(t.pr20minus?.[m]) }]),
      ) as Record<Metric, Tiers>)
    : null;
  return { all, tiers };
}

function withBaseline(panel: WeeklyChartBarPanel | null, base: ReturnType<typeof chartBaselines>, metric: Metric): WeeklyChartBarPanel | null {
  return panel ? { ...panel, average: base.all[metric], tiers: base.tiers?.[metric] ?? null } : null;
}

/** "2026-11-09" → "11/9"; null for anything else. */
function shortDate(isoDate: string | null | undefined): string | null {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(isoDate ?? '');
  return m ? `${Number(m[1])}/${Number(m[2])}` : null;
}

/**
 * The Monday digest as chart data (weeklyChart.ts): the text digest's boards — main board Top 10,
 * 進步榜 Top 5, 角色王, 新人榜 — plus 位置理論 and 整體理論 Top 10 (owner 2026-11-10), each only
 * when the cache has it. Throws on cache errors, like the text.
 */
export async function weeklyChartData(now: number = Date.now()): Promise<WeeklyChartData> {
  return rankingChartData({ title: '每週排行', dateLabel: () => digestDateLabel(now) });
}

/** The same chart for /排行: titled 「排行榜」 and dated by the day the boards were computed for. */
export async function leaderboardChartData(now: number = Date.now()): Promise<WeeklyChartData> {
  return rankingChartData({ title: '排行榜', dateLabel: (asOf) => shortDate(asOf) ?? digestDateLabel(now) });
}

async function rankingChartData(opts: { title: string; dateLabel: (asOf: string | null) => string }): Promise<WeeklyChartData> {
  const [overview, leaderboard, rating] = await Promise.all([getOverview(), getLeaderboard(), getRatingBoard().catch(() => null)]);
  const view = selectLeaderboard(leaderboard, overview);
  const head = splitViewTitle(view.title);
  const base = chartBaselines(rating?.theoryBaselines, overview);
  const main: WeeklyChartData['main'] = {
    ...head,
    average: base.all.role,
    tiers: base.tiers?.role ?? null,
    rows: view.rows.map((r) => ({ rank: r.rank, name: r.name, value: r.roleTheory, valueLabel: chartPct(r.roleTheory) })),
    ...(view.emptyNote ? { emptyNote: view.emptyNote.replace(/^（(.*)）$/u, '$1') } : {}),
  };

  const improvedBoard = findBoard(leaderboard, 'improved');
  const improvedRows = improvedLines(improvedBoard).length > 0 && improvedBoard ? improvedBoard.rows.slice(0, DIGEST_IMPROVED_SIZE) : [];
  const improved: WeeklyChartData['improved'] =
    improvedBoard && improvedRows.length > 0
      ? {
          title: `${improvedBoard.title} Top ${improvedRows.length}`,
          note: boardQualifier(improvedBoard) || null,
          rows: improvedRows.map((r, i) => ({
            rank: typeof r.rank === 'number' ? r.rank : i + 1,
            name: r.name,
            value: typeof r.value === 'number' && Number.isFinite(r.value) ? r.value : null,
            valueLabel: chartSigned(r.value),
            detail: `${chartPct(r.priorRoleTheory)} → ${chartPct(r.recentRoleTheory)}`,
          })),
        }
      : null;

  const titlesBoard = findTheoryBoard(leaderboard, 'roleTitles');
  const kings = roleKingEntries(titlesBoard);
  const roleKings: WeeklyChartData['roleKings'] =
    titlesBoard && kings.length > 0
      ? {
          title: kings.some((k) => k.ranks.some((x) => x.rank > 1)) ? `${titlesBoard.title} Top ${ROLE_KING_TOP}` : titlesBoard.title,
          note: titlesBoard.period || null,
          entries: kings,
        }
      : null;

  const newcomersBoard = findBoard(leaderboard, 'newcomers');
  const roleWindows = configRoleWindows(leaderboard?.config, overview?.theoryConfig as Record<string, unknown> | undefined);
  const newcomers: WeeklyChartData['newcomers'] =
    newcomersBoard && newcomersLine(newcomersBoard, undefined, roleWindows)
      ? {
          title: newcomersBoard.title,
          note: newcomersQualifier(newcomersBoard, roleWindows),
          // Newcomers are ranked by 角色理論: the same baselines.
          average: base.all.role,
          tiers: base.tiers?.role ?? null,
          rows: newcomersBoard.rows.slice(0, CHART_NEWCOMERS_SIZE).map((r, i) => {
            const value = typeof r.roleTheory === 'number' && Number.isFinite(r.roleTheory) ? r.roleTheory : r.value;
            const games = typeof r.careerGames === 'number' && Number.isFinite(r.careerGames) ? r.careerGames : r.games;
            return { rank: typeof r.rank === 'number' ? r.rank : i + 1, name: r.name, value, valueLabel: chartPct(value), detail: `${games} 場` };
          }),
        }
      : null;

  const subtitle = [
    leaderboard?.asOf ? `資料至 ${leaderboard.asOf}` : '',
    overview && typeof overview.totalGames === 'number' ? `總計 ${overview.totalGames} 場・${overview.totalPlayers} 位玩家` : '',
  ]
    .filter(Boolean)
    .join('｜');

  return {
    title: opts.title,
    dateLabel: opts.dateLabel(leaderboard?.asOf ?? null),
    subtitle: subtitle || null,
    main,
    position: withBaseline(theoryBoardPanel(leaderboard, 'position', 'positionTheory'), base, 'position'),
    overall: withBaseline(theoryBoardPanel(leaderboard, 'overall', 'overallTheory'), base, 'overall'),
    improved,
    roleKings,
    newcomers,
    footerLines: [`查個人：${STATS_COMMAND_USAGE.player}｜兩人默契：${STATS_COMMAND_USAGE.chemistry}`, '完整圖表與個人戰績（不用登入）'],
    url: STATS_PAGE_URL,
  };
}

/** The Monday digest as one PNG (weeklyChart.ts). Throws on cache or render errors — callers post the text instead. */
export async function weeklyDigestPng(now: number = Date.now()): Promise<Buffer> {
  return renderWeeklyChartPng(await weeklyChartData(now));
}

/** The one line that goes with the picture (Discord message text, LINE follow-up). */
export const WEEKLY_CHART_CAPTION = `🔗 完整圖表與個人戰績（不用登入）：${STATS_PAGE_URL}`;

/** The /排行 chart: `key` identifies its content (same data → same key), so a relay copy can be reused. */
export interface LeaderboardChart {
  key: string;
  png: Buffer;
}

let leaderboardChartCache: LeaderboardChart | null = null;

/**
 * The /排行 chart (leaderboardChartData → PNG), rendered once per distinct data: the key is a
 * hash of the chart data, so a new cache (another asOf, other rows) renders again and repeated
 * /排行 calls in between reuse the PNG (the render is synchronous, so concurrent calls for the
 * same data never render twice). Throws on cache or render errors — callers answer with the text.
 */
export async function leaderboardChart(now: number = Date.now()): Promise<LeaderboardChart> {
  const data = await leaderboardChartData(now);
  const key = crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 32);
  if (leaderboardChartCache?.key !== key) leaderboardChartCache = { key, png: renderWeeklyChartPng(data) };
  return leaderboardChartCache;
}

/** /排行 answers with the chart unless STATS_LEADERBOARD_CHART is false / 0 / off / no (then the text, as before). */
export function leaderboardChartEnabled(): boolean {
  const raw = (process.env.STATS_LEADERBOARD_CHART || '').trim().toLowerCase();
  return !['false', '0', 'off', 'no'].includes(raw);
}

/** Test hook: forget the cached /排行 chart. */
export function __resetLeaderboardChartCacheForTests(): void {
  leaderboardChartCache = null;
}

// ─── /默契 ───────────────────────────────────────────────────────────────

export async function chemistryReply(nameA: string, nameB: string): Promise<string> {
  return safely('chemistry', async () => {
    if (!nameA?.trim() || !nameB?.trim()) {
      return `請輸入兩位玩家，例如「${STATS_COMMAND_USAGE.chemistry}」。`;
    }
    const [chemistry, players, aliases] = await Promise.all([getChemistry(), getAllPlayerStats(), getPlayerAliases()]);
    const roster = chemistryRoster(chemistry);
    const allNames = namesByGames(players);

    const resolve = (query: string): NameMatch | { kind: 'outside'; name: string } => {
      // A player's own name (or the same player's other spelling, or an old name in
      // players.aliases) comes first, as for /戰績: "Nova" is Nova even when only NOVAK is in the
      // matrix — never part of NOVAK's name.
      const own = findTypedPlayerName(query, allNames, undefined, aliases);
      if (own !== undefined) {
        const label = findSamePlayerName(own, roster);
        if (label === undefined) return { kind: 'outside', name: own };
        return { kind: 'found', name: label, caseVariants: [] };
      }
      const inRoster = matchPlayerName(query, roster);
      if (inRoster.kind !== 'none') return inRoster;
      // Not in the matrix — say so explicitly when the player does exist (a
      // "did you mean" within the matrix does not count as a hit).
      const anywhere = matchPlayerName(query, allNames);
      if (anywhere.kind === 'found') return { kind: 'outside', name: anywhere.name };
      return inRoster;
    };

    const a = resolve(nameA);
    const b = resolve(nameB);
    for (const m of [a, b]) {
      if (m.kind === 'outside') return formatNotInChemistry(m.name, roster.length);
      if (m.kind !== 'found') {
        return formatNameProblem(m, {
          usage: STATS_COMMAND_USAGE.chemistry,
          scopeNote: `默契矩陣只收錄場次最多的 ${roster.length} 位玩家。`,
        });
      }
    }
    if (a.kind !== 'found' || b.kind !== 'found') return formatStatsUnavailable(); // unreachable
    if (normalizeName(a.name) === normalizeName(b.name)) return '請輸入兩位「不同」的玩家。';

    // Matrix labels are upper-cased (SIN); show the player-list spelling with
    // the most games instead (Sin), and use its win rate as context.
    const display = (label: string): { name: string; winRate: number | null } => {
      const best = players
        .filter((p) => normalizeName(p.name) === normalizeName(label))
        .sort((x, y) => y.totalGames - x.totalGames)[0];
      return { name: best?.name ?? label, winRate: best?.winRate ?? null };
    };

    return formatChemistry(display(a.name), display(b.name), lookupPair(chemistry, a.name, b.name), roster.length);
  });
}
