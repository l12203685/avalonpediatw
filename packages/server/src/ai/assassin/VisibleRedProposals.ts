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

/**
 * Leads the tier counts: every proposal from R1 on, the forced fifth included (Edward 2026-10-26).
 * `ignoreDoomed` (`AgentTuning.assassinIgnoreDoomed`, optimization loop round 2 candidate B — changes that
 * ruling): the non-forced R1–R2 proposals the normal votes always reject do not count —
 * the counter to 派拇指躲刺. Edward 2026-10-28 amended the ruling: on by default.
 */
function countsForTier(v: VoteRecord, ignoreDoomed = false): boolean {
  if (ignoreDoomed && v.round <= 2 && v.attempt < 5) return false;
  return v.round >= VISIBLE_RED_FIRST_ROUND;
}

/**
 * Round 19 (red) `assassinReuseRead`: whether proposal `v` re-proposes a successful mission team — round 3+, non-forced,
 * red short of two fails at the time, the whole team of an earlier successful mission on it, and a red Merlin may see
 * on it — every such red sat on that mission (a clean re-proposal is left to the reads as before). The norm after a successful mission (Edward 2026-11-01:
 * 照派成功的隊算順應局勢; `merlinReuseNorm=3` since round 18): loyal and Merlin captains both do it, so the seen red it
 * carries says nothing about the captain. The assassinator's mirror of `MerlinLoyalStyle.merlinReuseProposal`.
 */
export function successfulTeamReuse(obs: PlayerObservation, v: VoteRecord, sight: MerlinSight = merlinSightFromAssassin(obs)): boolean {
  if (v.round < 3 || v.attempt >= 5) return false;
  if (obs.questResults.slice(0, v.round - 1).filter((r) => r === 'fail').length >= 2) return false;
  const seen = v.team.filter((id) => sight.certain.has(id) || sight.ambiguous.includes(id));
  if (seen.length === 0) return false;
  return obs.questHistory.some((q) => q.round < v.round && obs.questResults[q.round - 1] === 'success'
    && q.team.every((id) => v.team.includes(id)) && seen.every((id) => q.team.includes(id)));
}

/** Leads the soft factor counts: non-forced only (its rates were measured on non-forced leads). */
function countsForLikelihood(v: VoteRecord, ignoreDoomed = false): boolean {
  return v.attempt < 5 && countsForTier(v, ignoreDoomed);
}

