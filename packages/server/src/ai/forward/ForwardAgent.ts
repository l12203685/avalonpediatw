/**
 * Forward Agent — Wave E PR2 (decision-side wiring of the forward pipeline).
 *
 * Edward Round 6 grill (2026-04-29) verbatim:
 *   AI decision flow (5 steps):
 *     step 1 解讀  — interpret using baseline tools + ToM reverse engine (PR1)
 *     step 2 邏輯  — derive purpose weights from interpretation (PR2)
 *     step 3 候選  — generate candidate actions (PR2)
 *     step 4 評分  — score candidates by purpose weights (PR2)
 *     step 5 動作  — pick top-scored action (PR2)
 *
 * Wrap-not-fork (Q1=B, PR1 lock):
 *   This module wraps `HeuristicAgent` + PR1 read-side modules. We DO
 *   NOT fork or modify HeuristicAgent.selectTeam / voteOnTeam / voteOnQuest
 *   / assassinate. We DO NOT touch baseline tools / 4 hard rules / 7-role
 *   layering. ForwardAgent is gated by `USE_FORWARD_REASONING` flag and
 *   defaults OFF; the baseline path remains the canonical decision route.
 *
 * Per-role purpose weights (Edward 2026-04-29 R6 lock):
 *   藍方 (good loyal/merlin/percival/etc.):
 *     - 三藍 70% + 隱梅 30%             (loyal default)
 *     - 梅林:        三藍 50% + 隱梅 40% + 不過度排紅 10%
 *     - 派西:        找梅 50% + 隱身派西 30% + 三藍 20%
 *     - 忠臣:        三藍 80% + 找好人 20%
 *   紅方 (evil):
 *     - 刺客:  三紅 60% + 逼梅刺殺 40%
 *     - 娜:    三紅 50% + 偽裝梅林 50%
 *     - 德:    三紅 80% + 隱身躲梅 20%
 *     - 奧:    三紅 90% + 不誤殺隊友 10%   (Oberon — solo evil, no coord)
 *
 * Round-aware linear interpolation:
 *   R1 偽裝重 → R5 達成重. The "disguise" purposes (隱梅 / 偽裝梅林 /
 *   隱身派西 / 隱身躲梅) are weighted higher in early rounds and decay
 *   linearly toward late rounds. The "achieve" purposes (三藍 / 三紅 /
 *   逼梅刺殺) inversely ramp up. Interpolation factor t ∈ [0, 1] from
 *   R1 (t=0, disguise weight = 1.0) to R5 (t=1, disguise weight = 0.4).
 *
 * Determinism (Q2=A):
 *   Pure decide(obs) → action mapping. No RNG. Same observation →
 *   identical action + trace.
 *
 * Internal trace only (Q3=A trace == forward output, Q4=A internal):
 *   `decide(obs)` returns `{ action, reasoningTrace }`. Never sends
 *   anything to Discord / Edward / external IO. Caller (HeuristicAgent
 *   when flag flips on, or self-play harness) decides what to log.
 *
 * Fallback (Q1=B safety):
 *   If `interpret(obs)` throws (defensive — PR1 is pure but tests may
 *   inject corrupted observations), `decide(obs)` falls back to the
 *   wrapped `HeuristicAgent.act(obs)` and emits a `usedFallback: true`
 *   flag in the reasoning trace.
 */

import type { Role } from '@avalon/shared';
import { AVALON_CONFIG } from '@avalon/shared';
import type {
  AvalonAgent,
  PlayerObservation,
  AgentAction,
} from '../types';
import { HeuristicAgent } from '../HeuristicAgent';
import {
  interpret,
  type Facts,
  type InterpretationResult,
  type MindState,
} from './index';
import {
  computePyramidScores,
  rankBySuspicion,
  PYRAMID_VIOLATOR_FLOOR,
  type PyramidScores,
} from '../baseline';
import {
  getRoleSignals,
  applyRoleBias,
  type RoleSignals,
  type RoleBiasDelta,
} from './RoleStrategy';

// ── Feature flag ────────────────────────────────────────────────
/**
 * Edward 2026-05-03 verbatim:
 *   「Feature flag USE_FORWARD_REASONING 預設 false (PR2 ship 後 Edward
 *    試開驗證)」
 *
 * Default OFF. Flip to true to route HeuristicAgent.decide through
 * ForwardAgent. PR2 ships the module wired but inert. Edward will flip
 * the flag manually after smoke-testing locally.
 *
 * Exported as a const so tests / smoke harnesses can import + check
 * the default. To override at runtime, callers should construct a
 * ForwardAgent directly and bypass the flag.
 */
export const USE_FORWARD_REASONING = true;

// ── Edward 2026-05-06 R1-P1 banned combos (5p baseline align) ────
/**
 * Local mirror of HeuristicAgent's R1-P1 banned-combo sets, scoped to
 * the ForwardAgent path so we don't reach across module boundaries.
 *
 *   5p (pair teams)  — {'12','34','45','15'} (consecutive seats; 23
 *                       excluded per Edward 2026-05-06 16:09 校正)
 *   10p (trio teams) — {'123','150','234','678'}
 *   Other counts     — empty (no constraint)
 *
 * Edward 2026-05-06 16:09 verbatim:
 *   「23 不算無腦組合, 因為這是五人局」
 *
 * See HeuristicAgent.ts comment block "Edward 2026-04-24 batch 4 fix #1"
 * for the canonical specification + rationale.
 */
const FORWARD_BANNED_5P = new Set<string>(['12', '34', '45', '15']);
const FORWARD_BANNED_10P = new Set<string>(['123', '150', '234', '678']);

function bannedComboSetFor5p(playerCount: number): ReadonlySet<string> {
  if (playerCount === 5) return FORWARD_BANNED_5P;
  if (playerCount === 10) return FORWARD_BANNED_10P;
  return new Set<string>();
}

/**
 * Render a team's canonical ascending seat-digit string. Mirrors
 * HeuristicAgent.canonicalSeatString — see there for full convention.
 */
function canonicalSeatStringForward(
  memberIds: readonly string[],
  allPlayerIds: readonly string[],
): string {
  const indices = memberIds
    .map((id) => allPlayerIds.indexOf(id))
    .filter((idx) => idx >= 0)
    .sort((a, b) => a - b);
  return indices.map((idx) => (idx === 9 ? '0' : String(idx + 1))).join('');
}

// ── Telemetry counters (Wave E PR3 verification) ────────────────
/**
 * Module-level counters incremented inside `ForwardAgent.decide()` so
 * smoke tests / self-play harnesses can verify the forward path is
 * actually taken (vs falling back to baseline). Values are
 * process-lifetime cumulative; harnesses should snapshot before/after
 * a run. Not used for production logic.
 */
let _forwardDecideCalls = 0;
let _forwardFallbackCalls = 0;

export function getForwardTelemetry(): {
  readonly totalDecisions: number;
  readonly fallbacks: number;
  readonly forwardSuccess: number;
  readonly fallbackRate: number;
} {
  const forwardSuccess = _forwardDecideCalls - _forwardFallbackCalls;
  const fallbackRate =
    _forwardDecideCalls === 0 ? 0 : _forwardFallbackCalls / _forwardDecideCalls;
  return {
    totalDecisions: _forwardDecideCalls,
    fallbacks: _forwardFallbackCalls,
    forwardSuccess,
    fallbackRate,
  };
}

