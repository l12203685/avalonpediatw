/**
 * FirestoreLeaderboard — compute leaderboard & player profiles.
 *
 * Primary data source: Google Sheets player stats (2145+ games, 60+ players).
 * Fallback: Firestore `games` collection (online games only).
 *
 * ELO is derived from aggregate win/loss records using a simplified model:
 * players start at 1000 and are adjusted based on win rate and game volume
 * relative to the population average.
 */

import { getAdminFirestore } from './firebase';
import { computeNewElo, expectedScore } from './EloRanking';
import type { GameRecord, GamePlayerRecord } from './GameHistoryRepository';
import { getAllPlayerStats, isSheetsReady } from './sheetsAnalysis';
import type { PlayerStats } from './sheetsAnalysis';

// ---------------------------------------------------------------------------
// Types (match the frontend's LeaderboardEntry / UserProfile shapes)
// ---------------------------------------------------------------------------

export interface LeaderboardEntry {
  id: string;
  display_name: string;
  photo_url: string | null;
  provider: string;
  elo_rating: number;
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
  elo_delta: number;
  player_count: number;
  created_at: string;
}

export interface UserProfile {
  id: string;
  display_name: string;
  photo_url: string | null;
  provider: string;
  elo_rating: number;
  total_games: number;
  games_won: number;
  games_lost: number;
  badges: string[];
  recent_games: RecentGame[];
}

// ---------------------------------------------------------------------------
// Internal aggregation types
// ---------------------------------------------------------------------------

interface PlayerAgg {
  id: string;
  displayName: string;
  elo: number;
  totalGames: number;
  gamesWon: number;
  gamesLost: number;
  /** Per-game snapshots for recent_games & ELO history */
  gameHistory: {
    gameId: string;
    role: string;
    team: 'good' | 'evil';
    won: boolean;
    eloBefore: number;
    eloAfter: number;
    playerCount: number;
    createdAt: number;
  }[];
}

const STARTING_ELO = 1000;

// ---------------------------------------------------------------------------
// Core: load all games and aggregate
// ---------------------------------------------------------------------------

/**
 * Load every document from `games` collection, sorted by createdAt ascending,
 * and compute per-player stats including ELO progression.
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

    // Ensure every player has an entry
    for (const p of game.players) {
      if (!p.playerId) continue;
      if (!players.has(p.playerId)) {
        players.set(p.playerId, {
          id: p.playerId,
          displayName: p.displayName || p.playerId,
          elo: STARTING_ELO,
          totalGames: 0,
          gamesWon: 0,
          gamesLost: 0,
          gameHistory: [],
        });
      }
    }

    // Compute team average ELOs before this game
    const goodElos: number[] = [];
    const evilElos: number[] = [];
    for (const p of game.players) {
      if (!p.playerId) continue;
      const agg = players.get(p.playerId)!;
      if (p.team === 'good') goodElos.push(agg.elo);
      else if (p.team === 'evil') evilElos.push(agg.elo);
      // If team is null (imported data without role info), skip ELO calc
    }

    const goodAvg = goodElos.length > 0
      ? goodElos.reduce((a, b) => a + b, 0) / goodElos.length
      : STARTING_ELO;
    const evilAvg = evilElos.length > 0
      ? evilElos.reduce((a, b) => a + b, 0) / evilElos.length
      : STARTING_ELO;

    // Update each player
    for (const p of game.players) {
      if (!p.playerId) continue;
      const agg = players.get(p.playerId)!;
      const eloBefore = agg.elo;

      // Determine if player won
      const won = p.won;

      // Only compute ELO delta if we know the team
      let eloAfter = eloBefore;
      if (p.team === 'good' || p.team === 'evil') {
        const opponentAvg = p.team === 'good' ? evilAvg : goodAvg;
        eloAfter = computeNewElo(eloBefore, won, opponentAvg, p.role ?? null);
      }

      agg.elo = eloAfter;
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
        eloBefore,
        eloAfter,
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
const CACHE_TTL_MS = 60_000; // 1 minute

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
 * Get leaderboard: top N players sorted by ELO descending.
 *
 * Strategy:
 *   1. Try Google Sheets player stats (primary source, 2145+ games).
 *   2. Fall back to Firestore games collection (online games only).
 */
