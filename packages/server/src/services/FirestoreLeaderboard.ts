/**
 * FirestoreLeaderboard — compute leaderboard & player profiles.
 *
 * Primary data source: Google Sheets player stats (2145+ games, 60+ players).
 * Fallback: Firestore `games` collection (online games only).
 *
 * elo_rating is the site's only Elo (Edward 2026-10-30「新版把網站上的 ELO 都完全統一成你研發的版本」): the
 * analysis cache's rating section (generate_cache.py compute_rating, the 團隊 Elo replayed over the 牌譜),
 * looked up by the player's name; null for a player without a rated game. The old formulas (sheets: 1000 +
 * win-rate / volume / theory bonuses; Firestore games: team-average K-factor ELO) are gone.
 */

import { getAdminFirestore } from './firebase';
import type { GameRecord } from './GameHistoryRepository';
import { findSamePlayerName, playerNameKey } from '@avalon/shared';
import { getAllPlayerStats, getEloOf, getPlayerAliases, isSheetsReady } from './sheetsAnalysis';
import type { PlayerStats } from './sheetsAnalysis';

// ---------------------------------------------------------------------------
// Types (match the frontend's LeaderboardEntry / UserProfile shapes)
// ---------------------------------------------------------------------------

export interface LeaderboardEntry {
  id: string;
  display_name: string;
  photo_url: string | null;
  provider: string;
  /** The rating section's Elo (rounded); null without a rated game. */
  elo_rating: number | null;
  total_games: number;
  games_won: number;
  games_lost: number;
  badges: string[];
  win_rate: number;
}

export interface RecentGame {
  id: string;
  room_id: string;
  role: string;
  team: 'good' | 'evil';
  won: boolean;
  player_count: number;
  created_at: string;
}

export interface UserProfile {
  id: string;
  display_name: string;
  photo_url: string | null;
  provider: string;
  /** The rating section's Elo (rounded); null without a rated game. */
  elo_rating: number | null;
  total_games: number;
  games_won: number;
  games_lost: number;
  badges: string[];
  recent_games: RecentGame[];
  /** 玩家可見短碼；新用戶註冊生成，舊用戶可能為 null */
  short_code?: string | null;
}

// ---------------------------------------------------------------------------
// Internal aggregation types
// ---------------------------------------------------------------------------

interface PlayerAgg {
  id: string;
  displayName: string;
  totalGames: number;
  gamesWon: number;
  gamesLost: number;
  /** Per-game snapshots for recent_games */
  gameHistory: {
    gameId: string;
    role: string;
    team: 'good' | 'evil';
    won: boolean;
    playerCount: number;
    createdAt: number;
  }[];
}

/**
 * Minimum games required to appear on the public leaderboard list.
 *
 * Edward 2026-04-26 16:05：raw 牌譜 rebuild 把實際 distinct 玩家從 62 拉到 198 後，
 * top-N 被一群 1-3 場 100% 勝率玩家佔走 — 小樣本不抗噪。20 場是
 * 統計意義 floor（與 deriveBadgesFromStats 內 `穩定發揮 / 勝率王` 的 10 場
 * 觸發分開：badge 仍可早觸發，上榜門檻較嚴）。
 *
 * 影響範圍 — **僅限 leaderboard 上榜列表**：
 *   - getSheetsLeaderboard / getFirestoreLeaderboard fallback 過濾
 *   - 不影響 getFirestoreUserProfile（個別玩家可從 search/profile 看完整 stats）
 *   - 不影響 analytics aggregate（baseline 需所有玩家貢獻）
 *   - 不影響 findPlayerByName（搜尋仍可找到 <20 場玩家）
 */
const MIN_LEADERBOARD_GAMES = 20;

// ---------------------------------------------------------------------------
// Core: load all games and aggregate
// ---------------------------------------------------------------------------

/**
 * Load every document from `games` collection, sorted by createdAt ascending,
 * and compute per-player win / loss stats (no rating: the site's Elo comes from the analysis cache).
 */
