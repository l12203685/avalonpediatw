/**
 * Heuristic Agent — Strategy-aware Avalon AI
 *
 * Implements role-appropriate decision heuristics:
 * - Good players: include themselves + safe players on quest teams
 * - Evil players: include self + appear cooperative, occasionally sneak in allies
 * - Merlin: vote against teams containing known evils
 * - Assassin: track who voted against evil teams (likely Merlin behavior)
 * - All roles: use vote history to build suspicion scores
 */

import {
  AvalonAgent,
  PlayerObservation,
  AgentAction,
} from './types';
import { AVALON_CONFIG } from '@avalon/shared';
import { PriorLookup, type Difficulty } from './priors/PriorLookup';
import {
  assassinTargetPenalty,
  voteInnerBlackBonus,
  seatPriorByRole,
  r1LeaderRolePrior,
  seatOfPlayer,
  type R1Outcome,
} from './priors/EvActionPriors';

// ── Strategy thresholds ────────────────────────────────────────
// #97 Phase 1 (2026-04-22): SUSPICION_REJECT_THRESHOLD / STRICT_THRESHOLD /
// OFF_TEAM_REJECT_BASELINE / NOISE_RATE now live inside PriorLookup's
// HARDCODE tier (see priors/PriorLookup.ts). Historical data path
// supersedes these when three-tier JSON is loaded. Pre-#97 constants
// preserved byte-identically in Tier-3 hardcode for emergency rollback.

/** Above this failCount, good always approves to avoid auto-loss on 5th reject. */
const FORCE_APPROVE_FAIL_COUNT = 4;

// ── Edward 2026-04-24 batch 4 fix #1 — R1-P1 banned team combos ───
/**
 * Edward 2026-04-24 batch 4 verbatim:
 *   「所有玩家在1-1 都不準派123/150/234/678 這幾種組合」
 *
 * On round 1 first proposal (R1-P1) of a 10-player game, no leader — regardless
 * of faction — may propose any of these four seat combinations:
 *   - `123` → seats {1, 2, 3}
 *   - `150` → seats {1, 5, 10}   (Edward display: seat 10 → digit '0')
 *   - `234` → seats {2, 3, 4}
 *   - `678` → seats {6, 7, 8}
 *
 * These combos are meta-banned as they commonly arise from naive sort-by-id
 * selection and create predictable signatures in training data. Enforced as
 * a hard post-filter on the assembled team — if the canonical ascending
 * seat string (1,2,3,4,5,6,7,8,9,0 convention) matches one, we swap members
 * until it doesn't.
 *
 * Canonical seat order: Edward's convention sorts seat digits as
 * `1,2,3,4,5,6,7,8,9,0` (seat 10 → '0' sorts LAST). Since `allPlayerIds`
 * indexes 0..9 correspond to seats 1..10, we sort by the allPlayerIds index
 * directly — natural ascending index order already produces the canonical
 * digit string when we map index 9 → digit '0'.
 */
const R1_P1_BANNED_COMBOS: readonly string[] = ['123', '150', '234', '678'];
const R1_P1_BANNED_COMBO_SET = new Set<string>(R1_P1_BANNED_COMBOS);

/**
 * Render a set of player IDs as Edward's canonical ascending seat-digit
 * string, using `allPlayerIds` as the seat-1-indexed reference.
 *
 * `allPlayerIds[i]` ↔ seat `i + 1` (seat 10 displays as '0').
 */
function canonicalSeatString(
  memberIds: readonly string[],
  allPlayerIds: readonly string[],
): string {
  const indices = memberIds
    .map((id) => allPlayerIds.indexOf(id))
    .filter((idx) => idx >= 0)
    .sort((a, b) => a - b);
  return indices.map((idx) => (idx === 9 ? '0' : String(idx + 1))).join('');
}

// ── #97 Phase 2 · Anomaly-vote weighting (v4, 2026-04-22) ───────
/**
 * Base magnitude for outer-white (off-team approve) anomaly suspicion delta.
 *
 * Effective delta per anomaly = `ANOMALY_OUTER_WHITE_BASE × round_weight × (1 − anomaly_rate)`.
 * Worst-case R5 rare (rate ≈ 0.27, weight 1.8) → 0.6 × 1.8 × 0.73 ≈ +0.79.
 * R1 (rate ≈ 0.025, weight 0.5) → 0.6 × 0.5 × 0.975 ≈ +0.29 (nearly noise).
 * Kept small so a single anomaly never dominates the legacy +2 fail-team penalty.
 */
const ANOMALY_OUTER_WHITE_BASE = 0.6;

/**
 * Base magnitude for inner-black (in-team reject) anomaly trust delta.
 *
 * Effective delta = `ANOMALY_INNER_BLACK_BASE × round_weight × (1 − anomaly_rate)`.
 * R5 rare (rate ≈ 0.33, weight 1.8) → 0.5 × 1.8 × 0.67 ≈ −0.60.
 * R1 (rate ≈ 0.009, weight 0.5) → 0.5 × 0.5 × 0.991 ≈ −0.25.
 * Slightly smaller than outer-white base because inner-black can also be
 * a contrarian reject (not always "principled good").
 */
const ANOMALY_INNER_BLACK_BASE = 0.5;

/**
 * Bayesian Merlin-signal bonus from inner-black anomalies in `scoreWizardAsMerlin`.
 * Rarer and later = stronger Merlin signal (Merlin refuses tainted teams
 * even when picked). Effective bonus = `MERLIN_INNER_BLACK_BASE × round_weight × (1 − rate)`.
 */
const MERLIN_INNER_BLACK_BASE = 0.8;

/** Clamp arbitrary round integer to 1-5 range used by anomaly tables. */
function clampRound(round: number): 1 | 2 | 3 | 4 | 5 {
  const r = Math.max(1, Math.min(5, Math.trunc(round)));
  return r as 1 | 2 | 3 | 4 | 5;
}

// ── §0 Listening Rule (Edward 2026-04-22 12:38 verbatim) ───────
/**
 * §0 Listening rule — evil quest-action override.
 *
 *   Listening (聽牌) = either side has already won 2 quests
 *     (goodWins === 2 || evilWins === 2).
 *
 *   When listening is triggered AND evil player is on the team →
 *     quest_vote MUST be 'fail' (regardless of role, TOP10 baseline,
 *     or "deep cover" heuristics).
 *
 *   Rationale (Edward verbatim):
 *     - Evil listening (evilWins === 2) → one more fail wins the entire
 *       mission track outright. No need to gamble on the assassination
 *       phase (three-good ends in assassination, which may miss).
 *     - Good listening (goodWins === 2) → letting this quest succeed
 *       pushes us straight into the assassination phase, where missing
 *       Merlin loses the game. Failing this quest keeps the score at
 *       2-1 and preserves evil's options.
 *
 *   Edward 2026-04-24 batch 6 verbatim:
 *     「紅方或藍方已經聽牌 紅方就不可能躲藏 一定會出任務失敗」
 *     → Oberon is NO LONGER an exception. Match-point detection reads
 *       only the public mission score (visible to every player equally).
 *       Oberon's information asymmetry concerns teammate identity, not
 *       public game state. At match-point the tactical value of hiding
 *       collapses to zero for every red player on team. All evil roles
 *       (Oberon included) force fail.
 *
 *   See `docs/ai/avalon_ai_strategy_baseline.md` §0 for the full spec.
 *
 *   Flag off → legacy branches re-engage (kept for emergency rollback
 *   and regression scaffolding only).
 */
const USE_LISTENING_RULE = true;

/**
 * Check whether the mission track is at the listening threshold, i.e.
 * either side has already won 2 quests out of 5.
 *
 * Exported helper so callers (including tests) can share the exact
 * definition.
 */
function isListeningState(goodWins: number, evilWins: number): boolean {
  return goodWins === 2 || evilWins === 2;
}

// ── Edward 2026-04-24 batch 10 — recognised-red hierarchy (位階法) ──
/**
 * Edward 2026-04-24 batch 10 verbatim:
 *   「相認紅方不是上場 hard fail / 相認紅方有位階法
 *    如果單獨出R1~R3任務, 必出失敗
 *    如果跟一位相認隊友一起出R1~R3任務, 刺客出失敗, 莫德雷德出成功
 *    莫甘娜則是先觀察一次任務結果, 如果隊友出了失敗 = 刺客, 如果隊友出了
 *    成功 = 莫德雷德 => 這時出任務的隊友就互相知道身分
 *    如果跟兩位相認隊友一起出R1~R3任務, 刺客出失敗
 *    如果跟一位相認隊友一起出R4任務, 必出失敗
 *    如果跟兩位相認隊友一起出R4任務, 刺客跟莫甘娜出失敗
 *    R5 只要能出任務就是出失敗(因為紅方聽牌)」
 *
 * Batch 10 REPLACES batch 9's blanket hard-fail for recognised-red
 * roles (assassin / morgana / mordred — the trio that share a
 * `knownEvils` view). Oberon is a lone-wolf red and CONTINUES to
 * route through his dedicated batch-7/8 rule set (not the hierarchy).
 *
 * Hierarchy decision table (R1-R3 + R4 + R5 + match-point):
 *   teammatesOnMission | R | role      | vote
 *   ------------------- | - | --------- | ----
 *   0                   | R1-R3 | any   | fail (solo: must crack the mission)
 *   0                   | R4    | any   | fail (solo R4: still must fail)
 *   0                   | R5    | any   | fail (listening)
 *   1                   | R1-R3 | assassin | fail
 *   1                   | R1-R3 | mordred  | success
 *   1                   | R1-R3 | morgana  | first-time → success (observe);
 *                                           subsequent joint-mission with
 *                                           a known failer teammate → she
 *                                           knows the teammate was assassin
 *                                           → she can now play as assassin
 *                                           does (return `null` to fall
 *                                           through to role-differentiated
 *                                           logic; simplified in batch 10
 *                                           to return success on her
 *                                           FIRST joint appearance)
 *   1                   | R4    | any       | fail (2-member R4 evil
 *                                           pact — both fail to guarantee
 *                                           2 fails needed in 10p R4)
 *   1                   | R5    | any       | fail (listening)
 *   2                   | R1-R3 | assassin | fail (1 fail suffices)
 *   2                   | R1-R3 | mordred  | success
 *   2                   | R1-R3 | morgana  | success
 *   2                   | R4    | assassin | fail
 *   2                   | R4    | morgana  | fail (need 2 fails in 10p R4)
 *   2                   | R4    | mordred  | success
 *   2                   | R5    | any       | fail (listening)
 *
 * Oberon: SKIPS the hierarchy (his knownEvils is empty). Routes to
 * existing batch 7/8 voteOnQuestAsOberon branch downstream.
 *
 * The hierarchy returns a concrete vote OR `null` (signalling "fall
 * through to existing logic", currently only for the Morgana-observe
 * case which always ends up returning a vote; null is reserved for
 * future extensions).
 */
const EVIL_HIERARCHY_ROLES: ReadonlySet<string> = new Set([
  'assassin',
  'morgana',
  'mordred',
]);

/**
 * Feature flag. Default `true`. Flip to `false` only for regression
 * study — doing so re-enables the pre-batch-10 batch-9 hard-fail
 * behaviour for every recognised-red role.
 */
const USE_EVIL_HIERARCHY = true;

// ── Smart Percival thumb identification (Fix #4, SSoT §6.4) ────
/**
 * Percival thumb-identification feature flag.
 *
 * When `true`, Percival uses a signal-based scoring function to decide which
 * of the two wizard candidates is more likely to be Merlin (vs. Morgana), and
 * prefers that candidate when selecting a quest team. When `false`, the legacy
 * behaviour is used — Percival picks `knownWizards[0]` blindly (coin flip).
 *
 * Default `true`. Tests may override this via `_setSmartPercivalForTesting`.
 * Fix #4 for SSoT §6.4 (Edward 2026-04-22 12:35 +08 "盲賭拇指").
 */
let USE_SMART_PERCIVAL = true;

/**
 * Minimum number of voteHistory entries before we trust the smart-percival
 * heuristic. Below this, behaviour is indistinguishable from the legacy path
 * (still scores, but scores are all zero → first candidate wins by default).
 */
const SMART_PERCIVAL_MIN_VOTE_SAMPLES = 1;

// ── Evil role differentiation (SSoT §3.2 + §6.14, fix #5) ─────
/**
 * Feature flag for the full-scenario evil role differentiation layer
 * (fix #5). Default **on** — extends #3's 2-0 deep-cover into the
 * ordinary team-vote / team-select / early-quest / assassination
 * paths. Flip to `false` to restore the pre-#5 behaviour where all
 * evil roles (except Oberon) share one code path.
 *
 * Main evil logic stays shared (camp goal is identical — 3 fails or
 * successful assassination). This flag only gates *delta adjustments*
 * applied on top of the shared branch.
 */
