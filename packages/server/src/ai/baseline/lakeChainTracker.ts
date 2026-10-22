/**
 * Lake declaration chain tracker — Edward 2026-04-28 Wave B core.
 *
 * Implements the 4 hard rules over the public lake declaration record
 * (Wave A schema `LakePublicRecord`):
 *
 *   硬1 (transitivity):    A 湖 B 宣藍 → C 派票選 A 必選 B
 *   硬2 (anti-transitivity): A 湖 B 宣紅 → C 派票選 A 必不選 B
 *   硬3 (rank order):      A 湖 B 宣藍 → A.tier ≤ B.tier (替 B 背書)
 *   硬4 (chain best-path): 首湖藍 → 持續湖到藍 → 末局決定
 *
 * Pyramid layer 3: 湖中宣告 (declarations) — public but defeatable
 * by built-in or mission ground truth. Within layer 3, declarations
 * ARE constrained by these 4 hard rules. (The old "cycle of mutual
 * claims" violator tagging was removed 2026-10-14: the lake path rule
 * makes such cycles impossible — see `analyzeLakeChain`.)
 *
 * Pure module: input is `obs.lakeHistory`; output is a struct of
 * derived facts (declarationsAsBlue, declarationsAsRed, violators).
 * No memory, no shared state.
 *
 * Red exception (Q11): callers (HeuristicAgent.voteOnTeam etc.)
 * decide whether to apply the hard rules to themselves. This module
 * does not enforce policy — it surfaces violators.
 */

import type { PlayerObservation, LakePublicRecord, VoteRecord } from '../types';
import { CertaintyView, certaintyParamsFor, enumerateWorlds } from '../belief/Certainty';
import { defaultBeliefOptions, type BeliefOptions } from '../belief/BeliefOptions';
import { missionFailed } from '../missionFacts';

// ── Derived chain state ─────────────────────────────────────────
/**
 * Output of `analyzeLakeChain`. All maps key by playerId.
 */
export interface LakeChainState {
  /** holderId → set of targetIds that holder declared blue. */
  declaredBlueByHolder: Map<string, Set<string>>;
  /** holderId → set of targetIds that holder declared red. */
  declaredRedByHolder: Map<string, Set<string>>;
  /** targetId → set of holderIds who declared this target blue. */
  declaredBlueByTarget: Map<string, Set<string>>;
  /** targetId → set of holderIds who declared this target red. */
  declaredRedByTarget: Map<string, Set<string>>;
  /**
   * Always empty since 2026-10-14 (S1-11): declarations cannot contradict
   * each other under the lake path rule; kept for the existing readers.
   */
  violators: Set<string>;
  /** All public declarations in chronological order. */
  records: readonly LakePublicRecord[];
}

const EMPTY_STATE: LakeChainState = {
  declaredBlueByHolder: new Map(),
  declaredRedByHolder: new Map(),
  declaredBlueByTarget: new Map(),
  declaredRedByTarget: new Map(),
  violators: new Set(),
  records: [],
};

// ── Analyze ────────────────────────────────────────────────────
/**
 * Build the full chain state from `obs.lakeHistory` (Wave A schema).
 * Undeclared lakes (`declaredClaim: 'none'`, S1-9c) carry no claim and
 * are left out, exactly as before they appeared in the observation.
 *
 * 2026-10-14 (S1-11, logic_audit.md F13): the "cycle SAT" detection that
 * used to fill `violators` is gone. It could not fire — a lake target can
 * never be an earlier holder (path rule C7; 0 of 1970 replayed games) —
 * and its three-step rule was wrong anyway ("A→B blue, B→C blue, C→A red"
 * is consistent with A red, B and C blue, so tagging C was unfounded).
 * Contradictions with the fail counts, the role sight and A0 are now the
 * certainty layer's job (`belief/Certainty.ts`, the L1-empty fallback).
 * `violators` stays in the state (always empty) for the existing readers.
 *
 * `undefined` / empty `lakeHistory` returns the empty state.
 */
