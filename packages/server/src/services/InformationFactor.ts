import { Role } from '@avalon/shared';
import { GameRecord } from './GameHistoryRepository';

/**
 * InformationFactor — #54 Phase 2.5 per-event attribution
 *
 * Measures how effectively GOOD-side information roles (Merlin / Percival)
 * and plain loyal players steered the group toward correct decisions by
 * voting / being-on-team in patterns consistent with their private info.
 *
 * Edward's 2026-04-20 factor list (priority #1):
 *   "梅林/派西 資訊釋放品質（藏得好/壞）"
 *
 * Signal intent (lightweight heuristic; full signal needs chat / reveal
 * parsing which Phase 2 doesn't persist):
 *
 *   For each vote in voteHistoryPersisted, for each GOOD player:
 *     approves a team with >=1 evil slot            → -0.5   (bad info use)
 *     rejects a team with >=1 evil slot             → +0.5   (good info use)
 *     approves a clean (0 evil) team                → +0.25  (consistent)
 *     rejects a clean team                          → -0.25  (noise / paranoia)
 *
 *   Extra weight for Merlin / Percival (they hold hidden info):
 *     The base delta is multiplied by MERLIN_INFO_MULTIPLIER / PERCIVAL_INFO_MULTIPLIER
 *     so their vote pattern dominates the factor as intended.
 *
 *   Assassination miss bonus (on assassination_failed outcome):
 *     Merlin who *survived* → +2 (successfully hid) — awarded once per game.
 *     Merlin who got assassinated → -2 (leaked) — awarded once per game.
 *
 * Evil players are ignored entirely — their information-warfare lives in
 * `MisdirectionFactor`.
 *
 * Design notes:
 *   - Using vote patterns as a proxy for "information release quality" is
 *     admittedly crude. Phase 3 backtest will tune the coefficients; the
 *     intent here is to have a non-zero signal that correlates with "Merlin
 *     who correctly flagged the infected team" vs "Merlin who just voted
 *     with the crowd".
 *   - Oberon is evil, so he's skipped here (his team doesn't know him, but
 *     he still counts as evil for evilSlot math inside ProposalFactor and
 *     MisdirectionFactor; Information is good-only).
 *   - If voteHistoryPersisted is missing / empty → returns empty scores.
 */

const MERLIN_INFO_MULTIPLIER = 2.0;
const PERCIVAL_INFO_MULTIPLIER = 1.5;
const LOYAL_INFO_MULTIPLIER = 1.0;
const ASSASSINATION_SURVIVAL_BONUS = 2;

export interface InformationFactorResult {
  /** Per-player raw score. GOOD team only. */
  scores: Record<string, number>;
  /** Per-player vote count (debug / telemetry). */
  voteCounts: Record<string, number>;
}

/**
 * Compute the Information factor for a completed game.
 */
export function computeInformationFactor(
  record: GameRecord
): InformationFactorResult {
  const scores: Record<string, number> = {};
  const voteCounts: Record<string, number> = {};

  const voteHistory = record.voteHistoryPersisted;
  if (!voteHistory || voteHistory.length === 0) {
    return { scores, voteCounts };
  }

  const teamByPlayer = new Map<string, 'good' | 'evil' | null>();
  const roleByPlayer = new Map<string, Role | null>();
  for (const p of record.players) {
    teamByPlayer.set(p.playerId, p.team);
    roleByPlayer.set(p.playerId, p.role);
  }

  // Iterate each completed vote. Only GOOD voters contribute.
  for (const vote of voteHistory) {
    const evilSlots = vote.team.filter(
      (pid) => teamByPlayer.get(pid) === 'evil'
    ).length;

    for (const [voterId, approved] of Object.entries(vote.votes ?? {})) {
      const team = teamByPlayer.get(voterId);
      if (team !== 'good') continue;

      voteCounts[voterId] = (voteCounts[voterId] ?? 0) + 1;

      const role = roleByPlayer.get(voterId) ?? null;
      const multiplier = roleMultiplier(role);

      const base = computeInformationVoteDelta({
        approved,
        teamHasEvil: evilSlots >= 1,
      });

      const delta = base * multiplier;
      if (delta !== 0) {
        scores[voterId] = (scores[voterId] ?? 0) + delta;
      }
    }
  }

  // Assassination outcome bonus / penalty for Merlin (lives at game level,
  // not per-vote — apply once using the record's winReason).
  const reason = (record.winReason ?? '').toLowerCase();
  const merlinPlayer = record.players.find((p) => p.role === 'merlin');
  if (merlinPlayer) {
    const mid = merlinPlayer.playerId;
    if (
      reason.includes('assassination_failed') ||
      reason.includes('assassination_timeout')
    ) {
      scores[mid] = (scores[mid] ?? 0) + ASSASSINATION_SURVIVAL_BONUS;
    } else if (
      reason.includes('assassination_success') ||
      reason.includes('merlin_assassinated') ||
      reason.includes('刺殺梅林') ||
      reason.includes('刺中梅林')
    ) {
      scores[mid] = (scores[mid] ?? 0) - ASSASSINATION_SURVIVAL_BONUS;
    }
  }

  return { scores, voteCounts };
}

/**
 * Score a single GOOD-side vote. Exported for unit tests.
 */
export function computeInformationVoteDelta(args: {
  approved: boolean;
  teamHasEvil: boolean;
}): number {
  const { approved, teamHasEvil } = args;
  if (teamHasEvil) {
    return approved ? -0.5 : 0.5;
  }
  return approved ? 0.25 : -0.25;
}

/**
 * Role-based multiplier for Information factor. Exported for tests.
 */
export function roleMultiplier(role: Role | null): number {
  if (role === 'merlin') return MERLIN_INFO_MULTIPLIER;
  if (role === 'percival') return PERCIVAL_INFO_MULTIPLIER;
  return LOYAL_INFO_MULTIPLIER;
}
