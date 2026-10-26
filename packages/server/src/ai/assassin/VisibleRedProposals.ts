/**
 * VisibleRedProposals — the assassination tier of logic-first batch 1G
 * (2026-10-26; practice report (b); docs/ai/logic_first.md 第 9 節).
 *
 * At the assassination the assassin knows every red seat (`allEvilIds`,
 * Oberon included) but not which of its two seen teammates is Mordred, the
 * one red Merlin does not see. A blue captain who put a red that Merlin
 * surely sees on their own team has acted against what Merlin knows: human
 * Merlins do it on 2.2% (R5) to 19.7% (R4) of their non-forced proposals,
 * loyal / Percival captains on 17.8–51.1% (likelihood ratio 0.12–0.46 by
 * round; `scripts/assassinVisibleRedStudy.ts`).
 *
 *   - `certain`   — the team holds the assassin or Oberon, or more of the
 *                   seen teammates than could all be Mordred (both of them):
 *                   in every role assignment the lobby allows, the team holds
 *                   a red Merlin sees;
 *   - `ambiguous` — the team holds exactly one seen teammate and nothing
 *                   certain: Morgana (seen) or Mordred (unseen), the assassin
 *                   cannot tell;
 *   - `none`      — no red the assassin could call seen.
 *
 * `assassinVisibleRedTier` ranks every candidate who, as captain on a
 * non-forced proposal (the forced fifth proposal is excluded; R1 counts —
 * human Merlins avoid seen reds in R1 too, LR 0.12), proposed a `certain`
 * team strictly below every candidate who never did: a lexicographic tier on
 * top of the scores, never a hard exclusion (when every candidate did it,
 * the scores decide alone). `assassinVisibleRedLikelihood` multiplies a
 * candidate's probability, for each non-forced `ambiguous` proposal they led,
 * by the measured likelihood ratio mixed over what the assassin cannot tell:
 * p·LR_seen(round) + (1 − p)·LR_unseen(round), where p = the chance the one
 * teammate on the team is seen (½ with two seen teammates, exactly one of
 * them Mordred) and LR_seen / LR_unseen = P(team holds / does not hold a seen
 * red | Merlin captain) / P(same | loyal or Percival captain)
 * (`VISIBLE_RED_LEAD_LR`).
 *
 * Pure functions of the assassin's own observation; no ground truth.
 */

import { AVALON_CONFIG } from '@avalon/shared';
import type { PlayerObservation, VoteRecord } from '../types';

/** What Merlin sees, from the assassin's seat. */
export interface MerlinSight {
  /** Reds Merlin surely sees (the assassin itself, Oberon; every teammate when no Mordred can hide among them). */
  certain: ReadonlySet<string>;
  /** Seen teammates among whom exactly one (Mordred) is invisible to Merlin. */
  ambiguous: readonly string[];
}

/**
 * Merlin sees every red but Mordred. The assassin knows the whole roster at
 * the assassination (`allEvilIds`) but not which seen teammate is Mordred.
 * (Moved from `HeuristicAgent.merlinSightFromAssassin`, 2026-10-14 S1-11.)
 */
