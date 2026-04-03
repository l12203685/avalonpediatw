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
 * Algorithm: iterative ELO simulation. Each player's win/loss record is
 * replayed against the population average ELO to derive a final rating.
 * Players with more games and higher win rates will naturally get higher ELO.
 */
function computeEloFromSheets(players: PlayerStats[]): Map<string, { elo: number; stats: PlayerStats }> {
  const result = new Map<string, { elo: number; stats: PlayerStats }>();

  // Phase 1: Initial ELO estimate from win rate (quick convergence seed)
  for (const p of players) {
    if (p.totalGames < 1) continue;
    // Seed: map win rate to an initial ELO range
    // 50% win rate = 1000, each 10% deviation = ~200 ELO points
    const winRateFraction = (p.winRate || 0) / 100;
    const seedElo = Math.round(1000 + (winRateFraction - 0.5) * 400);
    result.set(p.name, { elo: Math.max(100, seedElo), stats: p });
  }

  // Phase 2: Iterative refinement (3 passes)
  // Simulate games against population average to converge ELO
  for (let pass = 0; pass < 3; pass++) {
    const allElos = [...result.values()].map(v => v.elo);
    const populationAvg = allElos.length > 0
      ? allElos.reduce((a, b) => a + b, 0) / allElos.length
      : STARTING_ELO;

    for (const [name, entry] of result) {
      const { stats } = entry;
      let elo = entry.elo;

      // Simulate wins and losses against population average
      const totalWins = Math.round(stats.totalGames * (stats.winRate / 100));
      const totalLosses = stats.totalGames - totalWins;

      // K-factor decreases with more games (established players change slower)
      const kFactor = stats.totalGames >= 100 ? 16 : stats.totalGames >= 50 ? 24 : 32;

      // Apply batch ELO update
      const expected = expectedScore(elo, populationAvg);
      const actualWinRate = totalWins / stats.totalGames;
      // Scale the update by sqrt of games to avoid extreme values
      const gameScale = Math.min(Math.sqrt(stats.totalGames) / 10, 3);
      elo = Math.round(elo + kFactor * gameScale * (actualWinRate - expected));
      elo = Math.max(100, elo);

      result.set(name, { elo, stats });
    }
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

  if (stats.totalGames >= 100) badges.push('百戰老將');
  else if (stats.totalGames >= 50) badges.push('資深玩家');
  else if (stats.totalGames >= 10) badges.push('常客');

  const winRate = (stats.winRate || 0) / 100;
  if (stats.totalGames >= 10 && winRate >= 0.7) badges.push('勝率王');
  if (stats.totalGames >= 10 && winRate >= 0.6) badges.push('穩定發揮');

  if (elo >= 1500) badges.push('傳奇');
  else if (elo >= 1300) badges.push('大師');
  else if (elo >= 1150) badges.push('精英');

  // Role-specific badges from Sheets data
  if (stats.roleWinRates['梅林'] >= 70 && (stats.rawRoleGames['梅林'] || 0) >= 10) badges.push('梅林大師');
  if (stats.roleWinRates['刺客'] >= 70 && (stats.rawRoleGames['刺客'] || 0) >= 10) badges.push('刺客達人');

  return badges;
}

/**
 * Get a single player's profile with recent games.
 */
export async function getFirestoreUserProfile(playerId: string): Promise<UserProfile | null> {
  // Try Firestore first (has per-game history)
  const players = await getAggregated();
  const p = players.get(playerId);
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

  if (p.elo >= 1500) badges.push('傳奇');
  else if (p.elo >= 1300) badges.push('大師');
  else if (p.elo >= 1150) badges.push('精英');

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
