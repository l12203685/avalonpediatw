/**
 * Role Strategy — 6 角色 Phase 2 ship (Edward 2026-05-03 spec).
 *
 * Per-role private-information schema + override logic layered on top
 * of `ForwardAgent`. All role-specific decision tweaks live here so
 * `ForwardAgent.computePurposeAlignment` stays a generic dot-product
 * scorer and role asymmetries surface as additive biases.
 *
 * Spec source:
 *   `staging/subagent_results/six_roles_strategy_spec_2026-05-03.md`
 *
 * Lock invariants (Edward verbatim, do NOT cross):
 *   - Baseline core (HeuristicAgent.selectTeam / voteOnTeam / voteOnQuest
 *     / assassinate, suspectInference, pyramidScorer) untouched.
 *   - v9 H20 (派西vs娜 asymmetry) and H12 (declarer bias) ship in
 *     baseline (commit 5e688d08) — this layer reads the same priors
 *     but never overrides them.
 *   - R1-R2 force-normal vote pinning still owns by `ForwardAgent.decide`
 *     (delegates to `baseline.actDirect`). This module only adjusts R3+
 *     scoring biases for non-vote phases and team_select / quest_vote /
 *     assassinate at every round.
 *
 * Overrides per role (concise summary; full spec § references):
 *
 *   忠臣  (loyal)    — no private info, defaults to loyal-baseline (no override)
 *   梅林  (merlin)   — knownEvils hardpin + 隱身 priority (§1)
 *   派西  (percival) — wizards joint-constraint + 梅躲刺 / 娜出賣 signals (§2)
 *   刺客  (assassin) — find-merlin scoring + R1 mimic-loyal team_select (§3)
 *   莫娜  (morgana)  — mimic-merlin team picks + cleaner ally inclusion (§4)
 *   莫德  (mordred)  — bold ally inclusion (R3+) + 隱身躲梅 (§5)
 *   奧伯  (oberon)   — public-info baseline + buildOberonContext signals (§6)
 *
 * Output:
 *   Each role exports:
 *     - `getRoleSignals(obs)` — extra per-role signals attached to candidates
 *     - `applyRoleBias(role, candidate, obs, baseAlignment)` — additive
 *       bias on top of the generic alignment vector. Returns same shape
 *       as `PurposeVector` with deltas in [-1, 1].
 */

import type { Role } from '@avalon/shared';
import type { PlayerObservation, AgentAction } from '../types';
import {
  computePyramidScores,
  PYRAMID_VIOLATOR_FLOOR,
  type PyramidScores,
} from '../baseline';

// ── Role signal package ─────────────────────────────────────────
/**
 * Per-role private signals computed from the observation. These are
 * additive to the generic candidate signals — the scorer reads both.
 *
 * All fields default to neutral (zero / false / empty) when the role
 * does not consume them.
 */
export interface RoleSignals {
  /** Merlin/Percival: pyramid suspicion of the agent's privately-known wizards. */
  knownWizardSuspicions: ReadonlyMap<string, number>;
  /** Percival: predicted "this wizard is Merlin" score per known wizard. */
  wizardMerlinScores: ReadonlyMap<string, number>;
  /** Percival: A = picked-merlin-candidate; B = picked-morgana-candidate (the other wizard). */
  percivalA?: string;
  percivalB?: string;
  /** Percival "梅躲刺" — A vote pattern looks too baseline → distrust A. */
  merlinHidingFromAssassin: boolean;
  /** Percival "娜出賣隊友" — B reject containing known evil → trust B more. */
  morganaBetrayal: boolean;
  /** Oberon-only: have I appeared on at least one prior mission? */
  oberonMissionParticipatedBefore: boolean;
  /** Oberon-only: did any of my prior missions fail publicly? */
  oberonFailedInMission: boolean;
  /** Mordred: 1 if R1 leader (effective WR 71.74%, prefer mimic-loyal). */
  mordredR1Leader: boolean;
  /** Assassin/Morgana/Mordred: known-ally count among `obs.knownEvils`. */
  knownAllyCount: number;
}

/** Build a neutral RoleSignals package (no role-specific signals). */
function neutralRoleSignals(): RoleSignals {
  return {
    knownWizardSuspicions: new Map(),
    wizardMerlinScores: new Map(),
    percivalA: undefined,
    percivalB: undefined,
    merlinHidingFromAssassin: false,
    morganaBetrayal: false,
    oberonMissionParticipatedBefore: false,
    oberonFailedInMission: false,
    mordredR1Leader: false,
    knownAllyCount: 0,
  };
}

