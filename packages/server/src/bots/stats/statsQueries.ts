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
  getPlayerArchetype,
  getPlayerByName,
  getPlayerPlaystyle,
  getPlayerStrength,
} from '../../services/sheetsAnalysis';
import type { PlayerStats } from '../../services/sheetsAnalysis';
import type { NameMatch } from './statsReplies';
import {
  STATS_COMMAND_USAGE,
  chemistryRoster,
  findBoard,
  findSamePlayerName,
  findTypedPlayerName,
  formatChemistry,
  formatLeaderboard,
  formatNameProblem,
  formatNotInChemistry,
  formatPlayerCard,
  formatStatsUnavailable,
  improvedLines,
  lookupPair,
  matchPlayerName,
  newcomersLine,
  normalizeName,
  roleTitlesLine,
  selectLeaderboard,
} from './statsReplies';
import { digestDateLabel } from './weeklyDigest';

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
    const players = await getAllPlayerStats();
    const match = matchPlayerName(query, namesByGames(players));
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
    return formatPlayerCard({
      player,
      archetype: archetype ? { data: archetype.data, axisLabels: archetype.axisLabels } : null,
      strength: strength?.data ?? null,
      playstyle: playstyle ? { data: playstyle.data, labels: playstyle.labels } : null,
      caseVariants: match.caseVariants,
      minCellGames: typeof minCell === 'number' ? minCell : undefined,
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
    const newcomers = newcomersLine(findBoard(leaderboard, 'newcomers'));
    if (newcomers) sections.push([newcomers]);
  }
  return formatLeaderboard(overview, main, { header: opts.header, sections, footerLines: opts.footerLines });
}

export async function leaderboardReply(): Promise<string> {
  return safely('leaderboard', () => leaderboardText());
}

/**
 * Monday digest: dated header, main board Top 10 (角色理論, 各人最近 100 場),
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

// ─── /默契 ───────────────────────────────────────────────────────────────

export async function chemistryReply(nameA: string, nameB: string): Promise<string> {
  return safely('chemistry', async () => {
    if (!nameA?.trim() || !nameB?.trim()) {
      return `請輸入兩位玩家，例如「${STATS_COMMAND_USAGE.chemistry}」。`;
    }
    const [chemistry, players] = await Promise.all([getChemistry(), getAllPlayerStats()]);
    const roster = chemistryRoster(chemistry);
    const allNames = namesByGames(players);

    const resolve = (query: string): NameMatch | { kind: 'outside'; name: string } => {
      // A player's own name (or the same player's other spelling) comes first, as for /戰績:
      // "Nova" is Nova even when only NOVAK is in the matrix — never part of NOVAK's name.
      const own = findTypedPlayerName(query, allNames);
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
