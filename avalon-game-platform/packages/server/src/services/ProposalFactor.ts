import { VoteRecord, QuestRecord } from '@avalon/shared';
import { GameRecord } from './GameHistoryRepository';

/**
 * ProposalFactor — #54 Phase 2 per-event attribution
 *
 * Scores each proposal (team pick) in a GameRecord by comparing who the
 * leader put on the quest vs the hidden-team composition. The per-leader
 * sum across all their proposals becomes that player's Proposal factor
 * delta, which `EloAttributionService` multiplies by
 * `EloConfig.attributionWeights.proposal`.
 *
 * Signal intent (mirroring Edward 2026-04-20 feedback "only red can vote
 * quest-fail, so the question is **who put reds on the quest**"):
 *
 *   GOOD leader picks a team with:
 *     + 0 evil on team                        → +1 per proposal (clean pick)
 *     + 1+ evil on team, proposal approved    → -2 per evil-slot (infected, went through)
 *     + 1+ evil on team, proposal rejected    → -0.5 per evil-slot (team caught it, milder)
 *   EVIL leader picks a team with:
 *     + 1+ evil on team, approved             → +1 per evil-slot (smuggled teammates)
 *     + 0 evil on team (forced all-good)      → -1 per proposal (own-goal)
 *     + rejected proposal                     → 0  (no information transferred)
 *
 * Notes:
 *   - Oberon is counted as "evil on team" (he IS evil) even though the
 *     rest of evil doesn't know him — that's a game-state fact.
 *   - Merlin-on-team / Percival-on-team bonuses belong to Phase 2.5
 *     Information factor and are intentionally ignored here.
 *   - Missing voteHistoryPersisted → empty scores → caller falls back to
 *     legacy ELO.
 */

export interface ProposalFactorResult {
  /** Per-player raw score; positive = good proposals, negative = bad. */
  scores: Record<string, number>;
  /** Number of proposals each player (as leader) made. Debug / telemetry. */
  proposalCounts: Record<string, number>;
}

/**
 * Compute the Proposal factor for a completed game.
 */
export function computeProposalFactor(
  record: GameRecord
): ProposalFactorResult {
  const scores: Record<string, number> = {};
  const proposalCounts: Record<string, number> = {};

  const voteHistory = record.voteHistoryPersisted;
  if (!voteHistory || voteHistory.length === 0) {
    return { scores, proposalCounts };
  }

  const teamByPlayer = new Map<string, 'good' | 'evil' | null>();
  for (const p of record.players) {
    teamByPlayer.set(p.playerId, p.team);
  }

  for (const vote of voteHistory) {
    const leader = vote.leader;
    const leaderTeam = teamByPlayer.get(leader) ?? null;
    if (!leaderTeam) continue; // defensive: unknown leader

    proposalCounts[leader] = (proposalCounts[leader] ?? 0) + 1;

    const evilSlots = vote.team.filter(
      (pid) => teamByPlayer.get(pid) === 'evil'
    ).length;

    const delta = computeProposalDelta({
      leaderTeam,
      evilSlots,
      approved: vote.approved,
    });

    scores[leader] = (scores[leader] ?? 0) + delta;
  }

  return { scores, proposalCounts };
}

/**
 * Score a single proposal. Exported so unit tests can grill the heuristic
 * in isolation without building a full GameRecord fixture.
 */
export function computeProposalDelta(args: {
  leaderTeam: 'good' | 'evil';
  evilSlots: number;
  approved: boolean;
}): number {
  const { leaderTeam, evilSlots, approved } = args;

  if (leaderTeam === 'good') {
    if (evilSlots === 0) return 1;           // clean pick
    if (approved) return -2 * evilSlots;     // infected + approved
    return -0.5 * evilSlots;                 // infected + rejected
  }

  // leaderTeam === 'evil'
  if (evilSlots === 0) return -1;             // forced all-good own-goal
  if (approved) return 1 * evilSlots;         // smuggled teammates
  return 0;                                    // rejected evil pick
}

/**
 * Phase 2.5 hook — calibrate a proposal score with the actual quest
 * outcome (infected-but-succeeded suggests the evil slot threw success).
 * Stub now so downstream wire-up can reference the signature.
 *
 * @internal
 */
export function _questOutcomeAdjustment(
  _proposal: VoteRecord,
  _quest: QuestRecord | undefined
): number {
  return 0;
}
