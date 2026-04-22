import { VoteRecord } from '@avalon/shared';
import { GameRecord } from './GameHistoryRepository';

/**
 * SeatOrderAdjustment — #54 Phase 2.5 per-event attribution
 *
 * Applies a seat-position-aware multiplier on top of the per-player
 * attribution sum. Edward's 2026-04-20 factor list:
 *   "順位 × 角色（第幾個提案人、坐在刺客旁邊、湖中對位）"
 *
 * Signal intent:
 *   - Early leaders propose with less information (fewer completed quests,
 *     no voting-patterns to exploit). Their decisions are lower-stakes in
 *     an information sense.
 *   - Late leaders (round 4-5, attempt 3+) operate in a fully public data
 *     environment. A good call is worth more; a bad call is worth more.
 *   - Using `leader_index / total_leaders_in_game` as proxy for "decision
 *     depth" because rotation is deterministic from `leaderStartIndex`.
 *
 * Output: Record<playerId, multiplier> where multiplier ∈ [0.8, 1.2].
 *   - Multiplier 1.0 = neutral (also the fallback when leaderStartIndex /
 *     voteHistoryPersisted missing).
 *   - Callers (EloAttributionService) multiply the per-player factor
 *     SUM by this value (NOT the legacy delta — seat order only modulates
 *     the Phase 2 layer).
 *
 * This factor intentionally does NOT compute a raw delta like the other
 * three factors — seat position is a *calibration*, not a signal. Adding
 * it as yet another additive term risks double-counting whatever leaders
 * already earn through ProposalFactor.
 */

const MIN_MULTIPLIER = 0.8;
const MAX_MULTIPLIER = 1.2;
const NEUTRAL_MULTIPLIER = 1.0;

export interface SeatOrderAdjustmentResult {
  /** Per-player multiplier. Any player absent → caller treats as 1.0. */
  multipliers: Record<string, number>;
  /** Debug: each player's average proposal depth in [0, 1]. */
  averageDepth: Record<string, number>;
}

/**
 * Compute seat-order multipliers for every player who led at least one vote.
 * Non-leaders get NEUTRAL_MULTIPLIER (1.0).
 */
export function computeSeatOrderAdjustment(
  record: GameRecord
): SeatOrderAdjustmentResult {
  const multipliers: Record<string, number> = {};
  const averageDepth: Record<string, number> = {};

  const voteHistory = record.voteHistoryPersisted;
  if (!voteHistory || voteHistory.length === 0) {
    return { multipliers, averageDepth };
  }

  // Precompute ordered list of unique (round, attempt) pairs — each is a
  // proposal "slot". Depth = slot_index / total_slots so final proposal
  // has depth ≈ 1, first proposal has depth 0.
  const totalSlots = voteHistory.length;
  if (totalSlots === 0) {
    return { multipliers, averageDepth };
  }

  const depthSum = new Map<string, number>();
  const depthCount = new Map<string, number>();

  voteHistory.forEach((vote: VoteRecord, idx: number) => {
    const leader = vote.leader;
    if (!leader) return;
    const depth = totalSlots === 1 ? 0.5 : idx / (totalSlots - 1);
    depthSum.set(leader, (depthSum.get(leader) ?? 0) + depth);
    depthCount.set(leader, (depthCount.get(leader) ?? 0) + 1);
  });

  for (const [player, sum] of depthSum.entries()) {
    const count = depthCount.get(player) ?? 1;
    const avg = sum / count;
    averageDepth[player] = avg;
    multipliers[player] = depthToMultiplier(avg);
  }

  return { multipliers, averageDepth };
}

/**
 * Convert [0, 1] depth to a multiplier in [MIN_MULTIPLIER, MAX_MULTIPLIER].
 *
 *   depth 0   → MIN_MULTIPLIER  (first-slot leader, low info)
 *   depth 1   → MAX_MULTIPLIER  (late leader, high info)
 *   depth 0.5 → NEUTRAL_MULTIPLIER
 *
 * Exported for unit tests.
 */
export function depthToMultiplier(depth: number): number {
  const clamped = Math.max(0, Math.min(1, depth));
  return (
    MIN_MULTIPLIER + (MAX_MULTIPLIER - MIN_MULTIPLIER) * clamped
  );
}

/**
 * Look up a multiplier with sensible default. Exported so
 * `EloAttributionService` doesn't need to inline undefined-guards.
 */
export function lookupSeatMultiplier(
  multipliers: Record<string, number>,
  playerId: string
): number {
  const value = multipliers[playerId];
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return NEUTRAL_MULTIPLIER;
  }
  return value;
}