export function analyzeLakeChain(
  obs: PlayerObservation,
): LakeChainState {
  const records = (obs.lakeHistory ?? []).filter((rec) => rec.declaredClaim !== 'none');
  if (records.length === 0) return EMPTY_STATE;

  const declaredBlueByHolder = new Map<string, Set<string>>();
  const declaredRedByHolder = new Map<string, Set<string>>();
  const declaredBlueByTarget = new Map<string, Set<string>>();
  const declaredRedByTarget = new Map<string, Set<string>>();

  const addTo = (
    map: Map<string, Set<string>>,
    key: string,
    val: string,
  ): void => {
    const set = map.get(key) ?? new Set<string>();
    set.add(val);
    map.set(key, set);
  };

  for (const rec of records) {
    if (rec.declaredClaim === 'good') {
      addTo(declaredBlueByHolder, rec.holderId, rec.targetId);
      addTo(declaredBlueByTarget, rec.targetId, rec.holderId);
    } else {
      addTo(declaredRedByHolder, rec.holderId, rec.targetId);
      addTo(declaredRedByTarget, rec.targetId, rec.holderId);
    }
  }

  return {
    declaredBlueByHolder,
    declaredRedByHolder,
    declaredBlueByTarget,
    declaredRedByTarget,
    violators: new Set<string>(),
    records,
  };
}

// ── Hard rule check API ────────────────────────────────────────
/**
 * Is including `targetId` on a team led by `leaderId` consistent with
 * 硬1 + 硬2?
 *
 *   硬1: leader L 湖 B 宣藍 → 派 L 必含 B
 *        (a clean leader vouches for their declared-blue → MUST include)
 *   硬2: leader L 湖 B 宣紅 → 派 L 不可含 B
 *        (declaring B red while picking B = obvious contradiction)
 *
 * Returns:
 *   - 'must_include' — leader declared target blue, but team excludes target
 *   - 'must_exclude' — leader declared target red, but team includes target
 *   - 'ok' — no hard-rule conflict for this leader×target×team
 */
export function checkHardRulesForLeader(
  state: LakeChainState,
  leaderId: string,
  targetId: string,
  teamIncludesTarget: boolean,
): 'must_include' | 'must_exclude' | 'ok' {
  const blueTargets = state.declaredBlueByHolder.get(leaderId);
  const redTargets = state.declaredRedByHolder.get(leaderId);

  if (blueTargets?.has(targetId) && !teamIncludesTarget) {
    return 'must_include';
  }
  if (redTargets?.has(targetId) && teamIncludesTarget) {
    return 'must_exclude';
  }
  return 'ok';
}

/**
 * Does the proposed team violate 硬1 / 硬2 from the leader's POV?
 *
 * Concretely: for the team's leader, gather all of their lake
 * declarations and check each against the proposed roster:
 *   - Every declared-blue target MUST be on the team
 *   - Every declared-red target MUST NOT be on the team
 *
 * If either invariant breaks, we return the offending pair so the
 * caller (vote / select logic) can either reject the team (good side)
 * or apply the red exception (Q11).
 */
export function findHardRuleViolations(
  state: LakeChainState,
  leaderId: string,
  proposedTeam: readonly string[],
): Array<{ rule: 1 | 2; leaderId: string; targetId: string }> {
  const out: Array<{ rule: 1 | 2; leaderId: string; targetId: string }> = [];
  const teamSet = new Set(proposedTeam);

  const blueTargets = state.declaredBlueByHolder.get(leaderId) ?? new Set();
  for (const t of blueTargets) {
    if (!teamSet.has(t)) out.push({ rule: 1, leaderId, targetId: t });
  }
  const redTargets = state.declaredRedByHolder.get(leaderId) ?? new Set();
  for (const t of redTargets) {
    if (teamSet.has(t)) out.push({ rule: 2, leaderId, targetId: t });
  }
  return out;
}

// ── 硬1+硬2 universal team check (Edward 2026-04-29 post-fix) ───
/**
 * Universal hard-rule sweep: scan EVERY team member as a potential
 * holder of past lake declarations. The hard rules apply transitively —
 * if Player A on the team previously declared B blue, then any team
 * containing A must also contain B (硬1), regardless of who is leading
 * this round. Likewise A's declared-red targets must NOT be on the
 * same team as A (硬2).
 *
 * Edward 2026-04-29 verbatim:
 *   「[硬1] A 湖 B 宣藍 → C 派票選 A, 必選 B (傳遞性)」
 *   「[硬2] A 湖 B 宣紅 → C 派票選 A, 必不可選 B」
 *
 * Pre-fix (Wave B) bug: `findHardRuleViolations` only scanned the
 * current leader's own declarations — a team picking a third party
 * who had previously taken the lake bypassed the rule entirely. The
 * universal sweep is the correct enforcement.
 *
 * Returns one entry per (holder, target, rule) violation. Empty array
 * means the team passes all 硬1+硬2 checks.
 */