const USE_EVIL_ROLE_DIFFERENTIATION_FULL = true;

/**
 * Per-role strategic deltas layered on top of the shared evil logic.
 *
 * Design invariants:
 * - **Main decisions stay shared.** Every role still goes through the
 *   same `voteOnTeam` / `selectTeam` / `voteOnQuest` / `assassinate`
 *   branches. Deltas only nudge the baseline, never replace it.
 * - **Oberon is intentionally excluded from role-diff deltas** — he is
 *   declared independent (no knownEvils coordination) and stays on
 *   whatever legacy path each method already provides for role-specific
 *   nudges. This matches SSoT §3.2 oberon description: "can't be counted
 *   on to coordinate, treat as a random variable from other evils' POV."
 *   NOTE (2026-04-24 batch 6): this exclusion applies only to role-diff
 *   deltas (ally-inclusion, off-team approve chance, earlyQuestFailBonus).
 *   The §0 Listening Rule (match-point → force fail) applies to ALL evil
 *   roles including Oberon — match-point depends only on public mission
 *   score, which Oberon sees exactly like every other player.
 *
 * Per-role rationale (SSoT §3.2 & §6.14):
 * - **mordred**: invisible to Merlin → can be bold on team comp
 *   (include allies more often), fail rate highest (Merlin can't
 *   scream if I'm on a team), no camouflage penalty when voting.
 * - **morgana**: visible to Percival (one of his two thumbs) →
 *   must mimic Merlin's voting pattern (approve clean teams to
 *   signal "I'm cautious like Merlin"); propose cleaner teams.
 * - **assassin**: holds the kill token → top priority is staying
 *   clean until assassination; approve clean teams aggressively,
 *   propose clean teams, lowest fail rate when on quest.
 * - **oberon**: `null` row — deltas do not apply.
 */
interface EvilRoleStrategy {
  /** Additive to evil's approve probability when voting on a team
   * that contains neither self nor ally. Range roughly ±0.2. */
  voteApproveBonus: number;

  /** Multiplier on the 50% ally-inclusion probability when leading
   * a team of size >= 3. 1.0 = unchanged; < 1 = prefer cleaner
   * teams (fewer allies); > 1 = prefer more ally inclusion. */
  allyInclusionMultiplier: number;

  /** Additive to evil quest fail rate in the **early/normal** 60/40
   * split (not 2-0, not evilWins >= 2, not failsRequired >= 2).
   * Negative = feign cooperation more. Range ±0.15. */
  earlyQuestFailBonus: number;

  /** Human-readable tag for logging / tests. */
  label: string;
}

/**
 * Strategy deltas for differentiated evil roles.
 *
 * These numbers are **strategic priors** (not sampled from data). They
 * encode Avalon's canonical per-role asymmetries:
 *
 * | role      | voteApprBonus | allyInclMul | earlyFailBonus | reason                                |
 * |-----------|--------------:|------------:|---------------:|---------------------------------------|
 * | mordred   |        -0.05  |        1.3  |         +0.10  | Merlin-blind → bold ally inclusion, fail more |
 * | morgana   |        +0.15  |        0.6  |         -0.05  | Mimic Merlin → approve clean, clean teams    |
 * | assassin  |        +0.10  |        0.5  |         -0.10  | Save cover for the kill → cleanest profile   |
 *
 * Phase 1 (#97 2026-04-22): voteOnTeam thresholds (NOISE_RATE /
 * STRICT_THRESHOLD / OFF_TEAM_REJECT_BASELINE / SUSPICION_REJECT_THRESHOLD)
 * now resolve via PriorLookup. These per-role EVIL strategy deltas remain
 * hardcoded until per-role L1 samples are harvested (Phase 2).
 */
const EVIL_ROLE_STRATEGY_TABLE: Record<string, EvilRoleStrategy> = {
  mordred: {
    voteApproveBonus:        -0.05,
    allyInclusionMultiplier:  1.3,
    earlyQuestFailBonus:     +0.10,
    label:                   'mordred (merlin-blind — bold)',
  },
  morgana: {
    voteApproveBonus:        +0.15,
    allyInclusionMultiplier:  0.6,
    earlyQuestFailBonus:     -0.05,
    label:                   'morgana (mimic-merlin — clean)',
  },
  assassin: {
    voteApproveBonus:        +0.10,
    allyInclusionMultiplier:  0.5,
    earlyQuestFailBonus:     -0.10,
    label:                   'assassin (hold-kill — cleanest)',
  },
};

/** Roles that participate in the role-differentiation layer. Oberon
 *  is intentionally absent — see §3.2 + §6.14 of the strategy doc. */
const EVIL_DIFFERENTIATION_ROLES = new Set(Object.keys(EVIL_ROLE_STRATEGY_TABLE));

// ── Edward 2026-04-24 batch 7 fix #3 — Oberon 5-point strategy ────
/**
 * Edward 2026-04-24 batch 7 verbatim:
 *   「奧伯倫基本策略
 *   1. 還沒出過任務前只會投正常票
 *   2. 前三局有機會出任務必出失敗
 *   3. 前三局出過任務+讓任務失敗後開始無條件開白球
 *   4. 第四局有機會出任務且確認有隊友才可出失敗否則出成功
 *   5. 第五局: 前四局出過任務失敗, 則第五局無條件開白
 *   ; 前四局沒出過任務失敗則只會投正常黑白球」
 *
 * Feature flag. Default `true`. Set `false` to restore pre-batch-7
 * legacy Oberon path (voted like generic evil, no participation-
 * conditional rules).
 */
const USE_OBERON_STRATEGY = true;

/**
 * Oberon's public-info context. Oberon has NO knownEvils — he cannot
 * coordinate with other red players, cannot see them, and other reds
 * cannot see him. His only information channels are:
 *   - The public mission record (who was on which team, success/fail)
 *   - His own participation history (did HE go on a mission, and did
 *     it fail?)
 *
 * `buildOberonContext` derives the three switches Edward's 5 rules
 * depend on purely from `obs.questHistory` — no private role info
 * leaks. This keeps the strategy legal (Avalon rules), not cheating.
 */
interface OberonContext {
  /** Did Oberon (self) appear on any prior quest (R1..currentRound-1)? */
  missionParticipatedBefore: boolean;
  /** Did any quest Oberon participated on previously result in fail? */
  failedInMission: boolean;
  /**
   * The EARLIEST round number where Oberon appeared on a quest AND that
   * quest failed (public info). `null` if Oberon never participated in a
   * failed mission yet. Added batch 8 to generalise Rule 3 — any
   * subsequent round R > firstFailedRound triggers unconditional
   * off-team approve (not restricted to R4/R5).
   *
   * Edward 2026-04-24 batch 8 verbatim:
   *   「奧伯倫的無條件開白 應該是 R{n} 投過fail 後, R{m}, m>n 以後的所有投票
   *    都開白」
   */
  firstFailedRound: number | null;
  /** Total number of missions that failed publicly so far. */
  totalMissionFails: number;
  /** Set of playerIds who appeared on any publicly-failed R1-R3 mission,
   *  minus self. Used by Rule 4 (R4 "有隊友嫌疑" inference) — these are
   *  the public-info suspects for teammate presence. */
  suspectedTeammates: Set<string>;
}

/**
 * Build Oberon's public-info context from the observation.
 *
 * Strictly uses `obs.questHistory` (and `obs.myPlayerId`) — never
 * touches `knownEvils` (empty for Oberon anyway) or any private hint.
 */
function buildOberonContext(obs: PlayerObservation): OberonContext {
  const myId = obs.myPlayerId;
  let missionParticipatedBefore = false;
  let failedInMission = false;
  let firstFailedRound: number | null = null;
  let totalMissionFails = 0;
  const suspectedTeammates = new Set<string>();

  for (const quest of obs.questHistory) {
    const onTeam = quest.team.includes(myId);
    if (onTeam) {
      missionParticipatedBefore = true;
      if (quest.result === 'fail') {
        failedInMission = true;
        // Track the EARLIEST round where Oberon was on a failed mission.
        // Rule 3 (batch 8 generalisation) triggers on any round > this.
        if (firstFailedRound === null || quest.round < firstFailedRound) {
          firstFailedRound = quest.round;
        }
      }
    }
    if (quest.result === 'fail') {
      totalMissionFails++;
      // R1-R3 failed missions contribute members to the teammate-suspect
      // pool (Rule 4). R4 quest_history entries wouldn't hurt semantically
      // (R5 is downstream) but we stick to R1-R3 per Edward's spec
      // wording "第四局有機會出任務且確認有隊友".
      if (quest.round <= 3) {
        for (const pid of quest.team) {
          if (pid !== myId) suspectedTeammates.add(pid);
        }
      }
    }
  }

  return {
    missionParticipatedBefore,
    failedInMission,
    firstFailedRound,
    totalMissionFails,
    suspectedTeammates,
  };
}

// ── Edward 2026-04-24 batch 7 fix #4 — Blue conservative outer-white ────
/**
 * Edward 2026-04-24 batch 7 verbatim:
 *   「因此藍方不可能隨便開異常外白(會被誤認為奧伯倫)
 *   相認紅方頂多利用奧伯倫的白球去衝刺隊友 但同時這顆白球也會被抓到是紅方」
 *
 * Rationale: in Avalon, Oberon's exclusive strategic move is to
 * throw outer-white balls (off-team approvals) to protect red teammates.
 * Any blue player who does the same thing gets read as Oberon by the
 * table. So blue players should never outer-white casually.
 *
 * Batch 4 already hard-zeros blue outer-white in R1-R2. This batch 7
 * fix #4 extends the suppression into R3+ by pinning the off-team
 * approve probability to a tiny floor (`BLUE_R3_PLUS_APPROVE_FLOOR`).
 * Legitimate clean-team approves still happen at `BLUE_R3_PLUS_APPROVE_FLOOR`
 * rate to avoid degenerate `reject-always → 5-reject auto-loss` in
 * edge cases, but the rate is small enough that outer-white anomalies
 * in R3+ essentially disappear from training data.
 *
 * Pre-batch-7 R3+ approve rate: data-driven via `getOffTeamRejectRate`,
 * roughly ~13% approve baseline (1 − 0.87 reject). Post-batch-7: 3%.
 */
const BLUE_R3_PLUS_APPROVE_FLOOR = 0.03;
const USE_BLUE_CONSERVATIVE_OUTER_WHITE_R3 = true;

/**
 * Clamp helper kept inline to avoid a util import.
 */
function clampUnit(x: number, lo = 0.05, hi = 0.95): number {
  return Math.max(lo, Math.min(hi, x));
}

// ── Agent Memory ───────────────────────────────────────────────
/**
 * Per-agent, per-game memory. Populated via idempotent ingest methods
 * in `act()` so repeated observations do not double-count.
 *
 * Reset at every `onGameStart()` and cleared at `onGameEnd()`.
 */
interface AgentMemory {
  /** playerId → suspicion score (higher = more likely evil) */
  suspicion: Map<string, number>;
  /** playerId → number of failed quests this player appeared in */
  failedTeamMembers: Map<string, number>;
  /** chronological list of failed quest rounds (for blacklist decay) */
  failedTeamHistory: Array<{ round: number; team: string[] }>;
  /** playerId → times approved a team that was later proven evil-tainted */
  approvedSuspiciousVoters: Map<string, number>;
  /** playerId → times this leader led a team that failed its quest */
  leaderCoverScore: Map<string, number>;
  /** playerId → number of quests this player participated in */
  questsParticipated: Map<string, number>;
  /** last phase seen (dedup helper) */
  lastKnownPhase: 'team_select' | 'team_vote' | 'quest_vote' | 'assassination' | null;
  /** dedup key `${round}-${attempt}` for already-ingested vote records */
  processedVoteAttempts: Set<string>;
  /** dedup key `round` for already-ingested quest records */
  processedQuestRounds: Set<number>;
}

/** Lazy singleton — load once, share across agents for the life of the
 *  process. Constructing a fresh `PriorLookup` per agent would re-read
 *  three 70KB JSON files unnecessarily (each self-play spawns N agents).
 *  Tests can bypass this by passing `priors` to the constructor. */
let DEFAULT_PRIORS: PriorLookup | null = null;
function getDefaultPriors(): PriorLookup {
  if (DEFAULT_PRIORS === null) DEFAULT_PRIORS = PriorLookup.load();
  return DEFAULT_PRIORS;
}

export class HeuristicAgent implements AvalonAgent {
  readonly agentId: string;
  readonly agentType = 'heuristic' as const;
  private readonly difficulty: 'normal' | 'hard';
  /** PriorLookup — data-driven thresholds (Phase 1 #97). Injected for DI
   *  in tests; auto-loaded from bundled JSON in production. */
  private readonly priors: PriorLookup;

  private memory: AgentMemory = this.createEmptyMemory();

