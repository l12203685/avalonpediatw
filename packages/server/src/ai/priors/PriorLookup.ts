/**
 * PriorLookup — Data-driven prior for Avalon AI agents.
 *
 * Loads three-tier behavioural priors (expert / mid / novice) produced by
 * `scripts/compute_top10_behavior_threetier_v3_edwardrule.py` from 1685+
 * historical games using Edward's canonical vote rule (2026-04-22 14:18).
 *
 * Runtime fallback chain (three-tier):
 *
 *   Tier 1 — rollup lookup (L1 → L2 → L3 → L4)
 *            L1: role.stage.leader.team (4-d, role-aware)
 *            L2: stage.leader.team      (3-d, team-neutral)
 *            L3: stage.team             (2-d, most stable)
 *            L4: team_size              (1-d, last historical resort)
 *   Tier 2 — cross-tier promotion (expert <-> mid <-> novice when target
 *            tier JSON missing)
 *   Tier 3 — hard-coded default (preserves pre-#97 behaviour exactly)
 *
 * Feature flag `USE_HISTORICAL_PRIOR` (env) — when `false`, every `get()`
 * returns the Tier-3 hard-coded fallback (preserves pre-#97 behaviour for
 * emergency rollback). Defaults to `true`.
 *
 * Difficulty <-> tier mapping (HeuristicAgent difficulty):
 *   hard   <-> expert  (prior pool = top 10 win-rate players)
 *   normal <-> mid     (rank 40-60 pool)
 *   easy   <-> novice  (rank 65-90 pool — low win rate but non-bottom)
 *
 * Example:
 *   const lookup = PriorLookup.load();
 *   lookup.getOffTeamRejectRate('hard', { round: 1, team: 'good' });
 *     // -> 0.9633 (expert L3.r1.off_team.reject_rate)
 *   lookup.getInTeamApproveRate('hard', { round: 1, team: 'good' });
 *     // -> 0.9866 (expert L3.r1.in_team.approve_rate)
 */
import fs from 'fs';
import path from 'path';

// ── Schema (mirrors top10_behavior_priors_<tier>.json v3 + v4) ────
export interface Top10BehaviorJson {
  version: number;
  rule_version?: string;
  /** v4: additive anomaly breakdown version tag (round-cross-product). */
  anomaly_breakdown_version?: string;
  tier: Top10Tier;
  generated_at: string;
  pool_avg_win_rate: number;
  top10_player_nicknames: string[];
  games_processed: number;
  attempts_scanned?: number;
  votes_counted?: number;
  confidence_summary?: {
    total_keys: number;
    high_conf_keys: number;
    medium_conf_keys: number;
    low_conf_keys: number;
  };
  situations: Record<string, SituationBucket>;
  rollups: Record<string, SituationBucket>;
  data_quality?: {
    vote_rule_version?: string;
    vote_rule_description?: string;
    leader_rotation?: string;
    prior_rule_version_rejected?: string;
  };
  fallback_chain?: string[];
  schema_note?: string;
  /** v4: anomaly-vote breakdown by round + pooled reference + round weights. */
  anomaly_stats?: AnomalyStatsV4;
}

/**
 * v4 anomaly-vote breakdown (additive, does not touch v3 fields).
 * See `scripts/compute_top10_behavior_threetier_v4_anomaly_rounds.py` for
 * the aggregator and `analysis/output/top10_priors_schema.md` for the spec.
 *
 * - `outer_white_rate` — probability a player NOT on the proposed team
 *   still voted approve (often a red covering). Denominator is off-team
 *   seat-opportunities in that round.
 * - `inner_black_rate` — probability a player ON the proposed team voted
 *   reject (refuse to carry the team even though they were picked).
 *   Denominator is in-team seat-opportunities in that round.
 * - `round_weight_suggestion` — Edward's "late rounds count more" curve
 *   `{1:0.5, 2:0.7, 3:1.0, 4:1.3, 5:1.8}`. Wire runtime may pull from
 *   JSON or fall back to Tier-3 constant.
 */
