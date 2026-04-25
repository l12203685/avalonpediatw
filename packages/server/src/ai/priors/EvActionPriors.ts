/**
 * EvActionPriors — Action × Outcome causal-EV priors (2026-04-25)
 *
 * Inline-constant module that surfaces 5 production AI hooks distilled
 * from `staging/selfplay/action_ev_consolidated_v6.md` (2146 real-game
 * outcomes, 14 features × 3-outcome causal attribution).
 *
 * Hook contract (each hook returns either a concrete delta/decision or
 * `null` to signal "no prior signal — fall through to legacy logic"):
 *
 *   1. {@link assassinTargetPenalty}         — assassinTargetPrior
 *   2. {@link voteInnerBlackBonus}           — voteInnerBlackPrior (round-cond)
 *   3. {@link seatPriorByRole}               — scoreSeatPriorByRole
 *   4. {@link r1LeaderRolePrior}             — r1LeaderRolePrior_<role>_outcome_<r1_result>
 *   5. {@link lakeDeclareLiePrior}           — lakeDeclare_lie_Prior
 *
 * Design invariants:
 * - All numbers are derived from 95% Wilson CI lower-bounded, n ≥ 30 only.
 * - Baseline (red faction-favourable) = 0.6957 (1493/2146). Blue = 0.3043.
 * - Δpp = ev_rate − baseline; positive = action is +EV for that role.
 * - Hooks return *additive deltas* applied on top of legacy heuristics,
 *   NEVER replace the legacy decision wholesale. Fallback chain stays:
 *     historical-prior delta → legacy → hardcoded.
 * - Feature-flag `USE_EV_ACTION_PRIORS` env var (`'0'` = off; default on).
 *
 * Data source citations (line numbers in action_ev_consolidated_v6.md):
 *   - Hook 1 (assassin target):  L364 (loyal -69.57), L365 (percival -69.57)
 *   - Hook 2 (inner-black R3-R5): L79-114 (Δ +13~+22pp red roles)
 *   - Hook 3 (seat by role):     L94 (merlin@10 +13.51), L100 (mordred@5 +10.18),
 *                                 L111 (morgana@5 +6.76), L316 (merlin@2 -8.15)
 *   - Hook 4 (R1 leader):        L87 (loyal success +16.21), L93 (percival
 *                                 success +13.54), L121/151 (morgana/mordred fail)
 *   - Hook 5 (lake declare lie): L131 (any_holder lie +4.62 surface neutral
 *                                 but red-side morgana/oberon/assassin
 *                                 declare lie still +EV at L85, L103, L104)
 */

// ── Feature flag ────────────────────────────────────────────────────
/**
 * Reads `USE_EV_ACTION_PRIORS` env var. Defaults to `true`.
 * Set to `'0'` or `'false'` for emergency rollback to legacy-only paths.
 */
export function isEvActionPriorsEnabled(): boolean {
  const v = process.env.USE_EV_ACTION_PRIORS;
  if (v === undefined) return true;
  return v.toLowerCase() !== 'false' && v !== '0';
}

// ── Type exports ────────────────────────────────────────────────────
/** 1-indexed seat number (1-10 for a 10p game). */
export type Seat = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
/** Round index used by anomaly-vote tables. */
export type Round = 1 | 2 | 3 | 4 | 5;
/** Roles whose anomaly-vote inner-black behaviour is round-conditioned. */
export type AnomalyRole =
  | 'assassin' | 'morgana' | 'mordred' | 'oberon'
  | 'merlin' | 'percival' | 'loyal';
/** R1 leader role for the r1LeaderRolePrior. */
export type R1LeaderRole =
  | 'loyal' | 'merlin' | 'percival'
  | 'assassin' | 'morgana' | 'mordred' | 'oberon';
/** R1 mission outcome. */
export type R1Outcome = 'success' | 'fail';

// ── Hook 1 · Assassin target prior ──────────────────────────────────
/**
 * EV table for "assassinate target = X". Loyal & Percival are -69.57pp
 * (assassinating them = guaranteed loss, since Merlin survives).
 *
 * Returns a *penalty* (lower = stronger discouragement) added to the
 * Merlin-likeness score in `HeuristicAgent.assassinate`. Merlin returns
 * 0 (no penalty), loyal/percival return a strong negative.
 *
 * Magnitude: 3.0 chosen to dominate the existing ±2.0 merlin-like signals
 * (see `HeuristicAgent.getMerlinScore` per-vote +2.0 max). When a
 * candidate is suspected loyal/percival the prior pulls them firmly out
 * of the running. Merlin score remains the discriminator within the
 * merlin pool.
 */