  constructor(
    agentId: string,
    difficulty: 'normal' | 'hard' = 'normal',
    priors?: PriorLookup,
  ) {
    this.agentId = agentId;
    this.difficulty = difficulty;
    this.priors = priors ?? getDefaultPriors();
  }

  onGameStart(obs: PlayerObservation): void {
    this.resetMemory();
    // Known evils get max suspicion, known good (self if good) stay at 0.
    for (const knownEvil of obs.knownEvils) {
      this.memory.suspicion.set(knownEvil, 10);
    }
  }

  act(obs: PlayerObservation): AgentAction {
    // Idempotent ingestion: update cross-round memory from public history.
    this.ingestVoteHistory(obs);
    this.ingestQuestHistory(obs);
    this.ingestLeaderStats(obs);
    this.memory.lastKnownPhase = obs.gamePhase;

    switch (obs.gamePhase) {
      case 'team_select':  return this.selectTeam(obs);
      case 'team_vote':    return this.voteOnTeam(obs);
      case 'quest_vote':   return this.voteOnQuest(obs);
      case 'assassination': return this.assassinate(obs);
    }
  }

  onGameEnd(_obs: PlayerObservation, _won: boolean): void {
    this.resetMemory();
  }

  // ── Memory lifecycle ────────────────────────────────────────

  private createEmptyMemory(): AgentMemory {
    return {
      suspicion:                new Map(),
      failedTeamMembers:        new Map(),
      failedTeamHistory:        [],
      approvedSuspiciousVoters: new Map(),
      leaderCoverScore:         new Map(),
      questsParticipated:       new Map(),
      lastKnownPhase:           null,
      processedVoteAttempts:    new Set(),
      processedQuestRounds:     new Set(),
    };
  }

  private resetMemory(): void {
    this.memory = this.createEmptyMemory();
  }

  // ── Ingest (idempotent) ─────────────────────────────────────

  /**
   * Consume every new vote record since last call. Dedup key = `${round}-${attempt}`.
   * Per record:
   *   - Approvers get +0.1 baseline suspicion (covering evil)
   *   - Rejecters get -0.2 (less suspicious)
   * When a fail quest has already been ingested for this round, approvers of that
   * record's team get accumulated to `approvedSuspiciousVoters`.
   *
   * **#97 Phase 2 — Anomaly vote weighting (v4)**:
   * Additionally, per vote we check for two anomaly classes defined by
   * Edward's vote rule (2026-04-22):
   *   - **Outer-white**: voter is NOT on the proposed team but still approves.
   *     Often an evil-side cover move ("let this team through so fails are
   *     easy later"). Adds `weighted_delta` to suspicion, where
   *     `weighted_delta = round_weight * (1 − anomaly_rate) * base`.
   *     Rarer anomalies (lower rate) weigh more because they are stronger
   *     signals. Late rounds (R4/R5) weigh more via `round_weight` curve.
   *   - **Inner-black**: voter IS on the proposed team but rejects. This is
   *     a strong "I don't trust this team even though I'm in it" signal —
   *     often Percival-ish (refuses to carry a contaminated team). Subtracts
   *     `weighted_delta` from suspicion (treats them as more trustworthy).
   *
   * The baseline +0.1/-0.2 remains untouched; anomaly weighting is
   * additive on top so noise reduction never exceeds the legacy baseline.
   * Magnitudes (`OUTER_WHITE_BASE` / `INNER_BLACK_BASE`) are small
   * (≤0.6 × weight × rarity) so even R5 rare anomalies contribute only
   * ~1.3 points, comparable to the existing +1.5 failed-approval penalty.
   */
  private ingestVoteHistory(obs: PlayerObservation): void {
    for (const record of obs.voteHistory) {
      const key = `${record.round}-${record.attempt}`;
      if (this.memory.processedVoteAttempts.has(key)) continue;
      this.memory.processedVoteAttempts.add(key);

      for (const [pid, approved] of Object.entries(record.votes)) {
        if (approved) {
          this.addSuspicion(pid, 0.1);
        } else {
          this.addSuspicion(pid, -0.2);
        }

        // Anomaly weighting (#97 Phase 2, v4).
        const round = clampRound(record.round);
        const onTeam = record.team.includes(pid);
        if (approved && !onTeam) {
          // Outer-white → likely evil cover. Weight by rarity × round weight.
          const rate = this.priors.getAnomalyRate(
            'outer_white', round, this.difficulty,
          );
          const weight = this.priors.getRoundWeight(round, this.difficulty);
          const delta = ANOMALY_OUTER_WHITE_BASE * weight * (1 - rate);
          this.addSuspicion(pid, delta);
        } else if (!approved && onTeam) {
          // Inner-black → likely Percival-ish or principled good. Reduce suspicion.
          const rate = this.priors.getAnomalyRate(
            'inner_black', round, this.difficulty,
          );
          const weight = this.priors.getRoundWeight(round, this.difficulty);
          const delta = ANOMALY_INNER_BLACK_BASE * weight * (1 - rate);
          this.addSuspicion(pid, -delta);
        }
      }
    }
  }

  /**
   * Consume every new quest record since last call. Dedup key = `round`.
   * For each fail quest:
   *   - Every team member gets +2 suspicion and +1 failedTeamMembers count
   *   - History entry appended for blacklist decay
   *   - Approvers of the corresponding vote record get +1.5 suspicion
   *     and +1 approvedSuspiciousVoters
   *   - Every participant gets questsParticipated++.
   */
  private ingestQuestHistory(obs: PlayerObservation): void {
    for (const quest of obs.questHistory) {
      if (this.memory.processedQuestRounds.has(quest.round)) continue;
      this.memory.processedQuestRounds.add(quest.round);

      // Participation count (all quests, not just fails)
      for (const pid of quest.team) {
        this.memory.questsParticipated.set(
          pid,
          (this.memory.questsParticipated.get(pid) ?? 0) + 1,
        );
      }

      if (quest.result !== 'fail') continue;

      // Blacklist bookkeeping for failed quests
      for (const pid of quest.team) {
        this.addSuspicion(pid, 2);
        this.memory.failedTeamMembers.set(
          pid,
          (this.memory.failedTeamMembers.get(pid) ?? 0) + 1,
        );
      }
      this.memory.failedTeamHistory.push({ round: quest.round, team: [...quest.team] });

      // Penalise everyone who approved the approved team for this round
      const approvingRecord = obs.voteHistory.find(
        (r) => r.round === quest.round && r.approved,
      );
      if (!approvingRecord) continue;

      for (const [pid, approved] of Object.entries(approvingRecord.votes)) {
        if (approved && approvingRecord.team.includes(pid)) {
          this.addSuspicion(pid, 1.5);
        }
        if (approved) {
          this.memory.approvedSuspiciousVoters.set(
            pid,
            (this.memory.approvedSuspiciousVoters.get(pid) ?? 0) + 1,
          );
        }
      }
    }
  }

  /**
   * Recompute `leaderCoverScore` from authoritative history every call.
   * For every failed quest, the leader of the approved vote record earns +1.
   * Idempotent because the map is overwritten from source each time.
   */
  private ingestLeaderStats(obs: PlayerObservation): void {
    const tally = new Map<string, number>();
    for (const quest of obs.questHistory) {
      if (quest.result !== 'fail') continue;
      const approvingRecord = obs.voteHistory.find(
        (r) => r.round === quest.round && r.approved,
      );
      if (!approvingRecord) continue;
      tally.set(
        approvingRecord.leader,
        (tally.get(approvingRecord.leader) ?? 0) + 1,
      );
    }
    this.memory.leaderCoverScore = tally;
  }

  // ── Noise helper ────────────────────────────────────────────

  /**
   * Flip a decision with probability `rate`. When `critical` is true
   * the rate is forced to 0 (finish-line decisions never flip).
   * Works for any value — only flips when T is boolean.
   */
  private applyNoise<T>(decision: T, rate: number, critical = false): T {
    if (critical || rate <= 0) return decision;
    if (Math.random() >= rate) return decision;
    if (typeof decision === 'boolean') {
      return !decision as unknown as T;
    }
    return decision;
  }

  // ── Team Selection ───────────────────────────────────────────

  private selectTeam(obs: PlayerObservation): AgentAction {
    const { playerCount, currentRound, myPlayerId, myTeam, myRole, knownEvils, knownWizards } = obs;
    const teamSize = this.getTeamSize(playerCount, currentRound);
    const allIds   = this.getPlayerIds(obs);

    // Edward 2026-04-24 batch 4 fix #1 — R1-P1 banned combos (cross-faction).
    // Edward verbatim: 「所有玩家在1-1 都不準派123/150/234/678 這幾種組合」
    // R1-P1 is detected as currentRound === 1 AND no prior vote attempts yet.
    const isR1P1 = (currentRound ?? 1) === 1 && obs.voteHistory.length === 0;
    const enforceR1P1Ban = (team: string[]): string[] =>
      isR1P1 ? this.rewriteIfBannedR1P1Combo(team, obs, teamSize) : team;

    if (myTeam === 'good') {
      // Edward 2026-04-24 batch 2 fix #8 (Merlin hard-exclude) +
      // fix #9 (suspicion from failed-mission history).
      //
      // Fix #8 — Merlin never proposes a team containing a knownEvil
      // (Merlin sees assassin+morgana). This is a *hard* filter, not a
      // sort-order preference, so the invariant holds even in degenerate
      // team sizes. (Morgana/Mordred visible to Merlin via Avalon rules
      // — see getKnownEvils wiring.)
      //
      // Fix #9 — Every loyal good player (including Merlin / Percival)
      // leverages the public failed-mission history to infer suspects:
      //   For each failed mission M with failCount k, the team S(M)
      //   contains ≥ k evil players. Accumulate S(M) across all failed
      //   missions — every player in this union is a suspect.
      // Edward verbatim:
      //   「藍方會基於前面的任務結果去決定自己的隊伍組合 / 舉例 358 oox
      //     8家忠臣輪到自己時就不會把3/5家放在隊伍組合的優先考慮範圍內」
      //
      // Priority order when composing the team:
      //   1. Self (always on)
      //   2. Known-safe (explicitly excluded from both knownEvils AND
      //      failed-mission suspect set)
      //   3. Suspect but not known evil (fallback — better than evil)
      //   4. Known evil (only as degenerate last resort; should never
      //      happen at canonical team sizes 3-5 in a 10p game)
      const knownEvilSet = new Set(knownEvils);
      // Edward 2026-04-24 batch 10 — loyal suspect expansion.
      // Verbatim: 「對於忠臣, 看到異常外白優先視為偏紅方 (放在任務隊伍選擇外)」
      // For a loyal (no `knownEvils`, no `knownWizards`) the suspect set
      // is the union of: (a) members of publicly-failed missions, plus
      // (b) players who cast an off-team approve (outer-white) at any
      // point — these are the tell-tale Oberon-like signatures. Merlin
      // and Percival already have privileged knowledge and skip (b).
      const loyalLike = myRole === 'loyal' &&
        (!knownWizards || knownWizards.length === 0);
      const suspectSet = loyalLike
        ? this.getLoyalSuspectSet(obs)
        : this.getFailedMissionSuspects(obs);

      // Rank non-self candidates: (a) not-suspect-not-evil comes first,
      // then (b) suspect, then (c) known evil (should be empty slice for
      // Merlin at normal team sizes). Within each tier, sort ascending
      // by raw suspicion score.
      const nonSelf = allIds.filter(id => id !== myPlayerId);
      const byTier = (id: string): number => {
        if (knownEvilSet.has(id)) return 2;
        if (suspectSet.has(id))   return 1;
        return 0;
      };

      // ── EV-prior nudge (2026-04-25 ship · Hook 4 r1LeaderRolePrior) ──
      // R1 leader who oversaw a clean R1-success looks faction-trusted;
      // a loyal-like leader of R1-success is +EV to include (+16.21pp).
      // For good selectTeam: invert the prior's blue-favourable Δ → low
      // r1Adjust = "looks trustworthy" (subtract from sort key so they
      // rank earlier). The prior is small (max ~0.16) so it only breaks
      // ties between similarly-suspected candidates.
      const r1FirstRecord = obs.voteHistory.find(
        v => v.round === 1 && v.approved,
      );
      const r1QuestRecord = obs.questHistory.find(q => q.round === 1);
      const r1LeaderId = r1FirstRecord?.leader;
      const r1Result = r1QuestRecord?.result;
      const r1Adjust = (id: string): number => {
        if (id !== r1LeaderId || !r1Result) return 0;
        // For good selecting team: a HIGH +EV prior for a candidate
        // means they're more likely good-faction → reduce sort key.
        // Use blue-favourable mapping: positive Δ for loyal/percival/
        // merlin = good leader; for red roles a positive Δ means red
        // benefits → bad for good-side, increase sort key.
        // Simplification: treat all roles via the prior magnitude;
        // sign comes from baseline-already-encoded direction.
        // We don't know the leader's role here — apply a "loyal-like"
        // assumption since most R1 leaders are loyal in 10p games.
        // The prior already has loyal-success +0.162 → trustworthy.
        const loyalPrior = r1LeaderRolePrior('loyal', r1Result as R1Outcome);
        return -loyalPrior; // subtract to rank earlier
      };

      const candidates = nonSelf.sort((a, b) => {
        const tierDiff = byTier(a) - byTier(b);
        if (tierDiff !== 0) return tierDiff;
        const susDiff = this.getSuspicion(a) - this.getSuspicion(b);
        if (susDiff !== 0) return susDiff;
        return r1Adjust(a) - r1Adjust(b);
      });

      // Percival: prioritise including at least one wizard candidate (Merlin or Morgana) on the team
      // so quests can be protected. If a quest fails with a wizard on it, they're more likely Morgana.
      if (knownWizards && knownWizards.length > 0) {
        const team: string[] = [myPlayerId];
        // Smart Percival (Fix #4, SSoT §6.4): infer which wizard is more
        // likely to be Merlin from vote & proposal signals and prefer that
        // candidate. Falls back to `knownWizards[0]` when the flag is off
        // or when there is not enough signal yet (round 1 first attempt).
        const preferredWizard = this.pickPreferredWizard(knownWizards, obs);
        if (team.length < teamSize) team.push(preferredWizard);
        // Edward 2026-04-24 batch 10 — Percival dual-thumb intersection.
        // Verbatim: 「對於派西維爾, 除了根據異常投票去抓紅藍方, 也要透過
        //           雙拇指(梅林/莫甘娜)釋放的隊伍資訊去交集找共同好壞人」
        // Boost suspicion for players who appear on the
        // "Merlin-rejected AND Morgana-approved" team-set (cross-inferred
        // evil) or reduce it for players appearing on the
        // "Merlin-approved AND Morgana-rejected" team-set (cross-inferred
        // good). The resulting Set<string> is a HIGH-CONFIDENCE suspect
        // overlay; we prefer non-overlay members when sorting `candidates`.
        const dualSuspects = this.buildPercivalDualThumbSuspects(
          knownWizards, preferredWizard, obs,
        );
        // Resort candidates: dualSuspects get demoted within their tier.
        const reranked = [...candidates].sort((a, b) => {
          const ta = dualSuspects.has(a) ? 1 : 0;
          const tb = dualSuspects.has(b) ? 1 : 0;
          if (ta !== tb) return ta - tb;
          return 0;  // stable otherwise
        });
        for (const id of reranked) {
          if (team.length >= teamSize) break;
          if (!team.includes(id)) team.push(id);
        }
        return { type: 'team_select', teamIds: enforceR1P1Ban(team.slice(0, teamSize)) };
      }

      const team = [myPlayerId, ...candidates].slice(0, teamSize);
      return { type: 'team_select', teamIds: enforceR1P1Ban(team) };
    } else {
      // Evil: include self, prefer to include one evil ally on larger teams
      // Main logic stays shared — per-role strategy only nudges the
      // ally-inclusion probability (SSoT §3.2 + §6.14).
      const evilAllies = knownEvils.filter(id => id !== myPlayerId);
      const goodCandidates = allIds
        .filter(id => id !== myPlayerId && !knownEvils.includes(id))
        .sort(() => Math.random() - 0.5); // shuffle to appear random

      const team: string[] = [myPlayerId];

      // On bigger teams (size >= 3), sneak in one evil ally with base
      // 50% probability, modulated by per-role strategy. Mordred +30%
      // (bold), Morgana -40% (mimic Merlin's clean teams), Assassin
      // -50% (preserve cover for the kill). Oberon skips the layer.
      if (teamSize >= 3 && evilAllies.length > 0) {
        const strategy = this.getEvilRoleStrategy(obs.myRole as string);
        const allyInclusionThreshold = clampUnit(
          0.5 * (strategy?.allyInclusionMultiplier ?? 1),
          0.05,
          0.95,
        );
        if (Math.random() < allyInclusionThreshold) {
          team.push(evilAllies[Math.floor(Math.random() * evilAllies.length)]);
        }
      }

      // Fill remaining with good-looking players
      for (const id of goodCandidates) {
        if (team.length >= teamSize) break;
        team.push(id);
      }

      return { type: 'team_select', teamIds: enforceR1P1Ban(team.slice(0, teamSize)) };
    }
  }