export function findTeamHardRuleViolations(
  state: LakeChainState,
  proposedTeam: readonly string[],
): Array<{ rule: 1 | 2; holderId: string; targetId: string }> {
  const out: Array<{ rule: 1 | 2; holderId: string; targetId: string }> = [];
  const teamSet = new Set(proposedTeam);

  for (const holder of teamSet) {
    const blueTargets = state.declaredBlueByHolder.get(holder);
    if (blueTargets) {
      for (const t of blueTargets) {
        if (!teamSet.has(t)) out.push({ rule: 1, holderId: holder, targetId: t });
      }
    }
    const redTargets = state.declaredRedByHolder.get(holder);
    if (redTargets) {
      for (const t of redTargets) {
        if (teamSet.has(t)) out.push({ rule: 2, holderId: holder, targetId: t });
      }
    }
  }
  return out;
}

// ── 硬3 rank check ─────────────────────────────────────────────
/** The marker value of a 硬3 flag in `findRule3Violators` (rule (a)). */
export const RULE3_FLAG = 0.85;
/** Legacy only: the weak clause (b) marker. */
export const RULE3_WEAK_FLAG = 0.5;
/**
 * S1-2 (GM decision D10): the likelihood ratio of a post-lake omission —
 * P(omission | red holder) / P(omission | blue holder). Point estimate on
 * the 牌譜 about 18 (critique §3 row 7: 3 of 398 blue-led post-lake teams
 * vs 38 of 285 red-led), 95% interval about 6–86; the conservative lower
 * bound is used (`pyramidScorer` turns it into an odds update).
 */
export const RULE3_LIKELIHOOD_RATIO = 6;

/**
 * 硬3 (替 B 背書 → A 較低層): if A declared B blue, A's tier ≤ B's
 * tier. We approximate "tier" as suspicion direction — if A is later
 * observed acting like a higher-tier red (e.g. proposing tainted
 * teams or rejecting clean ones) while having endorsed B, that's a
 * 硬3 violation.
 *
 * Returns holderIds (A) who declared blue on any target B and whose own
 * subsequent leader behaviour contradicts the endorsement, mapped to a
 * marker: `RULE3_FLAG` (0.85) for rule (a), `RULE3_WEAK_FLAG` (0.5) for
 * the legacy clause (b). The pyramid turns the marker into a score.
 *
 * **`opts.rule3PostLake` on (S1-2, 2026-10-22, logic_audit.md F1 / F2,
 * critique X2 / X4 / X5; INV-H3a / INV-H3b):**
 *   - only teams A led *after* the declaration count — the cut is the
 *     declaration's round (before the lake A did not know B's camp, T1 /
 *     T3; pre-lake omissions have a likelihood ratio of 1.16 on the 牌譜,
 *     post-lake ones about 18);
 *   - the omission must be strictly dominated from A's own seat at that
 *     moment: the team holds, besides A, a seat A (if good) could not be
 *     sure was good — then swapping that seat for B (whom A saw blue)
 *     raises P(team all good) strictly. A team of seats A can prove good
 *     without B is a tie, not a violation (X4). Whether A itself was on
 *     the team does not matter (X2). "What A could be sure of" is the
 *     public record cut at that proposal plus A's own declarations as A's
 *     lake results, under A0 (L1; L0 when A0 leaves no world);
 *   - clause (b) ("led a team that later failed", unrelated to the
 *     endorsement and double-counted with layer 4) is gone.
 *
 * **Off (legacy, before 2026-10-22):** every team A ever led counts, (a)
 * fires on any omission, (b) marks a holder who led a team that failed.
 *
 * `setRule3DiagnosticOptions` (benchmark scripts): `off` and
 * `holderFilter` apply to both paths; `postLakeOnly` only changes the
 * legacy path (the cut is built in on the new one).
 */
