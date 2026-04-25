import { Role, QuestResult } from '@avalon/shared';
import { getAdminFirestore } from './firebase';
import { GameRecord, GamePlayerRecord } from './GameHistoryRepository';

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export interface FactionStats {
  faction: 'good' | 'evil';
  totalGames: number;
  wins: number;
  winRate: number;
  /** How often good's 3-quest win led to assassination phase */
  reachedAssassination?: number;
  assassinationSuccessRate?: number;
}

export interface RoleStats {
  role: Role;
  totalGames: number;
  wins: number;
  winRate: number;
}

export interface PlayerCountStats {
  playerCount: number;
  totalGames: number;
  goodWins: number;
  evilWins: number;
  goodWinRate: number;
}

export interface QuestPatternStats {
  /** e.g. "SSFSS" — S=success, F=fail */
  pattern: string;
  count: number;
  /** Who won with this pattern */
  goodWins: number;
  evilWins: number;
}

export interface AssassinationStats {
  totalAttempts: number;
  successes: number;
  successRate: number;
  /** Win rate for good side when assassination fails */
  goodWinRateOnFail: number;
}

export interface AnalyticsOverview {
  totalGames: number;
  factionStats: FactionStats[];
  roleStats: RoleStats[];
  playerCountStats: PlayerCountStats[];
  topQuestPatterns: QuestPatternStats[];
  assassinationStats: AssassinationStats;
  computedAt: number;
}

export interface PlayerAnalytics {
  playerId: string;
  displayName: string;
  totalGames: number;
  wins: number;
  losses: number;
  winRate: number;
  roleStats: RoleStats[];
  /** Win rate when playing good vs evil */
  goodWinRate: number;
  evilWinRate: number;
  averageGameDuration: number;
}

// ---------------------------------------------------------------------------
// Pure analysis helpers
// ---------------------------------------------------------------------------

function safeRate(wins: number, total: number): number {
  if (total === 0) return 0;
  return parseFloat(((wins / total) * 100).toFixed(1));
}

function questPatternKey(results: QuestResult[]): string {
  return results.map((r) => (r === 'success' ? 'S' : 'F')).join('');
}

// ---------------------------------------------------------------------------
// GameAnalytics — port of analyze_games.py patterns to TypeScript
// ---------------------------------------------------------------------------

/**
 * Computes win rates, assassination patterns, and role balance
 * from a set of game records.
 *
 * All methods are pure (no I/O) so they are easily testable.
 * The service methods fetch records and delegate to the pure functions.
 */
export class GameAnalytics {
  private readonly gamesCollection = 'games';

  // -------------------------------------------------------------------------
  // Pure computation methods (static — no DB dependency)
  // -------------------------------------------------------------------------

  /**
   * Aggregate win statistics per faction.
   * Mirrors overall_stats() in analyze_games.py.
   */
  static computeFactionStats(records: GameRecord[]): FactionStats[] {
    const total = records.length;
    if (total === 0) return [];

    const goodWins = records.filter((r) => r.winner === 'good').length;
    const evilWins = total - goodWins;

    // Assassination phase: games where good won 3 quests (winner=good means assassination failed)
    // Games where evil won by assassination = winner=evil with reason containing 'assassination'
    const assassinationAttempts = records.filter(
      (r) => r.winReason === 'assassination_success' || r.winner === 'good'
    ).length;
    const assassinationSuccesses = records.filter(
      (r) => r.winReason === 'assassination_success'
    ).length;

    return [
      {
        faction: 'good',
        totalGames: total,
        wins: goodWins,
        winRate: safeRate(goodWins, total),
        reachedAssassination: assassinationAttempts,
        assassinationSuccessRate: safeRate(assassinationSuccesses, assassinationAttempts),
      },
      {
        faction: 'evil',
        totalGames: total,
        wins: evilWins,
        winRate: safeRate(evilWins, total),
      },
    ];
  }

  /**
   * Win rates broken down by role.
   * Mirrors player_stats() role-level breakdown in analyze_games.py.
   */
  static computeRoleStats(records: GameRecord[]): RoleStats[] {
    const byRole = new Map<Role, { games: number; wins: number }>();

    for (const record of records) {
      for (const player of record.players) {
        if (!player.role) continue;
        const existing = byRole.get(player.role) ?? { games: 0, wins: 0 };
        byRole.set(player.role, {
          games: existing.games + 1,
          wins: existing.wins + (player.won ? 1 : 0),
        });
      }
    }

    return Array.from(byRole.entries()).map(([role, stats]) => ({
      role,
      totalGames: stats.games,
      wins: stats.wins,
      winRate: safeRate(stats.wins, stats.games),
    }));
  }

  /**
   * Win rates by player count (5-10 players).
   * Mirrors win_rates_by_category() in analyze_games.py.
   */
  static computePlayerCountStats(records: GameRecord[]): PlayerCountStats[] {
    const byCount = new Map<number, { total: number; goodWins: number; evilWins: number }>();

    for (const record of records) {
      const count = record.playerCount;
      const existing = byCount.get(count) ?? { total: 0, goodWins: 0, evilWins: 0 };
      byCount.set(count, {
        total: existing.total + 1,
        goodWins: existing.goodWins + (record.winner === 'good' ? 1 : 0),
        evilWins: existing.evilWins + (record.winner === 'evil' ? 1 : 0),
      });
    }

    return Array.from(byCount.entries())
      .sort(([a], [b]) => a - b)
      .map(([playerCount, stats]) => ({
        playerCount,
        totalGames: stats.total,
        goodWins: stats.goodWins,
        evilWins: stats.evilWins,
        goodWinRate: safeRate(stats.goodWins, stats.total),
      }));
  }

