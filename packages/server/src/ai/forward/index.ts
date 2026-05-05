/**
 * Forward reasoning — Wave E PR1 public surface.
 *
 * Edward Round 6 grill (2026-04-29):
 *   forward reasoning = THINKING MODE built on baseline building blocks.
 *
 * PR1 ships ONLY the read-side (Step 1 解讀 + ToM reverse engine).
 * Decisions still live in HeuristicAgent — PR2 wires those to consume
 * the InterpretationResult, PR3 wires the trace.
 */

export {
  interpret,
  extractFacts,
  InterpretationModule,
} from './InterpretationModule';

export {
  reverseEngineerMind,
  normalizeRoleDist,
  projectObsFromSeat,
  predictRoleDist,
  ALL_ROLES,
  ROLE_PRIOR_EPSILON,
} from './ToMReverseEngine';

export type {
  Facts,
  MindState,
  RoleProbDistribution,
  InterpretationResult,
} from './types';

// Wave E PR2 — decision-side wiring.
export {
  ForwardAgent,
  USE_FORWARD_REASONING,
  evaluatePurposes,
  scoreCandidate,
  computeRoleBias,
  computePurposeAlignment,
  PURPOSE_KEYS,
  zeroPurposeVector,
  normalizePurpose,
  roundT,
  lerp,
  getForwardTelemetry,
  resetForwardTelemetry,
} from './ForwardAgent';

export type {
  PurposeVector,
  Candidate,
  CandidateSignals,
  ReasoningTrace,
  ForwardDecision,
  DecisionType,
} from './ForwardAgent';

// 6 角色 Phase 2 (2026-05-05) — per-role override layer.
export {
  getRoleSignals,
  applyRoleBias,
  scoreWizardAsMerlin,
  detectMerlinHidingFromAssassin,
  detectMorganaBetrayal,
} from './RoleStrategy';

export type {
  RoleSignals,
  RoleBiasDelta,
} from './RoleStrategy';
