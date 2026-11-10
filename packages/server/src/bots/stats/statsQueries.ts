/**
 * Stats queries — reads analysis_cache.json through the existing
 * services/sheetsAnalysis.ts accessors (never re-parses the file) and hands
 * the data to the pure formatters in statsReplies.ts. Shared by the Discord
 * slash commands, the LINE text commands and the weekly digest.
 *
 * Every function resolves to a ready-to-send string and never throws: a
 * missing / unreadable cache becomes a short "暫時讀不到" reply.
 */

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
} from '../../services/sheetsAnalysis';
import type { PlayerStats } from '../../services/sheetsAnalysis';
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
  improvedLines,
  leaderboardScope,
  lookupPair,
  matchPlayerName,
  newcomersLine,
  newcomersQualifier,
  normalizeName,
  pct,
  roleTitleGroups,
  roleTitlesLine,
  selectLeaderboard,
  signed,
} from './statsReplies';
import { digestDateLabel } from './weeklyDigest';
import { renderWeeklyChartPng, stripLeadingEmoji, type WeeklyChartData } from './weeklyChart';

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
  return m ? { title: m[1].trim(), note: m[2].trim() || null } : { title: bare, note: null };
}

/**
 * The Monday digest as chart data (weeklyChart.ts): the same boards and order as
 * weeklyDigestText — main board Top 10, 進步榜 Top 5, 角色王, 新人榜 (each only
 * when the cache has it). Throws on cache errors, like the text.
 */
export async function weeklyChartData(now: number = Date.now()): Promise<WeeklyChartData> {
  const [overview, leaderboard] = await Promise.all([getOverview(), getLeaderboard()]);
  const view = selectLeaderboard(leaderboard, overview);
  const head = splitViewTitle(view.title);
  const main: WeeklyChartData['main'] = {
    ...head,
    rows: view.rows.map((r) => ({ rank: r.rank, name: r.name, value: r.roleTheory, valueLabel: pct(r.roleTheory) })),
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
            valueLabel: signed(r.value),
            detail: `${pct(r.priorRoleTheory)} → ${pct(r.recentRoleTheory)}`,
          })),
        }
      : null;

  const titlesBoard = findBoard(leaderboard, 'roleTitles');
  const groups = roleTitleGroups(titlesBoard);
  const roleKings: WeeklyChartData['roleKings'] =
    titlesBoard && groups.length > 0
      ? {
          title: titlesBoard.title,
          note: titlesBoard.period || null,
          entries: groups.map((g) => ({
            role: g.role,
            names: g.names,
            valueLabel: pct(g.value),
          })),
        }
      : null;

  const newcomersBoard = findBoard(leaderboard, 'newcomers');
  const roleWindows = configRoleWindows(leaderboard?.config, overview?.theoryConfig as Record<string, unknown> | undefined);
  const newcomers: WeeklyChartData['newcomers'] =
    newcomersBoard && newcomersLine(newcomersBoard, undefined, roleWindows)
      ? {
          title: newcomersBoard.title,
          note: newcomersQualifier(newcomersBoard, roleWindows),
          rows: newcomersBoard.rows.slice(0, DIGEST_NEWCOMERS_SIZE).map((r, i) => {
            const value = typeof r.roleTheory === 'number' && Number.isFinite(r.roleTheory) ? r.roleTheory : r.value;
            const games = typeof r.careerGames === 'number' && Number.isFinite(r.careerGames) ? r.careerGames : r.games;
            return { rank: typeof r.rank === 'number' ? r.rank : i + 1, name: r.name, value, valueLabel: pct(value), detail: `${games} 場` };
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
    dateLabel: digestDateLabel(now),
    subtitle: subtitle || null,
    main,
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