export interface AnomalyStatsV4 {
  anomaly_approve_count?: number;
  anomaly_reject_count?: number;
  anomaly_approve_ratio_of_all_votes?: number;
  anomaly_reject_ratio_of_all_votes?: number;
  attempts_with_any_anomaly?: number;
  attempts_with_anomaly_ratio?: number;
  total_anomaly_tokens?: number;
  total_attempts?: number;
  note?: string;
  by_round?: Record<string, AnomalyByRoundBucket>;
  round_weight_suggestion?: Record<string, number>;
  pooled_rates_for_reference?: {
    outer_white_rate?: number;
    outer_white_count?: number;
    inner_black_rate?: number;
    inner_black_count?: number;
  };
}

export interface AnomalyByRoundBucket {
  outer_white_rate: number;
  inner_black_rate: number;
  outer_white_count?: number;
  inner_black_count?: number;
  off_team_seat_opportunities?: number;
  in_team_seat_opportunities?: number;
  attempts_in_round?: number;
  games_with_round?: number;
}

/** Anomaly kind — outer-white (approved off-team) or inner-black (rejected in-team). */
export type AnomalyKind = 'outer_white' | 'inner_black';

/** Round index 1-5 used by round-cross-product breakdown. */
export type RoundIndex = 1 | 2 | 3 | 4 | 5;

export interface SituationBucket {
  sample_size: number;
  approve_count: number;
  reject_count: number;
  approve_rate: number;
  reject_rate: number;
  confidence?: 'high' | 'medium' | 'low';
}

export type Top10Tier = 'expert' | 'mid' | 'novice';

export type Difficulty = 'easy' | 'normal' | 'hard';

/** Difficulty to Tier mapping (Edward 2026-04-22 12:41). */
export function difficultyToTier(difficulty: Difficulty): Top10Tier {
  if (difficulty === 'hard') return 'expert';
  if (difficulty === 'easy') return 'novice';
  return 'mid';
}

/** Canonical vote rule version — only JSON with this version is wired. */
const CANONICAL_VOTE_RULE = 'edward_2026-04-22';

// ── Lookup context ────────────────────────────────────────────────
export interface BehaviorCtx {
  /** Caller's faction. */
  team?: 'good' | 'evil' | 'unknown';
  /** Round number (1-based). */
  round?: number;
  /** Whether caller is leader. */
  isLeader?: boolean;
  /** Whether caller is on the proposed team. */
  inTeam?: boolean;
  /** Number of previously-failed quests this team carries. */
  failCount?: number;
  /** Team size. */
  teamSize?: number;
}

// ── Hard-coded Tier-3 fallbacks (pre-#97 constants) ───────────────
const HARDCODE = {
  // voteOnTeam off-team baseline reject (legacy pre-#97)
  off_team_reject_baseline: {
    hard: 0.7,
    normal: 0.55,
    easy: 0.4,
  },
  // voteOnTeam on-team suspicion threshold
  suspicion_reject_threshold: {
    hard: 2.0,
    normal: 3.0,
    easy: 4.0,
  },
  // voteOnTeam off-team strict threshold
  strict_threshold: {
    hard: 1.5,
    normal: 2.5,
    easy: 3.5,
  },
  // applyNoise rate
  noise_rate: {
    hard: 0.05,
    normal: 0.15,
    easy: 0.25,
  },
  // in-team approve rate fallback (new — not in pre-#97 code but used
  // by Tier-3 when historical data missing)
  in_team_approve_rate: {
    hard: 0.9,
    normal: 0.85,
    easy: 0.8,
  },
  // v4 anomaly-vote fallback rates (used when JSON lacks anomaly_stats).
  // Values are a conservative midpoint across expert/mid/novice tiers
  // from the 2026-04-22 breakdown. Callers should still weight by
  // round_weight so R1/R2 stays low-impact.
  anomaly_rate: {
    outer_white: {
      1: 0.025, 2: 0.035, 3: 0.133, 4: 0.245, 5: 0.277,
    },
    inner_black: {
      1: 0.009, 2: 0.034, 3: 0.141, 4: 0.201, 5: 0.335,
    },
  },
  // Edward's "late rounds count more" Bayesian weight curve (2026-04-22).
  // Linear ramp chosen over exponential (`0.4/0.6/1.0/1.5/2.5`) so the
  // end-to-end suspicion delta stays bounded. Override by providing the
  // JSON field `anomaly_stats.round_weight_suggestion`.
  round_weight: {
    1: 0.5, 2: 0.7, 3: 1.0, 4: 1.3, 5: 1.8,
  },
} as const;

