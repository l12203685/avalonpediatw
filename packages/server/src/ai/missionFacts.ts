/**
 * missionFacts — the one place the agent code reads a mission's `result`
 * (logic-first batch 1C, S1-1, INV-B3; docs/ai/logic_first.md).
 *
 * C5: "success" does not mean "no fail card". An R4 success in a 10-player
 * game can carry one fail card (219 of 1177 R4 missions in the 牌譜), and
 * that card still proves a red on the team (C2). So belief code never reads
 * `q.result`; it reads the fail cards through `failCards`, and the
 * `beliefCertainFacts` switch decides whether an R4 success with a card
 * counts (`beliefFailCards`). The public outcome itself (the score, what
 * the table calls "failed") is `missionFailed`, for display and for rules
 * that are about the outcome, not about camps. The static INV-B3 scan
 * (`invariants/staticScan.ts`) lets only this file read `result`.
 */

import type { QuestRecord } from './types';

type Mission = Pick<QuestRecord, 'result' | 'failCount'>;

/** Fail cards the mission showed (C2 / C5). Records without a count fall back to the outcome. */
export function failCards(q: Mission): number {
  return q.failCount ?? (q.result === 'fail' ? 1 : 0);
}

/** The mission's public outcome — the score, not a camp fact (an R4 success may still hold a fail card). */
export function missionFailed(q: Mission): boolean {
  return q.result === 'fail';
}

/**
 * Fail cards the belief code counts for `q`: with S1-1 on every card
 * (an R4 success with one proves a red, C5); off, the pre-2026-10-22
 * reading — a failed mission's cards, a success nothing.
 */
export function beliefFailCards(q: Mission, certainFacts: boolean): number {
  if (certainFacts) return failCards(q);
  return missionFailed(q) ? Math.max(1, failCards(q)) : 0;
}