export function resetForwardTelemetry(): void {
  _forwardDecideCalls = 0;
  _forwardFallbackCalls = 0;
}

// ── Decision type union ─────────────────────────────────────────
/**
 * The decision currently facing the agent. Mirrors `obs.gamePhase`
 * exactly — kept as a separate alias so candidate generators can
 * dispatch on the value without re-reading the observation.
 *
 * Note the `assassination` phase produces an `assassinate` *action* —
 * the phase name (assassination) is the decision context; the action
 * type is `assassinate`. We mirror the phase here.
 */
export type DecisionType =
  | 'team_select'
  | 'team_vote'
  | 'quest_vote'
  | 'assassination';

// ── Purpose vector (per role) ───────────────────────────────────
/**
 * Each role has a fixed set of purposes (goals). The vector represents
 * the *current* round's weight on each purpose after round-aware
 * interpolation.
 *
 * Sum invariant: weights sum to 1.0 ± epsilon for any (role, round)
 * combination.
 *
 * Naming:
 *   - threeBlueWins   — push three blue quest wins
 *   - threeRedWins    — push three red quest wins
 *   - hideMerlin      — protect merlin's identity (good side)
 *   - findMerlin      — locate merlin (assassin / morgana side)
 *   - mimicMerlin     — pose as merlin (morgana POV)
 *   - hidePercival    — protect percival's identity (percival POV)
 *   - hideFromMerlin  — stay invisible to merlin (mordred POV)
 *   - avoidFriendlyFire — avoid voting/picking own team to fail (oberon
 *                          POV — has no teammate awareness)
 *   - findGoodTeam    — pick a clean team without merlin info
 *   - dontOverPushRed — avoid being too anti-red (merlin doesn't expose self)
 *   - forceMerlinKill — push to assassination phase (assassin late game)
 */
export interface PurposeVector {
  readonly threeBlueWins: number;
  readonly threeRedWins: number;
  readonly hideMerlin: number;
  readonly findMerlin: number;
  readonly mimicMerlin: number;
  readonly hidePercival: number;
  readonly hideFromMerlin: number;
  readonly avoidFriendlyFire: number;
  readonly findGoodTeam: number;
  readonly dontOverPushRed: number;
  readonly forceMerlinKill: number;
}

/** All purpose keys — used for vector iteration and zero-init. */
const PURPOSE_KEYS = [
  'threeBlueWins',
  'threeRedWins',
  'hideMerlin',
  'findMerlin',
  'mimicMerlin',
  'hidePercival',
  'hideFromMerlin',
  'avoidFriendlyFire',
  'findGoodTeam',
  'dontOverPushRed',
  'forceMerlinKill',
] as const satisfies ReadonlyArray<keyof PurposeVector>;

/** Build an all-zero purpose vector. */
function zeroPurposeVector(): PurposeVector {
  return {
    threeBlueWins: 0,
    threeRedWins: 0,
    hideMerlin: 0,
    findMerlin: 0,
    mimicMerlin: 0,
    hidePercival: 0,
    hideFromMerlin: 0,
    avoidFriendlyFire: 0,
    findGoodTeam: 0,
    dontOverPushRed: 0,
    forceMerlinKill: 0,
  };
}

/** Writable purpose vector — internal use during construction only. */
type MutablePurposeVector = { -readonly [K in keyof PurposeVector]: number };

/** Normalise a partial vector so its weights sum to 1.0. */
function normalizePurpose(raw: Readonly<Partial<PurposeVector>>): PurposeVector {
  let total = 0;
  for (const k of PURPOSE_KEYS) total += raw[k] ?? 0;
  if (total <= 0) {
    // Degenerate fallback: uniform across all purposes.
    const u = 1 / PURPOSE_KEYS.length;
    const out: MutablePurposeVector = zeroMutable();
    for (const k of PURPOSE_KEYS) out[k] = u;
    return out;
  }
  const out: MutablePurposeVector = zeroMutable();
  for (const k of PURPOSE_KEYS) out[k] = (raw[k] ?? 0) / total;
  return out;
}

/** Build a mutable all-zero PurposeVector for in-place construction. */
function zeroMutable(): MutablePurposeVector {
  return {
    threeBlueWins: 0,
    threeRedWins: 0,
    hideMerlin: 0,
    findMerlin: 0,
    mimicMerlin: 0,
    hidePercival: 0,
    hideFromMerlin: 0,
    avoidFriendlyFire: 0,
    findGoodTeam: 0,
    dontOverPushRed: 0,
    forceMerlinKill: 0,
  };
}

// ── Round-aware interpolation ───────────────────────────────────
/**
 * Linear interpolation factor t ∈ [0, 1] across rounds 1..5.
 *   R1 → t = 0 (early game, disguise dominates)
 *   R5 → t = 1 (late game, achievement dominates)
 *
 * Edward 2026-04-29: 「R1 偽裝重 / R5 達成重 線性插值」.
 */
function roundT(round: number): number {
  // Clamp to [1, 5].
  const r = Math.max(1, Math.min(5, round));
  return (r - 1) / 4;
}

/**
 * Blend two purpose weights by `t`:
 *   final = early * (1 - t) + late * t
 */
function lerp(early: number, late: number, t: number): number {
  return early * (1 - t) + late * t;
}

// ── Per-role purpose tables ─────────────────────────────────────
/**
 * Build the purpose vector for a given role at a given round.
 *
 * Edward 2026-04-29 lock — base weights (these are the un-interpolated
 * "achievement" anchor weights at R5 t=1). The disguise-anchor weights
 * (R1 t=0) shift mass from achievement → disguise:
 *
 *   藍方 default loyal: 三藍 70% + 隱梅 30%
 *     R1: 三藍 50% + 隱梅 50%
 *     R5: 三藍 90% + 隱梅 10%
 *   梅林: 三藍 50% + 隱梅 40% + 不過度排紅 10%
 *     R1: 三藍 30% + 隱梅 60% + 不過度排紅 10%
 *     R5: 三藍 70% + 隱梅 20% + 不過度排紅 10%
 *   派西: 找梅 50% + 隱身派西 30% + 三藍 20%
 *     R1: 找梅 30% + 隱身派西 50% + 三藍 20%
 *     R5: 找梅 70% + 隱身派西 10% + 三藍 20%
 *   忠臣: 三藍 80% + 找好人 20%
 *     (round-invariant — no disguise component)
 *   刺客: 三紅 60% + 逼梅刺殺 40%
 *     R1: 三紅 80% + 逼梅刺殺 20%
 *     R5: 三紅 40% + 逼梅刺殺 60%   (push to assassination late)
 *   娜:   三紅 50% + 偽裝梅林 50%
 *     R1: 三紅 30% + 偽裝梅林 70%
 *     R5: 三紅 70% + 偽裝梅林 30%
 *   德:   三紅 80% + 隱身躲梅 20%
 *     R1: 三紅 60% + 隱身躲梅 40%
 *     R5: 三紅 100% + 隱身躲梅 0%
 *   奧:   三紅 90% + 不誤殺隊友 10% (round-invariant — solo evil)
 */