/** Per-candidate evidence from the assassinator's observation. */
export function visibleRedEvidence(
  obs: PlayerObservation,
  candidates: readonly string[],
  ignoreDoomed = false,
  ignoreReuse = false,
): Map<string, VisibleRedEvidence> {
  const sight = merlinSightFromAssassin(obs);
  const out = new Map<string, VisibleRedEvidence>();
  for (const id of candidates) out.set(id, { certainRounds: [], ambiguousRounds: [], tier: 0, logLikelihood: 0 });
  for (const v of obs.voteHistory) {
    const e = out.get(v.leader);
    if (!e || !countsForTier(v, ignoreDoomed)) continue;
    if (ignoreReuse && successfulTeamReuse(obs, v, sight)) continue;
    const k = classifyTeamForAssassin(v.team, sight);
    if (k === 'certain') {
      e.certainRounds.push(v.round);
      e.tier = 1;
    } else if (k === 'ambiguous' && countsForLikelihood(v, ignoreDoomed)) {
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
  /** `countsForTier`'s `ignoreDoomed`. */
  ignoreDoomed?: boolean;
  /** Round 19 `assassinReuseRead`: re-proposals of a successful mission team do not count (`successfulTeamReuse`). */
  ignoreReuse?: boolean;
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
  const evidence = visibleRedEvidence(obs, candidates, opts.ignoreDoomed ?? false, opts.ignoreReuse ?? false);
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

/**
 * Round 19 `assassinReuseRead=2`: the observation the assassination model reads its captain features from, with every
 * blue captain's re-proposal of a successful mission team (`successfulTeamReuse`) unattributed (leader `''`), so
 * `ledWithSelfRate` / `ledWithAllyRate` / `ledCleanCount` stop reading the norm as a tell. Votes, teams and missions
 * stay as they were.
 */
export function withoutReuseLeaders(obs: PlayerObservation, reds: ReadonlySet<string>): PlayerObservation {
  const sight = merlinSightFromAssassin(obs);
  let changed = false;
  const voteHistory = obs.voteHistory.map((v) => {
    if (reds.has(v.leader) || !successfulTeamReuse(obs, v, sight)) return v;
    changed = true;
    return { ...v, leader: '' };
  });
  return changed ? { ...obs, voteHistory } : obs;
}

/**
 * Round 19 `assassinReuseRead=3`: the leads where `candidate` passed over the re-proposal Merlin's norm makes
 * (`merlinReuseNorm`: R2 after a successful R1, R3+ the latest successful mission while red is short of two fails;
 * only when that team holds a red Merlin sees). A non-forced lead that does not hold that whole team is one Merlin
 * would not have made unless the public gate barred the re-proposal; loyal captains pass it over freely.
 * Returns the number of such leads.
 */
export function missedReuseLeads(obs: PlayerObservation, candidate: string, sight: MerlinSight = merlinSightFromAssassin(obs)): number {
  let n = 0;
  for (const v of obs.voteHistory) {
    if (v.leader !== candidate || v.attempt >= 5 || v.round < 2) continue;
    const before = obs.questResults.slice(0, v.round - 1);
    if (v.round >= 3 && before.filter((r) => r === 'fail').length >= 2) continue;
    const done = obs.questHistory.filter((q) => q.round < v.round && before[q.round - 1] === 'success').map((q) => q.round);
    const target = v.round === 2 ? (before[0] === 'success' ? 1 : 0) : Math.max(0, ...done);
    const t = obs.questHistory.find((q) => q.round === target);
    if (!t || !t.team.some((id) => sight.certain.has(id) || sight.ambiguous.includes(id))) continue;
    if (t.team.length > v.team.length) continue;
    if (!t.team.every((id) => v.team.includes(id))) n++;
  }
  return n;
}

/** ln of the likelihood ratio P(lead | Merlin) / P(lead | loyal) of one passed-over re-proposal (`missedReuseLeads`). */
export const MISSED_REUSE_LOG_LR = Math.log(0.25);

/** Round 21 `assassinReuseRead` 4–10: the re-proposal-norm leads of one candidate, split by round (R2 vs R3+) and outcome. */
export interface ReuseLeadCounts {
  missR2: number;
  missR3: number;
  reuseR2: number;
  reuseR3: number;
  /** The same norm when the team holds no red Merlin sees (mode 8). */
  cleanMissR2: number;
  cleanMissR3: number;
}

/**
 * Round 21 `assassinReuseRead` 4–10: the leads `missedReuseLeads` reads (the team Merlin's re-proposal norm points at —
 * R2 the successful R1, R3+ the latest successful mission while red is short of two fails —, non-forced, the lead has
 * room for that team), counted by round and by whether `candidate` passed the team over (`miss*`) or put the whole team
 * in (`reuse*`); `cleanMiss*` count the passed-over norm teams that hold no red Merlin sees.
 */
export function reuseLeadCounts(obs: PlayerObservation, candidate: string, sight: MerlinSight = merlinSightFromAssassin(obs)): ReuseLeadCounts {
  const out: ReuseLeadCounts = { missR2: 0, missR3: 0, reuseR2: 0, reuseR3: 0, cleanMissR2: 0, cleanMissR3: 0 };
  for (const v of obs.voteHistory) {
    if (v.leader !== candidate || v.attempt >= 5 || v.round < 2) continue;
    const before = obs.questResults.slice(0, v.round - 1);
    if (v.round >= 3 && before.filter((r) => r === 'fail').length >= 2) continue;
    const done = obs.questHistory.filter((q) => q.round < v.round && before[q.round - 1] === 'success').map((q) => q.round);
    const target = v.round === 2 ? (before[0] === 'success' ? 1 : 0) : Math.max(0, ...done);
    const t = obs.questHistory.find((q) => q.round === target);
    if (!t || t.team.length > v.team.length) continue;
    const reused = t.team.every((id) => v.team.includes(id));
    if (!t.team.some((id) => sight.certain.has(id) || sight.ambiguous.includes(id))) {
      if (!reused) {
        if (v.round === 2) out.cleanMissR2++;
        else out.cleanMissR3++;
      }
      continue;
    }
    if (v.round === 2) {
      if (reused) out.reuseR2++;
      else out.missR2++;
    } else if (reused) out.reuseR3++;
    else out.missR3++;
  }
  return out;
}

/**
 * Round 21 `assassinReuseRead` 4–10: likelihood ratios P(lead | Merlin) / P(lead | other blue captain) measured in
 * self-play (`reusediag21`, round-19 default, 2000 games; Merlin re-proposes every time the public gate lets him).
 * Norm team with a seen red — R2: Merlin passed it over 0 / 140 times, loyal / Percival 41 / 520 (≈ 0.05);
 * R3+: Merlin 63 / 172, others 519 / 913 (≈ 0.65). Re-proposed — R2 1.00 vs 0.92 (≈ 1.1), R3+ 0.63 vs 0.43 (≈ 1.45).
 * Clean norm team passed over — R2 1.2% vs 9.6% (≈ 0.12), R3+ 13.9% vs 19.1% (≈ 0.73).
 */
export const REUSE_LEAD_LR = {
  missR2: 0.05,
  missR3: 0.65,
  reuseR2: 1.1,
  reuseR3: 1.45,
  cleanMissR2: 0.12,
  cleanMissR3: 0.73,
} as const;

/**
 * Round 21 `assassinReuseRead` 4–10: the factors each mode multiplies per lead — passed over with a seen red
 * [R2, R3+], re-proposed [R2, R3+], passed over a clean norm team [R2, R3+] (1 = no read). 3–8 hand-set from the
 * measured ratios (`REUSE_LEAD_LR`); 9 and 10 fitted (conditional logit over the tier pool, 1,672 assassinations of
 * round-19-default self-play, label = the real Merlin): 9 refits these factors only, 10 refits them with the weights of
 * the model score, the vote read and the lead read (`REUSE_STACK_WEIGHTS`).
 */
export const REUSE_MODE_FACTORS: Readonly<Record<number, { miss: readonly [number, number]; reuse: readonly [number, number]; clean: readonly [number, number] }>> = {
  3: { miss: [0.25, 0.25], reuse: [1, 1], clean: [1, 1] },
  4: { miss: [0.25, REUSE_LEAD_LR.missR3], reuse: [1, 1], clean: [1, 1] },
  5: { miss: [REUSE_LEAD_LR.missR2, REUSE_LEAD_LR.missR3], reuse: [1, 1], clean: [1, 1] },
  6: { miss: [REUSE_LEAD_LR.missR2, 0.25], reuse: [1, 1], clean: [1, 1] },
  7: { miss: [0.25, 0.25], reuse: [REUSE_LEAD_LR.reuseR2, REUSE_LEAD_LR.reuseR3], clean: [1, 1] },
  8: { miss: [0.25, 0.25], reuse: [1, 1], clean: [REUSE_LEAD_LR.cleanMissR2, REUSE_LEAD_LR.cleanMissR3] },
  9: { miss: [0.12, 0.2], reuse: [0.65, 2.3], clean: [0.18, 0.65] },
  10: { miss: [0.14, 0.33], reuse: [1.3, 2.55], clean: [0.19, 0.8] },
  // Round 25: 9 refitted on the round-24 default (blue re-proposes the successful team as it was, `goodReuseExact=2`): 1,295
  // assassinations; passing over a clean norm team R3+ is now Merlin-ish (×1.38 — the loyal / Percival re-propose it), the R2
  // re-proposal less so (×0.34). 5-fold cross-fitted hit +1.2 [+0.2, +2.1]pp over 9 on the same data. Default since round 25.
  11: { miss: [0.12, 0.21], reuse: [0.34, 2.3], clean: [0.27, 1.38] },
  // Round 29: 11 with the R2 factors refitted on the round-28 default (`merlinReuseNoEarly`: Merlin no longer re-proposes a successful
  // R1 team holding a red he sees — 0 of 159, the other blue captains in the tier pool 503 of 512): 1,791 assassinations; the R2
  // re-proposal is now loyal-ish (×0.05), passing it over neutral-ish (×0.68). R3+ factors kept. 5-fold cross-fitted hit
  // +5.4 [+4.3, +6.4]pp over 11 on the same data.
  12: { miss: [0.68, 0.21], reuse: [0.05, 2.3], clean: [0.3, 1.38] },
};

/** Round 21 `assassinReuseRead=10`: the refitted weights of the model score, the vote read and the lead read (default 1 / 0.5 / 1). */
export const REUSE_STACK_WEIGHTS = { model: 1.4, vote: 0.75, lead: 0.57 } as const;

/**
 * Round 21 `assassinReuseRead` 4–10: the log-likelihood the re-proposal norm adds for `candidate` (`REUSE_MODE_FACTORS`):
 * 4 = passed over with a seen red R2 ×0.25 (as mode 3), R3+ ×0.65 (measured); 5 = both measured (×0.05, ×0.65);
 * 6 = R2 ×0.05, R3+ ×0.25; 7 = mode 3 plus the re-proposals themselves (×1.1, ×1.45); 8 = mode 3 plus passed-over clean
 * norm teams (×0.12, ×0.73); 9, 10 = fitted; 11 = 9 refitted on the round-24 default (round 25); 12 = 11 with the R2 factors
 * refitted on the round-28 default (round 29).
 */
export function reuseLeadLogRatio(obs: PlayerObservation, candidate: string, mode: number, sight: MerlinSight = merlinSightFromAssassin(obs)): number {
  const c = reuseLeadCounts(obs, candidate, sight);
  const f = REUSE_MODE_FACTORS[mode] ?? REUSE_MODE_FACTORS[3];
  return c.missR2 * Math.log(f.miss[0]) + c.missR3 * Math.log(f.miss[1])
    + c.reuseR2 * Math.log(f.reuse[0]) + c.reuseR3 * Math.log(f.reuse[1])
    + c.cleanMissR2 * Math.log(f.clean[0]) + c.cleanMissR3 * Math.log(f.clean[1]);
}

/**
 * Round 23 (red) `assassinDoomedRead`: whether R2 proposal `v` re-proposes the successful R1 team — the whole R1 team on it
 * and every red Merlin may see on it from that team. Merlin's R2 norm (`merlinReuseNorm`, round 17): it is the only way a
 * bot Merlin's doomed R1–R2 proposal holds a red he sees (round 22: 9.7% of Merlin's doomed proposals, all of them this).
 */
export function r2ReuseOfR1(obs: PlayerObservation, v: VoteRecord, sight: MerlinSight = merlinSightFromAssassin(obs)): boolean {
  if (v.round !== 2 || obs.questResults[0] !== 'success') return false;
  const q1 = obs.questHistory.find((q) => q.round === 1);
  if (!q1 || !q1.team.every((id) => v.team.includes(id))) return false;
  return v.team.filter((id) => sight.certain.has(id) || sight.ambiguous.includes(id)).every((id) => q1.team.includes(id));
}

/**
 * Round 23 (red) `assassinDoomedRead` 1 / 3: the candidates who, as captain on a doomed R1–R2 proposal (non-forced, the
 * ones `assassinIgnoreDoomed` leaves out of the tier), certainly put a red Merlin sees on the team — the R2 re-proposal of
 * the successful R1 team excepted (`r2ReuseOfR1`). Round 22 measured bot Merlins never do it otherwise (`merlinLoyalStyle`
 * since round 5 keeps seen reds off; the round-1 派拇指躲刺 behind it never runs), loyal / Percival captains on ~39% of
 * those proposals. A second tier under the standard one: among `pool` (already the standard tier) keep the candidates
 * with no such lead, or all of `pool` when every one has one.
 */
export function doomedTierCandidates(obs: PlayerObservation, pool: readonly string[]): string[] {
  const sight = merlinSightFromAssassin(obs);
  const flagged = new Set<string>();
  for (const v of obs.voteHistory) {
    if (v.round > 2 || v.attempt >= 5 || !pool.includes(v.leader)) continue;
    if (classifyTeamForAssassin(v.team, sight) !== 'certain' || r2ReuseOfR1(obs, v, sight)) continue;
    flagged.add(v.leader);
  }
  const keep = pool.filter((id) => !flagged.has(id));
  return keep.length > 0 ? keep : [...pool];
}

/** Round 23 `assassinDoomedRead` 2 / 3: the lead read's ε for a doomed R1–R2 lead with a seen red (as R3+). */
export const DOOMED_LEAD_EPS = 0.05;