// ── Percival 梅 vs 娜 identification ────────────────────────────
/**
 * `scoreWizardAsMerlin(wizardId, obs)` — three-signal heuristic borrowed
 * from baseline §2.3 (Edward 2026-04-28 11:24 verbatim "派西決策樹"):
 *   1. Vote signal:    candidate rejects evil-containing teams (+)
 *   2. Proposal signal: candidate's proposed team excludes knownEvils (+)
 *   3. Participation:   candidate avoids fail-mission rosters (+)
 *
 * Cold-start (R1, voteHistory.length === 0) → returns 0.5 (no signal),
 * caller treats as "盲賭". From R2 onward signals accumulate.
 *
 * Output ∈ [0, 1] — higher means "more likely Merlin than Morgana".
 */
function scoreWizardAsMerlin(
  wizardId: string,
  obs: PlayerObservation,
  pyramid: PyramidScores,
): number {
  if (obs.voteHistory.length === 0) return 0.5;
  const knownEvilSet = new Set(obs.knownEvils);
  let score = 0;
  let total = 0;

  // Signal 1: rejected teams that contained pyramid-suspect / known-evil.
  for (const v of obs.voteHistory) {
    const teamHasSuspect = v.team.some(
      (id) => knownEvilSet.has(id) ||
        ((pyramid.scores.get(id) ?? 0.5) >= PYRAMID_VIOLATOR_FLOOR),
    );
    const myVote = v.votes[wizardId];
    if (myVote === undefined) continue;
    total += 1;
    if (teamHasSuspect && myVote === false) score += 1; // reject sketchy
    if (!teamHasSuspect && myVote === true) score += 0.5; // approve clean
    if (teamHasSuspect && myVote === true) score -= 0.5; // approve sketchy → red signal
  }

  // Signal 2: appeared on fail mission → NOT Merlin.
  for (const q of obs.questHistory) {
    if (q.result === 'fail' && q.team.includes(wizardId)) {
      score -= 1;
      total += 1;
    }
  }

  if (total === 0) return 0.5;
  // Map score / total to [0, 1] — sigmoid-ish soft clamp.
  const raw = 0.5 + (score / Math.max(2, total));
  if (raw < 0) return 0;
  if (raw > 1) return 1;
  return raw;
}

/**
 * Detect "梅躲刺" — Merlin's vote pattern looks too pure-baseline (no
 * inner-black, no outer-white) → low information leaked → likely
 * hiding from assassin.
 *
 * Trigger: candidate has voteHistory.length >= 2 AND
 *   - voted exactly the baseline (on-team approve / off-team reject)
 *     in every R1-R3 round, AND
 *   - never proposed a team that excluded a knownEvil from Percival's
 *     POV (which would be a pro-merlin signal).
 *
 * Returns `true` when the wizard's pattern is suspiciously sterile —
 * Percival should DISTRUST that candidate (reduce trust from default
 * 0.7 to 0.4 per spec §2.6).
 */
function detectMerlinHidingFromAssassin(
  wizardId: string,
  obs: PlayerObservation,
): boolean {
  if (obs.voteHistory.length < 2) return false;
  let suspiciouslyBaseline = 0;
  let total = 0;
  for (const v of obs.voteHistory) {
    if (v.round > 3) continue; // only R1-R3
    const myVote = v.votes[wizardId];
    if (myVote === undefined) continue;
    total += 1;
    const onTeam = v.team.includes(wizardId);
    const baselineVote = onTeam ? true : false;
    if (myVote === baselineVote) suspiciouslyBaseline += 1;
  }
  return total >= 3 && suspiciouslyBaseline === total;
}

/**
 * Detect "娜出賣隊友保忠臣" — Morgana cast a reject against a team
 * containing a publicly-failed (i.e. publicly-known-red) member. That
 * is a "betrayal" signal — atypical Morgana behaviour, suggests she's
 * actively sabotaging her own ally to preserve disguise.
 *
 * Returns `true` when at least one such reject exists.
 */