// ── Flag reader ────────────────────────────────────────────────────
/**
 * Reads `USE_HISTORICAL_PRIOR` env var. Defaults to `true`.
 * Exported so tests can stub `process.env` then re-instantiate cleanly.
 */
export function isHistoricalPriorEnabled(): boolean {
  const v = process.env.USE_HISTORICAL_PRIOR;
  if (v === undefined) return true;
  return v.toLowerCase() !== 'false' && v !== '0';
}

// ── Default JSON directory ─────────────────────────────────────────
const DEFAULT_PRIORS_DIR = path.resolve(__dirname);

// ── PriorLookup class ──────────────────────────────────────────────
export class PriorLookup {
  private readonly flagEnabled: boolean;
  /** Per-tier priors data (null = missing / unsafe). */
  private readonly tierData: Record<Top10Tier, Top10BehaviorJson | null>;

  /**
   * @param tierData Optional pre-loaded tier data (use for tests / DI).
   * @param flagOverride Optional override for `USE_HISTORICAL_PRIOR`.
   */
  constructor(
    tierData: Partial<Record<Top10Tier, Top10BehaviorJson | null>> = {},
    flagOverride?: boolean,
  ) {
    this.flagEnabled = flagOverride ?? isHistoricalPriorEnabled();
    this.tierData = {
      expert: tierData.expert ?? null,
      mid: tierData.mid ?? null,
      novice: tierData.novice ?? null,
    };
  }

  /** Factory: load three tier JSON files from a directory. */
  static load(priorsDir: string = DEFAULT_PRIORS_DIR): PriorLookup {
    const tierData: Partial<Record<Top10Tier, Top10BehaviorJson | null>> = {};
    for (const tier of ['expert', 'mid', 'novice'] as Top10Tier[]) {
      const p = path.resolve(priorsDir, `top10_behavior_priors_${tier}.json`);
      try {
        const raw = fs.readFileSync(p, 'utf8');
        tierData[tier] = JSON.parse(raw) as Top10BehaviorJson;
      } catch {
        tierData[tier] = null;
      }
    }
    return new PriorLookup(tierData);
  }

  /** Factory: build from in-memory data (tests / DI). */
  static fromData(
    tierData: Partial<Record<Top10Tier, Top10BehaviorJson | null>>,
    flagOverride?: boolean,
  ): PriorLookup {
    return new PriorLookup(tierData, flagOverride);
  }

  /** Inspector — flag state. */
  isEnabled(): boolean {
    return this.flagEnabled;
  }

  /** Inspector — which tiers have safe data. */
  availableTiers(): Top10Tier[] {
    if (!this.flagEnabled) return [];
    const out: Top10Tier[] = [];
    for (const t of ['expert', 'mid', 'novice'] as Top10Tier[]) {
      if (this.isTierSafe(t)) out.push(t);
    }
    return out;
  }

  /**
   * Off-team reject rate (historical). Used by HeuristicAgent `voteOnTeam`
   * off-team branch to replace the legacy `OFF_TEAM_REJECT_BASELINE`
   * constant. Falls back to Tier-3 hardcode when data missing.
   */
  getOffTeamRejectRate(difficulty: Difficulty, ctx: BehaviorCtx): number {
    const historical = this.lookupReject(difficulty, {
      ...ctx,
      inTeam: false,
    });
    if (historical !== null) return historical;
    return HARDCODE.off_team_reject_baseline[difficulty];
  }

