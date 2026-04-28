/**
 * Baseline tools — Edward 2026-04-28 Wave B.
 *
 * Public surface re-exported for `HeuristicAgent` and tests.
 */

export {
  getFailedMissionSuspects,
  getOuterWhiteApprovers,
  getLoyalSuspectSet,
} from './suspectInference';

export {
  analyzeLakeChain,
  checkHardRulesForLeader,
  findHardRuleViolations,
  findRule3Violators,
  type LakeChainState,
} from './lakeChainTracker';

export {
  scoreFromVotePattern,
  scoreFromTeamPick,
  combineLayer4,
  layer4Score,
} from './voteInferer';

export {
  computePyramidScores,
  rankBySuspicion,
  PYRAMID_NEUTRAL,
  PYRAMID_HARD_RED,
  PYRAMID_HARD_BLUE,
  PYRAMID_VIOLATOR_FLOOR,
  type PyramidScores,
} from './pyramidScorer';