export async function getFirestoreLeaderboard(limit = 50): Promise<LeaderboardEntry[]> {
  // Try Sheets-based leaderboard first (has the most data)
  const sheetsBoard = await getSheetsLeaderboard(limit);
  if (sheetsBoard.length > 0) {
    return sheetsBoard;
  }

  // Fallback: Firestore games collection
  const players = await getAggregated();

  const sorted = [...players.values()]
    .filter(p => p.totalGames >= 1)
    .sort((a, b) => b.elo - a.elo)
    .slice(0, limit);

  return sorted.map(p => ({
    id: p.id,
    display_name: p.displayName,
    photo_url: null,
    provider: 'guest',
    elo_rating: p.elo,
    total_games: p.totalGames,
    games_won: p.gamesWon,
    games_lost: p.gamesLost,
    badges: deriveBadges(p),
    win_rate: p.totalGames > 0 ? Math.round((p.gamesWon / p.totalGames) * 100) : 0,
  }));
}

// ---------------------------------------------------------------------------
// Sheets-based ELO computation
// ---------------------------------------------------------------------------

/**
 * Compute ELO ratings from Google Sheets aggregate player stats.
 *
 * Algorithm: two-factor composite scoring.
 *   1. Win rate contribution (dominant factor) -- maps win rate to a wide ELO
 *      range using a linear scale centered at 1000.
 *   2. Volume bonus -- players with more games get a small ELO bump to reward
 *      experience and statistical significance.
 *   3. Role theory bonus -- higher roleTheory (theoretical win rate based on
 *      role composition) gives a small additional bump.
 *
 * This produces an ELO spread of roughly 750-1500, matching the frontend
 * tier system (菜雞 <30 games, 初學 ≥0, 新手 ≥950, 中堅 ≥1050, 高手 ≥1150, 大師 ≥1300).
 * LeaderboardPage re-ranks by percentile (15/25/30/25/15) at render time.
 */
function computeEloFromSheets(players: PlayerStats[]): Map<string, { elo: number; stats: PlayerStats }> {
  const result = new Map<string, { elo: number; stats: PlayerStats }>();

  // Find max games for normalization
  let maxGames = 1;
  for (const p of players) {
    if (p.totalGames > maxGames) maxGames = p.totalGames;
  }

  for (const p of players) {
    if (p.totalGames < 1) continue;

    const winRateFraction = (p.winRate || 0) / 100;

    // Win rate contribution: 50% -> 1000, spread +/- 500
    // A 55% win rate player = 1050, 60% = 1100, etc.
    const winRateElo = 1000 + (winRateFraction - 0.5) * 1000;

    // Volume bonus: up to +150 for the most experienced player
    // Uses log scale so early games matter more
    const volumeBonus = Math.min(
      Math.log2(Math.max(p.totalGames, 1)) / Math.log2(maxGames) * 150,
      150,
    );

    // Role theory bonus: theoretical win rate above average gives +0..100
    const roleTheoryFraction = (p.roleTheory || 50) / 100;
    const theoryBonus = (roleTheoryFraction - 0.5) * 200;

    // Minimum 10 games for reliable rating; penalize low-game players
    const reliabilityFactor = Math.min(p.totalGames / 30, 1);

    let elo = winRateElo + (volumeBonus + theoryBonus) * reliabilityFactor;
    elo = Math.max(100, Math.round(elo));

    result.set(p.name, { elo, stats: p });
  }

  return result;
}

/**
 * Get leaderboard from Google Sheets player stats.
 * This is the primary leaderboard source since it contains 2145+ games of history.
 */