function detectMorganaBetrayal(
  wizardId: string,
  obs: PlayerObservation,
): boolean {
  // Failed-mission members = public information any role can read.
  const failedMembers = new Set<string>();
  for (const q of obs.questHistory) {
    if (q.result === 'fail') for (const id of q.team) failedMembers.add(id);
  }
  if (failedMembers.size === 0) return false;
  for (const v of obs.voteHistory) {
    const myVote = v.votes[wizardId];
    if (myVote !== false) continue;
    if (v.team.some((id) => failedMembers.has(id))) return true;
  }
  return false;
}

// ── Public: build per-role signals ──────────────────────────────
/**
 * Build the role-specific signal package for `obs`. Pure projection.
 *
 * - merlin:   knownWizardSuspicions over knownEvils (Edward sees 3 evils)
 * - percival: knownWizardSuspicions + wizardMerlinScores + A/B + signals
 * - assassin: knownAllyCount (knownEvils for assassin = 莫娜+莫德)
 * - morgana:  knownAllyCount (= 刺+莫德)
 * - mordred:  knownAllyCount (= 刺+莫娜) + R1-leader flag
 * - oberon:   participation flags from buildOberonContext (subset)
 * - loyal:    neutral (no override)
 */
export function getRoleSignals(obs: PlayerObservation): RoleSignals {
  const role = obs.myRole;
  if (role === 'loyal' || role === 'minion') return neutralRoleSignals();

  const pyramid = computePyramidScores(obs);

  const knownWizardSuspicions = new Map<string, number>();
  const wizardMerlinScores = new Map<string, number>();

  // Percival path — wizards joint constraint + signal probes.
  if (role === 'percival') {
    const wizards = obs.knownWizards ?? [];
    if (wizards.length !== 2) {
      // Defensive — Avalon spec guarantees exactly 2 wizards for Percival.
      // Fall through to neutral signals if invariant violated.
      return neutralRoleSignals();
    }
    for (const w of wizards) {
      knownWizardSuspicions.set(w, pyramid.scores.get(w) ?? 0.5);
      wizardMerlinScores.set(w, scoreWizardAsMerlin(w, obs, pyramid));
    }
    // Pick A = max merlinScore wizard, B = the other.
    let aId = wizards[0];
    let bId = wizards[1];
    if ((wizardMerlinScores.get(bId) ?? 0) > (wizardMerlinScores.get(aId) ?? 0)) {
      [aId, bId] = [bId, aId];
    }
    const merlinHidingFromAssassin = detectMerlinHidingFromAssassin(aId, obs);
    const morganaBetrayal = detectMorganaBetrayal(bId, obs);
    return {
      ...neutralRoleSignals(),
      knownWizardSuspicions,
      wizardMerlinScores,
      percivalA: aId,
      percivalB: bId,
      merlinHidingFromAssassin,
      morganaBetrayal,
    };
  }

  // Merlin path — knownEvils hardpin (3 evils visible to Merlin).
  if (role === 'merlin') {
    for (const id of obs.knownEvils) {
      knownWizardSuspicions.set(id, 1.0); // hardpin to red
    }
    return {
      ...neutralRoleSignals(),
      knownWizardSuspicions,
    };
  }

  // Evil path (assassin / morgana / mordred / oberon) — ally count.
  const knownAllyCount = obs.knownEvils.length;

  if (role === 'mordred') {
    // R1-leader detection: questHistory empty AND voteHistory empty AND
    // currentLeader === self → first-ever leader role.
    const isR1Leader =
      (obs.currentRound ?? 1) === 1 &&
      obs.voteHistory.length === 0 &&
      obs.currentLeader === obs.myPlayerId;
    return {
      ...neutralRoleSignals(),
      knownAllyCount,
      mordredR1Leader: isR1Leader,
    };
  }

  if (role === 'oberon') {
    // Spec §6.2 — derive from public quest history only. Mirrors
    // `buildOberonContext` in HeuristicAgent (kept inline here to avoid
    // exposing baseline private helper).
    let mp = false;
    let fm = false;
    for (const q of obs.questHistory) {
      if (q.team.includes(obs.myPlayerId)) {
        mp = true;
        if (q.result === 'fail') fm = true;
      }
    }
    return {
      ...neutralRoleSignals(),
      knownAllyCount, // == 0 for oberon by definition
      oberonMissionParticipatedBefore: mp,
      oberonFailedInMission: fm,
    };
  }

  // assassin / morgana
  return {
    ...neutralRoleSignals(),
    knownAllyCount,
  };
}