export function evaluatePurposes(
  role: Role,
  round: number,
): PurposeVector {
  const t = roundT(round);

  // Helper to build & normalise from partial spec.
  const v = (
    early: Readonly<Partial<PurposeVector>>,
    late: Readonly<Partial<PurposeVector>>,
  ): PurposeVector => {
    const blended: MutablePurposeVector = zeroMutable();
    for (const k of PURPOSE_KEYS) {
      blended[k] = lerp(early[k] ?? 0, late[k] ?? 0, t);
    }
    return normalizePurpose(blended);
  };

  switch (role) {
    case 'merlin':
      return v(
        { threeBlueWins: 0.30, hideMerlin: 0.60, dontOverPushRed: 0.10 },
        { threeBlueWins: 0.70, hideMerlin: 0.20, dontOverPushRed: 0.10 },
      );

    case 'percival':
      return v(
        { findMerlin: 0.30, hidePercival: 0.50, threeBlueWins: 0.20 },
        { findMerlin: 0.70, hidePercival: 0.10, threeBlueWins: 0.20 },
      );

    case 'loyal':
      return v(
        { threeBlueWins: 0.50, hideMerlin: 0.50 },
        { threeBlueWins: 0.90, hideMerlin: 0.10 },
      );

    case 'minion': {
      // Legacy substitute role — treat as plain loyal-evil with three-red focus.
      return v(
        { threeRedWins: 0.70, hideFromMerlin: 0.30 },
        { threeRedWins: 1.0, hideFromMerlin: 0.0 },
      );
    }

    case 'assassin':
      return v(
        { threeRedWins: 0.80, forceMerlinKill: 0.20 },
        { threeRedWins: 0.40, forceMerlinKill: 0.60 },
      );

    case 'morgana':
      return v(
        { threeRedWins: 0.30, mimicMerlin: 0.70 },
        { threeRedWins: 0.70, mimicMerlin: 0.30 },
      );

    case 'mordred':
      return v(
        { threeRedWins: 0.60, hideFromMerlin: 0.40 },
        { threeRedWins: 1.0, hideFromMerlin: 0.0 },
      );

    case 'oberon':
      // Round-invariant: solo evil, no coordination.
      return normalizePurpose({
        threeRedWins: 0.90,
        avoidFriendlyFire: 0.10,
      });

    default: {
      // Should not happen — Role union is exhaustive. Fallback uniform.
      const _exhaustive: never = role;
      void _exhaustive;
      const out: MutablePurposeVector = zeroMutable();
      for (const k of PURPOSE_KEYS) out[k] = 1 / PURPOSE_KEYS.length;
      return out;
    }
  }
}

// ── Candidate types ─────────────────────────────────────────────
/**
 * A single candidate action with metadata used by the scorer.
 *
 * `description` is for the reasoning trace; never load-bearing.
 */
export interface Candidate {
  readonly action: AgentAction;
  readonly description: string;
  /**
   * Pre-computed signals used by `scoreCandidate`. Computed once at
   * candidate-generation time so scoring stays O(1) per candidate.
   */
  readonly signals: CandidateSignals;
}

/**
 * Quantitative signals attached to a candidate. All ∈ [0, 1] when
 * applicable; exception is `expectedFails` which is an integer count.
 */
export interface CandidateSignals {
  /** Average pyramid suspicion of all players in this team / target. */
  readonly avgSuspicion: number;
  /** Maximum pyramid suspicion of any player in this team / target. */
  readonly maxSuspicion: number;
  /** Whether at least one privately-known evil is included. */
  readonly includesKnownEvil: boolean;
  /** Whether self is included (relevant for selectTeam). */
  readonly includesSelf: boolean;
  /** Whether the candidate breaks any of the 4 lake hard rules. */
  readonly violatesLakeRules: boolean;
  /** For team_select: number of teammates known by the agent to be evil. */
  readonly numKnownEvilOnTeam: number;
  /** For assassinate: predicted P(target = merlin) from ToM. */
  readonly merlinProbForTarget: number;
}

// ── Reasoning trace ─────────────────────────────────────────────
/**
 * Output of ForwardAgent.decide(obs) — the action + a structured
 * trace that PR3 will surface in the self-play log.
 *
 * Trace is the SOURCE OF TRUTH for the agent's reasoning (Q3=A from
 * PR1 lock). HeuristicAgent's per-action explanations are independent
 * — flipping the flag also flips which trace is canonical.
 */
export interface ReasoningTrace {
  readonly decisionType: DecisionType;
  readonly purposes: PurposeVector;
  readonly candidatesEvaluated: number;
  readonly chosen: Candidate;
  readonly chosenScore: number;
  readonly usedFallback: boolean;
  readonly fallbackReason?: string;
  /** Top-line rationale string for human-readable logs. */
  readonly summary: string;
}

export interface ForwardDecision {
  readonly action: AgentAction;
  readonly reasoningTrace: ReasoningTrace;
}

// ── ForwardAgent class ──────────────────────────────────────────
/**
 * ForwardAgent — wraps a baseline `HeuristicAgent` and adds the 5-step
 * forward reasoning pipeline.
 *
 * Construction: caller may inject a pre-built `HeuristicAgent` for
 * dependency injection in tests. Default behaviour constructs a fresh
 * baseline agent with the same `agentId`.
 *
 * Public API:
 *   - `decide(obs)`     — full pipeline, returns action + trace
 *   - `act(obs)`        — convenience wrapper compatible with AvalonAgent
 *   - `onGameStart(obs)` / `onGameEnd(obs, won)` — forwarded to baseline
 *
 * `agentType` reports `'heuristic'` for harness compatibility — forward
 * reasoning is a thinking-mode wrapper, not a new agent class.
 */
export class ForwardAgent implements AvalonAgent {
  readonly agentId: string;
  readonly agentType = 'heuristic' as const;

  /** Wrapped baseline agent. Used for fallback + onGameStart/End delegation. */
  private readonly baseline: HeuristicAgent;

  constructor(agentId: string, baseline?: HeuristicAgent) {
    this.agentId = agentId;
    this.baseline = baseline ?? new HeuristicAgent(agentId);
  }

  onGameStart(obs: PlayerObservation): void {
    this.baseline.onGameStart(obs);
  }

  onGameEnd(obs: PlayerObservation, won: boolean): void {
    this.baseline.onGameEnd(obs, won);
  }

  /**
   * AvalonAgent-compatible action accessor. Delegates to `decide(obs)`
   * and returns just the action — drops the trace. Use `decide(obs)`
   * when the caller wants the reasoning trace (PR3 wiring + tests).
   */
  act(obs: PlayerObservation): AgentAction {
    return this.decide(obs).action;
  }