async function getSheetsLeaderboard(limit: number): Promise<LeaderboardEntry[]> {
  if (!isSheetsReady()) return [];

  try {
    const sheetsPlayers = await getAllPlayerStats();
    if (sheetsPlayers.length === 0) return [];

    const eloMap = computeEloFromSheets(sheetsPlayers);

    const entries: LeaderboardEntry[] = [];
    for (const [name, { elo, stats }] of eloMap) {
      const totalWins = Math.round(stats.totalGames * (stats.winRate / 100));
      const totalLosses = stats.totalGames - totalWins;
      entries.push({
        id: name,
        display_name: name,
        photo_url: null,
        provider: 'sheets',
        elo_rating: elo,
        total_games: stats.totalGames,
        games_won: totalWins,
        games_lost: totalLosses,
        badges: deriveBadgesFromStats(stats, elo),
        win_rate: Math.round(stats.winRate),
      });
    }

    entries.sort((a, b) => b.elo_rating - a.elo_rating);
    return entries.slice(0, limit);
  } catch (err) {
    console.error(JSON.stringify({
      timestamp: new Date().toISOString(),
      event: 'sheets_leaderboard_error',
      error: err instanceof Error ? err.message : 'Unknown',
    }));
    return [];
  }
}

function deriveBadgesFromStats(stats: PlayerStats, elo: number): string[] {
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

  // ELO tier badges (thresholds match frontend eloRank.ts)
  if (elo >= 1300) badges.push('大師');
  else if (elo >= 1150) badges.push('高手');
  else if (elo >= 1050) badges.push('中堅');
  else if (elo >= 950) badges.push('新手');

  // Role-specific badges from Sheets data
  if (stats.roleWinRates['梅林'] >= 70 && (stats.rawRoleGames['梅林'] || 0) >= 10) badges.push('梅林大師');
  if (stats.roleWinRates['刺客'] >= 70 && (stats.rawRoleGames['刺客'] || 0) >= 10) badges.push('刺客達人');
  if (stats.roleWinRates['派西'] >= 70 && (stats.rawRoleGames['派西'] || 0) >= 10) badges.push('派西專家');
  if (stats.roleWinRates['娜美'] >= 70 && (stats.rawRoleGames['娜美'] || 0) >= 10) badges.push('娜美達人');

  return badges;
}

/**
 * Get a single player's profile with recent games.
 */
export async function getFirestoreUserProfile(playerId: string): Promise<UserProfile | null> {
  // Try Firestore first (has per-game history)
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
        elo_delta: g.eloAfter - g.eloBefore,
        player_count: g.playerCount,
        created_at: new Date(g.createdAt).toISOString(),
      }));

    return {
      id: p.id,
      display_name: p.displayName,
      photo_url: null,
      provider: 'guest',
      elo_rating: p.elo,
      total_games: p.totalGames,
      games_won: p.gamesWon,
      games_lost: p.gamesLost,
      badges: deriveBadges(p),
      recent_games: recent,
    };
  }

  // Fallback: Sheets-based profile (no per-game history available)
  if (isSheetsReady()) {
    try {
      const sheetsPlayers = await getAllPlayerStats();
      const eloMap = computeEloFromSheets(sheetsPlayers);
      const entry = eloMap.get(playerId);
      if (entry) {
        const { elo, stats } = entry;
        const totalWins = Math.round(stats.totalGames * (stats.winRate / 100));
        const totalLosses = stats.totalGames - totalWins;
        return {
          id: playerId,
          display_name: playerId,
          photo_url: null,
          provider: 'sheets',
          elo_rating: elo,
          total_games: stats.totalGames,
          games_won: totalWins,
          games_lost: totalLosses,
          badges: deriveBadgesFromStats(stats, elo),
          recent_games: [],
        };
      }
    } catch {
      // Sheets not available
    }
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
      for (const sp of sheetsPlayers) {
        if (sp.name.toLowerCase() === lower) return sp.name;
      }
      for (const sp of sheetsPlayers) {
        if (sp.name.toLowerCase().includes(lower)) return sp.name;
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

  if (p.elo >= 1300) badges.push('大師');
  else if (p.elo >= 1150) badges.push('高手');
  else if (p.elo >= 1050) badges.push('中堅');

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