export function findRule3Violators(
  state: LakeChainState,
  obs: PlayerObservation,
  opts: Readonly<Pick<BeliefOptions, 'rule3PostLake' | 'certainFacts'>> = defaultBeliefOptions(),
): Map<string, number> {
  const score = new Map<string, number>();
  const diag = rule3Diagnostics;
  if (diag?.off) return score;
  for (const [holder, blueSet] of state.declaredBlueByHolder) {
    if (diag?.holderFilter && !diag.holderFilter(holder)) continue;
    for (const target of blueSet) {
      const declaredRound = Math.min(...state.records
        .filter((r) => r.holderId === holder && r.targetId === target && r.declaredClaim === 'good')
        .map((r) => r.round));
      if (opts.rule3PostLake) {
        for (const rec of obs.voteHistory) {
          if (rec.leader !== holder || rec.round <= declaredRound || rec.team.includes(target)) continue;
          if (omissionStrictlyDominated(state, obs, holder, rec)) {
            score.set(holder, RULE3_FLAG);
            break;
          }
        }
        continue;
      }
      // (b) holder later led a team that failed — endorsed B but led
      // a tainted team → semantic 硬3 weak violation.
      const cutRound = diag?.postLakeOnly ? declaredRound : Number.NEGATIVE_INFINITY;
      const leaderRecords = obs.voteHistory.filter(
        (v) => v.leader === holder && v.round > cutRound,
      );
      for (const rec of leaderRecords) {
        const failedQ = obs.questHistory.find(
          (q) => q.round === rec.round && missionFailed(q),
        );
        if (failedQ && failedQ.team.every((id) => rec.team.includes(id))) {
          score.set(holder, Math.max(score.get(holder) ?? 0, RULE3_WEAK_FLAG));
        }
      }
      // (a) A is leader and excluded the endorsed B from their team
      // (room permitting). This is 硬1 violation territory; we boost
      // the holder's suspicion to ≥0.85 per pyramid spec.
      for (const rec of leaderRecords) {
        if (rec.team.length >= 1 && !rec.team.includes(target)) {
          score.set(holder, Math.max(score.get(holder) ?? 0, RULE3_FLAG));
        }
      }
    }
  }
  return score;
}

/**
 * S1-2 strict dominance (X2 / X4) at the time of `rec`: does the team
 * `holder` led hold a seat other than the holder that the holder — taken
 * as a good player with the public record as it stood before that
 * proposal and its own declarations as its lake results — could not be
 * sure was good? Everything the viewer knows privately is left out: this
 * is a judgement about what the holder knew (T1).
 */
function omissionStrictlyDominated(
  state: LakeChainState,
  obs: PlayerObservation,
  holder: string,
  rec: VoteRecord,
): boolean {
  const asHolder: PlayerObservation = {
    ...obs,
    myPlayerId: holder,
    myRole: 'loyal',
    myTeam: 'good',
    knownEvils: [],
    knownWizards: undefined,
    allEvilIds: undefined,
    currentRound: rec.round,
    voteHistory: obs.voteHistory.filter((v) => v.round < rec.round || (v.round === rec.round && v.attempt < rec.attempt)),
    questHistory: obs.questHistory.filter((q) => q.round < rec.round),
    questResults: obs.questResults.slice(0, Math.max(0, rec.round - 1)),
    lakeHistory: (obs.lakeHistory ?? []).filter((l) => l.round < rec.round),
    myLakeResults: state.records
      .filter((l) => l.holderId === holder && l.round < rec.round && l.declaredClaim !== 'none')
      .map((l) => ({ round: l.round, targetId: l.targetId, result: l.declaredClaim as 'good' | 'evil' })),
  };
  const params = certaintyParamsFor(asHolder);
  let worlds = enumerateWorlds(asHolder, { self: 'good', sight: false, ownLakeResults: true, lakes: true }, params);
  if (worlds.length === 0) {
    worlds = enumerateWorlds(asHolder, { self: 'good', sight: false, ownLakeResults: true, lakes: false }, params);
  }
  const view = new CertaintyView(asHolder, worlds, worlds, params);
  return rec.team.some((id) => id !== holder && !view.isCertGood(id, 'L1'));
}

// ── Diagnostic ablations (benchmark scripts only) ───────────────
/**
 * 2026-10-13 round 2 (docs/ai/strength_benchmark.md 第 8 節): knobs the
 * self-play diagnosis script (`scripts/redLakeDiagnosis.ts`) uses to
 * measure how much of a result runs through 硬3. Never set by the server
 * or the agents; `undefined` (the default) leaves `findRule3Violators`
 * exactly as documented above.
 *   - `off`          — no 硬3 flags at all;
 *   - `holderFilter` — only holders for which it returns true can be
 *                      flagged (e.g. only the red ones, using the hidden
 *                      roles the harness knows);
 *   - `postLakeOnly` — only teams the holder led after the declaration
 *                      count (rule (a) and (b)).
 */
export interface Rule3DiagnosticOptions {
  off?: boolean;
  holderFilter?: (holderId: string) => boolean;
  postLakeOnly?: boolean;
}

let rule3Diagnostics: Rule3DiagnosticOptions | undefined;

/** Benchmark scripts only: set (or clear with `undefined`) the 硬3 ablation. */
export function setRule3DiagnosticOptions(options: Rule3DiagnosticOptions | undefined): void {
  rule3Diagnostics = options;
}