async function aggregatePlayerStats(): Promise<Map<string, PlayerAgg>> {
  const firestore = getAdminFirestore();
  const snapshot = await firestore
    .collection('games')
    .orderBy('createdAt', 'asc')
    .get();

  const players = new Map<string, PlayerAgg>();

  for (const doc of snapshot.docs) {
    const game = doc.data() as GameRecord;
    if (!game.players || game.players.length === 0) continue;

    // Edward 2026-04-28：含 AI 玩家的局 / host 勾選的娛樂局不算勝率。
    // 與 V2 路徑 (`filterRankedGames` in shared/derived/gameMetrics) 對齊：
    // 嚴格 `=== true` 比較 → 舊 V1 row 沒這兩個 field (undefined) 仍視為 ranked，
    // 維持歷史戰績不漏。
    if (game.hasAI === true || game.casual === true) continue;

    // Ensure every player has an entry
    for (const p of game.players) {
      if (!p.playerId) continue;
      if (!players.has(p.playerId)) {
        players.set(p.playerId, {
          id: p.playerId,
          displayName: p.displayName || p.playerId,
          totalGames: 0,
          gamesWon: 0,
          gamesLost: 0,
          gameHistory: [],
        });
      }
    }

    // Update each player
    for (const p of game.players) {
      if (!p.playerId) continue;
      const agg = players.get(p.playerId)!;
      const won = p.won;

      agg.totalGames += 1;
      if (won) agg.gamesWon += 1;
      else agg.gamesLost += 1;

      // Keep display name fresh (latest game wins)
      if (p.displayName) agg.displayName = p.displayName;

      agg.gameHistory.push({
        gameId: game.gameId || doc.id,
        role: p.role ?? 'unknown',
        team: p.team ?? 'good',
        won,
        playerCount: game.playerCount,
        createdAt: game.createdAt,
      });
    }
  }

  return players;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

let _cache: { data: Map<string, PlayerAgg>; ts: number } | null = null;
const CACHE_TTL_MS = 3_600_000; // 1 hour (T6: reduce Spark daily reads — invalidated on game write)

async function getAggregated(): Promise<Map<string, PlayerAgg>> {
  const now = Date.now();
  if (_cache && now - _cache.ts < CACHE_TTL_MS) {
    return _cache.data;
  }
  const data = await aggregatePlayerStats();
  _cache = { data, ts: now };
  return data;
}

/** Invalidate cached stats (call after a new game is saved). */
export function invalidateLeaderboardCache(): void {
  _cache = null;
}

/**
 * Get leaderboard: all players with >= MIN_LEADERBOARD_GAMES games, sorted by Elo
 * (the analysis cache's rating section; players without one last, then by games).
 * A cap of 10000 is applied as a safety net; realistic populations are ~300-500 players.
 *
 * Strategy:
 *   1. Try Google Sheets player stats (primary source, 2145+ games).
 *   2. Fall back to Firestore games collection (online games only).
 */
export async function getFirestoreLeaderboard(limit = 10000): Promise<LeaderboardEntry[]> {
  // Try Sheets-based leaderboard first (has the most data)
  const sheetsBoard = await getSheetsLeaderboard(limit);
  if (sheetsBoard.length > 0) {
    return sheetsBoard;
  }

  // Fallback: Firestore games collection
  const players = await getAggregated();

  const entries: LeaderboardEntry[] = [];
  for (const p of players.values()) {
    if (p.totalGames < MIN_LEADERBOARD_GAMES) continue;
    entries.push({
      id: p.id,
      display_name: p.displayName,
      photo_url: null,
      provider: 'guest',
      elo_rating: await eloRating(p.displayName),
      total_games: p.totalGames,
      games_won: p.gamesWon,
      games_lost: p.gamesLost,
      badges: deriveBadges(p),
      win_rate: p.totalGames > 0 ? Math.round((p.gamesWon / p.totalGames) * 100) : 0,
    });
  }
  return sortByElo(entries).slice(0, limit);
}

/** The site's Elo of `name` (analysis cache rating section), rounded; null without one or without the cache. */
async function eloRating(name: string): Promise<number | null> {
  try {
    const row = await getEloOf(name);
    return row ? Math.round(row.elo) : null;
  } catch {
    return null;
  }
}

/** Highest Elo first; players without an Elo after them, most games first. */
function sortByElo(entries: LeaderboardEntry[]): LeaderboardEntry[] {
  return entries.sort((a, b) =>
    (b.elo_rating ?? -Infinity) - (a.elo_rating ?? -Infinity) || b.total_games - a.total_games);
}

/**
 * Get leaderboard from Google Sheets player stats.
 * This is the primary leaderboard source since it contains 2145+ games of history.
 *
 * Returns every player with >= `MIN_LEADERBOARD_GAMES` recorded games (capped by
 * `limit`, default effectively unlimited).
 *
 * Edward 2026-04-26 16:05：上榜門檻設 20 場 — raw 牌譜 rebuild 後 198 玩家入池，
 * top-N 被 1-3 場 100% 勝率小樣本玩家佔走，加 20 場 floor 才有統計意義。
 * 個別玩家 stats 仍可從 search/profile 看（getFirestoreUserProfile 不過濾）。
 */
async function getSheetsLeaderboard(limit: number): Promise<LeaderboardEntry[]> {
  if (!isSheetsReady()) return [];

  try {
    const sheetsPlayers = await getAllPlayerStats();
    if (sheetsPlayers.length === 0) return [];

    const entries: LeaderboardEntry[] = [];
    for (const stats of sheetsPlayers) {
      // Edward 2026-04-26 16:05: 上榜門檻 — < 20 場不上榜（避免小樣本 100% 勝率玩家浮榜）
      if (stats.totalGames < MIN_LEADERBOARD_GAMES) continue;
      const name = stats.name;

      const totalWins = Math.round(stats.totalGames * (stats.winRate / 100));
      const totalLosses = stats.totalGames - totalWins;
      entries.push({
        id: name,
        display_name: name,
        photo_url: null,
        provider: 'sheets',
        elo_rating: await eloRating(name),
        total_games: stats.totalGames,
        games_won: totalWins,
        games_lost: totalLosses,
        badges: deriveBadgesFromStats(stats),
        win_rate: Math.round(stats.winRate),
      });
    }

    return sortByElo(entries).slice(0, limit);
  } catch (err) {
    console.error(JSON.stringify({
      timestamp: new Date().toISOString(),
      event: 'sheets_leaderboard_error',
      error: err instanceof Error ? err.message : 'Unknown',
    }));
    return [];
  }
}

function deriveBadgesFromStats(stats: PlayerStats): string[] {
  const badges: string[] = [];

  // Experience badges
  if (stats.totalGames >= 500) badges.push('千錘百鍊');
  else if (stats.totalGames >= 100) badges.push('百戰老將');
  else if (stats.totalGames >= 50) badges.push('資深玩家');
  else if (stats.totalGames >= 10) badges.push('常客');

  // Win rate badges
  const winRate = (stats.winRate || 0) / 100;
  if (stats.totalGames >= 10 && winRate >= 0.7) badges.push('勝率王');
  else if (stats.totalGames >= 10 && winRate >= 0.6) badges.push('穩定發揮');

  // Role-specific badges from Sheets data.
  // Canonical role names only (cache has been migrated to the full names).
  const roleWr = (role: string): number => stats.roleWinRates[role] ?? 0;
  const roleGames = (role: string): number => stats.rawRoleGames[role] ?? 0;

  if (roleWr('梅林') >= 70 && roleGames('梅林') >= 10) badges.push('梅林大師');
  if (roleWr('刺客') >= 70 && roleGames('刺客') >= 10) badges.push('刺客達人');
  if (roleWr('派西維爾') >= 70 && roleGames('派西維爾') >= 10) badges.push('派西維爾專家');
  if (roleWr('莫甘娜') >= 70 && roleGames('莫甘娜') >= 10) badges.push('莫甘娜達人');
  if (roleWr('莫德雷德') >= 70 && roleGames('莫德雷德') >= 10) badges.push('莫德雷德達人');
  if (roleWr('奧伯倫') >= 70 && roleGames('奧伯倫') >= 10) badges.push('奧伯倫達人');

  return badges;
}

/**
 * Get a single player's profile with recent games.
 *
 * Lookup priority (aligned with `getFirestoreLeaderboard` which is Sheets-first):
 *   1. Sheets player stats (primary — matches leaderboard list IDs, avoids
 *      Firestore playerId collision pollution where guest records share keys)
 *   2. Best-effort enrichment: if a Firestore aggregated player has the same
 *      displayName as the Sheets entry, merge its per-game `recent_games`
 *   3. Firestore aggregated map (fallback — only when Sheets has no entry;
 *      preserves profile access for Firestore-only players)
 */
export async function getFirestoreUserProfile(playerId: string): Promise<UserProfile | null> {
  // 1. Try Sheets first (leaderboard list is Sheets-first; IDs are display names)
  if (isSheetsReady()) {
    try {
      const sheetsPlayers = await getAllPlayerStats();
      const statsByName = new Map(sheetsPlayers.filter(p => p.totalGames >= 1).map(p => [p.name, p] as const));
      // Sheets names ignore case / width (@avalon/shared findSamePlayerName, the stats API's
      // lookup): "nova" finds the cache's "Nova", "(Nova)" or "@Nova" does not; most games first
      // among an old cache's spellings; an old name in players.aliases finds the official name.
      const sheetName = statsByName.has(playerId)
        ? playerId
        : findSamePlayerName(playerId, [...statsByName.keys()], (name) => statsByName.get(name)?.totalGames ?? 0,
          await getPlayerAliases());
      const stats = sheetName === undefined ? undefined : statsByName.get(sheetName);
      if (sheetName !== undefined && stats) {
        const totalWins = Math.round(stats.totalGames * (stats.winRate / 100));
        const totalLosses = stats.totalGames - totalWins;

        // 2. Best-effort enrichment: pull recent_games from Firestore if a
        //    matching displayName exists. If merge causes issues later, this
        //    block is the place to gate behind a feature flag.
        // TODO: resolve displayName collisions across Firestore aggregated map
        //       (currently picks the first match which may still be a polluted
        //       guest record — safe because we only borrow its gameHistory
        //       recency, not its stats).
        let recent: RecentGame[] = [];
        try {
          const players = await getAggregated();
          const wanted = playerNameKey(sheetName);
          for (const [, candidate] of players) {
            if (playerNameKey(candidate.displayName) === wanted) {
              recent = candidate.gameHistory
                .slice(-20)
                .reverse()
                .map(g => ({
                  id: g.gameId,
                  room_id: g.gameId,
                  role: g.role,
                  team: g.team,
                  won: g.won,
                  player_count: g.playerCount,
                  created_at: new Date(g.createdAt).toISOString(),
                }));
              break;
            }
          }
        } catch {
          // Firestore unavailable — leave recent_games empty, still return Sheets profile
        }

        return {
          id: sheetName,
          display_name: sheetName,
          photo_url: null,
          provider: 'sheets',
          elo_rating: await eloRating(sheetName),
          total_games: stats.totalGames,
          games_won: totalWins,
          games_lost: totalLosses,
          badges: deriveBadgesFromStats(stats),
          recent_games: recent,
        };
      }
    } catch {
      // Sheets not available — fall through to Firestore
    }
  }

  // 3. Fallback: Firestore aggregated (per-game history available)
  const players = await getAggregated();
  let p = players.get(playerId);

  // Fallback: search by display name (JWT sub may differ from Firestore playerId)
  if (!p) {
    const lower = playerId.toLowerCase();
    for (const [, candidate] of players) {
      if (candidate.displayName.toLowerCase() === lower) {
        p = candidate;
        break;
      }
    }
  }
  if (p) {
    const recent = p.gameHistory
      .slice(-20)
      .reverse()
      .map(g => ({
        id: g.gameId,
        room_id: g.gameId,
        role: g.role,
        team: g.team,
        won: g.won,
        player_count: g.playerCount,
        created_at: new Date(g.createdAt).toISOString(),
      }));

    return {
      id: p.id,
      display_name: p.displayName,
      photo_url: null,
      provider: 'guest',
      elo_rating: await eloRating(p.displayName),
      total_games: p.totalGames,
      games_won: p.gamesWon,
      games_lost: p.gamesLost,
      badges: deriveBadges(p),
      recent_games: recent,
    };
  }

  return null;
}

/**
 * Search for a player by display name (partial match).
 * Returns the playerId if found.
 */
export async function findPlayerByName(name: string): Promise<string | null> {
  const lower = name.toLowerCase();

  // Check Firestore first
  const players = await getAggregated();
  for (const [id, p] of players) {
    if (p.displayName.toLowerCase() === lower) return id;
  }
  for (const [id, p] of players) {
    if (p.displayName.toLowerCase().includes(lower)) return id;
  }

  // Check Sheets data
  if (isSheetsReady()) {
    try {
      const sheetsPlayers = await getAllPlayerStats();
      const names = sheetsPlayers.map((sp) => sp.name);
      const same = findSamePlayerName(name, names, undefined, await getPlayerAliases());
      if (same !== undefined) return same;
      const wanted = playerNameKey(name);
      for (const sp of sheetsPlayers) {
        if (wanted && playerNameKey(sp.name).includes(wanted)) return sp.name;
      }
    } catch {
      // Sheets not available
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Badge derivation
// ---------------------------------------------------------------------------

function deriveBadges(p: PlayerAgg): string[] {
  const badges: string[] = [];

  if (p.totalGames >= 100) badges.push('百戰老將');
  else if (p.totalGames >= 50) badges.push('資深玩家');
  else if (p.totalGames >= 10) badges.push('常客');

  const winRate = p.totalGames > 0 ? p.gamesWon / p.totalGames : 0;
  if (p.totalGames >= 10 && winRate >= 0.7) badges.push('勝率王');
  if (p.totalGames >= 10 && winRate >= 0.6) badges.push('穩定發揮');

  // Streak detection
  const history = p.gameHistory;
  let currentStreak = 0;
  let maxStreak = 0;
  for (const g of history) {
    if (g.won) {
      currentStreak++;
      maxStreak = Math.max(maxStreak, currentStreak);
    } else {
      currentStreak = 0;
    }
  }
  if (maxStreak >= 10) badges.push('十連勝');
  else if (maxStreak >= 5) badges.push('五連勝');

  return badges;
}