// ── Action helpers ──────────────────────────────────────────────
function isApprove(action: AgentAction): boolean {
  return action.type === 'team_vote' && action.vote === true;
}
function isReject(action: AgentAction): boolean {
  return action.type === 'team_vote' && action.vote === false;
}
function isQuestSuccess(action: AgentAction): boolean {
  return action.type === 'quest_vote' && action.vote === 'success';
}
function isQuestFail(action: AgentAction): boolean {
  return action.type === 'quest_vote' && action.vote === 'fail';
}
function isTeamSelect(action: AgentAction): boolean {
  return action.type === 'team_select';
}
function isAssassinate(action: AgentAction): boolean {
  return action.type === 'assassinate';
}

/**
 * Bias type — sparse delta map applied additively to the generic
 * purpose-alignment vector. Returning purpose deltas (not raw scores)
 * keeps role overrides composable with the round-aware purpose weights.
 */
export type RoleBiasDelta = Partial<{
  threeBlueWins: number;
  threeRedWins: number;
  hideMerlin: number;
  findMerlin: number;
  mimicMerlin: number;
  hidePercival: number;
  hideFromMerlin: number;
  avoidFriendlyFire: number;
  findGoodTeam: number;
  dontOverPushRed: number;
  forceMerlinKill: number;
}>;

// ── Per-role bias projections ───────────────────────────────────

/**
 * Bias for **梅林 (merlin)** — spec §1.4.
 *
 *   selectTeam:    強制排除 knownEvils + pyramid violators
 *   voteOnTeam:    team ∩ knownEvils → reject (boost reject side)
 *                  team 純藍 + 中度疑紅 → 不主動 reject (隱身)
 *   voteOnQuest:   on-team success boost (loyal default)
 *
 * Implementation:
 *   - team_select containing knownEvil → strong negative threeBlueWins delta
 *   - team_vote reject team containing knownEvil → strong positive hideMerlin delta
 *   - team_vote reject team that's pure clean (no knownEvil) → negative
 *     hideMerlin delta (don't out yourself)
 */
function biasForMerlin(
  action: AgentAction,
  signals: { numKnownEvilOnTeam: number; avgSuspicion: number },
): RoleBiasDelta {
  const evilOnTeam = signals.numKnownEvilOnTeam > 0;
  if (isTeamSelect(action)) {
    if (evilOnTeam) return { threeBlueWins: -1.0, hideMerlin: -1.0 };
    // Clean team → standard, slight hideMerlin nudge (don't make it TOO clean).
    return {};
  }
  if (isApprove(action)) {
    if (evilOnTeam) return { threeBlueWins: -0.6, hideMerlin: -0.4 };
    return { threeBlueWins: 0.3 };
  }
  if (isReject(action)) {
    if (evilOnTeam) return { threeBlueWins: 0.8, hideMerlin: 0.5 };
    // Reject pure-clean team → outs you as merlin.
    if (signals.avgSuspicion < 0.3) return { hideMerlin: -0.6, dontOverPushRed: -0.5 };
    return {};
  }
  if (isQuestSuccess(action)) return { threeBlueWins: 0.5 };
  if (isQuestFail(action)) return { threeBlueWins: -1.0 };
  return {};
}

/**
 * Bias for **派西 (percival)** — spec §2.4.
 *
 *   selectTeam:
 *     R2+: prefer A (high merlin score) include, B (morgana) exclude;
 *          if "梅躲刺" → distrust A too (don't include);
 *          if "娜出賣隊友" → optionally include B.
 *   voteOnTeam:
 *     team ∩ B → reject (default — not trust B);
 *     team 高 pyramid 疑紅 → reject;
 *     team has both wizards (intersection) → reject.
 *   voteOnQuest:
 *     on-team success (good faction).
 *
 * The bias delta encodes the wizard A/B asymmetry without the actual
 * candidate-team ID list — caller passes pre-computed inclusion flags
 * via `extras`.
 */
