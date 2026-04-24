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
 *     or "deep cover" heuristics). Oberon is the only exception and
 *     keeps its legacy randomised behaviour.
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
 * - **Oberon is intentionally excluded** — he is declared independent
 *   (no knownEvils coordination) and stays on whatever legacy path
 *   each method already provides. This matches SSoT §3.2 oberon
 *   description: "can't be counted on to coordinate, treat as a
 *   random variable from other evils' POV."
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
    const { playerCount, currentRound, myPlayerId, myTeam, knownEvils, knownWizards } = obs;
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
      const suspectSet = this.getFailedMissionSuspects(obs);

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
      const candidates = nonSelf.sort((a, b) => {
        const tierDiff = byTier(a) - byTier(b);
        if (tierDiff !== 0) return tierDiff;
        return this.getSuspicion(a) - this.getSuspicion(b);
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
        for (const id of candidates) {
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

  // ── Team Vote ────────────────────────────────────────────────

  private voteOnTeam(obs: PlayerObservation): AgentAction {
    const { proposedTeam, myTeam, myPlayerId, knownEvils, knownWizards, failCount } = obs;

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

      if (hasSelf || hasAlly) return { type: 'team_vote', vote: true };

      // Hard mode: more strategically sometimes approves to appear cooperative
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

  // ── Quest Vote ───────────────────────────────────────────────

  private voteOnQuest(obs: PlayerObservation): AgentAction {
    const { myTeam, myRole, questResults, playerCount, currentRound, failCount } = obs;

    if (myTeam === 'good') {
      return { type: 'quest_vote', vote: 'success' };
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
    // MUST fail. Rationale (Edward 2026-04-22 12:38):
    //   • evilWins === 2 → one more fail wins the mission track outright.
    //   • goodWins === 2 → failing keeps it at 2-1 and avoids the
    //     assassination-phase gamble.
    // Oberon is the only exception (no teammate coordination, legacy
    // randomised behaviour kept).
    //
    // This branch overrides role differentiation and the `failsRequired >= 2`
    // cautious path. See `docs/ai/avalon_ai_strategy_baseline.md` §0.
    if (USE_LISTENING_RULE && isListeningState(goodQuestWins, evilQuestWins)) {
      if (myRole === 'oberon') {
        // Oberon acts more randomly since they don't know the game state as well.
        return { type: 'quest_vote', vote: Math.random() > 0.3 ? 'fail' : 'success' };
      }
      return { type: 'quest_vote', vote: 'fail' };
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

    const target = candidatePool.reduce((best, id) =>
      (merlinScore.get(id) ?? 0) > (merlinScore.get(best) ?? 0) ? id : best
    , candidatePool[0]);

    return { type: 'assassinate', targetId: target };
  }

  /**
   * Count observable "mistakes" a good player made from the assassin's
   * point of view (Edward 2026-04-24 batch 2 fix #6).
   *
   * A mistake reveals the player is NOT Merlin — Merlin sees all
   * knownEvils (assassin+morgana from the assassin's POV) and would
   * never sponsor or outer-white approve a team containing them.
   *
   * Two anti-Merlin patterns are counted:
   *   1. **排水 (as leader)** — player led a vote whose team contained
   *      any known evil.
   *   2. **場外白球 (off-team approval)** — player was not on the team,
   *      but approved a team that contained any known evil.
   *
   * Returns the raw count (each vote record can contribute to both
   * buckets at most once). Used as a binary filter (unmistaken vs.
   * mistaken); absolute magnitude is secondary.
   */
  private getMistakeCount(playerId: string, obs: PlayerObservation): number {
    let mistakes = 0;
    for (const record of obs.voteHistory) {
      const teamHasKnownEvil = record.team.some(id => obs.knownEvils.includes(id));
      if (!teamHasKnownEvil) continue;

      if (record.leader === playerId) {
        mistakes += 1; // 排水: led a tainted team
      }
      const onTeam = record.team.includes(playerId);
      const approved = record.votes[playerId];
      if (!onTeam && approved === true) {
        mistakes += 1; // 場外白球: approved a tainted team from outside
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