  /**
   * Edward 2026-04-24 batch 4 fix #1 — R1-P1 banned-combo rewriter.
   *
   * If the input team's canonical ascending seat string
   * (1,2,3,4,5,6,7,8,9,0 convention) equals one of the banned combos
   * `{'123','150','234','678'}`, swap exactly one non-self member with
   * an alternative player drawn from `allPlayerIds` — keep trying other
   * alternatives until the canonical string is no longer banned.
   *
   * Guarantees:
   *   - Leader (self) stays on the team.
   *   - Team size is preserved.
   *   - If no legal swap exists (pathological — would require > 4 players
   *     locked) the original team is returned unchanged, with an upstream
   *     `console.warn` for visibility. In practice with a 10-player game
   *     and 4 banned combos the swap always succeeds.
   */
  private rewriteIfBannedR1P1Combo(
    team: readonly string[],
    obs: PlayerObservation,
    teamSize: number,
  ): string[] {
    const all = obs.allPlayerIds;
    const canonical = canonicalSeatString(team, all);
    if (!R1_P1_BANNED_COMBO_SET.has(canonical)) {
      return [...team];
    }

    const selfId = obs.myPlayerId;
    // Candidate replacements: any player not already on the team and not self.
    const pool = all.filter((id) => !team.includes(id) && id !== selfId);

    for (const slot of team) {
      // Never swap out self — leader always stays on their own team.
      if (slot === selfId) continue;
      for (const replacement of pool) {
        const trial = team.map((id) => (id === slot ? replacement : id));
        const trialCanonical = canonicalSeatString(trial, all);
        if (!R1_P1_BANNED_COMBO_SET.has(trialCanonical) && trial.length === teamSize) {
          return trial;
        }
      }
    }

    // No legal swap found — return original. Shouldn't happen with 10 players.
    return [...team];
  }

  /**
   * Edward 2026-04-24 batch 2 fix #9 — failed-mission suspect set.
   *
   * Core deduction rule every good player can make from public history:
   *   If mission M failed with fail-count k, the team S(M) contained
   *   at least k evil players.
   *
   * Without role information, a loyal good player cannot pinpoint which
   * member of S(M) is evil. The conservative (and strategically sound)
   * response is to treat the ENTIRE S(M) as "suspect" — i.e. avoid
   * putting anyone from S(M) on future teams when cleaner alternatives
   * exist. Merlin and Percival can overlay their privileged knowledge
   * (knownEvils, knownWizards) on top of this.
   *
   * Union across all failed missions is returned. An empty history →
   * empty set (caller should then fall back to raw suspicion scores).
   */
  private getFailedMissionSuspects(obs: PlayerObservation): Set<string> {
    const suspects = new Set<string>();
    for (const quest of obs.questHistory) {
      if (quest.result !== 'fail') continue;
      for (const pid of quest.team) suspects.add(pid);
    }
    return suspects;
  }

  /**
   * Edward 2026-04-24 batch 10 — loyal-specific suspect expansion.
   *
   * Verbatim: 「對於忠臣, 看到異常外白優先視為偏紅方 (放在任務隊伍選擇外)」
   *
   * A loyal good player has NO privileged information (no knownEvils,
   * no knownWizards). To compensate, she leans on EVERY public anomaly
   * signal she can observe. Union of:
   *   (a) members of publicly-failed missions (same as
   *       getFailedMissionSuspects)
   *   (b) players who cast an off-team approve (outer-white) in any
   *       voteHistory record — textbook Oberon-like signature, and a
   *       legitimate red-cover move for any recognised-red when a
   *       teammate is on the team (see batch 10 Point 3). Either way,
   *       the loyal treats them as "偏紅方" and deprioritises them on
   *       the proposed team.
   *
   * Self is explicitly excluded (a loyal never self-suspects).
   */
  private getLoyalSuspectSet(obs: PlayerObservation): Set<string> {
    const suspects = this.getFailedMissionSuspects(obs);
    // Add outer-white approvers.
    for (const record of obs.voteHistory) {
      for (const [pid, approved] of Object.entries(record.votes)) {
        if (pid === obs.myPlayerId) continue;
        const onTeam = record.team.includes(pid);
        if (!onTeam && approved === true) {
          suspects.add(pid);
        }
      }
    }
    return suspects;
  }

  // ── Team Vote ────────────────────────────────────────────────