export const ASSASSIN_TARGET_PENALTY: Record<string, number> = {
  loyal: -3.0,        // Δ -69.57pp · n = 467
  percival: -3.0,     // Δ -69.57pp · n = 158
  merlin: 0.0,        // Δ +30.43pp (the kill target — no penalty)
};

/**
 * Look up the assassin-target penalty for a candidate's *suspected* role.
 *
 * In production assassin POV the role is unknown — caller is expected to
 * pass the inferred role from `getMerlinScore` / `getPercivalLikenessPenalty`.
 * Returns 0 for unrecognised role labels (safe default — no nudge).
 */
export function assassinTargetPenalty(suspectedRole: string | undefined): number {
  if (!isEvActionPriorsEnabled()) return 0;
  if (!suspectedRole) return 0;
  return ASSASSIN_TARGET_PENALTY[suspectedRole] ?? 0;
}

// ── Hook 2 · Inner-black anomaly bonus by round × role ──────────────
/**
 * EV bonus for a red-faction "inner-black" team-vote anomaly (on-team
 * reject) at a given round. Positive Δpp = +EV for the role's faction.
 *
 * Source rows (n ≥ 30): action_ev_consolidated_v6.md L79-114, L302-334.
 * Numbers below are the table's `ev_delta_pp` divided by 100 so the
 * caller can use them as a probability bump in `[0, 1]` space.
 *
 * Caller wires this in `voteOnTeam` evil branch: when a red role is
 * on-team and R3+, the bump shifts the cover-approve baseline a bit
 * toward inner-black reject — but always capped to keep the legacy
 * branch in charge. Returns 0 for negative-EV combinations (the legacy
 * branch already produces approve in those cases).
 *
 * Read as: "additive probability of choosing inner-black anomaly given
 * on-team red role at round R, over and above legacy."
 */
const INNER_BLACK_BONUS_BY_ROLE_ROUND: Partial<Record<
  AnomalyRole, Partial<Record<Round, number>>
>> = {
  // Mordred — strongest signal, esp. R5 (+0.218) and R3 (+0.205)
  mordred: { 3: 0.205, 4: 0.152, 5: 0.218 },
  // Assassin — R3/R4/R5 all positive
  assassin: { 3: 0.183, 4: 0.192, 5: 0.060 },
  // Morgana — R3/R4 positive, R5 modest
  morgana: { 3: 0.125, 4: 0.159, 5: 0.064 },
  // Oberon — R3/R4/R5 positive
  oberon: { 3: 0.136, 4: 0.074, 5: 0.210 },
  // Merlin — small positive R2/R4 (she rejects clean teams she's on
  // when she sees a thumb opportunity, baseline-adjusted)
  merlin: { 2: 0.061, 4: 0.057 },
  // Percival — R2 positive only
  percival: { 2: 0.105 },
  // Loyal — no significant +EV inner-black at any round (omitted)
};

/**
 * Inner-black bonus probability for a (role, round) cell.
 *
 * Returns 0 when the cell is missing, negative-EV, or below the n ≥ 30
 * confidence floor. Caller's legacy logic stays in charge — this just
 * provides a small additive nudge on the cover-approve probability.
 *
 * Conditional gating: caller MUST verify `round >= 3` before applying
 * this bump for red roles outside R3-R5 (their R1-R2 inner-black is
 * negative-EV — see L319, L334 for mordred R1/R2 -9.03pp / -14.73pp).
 * The map above already filters those cells, but the gating belongs
 * to the caller for clarity.
 */
export function voteInnerBlackBonus(
  role: string | undefined,
  round: number,
): number {
  if (!isEvActionPriorsEnabled()) return 0;
  if (!role) return 0;
  const r = Math.trunc(round);
  if (r < 1 || r > 5) return 0;
  const roleMap = INNER_BLACK_BONUS_BY_ROLE_ROUND[role as AnomalyRole];
  if (!roleMap) return 0;
  return roleMap[r as Round] ?? 0;
}

// ── Hook 3 · Seat × role prior ──────────────────────────────────────
/**
 * EV delta (pp / 100) for "role X occupies seat Y". Used as:
 *  - Defensive signal: assassin should *avoid* assassinating seat=10
 *    target (Δ -29.57pp at L354) and seat=5 (Δ -20.95pp at L341)
 *  - Offensive signal: assassin should preferentially target seats with
 *    high merlin occupancy (seat=10 with merlin Δ +13.51pp at L94)
 *
 * Returns an additive bonus to the merlin-likeness score in
 * `HeuristicAgent.assassinate`. Caller passes (suspectedRole='merlin',
 * seat=N) to read "how often does Merlin sit at seat N" — high value
 * means we should weight that candidate higher as a Merlin target.
 *
 * For non-merlin roles the table reads "how often this seat is held by
 * NOT-merlin" — used by caller to *de-prioritise* seats with high
 * mordred/morgana occupancy (those roles are harder to assassinate
 * cleanly because Merlin rarely sits there).
 */
