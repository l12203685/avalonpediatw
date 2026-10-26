/**
 * VisibleRedProposals — the assassination tier of batch 1G (2026-10-26;
 * practice report (b); docs/ai/logic_first.md 第 9 節), reclassified by the
 * 2026-10-26 review as a TIER-2 rule (human-likeness: a strong human
 * regularity, not an absolutely-true constraint — a real Merlin can, and
 * human Merlins sometimes do, put a red they see on their own team).
 *
 * At the assassination the assassinator (the assassin; Mordred / Morgana
 * when no assassin is dealt, `game/assassinator.ts`) knows every red seat
 * (`allEvilIds`, Oberon included) but not which of its seen teammates is
 * Mordred, the one red Merlin does not see. Human Merlins put a red they see
 * on their own team on 2.2% (R5) to 19.7% (R4) of their non-forced
 * proposals, loyal / Percival captains on 17.8–51.1% (likelihood ratio
 * 0.12–0.46 by round); at the assassination 10.5% of human Merlins carry the
 * flag against 39.5% of the other blues (LR 0.27;
 * `scripts/assassinVisibleRedStudy.ts`).
 *
 *   - `certain`   — the team holds the assassinator itself (unless it is
 *                   Mordred), Oberon, or more seen teammates than could all
 *                   be Mordred: in every role assignment the LOBBY allows
 *                   (`obs.lobbyRoles`; the standard table when absent) the
 *                   team holds a red Merlin sees;
 *   - `ambiguous` — exactly one seen teammate and nothing certain: Morgana
 *                   (seen) or Mordred (unseen), the assassinator cannot tell;
 *   - `none`      — no red the assassinator could call seen.
 *
 * `assassinVisibleRedTier` ranks every candidate who, as captain on any
 * proposal (R1 counts; the forced fifth proposal counts too since Edward
 * 2026-10-26「先把派了可見紅方的人排除在選項外」— a forced captain still picks
 * the team, and human Merlins avoid seen reds there too, LR 0.18),
 * proposed a `certain` team strictly below every candidate who never did: a
 * lexicographic tier on top of the scores, never a hard exclusion (when
 * every candidate did it, the scores decide alone).
 *
 * `assassinVisibleRedLikelihood` (soft): each non-forced `ambiguous` lead
 * multiplies the candidate's odds by the likelihood ratio of exactly that
 * event, the ratio of the two MIXED RATES —
 *   (p·m_seen + (1 − p)·m_unseen) / (p·o_seen + (1 − p)·o_unseen),
 * m / o = the rate of a lead holding exactly the Morgana (seen) / exactly
 * the Mordred (unseen) among Merlin / loyal-or-Percival captains, p = the
 * chance the teammate is the seen one ((k − 1) / k with k seen teammates,
 * exactly one of them Mordred). At p = ½ (the standard roster) it is the
 * measured LR of the ambiguous class (R1 1.25, R2 1.64, R3 1.03, R4 1.51,
 * R5 1.01). Batch 1G averaged two whole-team ratios instead (½ LR(visible) +
 * ½ LR(not visible): R1 1.18 … R5 0.70); withdrawn 2026-10-26.
 *
 * Default OFF since the 2026-10-26 review: the assassination model already
 * has features for exactly these leads (`ledWithAllyRate`, `ledCleanCount`),
 * so an unconditional ratio on top counts the same evidence twice, and out
 * of sample it adds nothing to the tier (study (c), docs 第 9 節: 2-fold
 * cross-fitted mean ln P(Merlin) −1.2825 vs −1.2796 for the tier alone; the
 * residual β given the model's score is unstable, 0.20 / 0.97 by fold). When
 * switched on it adds ln LR to the model's linear score (a log-probability
 * up to a constant); the legacy heuristic, whose score has no fitted scale,
 * never applies it. It stays for the Stage-2 retrain, where the split
 * Morgana / Mordred lead becomes a model feature.
 *
 * Pure functions of the assassinator's own observation; no ground truth.
 */

import { AVALON_CONFIG } from '@avalon/shared';
import type { PlayerObservation, VoteRecord } from '../types';

/** What Merlin sees, from the assassinator's seat. */
export interface MerlinSight {
  /** Reds Merlin surely sees (the assassinator unless Mordred, Oberon; every teammate when no Mordred can hide among them). */
  certain: ReadonlySet<string>;
  /** Seen teammates among whom exactly one (Mordred) is invisible to Merlin. */
  ambiguous: readonly string[];
}

/** Whether a Mordred is dealt: the lobby roles when known, else the standard table. */
export function mordredInLobby(obs: Pick<PlayerObservation, 'lobbyRoles' | 'playerCount'>): boolean {
  if (obs.lobbyRoles && obs.lobbyRoles.length > 0) return obs.lobbyRoles.includes('mordred');
  return AVALON_CONFIG[obs.playerCount]?.roles.includes('mordred') ?? false;
}