function biasForPercival(
  action: AgentAction,
  signals: {
    numKnownEvilOnTeam: number;
    avgSuspicion: number;
    teamIncludesPercivalA: boolean;
    teamIncludesPercivalB: boolean;
    merlinHidingFromAssassin: boolean;
    morganaBetrayal: boolean;
  },
): RoleBiasDelta {
  if (isTeamSelect(action)) {
    let bias: RoleBiasDelta = {};
    if (signals.teamIncludesPercivalB) {
      // Default: exclude B — heavy negative findMerlin / hidePercival.
      bias = { findMerlin: -0.8, hidePercival: -0.4, threeBlueWins: -0.4 };
      if (signals.morganaBetrayal) {
        // Exception — B might be betraying. Lighter penalty (still negative).
        bias = { findMerlin: -0.2, hidePercival: -0.2, threeBlueWins: -0.1 };
      }
    } else if (signals.teamIncludesPercivalA) {
      if (signals.merlinHidingFromAssassin) {
        // 梅躲刺 detected → don't reward A inclusion.
        bias = { findMerlin: 0.1, hidePercival: 0.1 };
      } else {
        // Standard: include A is the goal.
        bias = { findMerlin: 0.6, hidePercival: 0.2, threeBlueWins: 0.3 };
      }
    }
    return bias;
  }
  if (isApprove(action)) {
    if (signals.teamIncludesPercivalB && !signals.morganaBetrayal) {
      return { findMerlin: -0.5, hidePercival: -0.3 };
    }
    if (signals.numKnownEvilOnTeam > 0) {
      // Percival doesn't have knownEvils, but signals carry pyramid-derived
      // ones (forwarded for symmetry); reject-leaning.
      return { threeBlueWins: -0.4 };
    }
    return { threeBlueWins: 0.2, hidePercival: 0.1 };
  }
  if (isReject(action)) {
    if (signals.teamIncludesPercivalB) {
      return { findMerlin: 0.5, hidePercival: 0.3 };
    }
    if (signals.avgSuspicion < 0.3) {
      // Reject clean team → outs as percival (rejecting pure-clean teams
      // is rare for any good role).
      return { hidePercival: -0.5, dontOverPushRed: -0.4 };
    }
    return {};
  }
  if (isQuestSuccess(action)) return { threeBlueWins: 0.5 };
  if (isQuestFail(action)) return { threeBlueWins: -1.0 };
  return {};
}

/**
 * Bias for **刺客 (assassin)** — spec §3.4.
 *
 *   selectTeam:
 *     R1: mimic-loyal — no ally on team (negative bias on knownEvil
 *         inclusion at R1).
 *     R3+: mayBreakHardRules → 衝刺隊友 mode (positive ally inclusion).
 *   voteOnTeam:
 *     R1-R2 → delegated to baseline (handled upstream).
 *     R3+: cover ally on team (approve), reject pure-blue when winning.
 *   voteOnQuest:
 *     listening (goodWins===2 || evilWins===2) → fail (handled
 *     downstream by listening rule); non-listening → EVIL_HIERARCHY
 *     (handled by baseline; here we boost fail when evil-team-mate
 *     count signals it's safe).
 *   assassinate:
 *     find merlin — boost forceMerlinKill alignment, suppress when
 *     target is known ally / Oberon (allEvilIds filter handled upstream).
 */
function biasForAssassin(
  action: AgentAction,
  obs: PlayerObservation,
  signals: {
    numKnownEvilOnTeam: number;
    avgSuspicion: number;
    includesKnownEvil: boolean;
    merlinProbForTarget: number;
    targetIsKnownAlly: boolean;
    targetIsOberon: boolean;
  },
): RoleBiasDelta {
  const round = obs.currentRound ?? 1;
  const evilWins = obs.questResults.filter((r) => r === 'fail').length;
  const goodWins = obs.questResults.filter((r) => r === 'success').length;
  const listening = goodWins === 2 || evilWins === 2;

  if (isTeamSelect(action)) {
    if (round === 1) {
      // R1 mimic-loyal — DO NOT include ally. Base alignment gives
      // ally-team a +threeRedWins bonus; we need to *override* that to
      // a negative delta strong enough to flip the sign. Worst-case
      // base for ally team ≈ +1.0; clamp to -1.0 means the bias must
      // saturate. We push -1.5 here even though the clamp caps it —
      // the magnitude is intentional documentation that R1 ally is
      // strictly forbidden.
      if (signals.numKnownEvilOnTeam > 0) {
        return { threeRedWins: -1.5, hideFromMerlin: -0.5 };
      }
      // Mimic-loyal clean team: positive bias proportional to absent
      // evil. Combined with base -0.5 (no ally) → net positive after
      // clamp.
      return { threeRedWins: 1.0, hideFromMerlin: 0.5 };
    }
    // R3+: ally inclusion OK (allyInclusionMultiplier 0.5 in baseline).
    if (signals.numKnownEvilOnTeam > 0) {
      return { threeRedWins: 0.4 };
    }
    return {};
  }
  if (isApprove(action)) {
    if (signals.numKnownEvilOnTeam > 0) return { threeRedWins: 0.5 };
    return {};
  }
  if (isReject(action)) {
    if (signals.numKnownEvilOnTeam > 0) {
      // Don't reject ally team.
      return { threeRedWins: -0.5 };
    }
    return {};
  }
  if (isQuestSuccess(action)) {
    if (listening) return { threeRedWins: -1.0 }; // listening must fail
    return {};
  }
  if (isQuestFail(action)) {
    if (listening) return { threeRedWins: 0.8 };
    if (round <= 3) return { threeRedWins: 0.4 };
    return {};
  }
  if (isAssassinate(action)) {
    if (signals.targetIsKnownAlly || signals.targetIsOberon) {
      return { forceMerlinKill: -1.0, threeRedWins: -1.0, avoidFriendlyFire: -1.0 };
    }
    // Higher merlinProbForTarget → more positive bias.
    const k = 2 * (signals.merlinProbForTarget - 0.5);
    return { forceMerlinKill: k, threeRedWins: k * 0.5 };
  }
  return {};
}