  /**
   * Most common quest result patterns and associated win rates.
   * Mirrors round_progression() in analyze_games.py.
   */
  static computeQuestPatterns(records: GameRecord[], topN = 10): QuestPatternStats[] {
    const patternMap = new Map<string, { count: number; goodWins: number; evilWins: number }>();

    for (const record of records) {
      if (record.questResults.length === 0) continue;
      const key = questPatternKey(record.questResults);
      const existing = patternMap.get(key) ?? { count: 0, goodWins: 0, evilWins: 0 };
      patternMap.set(key, {
        count: existing.count + 1,
        goodWins: existing.goodWins + (record.winner === 'good' ? 1 : 0),
        evilWins: existing.evilWins + (record.winner === 'evil' ? 1 : 0),
      });
    }

    return Array.from(patternMap.entries())
      .sort(([, a], [, b]) => b.count - a.count)
      .slice(0, topN)
      .map(([pattern, stats]) => ({ pattern, ...stats }));
  }

  /**
   * Assassination phase statistics.
   * Mirrors assassination_analysis() in analyze_games.py.
   */
  static computeAssassinationStats(records: GameRecord[]): AssassinationStats {
    // Games that reached assassination = winner is good OR won by assassination
    const reached = records.filter(
      (r) => r.winner === 'good' || r.winReason === 'assassination_success'
    );
    const successes = records.filter((r) => r.winReason === 'assassination_success');
    const fails = reached.length - successes.length;

    return {
      totalAttempts: reached.length,
      successes: successes.length,
      successRate: safeRate(successes.length, reached.length),
      goodWinRateOnFail: safeRate(fails, reached.length),
    };
  }

  /**
   * Analytics for a single player across their game history.
   */
  static computePlayerAnalytics(
    playerId: string,
    records: GameRecord[]
  ): PlayerAnalytics | null {
    const playerRecords = records.filter((r) =>
      r.players.some((p) => p.playerId === playerId)
    );
    if (playerRecords.length === 0) return null;

    // Find display name from any record
    let displayName = playerId;
    for (const record of playerRecords) {
      const p = record.players.find((p) => p.playerId === playerId);
      if (p) {
        displayName = p.displayName;
        break;
      }
    }

    const total = playerRecords.length;
    let wins = 0;
    let goodGames = 0;
    let goodWins = 0;
    let evilGames = 0;
    let evilWins = 0;
    let totalDuration = 0;
    const roleMap = new Map<Role, { games: number; wins: number }>();

    for (const record of playerRecords) {
      const playerEntry = record.players.find((p) => p.playerId === playerId)!;

      if (playerEntry.won) wins++;
      totalDuration += record.duration;

      if (playerEntry.team === 'good') {
        goodGames++;
        if (playerEntry.won) goodWins++;
      } else if (playerEntry.team === 'evil') {
        evilGames++;
        if (playerEntry.won) evilWins++;
      }

      if (playerEntry.role) {
        const existing = roleMap.get(playerEntry.role) ?? { games: 0, wins: 0 };
        roleMap.set(playerEntry.role, {
          games: existing.games + 1,
          wins: existing.wins + (playerEntry.won ? 1 : 0),
        });
      }
    }

    return {
      playerId,
      displayName,
      totalGames: total,
      wins,
      losses: total - wins,
      winRate: safeRate(wins, total),
      roleStats: Array.from(roleMap.entries()).map(([role, stats]) => ({
        role,
        totalGames: stats.games,
        wins: stats.wins,
        winRate: safeRate(stats.wins, stats.games),
      })),
      goodWinRate: safeRate(goodWins, goodGames),
      evilWinRate: safeRate(evilWins, evilGames),
      averageGameDuration: total > 0 ? Math.round(totalDuration / total) : 0,
    };
  }

  // -------------------------------------------------------------------------
  // Service methods (fetch from Firestore, delegate to pure methods)
  // -------------------------------------------------------------------------

  /**
   * Build the full analytics overview from all recorded games.
   * Fetches up to maxGames records from Firestore.
   */
  async getOverview(maxGames = 500): Promise<AnalyticsOverview> {
    const records = await this.fetchRecentGames(maxGames);
    return {
      totalGames: records.length,
      factionStats: GameAnalytics.computeFactionStats(records),
      roleStats: GameAnalytics.computeRoleStats(records),
      playerCountStats: GameAnalytics.computePlayerCountStats(records),
      topQuestPatterns: GameAnalytics.computeQuestPatterns(records),
      assassinationStats: GameAnalytics.computeAssassinationStats(records),
      computedAt: Date.now(),
    };
  }

  /**
   * Build analytics for a specific player from their game history.
   * Fetches up to maxGames records from Firestore and filters client-side.
   */
  async getPlayerAnalytics(
    playerId: string,
    maxGames = 200
  ): Promise<PlayerAnalytics | null> {
    const records = await this.fetchRecentGames(maxGames);
    return GameAnalytics.computePlayerAnalytics(playerId, records);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async fetchRecentGames(limit: number): Promise<GameRecord[]> {
    try {
      const firestore = getAdminFirestore();
      const snapshot = await firestore
        .collection(this.gamesCollection)
        .orderBy('endedAt', 'desc')
        .limit(limit)
        .get();

      return snapshot.docs.map((doc) => doc.data() as GameRecord);
    } catch (err) {
      console.error(JSON.stringify({
        timestamp: new Date().toISOString(),
        event: 'analytics_fetch_error',
        error: err instanceof Error ? err.message : 'Unknown',
      }));
      return [];
    }
  }
}