/**
 * Merlin sees every red but Mordred. At the assassination the reds show
 * each other their cards (`allEvilRoles`, Edward 2026-10-26), so the
 * assassinator knows exactly who Merlin sees. Without the roles (older
 * observations) it knows the whole roster (`allEvilIds`) but not which seen
 * teammate is Mordred — the fallback below. Whether a Mordred is dealt at all comes from the lobby roles
 * (2026-10-26; it came from the standard table, so with Mordred switched off
 * both seen teammates were treated as ambiguous).
 * (Moved from `HeuristicAgent.merlinSightFromAssassin`, 2026-10-14 S1-11.)
 */
export function merlinSightFromAssassin(obs: PlayerObservation): MerlinSight {
  // 刺殺階段紅方開牌相認 (Edward 2026-10-26): the assassinator knows every red's role, so Merlin's
  // sight is exact — every red but Mordred. Nothing is ambiguous.
  if (obs.allEvilRoles) {
    const certain = new Set(Object.entries(obs.allEvilRoles).filter(([, role]) => role !== 'mordred').map(([id]) => id));
    return { certain, ambiguous: [] };
  }
  const self = obs.myPlayerId;
  const teammates = obs.knownEvils.filter((id) => id !== self);
  const all = new Set<string>(obs.allEvilIds ?? [...teammates, self]);
  const certain = new Set<string>();
  const selfIsMordred = (obs.myRole as string) === 'mordred';
  if (!selfIsMordred) certain.add(self);
  for (const id of all) if (id !== self && !teammates.includes(id)) certain.add(id); // Oberon
  if (!mordredInLobby(obs) || selfIsMordred) {
    for (const id of teammates) certain.add(id);
    return { certain, ambiguous: [] };
  }
  // A lone teammate is Mordred himself (invisible); otherwise exactly one of them is.
  return { certain, ambiguous: teammates.length >= 2 ? teammates : [] };
}

export type VisibleRedClass = 'certain' | 'ambiguous' | 'none';

/** At most one Mordred hides among the ambiguous teammates. */
export function classifyTeamForAssassin(team: readonly string[], sight: MerlinSight): VisibleRedClass {
  if (team.some((id) => sight.certain.has(id))) return 'certain';
  const mates = team.filter((id) => sight.ambiguous.includes(id)).length;
  if (mates >= 2) return 'certain';
  return mates === 1 ? 'ambiguous' : 'none';
}

/** The first round whose proposals count (R1 counts: human Merlins avoid seen reds in R1 too). */
export const VISIBLE_RED_FIRST_ROUND = 1;

/**
 * Non-forced blue leads holding exactly one of the assassin's two teammates
 * and nothing certain, by which one (human replays, 1970 10-player games,
 * `scripts/assassinVisibleRedStudy.ts` (a), 2026-10-26): `seen` = the
 * Morgana, `unseen` = the Mordred, `n` = all non-forced leads of the group;
 * `merlin` = Merlin captains, `other` = loyal and Percival captains.
 */
export const AMBIGUOUS_LEAD_RATES: Readonly<Record<number, {
  merlin: { seen: number; unseen: number; n: number };
  other: { seen: number; unseen: number; n: number };
}>> = Object.freeze({
  1: { merlin: { seen: 30, unseen: 468, n: 1546 }, other: { seen: 452, unseen: 559, n: 3913 } },
  2: { merlin: { seen: 58, unseen: 532, n: 1538 }, other: { seen: 340, unseen: 550, n: 3811 } },
  3: { merlin: { seen: 14, unseen: 298, n: 1214 }, other: { seen: 291, unseen: 486, n: 3128 } },
  4: { merlin: { seen: 16, unseen: 136, n: 508 }, other: { seen: 92, unseen: 143, n: 1189 } },
  5: { merlin: { seen: 2, unseen: 48, n: 278 }, other: { seen: 39, unseen: 75, n: 639 } },
});

/**
 * The likelihood ratio of one ambiguous lead in `round` when its teammate is
 * the seen one with probability `pSeen`: the ratio of the mixed rates (module
 * doc). 1 for an unknown round.
 */
export function ambiguousLeadMultiplier(round: number, pSeen: number): number {
  const t = AMBIGUOUS_LEAD_RATES[round];
  if (!t) return 1;
  const m = (pSeen * t.merlin.seen + (1 - pSeen) * t.merlin.unseen) / t.merlin.n;
  const o = (pSeen * t.other.seen + (1 - pSeen) * t.other.unseen) / t.other.n;
  return o > 0 && m > 0 ? m / o : 1;
}