  private voteOnTeam(obs: PlayerObservation): AgentAction {
    const { proposedTeam, myTeam, myPlayerId, myRole, knownEvils, knownWizards, failCount } = obs;

    // Edward 2026-04-24 batch 3 fix #2 — forced-mission team vote:
    // on the 5th attempt (failCount === 4), a reject hands the round
    // directly to evil via the 5-rejections rule. Therefore:
    //   • good MUST approve (already handled below, preserved)
    //   • evil MUST ALSO approve — a reject wins them the whole round,
    //     so blue players physically cannot cast an anomaly reject;
    //     and a red reject would be self-sabotage at this specific point
    //     only if blue rejects (blue can't) — but per Edward's rule
    //     「強制局不會有異常票」→ everyone approves, the tail leader's
    //     team just runs the quest.
    // Cross-faction gate: applies regardless of team.
    if (failCount >= FORCE_APPROVE_FAIL_COUNT) {
      return { type: 'team_vote', vote: true };
    }

    // Edward 2026-04-24 batch 7 fix #3 — Oberon 5-point strategy.
    // Oberon has his OWN voting logic that supersedes the generic
    // evil branch below. Place this check BEFORE the cross-faction
    // R1-R2 guard so Oberon's participation-conditional behaviour
    // (Rule 3 / Rule 5) can produce intentional outer-whites in R4/R5
    // once the pre-conditions are met. Rules 1/2/5b still yield normal
    // (non-anomaly) votes so the R1-R2 guard is never actually contradicted.
    //
    // Contract (verbatim):
    //   1. 還沒出過任務前只會投正常票 → on-team approve / off-team reject
    //   2. 前三局有機會出任務必出失敗 → quest-side (voteOnQuest), not here
    //   3. 前三局出過任務+讓任務失敗後 → R4/R5 off-team unconditional approve
    //   5a. R5 + totalMissionFails >= 1 → off-team unconditional approve
    //   5b. R5 + totalMissionFails === 0 → normal votes only
    if (
      USE_OBERON_STRATEGY &&
      myTeam === 'evil' &&
      (myRole as string) === 'oberon'
    ) {
      const oberonDecision = this.voteOnTeamAsOberon(obs);
      if (oberonDecision !== null) return oberonDecision;
    }

    // Edward 2026-04-24 batch 4 fix #2 — cross-faction R1-R2 anomaly
    // suppression (promoted from good-only to all factions).
    //
    // Edward verbatim (batch 2): 「不是前三局不開白 / 是第1&2局先不要開異常票」
    // Edward verbatim (batch 4): 「你還是一堆異常票啊」
    //
    // Root cause of residual anomalies after batch 2: the guard lived
    // inside the `myTeam === 'good'` branch, so evil players still ran
    // their standard `hasSelf || hasAlly → approve; else 30-35% approve`
    // logic — this produced outer-white anomalies (evil off-team + no
    // ally on team + random approve) in R1-R2 exactly as visible in
    // the batch-3 self-play output (e.g. R1-P1 team [1,2,3] with evil
    // seats 6+10 outer-white approving).
    //
    // Fix: lift the early-round guard above the faction split so it
    // applies to BOTH good and evil:
    //   • R1-R2 on-team  → approve  (suppress inner-black for all)
    //   • R1-R2 off-team → reject   (suppress outer-white for all)
    //
    // Exception: `hasFailedMemberEarly` — in R2 after a failed R1, any
    // returning quest member is public-info tainted. Good-side rejects
    // then are public-evidence-driven, not private-role-driven, so not
    // truly "anomalies" in the role-identification sense. The guard
    // stands down and normal heuristics resume; evil-side behaviour on
    // R2 after R1 fail is unchanged (red always covers ally).
    //
    // Trade-offs accepted (Edward's intent is maximal clean data):
    //   • A Merlin/Percival on team with a knownEvil in R1 is forced to
    //     approve instead of reject. Sacrifices one r1 inner-black signal
    //     for zero-anomaly R1-R2 — aligned with "先不要開異常票".
    //   • Evil off-team with ally on team in R1-R2 is forced to reject
    //     instead of outer-white approving. Loses one cover approve but
    //     removes a strong anomaly signature.
    const hasFailedMemberEarly = proposedTeam.some(
      id => (this.memory.failedTeamMembers.get(id) ?? 0) >= 1,
    );
    if ((obs.currentRound ?? 1) <= 2 && !hasFailedMemberEarly) {
      return { type: 'team_vote', vote: proposedTeam.includes(myPlayerId) };
    }

    if (myTeam === 'good') {

      // Hard veto: any known evil on team → always reject (critical, no noise).
      const hasKnownEvil = proposedTeam.some(id => knownEvils.includes(id));
      if (hasKnownEvil) {
        return { type: 'team_vote', vote: false };
      }

      // Percival: skeptical of teams without any wizard candidate (Merlin/Morgana).
      if (knownWizards && knownWizards.length > 0 && proposedTeam.length >= 3) {
        const hasWizard = proposedTeam.some(id => knownWizards.includes(id));
        if (!hasWizard) {
          return {
            type: 'team_vote',
            vote: this.difficulty === 'hard' ? false : Math.random() > 0.65,
          };
        }
      }

      // Suspicion + failed-team-member scan used by both on/off-team branches.
      const avgSuspicion = proposedTeam.reduce((s, id) => s + this.getSuspicion(id), 0) / proposedTeam.length;
      const hasFailedMember = proposedTeam.some(
        id => (this.memory.failedTeamMembers.get(id) ?? 0) >= 1,
      );
      const onTeam = proposedTeam.includes(myPlayerId);
      // #97 Phase 1: all four thresholds now resolve via PriorLookup.
      // Historical data path: expert/mid/novice JSON (Edward vote rule).
      // Tier-3 fallback preserves pre-#97 behaviour byte-identically.
      const diff: Difficulty = this.difficulty;
      const noise = this.priors.getNoiseRate(diff);

      if (!onTeam) {
        // Edward 2026-04-24 batch 2 fix #1 — rounds 1-2 pre-filter is
        // already handled above (approve-if-on-team / reject-if-off).
        // Off-team path: default to cautious reject. Leader must prove the
        // team is clean — otherwise the good player holds out their approval.
        const strictThreshold = this.priors.getStrictThreshold(diff);
        if (hasFailedMember || avgSuspicion > strictThreshold) {
          return { type: 'team_vote', vote: this.applyNoise(false, noise) };
        }

        // Edward 2026-04-24 batch 7 fix #4 — Blue conservative outer-white
        // in R3+. Edward verbatim「藍方不可能隨便開異常外白(會被誤認為
        // 奧伯倫)」. Any blue outer-white in R3+ risks being misread as
        // Oberon's signature play. Pin approve probability to the
        // conservative floor so outer-white anomalies are essentially
        // eliminated in R3+ training data while still keeping a tiny
        // non-zero rate to avoid degenerate 5-reject auto-loss.
        if (
          USE_BLUE_CONSERVATIVE_OUTER_WHITE_R3 &&
          (obs.currentRound ?? 1) >= 3
        ) {
          const baselineVote = Math.random() < BLUE_R3_PLUS_APPROVE_FLOOR ? true : false;
          return { type: 'team_vote', vote: this.applyNoise(baselineVote, noise) };
        }

        // No hard signal → baseline reject probability from historical
        // off-team rejects (L1/L2/L3 rollup, Edward vote rule). Round 1
        // and round 2+ differ sharply (r1 ~0.99, r2+ ~0.87 for expert).
        const hasHistory = this.memory.failedTeamHistory.length > 0
          || this.memory.processedVoteAttempts.size > 0;
        const roundForPrior = hasHistory ? (obs.currentRound ?? 1) : 1;
        let baseline = this.priors.getOffTeamRejectRate(diff, {
          team: 'good',
          round: roundForPrior,
          isLeader: false,
        });
        // Legacy parity: when no history yet (true r1 with no prior
        // attempts), relax baseline by 0.6 so the agent doesn't race
        // to failCount=5 in the total dark. Historical data path
        // already captures r1 separately, so this dampener only fires
        // on the very first attempt of the very first round.
        if (!hasHistory) baseline *= 0.6;
        const baselineVote = Math.random() < baseline ? false : true;
        return { type: 'team_vote', vote: this.applyNoise(baselineVote, noise) };
      }

      // Edward 2026-04-24 batch 2 fix #1 — rounds 1-2 pre-filter is
      // already handled above; here we are round 3+ on-team.
      // On-team path: keep legacy avg-suspicion check, but also veto teams
      // that contain any previously-failed member.
      if (hasFailedMember) {
        return { type: 'team_vote', vote: this.applyNoise(false, noise) };
      }
      const threshold = this.priors.getSuspicionRejectThreshold(diff);
      const decision  = avgSuspicion < threshold;
      return { type: 'team_vote', vote: this.applyNoise(decision, noise) };
    } else {
      // Evil: approve if own ally or self is on team, reject otherwise
      // Main logic stays shared — per-role strategy only nudges the
      // off-team approve probability (Morgana mimics Merlin → approves
      // clean teams more; Mordred is bolder → rejects more).
      const hasSelf  = proposedTeam.includes(obs.myPlayerId);
      const hasAlly  = proposedTeam.some(id => knownEvils.includes(id));

      // ── EV-prior nudge (2026-04-25 ship · Hook 2 voteInnerBlackPrior) ──
      // When on-team at R3+ as a red role with a +EV inner-black signal,
      // probabilistically flip the cover-approve into an inner-black
      // reject (anomaly). Magnitude bounded by the EV table —
      // e.g. mordred R3 = +0.205 ≈ 20% chance to inner-black instead of
      // cover-approve. Below R3 (or when bonus = 0) the legacy approve
      // branch keeps full priority.
      //
      // Listening (match-point) is handled upstream and short-circuits
      // before reaching here, so this block never affects R5 listening.
      const round = obs.currentRound ?? 1;
      if (hasSelf && round >= 3) {
        const innerBlackBonus = voteInnerBlackBonus(obs.myRole as string, round);
        if (innerBlackBonus > 0 && Math.random() < innerBlackBonus) {
          return { type: 'team_vote', vote: false };
        }
      }

      if (hasSelf || hasAlly) return { type: 'team_vote', vote: true };

      // Edward 2026-04-24 batch 10 — recognised-red outer-white limit.
      // Verbatim: 「相認紅方(刺娜德) 不會在隊伍組合沒有相認隊友時開異常外白」
      //
      // Recognised-red roles (assassin / morgana / mordred) can see each
      // other via `knownEvils`. When the proposed team contains no
      // teammate they can see, opening an off-team approve (outer-white)
      // is a cover-burn with no strategic upside — it signals their
      // faction to readers without helping any ally through. Force
      // reject in this scenario.
      //
      // Scope: applies ONLY to recognised-red. Oberon keeps his
      // dedicated batch 7/8 branch (handled earlier in voteOnTeam).
      // Mordred is included (he is a recognised-red for the trio).
      if (EVIL_HIERARCHY_ROLES.has(obs.myRole as string)) {
        // hasSelf / hasAlly already false here (short-circuited above),
        // so this is the "no teammate on team" branch. Force reject.
        return { type: 'team_vote', vote: false };
      }

      // Hard mode: more strategically sometimes approves to appear cooperative.
      // Reachable only for Oberon (his dedicated branch would have returned
      // earlier unless Rule 1/5b resolved to "normal vote"; he legitimately
      // reaches here at R1-R2 before any participation, where the cross-
      // faction R1-R2 guard has already handled him).
      const baseApproveChance = this.difficulty === 'hard' ? 0.35 : 0.3;
      const strategy = this.getEvilRoleStrategy(obs.myRole as string);
      const approveChance = clampUnit(
        baseApproveChance + (strategy?.voteApproveBonus ?? 0),
        0.05,
        0.95,
      );
      return { type: 'team_vote', vote: Math.random() < approveChance };
    }
  }

  // ── Oberon strategy (Edward 2026-04-24 batch 7 fix #3) ──────────

  /**
   * Oberon-specific team-vote. Returns `null` if the generic branch
   * should handle the vote (e.g. when Rules 1 / 5b decay to "normal
   * votes only" — the caller's standard path already produces those).
   *
   * Rules implemented here (Edward 2026-04-24 batch 7 + batch 8 verbatim):
   *   - Rule 1: missionParticipatedBefore === false →
   *             on-team approve, off-team reject (normal vote).
   *   - Rule 3 (batch 8 generalised): firstFailedRound === R_n AND
   *             currentRound > R_n → off-team approve unconditionally
   *             (外白 signal). Pre-batch-8 this was hard-coded to R >= 4;
   *             now ANY subsequent round triggers the signal.
   *   - Rule 5a: currentRound === 5 AND totalMissionFails >= 1
   *             AND off-team → approve unconditionally.
   *   - Rule 5b: currentRound === 5 AND totalMissionFails === 0 →
   *             normal vote (returns the computed normal decision).
   *
   * Evil R1-R2 anomaly-suppression rule (batch 4) would have forced
   * reject for Oberon off-team. Oberon's Rule 1 is ALSO "normal vote =
   * off-team reject" in R1-R2 so the two agree — no conflict. Rule 3
   * (post-batch-8) could in principle fire at R2 if Oberon went on a
   * failed R1, which produces an off-team APPROVE — this is the
   * intended batch-8 behaviour (Edward verbatim「R{n} 投過fail 後,
   * R{m}, m>n 以後的所有投票 都開白」). The R1-R2 cross-faction guard
   * does NOT fire for Oberon because his dedicated branch returns
   * before the guard check.
   *
   * Edward 2026-04-24 batch 8 verbatim:
   *   「奧伯倫的無條件開白 應該是 R{n} 投過fail 後, R{m}, m>n 以後的所有投票
   *    都開白」
   */
  private voteOnTeamAsOberon(obs: PlayerObservation): AgentAction | null {
    const { proposedTeam, myPlayerId, currentRound } = obs;
    const onTeam = proposedTeam.includes(myPlayerId);
    const ctx = buildOberonContext(obs);
    const round = currentRound ?? 1;

    // Rule 1: never participated → normal vote.
    if (!ctx.missionParticipatedBefore) {
      return { type: 'team_vote', vote: onTeam };
    }

    // Rule 3 (batch 8 generalised): after Oberon's first failed-mission
    // participation at round R_n, every round R > R_n triggers off-team
    // unconditional approve (外白 signal). On-team still returns approve
    // (normal vote), so effectively Oberon approves every vote from
    // R_n+1 onwards once he has been on a failed mission.
    //
    // Batch 8 invariant gate: even when firstFailedRound === 1 (Oberon
    // went on a failed R1), Rule 3 stays silent at R2 so the
    // cross-faction「R1~R2 是不能有異常票的」invariant still holds. The
    // gate is `round >= 3` — R3 onwards Rule 3 may open outer-white.
    if (
      ctx.firstFailedRound !== null &&
      round > ctx.firstFailedRound &&
      round >= 3
    ) {
      return { type: 'team_vote', vote: true };
    }

    // Rule 5a: R5 + any prior mission fail → off-team unconditional approve.
    // (Distinct from Rule 3 because Oberon himself may not have been on
    // the failed mission, yet the rule still fires at R5.)
    if (round === 5 && ctx.totalMissionFails >= 1) {
      return { type: 'team_vote', vote: true };
    }

    // Rule 5b: R5 + no mission fail yet → normal vote.
    if (round === 5 && ctx.totalMissionFails === 0) {
      return { type: 'team_vote', vote: onTeam };
    }

    // Oberon participated in a prior mission but that mission did NOT
    // fail (e.g. teammate didn't drop a fail token, or failsRequired=2
    // and only 1 dropped). Fall back to normal (on-team approve /
    // off-team reject) to avoid emitting anomaly signals without the
    // fail-participation precondition.
    return { type: 'team_vote', vote: onTeam };
  }

