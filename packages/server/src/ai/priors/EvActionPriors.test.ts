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
