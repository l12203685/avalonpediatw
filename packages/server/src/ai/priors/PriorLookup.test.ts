import { describe, it, expect, afterEach } from 'vitest';
import {
  PriorLookup,
  difficultyToTier,
  type Top10BehaviorJson,
  type Top10Tier,
} from './PriorLookup';

// ── Fixtures ──────────────────────────────────────────────────────

function synthTop10(
  tier: Top10Tier,
  overrides: Partial<Top10BehaviorJson> = {},
): Top10BehaviorJson {
  return {
    version: 3,
    rule_version: 'edward_2026-04-22',
    tier,
    generated_at: '2026-04-22T14:48:02+08:00',
    pool_avg_win_rate: tier === 'expert' ? 0.528 : tier === 'mid' ? 0.473 : 0.439,
    top10_player_nicknames: ['X', 'Y', 'Z'],
    games_processed: 1685,
    attempts_scanned: 25526,
    votes_counted: 64510,
    situations: {},
    rollups: {
      // L3 (most stable) — canonical Edward rule means:
      //   in_team ~= approve; off_team ~= reject
      'L3.r1.in_team': {
        sample_size: 6578,
        approve_count: 6490,
        reject_count: 88,
        approve_rate: 0.9866,
        reject_rate: 0.0134,
        confidence: 'high',
      },
      'L3.r1.off_team': {
        sample_size: 14917,
        approve_count: 548,
        reject_count: 14369,
        approve_rate: 0.0367,
        reject_rate: 0.9633,
        confidence: 'high',
      },
      'L3.r2_plus.in_team': {
        sample_size: 18810,
        approve_count: 16362,
        reject_count: 2448,
        approve_rate: 0.8699,
        reject_rate: 0.1301,
        confidence: 'high',
      },
      'L3.r2_plus.off_team': {
        sample_size: 24205,
        approve_count: 3104,
        reject_count: 21101,
        approve_rate: 0.1282,
        reject_rate: 0.8718,
        confidence: 'high',
      },
      // L2 (team-neutral) — used when L1 has insufficient samples
      'L2.r1.off_leader.off_team': {
        sample_size: 8500,
        approve_count: 300,
        reject_count: 8200,
        approve_rate: 0.0353,
        reject_rate: 0.9647,
        confidence: 'high',
      },
      // L1 (role-aware) — used when sample_size >= 30
      'L1.good.r1.off_leader.off_team': {
        sample_size: 3445,
        approve_count: 37,
        reject_count: 3408,
        approve_rate: 0.0107,
        reject_rate: 0.9893,
        confidence: 'high',
      },
      'L1.evil.r1.off_leader.off_team': {
        sample_size: 2454,
        approve_count: 38,
        reject_count: 2416,
        approve_rate: 0.0155,
        reject_rate: 0.9845,
        confidence: 'high',
      },
    },
    data_quality: {
      vote_rule_version: 'edward_2026-04-22',
    },
    fallback_chain: [],
    ...overrides,
  };
}

// ── difficultyToTier ──────────────────────────────────────────────

describe('difficultyToTier', () => {
  it('hard -> expert', () => {
    expect(difficultyToTier('hard')).toBe('expert');
  });
  it('normal -> mid', () => {
    expect(difficultyToTier('normal')).toBe('mid');
  });
  it('easy -> novice', () => {
    expect(difficultyToTier('easy')).toBe('novice');
  });
});

// ── PriorLookup · flag / availability ─────────────────────────────

describe('PriorLookup · flag state', () => {
  it('flag on + all tiers loaded -> availableTiers returns all three', () => {
    const lookup = PriorLookup.fromData(
      {
        expert: synthTop10('expert'),
        mid: synthTop10('mid'),
        novice: synthTop10('novice'),
      },
      true,
    );
    expect(lookup.isEnabled()).toBe(true);
    expect(lookup.availableTiers()).toEqual(['expert', 'mid', 'novice']);
  });

  it('flag off -> availableTiers empty even if data loaded', () => {
    const lookup = PriorLookup.fromData({ expert: synthTop10('expert') }, false);
    expect(lookup.isEnabled()).toBe(false);
    expect(lookup.availableTiers()).toEqual([]);
  });

  it('missing tier -> availableTiers skips it', () => {
    const lookup = PriorLookup.fromData({ expert: synthTop10('expert') }, true);
    expect(lookup.availableTiers()).toEqual(['expert']);
  });

  it('tier with wrong vote_rule_version -> treated as unsafe', () => {
    const stale = synthTop10('expert', { rule_version: 'v2_rejected' });
    const lookup = PriorLookup.fromData({ expert: stale }, true);
    expect(lookup.availableTiers()).toEqual([]);
  });
});