  /**
   * Oberon-specific quest-vote. Returns `null` when the generic branch
   * should handle (e.g. Rules 1 / 5b normal → but voteOnQuest's match-
   * point / legacy paths may still fire; we short-circuit for the
   * deterministic rules and hand back control otherwise).
   *
   * Rules implemented here (Edward 2026-04-24 batch 7 verbatim):
   *   - Rule 2: R1-R3 on team → fail unconditionally.
   *   - Rule 4: R4 on team → fail iff teammate-suspicion overlap,
   *             otherwise success.
   *   - Rule 5c: R5 on team → fail iff totalMissionFails >= 1,
   *             otherwise success.
   *
   * Precedence note: caller invokes match-point (isListeningState)
   * first, which is a HARDER override than any Oberon rule — so by
   * the time we land here we know match-point is false. Oberon rules
   * below coexist with the baseline 60/40 probabilistic path; we
   * only return a decision when a deterministic rule applies.
   */
  private voteOnQuestAsOberon(obs: PlayerObservation): AgentAction | null {
    const { proposedTeam, myPlayerId, currentRound } = obs;
    const onTeam = proposedTeam.includes(myPlayerId);
    if (!onTeam) return null;  // Oberon rules fire only on-team
    const round = currentRound ?? 1;
    const ctx = buildOberonContext(obs);

    // Rule 2: R1-R3 on team → fail.
    if (round >= 1 && round <= 3) {
      return { type: 'quest_vote', vote: 'fail' };
    }

    // Rule 4: R4 on team → fail iff teammate suspicion overlap.
    // "有隊友嫌疑" inferred from R1-R3 failed-mission member overlap with
    // current proposedTeam (minus Oberon himself). This is public info —
    // legal inference, not role-information cheating.
    if (round === 4) {
      const hasTeammateSuspicion = proposedTeam.some(
        (id) => id !== myPlayerId && ctx.suspectedTeammates.has(id),
      );
      return {
        type: 'quest_vote',
        vote: hasTeammateSuspicion ? 'fail' : 'success',
      };
    }

    // Rule 5c: R5 on team → fail iff totalMissionFails >= 1.
    if (round === 5) {
      return {
        type: 'quest_vote',
        vote: ctx.totalMissionFails >= 1 ? 'fail' : 'success',
      };
    }

    return null;
  }

  // ── Recognised-red hierarchy (Edward 2026-04-24 batch 10) ──────────
  /**
   * Resolve the hierarchy vote for a recognised-red role (assassin /
   * morgana / mordred). Returns the concrete `'fail' | 'success'`
   * vote if the hierarchy applies; returns `null` if the caller should
   * fall through to downstream legacy logic (should not normally
   * happen — all recognised-red on-team cases resolve here).
   *
   * Applies ONLY when `myRole ∈ EVIL_HIERARCHY_ROLES`. Oberon is
   * routed elsewhere.
   *
   * Teammate count is derived from `knownEvils ∩ proposedTeam` minus
   * self — i.e. players the current recognised-red agent can see as
   * teammates AND who are on this mission. Oberon hides from
   * knownEvils, so he is invisible for the teammate-count axis (as he
   * should be — Oberon does not coordinate).
   *
   * Morgana-observe (batch 10 verbatim): on her FIRST joint mission
   * with exactly one teammate in R1-R3 she votes `success` to let the
   * result reveal whether the teammate is assassin (fail on that
   * quest) or mordred (success). Implementation detail: we detect
   * "first joint mission" by checking that NO prior quest (from
   * `questHistory`) had Morgana on team together with a known evil
   * teammate. Once a prior joint mission exists, she can infer the
   * teammate's role from its outcome and act accordingly:
   *   - If the prior joint mission FAILED → teammate was assassin →
   *     Morgana now plays as assassin does (fail).
   *   - If the prior joint mission SUCCEEDED → teammate was mordred →
   *     Morgana continues the mordred-joint pattern (success, since
   *     she knows 1 fail is insufficient to break cover).
   *
   * Edward's rule as written focuses on the observe step. Downstream
   * inference is implemented here as the natural continuation.
   */
  private chooseRedHierarchyVote(
    obs: PlayerObservation,
  ): 'fail' | 'success' | null {
    const { myRole, myPlayerId, proposedTeam, knownEvils, currentRound, questHistory } = obs;
    const round = currentRound ?? 1;

    // R5: listening — any red on mission MUST fail. This is the single
    // strongest rule and supersedes every teammate-count axis.
    if (round === 5) return 'fail';

    const teammatesOnMission = proposedTeam.filter(
      (id) => id !== myPlayerId && knownEvils.includes(id),
    );
    const teammateCount = teammatesOnMission.length;

    // R1-R3 branch.
    if (round >= 1 && round <= 3) {
      if (teammateCount === 0) return 'fail';  // solo recognised-red
      if (teammateCount === 1) {
        if (myRole === 'assassin') return 'fail';
        if (myRole === 'mordred') return 'success';
        if (myRole === 'morgana') {
          // Observe-first on her FIRST joint R1-R3 mission. On subsequent
          // joint missions, infer the teammate's role from the previous
          // joint mission's outcome and mirror the appropriate behaviour.
          const priorJoint = questHistory.find((q) =>
            q.round <= 3 &&
            q.team.includes(myPlayerId) &&
            q.team.some((id) => id !== myPlayerId && knownEvils.includes(id)),
          );
          if (!priorJoint) {
            // First joint mission — observe (let it succeed so the
            // teammate-role reveal happens on this quest).
            return 'success';
          }
          // Prior joint mission exists → Morgana knows teammate's role:
          //   joint-mission failed → teammate = assassin → fail now too
          //     (assassin would have failed then; morgana now plays as
          //     assassin does in this regime).
          //   joint-mission succeeded → teammate = mordred → mirror
          //     mordred's success (both hiding).
          return priorJoint.result === 'fail' ? 'fail' : 'success';
        }
      }
      if (teammateCount >= 2) {
        if (myRole === 'assassin') return 'fail';
        return 'success';
      }
    }

    // R4 branch (5-person team in 10p needs 2 fails — hierarchy enforces
    // that 2-member-or-more evil presence can guarantee the 2 fails).
    if (round === 4) {
      if (teammateCount === 0) return 'fail';  // solo R4: fail anyway
      if (teammateCount === 1) return 'fail';  // both evils on 2-member R4 must fail
      if (teammateCount >= 2) {
        if (myRole === 'mordred') return 'success';  // assassin+morgana carry the 2 fails
        return 'fail';  // assassin / morgana fail
      }
    }

    // Unreachable in canonical 5-round games (round clamped 1-5 upstream).
    return null;
  }

  // ── Quest Vote ───────────────────────────────────────────────

  private voteOnQuest(obs: PlayerObservation): AgentAction {
    const { myTeam, myRole, questResults, playerCount, currentRound, failCount } = obs;

    if (myTeam === 'good') {
      return { type: 'quest_vote', vote: 'success' };
    }

    // Edward 2026-04-24 batch 10 — recognised-red hierarchy (位階法).
    // Replaces batch 9's blanket hard-fail for {assassin, morgana,
    // mordred}. Oberon SKIPS the hierarchy and uses his dedicated batch
    // 7/8 ruleset below (oberon branch runs before forced-mission so
    // Rule 2 on R1-R3 can still force fail even on forced missions).
    //
    // Hierarchy logic (Edward 2026-04-24 batch 10 verbatim — see the
    // long doc-comment at EVIL_HIERARCHY_ROLES for the full matrix).
    if (
      USE_EVIL_HIERARCHY &&
      EVIL_HIERARCHY_ROLES.has(myRole as string)
    ) {
      const hierarchyVote = this.chooseRedHierarchyVote(obs);
      if (hierarchyVote !== null) {
        return { type: 'quest_vote', vote: hierarchyVote };
      }
    }

    // Edward 2026-04-24 batch 10 — oberon rules fire BEFORE the
    // forced-mission branch so Rule 2 (R1-R3 on team → fail) still
    // produces fails on forced missions (else batch 3 forced-mission
    // cover-success would allow oberon to ride the forced quest as
    // success — the same bug batch 9 closed).
    if (USE_OBERON_STRATEGY && (myRole as string) === 'oberon') {
      // Oberon listening override runs inside voteOnQuestAsOberon
      // implicitly (Rule 5c handles R5 + prior fail). Edward batch 6
      // raised match-point to apply to Oberon, so mirror the isListening
      // override here too (matching pre-batch-9 semantics).
      const goodWinsHere = questResults.filter(r => r === 'success').length;
      const evilWinsHere = questResults.filter(r => r === 'fail').length;
      if (USE_LISTENING_RULE && isListeningState(goodWinsHere, evilWinsHere)) {
        return { type: 'quest_vote', vote: 'fail' };
      }
      const oberonDecision = this.voteOnQuestAsOberon(obs);
      if (oberonDecision !== null) return oberonDecision;
    }

    // Edward 2026-04-24 batch 3 fix #2 — forced-mission quest vote:
    // detect whether this quest arose from the 5th proposal (forced
    // mission). `failCount` resets to 0 on approval, so we check the
    // approved vote record for this round — if its `attempt === 5`,
    // the quest team was auto-approved under forced-mission pressure.
    //
    // Per Edward「強制局不會有異常票」: evil MUST also vote success
    // at this point — a fail reveals cover for zero strategic gain
    // (blue already couldn't reject, so no anomaly vote branch fires).
    // Short-circuit before any role-specific fail heuristic.
    //
    // Batch 10: recognised-red hierarchy + oberon branches above have
    // already resolved before this point. Forced-mission cover-success
    // now only applies to any residual evil path (should be empty for
    // canonical roles; kept for auditability).
    const approvedVoteThisRound = obs.voteHistory.find(
      v => v.round === currentRound && v.approved,
    );
    if (approvedVoteThisRound && approvedVoteThisRound.attempt >= 5) {
      return { type: 'quest_vote', vote: 'success' };
    }
    // Suppress unused-variable lint when the guard above doesn't fire.
    void failCount;

    // Evil: decide whether to fail based on game state
    const goodQuestWins = questResults.filter(r => r === 'success').length;
    const evilQuestWins = questResults.filter(r => r === 'fail').length;

    // ── §0 Listening rule (highest-priority evil quest-action override) ──
    //
    // When either side has won 2 quests, every evil player on the team
    // MUST fail. Rationale (Edward 2026-04-22 12:38, reaffirmed
    // 2026-04-24 batch 6):
    //   • evilWins === 2 → one more fail wins the mission track outright.
    //   • goodWins === 2 → failing keeps it at 2-1 and avoids the
    //     assassination-phase gamble.
    //
    // Edward 2026-04-24 batch 6 verbatim:
    //   「紅方或藍方已經聽牌 紅方就不可能躲藏 一定會出任務失敗」
    //
    // Batch 6 change — Oberon is NO LONGER an exception. Previous baseline
    // (strategy doc §0.4) carved Oberon out because he lacks teammate
    // coordination. But match-point detection only reads the PUBLIC
    // mission score (which Oberon sees exactly like every other player).
    // Oberon's ignorance concerns teammate identity, not game state.
    // At match-point, the tactical value of "hiding" (cover-success)
    // collapses to zero for any red player on team:
    //   • Red listening (evilWins === 2) → failing wins the game; hiding
    //     throws away the decisive moment.
    //   • Blue listening (goodWins === 2) → not failing hands the game
    //     to assassination phase, which is a gamble. Red still prefers
    //     fail to extend the mission track.
    // → Every evil player on team (Oberon included) MUST fail.
    //
    // This branch overrides role differentiation and the `failsRequired >= 2`
    // cautious path. See `docs/ai/avalon_ai_strategy_baseline.md` §0.
    if (USE_LISTENING_RULE && isListeningState(goodQuestWins, evilQuestWins)) {
      return { type: 'quest_vote', vote: 'fail' };
    }

    // Edward 2026-04-24 batch 7 fix #3 — Oberon quest rules.
    // Applies ONLY when match-point listening has NOT triggered (match-
    // point is a harder override, already handled above). Oberon Rule 2
    // (R1-R3 on team → fail) is STRICTLY stronger than the 60/40 default,
    // Rule 4 (R4 on team + teammate suspicion → fail, else success) is
    // a different axis than failsRequired>=2, and Rule 5c depends on
    // the prior fail record. When any Oberon rule applies we return it;
    // otherwise fall through to the shared generic evil logic.
    if (USE_OBERON_STRATEGY && (myRole as string) === 'oberon') {
      const oberonDecision = this.voteOnQuestAsOberon(obs);
      if (oberonDecision !== null) return oberonDecision;
    }

    // Check if this round requires 2 fail votes (7+ players, round 4)
    const config = AVALON_CONFIG[playerCount];
    const failsRequired = config?.questFailsRequired[currentRound - 1] ?? 1;

    // If 2 fails required this round, a single fail is wasted — be strategic.
    // (Listening handled above; this path only fires at 0-0, 1-0, 0-1, 1-1.)
    if (failsRequired >= 2) {
      // Baseline 30% fail, modulated by per-role earlyQuestFailBonus
      // (Mordred +0.10, Morgana -0.05, Assassin -0.10). Oberon skips.
      const fr2Base = 0.30;
      const fr2FailRate = this.applyEvilEarlyFailBonus(myRole as string, fr2Base);
      return { type: 'quest_vote', vote: Math.random() < fr2FailRate ? 'fail' : 'success' };
    }

    // Early game (both sides < 2 wins): sometimes succeed to stay hidden
    // (60% fail, 40% succeed) baseline, modulated by per-role
    // earlyQuestFailBonus. Oberon skips (legacy 60% fail preserved).
    const earlyBase = 0.60;
    const earlyFailRate = this.applyEvilEarlyFailBonus(myRole as string, earlyBase);
    return { type: 'quest_vote', vote: Math.random() < earlyFailRate ? 'fail' : 'success' };
  }