const SEAT_PRIOR_BY_ROLE: Partial<Record<
  string, Partial<Record<Seat, number>>
>> = {
  // Merlin — seats with elevated occupancy (target enrichment for assassin)
  // Source: action_ev_consolidated_v6.md L94, L129, L130, L180
  merlin: {
    10: 0.135,  // L94  · n = 198 · Δ +13.51pp
    5:  0.047,  // L129 · n = 225 · Δ  +4.68pp
    9:  0.046,  // L130 · n = 211 · Δ  +4.64pp
    6:  0.011,  // L180 · n = 241 · Δ  +1.11pp
    // negative seats — merlin LESS likely there → de-prioritise as target
    2: -0.082,  // L316 · n = 211 · Δ  -8.15pp
    8: -0.052,  // L296 · n = 218 · Δ  -5.20pp
    3: -0.047,  // L292 · n = 206 · Δ  -4.70pp
  },
  // Mordred — high occupancy at seat 5 (+10.18pp), seat 10 (+4.01pp)
  // Caller can use to FILTER OUT mordred-likely seats from assassin pool
  mordred: {
    5:  0.102,  // L100 · n = 237 · Δ +10.18pp
    10: 0.040,  // L139 · n = 212 · Δ  +4.01pp
  },
  // Morgana — seat 5 high (+6.76pp), seat 4 (+1.72pp), seat 2 (-6.17pp)
  morgana: {
    5:  0.068,  // L111 · n = 207 · Δ  +6.76pp
    4:  0.017,  // L172 · n = 209 · Δ  +1.72pp
    2: -0.062,  // L303 · n = 194 · Δ  -6.17pp
  },
  // Oberon — seat 5 (+4.99pp), seat 8 (+3.36pp), seat 3 (-7.75pp)
  oberon: {
    5:  0.050,  // L122 · n = 228 · Δ  +4.99pp
    10: 0.048,  // L126 · n = 199 · Δ  +4.80pp
    8:  0.034,  // L147 · n = 181 · Δ  +3.36pp
    3: -0.078,  // L313 · n = 241 · Δ  -7.75pp
  },
  // Assassin — seat 5 (+3.73pp), seat 10/6 (+4.52pp)
  assassin: {
    5:  0.037,  // L143 · n = 221 · Δ  +3.73pp
    10: 0.045,  // L135 · n = 193 · Δ  +4.52pp
    6:  0.045,  // L136 · n = 220 · Δ  +4.52pp
  },
  // Percival — seat 5 (+5.59pp), seat 10 (+4.84pp)
  percival: {
    5:  0.056,  // L118 · n = 186 · Δ  +5.59pp
    10: 0.048,  // L124 · n = 224 · Δ  +4.84pp
  },
};

/**
 * Look up the seat × role EV prior. Returns 0 if no entry.
 *
 * `seat` is the 1-indexed seat number derived from
 * `obs.allPlayerIds.indexOf(playerId) + 1` (matches Edward's seat
 * convention). `role` is the suspected role from caller's heuristics.
 */
export function seatPriorByRole(
  suspectedRole: string | undefined,
  seat: number,
): number {
  if (!isEvActionPriorsEnabled()) return 0;
  if (!suspectedRole) return 0;
  if (seat < 1 || seat > 10) return 0;
  const roleMap = SEAT_PRIOR_BY_ROLE[suspectedRole];
  if (!roleMap) return 0;
  return roleMap[seat as Seat] ?? 0;
}

// ── Hook 4 · R1 leader role × outcome prior ─────────────────────────
/**
 * EV delta for "player led R1 → R1 ended in <result>" by role.
 *
 * Used during selectTeam (R2+) to amplify the leader's faction stance:
 *   - Loyal who led R1-success → +16.21pp blue-favourable → blue should
 *     follow the loyal's lead more confidently in subsequent rounds.
 *   - Merlin who led R1-fail → -14.47pp → leader looks suspicious
 *     (Merlin shouldn't lead failed R1s cleanly).
 *   - Mordred/Morgana who led R1-fail → +5.04 / +2.76pp for their faction.
 *
 * The hook surfaces "this leader's R1 outcome was X — how much weight
 * should we put on their subsequent leadership?" Returns 0 if not R2+
 * or no R1 record yet.
 */
