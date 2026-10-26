/**
 * Invariant harness context (logic-first plan §5.2): the certainty views of
 * a deciding seat's observation, cached per observation object, plus the
 * ground truth a source may attach for diagnostic columns only (never for
 * the invariant verdicts, which read the seat's own observation).
 */

import type { Role } from '@avalon/shared';
import type { PlayerObservation } from '../types';
import { buildCertainty, buildPublicCertainty, type CertaintyView } from '../belief/Certainty';

const ownCache = new WeakMap<PlayerObservation, CertaintyView>();
const publicCache = new WeakMap<PlayerObservation, CertaintyView>();

/** The deciding seat's certainty view (L0 / L1 / L1*). */
export function certaintyOf(obs: PlayerObservation): CertaintyView {
  let v = ownCache.get(obs);
  if (!v) { v = buildCertainty(obs); ownCache.set(obs, v); }
  return v;
}

/** The public picture of `obs` (no private knowledge, no camp for the viewer). */
export function publicCertaintyOf(obs: PlayerObservation): CertaintyView {
  let v = publicCache.get(obs);
  if (!v) { v = buildPublicCertainty(obs); publicCache.set(obs, v); }
  return v;
}

/** Hidden roles of a game (replay record or self-play deal); diagnostics only. */
export interface Truth {
  roles: ReadonlyMap<string, Role>;
  evil: ReadonlySet<string>;
}

const EVIL: ReadonlySet<string> = new Set(['assassin', 'morgana', 'mordred', 'oberon', 'minion']);

export function truthFromRoles(roles: ReadonlyMap<string, Role>): Truth {
  const evil = new Set<string>();
  for (const [id, r] of roles) if (EVIL.has(r)) evil.add(id);
  return { roles, evil };
}

/** The forced fifth proposal of a round (no vote is held; its record is synthetic). */
export function isForcedProposal(obs: PlayerObservation): boolean {
  return obs.failCount >= 4;
}

/**
 * The observation as it stood right after the lake of `round` was declared
 * (missions up to `round`, lakes up to and including that round, votes up
 * to that mission) — used to judge a claim with what the table knew then.
 */
export function cutAtLake(obs: PlayerObservation, round: number): PlayerObservation {
  return {
    ...obs,
    questHistory: obs.questHistory.filter((q) => q.round <= round),
    voteHistory: obs.voteHistory.filter((v) => v.round <= round),
    lakeHistory: (obs.lakeHistory ?? []).filter((l) => l.round < round),
    questResults: obs.questResults.slice(0, round),
  };
}