  /**
   * Look up per-role evil strategy delta. Returns `null` for roles not in
   * the differentiation table (Oberon, or any good role) so callers can
   * short-circuit cleanly — Oberon retains his legacy independent path.
   *
   * Gated by `USE_EVIL_ROLE_DIFFERENTIATION_FULL`; flip to `false` to
   * restore pre-#5 "one evil branch for all non-Oberon roles".
   */
  private getEvilRoleStrategy(role: string | undefined | null): EvilRoleStrategy | null {
    if (!USE_EVIL_ROLE_DIFFERENTIATION_FULL) return null;
    if (!role) return null;
    if (!EVIL_DIFFERENTIATION_ROLES.has(role)) return null;
    return EVIL_ROLE_STRATEGY_TABLE[role] ?? null;
  }

  /**
   * Modulate an early-game evil quest fail rate by the role's
   * `earlyQuestFailBonus`. Clamp to `[0.05, 0.95]`. Oberon (or
   * unknown) returns the base unchanged.
   */
  private applyEvilEarlyFailBonus(role: string, base: number): number {
    const strategy = this.getEvilRoleStrategy(role);
    if (!strategy) return base;
    return clampUnit(base + strategy.earlyQuestFailBonus, 0.05, 0.95);
  }

  // ── Assassination ────────────────────────────────────────────

  private assassinate(obs: PlayerObservation): AgentAction {
    const allIds = this.getPlayerIds(obs);

    // Edward 2026-04-24 batch 3 fix #1 — assassin hard-filter: candidate
    // pool MUST be faction=good only. `knownEvils` from the assassin's POV
    // only reveals assassin+morgana — it hides Oberon and Mordred, so a
    // naive "not in knownEvils" filter leaks Oberon/Mordred into the
    // candidate pool ("紅方不可能是被刺殺對象").
    //
    // `allEvilIds` is populated by the harness only at assassination phase
    // (see types.ts). Prefer it when available; fall back to `knownEvils`
    // for backwards compatibility with tests / non-harness callers.
    const evilSet = new Set<string>(obs.allEvilIds ?? obs.knownEvils);
    const goodPlayers = allIds.filter(id => !evilSet.has(id) && id !== obs.myPlayerId);

    if (goodPlayers.length === 0) {
      return { type: 'assassinate', targetId: allIds.find(id => id !== obs.myPlayerId) ?? allIds[0] };
    }

    // Edward 2026-04-24 batch 2 fix #6: assassin must first prefer
    // candidates who have NOT "made a mistake" (i.e. behaved like an
    // uninformed good — which Merlin never is).
    //
    // Edward verbatim:
    //   「刺客刺殺應該要先以未犯錯對象優先 / 犯錯=排水=任務選擇選到
    //     梅林可見紅方(刺娜奧) / 或是場外白球白到可見紅方」
    //
    // Definitions (from the assassin's perspective, who sees
    // assassin+morgana in knownEvils — Merlin sees the same set):
    //   - "排水" (mistake as leader): the player led a proposal that
    //     contained a known evil (assassin/morgana). Merlin would never
    //     propose a tainted team → strong anti-Merlin signal.
    //   - "場外白球白到可見紅方" (mistake as off-team approver): the
    //     player approved a team they were NOT on that contained a
    //     known evil. Merlin would never outer-white a tainted team.
    //
    // Strategy: split good players into "unmistaken" and "mistaken".
    // Prefer unmistaken (they retained the Merlin-safe profile). Only
    // if the unmistaken pool is empty fall back to scoring over all.
    const mistakeMap = new Map<string, number>();
    for (const id of goodPlayers) {
      mistakeMap.set(id, this.getMistakeCount(id, obs));
    }
    const unmistaken = goodPlayers.filter(id => (mistakeMap.get(id) ?? 0) === 0);
    const candidatePool = unmistaken.length > 0 ? unmistaken : goodPlayers;

    // Target the good player who behaved most like Merlin:
    // - Voted against teams with evil players
    // - Was never on a failed quest
    // - Was not easily voted through
    //
    // Assassin-specific adjustment (SSoT §6.13 + fix #5): when the
    // role-differentiation layer is on, penalise candidates who show
    // Percival-like "thumb-following" patterns — Percival has two
    // wizard thumbs and often leads with one of them, which is NOT
    // Merlin behaviour. Wiki: "刺客刺殺不挑一直派拇指的玩家".
    const merlinScore = new Map<string, number>();
    for (const id of candidatePool) {
      merlinScore.set(id, this.getMerlinScore(id, obs));
    }

    if (USE_EVIL_ROLE_DIFFERENTIATION_FULL && (obs.myRole as string) === 'assassin') {
      for (const id of candidatePool) {
        const percivalPenalty = this.getPercivalLikenessPenalty(id, obs);
        merlinScore.set(id, (merlinScore.get(id) ?? 0) - percivalPenalty);
      }
    }

    // ── EV-prior nudge (2026-04-25 ship · 5 hooks) ───────────────
    // Hook 1: assassinTargetPrior — penalise candidates that look
    //         like loyal/percival (Δ -69.57pp · catastrophic miss).
    //         The assassin's existing percivalLikenessPenalty above
    //         already de-prioritises percival; this prior reinforces
    //         that signal AND additionally penalises "loyal" inferred
    //         from low merlin-score AND zero percival-like leads.
    // Hook 3: scoreSeatPriorByRole — boost candidates whose seat has
    //         high merlin occupancy (seat 10 · Δ +13.51pp), de-boost
    //         seats with high mordred/morgana occupancy.
    //
    // Both hooks are *additive* on top of the legacy merlinScore — the
    // candidate with the highest blended score still wins. Magnitude
    // chosen to keep the legacy ±2.0 signals dominant when they have
    // strong evidence, while the prior breaks ties.
    for (const id of candidatePool) {
      // Seat-prior: higher merlin occupancy at this seat → boost as
      // probable Merlin target.
      const seat = seatOfPlayer(id, obs.allPlayerIds);
      const seatBoost = seatPriorByRole('merlin', seat);
      // Loyal-likeness penalty: a player with very low getMerlinScore
      // AND very low getPercivalLikenessPenalty looks neither — that
      // is the loyal signature. Apply assassinTargetPenalty('loyal')
      // scaled by how loyal-like they read.
      const rawScore = merlinScore.get(id) ?? 0;
      const looksLoyal = rawScore < 0.5; // weak Merlin signal threshold
      const loyalPenalty = looksLoyal
        ? assassinTargetPenalty('loyal') * 0.3 // partial — score is fuzzy
        : 0;
      merlinScore.set(id, rawScore + seatBoost + loyalPenalty);
    }

    const target = candidatePool.reduce((best, id) =>
      (merlinScore.get(id) ?? 0) > (merlinScore.get(best) ?? 0) ? id : best
    , candidatePool[0]);

    return { type: 'assassinate', targetId: target };
  }

  /**
   * Count observable "mistakes" a good player made from the assassin's
   * point of view. Edward 2026-04-24 batch 10 refinement + batch 11
   * pattern 3:
   *
   *   拇指 = 刺/娜/奧 (thumb = assassin / morgana / oberon)
   *   錯誤動作:
   *     1. 全沒拇指組合開異常內黑 — player is on-team, no thumb on team,
   *        yet they voted reject → inner-black anomaly on a clean team
   *        (Merlin would NEVER reject a clean team she is on: Merlin
   *        sees every thumb, and "no thumb" = "guaranteed clean from
   *        her perspective").
   *     2. 有拇指組合開異常外白 — player is off-team, a thumb is on the
   *        team, yet they approved → outer-white anomaly on a tainted
   *        team (Merlin would NEVER approve a team she knows contains
   *        a thumb; off-team rejecting is her only legal move).
   *     3. 任務派票派到拇指 (Edward 2026-04-24 batch 11) — player is
   *        leader of a proposal whose team contains any thumb. Merlin
   *        would NEVER propose a tainted team (she sees every thumb
   *        except Mordred; visible thumbs to Merlin = 刺/娜/奧).
   *
   * Thumb visibility caveat: from the assassin's POV, `knownEvils`
   * reveals {assassin, morgana} only — Oberon is hidden. So "thumb
   * on team" is approximated as `any member ∈ knownEvils`. Oberon-on-
   * team cases produce a false "no-thumb" signal, but this is the
   * same information the Merlin actually has (Merlin sees assassin +
   * morgana + mordred; Merlin is blind to Oberon). Close enough for
   * the mistake heuristic.
   *
   * Pre-batch-10 semantics (dropped, see git blame for history):
   *   - 排水 (leader led tainted team) was counted. Replaced by
   *     Edward's clean specification above. Batch 11 reintroduces it
   *     as Pattern 3 per Edward 23:46 verbatim spec.
   *   - 場外白球 existed as pattern 2 already; preserved verbatim.
   *
   * Returns the raw count (each vote record can contribute to at most
   * one bucket per record per pattern). Used as a binary filter
   * (unmistaken vs. mistaken); the absolute magnitude is secondary.
   */
  private getMistakeCount(playerId: string, obs: PlayerObservation): number {
    let mistakes = 0;
    for (const record of obs.voteHistory) {
      const teamHasThumb = record.team.some(id => obs.knownEvils.includes(id));
      const onTeam = record.team.includes(playerId);
      const vote = record.votes[playerId];

      // Pattern 3: 任務派票派到拇指 (leader + proposed team has thumb).
      // Independent of vote — merely proposing a thumb-tainted team is
      // a Merlin-impossible action. Applies even to forced-approve
      // round 5 proposals and to records where the leader declined to
      // vote on themselves (vote undefined for leader is rare but
      // possible in malformed records).
      if (record.leader === playerId && teamHasThumb) {
        mistakes += 1;
      }

      if (vote === undefined) continue;

      // Pattern 1: 全沒拇指組合開異常內黑 (on-team + thumbless team + reject).
      if (!teamHasThumb && onTeam && vote === false) {
        mistakes += 1;
      }
      // Pattern 2: 有拇指組合開異常外白 (off-team + thumb team + approve).
      if (teamHasThumb && !onTeam && vote === true) {
        mistakes += 1;
      }
    }
    return mistakes;
  }

  /**
   * Score how "Percival-like" a player's leadership pattern is. Percival
   * typically includes a wizard candidate (Merlin or Morgana) on every
   * team he proposes — Merlin, by contrast, avoids any *known* evil but
   * does NOT consistently lead with wizards. A consistent wizard-leading
   * pattern is therefore a Percival signal, not a Merlin signal.
   *
   * Signal used here: whenever this player was the leader of a vote
   * record, did they include a known evil (Morgana is in `knownEvils`
   * from the assassin's POV)? If the leader always put Morgana on
   * their proposed team, that's a strong Percival thumb-lead signal.
   *
   * Penalty is additive to `merlinScore`, so higher = less likely
   * Merlin = less likely to be assassinated.
   */
  private getPercivalLikenessPenalty(playerId: string, obs: PlayerObservation): number {
    let morganaIncludedAsLeader = 0;
    let ledCount = 0;
    for (const vote of obs.voteHistory) {
      if (vote.leader !== playerId) continue;
      ledCount++;
      // Morgana is visible to the assassin — check if this leader
      // consistently includes her on proposed teams (Percival thumb).
      if (vote.team.some((id) => obs.knownEvils.includes(id))) {
        morganaIncludedAsLeader++;
      }
    }
    if (ledCount === 0) return 0;
    // Two-thumb leaders → 1.5 penalty (similar magnitude to the "+1.5
    // merlin behaviour" signals in getMerlinScore so the two balance).
    return morganaIncludedAsLeader >= 1 ? 1.5 * (morganaIncludedAsLeader / ledCount) : 0;
  }

  /**
   * Score a player on how "Merlin-like" their behavior has been.
   * Higher = more likely to be Merlin.
   */
  private getMerlinScore(playerId: string, obs: PlayerObservation): number {
    let score = 0;

    for (const vote of obs.voteHistory) {
      const theirVote = vote.votes[playerId];
      if (theirVote === undefined) continue;

      if (this.difficulty === 'hard') {
        // Hard: weight by how "informative" the rejection was
        // Rejecting a team that contained an evil player is very Merlin-like
        const teamHadEvil = vote.team.some(id => obs.knownEvils.includes(id));
        if (!theirVote && teamHadEvil) score += 2.0;   // Rejected a team with evil — Merlin behavior
        else if (!theirVote && !vote.approved) score += 0.8; // Rejected a team that was ultimately rejected
        else if (!theirVote) score += 0.4;              // Cautious rejection
        // If they approved a team with evil, they're probably NOT Merlin
        if (theirVote && teamHadEvil) score -= 1.5;
      } else {
        // Normal mode
        if (!theirVote && !vote.approved) score += 0.5;
        if (!theirVote) score += 0.3;
      }
    }

    // Never on a failed quest → suspicious of being the protected Merlin
    const onFailedQuest = obs.questHistory.some(q => q.result === 'fail' && q.team.includes(playerId));
    if (!onFailedQuest && obs.questHistory.length > 0) {
      score += this.difficulty === 'hard' ? 1.5 : 1;
    }

    // Hard: was always on successful quests = likely trusted good role (Merlin is always trusted)
    if (this.difficulty === 'hard') {
      const questAppearances = obs.questHistory.filter(q => q.team.includes(playerId));
      const allSucceeded = questAppearances.every(q => q.result === 'success');
      if (allSucceeded && questAppearances.length >= 2) score += 1.0;
    }

    return score;
  }

