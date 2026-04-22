import { GameRecord } from './GameHistoryRepository';
import {
  EloAttributionWeights,
  getEloConfig,
} from './EloConfig';
import { computeProposalFactor } from './ProposalFactor';
import { computeOuterWhiteInnerBlackFactor } from './OuterWhiteInnerBlackFactor';
import { computeInformationFactor } from './InformationFactor';
import { computeMisdirectionFactor } from './MisdirectionFactor';
import {
  computeSeatOrderAdjustment,
  lookupSeatMultiplier,
} from './SeatOrderAdjustment';

/**
 * EloAttributionService — #54 Phase 2 / 2.5 per-event delta router
 *
 * Takes a completed GameRecord and returns an additive per-player ELO
 * delta that `EloRanking.processGameResult` layers on top of the legacy
 * (team-average × outcome × role) computation when
 * `EloConfig.attributionMode === 'per_event'`.
 *
 * Phase 2 contract (2026-04-22):
 *   finalDelta(player) =
 *     legacyDelta(player)                                      // Phase 1
 *   + weights.proposal              * proposalScore(player)    // Phase 2
 *   + weights.outerWhiteInnerBlack  * owibScore(player)        // Phase 2
 *
 * Phase 2.5 contract (2026-04-22):
 *   rawFactorSum(player) =
 *       weights.proposal             * proposalScore(player)
 *     + weights.outerWhiteInnerBlack * owibScore(player)
 *     + weights.information          * infoScore(player)
 *     + weights.misdirection         * misdirectionScore(player)
 *
 *   seatMultiplier(player) =
 *     weights.seatOrderEnabled
 *       ? depthToMultiplier(avg proposal depth for that player)
 *       : 1.0
 *
 *   finalDelta(player) = legacyDelta(player) + rawFactorSum * seatMultiplier
 *
 * Fallback rules (legacy-preserving; all keep Phase 1 behaviour):
 *   - attributionMode === 'legacy'                     → returns {}
 *   - voteHistoryPersisted missing or empty            → Proposal / Information / part
 *                                                        of Misdirection contribute 0
 *   - questHistoryPersisted missing or empty           → OWIB and part of
 *                                                        Misdirection contribute 0
 *   - BOTH missing                                     → returns applied=false (same as legacy)
 *   - Any player absent from a factor's result         → 0 for that factor
 *
 * The service is **pure** w.r.t. the passed record and current config:
 *   no DB reads, no network, no mutation. Call it after fetching the record.
 */

export interface AttributionBreakdown {
  proposal: number;
  outerWhiteInnerBlack: number;
  information: number;
  misdirection: number;
  /** Multiplier applied to (proposal + OWIB + info + misdirection). */
  seatMultiplier: number;
  /** Sum of all weighted factor contributions after seat multiplier. */
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
  const infoResult =
    hasVotes || !hasQuests  // info uses votes primarily + winReason
      ? computeInformationFactor(record)
      : { scores: {}, voteCounts: {} };
  const misdirectionResult = computeMisdirectionFactor(record);
  const seatResult = hasVotes
    ? computeSeatOrderAdjustment(record)
    : { multipliers: {}, averageDepth: {} };

  const deltas: Record<string, number> = {};
  const breakdown: Record<string, AttributionBreakdown> = {};

  for (const player of record.players) {
    const pid = player.playerId;
    const proposalRaw = proposalResult.scores[pid] ?? 0;
    const owibRaw = owibResult.scores[pid] ?? 0;
    const infoRaw = infoResult.scores[pid] ?? 0;
    const misdirectionRaw = misdirectionResult.scores[pid] ?? 0;

    const proposalDelta = proposalRaw * weights.proposal;
    const owibDelta = owibRaw * weights.outerWhiteInnerBlack;
    const infoDelta = infoRaw * weights.information;
    const misdirectionDelta = misdirectionRaw * weights.misdirection;

    const sum = proposalDelta + owibDelta + infoDelta + misdirectionDelta;

    const seatMultiplier = weights.seatOrderEnabled
      ? lookupSeatMultiplier(seatResult.multipliers, pid)
      : 1.0;

    const total = sum * seatMultiplier;

    breakdown[pid] = {
      proposal: proposalDelta,
      outerWhiteInnerBlack: owibDelta,
      information: infoDelta,
      misdirection: misdirectionDelta,
      seatMultiplier,
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