export function merlinSightFromAssassin(obs: PlayerObservation): MerlinSight {
  const self = obs.myPlayerId;
  const teammates = obs.knownEvils.filter((id) => id !== self);
  const all = new Set<string>(obs.allEvilIds ?? [...teammates, self]);
  const certain = new Set<string>();
  const selfIsMordred = (obs.myRole as string) === 'mordred';
  if (!selfIsMordred) certain.add(self);
  for (const id of all) if (id !== self && !teammates.includes(id)) certain.add(id); // Oberon
  const mordredInGame = AVALON_CONFIG[obs.playerCount]?.roles.includes('mordred') ?? false;
  if (!mordredInGame || selfIsMordred) {
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
 * Likelihood ratios, per round, of a non-forced lead by a Merlin captain vs a
 * loyal or Percival captain: `seen` = the team holds a red Merlin sees
 * (assassin, Morgana, Oberon), `unseen` = it does not. Human replays (1970
 * games, `scripts/assassinVisibleRedStudy.ts`, 2026-10-26); Merlin / other
 * seen rates R1 7.6% / 58.6%, R2 18.9% / 60.0%, R3 8.4% / 48.8%,
 * R4 22.8% / 50.5%, R5 2.9% / 23.9%.
 */
export const VISIBLE_RED_LEAD_LR: Readonly<Record<number, { seen: number; unseen: number }>> = Object.freeze({
  1: { seen: 0.130, unseen: 2.231 },
  2: { seen: 0.314, unseen: 2.028 },
  3: { seen: 0.172, unseen: 1.790 },
  4: { seen: 0.453, unseen: 1.558 },
  5: { seen: 0.120, unseen: 1.277 },
});

/** The soft factor of one ambiguous lead in `round` when its teammate is seen with probability `pSeen`. */
export function ambiguousLeadMultiplier(round: number, pSeen: number): number {
  const lr = VISIBLE_RED_LEAD_LR[round];
  if (!lr) return 1;
  return pSeen * lr.seen + (1 - pSeen) * lr.unseen;
}

export interface VisibleRedEvidence {
  /** Rounds of the non-forced proposals this candidate led with a `certain` seen red. */
  certainRounds: number[];
  /** Rounds of the non-forced proposals this candidate led with an `ambiguous` one. */
  ambiguousRounds: number[];
  /** 1 = certainly proposed a seen red (ranked below every 0). */
  tier: 0 | 1;
  /** ln of the product of `ambiguousLeadMultiplier` over `ambiguousRounds`. */
  logLikelihood: number;
}

function counts(v: VoteRecord): boolean {
  return v.attempt < 5 && v.round >= VISIBLE_RED_FIRST_ROUND;
}

/** Per-candidate evidence from the assassin's observation. */
export function visibleRedEvidence(
  obs: PlayerObservation,
  candidates: readonly string[],
): Map<string, VisibleRedEvidence> {
  const sight = merlinSightFromAssassin(obs);
  const out = new Map<string, VisibleRedEvidence>();
  for (const id of candidates) out.set(id, { certainRounds: [], ambiguousRounds: [], tier: 0, logLikelihood: 0 });
  for (const v of obs.voteHistory) {
    const e = out.get(v.leader);
    if (!e || !counts(v)) continue;
    const k = classifyTeamForAssassin(v.team, sight);
    if (k === 'certain') {
      e.certainRounds.push(v.round);
      e.tier = 1;
    } else if (k === 'ambiguous') {
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
 * Pick among `candidates` by `logScores` (a log-probability up to a constant:
 * the model's linear score, or the heuristic's Merlin score read the same
 * way) with the batch-1G adjustments: the likelihood adds
 * `logLikelihood`, the tier restricts to `tierCandidates`. Ties: seat order.
 */
export function pickWithVisibleRed(
  obs: PlayerObservation,
  candidates: readonly string[],
  logScores: ReadonlyMap<string, number>,
  opts: VisibleRedOptions,
): string {
  if (candidates.length === 0) throw new Error('pickWithVisibleRed: no candidates');
  const evidence = visibleRedEvidence(obs, candidates);
  const pool = opts.tier ? tierCandidates(candidates, evidence) : [...candidates];
  const order = new Map(obs.allPlayerIds.map((id, i) => [id, i]));
  const score = (id: string): number =>
    (logScores.get(id) ?? 0) + (opts.likelihood ? evidence.get(id)?.logLikelihood ?? 0 : 0);
  let best = pool[0];
  for (const id of pool.slice(1)) {
    const a = score(id);
    const b = score(best);
    if (a > b || (a === b && (order.get(id) ?? 0) < (order.get(best) ?? 0))) best = id;
  }
  return best;
}

/** Softmax of `logScores` over `candidates` with the likelihood adjustment (for the explanation text). */
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
