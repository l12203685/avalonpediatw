import { GameRecord } from './GameHistoryRepository';

/**
 * MisdirectionFactor — #54 Phase 2.5 per-event attribution
 *
 * Measures how effectively EVIL-side players misled the group into wrong
 * decisions via vote patterns and quest-team smuggling.
 *
 * Edward's 2026-04-20 factor list (priority #3):
 *   "紅方誤導效果（發言/投票誘導藍）"
 *
 * Signal intent (heuristic, chat-free):
 *
 *   (a) Vote camouflage — per vote, per evil player:
 *         approves clean team (0 evil)              → +0.25 (looks good, low risk)
 *         approves infected team (>=1 evil)         → +0.5  (smuggles teammates)
 *         rejects clean team                        → -0.5  (obvious sabotage vote)
 *         rejects infected team                     →  0    (reasonable self-protect)
 *
 *   (b) Clean-looking fail — per quest that evil was on AND failed:
 *         team composition had exactly 1 evil       → +2  (ambiguous, blame-shifting)
 *         team composition had >=2 evil             → +0.5 (obvious sabotage)
 *     Rationale: a single evil on a quest that fails is the hardest to
 *     identify in post-mortem; multi-evil fails are forensically obvious.
 *
 *   (c) Post-approval quest outcome correlation:
 *     Evil player who *voted approve* on an infected team that *failed* on
 *     the quest gets an extra +1 (successful stealth coordination).
 *
 * Good-team players contribute zero — their information-processing lives
 * in `InformationFactor`.
 *
 * Missing voteHistoryPersisted → only (b) runs.
 * Missing questHistoryPersisted → only (a) runs.
 * Both missing → empty scores.
 */

export interface MisdirectionFactorResult {
  /** Per-player raw score. EVIL team only. */
  scores: Record<string, number>;
  /** Per-player vote count (debug / telemetry). */
  voteCounts: Record<string, number>;
}

/**
 * Compute the Misdirection factor for a completed game.
 */
export function computeMisdirectionFactor(
  record: GameRecord
): MisdirectionFactorResult {
  const scores: Record<string, number> = {};
  const voteCounts: Record<string, number> = {};

  const voteHistory = record.voteHistoryPersisted;
  const questHistory = record.questHistoryPersisted;
  const hasVotes = !!voteHistory && voteHistory.length > 0;
  const hasQuests = !!questHistory && questHistory.length > 0;

  if (!hasVotes && !hasQuests) {
    return { scores, voteCounts };
  }

  const teamByPlayer = new Map<string, 'good' | 'evil' | null>();
  for (const p of record.players) {
    teamByPlayer.set(p.playerId, p.team);
  }

  const evilPlayers = record.players.filter((p) => p.team === 'evil');
  if (evilPlayers.length === 0) {
    return { scores, voteCounts };
  }

  // (a) Vote camouflage — only if we have votes.
  if (hasVotes && voteHistory) {
    for (const vote of voteHistory) {
      const evilSlots = vote.team.filter(
        (pid) => teamByPlayer.get(pid) === 'evil'
      ).length;

      for (const evilPlayer of evilPlayers) {
        const voted = vote.votes?.[evilPlayer.playerId];
        if (voted === undefined) continue;

        voteCounts[evilPlayer.playerId] =
          (voteCounts[evilPlayer.playerId] ?? 0) + 1;

        const delta = computeMisdirectionVoteDelta({
          approved: voted,
          teamHasEvil: evilSlots >= 1,
        });
        if (delta !== 0) {
          scores[evilPlayer.playerId] =
            (scores[evilPlayer.playerId] ?? 0) + delta;
        }
      }
    }
  }

  // (b) Clean-looking fail — only if we have quests.
  if (hasQuests && questHistory) {
    for (const quest of questHistory) {
      if (quest.result !== 'fail') continue;

      const teamSet = new Set(quest.team);
      const evilOnTeam = evilPlayers.filter((p) => teamSet.has(p.playerId));
      if (evilOnTeam.length === 0) continue;

      const stealthBonus = computeStealthFailBonus({
        evilCountOnTeam: evilOnTeam.length,
      });
      if (stealthBonus !== 0) {
        for (const evil of evilOnTeam) {
          scores[evil.playerId] =
            (scores[evil.playerId] ?? 0) + stealthBonus;
        }
      }
    }
  }

  // (c) Post-approval coordination — needs BOTH votes and quests.
  if (hasVotes && hasQuests && voteHistory && questHistory) {
    // Build round → vote-of-approval-that-passed lookup. Multiple votes per
    // round are possible (attempts); use the last approved one (which is
    // what the quest corresponds to).
    const approvedVoteByRound = new Map<number, (typeof voteHistory)[number]>();
    for (const v of voteHistory) {
      if (v.approved) {
        approvedVoteByRound.set(v.round, v);
      }
    }

    for (const quest of questHistory) {
      if (quest.result !== 'fail') continue;
      const vote = approvedVoteByRound.get(quest.round);
      if (!vote) continue;

      const evilSlots = vote.team.filter(
        (pid) => teamByPlayer.get(pid) === 'evil'
      ).length;
      if (evilSlots < 1) continue;

      for (const evilPlayer of evilPlayers) {
        if (vote.votes?.[evilPlayer.playerId] === true) {
          scores[evilPlayer.playerId] =
            (scores[evilPlayer.playerId] ?? 0) + 1;
        }
      }
    }
  }

  return { scores, voteCounts };
}

/**
 * Single-vote misdirection delta. Exported for unit tests.
 */
export function computeMisdirectionVoteDelta(args: {
  approved: boolean;
  teamHasEvil: boolean;
}): number {
  const { approved, teamHasEvil } = args;
  if (teamHasEvil) {
    return approved ? 0.5 : 0;
  }
  return approved ? 0.25 : -0.5;
}

/**
 * Stealth-fail bonus for evil players on a failed quest. Exported for tests.
 */
export function computeStealthFailBonus(args: {
  evilCountOnTeam: number;
}): number {
  const { evilCountOnTeam } = args;
  if (evilCountOnTeam === 1) return 2;
  if (evilCountOnTeam >= 2) return 0.5;
  return 0;
}
