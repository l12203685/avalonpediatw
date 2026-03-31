import { Role } from '@avalon/shared';
import { getAdminDB } from './firebase';
import { GameRecord, GamePlayerRecord } from './GameHistoryRepository';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_K_FACTOR = 32;
const STARTING_ELO = 1000;
const MIN_ELO = 100;

/**
 * Role weight multipliers for K-factor adjustment.
 * Higher-stakes roles (Merlin, Assassin) get a larger K-factor
 * because their individual performance has outsized game impact.
 */
const ROLE_K_WEIGHTS: Record<Role, number> = {
  merlin: 1.5,
  assassin: 1.5,
  percival: 1.2,
  morgana: 1.2,
  oberon: 1.1,
  loyal: 1.0,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EloEntry {
  uid: string;
  displayName: string;
  eloRating: number;
  totalGames: number;
  gamesWon: number;
  gamesLost: number;
  winRate: number;
  lastGameAt: number;
  updatedAt: number;
}

export interface EloUpdate {
  uid: string;
  previousElo: number;
  newElo: number;
  delta: number;
  role: Role | null;
  won: boolean;
}

export interface LeaderboardEntry extends EloEntry {
  rank: number;
}

// ---------------------------------------------------------------------------
// Pure ELO calculation helpers
// ---------------------------------------------------------------------------

/**
 * Standard ELO expected score formula.
 * Returns the probability [0,1] that playerA beats playerB.
 */
export function expectedScore(eloA: number, eloB: number): number {
  return 1 / (1 + Math.pow(10, (eloB - eloA) / 400));
}

/**
 * Compute new ELO for a single player after a game result.
 *
 * @param currentElo  Player's current rating
 * @param won         Whether the player won
 * @param opponentAvgElo  Average ELO of opposing team
 * @param role        Player's role (used to weight K-factor)
 * @param kFactor     Base K-factor (default 32)
 */
export function computeNewElo(
  currentElo: number,
  won: boolean,
  opponentAvgElo: number,
  role: Role | null,
  kFactor: number = DEFAULT_K_FACTOR
): number {
  const expected = expectedScore(currentElo, opponentAvgElo);
  const actual = won ? 1 : 0;
  const roleWeight = role ? (ROLE_K_WEIGHTS[role] ?? 1.0) : 1.0;
  const adjustedK = kFactor * roleWeight;

  const newElo = Math.round(currentElo + adjustedK * (actual - expected));
  return Math.max(MIN_ELO, newElo);
}

/**
 * Compute average ELO for a list of players.
 * Falls back to STARTING_ELO if the list is empty.
 */
function averageElo(elos: number[]): number {
  if (elos.length === 0) return STARTING_ELO;
  return elos.reduce((sum, e) => sum + e, 0) / elos.length;
}

// ---------------------------------------------------------------------------
// EloRankingService — Firestore-backed
// ---------------------------------------------------------------------------

export class EloRankingService {
  private readonly rankingsPath = 'rankings';

  /**
   * Fetch the current ELO for a player.
   * Returns STARTING_ELO if no record exists.
   */
  async getPlayerElo(uid: string): Promise<number> {
    try {
      const db = getAdminDB();
      const snap = await db.ref(`${this.rankingsPath}/${uid}`).once('value');
      const entry = snap.val() as EloEntry | null;
      return entry?.eloRating ?? STARTING_ELO;
    } catch (err) {
      console.error(JSON.stringify({
        timestamp: new Date().toISOString(),
        event: 'elo_get_error',
        uid,
        error: err instanceof Error ? err.message : 'Unknown',
      }));
      return STARTING_ELO;
    }
  }

  /**
   * Process a completed game: compute and persist ELO updates for all players.
   * Returns the list of per-player deltas.
   */
  async processGameResult(
    record: GameRecord,
    kFactor: number = DEFAULT_K_FACTOR
  ): Promise<EloUpdate[]> {
    const db = getAdminDB();

    // Fetch current ELOs for all participants
    const elos = await Promise.all(
      record.players.map(async (p) => ({
        player: p,
        elo: await this.getPlayerElo(p.playerId),
      }))
    );

    const goodTeamElos = elos
      .filter((e) => e.player.team === 'good')
      .map((e) => e.elo);
    const evilTeamElos = elos
      .filter((e) => e.player.team === 'evil')
      .map((e) => e.elo);

    const goodAvg = averageElo(goodTeamElos);
    const evilAvg = averageElo(evilTeamElos);

    const updates: EloUpdate[] = [];
    const now = Date.now();

    for (const { player, elo } of elos) {
      const opponentAvg = player.team === 'good' ? evilAvg : goodAvg;
      const newElo = computeNewElo(elo, player.won, opponentAvg, player.role, kFactor);

      updates.push({
        uid: player.playerId,
        previousElo: elo,
        newElo,
        delta: newElo - elo,
        role: player.role,
        won: player.won,
      });

      await this.upsertEntry(db, player, elo, newElo, now);
    }

    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      event: 'elo_processed',
      gameId: record.gameId,
      playerCount: record.players.length,
    }));

    return updates;
  }

  /**
   * Retrieve the top N players ordered by ELO descending.
   */
  async getLeaderboard(limit = 50): Promise<LeaderboardEntry[]> {
    try {
      const db = getAdminDB();
      const snap = await db
        .ref(this.rankingsPath)
        .orderByChild('eloRating')
        .limitToLast(limit)
        .once('value');

      const entries: EloEntry[] = [];
      snap.forEach((child) => {
        const val = child.val() as EloEntry;
        if (val) entries.push({ ...val, uid: child.key as string });
      });

      entries.sort((a, b) => b.eloRating - a.eloRating);

      return entries.map((entry, idx) => ({ ...entry, rank: idx + 1 }));
    } catch (err) {
      console.error(JSON.stringify({
        timestamp: new Date().toISOString(),
        event: 'elo_leaderboard_error',
        error: err instanceof Error ? err.message : 'Unknown',
      }));
      return [];
    }
  }

  /**
   * Get detailed ELO entry for a single player.
   */
  async getPlayerEntry(uid: string): Promise<EloEntry | null> {
    try {
      const db = getAdminDB();
      const snap = await db.ref(`${this.rankingsPath}/${uid}`).once('value');
      const val = snap.val() as EloEntry | null;
      return val ? { ...val, uid } : null;
    } catch (err) {
      console.error(JSON.stringify({
        timestamp: new Date().toISOString(),
        event: 'elo_entry_error',
        uid,
        error: err instanceof Error ? err.message : 'Unknown',
      }));
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async upsertEntry(
    db: ReturnType<typeof getAdminDB>,
    player: GamePlayerRecord,
    previousElo: number,
    newElo: number,
    now: number
  ): Promise<void> {
    const ref = db.ref(`${this.rankingsPath}/${player.playerId}`);
    const snap = await ref.once('value');
    const existing = snap.val() as EloEntry | null;

    const totalGames = (existing?.totalGames ?? 0) + 1;
    const gamesWon = (existing?.gamesWon ?? 0) + (player.won ? 1 : 0);
    const gamesLost = (existing?.gamesLost ?? 0) + (player.won ? 0 : 1);

    const entry: EloEntry = {
      uid: player.playerId,
      displayName: player.displayName,
      eloRating: newElo,
      totalGames,
      gamesWon,
      gamesLost,
      winRate: totalGames > 0 ? (gamesWon / totalGames) * 100 : 0,
      lastGameAt: now,
      updatedAt: now,
    };

    await ref.set(entry);
  }
}
