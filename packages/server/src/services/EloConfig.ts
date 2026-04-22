import { Role } from '@avalon/shared';

/**
 * EloConfig — data-driven ELO configuration (#54 Phase 1)
 *
 * Replaces the hardcoded constants previously baked into EloRanking.ts with
 * a single source of truth that:
 *   1. Defines per-team baseline ratings (used as team-average fallback
 *      when a side has no participants yet).
 *   2. Defines per-outcome K-factor multipliers for the three Avalon
 *      end-state categories.
 *   3. Keeps the existing per-role K weighting as configurable data.
 *
 * Phase 2 will expose this config through an admin UI and optionally
 * persist it to Supabase; Phase 3 will rerun historical games with a
 * specific config snapshot. Phase 1 only threads the data-driven shape
 * through the calculation pipeline.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The three Avalon end-state outcomes recognised by the ELO model.
 *
 *   - good_wins_quests:  Good team completed 3 successful quests AND the
 *     assassin failed to identify Merlin (a.k.a. assassination_failed).
 *   - evil_wins_quests:  Evil team caused 3 failed quests, or Good team
 *     was blocked by vote-rejection limit; structural evil win without
 *     an assassination phase.
 *   - assassin_kills_merlin: Good team completed 3 successful quests but
 *     the assassin correctly identified Merlin.
 */
export type EloOutcome =
  | 'good_wins_quests'
  | 'evil_wins_quests'
  | 'assassin_kills_merlin';

/**
 * #54 Phase 2: attribution mode controls whether per-event factor deltas
 * are computed on top of the legacy per-team-average ELO.
 *
 *   'legacy'    — Phase 1 behaviour only (outcome × role multiplier).
 *   'per_event' — also apply Proposal + Outer-white-inner-black factors
 *                 from `EloAttributionService`. Requires
 *                 `voteHistoryPersisted` and `questHistoryPersisted` on
 *                 the record; automatically falls back to 'legacy' when
 *                 either is missing.
 */
export type EloAttributionMode = 'legacy' | 'per_event';

/**
 * #54 Phase 2 / 2.5: per-event factor weights.
 *
 * Phase 2 (shipped 2026-04-22): proposal + outerWhiteInnerBlack.
 * Phase 2.5 (shipped 2026-04-22): information + misdirection complete the
 *   four causal factors from Edward's 2026-04-20 list. seatOrderEnabled
 *   toggles the seat-position multiplier on top of the sum.
 *
 * All four factor weights default to a non-zero value so `per_event` mode
 * uses the full attribution stack out of the box. To disable an individual
 * factor set its weight to 0 (or flip seatOrderEnabled to false).
 */
export interface EloAttributionWeights {
  proposal: number;
  outerWhiteInnerBlack: number;
  information: number;
  misdirection: number;
  /** When true, seat-position multiplier is applied to the factor sum. */
  seatOrderEnabled: boolean;
}

export interface EloConfig {
  /** Starting ELO for a brand new player (first-time fetch fallback). */
  startingElo: number;
  /** Minimum ELO floor — a player's rating can never fall below this. */
  minElo: number;
  /** Base K-factor before outcome and role multipliers are applied. */
  baseKFactor: number;

  /**
   * Team-average baseline ratings. Used when a side has no participants
   * yet (e.g. replaying a partial record) as the expected-score reference.
   */
  teamBaselines: {
    good: number;
    evil: number;
  };

  /**
   * Per-outcome K-factor multipliers. Applied on top of baseKFactor and
   * per-role weight. Seed values (Phase 1):
   *   - good_wins_quests:     1.0  (structural win, neutral weight)
   *   - evil_wins_quests:     1.0  (structural win, neutral weight)
   *   - assassin_kills_merlin:1.5  (key individual strike, higher stakes)
   */
  outcomeWeights: Record<EloOutcome, number>;

  /**
   * Per-role K-factor multipliers. Higher-stakes roles get larger deltas
   * because their individual performance has outsized game impact.
   */
  roleKWeights: Record<Role, number>;

  /**
   * #54 Phase 2: attribution mode. Default 'legacy' = Phase 1 exact behaviour.
   * Flip to 'per_event' after Phase 3 backtest validates factor weights.
   */
  attributionMode: EloAttributionMode;

  /**
   * #54 Phase 2: per-event factor weights. Placeholder values shipped with
   * the first batch — tune via backtest before flipping attributionMode.
   */
  attributionWeights: EloAttributionWeights;
}

// ---------------------------------------------------------------------------
// Default config (Phase 1 seed values)
// ---------------------------------------------------------------------------