  /**
   * In-team approve rate (historical). Optional override for on-team
   * approval baseline — currently informational; HeuristicAgent keeps
   * its avg-suspicion threshold logic but can query this to calibrate.
   */
  getInTeamApproveRate(difficulty: Difficulty, ctx: BehaviorCtx): number {
    const historical = this.lookupApprove(difficulty, {
      ...ctx,
      inTeam: true,
    });
    if (historical !== null) return historical;
    return HARDCODE.in_team_approve_rate[difficulty];
  }

  /**
   * v4 anomaly-vote base rate for a given `kind` + `round` + `difficulty`.
   *
   * Three-tier fallback:
   *   1. Target tier `anomaly_stats.by_round[round].<kind>_rate` (JSON, v4).
   *   2. Cross-tier promotion — if target tier missing, try the other two
   *      (preserves prediction when any tier has data).
   *   3. Tier-3 hardcode (`HARDCODE.anomaly_rate[kind][round]`).
   *
   * Flag off → always returns Tier-3 hardcode.
   *
   * Used by:
   *   - `HeuristicAgent.ingestVoteHistory` to weight suspicion deltas by
   *     how rare the observed anomaly is.
   *   - `HeuristicAgent.scoreWizardAsMerlin` (Percival thumb) for the same
   *     weighting on wizard candidates.
   */
  getAnomalyRate(
    kind: AnomalyKind,
    round: RoundIndex,
    difficulty: Difficulty,
  ): number {
    if (!this.flagEnabled) return HARDCODE.anomaly_rate[kind][round];

    const targetTier = difficultyToTier(difficulty);
    const searchOrder: Top10Tier[] = [targetTier];
    for (const t of ['expert', 'mid', 'novice'] as Top10Tier[]) {
      if (t !== targetTier) searchOrder.push(t);
    }

    for (const tier of searchOrder) {
      if (!this.isTierSafe(tier)) continue;
      const data = this.tierData[tier];
      const bucket = data?.anomaly_stats?.by_round?.[String(round)];
      if (!bucket) continue;
      const rate = kind === 'outer_white' ? bucket.outer_white_rate : bucket.inner_black_rate;
      if (typeof rate === 'number' && Number.isFinite(rate)) return rate;
    }

    return HARDCODE.anomaly_rate[kind][round];
  }

  /**
   * v4 round weight — Edward's "late rounds count more" Bayesian curve.
   *
   * Fallback:
   *   1. Target tier `anomaly_stats.round_weight_suggestion[round]` (JSON).
   *   2. Cross-tier promotion.
   *   3. Tier-3 hardcode `HARDCODE.round_weight[round]` (linear ramp).
   *
   * Flag off → always returns Tier-3 hardcode.
   */
  getRoundWeight(round: RoundIndex, difficulty?: Difficulty): number {
    if (!this.flagEnabled) return HARDCODE.round_weight[round];

    const searchOrder: Top10Tier[] = difficulty
      ? [difficultyToTier(difficulty)]
      : ['expert'];
    for (const t of ['expert', 'mid', 'novice'] as Top10Tier[]) {
      if (!searchOrder.includes(t)) searchOrder.push(t);
    }

    for (const tier of searchOrder) {
      if (!this.isTierSafe(tier)) continue;
      const data = this.tierData[tier];
      const suggestion = data?.anomaly_stats?.round_weight_suggestion;
      if (!suggestion) continue;
      const w = suggestion[String(round)];
      if (typeof w === 'number' && Number.isFinite(w)) return w;
    }

    return HARDCODE.round_weight[round];
  }

  /**
   * Suspicion-reject threshold for on-team branch. Currently not in JSON
   * — returns Tier-3 hardcode. Promoted to JSON in Phase 2.
   */
  getSuspicionRejectThreshold(difficulty: Difficulty): number {
    if (!this.flagEnabled) return HARDCODE.suspicion_reject_threshold[difficulty];
    return HARDCODE.suspicion_reject_threshold[difficulty];
  }

