/**
 * EvActionPriors — Smoke test for 5 production AI hooks (2026-04-25 ship).
 *
 * Validates the contract surface of each hook, NOT the actual EV magnitudes
 * (those are pinned by `staging/selfplay/action_ev_consolidated_v6.md`).
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  assassinTargetPenalty,
  voteInnerBlackBonus,
  seatPriorByRole,
  r1LeaderRolePrior,
  lakeDeclareLiePrior,
  seatOfPlayer,
  isEvActionPriorsEnabled,
  // v8 hooks
  r3PlusForcedRejectPrior,
  lakeDeclareLieRoleRate,
  declarerPostActionConsistencyPrior,
  assassinTopTierSeatPrior,
  sameTeamProposalReversePrior,
  loyalVsPercivalReversePrior,
  pathAwareEvMultiplier,
  R3_PLUS_FORCED_REJECT_PATH,
  ASSASSIN_TOP_TIER_SEAT_PATH,
  SAME_TEAM_PROPOSAL_REVERSE_PATH,
  LOYAL_VS_PERCIVAL_REVERSE_PATH,
  DECLARER_POST_ACTION_CONSISTENCY_PATH,
  LAKE_DECLARE_LIE_ROLE_RATE_PATH,
} from './EvActionPriors';

const ORIGINAL_ENV = process.env.USE_EV_ACTION_PRIORS;

describe('EvActionPriors · feature flag', () => {
  afterEach(() => {
    process.env.USE_EV_ACTION_PRIORS = ORIGINAL_ENV;
  });

  it('defaults to enabled', () => {
    delete process.env.USE_EV_ACTION_PRIORS;
    expect(isEvActionPriorsEnabled()).toBe(true);
  });

  it('disabled when env=0', () => {
    process.env.USE_EV_ACTION_PRIORS = '0';
    expect(isEvActionPriorsEnabled()).toBe(false);
  });

  it('disabled when env=false', () => {
    process.env.USE_EV_ACTION_PRIORS = 'false';
    expect(isEvActionPriorsEnabled()).toBe(false);
  });

  it('hooks return 0 when flag off', () => {
    process.env.USE_EV_ACTION_PRIORS = '0';
    expect(assassinTargetPenalty('loyal')).toBe(0);
    expect(voteInnerBlackBonus('mordred', 5)).toBe(0);
    expect(seatPriorByRole('merlin', 10)).toBe(0);
    expect(r1LeaderRolePrior('loyal', 'success')).toBe(0);
    expect(lakeDeclareLiePrior('morgana', 'evil')).toBe(0);
  });
});

describe('Hook 1 · assassinTargetPenalty', () => {
  it('penalises loyal (Δ -69.57pp)', () => {
    expect(assassinTargetPenalty('loyal')).toBeLessThan(0);
  });
  it('penalises percival (Δ -69.57pp)', () => {
    expect(assassinTargetPenalty('percival')).toBeLessThan(0);
  });
  it('does not penalise merlin (the kill target)', () => {
    expect(assassinTargetPenalty('merlin')).toBe(0);
  });
  it('returns 0 for unknown role', () => {
    expect(assassinTargetPenalty('unknown_role')).toBe(0);
    expect(assassinTargetPenalty(undefined)).toBe(0);
  });
});

describe('Hook 2 · voteInnerBlackBonus (round-conditional)', () => {
  it('mordred R3-R5 returns positive bonus', () => {
    expect(voteInnerBlackBonus('mordred', 3)).toBeGreaterThan(0);
    expect(voteInnerBlackBonus('mordred', 4)).toBeGreaterThan(0);
    expect(voteInnerBlackBonus('mordred', 5)).toBeGreaterThan(0);
  });
  it('assassin R3/R4 returns positive bonus', () => {
    expect(voteInnerBlackBonus('assassin', 3)).toBeGreaterThan(0);
    expect(voteInnerBlackBonus('assassin', 4)).toBeGreaterThan(0);
  });
  it('loyal returns 0 (no +EV inner-black row)', () => {
    expect(voteInnerBlackBonus('loyal', 3)).toBe(0);
    expect(voteInnerBlackBonus('loyal', 4)).toBe(0);
  });
  it('returns 0 for out-of-range round', () => {
    expect(voteInnerBlackBonus('mordred', 0)).toBe(0);
    expect(voteInnerBlackBonus('mordred', 6)).toBe(0);
  });
  it('returns 0 for unknown role', () => {
    expect(voteInnerBlackBonus(undefined, 3)).toBe(0);
    expect(voteInnerBlackBonus('xxx', 3)).toBe(0);
  });
});

describe('Hook 3 · seatPriorByRole', () => {
  it('boosts merlin@seat10 (Δ +13.51pp)', () => {
    expect(seatPriorByRole('merlin', 10)).toBeGreaterThan(0.1);
  });
  it('penalises merlin@seat2 (Δ -8.15pp)', () => {
    expect(seatPriorByRole('merlin', 2)).toBeLessThan(0);
  });
  it('boosts mordred@seat5 (Δ +10.18pp)', () => {
    expect(seatPriorByRole('mordred', 5)).toBeGreaterThan(0.05);
  });
  it('returns 0 for out-of-range seat', () => {
    expect(seatPriorByRole('merlin', 0)).toBe(0);
    expect(seatPriorByRole('merlin', 11)).toBe(0);
  });
  it('returns 0 for unknown role', () => {
    expect(seatPriorByRole('xxx', 5)).toBe(0);
    expect(seatPriorByRole(undefined, 5)).toBe(0);
  });
});

describe('Hook 4 · r1LeaderRolePrior', () => {
  it('loyal R1-success is highly +EV (Δ +16.21pp)', () => {
    expect(r1LeaderRolePrior('loyal', 'success')).toBeGreaterThan(0.15);
  });
  it('loyal R1-fail is -EV', () => {
    expect(r1LeaderRolePrior('loyal', 'fail')).toBeLessThan(0);
  });
  it('merlin R1-fail is -EV (Δ -14.47pp)', () => {
    expect(r1LeaderRolePrior('merlin', 'fail')).toBeLessThan(-0.1);
  });
  it('mordred R1 either way is +EV (red faction)', () => {
    expect(r1LeaderRolePrior('mordred', 'success')).toBeGreaterThanOrEqual(0);
    expect(r1LeaderRolePrior('mordred', 'fail')).toBeGreaterThanOrEqual(0);
  });
  it('returns 0 for unknown role/outcome', () => {
    expect(r1LeaderRolePrior('xxx', 'success')).toBe(0);
    expect(r1LeaderRolePrior('loyal', undefined)).toBe(0);
  });
});

describe('Hook 5 · lakeDeclareLiePrior', () => {
  it('morgana evil holder gets positive lie bonus (Δ +16.48pp)', () => {
    expect(lakeDeclareLiePrior('morgana', 'evil')).toBeGreaterThan(0.1);
  });
  it('oberon evil holder gets positive lie bonus (Δ +9.00pp)', () => {
    expect(lakeDeclareLiePrior('oberon', 'evil')).toBeGreaterThan(0.05);
  });
  it('good holder never lies (returns 0)', () => {
    expect(lakeDeclareLiePrior('merlin', 'good')).toBe(0);
    expect(lakeDeclareLiePrior('loyal', 'good')).toBe(0);
  });
  it('returns 0 for unknown role', () => {
    expect(lakeDeclareLiePrior('xxx', 'evil')).toBe(0);
    expect(lakeDeclareLiePrior(undefined, 'evil')).toBe(0);
  });
});

describe('Helper · seatOfPlayer', () => {
  const allPlayerIds = ['p1', 'p2', 'p3', 'p4', 'p5'];
  it('maps allPlayerIds[0] to seat 1', () => {
    expect(seatOfPlayer('p1', allPlayerIds)).toBe(1);
  });
  it('maps allPlayerIds[4] to seat 5', () => {
    expect(seatOfPlayer('p5', allPlayerIds)).toBe(5);
  });
  it('returns 0 for missing id', () => {
    expect(seatOfPlayer('not_in_list', allPlayerIds)).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════
// v8 hooks (H6-H11) — 2026-04-27 path-aware ship
// ════════════════════════════════════════════════════════════════════

describe('Hook 6 · r3PlusForcedRejectPrior', () => {
  it('R3 evil failCount=2 returns positive bump (Δ +4.50pp three_red)', () => {
    expect(r3PlusForcedRejectPrior('evil', 3, 2)).toBeGreaterThan(0.04);
  });
  it('R4 evil failCount=3 returns strongest bump (Δ +5.28pp)', () => {
    expect(r3PlusForcedRejectPrior('evil', 4, 3)).toBeGreaterThan(0.05);
  });
  it('returns 0 for good team', () => {
    expect(r3PlusForcedRejectPrior('good', 3, 2)).toBe(0);
  });
  it('returns 0 outside R3-R4', () => {
    expect(r3PlusForcedRejectPrior('evil', 2, 2)).toBe(0);
    expect(r3PlusForcedRejectPrior('evil', 5, 2)).toBe(0);
  });
  it('returns 0 outside failCount {2, 3}', () => {
    expect(r3PlusForcedRejectPrior('evil', 3, 0)).toBe(0);
    expect(r3PlusForcedRejectPrior('evil', 3, 1)).toBe(0);
    expect(r3PlusForcedRejectPrior('evil', 3, 4)).toBe(0);
  });
  it('exposes path metadata = dominant / three_red', () => {
    expect(R3_PLUS_FORCED_REJECT_PATH.pathCategory).toBe('dominant');
    expect(R3_PLUS_FORCED_REJECT_PATH.primaryOutcome).toBe('three_red');
  });
});

describe('Hook 7 · lakeDeclareLieRoleRate', () => {
  it('assassin returns highest lie rate (~54%)', () => {
    expect(lakeDeclareLieRoleRate('assassin')).toBeGreaterThan(0.5);
  });
  it('morgana returns ~45% lie rate', () => {
    const r = lakeDeclareLieRoleRate('morgana');
    expect(r).toBeGreaterThan(0.4);
    expect(r).toBeLessThan(0.5);
  });
  it('mordred returns ~38% lie rate', () => {
    const r = lakeDeclareLieRoleRate('mordred');
    expect(r).toBeGreaterThan(0.3);
    expect(r).toBeLessThan(0.4);
  });
  it('good roles return near-zero rate (loyal 0.34%, percival 0.91%)', () => {
    expect(lakeDeclareLieRoleRate('loyal')).toBeLessThan(0.02);
    expect(lakeDeclareLieRoleRate('percival')).toBeLessThan(0.02);
    expect(lakeDeclareLieRoleRate('merlin')).toBeLessThan(0.02);
  });
  it('returns 0 for unknown role', () => {
    expect(lakeDeclareLieRoleRate('xxx')).toBe(0);
    expect(lakeDeclareLieRoleRate(undefined)).toBe(0);
  });
  it('exposes path metadata = mixed / three_red', () => {
    expect(LAKE_DECLARE_LIE_ROLE_RATE_PATH.pathCategory).toBe('mixed');
    expect(LAKE_DECLARE_LIE_ROLE_RATE_PATH.primaryOutcome).toBe('three_red');
  });
});

describe('Hook 8 · declarerPostActionConsistencyPrior', () => {
  it('紅|宣藍|target=evil returns +21.71pp (n=59)', () => {
    expect(
      declarerPostActionConsistencyPrior('evil', 'good', 'evil'),
    ).toBeGreaterThan(0.2);
  });
  it('returns 0 for good declarer', () => {
    expect(
      declarerPostActionConsistencyPrior('good', 'good', 'evil'),
    ).toBe(0);
  });
  it('returns 0 for declared evil (not the lie pattern)', () => {
    expect(
      declarerPostActionConsistencyPrior('evil', 'evil', 'evil'),
    ).toBe(0);
  });
  it('returns 0 for actually-good target (not a lie)', () => {
    expect(
      declarerPostActionConsistencyPrior('evil', 'good', 'good'),
    ).toBe(0);
  });
  it('returns 0 for missing arguments', () => {
    expect(
      declarerPostActionConsistencyPrior(undefined, 'good', 'evil'),
    ).toBe(0);
  });
  it('exposes path metadata = dominant / three_red', () => {
    expect(DECLARER_POST_ACTION_CONSISTENCY_PATH.pathCategory).toBe('dominant');
    expect(DECLARER_POST_ACTION_CONSISTENCY_PATH.primaryOutcome).toBe('three_red');
  });
});

describe('Hook 9 · assassinTopTierSeatPrior', () => {
  it('seats 3/4 (hot, ~50% hit) return positive boost', () => {
    expect(assassinTopTierSeatPrior(3)).toBeGreaterThan(0.02);
    expect(assassinTopTierSeatPrior(4)).toBeGreaterThan(0.02);
  });
  it('seats 7/9 (cold, ~36% hit) return negative penalty', () => {
    expect(assassinTopTierSeatPrior(7)).toBeLessThan(-0.04);
    expect(assassinTopTierSeatPrior(9)).toBeLessThan(-0.04);
  });
  it('returns 0 for invalid seat', () => {
    expect(assassinTopTierSeatPrior(0)).toBe(0);
    expect(assassinTopTierSeatPrior(11)).toBe(0);
    expect(assassinTopTierSeatPrior(-1)).toBe(0);
  });
  it('exposes path metadata = 備援 / three_blue_dead', () => {
    expect(ASSASSIN_TOP_TIER_SEAT_PATH.pathCategory).toBe('備援');
    expect(ASSASSIN_TOP_TIER_SEAT_PATH.primaryOutcome).toBe('three_blue_dead');
  });
});

describe('Hook 10 · sameTeamProposalReversePrior', () => {
  it('returns 0 for repeatCount < 2', () => {
    expect(sameTeamProposalReversePrior(0)).toBe(0);
    expect(sameTeamProposalReversePrior(1)).toBe(0);
  });
  it('returns negative delta for repeatCount >= 2 (trustworthy nudge)', () => {
    expect(sameTeamProposalReversePrior(2)).toBeLessThan(0);
    expect(sameTeamProposalReversePrior(3)).toBeLessThan(0);
  });
  it('saturates at repeatCount=3', () => {
    const at3 = sameTeamProposalReversePrior(3);
    const at5 = sameTeamProposalReversePrior(5);
    expect(at3).toBe(at5);
  });
  it('exposes path metadata = mixed / three_blue_alive', () => {
    expect(SAME_TEAM_PROPOSAL_REVERSE_PATH.pathCategory).toBe('mixed');
    expect(SAME_TEAM_PROPOSAL_REVERSE_PATH.primaryOutcome).toBe('three_blue_alive');
  });
});

describe('Hook 11 · loyalVsPercivalReversePrior', () => {
  it('returns 0 trust at 0 vote rounds', () => {
    expect(loyalVsPercivalReversePrior(0)).toBe(0);
  });
  it('ramps linearly up to 1.0 by 3 rounds', () => {
    expect(loyalVsPercivalReversePrior(1)).toBeCloseTo(1 / 3, 5);
    expect(loyalVsPercivalReversePrior(2)).toBeCloseTo(2 / 3, 5);
    expect(loyalVsPercivalReversePrior(3)).toBe(1);
  });
  it('saturates at 1.0 from round 3 onwards', () => {
    expect(loyalVsPercivalReversePrior(4)).toBe(1);
    expect(loyalVsPercivalReversePrior(10)).toBe(1);
  });
  it('exposes path metadata = dominant / three_blue_alive', () => {
    expect(LOYAL_VS_PERCIVAL_REVERSE_PATH.pathCategory).toBe('dominant');
    expect(LOYAL_VS_PERCIVAL_REVERSE_PATH.primaryOutcome).toBe('three_blue_alive');
  });
});

describe('pathAwareEvMultiplier (Edward v8 spec)', () => {
  it('red dominant returns 1.0', () => {
    expect(
      pathAwareEvMultiplier('evil', R3_PLUS_FORCED_REJECT_PATH, 'any', 0),
    ).toBe(1);
  });
  it('red 備援 returns 0.5', () => {
    expect(
      pathAwareEvMultiplier('evil', ASSASSIN_TOP_TIER_SEAT_PATH, 'any', 0),
    ).toBe(0.5);
  });
  it('blue Phase A (mission_pending) three_blue_* returns 1.0', () => {
    expect(
      pathAwareEvMultiplier(
        'good',
        { pathCategory: 'dominant', primaryOutcome: 'three_blue_alive' },
        'mission_pending',
        0,
      ),
    ).toBe(1);
    expect(
      pathAwareEvMultiplier(
        'good',
        { pathCategory: 'mixed', primaryOutcome: 'three_blue_dead' },
        'mission_pending',
        0,
      ),
    ).toBe(1);
  });
  it('blue Phase A non-blue outcome returns 0.5', () => {
    expect(
      pathAwareEvMultiplier(
        'good',
        { pathCategory: 'dominant', primaryOutcome: 'three_red' },
        'mission_pending',
        1,
      ),
    ).toBe(0.5);
  });
  it('blue Phase B (questsCompleted >= 3) three_blue_alive returns 1.0', () => {
    expect(
      pathAwareEvMultiplier(
        'good',
        { pathCategory: 'dominant', primaryOutcome: 'three_blue_alive' },
        'mission_done',
        3,
      ),
    ).toBe(1);
  });
  it('blue Phase B non-blue-alive returns 0.7', () => {
    expect(
      pathAwareEvMultiplier(
        'good',
        { pathCategory: '備援', primaryOutcome: 'three_blue_dead' },
        'mission_done',
        3,
      ),
    ).toBe(0.7);
  });
});