/**
 * Bias for **莫甘娜 (morgana)** — spec §4.4 (Edward 2026-05-11 doctrine change).
 *
 *   Edward verbatim:「不用刻意演 預設策略就是忠臣 莫甘看不到奧 也分不出
 *   刺/莫德 怎麼演」. Default doctrine = **mimicLoyal** (act exactly like a
 *   loyal would). The classic mimicMerlin posture is downgraded to advanced /
 *   late-round opt-in because the morgana lacks the hidden-info needed to
 *   bluff merlin convincingly:
 *     1. morgana cannot see oberon (oberon is hidden from all evil except by
 *        the engine's reveal — morgana POV ⊇ {self, assassin, mordred} only);
 *     2. morgana cannot distinguish assassin vs mordred internally — so
 *        attempting to push "I'm merlin and X is morgana" risks fingering
 *        her own teammate.
 *   The clean fallback is loyal-mimicry: vote/select as a loyal would
 *   (findGoodTeam dominates), then fail when listening.
 *
 *   selectTeam:
 *     R1: mimic-loyal pure clean team — exclude knownEvils (same shape as
 *         loyal R1 — pick the seat with lowest pyramid suspicion).
 *     R3+: mimic-loyal + selective ally inclusion when winning red track.
 *   voteOnTeam:
 *     mimic-loyal — approve clean teams, reject suspect-heavy teams.
 *     Cover ally inclusion only when red is winning.
 *   voteOnQuest:
 *     listening fail; non-listening play success to maintain disguise.
 *
 *   HR-8.2「莫甘都想演梅」is downgraded — see HeuristicAgent line ~1830.
 */
function biasForMorgana(
  action: AgentAction,
  obs: PlayerObservation,
  signals: {
    numKnownEvilOnTeam: number;
    avgSuspicion: number;
  },
): RoleBiasDelta {
  const round = obs.currentRound ?? 1;
  const evilWins = obs.questResults.filter((r) => r === 'fail').length;
  const goodWins = obs.questResults.filter((r) => r === 'success').length;
  const listening = goodWins === 2 || evilWins === 2;

  if (isTeamSelect(action)) {
    if (round === 1) {
      // R1: mimic-loyal pure clean — exclude allies. Same magnitude
      // override as assassin §3.4 R1 mimic-loyal: ally inclusion must
      // produce negative net even after base +threeRedWins boost.
      if (signals.numKnownEvilOnTeam > 0) {
        return { findGoodTeam: -0.7, threeRedWins: -1.5 };
      }
      return { findGoodTeam: 0.5, threeRedWins: 1.0 };
    }
    if (signals.numKnownEvilOnTeam > 0) {
      // R3+: occasional ally inclusion (allyInclusionMultiplier 0.6).
      return { threeRedWins: 0.3, findGoodTeam: -0.3 };
    }
    // Clean team — strong mimic-loyal signal.
    return { findGoodTeam: 0.5, threeRedWins: -0.1 };
  }
  if (isApprove(action)) {
    if (signals.numKnownEvilOnTeam > 0) return { threeRedWins: 0.5 };
    if (signals.avgSuspicion < 0.3) return { findGoodTeam: 0.4 };
    return {};
  }
  if (isReject(action)) {
    if (signals.numKnownEvilOnTeam > 0) {
      return { threeRedWins: -0.5, findGoodTeam: 0.2 }; // mimic loyal reject sketchy
    }
    if (signals.avgSuspicion >= 0.6) return { findGoodTeam: 0.3 }; // mimic loyal reject suspect
    return {};
  }
  if (isQuestSuccess(action)) {
    if (listening) return { threeRedWins: -1.0 };
    if (round <= 3 && obs.knownEvils.length > 0) return { findGoodTeam: 0.3 };
    return {};
  }
  if (isQuestFail(action)) {
    if (listening) return { threeRedWins: 0.8 };
    if (round <= 3) return { threeRedWins: 0.2, findGoodTeam: -0.2 };
    return { threeRedWins: 0.3 };
  }
  return {};
}