export const DEFAULT_ELO_CONFIG: EloConfig = {
  startingElo: 1000,
  minElo: 100,
  baseKFactor: 32,
  teamBaselines: {
    good: 1500,
    evil: 1500,
  },
  outcomeWeights: {
    good_wins_quests: 1.0,
    evil_wins_quests: 1.0,
    assassin_kills_merlin: 1.5,
  },
  roleKWeights: {
    merlin: 1.5,
    assassin: 1.5,
    percival: 1.2,
    morgana: 1.2,
    oberon: 1.1,
    mordred: 1.3,
    minion: 1.0,
    loyal: 1.0,
  },
  // #54 Phase 2 defaults — 'legacy' mode preserves Phase 1 behaviour.
  // Flip to 'per_event' after Phase 3 backtest tunes the weights.
  attributionMode: 'legacy',
  attributionWeights: {
    // Phase 2 factors (Edward 2026-04-20 priority #2, #4).
    proposal: 2.0,
    outerWhiteInnerBlack: 3.0,
    // Phase 2.5 factors (Edward 2026-04-20 priority #1, #3).
    information: 1.5,
    misdirection: 1.5,
    // Seat-order multiplier applied to the SUM of the four factors
    // (NOT the legacy delta). Default on so per_event uses the full stack.
    seatOrderEnabled: true,
  },
};

// ---------------------------------------------------------------------------
// In-memory cache (single read per process; Phase 2 will wire persistence)
// ---------------------------------------------------------------------------

let activeConfig: EloConfig = DEFAULT_ELO_CONFIG;

/**
 * Return the currently active ELO configuration. All reads in the ELO
 * pipeline go through this helper so Phase 2 can swap in a DB-backed
 * loader without touching call sites.
 */
export function getEloConfig(): EloConfig {
  return activeConfig;
}

/**
 * Partial shape for `setEloConfig` — allows nested partial overrides so
 * tests and admin UI can flip a single key without having to re-specify
 * every required field in the nested records.
 */
export type PartialEloConfig = Omit<
  Partial<EloConfig>,
  'teamBaselines' | 'outcomeWeights' | 'roleKWeights' | 'attributionWeights'
> & {
  teamBaselines?: Partial<EloConfig['teamBaselines']>;
  outcomeWeights?: Partial<EloConfig['outcomeWeights']>;
  roleKWeights?: Partial<EloConfig['roleKWeights']>;
  attributionWeights?: Partial<EloAttributionWeights>;
};

/**
 * Override the active config. Used by tests and (Phase 2) the admin UI.
 * Pass a partial config to merge with the current one; pass undefined to
 * reset to DEFAULT_ELO_CONFIG.
 */
export function setEloConfig(partial?: PartialEloConfig): EloConfig {
  if (!partial) {
    activeConfig = DEFAULT_ELO_CONFIG;
    return activeConfig;
  }
  activeConfig = {
    ...activeConfig,
    ...partial,
    teamBaselines: {
      ...activeConfig.teamBaselines,
      ...(partial.teamBaselines ?? {}),
    },
    outcomeWeights: {
      ...activeConfig.outcomeWeights,
      ...(partial.outcomeWeights ?? {}),
    },
    roleKWeights: {
      ...activeConfig.roleKWeights,
      ...(partial.roleKWeights ?? {}),
    },
    // #54 Phase 2 — same nested-merge pattern for attribution weights.
    attributionWeights: {
      ...activeConfig.attributionWeights,
      ...(partial.attributionWeights ?? {}),
    },
  };
  return activeConfig;
}

// ---------------------------------------------------------------------------
// winReason → EloOutcome derivation
// ---------------------------------------------------------------------------

/**
 * Map a GameRecord's winReason/winner pair to the canonical EloOutcome.
 *
 * Known winReason values in the codebase (see Room.endReason in
 * packages/shared/src/types/game.ts and importer scripts):
 *   - 'assassination_failed'     → good wins after good quests (no merlin kill)
 *   - 'assassination_success'    → assassin kills merlin
 *   - 'merlin_assassinated'      → assassin kills merlin
 *   - 'failed_quests' | 'failed_quests_limit' → evil wins by 3 fails
 *   - 'vote_rejections' | 'vote_rejections_limit' → evil wins by vote spam
 *   - 'assassination_timeout'    → good wins (assassin didn't act in time)
 *   - Legacy CJK strings from importer: '刺殺梅林', '好人勝（梅林存活）', etc.
 *
 * Falls back to winner team when winReason is unknown so Phase 1 never
 * crashes on legacy data — Phase 3 replay will assign richer outcomes.
 */
export function deriveEloOutcome(
  winner: 'good' | 'evil',
  winReason: string | null | undefined
): EloOutcome {
  const reason = (winReason ?? '').toLowerCase();

  // Assassin kill (any locale / legacy label)
  if (
    reason.includes('assassination_success') ||
    reason.includes('merlin_assassinated') ||
    reason.includes('刺殺梅林') ||
    reason.includes('刺中梅林')
  ) {
    return 'assassin_kills_merlin';
  }

  // Good wins (assassination_failed, assassination_timeout, explicit good flag)
  if (winner === 'good') {
    return 'good_wins_quests';
  }

  // Evil wins via quests / vote rejection
  return 'evil_wins_quests';
}
