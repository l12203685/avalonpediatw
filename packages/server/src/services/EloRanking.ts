import { Role } from '@avalon/shared';
import { getAdminDB } from './firebase';
import { GameRecord, GamePlayerRecord } from './GameHistoryRepository';
import {
  EloOutcome,
  deriveEloOutcome,
  getEloConfig,
} from './EloConfig';
import {
  computeAttributionDeltas,
  AttributionBreakdown,
} from './EloAttributionService';

// ---------------------------------------------------------------------------
// Constants (data-driven via EloConfig — see EloConfig.ts for seed values)
// ---------------------------------------------------------------------------
//
// #54 Phase 1: the hardcoded STARTING_ELO / DEFAULT_K_FACTOR / MIN_ELO /
// ROLE_K_WEIGHTS constants were migrated into EloConfig.ts so that Phase 2
// can expose them through an admin UI and Phase 3 can replay history with
// alternative snapshots. The lookups below read from getEloConfig() on
// every call (no-op indirection today — cheap single-object deref).

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
  /** Which of the three Avalon outcomes drove this ELO update. */
  outcome?: EloOutcome;
  /**
   * #54 Phase 2: per-event attribution breakdown applied on top of the
   * legacy (team-average × outcome × role) delta. Populated only when
   * `EloConfig.attributionMode === 'per_event'` AND the record carries
   * usable `voteHistoryPersisted` or `questHistoryPersisted`. Omitted on
   * the legacy path so Phase 1 consumers see no schema change.
   */
  attribution?: AttributionBreakdown;
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
 * @param currentElo       Player's current rating.
 * @param won              Whether the player won.
 * @param opponentAvgElo   Average ELO of opposing team.
 * @param role             Player's role (used to weight K-factor).
 * @param kFactor          Base K-factor. Defaults to EloConfig.baseKFactor.
 * @param outcome          Optional EloOutcome; when provided, its multiplier
 *                         (EloConfig.outcomeWeights) is applied on top of the
 *                         role weight. Omitting keeps legacy behaviour.
 */
export function computeNewElo(
  currentElo: number,
  won: boolean,
  opponentAvgElo: number,
  role: Role | null,
  kFactor?: number,
  outcome?: EloOutcome
): number {
  const config = getEloConfig();
  const baseK = kFactor ?? config.baseKFactor;

  const expected = expectedScore(currentElo, opponentAvgElo);
  const actual = won ? 1 : 0;
  const roleWeight = role ? (config.roleKWeights[role] ?? 1.0) : 1.0;
  const outcomeWeight = outcome ? (config.outcomeWeights[outcome] ?? 1.0) : 1.0;
  const adjustedK = baseK * roleWeight * outcomeWeight;

  const newElo = Math.round(currentElo + adjustedK * (actual - expected));
  return Math.max(config.minElo, newElo);
}

/**
 * Compute average ELO for a list of players.
 * Falls back to the team baseline from EloConfig.teamBaselines when empty.
 */
function averageElo(elos: number[], team: 'good' | 'evil'): number {
  if (elos.length === 0) return getEloConfig().teamBaselines[team];
  return elos.reduce((sum, e) => sum + e, 0) / elos.length;
}

// ---------------------------------------------------------------------------
// EloRankingService — Firestore-backed
// ---------------------------------------------------------------------------

export class EloRankingService {
  private readonly rankingsPath = 'rankings';

  /**
   * Fetch the current ELO for a player.
   * Returns the active config's startingElo (EloConfig.startingElo) when
   * no record exists.
   */
  async getPlayerElo(uid: string): Promise<number> {
    try {
      const db = getAdminDB();
      const snap = await db.ref(`${this.rankingsPath}/${uid}`).once('value');
      const entry = snap.val() as EloEntry | null;
      return entry?.eloRating ?? getEloConfig().startingElo;
    } catch (err) {
      console.error(JSON.stringify({
        timestamp: new Date().toISOString(),
        event: 'elo_get_error',
        uid,
        error: err instanceof Error ? err.message : 'Unknown',
      }));
      return getEloConfig().startingElo;
    }
  }

  /**
   * Process a completed game: compute and persist ELO updates for all players.
   * Returns the list of per-player deltas.
   */
  async processGameResult(
    record: GameRecord,
    kFactor?: number
  ): Promise<EloUpdate[]> {
    const db = getAdminDB();
    const config = getEloConfig();

    // Derive once per game — the outcome multiplier is identical for every
    // player in the match. No DB round-trip needed (config is in-memory).
    const outcome = deriveEloOutcome(record.winner, record.winReason);

    // #54 Phase 2 routing: compute per-event attribution once, reuse for all
    // players. Returns `applied: false` for legacy records / legacy mode —
    // layer is a no-op on the Phase 1 branch.
    const attribution = computeAttributionDeltas(record);

    // Fetch current ELOs for all participants (single batch; N-of-N)
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

    const goodAvg = averageElo(goodTeamElos, 'good');
    const evilAvg = averageElo(evilTeamElos, 'evil');

    const updates: EloUpdate[] = [];
    const now = Date.now();

    for (const { player, elo } of elos) {
      const opponentAvg = player.team === 'good' ? evilAvg : goodAvg;
      // Legacy ELO based on team-average × outcome × role K.
      const legacyNewElo = computeNewElo(
        elo,
        player.won,
        opponentAvg,
        player.role,
        kFactor,
        outcome
      );

      // Phase 2 per-event layer. `applied: false` → attributionDelta = 0.
      const attributionDelta = attribution.applied
        ? (attribution.deltas[player.playerId] ?? 0)
        : 0;

      // Round after layering so the final ELO stays integer and the
      // min-ELO floor is still honoured.
      const combined = Math.round(legacyNewElo + attributionDelta);
      const newElo = Math.max(config.minElo, combined);

      const breakdown = attribution.applied
        ? attribution.breakdown[player.playerId]
        : undefined;

      const update: EloUpdate = {
        uid: player.playerId,
        previousElo: elo,
        newElo,
        delta: newElo - elo,
        role: player.role,
        won: player.won,
        outcome,
      };
      if (breakdown) {
        update.attribution = breakdown;
      }
      updates.push(update);

      await this.upsertEntry(db, player, elo, newElo, now);
    }

    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      event: 'elo_processed',
      gameId: record.gameId,
      playerCount: record.players.length,
      outcome,
      attributionMode: config.attributionMode,
      attributionApplied: attribution.applied,
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