const R1_LEADER_PRIOR: Partial<Record<
  R1LeaderRole, Partial<Record<R1Outcome, number>>
>> = {
  loyal:    { success: +0.162, fail: -0.101 },  // L87, L326
  percival: { success: +0.135, fail: -0.017 },  // L93, L246
  merlin:   { success: +0.018, fail: -0.145 },  // L171, L333
  mordred:  { success: +0.030, fail: +0.028 },  // L150, L151
  morgana:  { success: +0.080, fail: +0.050 },  // L107, L121
  assassin: { success: +0.000, fail: +0.017 },  // L174 (success row absent)
  oberon:   { success: +0.002, fail: +0.060 },  // L203, L115
};

/**
 * Look up the R1 leader role × outcome prior.
 *
 * Returns 0 when:
 *   - feature flag off
 *   - role not in table
 *   - outcome not in table
 *
 * Caller should additionally gate on "is this player actually the R1
 * leader and did R1 actually finish" before applying.
 */
export function r1LeaderRolePrior(
  role: string | undefined,
  outcome: R1Outcome | undefined,
): number {
  if (!isEvActionPriorsEnabled()) return 0;
  if (!role || !outcome) return 0;
  const roleMap = R1_LEADER_PRIOR[role as R1LeaderRole];
  if (!roleMap) return 0;
  return roleMap[outcome] ?? 0;
}

// ── Hook 5 · Lake declare = lie prior ───────────────────────────────
/**
 * EV delta for "lake-token holder declares a LIE" (declared camp ≠
 * actual camp), broken out by holder role.
 *
 * Source: action_ev_consolidated_v6.md L85 (morgana 紅→藍 +16.48pp),
 * L103 (oberon 紅→藍 +9.00pp), L104 (oberon 藍→紅 +8.84pp), L131
 * (any_holder lie +4.62pp pooled).
 *
 * Caller wires this in `SelfPlayEngine.decideLakeAnnouncement` evil
 * branch — when the prior says "this role + this lie pattern is +EV",
 * bias the decision toward lying. Legacy heuristic stays primary; the
 * prior just resolves close calls in favour of historically-winning
 * actions.
 *
 * Returns a probability bump in `[0, 1]` ranges. Returns 0 for
 * roles/patterns not in the table.
 */
const LAKE_LIE_BONUS_BY_ROLE: Partial<Record<string, number>> = {
  morgana:  0.165,  // L85  · 紅→藍 lie · n = 43 · +16.48pp
  oberon:   0.090,  // L103 · 紅→藍 lie · n = 56 · +9.00pp
  assassin: 0.046,  // L133 · 藍→紅 lie · n = 116 · +4.57pp
  // Mordred lie has no significant +EV row (-1.83pp at L250 / +1.86 at L169)
  // — caller falls back to legacy heuristic.
};

/**
 * Look up the lake-declare-lie EV bonus for a holder role.
 *
 * Returns 0 (no nudge) when:
 *   - feature flag off
 *   - holder is good faction (good never lies — legacy already enforces)
 *   - role not in table
 *
 * Caller is expected to multiply this with their existing `should-lie?`
 * decision threshold rather than treating it as an absolute probability.
 */
export function lakeDeclareLiePrior(
  role: string | undefined,
  holderTeam: 'good' | 'evil' | undefined,
): number {
  if (!isEvActionPriorsEnabled()) return 0;
  if (holderTeam !== 'evil') return 0;  // good never lies
  if (!role) return 0;
  return LAKE_LIE_BONUS_BY_ROLE[role] ?? 0;
}

// ── Helper · Seat lookup from playerId ──────────────────────────────
/**
 * Edward seat convention: `allPlayerIds[i]` ↔ seat `i + 1`. Returns 0
 * (sentinel "unknown") if id not found.
 *
 * Exposed so callers in HeuristicAgent / SelfPlayEngine share one
 * implementation.
 */
export function seatOfPlayer(
  playerId: string,
  allPlayerIds: readonly string[],
): number {
  const idx = allPlayerIds.indexOf(playerId);
  return idx < 0 ? 0 : idx + 1;
}

// ── Test hooks ──────────────────────────────────────────────────────
/** Read-only access to internal tables for unit tests. */
export const _forTesting = {
  ASSASSIN_TARGET_PENALTY,
  INNER_BLACK_BONUS_BY_ROLE_ROUND,
  SEAT_PRIOR_BY_ROLE,
  R1_LEADER_PRIOR,
  LAKE_LIE_BONUS_BY_ROLE,
} as const;