  /**
   * Run the full forward pipeline:
   *   1. interpret(obs)        → facts + per-other-player MindState
   *   2. evaluatePurposes(...) → role + round purpose vector
   *   3. generateCandidates    → list of feasible actions
   *   4. scoreCandidate        → score by purpose dot-product
   *   5. pickTop               → highest-scored action
   *
   * On any internal error → fallback to baseline.act(obs).
   */
  decide(obs: PlayerObservation): ForwardDecision {
    _forwardDecideCalls += 1;
    const decisionType = obs.gamePhase as DecisionType;

    // ── Edward 2026-05-05 R1-R2 force-normal vote delegation ────
    //
    // Edward 2026-04-30 18:10 verbatim:
    //   「R1R2 都先只能投正常票吧 不然這樣 bug 根本修不完 基本策略都玩不好了
    //    還一直搞花式」
    //
    // The baseline `HeuristicAgent.voteOnTeam` (line ~1561) pins R1+R2
    // votes to canonical normal (on-team approve / off-team reject) via
    // an absolute hard rule with priority chain:
    //   1. forced-mission approve (failCount >= 4)
    //   2. lake hard rules (硬1 / 硬2) reject
    //   3. leader self-approve
    //   4. R1-R2 force normal
    //
    // The ForwardAgent.decide pipeline (interpret → purposes →
    // candidates → score → pick) does NOT include this hard rule,
    // so when `USE_FORWARD_REASONING=true` (flipped 2026-05-05 commit
    // fc318fe5) the R1-R2 anomaly rate spikes (1-game self-play showed
    // R1=90% / R2=40%). Edward 2026-05-05:「Fix 必走相同 hard rule,
    // 不要 forward 自己再算一遍 (避免分歧). 推薦: ForwardAgent voteOnTeam
    // 直接 delegate 到 baseline.voteOnTeam (R1R2) + 自己只 override R3+」.
    //
    // Implementation: when the decision is `team_vote` in R1 or R2,
    // delegate the entire decision to `baseline.actDirect(obs)` (which
    // bypasses the forward-reasoning gate to avoid infinite recursion).
    // R3+ falls through to the standard forward pipeline below.
    //
    // Trace records this as a non-fallback delegation so smoke tests
    // can distinguish it from the catastrophic-error fallback path.
    if (
      decisionType === 'team_vote' &&
      (obs.currentRound ?? 1) <= 2
    ) {
      const action = this.baseline.actDirect(obs);
      const delegateCandidate: Candidate = {
        action,
        description: 'baseline R1-R2 force normal',
        signals: {
          avgSuspicion: 0,
          maxSuspicion: 0,
          includesKnownEvil: false,
          includesSelf:
            action.type === 'team_vote' && action.vote === true,
          violatesLakeRules: false,
          numKnownEvilOnTeam: 0,
          merlinProbForTarget: 0,
        },
      };
      return {
        action,
        reasoningTrace: {
          decisionType,
          purposes: zeroPurposeVector(),
          candidatesEvaluated: 1,
          chosen: delegateCandidate,
          chosenScore: 0,
          usedFallback: false,
          summary: `${decisionType} → baseline R1-R2 force normal (round=${obs.currentRound ?? 1})`,
        },
      };
    }

    // ── Edward 2026-05-06 16:09 — 派西 / 莫甘娜 on-team approve hard rule ─
    //
    // Edward 16:09 verbatim:
    //   「白癡問題 重點是自己派的組合為什麼開黑」
    //   「自己派的組合為什麼開黑」
    //
    // 派西 reject 自己被派進去的隊 = 邏輯違反 (公開分裂藍方信號).
    // 莫甘娜 mimicMerlin 但 reject 自己在的隊 = 反 mimic, 自我曝光.
    //
    // Hard rule: when 派西 or 莫甘娜 is on-team for a team_vote decision,
    // delegate to `baseline.actDirect(obs)` which fires the same hard rule
    // (HeuristicAgent.voteOnTeam line ~1700 / line ~1782). This keeps
    // ForwardAgent's R3+ pipeline aligned with baseline's hard-rule layer
    // (per Edward 2026-05-05 verbatim「Fix 必走相同 hard rule, 不要
    // forward 自己再算一遍」).
    //
    // R1-R2 path above already covers (force-normal on-team approve);
    // this gate adds R3+ on-team approve for these two roles.
    if (decisionType === 'team_vote' && (obs.currentRound ?? 1) >= 3) {
      const proposedTeam = obs.proposedTeam ?? [];
      const onTeam = proposedTeam.includes(obs.myPlayerId);
      const role = obs.myRole as string;
      if (onTeam && (role === 'percival' || role === 'morgana')) {
        const action = this.baseline.actDirect(obs);
        const delegateCandidate: Candidate = {
          action,
          description: `baseline ${role} on-team approve hard rule`,
          signals: {
            avgSuspicion: 0,
            maxSuspicion: 0,
            includesKnownEvil: false,
            includesSelf:
              action.type === 'team_vote' && action.vote === true,
            violatesLakeRules: false,
            numKnownEvilOnTeam: 0,
            merlinProbForTarget: 0,
          },
        };
        return {
          action,
          reasoningTrace: {
            decisionType,
            purposes: zeroPurposeVector(),
            candidatesEvaluated: 1,
            chosen: delegateCandidate,
            chosenScore: 0,
            usedFallback: false,
            summary: `${decisionType} → baseline ${role} on-team approve hard rule (round=${obs.currentRound ?? 1})`,
          },
        };
      }
    }

    // ── Edward 2026-05-05 22:10 assassinate delegation (Audit fix A) ─
    //
    // Audit `staging/subagent_results/assassin_merlin_bug_audit_2026-05-05.md`
    // root cause: ForwardAgent assassinate path skipped baseline's 6-signal
    // Merlin scorer (getMerlinScore + getPercivalLikenessPenalty +
    // assassinTopTierSeatPrior * h9 + seatPriorByRole + assassinTargetPenalty
    // + pyramidBoost) and only consumed the ToM 5-bucket merlinProb. Multiple
    // blue candidates landed in the same pyramid bucket → identical
    // merlinProb → strict `>` tie-break (line ~605) always selected the
    // seat-order-earliest player. Two consecutive blue-win games (g9/g17 in
    // forward_batch_20games_2026-05-05) both shot seat 1 (loyal) when real
    // Merlin sat at seat 7 / seat 3 = structural bias, not sample noise.
    //
    // Edward 22:10 verbatim:「6 應該要馬上修 並且跟著刺殺 features 一起做」.
    //
    // Fix: same delegate-to-baseline pattern as R1-R2 voteOnTeam (commit
    // de11bd28). `baseline.actDirect(obs)` recovers the 6 signals + R3+
    // hypothesised assassin reads (派西 R3+ 異白 morgana exclusion etc. is
    // handled inside `HeuristicAgent.assassinate` mistakeMap at line 2346
    // already — it filters candidates whose mistakeMap > 0, which captures
    // the H20 派西 識破 morgana cover hypothesis without bespoke wiring).
    //
    // Forward planning is otherwise undisturbed — only the single
    // assassination-phase decision delegates. trace.summary marks
    // 'assassinate-delegate' so smoke tests / batch reports can audit.
    if (decisionType === 'assassination') {
      const action = this.baseline.actDirect(obs);
      const targetId =
        action.type === 'assassinate' ? action.targetId : '';
      const delegateCandidate: Candidate = {
        action,
        description: `baseline assassinate ${targetId}`,
        signals: {
          avgSuspicion: 0,
          maxSuspicion: 0,
          includesKnownEvil: false,
          includesSelf: false,
          violatesLakeRules: false,
          numKnownEvilOnTeam: 0,
          merlinProbForTarget: 0,
        },
      };
      return {
        action,
        reasoningTrace: {
          decisionType,
          purposes: zeroPurposeVector(),
          candidatesEvaluated: 1,
          chosen: delegateCandidate,
          chosenScore: 0,
          usedFallback: false,
          summary: `${decisionType} → baseline assassinate-delegate (target=${targetId})`,
        },
      };
    }

    let interp: InterpretationResult;
    try {
      interp = interpret(obs);
    } catch (error: unknown) {
      return this.fallback(obs, decisionType, 'interpret() threw');
    }

    let purposes: PurposeVector;
    try {
      purposes = evaluatePurposes(obs.myRole, obs.currentRound);
    } catch (error: unknown) {
      return this.fallback(obs, decisionType, 'evaluatePurposes() threw');
    }

    let candidates: Candidate[];
    try {
      candidates = this.generateCandidates(decisionType, obs, interp);
    } catch (error: unknown) {
      return this.fallback(obs, decisionType, 'generateCandidates() threw');
    }

    if (candidates.length === 0) {
      return this.fallback(obs, decisionType, 'no candidates generated');
    }

    // 6 角色 Phase 2 (2026-05-05) — per-role signal package. Computed
    // once per decision; pure projection over `obs`. RoleStrategy.ts
    // owns the schema; ForwardAgent passes it through to scoreCandidate
    // unchanged. Spec: staging/subagent_results/six_roles_strategy_spec_2026-05-03.md
    let roleSignals: RoleSignals;
    try {
      roleSignals = getRoleSignals(obs);
    } catch (error: unknown) {
      return this.fallback(obs, decisionType, 'getRoleSignals() threw');
    }

    let bestIdx = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < candidates.length; i++) {
      const s = scoreCandidate(
        candidates[i],
        purposes,
        obs,
        interp,
        roleSignals,
      );
      if (s > bestScore) {
        bestScore = s;
        bestIdx = i;
      }
    }

