import { Role } from '@avalon/shared';
import { GameRecord } from './GameHistoryRepository';

/**
 * OuterWhiteInnerBlackFactor — #54 Phase 2 per-event attribution
 *
 * "Outer-white-inner-black" (外白內黑) in Avalon refers to evil roles
 * that pass as good: Mordred (hidden from Merlin), Morgana (poses as
 * Merlin to Percival), Oberon (invisible to fellow evil, sometimes
 * sneaks onto good-looking slates).
 *
 * Edward's 2026-04-20 feedback: "in 3-red, reds who got onto quests
 * and threw fails contributed much more than reds who were blocked.
 * Smuggled-in reds should gain much more ELO; shut-out reds at most
 * get the team baseline."
 *
 * Per-quest scoring for each evil player (summed across the game):
 *   on team  & quest failed    → +3   (successful sabotage)
 *   on team  & quest succeeded → +0.5 (built trust, no fail cost)
 *   off team & quest failed    → -1   (teammate carried the play)
 *   off team & quest succeeded → 0    (no signal)
 *
 * Good-team players are ignored entirely — their contribution signal
 * lives in the Proposal factor (leader pick quality).
 *
 * Output: Record<playerId, rawScore>. Caller multiplies by
 * `EloConfig.attributionWeights.outerWhiteInnerBlack`.
 */

export interface OuterWhiteInnerBlackFactorResult {
  /** Per-player raw score. Evil team only; good players not included. */
  scores: Record<string, number>;
  /** Per-player quest appearance count (debug / telemetry). */
  questAppearances: Record<string, number>;
}

/**
 * Hidden-evil roles in the strict sense. Exported so Phase 2.5 can
 * weight these three differently from generic Minion if needed.
 */
export const OUTER_WHITE_INNER_BLACK_ROLES: ReadonlySet<Role> = new Set([
  'mordred',
  'morgana',
  'oberon',
]);

/**
 * Compute the Outer-white-inner-black factor for a completed game.
 */
export function computeOuterWhiteInnerBlackFactor(
  record: GameRecord
): OuterWhiteInnerBlackFactorResult {
  const scores: Record<string, number> = {};
  const questAppearances: Record<string, number> = {};

  const questHistory = record.questHistoryPersisted;
  if (!questHistory || questHistory.length === 0) {
    return { scores, questAppearances };
  }

  const evilPlayers = record.players.filter((p) => p.team === 'evil');
  if (evilPlayers.length === 0) {
    return { scores, questAppearances };
  }

  for (const quest of questHistory) {
    const teamSet = new Set(quest.team);
    const questFailed = quest.result === 'fail';

    for (const evilPlayer of evilPlayers) {
      const onTeam = teamSet.has(evilPlayer.playerId);

      if (onTeam) {
        questAppearances[evilPlayer.playerId] =
          (questAppearances[evilPlayer.playerId] ?? 0) + 1;
      }

      const delta = computeOwibDelta({ onTeam, questFailed });

      if (delta !== 0) {
        scores[evilPlayer.playerId] =
          (scores[evilPlayer.playerId] ?? 0) + delta;
      }
    }
  }

  return { scores, questAppearances };
}

/**
 * Score a single (quest × evil-player) cell. Extracted for unit tests.
 */
export function computeOwibDelta(args: {
  onTeam: boolean;
  questFailed: boolean;
}): number {
  const { onTeam, questFailed } = args;
  if (onTeam && questFailed) return 3;      // successful sabotage
  if (onTeam && !questFailed) return 0.5;   // trust building
  if (!onTeam && questFailed) return -1;    // teammate carried
  return 0;                                  // off-team success
}