// ── getOffTeamRejectRate · historical path ────────────────────────

describe('PriorLookup · getOffTeamRejectRate (historical)', () => {
  const lookup = PriorLookup.fromData(
    {
      expert: synthTop10('expert'),
      mid: synthTop10('mid'),
      novice: synthTop10('novice'),
    },
    true,
  );

  it('hard + r1 good -> resolves via L1 (role-aware) when sample >= 30', () => {
    // L1.good.r1.off_leader.off_team has sample 3445 >= 30 -> used
    const rate = lookup.getOffTeamRejectRate('hard', {
      team: 'good',
      round: 1,
      isLeader: false,
    });
    expect(rate).toBeCloseTo(0.9893, 3);
  });

  it('hard + r1 evil -> resolves via L1 evil bucket', () => {
    const rate = lookup.getOffTeamRejectRate('hard', {
      team: 'evil',
      round: 1,
      isLeader: false,
    });
    expect(rate).toBeCloseTo(0.9845, 3);
  });

  it('hard + r2_plus good -> widens to L3 when L1/L2 absent', () => {
    // No L1/L2 for r2_plus in fixture -> L3.r2_plus.off_team
    const rate = lookup.getOffTeamRejectRate('hard', {
      team: 'good',
      round: 2,
      isLeader: false,
    });
    expect(rate).toBeCloseTo(0.8718, 3);
  });

  it('normal difficulty uses mid tier', () => {
    const rate = lookup.getOffTeamRejectRate('normal', {
      team: 'good',
      round: 1,
      isLeader: false,
    });
    // Same fixture -> expect same L1 result
    expect(rate).toBeCloseTo(0.9893, 3);
  });

  it('easy difficulty uses novice tier', () => {
    const rate = lookup.getOffTeamRejectRate('easy', {
      team: 'good',
      round: 1,
      isLeader: false,
    });
    expect(rate).toBeCloseTo(0.9893, 3);
  });
});

// ── getInTeamApproveRate · historical path ────────────────────────

describe('PriorLookup · getInTeamApproveRate (historical)', () => {
  const lookup = PriorLookup.fromData(
    {
      expert: synthTop10('expert'),
      mid: synthTop10('mid'),
      novice: synthTop10('novice'),
    },
    true,
  );

  it('hard + r1 good in_team -> L3 approve ~0.9866', () => {
    const rate = lookup.getInTeamApproveRate('hard', {
      team: 'good',
      round: 1,
      isLeader: false,
    });
    expect(rate).toBeCloseTo(0.9866, 3);
  });

  it('hard + r2_plus -> L3.r2_plus.in_team ~0.8699', () => {
    const rate = lookup.getInTeamApproveRate('hard', {
      team: 'good',
      round: 2,
      isLeader: false,
    });
    expect(rate).toBeCloseTo(0.8699, 3);
  });
});

// ── Tier-3 fallback path ──────────────────────────────────────────

describe('PriorLookup · Tier-3 fallback', () => {
  it('no data + flag on -> off_team_reject_baseline falls to hardcode', () => {
    const lookup = PriorLookup.fromData({}, true);
    expect(lookup.getOffTeamRejectRate('hard', { team: 'good', round: 1, isLeader: false }))
      .toBe(0.7);
    expect(lookup.getOffTeamRejectRate('normal', { team: 'good', round: 1, isLeader: false }))
      .toBe(0.55);
    expect(lookup.getOffTeamRejectRate('easy', { team: 'good', round: 1, isLeader: false }))
      .toBe(0.4);
  });

  it('flag off + data present -> still Tier-3 (feature flag beats JSON)', () => {
    const lookup = PriorLookup.fromData({ expert: synthTop10('expert') }, false);
    expect(lookup.getOffTeamRejectRate('hard', { team: 'good', round: 1, isLeader: false }))
      .toBe(0.7);
  });

  it('suspicion_reject_threshold -> hardcode (not in JSON yet)', () => {
    const lookup = PriorLookup.fromData({ expert: synthTop10('expert') }, true);
    expect(lookup.getSuspicionRejectThreshold('hard')).toBe(2.0);
    expect(lookup.getSuspicionRejectThreshold('normal')).toBe(3.0);
    expect(lookup.getSuspicionRejectThreshold('easy')).toBe(4.0);
  });

  it('strict_threshold -> hardcode', () => {
    const lookup = PriorLookup.fromData({ expert: synthTop10('expert') }, true);
    expect(lookup.getStrictThreshold('hard')).toBe(1.5);
    expect(lookup.getStrictThreshold('normal')).toBe(2.5);
    expect(lookup.getStrictThreshold('easy')).toBe(3.5);
  });

  it('noise_rate -> hardcode', () => {
    const lookup = PriorLookup.fromData({ expert: synthTop10('expert') }, true);
    expect(lookup.getNoiseRate('hard')).toBe(0.05);
    expect(lookup.getNoiseRate('normal')).toBe(0.15);
    expect(lookup.getNoiseRate('easy')).toBe(0.25);
  });

  it('in_team_approve_rate falls to hardcode when data missing', () => {
    const lookup = PriorLookup.fromData({}, true);
    expect(lookup.getInTeamApproveRate('hard', { team: 'good', round: 1, isLeader: false }))
      .toBe(0.9);
    expect(lookup.getInTeamApproveRate('normal', { team: 'good', round: 1, isLeader: false }))
      .toBe(0.85);
    expect(lookup.getInTeamApproveRate('easy', { team: 'good', round: 1, isLeader: false }))
      .toBe(0.8);
  });
});

