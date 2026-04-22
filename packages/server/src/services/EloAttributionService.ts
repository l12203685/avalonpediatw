import { GameRecord } from './GameHistoryRepository';
import {
  EloAttributionWeights,
  getEloConfig,
} from './EloConfig';
import { computeProposalFactor } from './ProposalFactor';
import { computeOuterWhiteInnerBlackFactor } from './OuterWhiteInnerBlackFactor';

/**
 * EloAttributionService — #54 Phase 2 per-event delta router
 *
 * Takes a completed GameRecord and returns an additive per-player ELO
 * delta that `EloRanking.processGameResult` layers on top of the legacy
 * (team-average × outcome × role) computation when
 * `EloConfig.attributionMode === 'per_event'`.
 *
 * Contract (intentional, DG B — start with the two strongest signals):
 *   finalDelta(player) =
 *     legacyDelta(player)                                 // Phase 1
 *   + weights.proposal           * proposalScore(player)  // Phase 2
 *   + weights.outerWhiteInnerBlack * owibScore(player)    // Phase 2
 *   + weights.information?       * 0                      // reserved (Phase 2.5)
 *   + weights.misdirection?      * 0                      // reserved (Phase 2.5)
 *
 * Fallback rules (legacy-preserving; all three keep Phase 1 behaviour):
 *   - attributionMode === 'legacy'                     → returns {}
 *   - voteHistoryPersisted missing or empty            → Proposal contributes 0
 *   - questHistoryPersisted missing or empty           → OWIB contributes 0
 *   - Any player absent from a factor's result         → 0 for that factor
 *
 * The service is **pure** w.r.t. the passed record and current config:
 *   no DB reads, no network, no mutation. Call it after fetching the record.
 */

export interface AttributionBreakdown {
  proposal: number;
  outerWhiteInnerBlack: number;
  /** Sum of all factor contributions (already weighted). */
  total: number;
}

export interface AttributionResult {
  /** Per-player additive ELO delta from factor computations. */
  deltas: Record<string, number>;
  /** Per-player factor breakdown (debug / audit / admin UI). */
  breakdown: Record<string, AttributionBreakdown>;
  /** Echo of the weights used — handy for audit logs. */
  weights: EloAttributionWeights;
  /** True iff the caller should apply the deltas (i.e. flag on AND history present). */
  applied: boolean;
}

/**
 * Compute per-player attribution deltas for a completed game.
 *
 * Returns `applied: false` and empty deltas when attributionMode is 'legacy'
 * OR when neither voteHistoryPersisted nor questHistoryPersisted is usable.
 * Callers (EloRanking) MUST check `applied` before layering on top of the
 * legacy delta.
 */
export function computeAttributionDeltas(
  record: GameRecord
): AttributionResult {
  const config = getEloConfig();
  const weights = config.attributionWeights;

  // Feature flag off → return empty, caller stays on Phase 1 path.
  if (config.attributionMode !== 'per_event') {
    return {
      deltas: {},
      breakdown: {},
      weights,
      applied: false,
    };
  }

  const hasVotes =
    !!record.voteHistoryPersisted && record.voteHistoryPersisted.length > 0;
  const hasQuests =
    !!record.questHistoryPersisted && record.questHistoryPersisted.length > 0;

  // per_event requested but legacy record (pre-Phase 2) has neither history
  // → fall back to Phase 1. Do NOT partially apply; that would create mixed
  // rating scales across different eras of records.
  if (!hasVotes && !hasQuests) {
    return {
      deltas: {},
      breakdown: {},
      weights,
      applied: false,
    };
  }

  const proposalResult = hasVotes
    ? computeProposalFactor(record)
    : { scores: {}, proposalCounts: {} };
  const owibResult = hasQuests
    ? computeOuterWhiteInnerBlackFactor(record)
    : { scores: {}, questAppearances: {} };

  const deltas: Record<string, number> = {};
  const breakdown: Record<string, AttributionBreakdown> = {};

  for (const player of record.players) {
    const pid = player.playerId;
    const proposalRaw = proposalResult.scores[pid] ?? 0;
    const owibRaw = owibResult.scores[pid] ?? 0;

    const proposalDelta = proposalRaw * weights.proposal;
    const owibDelta = owibRaw * weights.outerWhiteInnerBlack;
    const total = proposalDelta + owibDelta;

    breakdown[pid] = {
      proposal: proposalDelta,
      outerWhiteInnerBlack: owibDelta,
      total,
    };

    // Only surface non-zero deltas — keeps downstream patch payload small.
    if (total !== 0) {
      deltas[pid] = total;
    }
  }

  return {
    deltas,
    breakdown,
    weights,
    applied: true,
  };
}