  /**
   * Strict threshold for off-team branch (avg suspicion gate).
   * Currently not in JSON — returns Tier-3 hardcode.
   */
  getStrictThreshold(difficulty: Difficulty): number {
    if (!this.flagEnabled) return HARDCODE.strict_threshold[difficulty];
    return HARDCODE.strict_threshold[difficulty];
  }

  /**
   * Decision-flip noise rate (higher = more "human error").
   * Currently not in JSON — returns Tier-3 hardcode.
   */
  getNoiseRate(difficulty: Difficulty): number {
    if (!this.flagEnabled) return HARDCODE.noise_rate[difficulty];
    return HARDCODE.noise_rate[difficulty];
  }

  // ── Internal rollup resolver ────────────────────────────────────
  /** Lookup reject_rate via L1 -> L2 -> L3 chain (null if all miss). */
  private lookupReject(difficulty: Difficulty, ctx: BehaviorCtx): number | null {
    const bucket = this.resolveBucket(difficulty, ctx);
    return bucket ? bucket.reject_rate : null;
  }

  /** Lookup approve_rate via L1 -> L2 -> L3 chain (null if all miss). */
  private lookupApprove(difficulty: Difficulty, ctx: BehaviorCtx): number | null {
    const bucket = this.resolveBucket(difficulty, ctx);
    return bucket ? bucket.approve_rate : null;
  }

  /**
   * Resolve the rollup bucket for `ctx` via three-tier chain:
   *   L1 -> L2 -> L3 -> cross-tier promotion -> null
   */
  private resolveBucket(difficulty: Difficulty, ctx: BehaviorCtx): SituationBucket | null {
    if (!this.flagEnabled) return null;

    const targetTier = difficultyToTier(difficulty);
    const searchOrder: Top10Tier[] = [targetTier];
    // Cross-tier promotion — if target missing, widen to neighbours.
    for (const t of ['expert', 'mid', 'novice'] as Top10Tier[]) {
      if (t !== targetTier) searchOrder.push(t);
    }

    const stage = (ctx.round ?? 1) === 1 ? 'r1' : 'r2_plus';
    const team = ctx.team ?? 'good';
    const leaderSeg = ctx.isLeader ? 'leader' : 'off_leader';
    const teamSeg = ctx.inTeam ? 'in_team' : 'off_team';

    for (const tier of searchOrder) {
      const data = this.tierData[tier];
      if (!data || !this.isTierSafe(tier)) continue;
      const rollups = data.rollups;
      if (!rollups) continue;

      // L1: role.stage.leader.team (4-d)
      const l1Key = `L1.${team}.${stage}.${leaderSeg}.${teamSeg}`;
      if (rollups[l1Key] && rollups[l1Key].sample_size >= 30) {
        return rollups[l1Key];
      }

      // L2: stage.leader.team (3-d, team-neutral)
      const l2Key = `L2.${stage}.${leaderSeg}.${teamSeg}`;
      if (rollups[l2Key] && rollups[l2Key].sample_size >= 30) {
        return rollups[l2Key];
      }

      // L3: stage.team (2-d, most stable — always present when data loaded)
      const l3Key = `L3.${stage}.${teamSeg}`;
      if (rollups[l3Key] && rollups[l3Key].sample_size >= 30) {
        return rollups[l3Key];
      }
    }

    return null;
  }

  /**
   * A tier is safe iff the loaded JSON declares Edward's canonical
   * vote rule (`edward_2026-04-22`). Older rule versions fall through
   * to Tier-3 hardcode to prevent contamination from the rejected
   * `v2` interpretation.
   */
  private isTierSafe(tier: Top10Tier): boolean {
    const d = this.tierData[tier];
    if (!d) return false;
    const ruleV = d.rule_version ?? d.data_quality?.vote_rule_version;
    return ruleV === CANONICAL_VOTE_RULE;
  }
}