    const chosen = candidates[bestIdx];
    const trace: ReasoningTrace = {
      decisionType,
      purposes,
      candidatesEvaluated: candidates.length,
      chosen,
      chosenScore: bestScore,
      usedFallback: false,
      summary: `${decisionType} → ${chosen.description} (score=${bestScore.toFixed(3)})`,
    };

    return { action: chosen.action, reasoningTrace: trace };
  }

  // ── Fallback to baseline ────────────────────────────────────
  private fallback(
    obs: PlayerObservation,
    decisionType: DecisionType,
    reason: string,
  ): ForwardDecision {
    _forwardFallbackCalls += 1;
    // Use `actDirect` (not `act`) to bypass the forward-reasoning gate
    // — `act` re-checks `forwardReasoningEnabled()` and would otherwise
    // re-enter ForwardAgent → infinite recursion when fallback fires
    // in production. Tests pass because vitest's ESM environment fails
    // the `require()` lazy-load and short-circuits the gate, but the
    // bug latently triggers in self-play / runtime.
    const action = this.baseline.actDirect(obs);
    const fallbackCandidate: Candidate = {
      action,
      description: 'baseline fallback',
      signals: {
        avgSuspicion: 0,
        maxSuspicion: 0,
        includesKnownEvil: false,
        includesSelf: false,
        violatesLakeRules: false,
        numKnownEvilOnTeam: 0,
        merlinProbForTarget: 0,
      },
    };
    return {
      action,
      reasoningTrace: {
        decisionType,
        purposes: zeroPurposeVector(),
        candidatesEvaluated: 1,
        chosen: fallbackCandidate,
        chosenScore: 0,
        usedFallback: true,
        fallbackReason: reason,
        summary: `${decisionType} → baseline fallback (${reason})`,
      },
    };
  }

  // ── Step 3: candidate generation ────────────────────────────
  /**
   * Build the candidate set for the current decision type.
   *
   * For `team_select`: generate up to N candidate teams using a
   * top-K-by-low-suspicion enumeration (bounded; we don't enumerate
   * all C(playerCount, teamSize) subsets).
   *
   * For `team_vote`: two candidates — approve / reject the current
   * proposed team.
   *
   * For `quest_vote`: two candidates — success / fail (only for evil
   * agents; good agents always vote success but we keep the symmetric
   * candidate set so scoring drives the choice).
   *
   * For `assassinate`: every non-self player is a candidate. (Assassin
   * may include known evils in the raw candidate list — scoring will
   * suppress them via `includesKnownEvil` signal.)
   */
  private generateCandidates(
    decisionType: DecisionType,
    obs: PlayerObservation,
    interp: InterpretationResult,
  ): Candidate[] {
    const pyramid = computePyramidScores(obs);
    switch (decisionType) {
      case 'team_select':
        return this.generateTeamSelectCandidates(obs, interp, pyramid);
      case 'team_vote':
        return this.generateTeamVoteCandidates(obs, interp, pyramid);
      case 'quest_vote':
        return this.generateQuestVoteCandidates(obs, interp, pyramid);
      case 'assassination':
        return this.generateAssassinateCandidates(obs, interp, pyramid);
    }
  }

  private generateTeamSelectCandidates(
    obs: PlayerObservation,
    interp: InterpretationResult,
    pyramid: PyramidScores,
  ): Candidate[] {
    const teamSize = AVALON_CONFIG[obs.playerCount]?.questTeams[obs.currentRound - 1];
    if (teamSize === undefined || teamSize <= 0) return [];

    const allIds = obs.allPlayerIds;
    if (allIds.length < teamSize) return [];

    // Rank everyone by ascending suspicion (least suspicious first).
    let ranked = rankBySuspicion(pyramid, obs, false);

    // 6 角色 Phase 2 (2026-05-05) — role-specific candidate filtering.
    //
    // Merlin (spec §1.4) — hard-exclude `knownEvils` from candidate pool.
    // Pyramid already pins them to suspicion=1.0 via L1 hardpin, but we
    // also remove them so even degenerate "rotate the last slot through
    // alternative picks" candidates can never include a known red.
    //
    // Percival (spec §2.4) — Edward 2026-05-06 16:09 verbatim correction:
    //   「派西維爾並非兩紅後才能鐵咬 而是認為該鐵咬就可以鐵咬」
    //   → HARD-exclude wizard B (predicted Morgana) any round any attempt
    //     when 派西 is reasonably confident in identification. Confidence
    //     is established as soon as 派西 has any voteHistory observation
    //     to differentiate the wizards (i.e. R1-P2+). For R1-P1 special
    //     case (voteHistory empty), baseline's selectPercivalTeam handles
    //     no-wizard fallback.
    //
    // Pre-fix bug: only soft-tail ranking; under candidate rotation the
    // morgana wizard could surface (esp. when ranked candidates run out).
    // Self-play 5p R3-4 example: Percival p3 picked p1 (morgana) in own
    // team → "我自己派 45 含娜" 邏輯違反 (perspective_percival.md L43-46).
    //
    // Assassin / Mordred / Morgana — keep the full pool so the scorer
    // can choose ally inclusion adaptively per round (R1 mimic-loyal,
    // R3+ ally cover).
    const role = obs.myRole;
    if (role === 'merlin') {
      const knownEvilSet = new Set(obs.knownEvils);
      ranked = ranked.filter((id) => !knownEvilSet.has(id));
    } else if (role === 'percival') {
      // Edward 2026-05-06 16:09 — HARD-exclude wizard B (predicted Morgana).
      const wizards = obs.knownWizards ?? [];
      if (wizards.length === 2) {
        // Use the same A/B split as RoleStrategy.getRoleSignals (without
        // re-running scoreWizardAsMerlin here — pyramid score is the
        // cheap proxy: lower = more merlin-like).
        const [w0, w1] = wizards;
        const s0 = pyramid.scores.get(w0) ?? 0.5;
        const s1 = pyramid.scores.get(w1) ?? 0.5;
        const bId = s0 > s1 ? w0 : w1; // higher suspicion = predicted morgana
        // R1-P1 special-case: voteHistory empty means no signal to
        // discriminate, so HeuristicAgent.selectPercivalTeam handles the
        // R1-P1 no-wizard fallback. ForwardAgent here is a parallel path
        // for R2+ — at R2+ we have signal so 鐵咬 fires.
        const isR1P1 =
          (obs.currentRound ?? 1) === 1 && obs.voteHistory.length === 0;
        if (!isR1P1) {
          // 鐵咬: hard-remove inferred-morgana wizard from candidate pool.
          ranked = ranked.filter((id) => id !== bId);
        } else {
          // R1-P1: leave wizard tail-soft (baseline path also picks neither).
          const without = ranked.filter((id) => id !== bId);
          const includesB = ranked.includes(bId);
          ranked = includesB ? [...without, bId] : without;
        }
      }
    }

    // Edward 2026-05-05 R1-R2 align-baseline invariant:
    //   Baseline `HeuristicAgent.selectTeam` ALWAYS includes self
    //   (line ~1283 good branch + line ~1317 evil branch:
    //   `[myPlayerId, ...filteredCandidates]`). When ForwardAgent
    //   produces a candidate team WITHOUT self, the downstream
    //   `voteOnTeam` step fires `leader === self → unconditional
    //   approve` (HeuristicAgent.ts line ~1500), which counts as an
    //   outer-white anomaly because the leader is off-team. To match
    //   baseline's R1-R2 zero-anomaly invariant
    //   (HeuristicAgent.r1r2_zero.test) we restrict candidate teams
    //   to ones that include self — the leader-self-approve rule
    //   then becomes on-team approve = no anomaly.
    //
    // This is enforced cross-faction (good and evil) because baseline
    // does so too. The original Candidate A "pure top-N" path was
    // self-defeating: the scorer can never approve a leader's
    // off-team selection without leaking an outer-white in R1-R2.
    //
    // Self-inclusion is enforced here at candidate generation rather
    // than as a post-pick fixup so the scorer's choice across
    // candidates remains coherent (no last-mile rewrite of the chosen
    // candidate's signals).
    const selfId = obs.myPlayerId;
    const otherRanked = ranked.filter((id) => id !== selfId);

    // Generate up to MAX_CANDIDATES candidate teams using rotation:
    //   Candidate 0: self + top-(teamSize-1) least suspicious others
    //   Candidate 1..N: rotate the LAST slot through alternative picks
    // Bounded by MAX_CANDIDATES to keep evaluation cheap.
    const MAX_CANDIDATES = 8;
    const candidates: Candidate[] = [];

    // Candidate A: self + top-(N-1) least suspicious others.
    const topN = [selfId, ...otherRanked.slice(0, teamSize - 1)];
    candidates.push(this.makeTeamSelectCandidate(topN, obs, interp, pyramid));

    // Candidate B..N: rotate the LAST slot through alternative picks
    // (always keeping self at slot 0).
    for (
      let alt = teamSize - 1;
      alt < otherRanked.length && candidates.length < MAX_CANDIDATES;
      alt++
    ) {
      const team = [
        selfId,
        ...otherRanked.slice(0, teamSize - 2),
        otherRanked[alt],
      ];
      candidates.push(this.makeTeamSelectCandidate(team, obs, interp, pyramid));
    }

    // ── Edward 2026-05-06 R1-P1 banned-combo filter (5p HR-5/HR-7) ────
    // Mirror baseline `HeuristicAgent.rewriteIfBannedR1P1Combo` semantics
    // in ForwardAgent path: filter out R1-P1 banned canonical seat
    // combos (5p: 12/23/34/45/15; 10p: 123/150/234/678). Forward picks
    // a candidate by score, so banned combos must be PHYSICALLY removed
    // from the candidate set — soft demotion (e.g. -Infinity score)
    // would still surface them when no alternative scores higher.
    //
    // R1-P1 detection: currentRound === 1 AND no prior vote attempts.
    // If after filtering the candidate set is empty (all rotations land
    // on a banned combo), keep the original list as a fallback so the
    // pipeline never collapses; baseline's enforceR1P1Ban will retry
    // the swap downstream.
    const isR1P1 = (obs.currentRound ?? 1) === 1 && obs.voteHistory.length === 0;
    if (isR1P1) {
      const bannedSet = bannedComboSetFor5p(obs.playerCount);
      if (bannedSet.size > 0) {
        const filtered = candidates.filter((c) => {
          if (c.action.type !== 'team_select') return true;
          const canonical = canonicalSeatStringForward(
            c.action.teamIds,
            obs.allPlayerIds,
          );
          return !bannedSet.has(canonical);
        });
        if (filtered.length > 0) return filtered;
      }
    }

    return candidates;
  }

  private makeTeamSelectCandidate(
    teamIds: string[],
    obs: PlayerObservation,
    interp: InterpretationResult,
    pyramid: PyramidScores,
  ): Candidate {
    const signals = buildTeamSignals(teamIds, obs, pyramid);
    return {
      action: { type: 'team_select', teamIds: [...teamIds] },
      description: `team [${teamIds.join(',')}]`,
      signals,
    };
  }

  private generateTeamVoteCandidates(
    obs: PlayerObservation,
    interp: InterpretationResult,
    pyramid: PyramidScores,
  ): Candidate[] {
    const proposedTeam = obs.proposedTeam ?? [];
    const signals = buildTeamSignals(proposedTeam, obs, pyramid);

    return [
      {
        action: { type: 'team_vote', vote: true },
        description: 'approve proposed team',
        signals,
      },
      {
        action: { type: 'team_vote', vote: false },
        // Reject inverts most signals — the scorer treats reject as
        // "don't push this team forward", reading the same signals
        // with inverted purpose alignment.
        description: 'reject proposed team',
        signals,
      },
    ];
  }

  private generateQuestVoteCandidates(
    obs: PlayerObservation,
    _interp: InterpretationResult,
    _pyramid: PyramidScores,
  ): Candidate[] {
    // Quest vote candidates are simple binary; signals carry whether
    // self is on team (always true here) and faction info.
    const signals: CandidateSignals = {
      avgSuspicion: 0,
      maxSuspicion: 0,
      includesKnownEvil: false,
      includesSelf: true,
      violatesLakeRules: false,
      numKnownEvilOnTeam: 0,
      merlinProbForTarget: 0,
    };
    return [
      {
        action: { type: 'quest_vote', vote: 'success' },
        description: 'play success',
        signals,
      },
      {
        action: { type: 'quest_vote', vote: 'fail' },
        description: 'play fail',
        signals,
      },
    ];
  }

  private generateAssassinateCandidates(
    obs: PlayerObservation,
    interp: InterpretationResult,
    pyramid: PyramidScores,
  ): Candidate[] {
    const candidates: Candidate[] = [];
    const allEvilSet = new Set(obs.allEvilIds ?? obs.knownEvils);
    for (const target of obs.allPlayerIds) {
      if (target === obs.myPlayerId) continue;
      const mind = interp.mindBy.get(target);
      const merlinProb = mind?.predictedRoleProb.merlin ?? 0;
      const targetSuspicion = pyramid.scores.get(target) ?? 0.5;
      candidates.push({
        action: { type: 'assassinate', targetId: target },
        description: `assassinate ${target}`,
        signals: {
          avgSuspicion: targetSuspicion,
          maxSuspicion: targetSuspicion,
          includesKnownEvil: allEvilSet.has(target),
          includesSelf: false,
          violatesLakeRules: false,
          numKnownEvilOnTeam: allEvilSet.has(target) ? 1 : 0,
          merlinProbForTarget: merlinProb,
        },
      });
    }
    return candidates;
  }
}