/**
 * Bias for **莫德雷德 (mordred)** — spec §5.4.
 *
 *   selectTeam:
 *     R1 leader: mimic loyal — exclude allies (effective WR 71.74%).
 *     R3+: bold ally inclusion (allyInclusionMultiplier=1.3).
 *   voteOnTeam:
 *     R3+: aggressive ally cover; mimic loyal cleanup.
 *   voteOnQuest:
 *     listening fail; non-listening earlyFailBonus +0.10.
 */
function biasForMordred(
  action: AgentAction,
  obs: PlayerObservation,
  signals: {
    numKnownEvilOnTeam: number;
    avgSuspicion: number;
    mordredR1Leader: boolean;
  },
): RoleBiasDelta {
  const round = obs.currentRound ?? 1;
  const evilWins = obs.questResults.filter((r) => r === 'fail').length;
  const goodWins = obs.questResults.filter((r) => r === 'success').length;
  const listening = goodWins === 2 || evilWins === 2;

  if (isTeamSelect(action)) {
    if (signals.mordredR1Leader) {
      // R1 leader → mimic-loyal pure clean. Strong override.
      if (signals.numKnownEvilOnTeam > 0) {
        return { hideFromMerlin: -1.0, threeRedWins: -1.5 };
      }
      return { hideFromMerlin: 0.4, threeRedWins: 1.0 };
    }
    if (round === 1) {
      // R1 (non-leader proposing) — same mimic-loyal preference.
      if (signals.numKnownEvilOnTeam > 0) {
        return { threeRedWins: -1.5 };
      }
      return { threeRedWins: 1.0 };
    }
    if (signals.numKnownEvilOnTeam > 0) {
      // R3+: bold ally inclusion (1.3x).
      return { threeRedWins: 0.6, hideFromMerlin: 0.3 };
    }
    return {};
  }
  if (isApprove(action)) {
    if (signals.numKnownEvilOnTeam > 0) return { threeRedWins: 0.6 };
    return {};
  }
  if (isReject(action)) {
    if (signals.numKnownEvilOnTeam > 0) return { threeRedWins: -0.6 };
    return {};
  }
  if (isQuestSuccess(action)) {
    if (listening) return { threeRedWins: -1.0 };
    return {};
  }
  if (isQuestFail(action)) {
    if (listening) return { threeRedWins: 0.8 };
    if (round <= 3) return { threeRedWins: 0.5 };
    return { threeRedWins: 0.3 };
  }
  return {};
}

/**
 * Bias for **奧伯倫 (oberon)** — spec §6.4.
 *
 *   Lone-wolf: knownEvils=[] so EVIL_HIERARCHY skipped, allyInclusion N/A.
 *   selectTeam: pure loyal-baseline (no ally bias).
 *   voteOnTeam:
 *     Rule 1 (!missionParticipatedBefore): R1 normal vote → handled by
 *       baseline R1-R2 force-normal (already delegated upstream).
 *     Rule 3 (failedInMission && round > firstFailedRound): off-team
 *       open-white = approve (positive bias for approve regardless of
 *       team color).
 *     Rule 5a (R5 + totalFails>=1): off-team approve.
 *   voteOnQuest:
 *     Rule 2 (R1-R3 on-team): fail (positive threeRedWins).
 *     Rule 4 (R4 + hasTeammateSuspicion): fail; else success.
 *     Rule 5c (R5 + totalFails>=1): fail.
 *     Listening: 70% fail / 30% success (lone-wolf can't coordinate).
 */
