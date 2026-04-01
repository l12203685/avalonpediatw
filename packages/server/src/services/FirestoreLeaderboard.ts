/**
 * FirestoreLeaderboard — compute leaderboard & player profiles from Firestore games collection.
 *
 * Replaces the Supabase-backed leaderboard. Reads all documents from `games/{gameId}`,
 * aggregates per-player win/loss/ELO stats, and returns sorted results.
 *
 * ELO is computed from scratch on each call using the same algorithm as EloRanking.ts.
 * For production scale, consider caching or materialising stats into a `player_stats` collection.
 */

import { getAdminFirestore } from './firebase';
import { computeNewElo, expectedScore } from './EloRanking';
import type { GameRecord, GamePlayerRecord } from './GameHistoryRepository';

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
 * Only includes players with at least 1 game.
 */
export async function getFirestoreLeaderboard(limit = 50): Promise<LeaderboardEntry[]> {
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

/**
 * Get a single player's profile with recent games.
 */
export async function getFirestoreUserProfile(playerId: string): Promise<UserProfile | null> {
  const players = await getAggregated();
  const p = players.get(playerId);
  if (!p) return null;

  // Most recent 20 games, newest first
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

/**
 * Search for a player by display name (partial match).
 * Returns the playerId if found.
 */
export async function findPlayerByName(name: string): Promise<string | null> {
  const players = await getAggregated();
  const lower = name.toLowerCase();
  for (const [id, p] of players) {
    if (p.displayName.toLowerCase() === lower) return id;
  }
  // Partial match fallback
  for (const [id, p] of players) {
    if (p.displayName.toLowerCase().includes(lower)) return id;
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