// ── Step 4: scoring ─────────────────────────────────────────────
/**
 * Score a candidate against the purpose vector.
 *
 * Score = Σ (purpose_weight_i * purpose_alignment_i)
 *
 * Each purpose has an alignment function that maps the candidate's
 * `signals` + the `obs` + `interp` into [-1, 1]. Positive = candidate
 * advances purpose; negative = candidate hurts purpose.
 *
 * Per-role bias (`roleSignals` optional):
 *   When provided, role-specific deltas from `RoleStrategy.applyRoleBias`
 *   are summed onto the generic alignment vector BEFORE the dot product.
 *   This keeps role asymmetries (派西 wizard A/B, 莫德 R1-leader, etc.)
 *   isolated from the round-aware purpose weights.
 *
 *   Backward-compatible: omitting `roleSignals` reverts to pure generic
 *   alignment (test helpers and pre-Phase-2 callers stay unbroken).
 *
 * Exported for unit testing.
 */
export function scoreCandidate(
  candidate: Candidate,
  purposes: PurposeVector,
  obs: PlayerObservation,
  interp: InterpretationResult,
  roleSignals?: RoleSignals,
): number {
  const a = computePurposeAlignment(candidate, obs, interp);
  let score = 0;

  // 6 角色 Phase 2 — sum role-specific bias deltas onto the generic
  // alignment vector before the purpose-weighted dot product.
  let bias: RoleBiasDelta = {};
  if (roleSignals !== undefined) {
    bias = computeRoleBias(candidate, obs, roleSignals);
  }
  for (const k of PURPOSE_KEYS) {
    const aligned = (a[k] ?? 0) + (bias[k] ?? 0);
    // Clamp the combined value back into [-1, 1] so a single role
    // override cannot saturate the score across multiple purposes.
    const clamped = aligned > 1 ? 1 : aligned < -1 ? -1 : aligned;
    score += (purposes[k] ?? 0) * clamped;
  }
  return score;
}