function biasForOberon(
  action: AgentAction,
  obs: PlayerObservation,
  signals: {
    numKnownEvilOnTeam: number;
    avgSuspicion: number;
    oberonMissionParticipatedBefore: boolean;
    oberonFailedInMission: boolean;
  },
): RoleBiasDelta {
  const round = obs.currentRound ?? 1;
  const evilWins = obs.questResults.filter((r) => r === 'fail').length;
  const goodWins = obs.questResults.filter((r) => r === 'success').length;
  const listening = goodWins === 2 || evilWins === 2;

  if (isTeamSelect(action)) {
    // Loyal-baseline behaviour — prefer low suspicion.
    if (signals.avgSuspicion < 0.3) return { threeRedWins: 0.1 };
    return {};
  }
  if (isApprove(action)) {
    // Rule 3 / Rule 5a — open-white when has prior fail-mission record.
    // Saturating override — base off-team-approve has -0.5 threeRedWins
    // (default loyal), so we push +1.5 to flip the sign even after clamp.
    if (
      signals.oberonFailedInMission &&
      round >= 3 &&
      signals.numKnownEvilOnTeam === 0
    ) {
      return { threeRedWins: 1.5 };
    }
    if (round === 5 && evilWins >= 1) return { threeRedWins: 1.5 };
    return {};
  }
  if (isReject(action)) {
    // Rule 3 / Rule 5a — open-white triggers ↔ reject penalised.
    if (
      signals.oberonFailedInMission &&
      round >= 3 &&
      signals.numKnownEvilOnTeam === 0
    ) {
      return { threeRedWins: -0.8 };
    }
    if (round === 5 && evilWins >= 1) return { threeRedWins: -0.8 };
    return {};
  }
  if (isQuestSuccess(action)) {
    if (listening) return { threeRedWins: -0.4 }; // 30% chance success
    if (round === 4 && !signals.oberonFailedInMission) {
      // Rule 4 — no teammate suspicion → success.
      return { threeRedWins: 0.2 };
    }
    return {};
  }
  if (isQuestFail(action)) {
    // Rule 2: R1-R3 on-team → fail.
    if (round <= 3) return { threeRedWins: 0.6 };
    // Rule 4: R4 + has teammate suspicion → fail.
    if (round === 4 && signals.oberonFailedInMission) return { threeRedWins: 0.5 };
    // Rule 5c: R5 + totalFails>=1 → fail.
    if (round === 5 && evilWins >= 1) return { threeRedWins: 0.5 };
    if (listening) return { threeRedWins: 0.4 }; // 70% chance fail
    return {};
  }
  return {};
}

// ── Public: applyRoleBias ───────────────────────────────────────
/**
 * Compute the additive role bias for a given role × candidate × obs.
 *
 * Returned delta is added to the generic `computePurposeAlignment`
 * vector before purpose-weighted dot product. Sparse — most roles emit
 * zero across most fields.
 *
 * `extras` carries pre-computed candidate-derived signals that the
 * caller has already extracted (avoid recomputing pyramid in every
 * scoring call).
 */
export function applyRoleBias(
  role: Role,
  action: AgentAction,
  obs: PlayerObservation,
  signals: {
    numKnownEvilOnTeam: number;
    avgSuspicion: number;
    includesKnownEvil: boolean;
    merlinProbForTarget: number;
    teamIncludesPercivalA: boolean;
    teamIncludesPercivalB: boolean;
    merlinHidingFromAssassin: boolean;
    morganaBetrayal: boolean;
    mordredR1Leader: boolean;
    targetIsKnownAlly: boolean;
    targetIsOberon: boolean;
    oberonMissionParticipatedBefore: boolean;
    oberonFailedInMission: boolean;
  },
): RoleBiasDelta {
  switch (role) {
    case 'loyal':
    case 'minion':
      return {}; // no override
    case 'merlin':
      return biasForMerlin(action, signals);
    case 'percival':
      return biasForPercival(action, signals);
    case 'assassin':
      return biasForAssassin(action, obs, signals);
    case 'morgana':
      return biasForMorgana(action, obs, signals);
    case 'mordred':
      return biasForMordred(action, obs, signals);
    case 'oberon':
      return biasForOberon(action, obs, signals);
    default: {
      const _exhaustive: never = role;
      void _exhaustive;
      return {};
    }
  }
}

// ── Re-exports for tests ────────────────────────────────────────
export {
  scoreWizardAsMerlin,
  detectMerlinHidingFromAssassin,
  detectMorganaBetrayal,
};