  // ── Percival thumb identification (Fix #4, SSoT §6.4) ───────

  /**
   * Score how "Merlin-like" a wizard candidate has behaved so far.
   *
   * Merlin sees all evil players. Morgana does not. Their observable
   * behaviour therefore differs in three ways that a Percival can read:
   *   1. **Vote pattern** — Merlin rejects teams containing known evils
   *      or previously-failed members; Morgana's votes are uncorrelated
   *      with evil presence (she cannot see them).
   *   2. **Proposal quality** — when this wizard is leader, Merlin's
   *      proposed teams are clean (never contain knownEvils from a
   *      third-party perspective, which Percival can approximate by
   *      checking whether the team later failed); Morgana's are dirtier.
   *   3. **Failed-quest participation** — Morgana, being evil, can be
   *      the player who actively failed a quest, so her presence in
   *      failed teams is weakly self-implicating.
   *
   * Higher score → more Merlin-like. Ties resolve to list order so the
   * function is deterministic when signals are equal.
   */
  private scoreWizardAsMerlin(wizardId: string, obs: PlayerObservation): number {
    let score = 0;

    // Signal 1: vote pattern.
    for (const record of obs.voteHistory) {
      const theirVote = record.votes[wizardId];
      if (theirVote === undefined) continue;

      const teamHadFailedMember = record.team.some(
        (id) => (this.memory.failedTeamMembers.get(id) ?? 0) >= 1,
      );

      // Rejecting a team that later proved tainted = Merlin-like.
      if (theirVote === false && teamHadFailedMember) score += 2.0;
      // Rejecting a team that was ultimately rejected (consensus) = mild.
      else if (theirVote === false && !record.approved) score += 0.3;
      // Approving a tainted team = not Merlin (Merlin would veto).
      if (theirVote === true && teamHadFailedMember) score -= 1.5;

      // #97 Phase 2 (v4): inner-black anomaly = strong Merlin/Percival-ish
      // signal, weighted by round rarity. Shares the same PriorLookup
      // anomaly API as ingestVoteHistory so signals stay calibrated.
      const onTeam = record.team.includes(wizardId);
      if (theirVote === false && onTeam) {
        const round = clampRound(record.round);
        const rate = this.priors.getAnomalyRate(
          'inner_black', round, this.difficulty,
        );
        const weight = this.priors.getRoundWeight(round, this.difficulty);
        score += MERLIN_INNER_BLACK_BASE * weight * (1 - rate);
      }
    }

    // Signal 2: proposal quality when this wizard led.
    for (const record of obs.voteHistory) {
      if (record.leader !== wizardId) continue;
      // Did this leader's team later fail (as a proxy for "contained evil")?
      const failed = obs.questHistory.find(
        (q) => q.round === record.round && q.result === 'fail',
      );
      if (failed && failed.team.every((id) => record.team.includes(id))) {
        score -= 1.0;  // Morgana-ish: led a tainted team.
      } else if (record.approved) {
        score += 0.5;  // Clean approved team: Merlin-ish.
      }
    }

    // Signal 3: participation in failed quests.
    for (const quest of obs.questHistory) {
      if (quest.result !== 'fail') continue;
      if (quest.team.includes(wizardId)) {
        // Morgana herself could have dropped the fail token.
        score -= 0.5;
      }
    }

    return score;
  }

  /**
   * Decide which of the two wizard candidates Percival should treat as Merlin.
   *
   * Returns the wizard with the highest Merlin-like score. When the feature
   * flag is off, or when signal is insufficient (no vote history yet), falls
   * back to the legacy behaviour of picking `knownWizards[0]`.
   *
   * Exposed so tests can verify the classification independently of the
   * surrounding `selectTeam` flow.
   */
  identifyMerlinFromThumbs(
    wizards: readonly string[],
    obs: PlayerObservation,
  ): { merlin: string; confidence: number; scores: Record<string, number> } {
    if (wizards.length === 0) {
      return { merlin: '', confidence: 0, scores: {} };
    }
    if (wizards.length === 1) {
      return { merlin: wizards[0], confidence: 1, scores: { [wizards[0]]: 0 } };
    }

    // Insufficient-signal guard: keep legacy behaviour until enough votes
    // are on the board. Deterministic so unit tests can assert on it.
    if (obs.voteHistory.length < SMART_PERCIVAL_MIN_VOTE_SAMPLES) {
      const scores: Record<string, number> = {};
      for (const id of wizards) scores[id] = 0;
      return { merlin: wizards[0], confidence: 0, scores };
    }

    const scores: Record<string, number> = {};
    for (const id of wizards) {
      scores[id] = this.scoreWizardAsMerlin(id, obs);
    }

    // Pick highest-scoring wizard; ties break in wizards[] order (stable).
    let merlin = wizards[0];
    let best = scores[wizards[0]];
    for (let i = 1; i < wizards.length; i++) {
      if (scores[wizards[i]] > best) {
        best = scores[wizards[i]];
        merlin = wizards[i];
      }
    }

    // Confidence = relative gap between top score and runner-up, clipped [0,1].
    const sorted = [...wizards].sort((a, b) => scores[b] - scores[a]);
    const gap = scores[sorted[0]] - scores[sorted[1]];
    const confidence = Math.min(1, Math.max(0, gap / 3));

    return { merlin, confidence, scores };
  }

  /**
   * Choose which wizard candidate to include on Percival's proposed team.
   * Honours the `USE_SMART_PERCIVAL` feature flag.
   */
  private pickPreferredWizard(
    wizards: readonly string[],
    obs: PlayerObservation,
  ): string {
    if (!USE_SMART_PERCIVAL) return wizards[0];
    const { merlin } = this.identifyMerlinFromThumbs(wizards, obs);
    return merlin || wizards[0];
  }

  /**
   * Edward 2026-04-24 batch 10 — Percival dual-thumb cross-inference.
   *
   * Verbatim: 「對於派西維爾, 除了根據異常投票去抓紅藍方, 也要透過雙拇指
   *          (梅林/莫甘娜)釋放的隊伍資訊去交集找共同好壞人」
   *
   * Once Percival has inferred which wizard is Merlin and which is
   * Morgana, their votes encode complementary signals:
   *   - Wizard-as-Merlin rejects teams containing knownEvils (she sees
   *     them). Her reject list is a conservative evil-presence pointer.
   *   - Wizard-as-Morgana's approve list, when off-team, is an evil-
   *     cover signature (she approves to support allies she can see).
   *     Her in-team approve is less informative; her out-team reject
   *     is also less informative.
   *
   * Intersection criterion (high-confidence suspect):
   *   Any player who appeared on a team that
   *     (a) wizard-as-Merlin rejected AND
   *     (b) wizard-as-Morgana approved
   *   is cross-inferred evil. The (a) ∧ (b) combination requires BOTH
   *   wizards to disagree in a role-legal way (Merlin against, Morgana
   *   for), which Merlin+Merlin or Morgana+Morgana can never produce.
   *
   * Returns the union of all such team members across voteHistory.
   * Empty set when wizards do not resolve (only 1 knownWizard), when
   * no voteHistory exists yet, or when Percival has too little signal
   * to confidently pick a Merlin (identifyMerlinFromThumbs confidence
   * 0). Always excludes self (Percival knows he is good).
   *
   * Exposed via a `_forTesting` hook so tests can assert the
   * intersection without reconstructing the selectTeam path.
   */
  private buildPercivalDualThumbSuspects(
    wizards: readonly string[],
    merlinWizard: string,
    obs: PlayerObservation,
  ): Set<string> {
    const suspects = new Set<string>();
    if (wizards.length < 2) return suspects;
    const morganaWizard = wizards.find((w) => w !== merlinWizard);
    if (!morganaWizard) return suspects;

    for (const record of obs.voteHistory) {
      const merlinVote = record.votes[merlinWizard];
      const morganaVote = record.votes[morganaWizard];
      if (merlinVote === undefined || morganaVote === undefined) continue;
      // Disagreement pattern: Merlin rejects, Morgana approves.
      if (merlinVote === false && morganaVote === true) {
        for (const pid of record.team) {
          if (pid !== obs.myPlayerId) suspects.add(pid);
        }
      }
    }
    return suspects;
  }

  // ── Suspicion accessors ─────────────────────────────────────

  private getSuspicion(playerId: string): number {
    return this.memory.suspicion.get(playerId) ?? 0;
  }

  private addSuspicion(playerId: string, delta: number): void {
    this.memory.suspicion.set(
      playerId,
      Math.max(0, (this.memory.suspicion.get(playerId) ?? 0) + delta),
    );
  }

  // ── Test hooks ──────────────────────────────────────────────

  /** Read-only snapshot of internal memory (tests only — do not call from game code). */
  _memoryForTesting(): Readonly<AgentMemory> {
    return this.memory;
  }

  /** Direct access to ingest / noise helpers (tests only). */
  _ingestForTesting(obs: PlayerObservation): void {
    this.ingestVoteHistory(obs);
    this.ingestQuestHistory(obs);
    this.ingestLeaderStats(obs);
  }

  _applyNoiseForTesting<T>(decision: T, rate: number, critical = false): T {
    return this.applyNoise(decision, rate, critical);
  }

  /** Evil role strategy lookup (tests only). */
  _getEvilRoleStrategyForTesting(role: string): EvilRoleStrategy | null {
    return this.getEvilRoleStrategy(role);
  }

  /** Early-quest fail rate with per-role bonus (tests only). */
  _applyEvilEarlyFailBonusForTesting(role: string, base: number): number {
    return this.applyEvilEarlyFailBonus(role, base);
  }

  /** Percival likeness penalty for assassin targeting (tests only). */
  _getPercivalLikenessPenaltyForTesting(playerId: string, obs: PlayerObservation): number {
    return this.getPercivalLikenessPenalty(playerId, obs);
  }

  /** Oberon context (tests only, batch 7 fix #3). */
  _buildOberonContextForTesting(obs: PlayerObservation): OberonContext {
    return buildOberonContext(obs);
  }

  /** Oberon team-vote decision (tests only, batch 7 fix #3). */
  _voteOnTeamAsOberonForTesting(obs: PlayerObservation): AgentAction | null {
    return this.voteOnTeamAsOberon(obs);
  }

  /** Oberon quest-vote decision (tests only, batch 7 fix #3). */
  _voteOnQuestAsOberonForTesting(obs: PlayerObservation): AgentAction | null {
    return this.voteOnQuestAsOberon(obs);
  }

  /** Red hierarchy vote (tests only, batch 10). */
  _chooseRedHierarchyVoteForTesting(obs: PlayerObservation): 'fail' | 'success' | null {
    return this.chooseRedHierarchyVote(obs);
  }

  /** Loyal suspect set (tests only, batch 10). */
  _getLoyalSuspectSetForTesting(obs: PlayerObservation): Set<string> {
    return this.getLoyalSuspectSet(obs);
  }

  /** Percival dual-thumb cross-inference (tests only, batch 10). */
  _buildPercivalDualThumbSuspectsForTesting(
    wizards: readonly string[],
    merlinWizard: string,
    obs: PlayerObservation,
  ): Set<string> {
    return this.buildPercivalDualThumbSuspects(wizards, merlinWizard, obs);
  }

  /**
   * Toggle the smart-Percival feature flag from tests. Returns the previous
   * value so a test can restore it in `afterEach`.
   */
  static _setSmartPercivalForTesting(value: boolean): boolean {
    const previous = USE_SMART_PERCIVAL;
    USE_SMART_PERCIVAL = value;
    return previous;
  }

  // ── Helpers ──────────────────────────────────────────────────

  private getPlayerIds(obs: PlayerObservation): string[] {
    return obs.allPlayerIds;
  }

  private getTeamSize(playerCount: number, round: number): number {
    const TEAM_SIZES: Record<number, number[]> = {
      5:  [2, 3, 2, 3, 3],
      6:  [2, 3, 4, 3, 4],
      7:  [2, 3, 3, 4, 4],
      8:  [3, 4, 4, 5, 5],
      9:  [3, 4, 4, 5, 5],
      10: [3, 4, 4, 5, 5],
    };
    return (TEAM_SIZES[playerCount] ?? TEAM_SIZES[5])[Math.min(round - 1, 4)];
  }
}