/**
 * Resolve the per-role candidate-bias delta. Pure projection — no IO.
 *
 * Composes:
 *   1. Pre-computed candidate signals (from `buildTeamSignals`).
 *   2. Role-specific signals (from `getRoleSignals(obs)`).
 *   3. Wizard A/B inclusion derived from candidate team list (Percival).
 *   4. Assassinate target identity vs `allEvilIds` / Oberon.
 *
 * Exported for unit tests.
 */
export function computeRoleBias(
  candidate: Candidate,
  obs: PlayerObservation,
  roleSignals: RoleSignals,
): RoleBiasDelta {
  const action = candidate.action;
  const s = candidate.signals;

  // Wizard inclusion derived from team list (Percival only consumes).
  let teamIncludesPercivalA = false;
  let teamIncludesPercivalB = false;
  if (action.type === 'team_select') {
    if (roleSignals.percivalA) {
      teamIncludesPercivalA = action.teamIds.includes(roleSignals.percivalA);
    }
    if (roleSignals.percivalB) {
      teamIncludesPercivalB = action.teamIds.includes(roleSignals.percivalB);
    }
  } else if (action.type === 'team_vote') {
    const team = obs.proposedTeam ?? [];
    if (roleSignals.percivalA) {
      teamIncludesPercivalA = team.includes(roleSignals.percivalA);
    }
    if (roleSignals.percivalB) {
      teamIncludesPercivalB = team.includes(roleSignals.percivalB);
    }
  }

  // Assassinate target classification.
  let targetIsKnownAlly = false;
  let targetIsOberon = false;
  if (action.type === 'assassinate') {
    const allEvilSet = new Set(obs.allEvilIds ?? obs.knownEvils);
    const knownAllySet = new Set(obs.knownEvils);
    targetIsKnownAlly = knownAllySet.has(action.targetId);
    // Oberon = evil per `allEvilIds` but NOT in `knownEvils` (lone wolf).
    targetIsOberon =
      allEvilSet.has(action.targetId) && !knownAllySet.has(action.targetId);
  }

  return applyRoleBias(obs.myRole, action, obs, {
    numKnownEvilOnTeam: s.numKnownEvilOnTeam,
    avgSuspicion: s.avgSuspicion,
    includesKnownEvil: s.includesKnownEvil,
    merlinProbForTarget: s.merlinProbForTarget,
    teamIncludesPercivalA,
    teamIncludesPercivalB,
    merlinHidingFromAssassin: roleSignals.merlinHidingFromAssassin,
    morganaBetrayal: roleSignals.morganaBetrayal,
    mordredR1Leader: roleSignals.mordredR1Leader,
    targetIsKnownAlly,
    targetIsOberon,
    oberonMissionParticipatedBefore: roleSignals.oberonMissionParticipatedBefore,
    oberonFailedInMission: roleSignals.oberonFailedInMission,
  });
}

/**
 * Per-purpose alignment in [-1, 1]. Pure projection — no IO.
 *
 * Exported for unit tests.
 */