export interface VisibleRedEvidence {
  /** Rounds of the non-forced proposals this candidate led with a `certain` seen red. */
  certainRounds: number[];
  /** Rounds of the non-forced proposals this candidate led with an `ambiguous` one. */
  ambiguousRounds: number[];
  /** 1 = certainly proposed a seen red (ranked below every 0). */
  tier: 0 | 1;
  /** ln of the product of `ambiguousLeadMultiplier` over `ambiguousRounds` (ln-odds). */
  logLikelihood: number;
}

/** Leads the tier counts: every proposal from R1 on, the forced fifth included (Edward 2026-10-26). */
function countsForTier(v: VoteRecord): boolean {
  return v.round >= VISIBLE_RED_FIRST_ROUND;
}

/** Leads the soft factor counts: non-forced only (its rates were measured on non-forced leads). */
function countsForLikelihood(v: VoteRecord): boolean {
  return v.attempt < 5 && countsForTier(v);
}

/** Per-candidate evidence from the assassinator's observation. */
export function visibleRedEvidence(
  obs: PlayerObservation,
  candidates: readonly string[],
): Map<string, VisibleRedEvidence> {
  const sight = merlinSightFromAssassin(obs);
  const out = new Map<string, VisibleRedEvidence>();
  for (const id of candidates) out.set(id, { certainRounds: [], ambiguousRounds: [], tier: 0, logLikelihood: 0 });
  for (const v of obs.voteHistory) {
    const e = out.get(v.leader);
    if (!e || !countsForTier(v)) continue;
    const k = classifyTeamForAssassin(v.team, sight);
    if (k === 'certain') {
      e.certainRounds.push(v.round);
      e.tier = 1;
    } else if (k === 'ambiguous' && countsForLikelihood(v)) {
      e.ambiguousRounds.push(v.round);
      // One of k seen teammates, exactly one of whom is Mordred: seen with (k − 1) / k.
      const pSeen = (sight.ambiguous.length - 1) / sight.ambiguous.length;
      e.logLikelihood += Math.log(ambiguousLeadMultiplier(v.round, pSeen));
    }
  }
  return out;
}

export interface VisibleRedOptions {
  tier: boolean;
  /** Add `logLikelihood` to the scores (a log-probability scale: the model path only). */
  likelihood: boolean;
}

/**
 * The candidates the tier keeps: every candidate who never certainly
 * proposed a seen red, or — when every candidate did — all of them.
 */
export function tierCandidates(
  candidates: readonly string[],
  evidence: ReadonlyMap<string, VisibleRedEvidence>,
): string[] {
  const clean = candidates.filter((id) => (evidence.get(id)?.tier ?? 0) === 0);
  return clean.length > 0 ? clean : [...candidates];
}

/**
 * Pick among `candidates` by `scores` (the model's linear score, a
 * log-probability up to a constant) with the batch-1G adjustments: the soft
 * factor adds `logLikelihood`, the tier restricts to `tierCandidates`.
 * Ties: seat order.
 */
export function pickWithVisibleRed(
  obs: PlayerObservation,
  candidates: readonly string[],
  scores: ReadonlyMap<string, number>,
  opts: VisibleRedOptions,
): string {
  if (candidates.length === 0) throw new Error('pickWithVisibleRed: no candidates');
  const evidence = visibleRedEvidence(obs, candidates);
  const pool = opts.tier ? tierCandidates(candidates, evidence) : [...candidates];
  const order = new Map(obs.allPlayerIds.map((id, i) => [id, i]));
  const score = (id: string): number =>
    (scores.get(id) ?? 0) + (opts.likelihood ? evidence.get(id)?.logLikelihood ?? 0 : 0);
  let best = pool[0];
  for (const id of pool.slice(1)) {
    const a = score(id);
    const b = score(best);
    if (a > b || (a === b && (order.get(id) ?? 0) < (order.get(best) ?? 0))) best = id;
  }
  return best;
}

/** Softmax of `logScores` over `candidates`, optionally with the soft factor (for the explanation text). */
export function adjustedProbabilities(
  obs: PlayerObservation,
  candidates: readonly string[],
  logScores: ReadonlyMap<string, number>,
  likelihood: boolean,
): Map<string, number> {
  const evidence = visibleRedEvidence(obs, candidates);
  const raw = candidates.map((id) => (logScores.get(id) ?? 0) + (likelihood ? evidence.get(id)?.logLikelihood ?? 0 : 0));
  const max = Math.max(...raw);
  const exps = raw.map((s) => Math.exp(s - max));
  const z = exps.reduce((a, b) => a + b, 0);
  return new Map(candidates.map((id, i) => [id, exps[i] / z]));
}