// ── Cross-tier promotion ──────────────────────────────────────────

describe('PriorLookup · cross-tier promotion', () => {
  it('requested hard tier missing -> promotes to mid/novice', () => {
    // Only mid loaded; ask for hard
    const lookup = PriorLookup.fromData({ mid: synthTop10('mid') }, true);
    const rate = lookup.getOffTeamRejectRate('hard', {
      team: 'good',
      round: 1,
      isLeader: false,
    });
    // mid's L1.good.r1.off_leader.off_team = 0.9893 -> used via promotion
    expect(rate).toBeCloseTo(0.9893, 3);
  });

  it('all tiers missing -> falls to hardcode', () => {
    const lookup = PriorLookup.fromData({}, true);
    const rate = lookup.getOffTeamRejectRate('hard', {
      team: 'good',
      round: 1,
      isLeader: false,
    });
    expect(rate).toBe(0.7);
  });
});

// ── Env flag wiring ──────────────────────────────────────────────

describe('PriorLookup · USE_HISTORICAL_PRIOR env flag', () => {
  const origEnv = process.env.USE_HISTORICAL_PRIOR;
  afterEach(() => {
    if (origEnv === undefined) delete process.env.USE_HISTORICAL_PRIOR;
    else process.env.USE_HISTORICAL_PRIOR = origEnv;
  });

  it('env unset -> defaults to enabled', () => {
    delete process.env.USE_HISTORICAL_PRIOR;
    const lookup = PriorLookup.fromData({ expert: synthTop10('expert') });
    expect(lookup.isEnabled()).toBe(true);
  });

  it('env=false -> disabled', () => {
    process.env.USE_HISTORICAL_PRIOR = 'false';
    const lookup = PriorLookup.fromData({ expert: synthTop10('expert') });
    expect(lookup.isEnabled()).toBe(false);
  });

  it('env=0 -> disabled', () => {
    process.env.USE_HISTORICAL_PRIOR = '0';
    const lookup = PriorLookup.fromData({ expert: synthTop10('expert') });
    expect(lookup.isEnabled()).toBe(false);
  });

  it('env=true -> enabled', () => {
    process.env.USE_HISTORICAL_PRIOR = 'true';
    const lookup = PriorLookup.fromData({ expert: synthTop10('expert') });
    expect(lookup.isEnabled()).toBe(true);
  });
});

// ── Real JSON load sanity ────────────────────────────────────────

describe('PriorLookup · real JSON load', () => {
  it('loads all three tier files from default dir', () => {
    const lookup = PriorLookup.load();
    expect(lookup.availableTiers().length).toBeGreaterThan(0);
    // Expert + r1 + off_team -> canonical ~0.96+ (Edward rule verified).
    const rate = lookup.getOffTeamRejectRate('hard', {
      team: 'good',
      round: 1,
      isLeader: false,
    });
    // Expect near-1 (post-Edward rule); hard-code is 0.7 so anything >0.9
    // means historical path was used.
    expect(rate).toBeGreaterThan(0.9);
  });

  it('loading non-existent dir -> falls back to hardcode', () => {
    const lookup = PriorLookup.load('/nonexistent/path');
    expect(lookup.availableTiers()).toEqual([]);
    expect(lookup.getOffTeamRejectRate('hard', { team: 'good', round: 1, isLeader: false }))
      .toBe(0.7);
  });
});