export function computePurposeAlignment(
  candidate: Candidate,
  obs: PlayerObservation,
  interp: InterpretationResult,
): PurposeVector {
  const s = candidate.signals;
  const action = candidate.action;
  const isApprove = action.type === 'team_vote' && action.vote === true;
  const isReject = action.type === 'team_vote' && !action.vote;
  const isQuestFail = action.type === 'quest_vote' && action.vote === 'fail';
  const isQuestSuccess = action.type === 'quest_vote' && action.vote === 'success';
  const isAssassinate = action.type === 'assassinate';
  const isTeamSelect = action.type === 'team_select';

  // Suspicion-weighted alignment helpers.
  const lowSuspicion = 1 - 2 * s.avgSuspicion; // [1 .. -1] as suspicion 0 .. 1
  const highSuspicion = 2 * s.avgSuspicion - 1;

  // For team_vote: approve aligns with the team's signals; reject
  // inverts. Use a sign multiplier so reject inverts every alignment.
  const voteSign = isReject ? -1 : 1;
  // For quest_vote: success aligns with three blue; fail aligns with three red.
  const questBlueSign = isQuestSuccess ? 1 : isQuestFail ? -1 : 0;
  const questRedSign = isQuestSuccess ? -1 : isQuestFail ? 1 : 0;

  // ── threeBlueWins: clean teams good, fails bad
  let threeBlueWins = 0;
  if (isTeamSelect) threeBlueWins = lowSuspicion - (s.numKnownEvilOnTeam > 0 ? 1.5 : 0);
  else if (isApprove) threeBlueWins = lowSuspicion - (s.numKnownEvilOnTeam > 0 ? 1.5 : 0);
  else if (isReject) threeBlueWins = highSuspicion + (s.numKnownEvilOnTeam > 0 ? 1.5 : 0);
  else if (questBlueSign !== 0) threeBlueWins = questBlueSign;

  // ── threeRedWins: dirty teams good (evil POV), fails good
  let threeRedWins = 0;
  if (isTeamSelect) threeRedWins = (s.numKnownEvilOnTeam > 0 ? 1 : -0.5) + 0.3 * highSuspicion;
  else if (isApprove) threeRedWins = (s.numKnownEvilOnTeam > 0 ? 1 : -0.5);
  else if (isReject) threeRedWins = (s.numKnownEvilOnTeam > 0 ? -1 : 0.3);
  else if (questRedSign !== 0) threeRedWins = questRedSign;

  // ── hideMerlin (good POV — merlin protects self, also for loyal who
  //    wants to keep merlin alive): reject obvious-known-evil teams,
  //    but also avoid being the ONLY rejecter on close votes (proxy:
  //    avoid extreme suspicion alignment). Approximated: align with
  //    lowSuspicion but moderate the swing.
  let hideMerlin = 0;
  if (isApprove) hideMerlin = 0.3 * lowSuspicion;
  else if (isReject) hideMerlin = 0.3 * highSuspicion;
  else if (isTeamSelect) hideMerlin = 0.3 * lowSuspicion - 0.5 * (s.numKnownEvilOnTeam > 0 ? 1 : 0);
  else if (questBlueSign !== 0) hideMerlin = questBlueSign * 0.5;

  // ── findMerlin (assassin / morgana POV): correlate with high merlin prob
  let findMerlin = 0;
  if (isAssassinate) findMerlin = 2 * (s.merlinProbForTarget - 0.5);

  // ── mimicMerlin (morgana POV): act like merlin would — push clean teams
  let mimicMerlin = 0;
  if (isApprove) mimicMerlin = 0.5 * lowSuspicion;
  else if (isReject) mimicMerlin = 0.5 * highSuspicion;
  else if (isTeamSelect) mimicMerlin = 0.5 * lowSuspicion;
  else if (isQuestSuccess) mimicMerlin = 0.5; // morgana plays success early to mimic
  else if (isQuestFail) mimicMerlin = -0.5;

  // ── hidePercival (percival POV): avoid actions that out you as percival.
  //    Proxy: don't take overly-anti-suspect actions early.
  let hidePercival = 0;
  if (isReject) hidePercival = -0.2; // rejecting a clean team outs you
  else if (isApprove) hidePercival = 0.1;

  // ── hideFromMerlin (mordred POV / minion): avoid being on the most
  //    obvious evil-mass team; avoid suspicion-spiking selects.
  let hideFromMerlin = 0;
  if (isApprove) hideFromMerlin = 0.3 * lowSuspicion;
  else if (isReject) hideFromMerlin = 0.3 * highSuspicion;
  else if (isTeamSelect) hideFromMerlin = -0.5 * highSuspicion;
  else if (isQuestSuccess) hideFromMerlin = 0.3; // play success early to look loyal
  else if (isQuestFail) hideFromMerlin = -0.3;

  // ── avoidFriendlyFire (oberon POV): don't assassinate own team if
  //    we somehow reach assassination; don't quest-fail with another
  //    evil already failing (heuristic — public failCount ≥ required).
  let avoidFriendlyFire = 0;
  if (isAssassinate && s.includesKnownEvil) avoidFriendlyFire = -1;
  else if (isAssassinate) avoidFriendlyFire = 0.2;

  // ── findGoodTeam (loyal POV — no merlin info, lean conservative)
  let findGoodTeam = 0;
  if (isTeamSelect) findGoodTeam = lowSuspicion;
  else if (isApprove) findGoodTeam = lowSuspicion;
  else if (isReject) findGoodTeam = highSuspicion;

  // ── dontOverPushRed (merlin POV — avoid exposing self):
  //    penalise extreme anti-red votes; reward moderation.
  let dontOverPushRed = 0;
  if (isReject && s.numKnownEvilOnTeam === 0) dontOverPushRed = -0.5;
  else if (isApprove) dontOverPushRed = 0.2;

  // ── forceMerlinKill (assassin late-game): assassinate the most
  //    likely merlin candidate.
  let forceMerlinKill = 0;
  if (isAssassinate) forceMerlinKill = s.merlinProbForTarget;

  // Apply voteSign for actions that have natural inversion semantics.
  // (Only purposes whose direction depends on approve vs reject are
  // already handled above — voteSign retained for clarity / future use.)
  void voteSign;

  const aligned: MutablePurposeVector = {
    threeBlueWins: clamp(threeBlueWins),
    threeRedWins: clamp(threeRedWins),
    hideMerlin: clamp(hideMerlin),
    findMerlin: clamp(findMerlin),
    mimicMerlin: clamp(mimicMerlin),
    hidePercival: clamp(hidePercival),
    hideFromMerlin: clamp(hideFromMerlin),
    avoidFriendlyFire: clamp(avoidFriendlyFire),
    findGoodTeam: clamp(findGoodTeam),
    dontOverPushRed: clamp(dontOverPushRed),
    forceMerlinKill: clamp(forceMerlinKill),
  };
  return aligned;
}

function clamp(x: number): number {
  if (x > 1) return 1;
  if (x < -1) return -1;
  return x;
}

// ── Helper: build CandidateSignals for a team ───────────────────
function buildTeamSignals(
  teamIds: readonly string[],
  obs: PlayerObservation,
  pyramid: PyramidScores,
): CandidateSignals {
  if (teamIds.length === 0) {
    return {
      avgSuspicion: 0.5,
      maxSuspicion: 0.5,
      includesKnownEvil: false,
      includesSelf: false,
      violatesLakeRules: false,
      numKnownEvilOnTeam: 0,
      merlinProbForTarget: 0,
    };
  }
  let sum = 0;
  let max = 0;
  let includesKnownEvil = false;
  let includesSelf = false;
  let knownEvilCount = 0;
  const knownEvilSet = new Set(obs.knownEvils);
  for (const id of teamIds) {
    const s = pyramid.scores.get(id) ?? 0.5;
    sum += s;
    if (s > max) max = s;
    if (id === obs.myPlayerId) includesSelf = true;
    if (knownEvilSet.has(id)) {
      includesKnownEvil = true;
      knownEvilCount++;
    }
  }
  return {
    avgSuspicion: sum / teamIds.length,
    maxSuspicion: max,
    includesKnownEvil,
    includesSelf,
    // Lake rule violation detection is intentionally LEFT to the
    // baseline (it owns the 4 hard rules). PR2 doesn't recompute —
    // a false here means the scorer doesn't slam this candidate; the
    // baseline path still enforces the rules elsewhere.
    violatesLakeRules: false,
    numKnownEvilOnTeam: knownEvilCount,
    merlinProbForTarget: 0,
  };
}

// ── Re-exports for tests ────────────────────────────────────────
export {
  PURPOSE_KEYS,
  zeroPurposeVector,
  normalizePurpose,
  roundT,
  lerp,
};
