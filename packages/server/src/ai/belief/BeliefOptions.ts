/**
 * BeliefOptions — the logic-first batch 1C switches as the belief code reads
 * them (2026-10-22; docs/ai/logic_first.md 第 1C 節, plan §2.1 S1-1 / S1-2 /
 * S1-3 / S1-9a).
 *
 * The pyramid (`baseline/pyramidScorer.ts`) and everything that feeds it
 * (`suspectInference`, `voteInferer`, `lakeChainTracker`), the ToM /
 * interpretation modules, `RoleStrategy`, `TeamReuse` and the public-history
 * scorers of `LakePolicy` are pure functions of an observation. They take an
 * optional `BeliefOptions` so a legacy agent, a benchmark variant and the
 * production default can coexist in one process (the self-play strength
 * benchmark plays both in the same game). Agents derive theirs once from
 * their `AgentTuning` (`beliefOptionsFrom`); callers without a tuning get
 * the production default plus the `AVALON_TUNING_*` environment
 * (`defaultBeliefOptions`), exactly as `LakePolicy` does with
 * `getDefaultAgentTuning()`.
 *
 *   - `certainFacts`    S1-1 `beliefCertainFacts`: certainty-layer pins and
 *                       C2 counting by fail cards (`failCount`, never `result`).
 *   - `rule3PostLake`   S1-2 `rule3PostLakeOnly`: 硬3 after the lake only,
 *                       strict dominance, no clause (b), likelihood ratio 6.
 *   - `chainProjection` S1-3 `beliefChainProjection`: s(C) ≤ s(B) ≤ s(A)
 *                       along declared-blue chains, s(A) + s(B) ≥ 1 for a
 *                       declared-red pair.
 *   - `forcedVotesZero` S1-9a `forcedVoteZeroBits`: the synthetic votes of
 *                       the forced fifth proposal carry no information.
 */

import { getDefaultAgentTuning, type AgentTuning } from '../AgentTuning';

export interface BeliefOptions {
  certainFacts: boolean;
  rule3PostLake: boolean;
  chainProjection: boolean;
  forcedVotesZero: boolean;
  /**
   * `worldShareBelief` (2026-10-28, optimization loop round 1): a good viewer's suspicion = its share of the
   * certainty layer's consistent worlds (L1*) — rules and conventions only. On the R3 self-play decisions the
   * pyramid scored 1.01 bits of log loss (a constant guess: 0.99), the world share 0.82
   * (`scripts/beliefCalibration.ts`). Optional: absent = off.
   */
  worldShare?: boolean;
  /**
   * `bayesBelief` (2026-10-28, stage-3 belief engine): a good viewer's suspicion = the Bayes posterior over the
   * consistent worlds with the human-record action likelihoods (`BayesBelief.ts`). Wins over `worldShare`.
   */
  bayes?: boolean;
  /** `bayesThumbRoles`: Percival reads its thumbs with the Merlin / Morgana tables (`BayesOptions.thumbRoles`). */
  bayesThumbRoles?: boolean;
  /** `percivalThumbLogic`: Percival reads its good thumb as a strict Merlin (`BayesOptions.strictMerlin`). */
  percivalThumbLogic?: boolean;
  /** `loyalMerlinRead`: loyals read one of the blues as Merlin (`BayesOptions.merlinMixture`, 0 / 1 / 2). */
  loyalMerlinRead?: number;
  /** `merlinZoneSignal`: read Merlin's R1–R2 proposals as zone cuts (`BayesOptions.zoneMerlin`). */
  merlinZoneSignal?: boolean;
  /** `merlinLoyalStyle`: read the Merlin candidate's R1–R2 proposals strictly (`BayesOptions.merlinEarlyStrict`). */
  merlinLoyalStyle?: boolean;
}

export type BeliefTuning = Pick<
  AgentTuning,
  'beliefCertainFacts' | 'rule3PostLakeOnly' | 'beliefChainProjection' | 'forcedVoteZeroBits' | 'worldShareBelief' | 'bayesBelief' | 'bayesThumbRoles' | 'percivalThumbLogic' | 'loyalMerlinRead' | 'merlinZoneSignal' | 'merlinLoyalStyle'
>;

/** Every switch off: the belief code before 2026-10-22. */
export const LEGACY_BELIEF_OPTIONS: Readonly<BeliefOptions> = Object.freeze({
  certainFacts: false,
  rule3PostLake: false,
  chainProjection: false,
  forcedVotesZero: false,
});

/** The belief switches of an agent tuning. */
export function beliefOptionsFrom(tuning: BeliefTuning): BeliefOptions {
  return {
    certainFacts: tuning.beliefCertainFacts,
    rule3PostLake: tuning.rule3PostLakeOnly,
    chainProjection: tuning.beliefChainProjection,
    forcedVotesZero: tuning.forcedVoteZeroBits,
    worldShare: tuning.worldShareBelief,
    bayes: tuning.bayesBelief,
    bayesThumbRoles: tuning.bayesThumbRoles,
    percivalThumbLogic: tuning.percivalThumbLogic,
    loyalMerlinRead: tuning.loyalMerlinRead,
    merlinZoneSignal: tuning.merlinZoneSignal,
    merlinLoyalStyle: tuning.merlinLoyalStyle,
  };
}

/** Production default + `AVALON_TUNING_*` (re-read on every call, like `getDefaultAgentTuning`). */
export function defaultBeliefOptions(): BeliefOptions {
  return beliefOptionsFrom(getDefaultAgentTuning());
}

/** The forced fifth proposal: no vote was held, the record is synthetic (S1-9a). */
export function isForcedVoteRecord(record: { attempt: number }): boolean {
  return record.attempt >= 5;
}
