/**
 * Unit tests for DefaultActionPolicy (棋瓦 P3, 2026-04-27).
 *
 * Coverage focus:
 *   - Registry: set / get / clear / clearGamePolicies semantics.
 *   - Resolver: every policy field × every phase × loyal/evil side.
 *   - Scope expiration: until_quest_result / until_round_end /
 *     until_game_end / one_shot / absolute expiresAt.
 *   - **SAFETY** (highest priority): evil quest votes ALWAYS decline,
 *     regardless of policy.questVote ('fail' / 'success' / 'role_aware').
 *   - Helper functions: teamForRole, gameStateToDefaultPhase,
 *     buildAutoFillEvent.
 *
 * If you add a new field to DefaultActionPolicy or a new phase, the
 * exhaustive `default: never` switches in DefaultActionPolicy.ts will
 * tell you which test branches to add here.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { Role } from '@avalon/shared';
import {
  T_DEFAULT_GRACE_MS,
  setPolicy,
  getPolicy,
  clearPolicy,
  clearGamePolicies,
  __resetRegistryForTests,
  resolveDefaultAction,
  teamForRole,
  gameStateToDefaultPhase,
  buildAutoFillEvent,
  type PolicyContext,
} from './DefaultActionPolicy';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    gameId: 'g1',
    currentRound: 1,
    questResultKnown: false,
    gameEnded: false,
    now: 1_700_000_000_000,
    ...overrides,
  };
}

const LOYAL_ROLES: Role[] = ['merlin', 'percival', 'loyal'];
const EVIL_ROLES_LIST: Role[] = [
  'assassin',
  'morgana',
  'mordred',
  'oberon',
  'minion',
];

beforeEach(() => {
  __resetRegistryForTests();
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('T_DEFAULT_GRACE_MS', () => {
  it('is 6 hours in ms', () => {
    expect(T_DEFAULT_GRACE_MS).toBe(6 * 60 * 60 * 1000);
  });
});

// ---------------------------------------------------------------------------
// teamForRole
// ---------------------------------------------------------------------------

describe('teamForRole', () => {
  it('classifies all loyal roles as good', () => {
    for (const r of LOYAL_ROLES) {
      expect(teamForRole(r)).toBe('good');
    }
  });
  it('classifies all evil roles as evil', () => {
    for (const r of EVIL_ROLES_LIST) {
      expect(teamForRole(r)).toBe('evil');
    }
  });
});

// ---------------------------------------------------------------------------
// gameStateToDefaultPhase
// ---------------------------------------------------------------------------

describe('gameStateToDefaultPhase', () => {
  it('returns team_vote for voting + team picked', () => {
    expect(gameStateToDefaultPhase('voting', true)).toBe('team_vote');
  });
  it('returns null for voting + team NOT picked (TEAM_SELECT phase)', () => {
    expect(gameStateToDefaultPhase('voting', false)).toBe(null);
  });
  it('returns quest_vote for quest', () => {
    expect(gameStateToDefaultPhase('quest', false)).toBe('quest_vote');
    expect(gameStateToDefaultPhase('quest', true)).toBe('quest_vote');
  });
  it('returns null for non-defaultable phases', () => {
    expect(gameStateToDefaultPhase('lobby', false)).toBe(null);
    expect(gameStateToDefaultPhase('lady_of_the_lake', false)).toBe(null);
    expect(gameStateToDefaultPhase('discussion', false)).toBe(null);
    expect(gameStateToDefaultPhase('ended', false)).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// Registry: set / get / clear / clearGamePolicies
// ---------------------------------------------------------------------------

describe('registry', () => {
  it('set then get returns the stored policy', () => {
    const stored = setPolicy('g1', {
      playerId: 'p1',
      voteOnTeam: 'normal',
      questVote: 'role_aware',
      scope: 'until_quest_result',
    });
    const fetched = getPolicy('g1', 'p1');
    expect(fetched).toEqual(stored);
    expect(fetched?.setAt).toBeGreaterThan(0);
  });

  it('set defaults setAt to Date.now() when not provided', () => {
    const before = Date.now();
    const stored = setPolicy('g1', {
      playerId: 'p1',
      scope: 'one_shot',
    });
    const after = Date.now();
    expect(stored.setAt).toBeGreaterThanOrEqual(before);
    expect(stored.setAt).toBeLessThanOrEqual(after);
  });

  it('set respects explicit setAt', () => {
    const stored = setPolicy('g1', {
      playerId: 'p1',
      scope: 'one_shot',
      setAt: 12345,
    });
    expect(stored.setAt).toBe(12345);
  });

  it('get returns undefined for missing player', () => {
    expect(getPolicy('g1', 'nobody')).toBeUndefined();
  });

  it('set replaces existing policy', () => {
    setPolicy('g1', { playerId: 'p1', voteOnTeam: 'approve', scope: 'one_shot' });
    setPolicy('g1', { playerId: 'p1', voteOnTeam: 'reject', scope: 'until_game_end' });
    const fetched = getPolicy('g1', 'p1');
    expect(fetched?.voteOnTeam).toBe('reject');
    expect(fetched?.scope).toBe('until_game_end');
  });

  it('clearPolicy removes policy and returns true', () => {
    setPolicy('g1', { playerId: 'p1', scope: 'one_shot' });
    expect(clearPolicy('g1', 'p1')).toBe(true);
    expect(getPolicy('g1', 'p1')).toBeUndefined();
  });

  it('clearPolicy returns false when no policy exists', () => {
    expect(clearPolicy('g1', 'ghost')).toBe(false);
  });

  it('different gameId scopes do not collide', () => {
    setPolicy('g1', { playerId: 'p1', voteOnTeam: 'approve', scope: 'one_shot' });
    setPolicy('g2', { playerId: 'p1', voteOnTeam: 'reject', scope: 'one_shot' });
    expect(getPolicy('g1', 'p1')?.voteOnTeam).toBe('approve');
    expect(getPolicy('g2', 'p1')?.voteOnTeam).toBe('reject');
  });

  it('clearGamePolicies wipes only the target game', () => {
    setPolicy('g1', { playerId: 'p1', scope: 'one_shot' });
    setPolicy('g1', { playerId: 'p2', scope: 'one_shot' });
    setPolicy('g2', { playerId: 'p1', scope: 'one_shot' });
    clearGamePolicies('g1');
    expect(getPolicy('g1', 'p1')).toBeUndefined();
    expect(getPolicy('g1', 'p2')).toBeUndefined();
    expect(getPolicy('g2', 'p1')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Resolver: no policy
// ---------------------------------------------------------------------------

describe('resolveDefaultAction — no policy', () => {
  it('declines with no_policy when policy is undefined', () => {
    const result = resolveDefaultAction(undefined, 'loyal', 'team_vote', makeCtx());
    expect('decline' in result).toBe(true);
    if ('decline' in result) {
      expect(result.decline.reason).toBe('no_policy');
    }
  });
});

// ---------------------------------------------------------------------------
// Resolver: team_vote phase
// ---------------------------------------------------------------------------

describe('resolveDefaultAction — team_vote', () => {
  it('voteOnTeam=approve always returns approve', () => {
    const policy = setPolicy('g1', {
      playerId: 'p1',
      voteOnTeam: 'approve',
      scope: 'until_game_end',
    });
    const result = resolveDefaultAction(policy, 'loyal', 'team_vote', makeCtx(), false);
    expect('action' in result).toBe(true);
    if ('action' in result) {
      expect(result.action).toEqual({ kind: 'team_vote', vote: true });
    }
  });

  it('voteOnTeam=reject always returns reject', () => {
    const policy = setPolicy('g1', {
      playerId: 'p1',
      voteOnTeam: 'reject',
      scope: 'until_game_end',
    });
    const result = resolveDefaultAction(policy, 'loyal', 'team_vote', makeCtx(), true);
    expect('action' in result).toBe(true);
    if ('action' in result) {
      expect(result.action).toEqual({ kind: 'team_vote', vote: false });
    }
  });

  it('voteOnTeam=normal + on team → approve (mirrors AFK rule)', () => {
    const policy = setPolicy('g1', {
      playerId: 'p1',
      voteOnTeam: 'normal',
      scope: 'until_game_end',
    });
    const result = resolveDefaultAction(policy, 'loyal', 'team_vote', makeCtx(), true);
    expect('action' in result).toBe(true);
    if ('action' in result) {
      expect(result.action).toEqual({ kind: 'team_vote', vote: true });
    }
  });

  it('voteOnTeam=normal + off team → reject (mirrors AFK rule)', () => {
    const policy = setPolicy('g1', {
      playerId: 'p1',
      voteOnTeam: 'normal',
      scope: 'until_game_end',
    });
    const result = resolveDefaultAction(policy, 'loyal', 'team_vote', makeCtx(), false);
    expect('action' in result).toBe(true);
    if ('action' in result) {
      expect(result.action).toEqual({ kind: 'team_vote', vote: false });
    }
  });

  it('declines when voteOnTeam is undefined', () => {
    const policy = setPolicy('g1', {
      playerId: 'p1',
      questVote: 'success',
      scope: 'until_game_end',
    });
    const result = resolveDefaultAction(policy, 'loyal', 'team_vote', makeCtx(), false);
    expect('decline' in result).toBe(true);
    if ('decline' in result) {
      expect(result.decline.reason).toBe('no_field_for_phase');
    }
  });

  it('team_vote works the same for evil and loyal (no role gating)', () => {
    const policy = setPolicy('g1', {
      playerId: 'p1',
      voteOnTeam: 'approve',
      scope: 'until_game_end',
    });
    for (const role of [...LOYAL_ROLES, ...EVIL_ROLES_LIST]) {
      const result = resolveDefaultAction(policy, role, 'team_vote', makeCtx(), false);
      expect('action' in result).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Resolver: quest_vote — SAFETY
// ---------------------------------------------------------------------------

describe('resolveDefaultAction — quest_vote SAFETY (evil never auto-defaults)', () => {
  for (const role of EVIL_ROLES_LIST) {
    it(`evil role ${role} declines with evil_quest_safety regardless of questVote='success'`, () => {
      const policy = setPolicy('g1', {
        playerId: 'p1',
        questVote: 'success',
        scope: 'until_game_end',
      });
      const result = resolveDefaultAction(policy, role, 'quest_vote', makeCtx());
      expect('decline' in result).toBe(true);
      if ('decline' in result) {
        expect(result.decline.reason).toBe('evil_quest_safety');
      }
    });

    it(`evil role ${role} declines with evil_quest_safety regardless of questVote='fail'`, () => {
      const policy = setPolicy('g1', {
        playerId: 'p1',
        questVote: 'fail',
        scope: 'until_game_end',
      });
      const result = resolveDefaultAction(policy, role, 'quest_vote', makeCtx());
      expect('decline' in result).toBe(true);
      if ('decline' in result) {
        expect(result.decline.reason).toBe('evil_quest_safety');
      }
    });

    it(`evil role ${role} declines with evil_quest_safety regardless of questVote='role_aware'`, () => {
      const policy = setPolicy('g1', {
        playerId: 'p1',
        questVote: 'role_aware',
        scope: 'until_game_end',
      });
      const result = resolveDefaultAction(policy, role, 'quest_vote', makeCtx());
      expect('decline' in result).toBe(true);
      if ('decline' in result) {
        expect(result.decline.reason).toBe('evil_quest_safety');
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Resolver: quest_vote — loyal branches
// ---------------------------------------------------------------------------

describe('resolveDefaultAction — quest_vote loyal', () => {
  for (const role of LOYAL_ROLES) {
    it(`loyal role ${role} + questVote=success → success`, () => {
      const policy = setPolicy('g1', {
        playerId: 'p1',
        questVote: 'success',
        scope: 'until_game_end',
      });
      const result = resolveDefaultAction(policy, role, 'quest_vote', makeCtx());
      expect('action' in result).toBe(true);
      if ('action' in result) {
        expect(result.action).toEqual({ kind: 'quest_vote', vote: 'success' });
      }
    });

    it(`loyal role ${role} + questVote=role_aware → success`, () => {
      const policy = setPolicy('g1', {
        playerId: 'p1',
        questVote: 'role_aware',
        scope: 'until_game_end',
      });
      const result = resolveDefaultAction(policy, role, 'quest_vote', makeCtx());
      expect('action' in result).toBe(true);
      if ('action' in result) {
        expect(result.action).toEqual({ kind: 'quest_vote', vote: 'success' });
      }
    });

    it(`loyal role ${role} + questVote=fail → declines (loyal cannot fail)`, () => {
      const policy = setPolicy('g1', {
        playerId: 'p1',
        questVote: 'fail',
        scope: 'until_game_end',
      });
      const result = resolveDefaultAction(policy, role, 'quest_vote', makeCtx());
      expect('decline' in result).toBe(true);
      if ('decline' in result) {
        expect(result.decline.reason).toBe('no_field_for_phase');
      }
    });
  }

  it('declines when questVote is undefined', () => {
    const policy = setPolicy('g1', {
      playerId: 'p1',
      voteOnTeam: 'normal',
      scope: 'until_game_end',
    });
    const result = resolveDefaultAction(policy, 'loyal', 'quest_vote', makeCtx());
    expect('decline' in result).toBe(true);
    if ('decline' in result) {
      expect(result.decline.reason).toBe('no_field_for_phase');
    }
  });
});

// ---------------------------------------------------------------------------
// Resolver: scope expiration
// ---------------------------------------------------------------------------

describe('resolveDefaultAction — scope expiration', () => {
  it('declines when game has ended', () => {
    const policy = setPolicy('g1', {
      playerId: 'p1',
      voteOnTeam: 'approve',
      scope: 'until_game_end',
    });
    const result = resolveDefaultAction(
      policy,
      'loyal',
      'team_vote',
      makeCtx({ gameEnded: true }),
    );
    expect('decline' in result).toBe(true);
    if ('decline' in result) {
      expect(result.decline.reason).toBe('expired');
    }
  });

  it('declines when expiresAt has elapsed', () => {
    const policy = setPolicy('g1', {
      playerId: 'p1',
      voteOnTeam: 'approve',
      scope: 'until_game_end',
      expiresAt: 1_000,
    });
    const result = resolveDefaultAction(
      policy,
      'loyal',
      'team_vote',
      makeCtx({ now: 2_000 }),
    );
    expect('decline' in result).toBe(true);
    if ('decline' in result) {
      expect(result.decline.reason).toBe('expired');
    }
  });

  it('still active when expiresAt has NOT elapsed', () => {
    const policy = setPolicy('g1', {
      playerId: 'p1',
      voteOnTeam: 'approve',
      scope: 'until_game_end',
      expiresAt: 5_000,
    });
    const result = resolveDefaultAction(
      policy,
      'loyal',
      'team_vote',
      makeCtx({ now: 2_000 }),
    );
    expect('action' in result).toBe(true);
  });

  it('until_quest_result declines after questResultKnown', () => {
    const policy = setPolicy('g1', {
      playerId: 'p1',
      voteOnTeam: 'approve',
      scope: 'until_quest_result',
    });
    const result = resolveDefaultAction(
      policy,
      'loyal',
      'team_vote',
      makeCtx({ questResultKnown: true }),
    );
    expect('decline' in result).toBe(true);
    if ('decline' in result) {
      expect(result.decline.reason).toBe('expired');
    }
  });

  it('until_quest_result still active before questResultKnown', () => {
    const policy = setPolicy('g1', {
      playerId: 'p1',
      voteOnTeam: 'approve',
      scope: 'until_quest_result',
    });
    const result = resolveDefaultAction(
      policy,
      'loyal',
      'team_vote',
      makeCtx({ questResultKnown: false }),
    );
    expect('action' in result).toBe(true);
  });

  it('until_round_end behaves like until_quest_result at the resolver layer', () => {
    const policyActive = setPolicy('g1', {
      playerId: 'p1',
      voteOnTeam: 'approve',
      scope: 'until_round_end',
    });
    expect(
      'action' in
        resolveDefaultAction(policyActive, 'loyal', 'team_vote', makeCtx()),
    ).toBe(true);

    const policyExpired = setPolicy('g1', {
      playerId: 'p2',
      voteOnTeam: 'approve',
      scope: 'until_round_end',
    });
    expect(
      'decline' in
        resolveDefaultAction(
          policyExpired,
          'loyal',
          'team_vote',
          makeCtx({ questResultKnown: true }),
        ),
    ).toBe(true);
  });

  it('until_game_end stays active across rounds', () => {
    const policy = setPolicy('g1', {
      playerId: 'p1',
      voteOnTeam: 'approve',
      scope: 'until_game_end',
    });
    for (let round = 1; round <= 5; round++) {
      const result = resolveDefaultAction(
        policy,
        'loyal',
        'team_vote',
        makeCtx({ currentRound: round, questResultKnown: true }),
      );
      expect('action' in result).toBe(true);
    }
  });

  it('one_shot stays active at the resolver layer (engine consumes it)', () => {
    const policy = setPolicy('g1', {
      playerId: 'p1',
      voteOnTeam: 'approve',
      scope: 'one_shot',
    });
    // First call: still active.
    expect(
      'action' in resolveDefaultAction(policy, 'loyal', 'team_vote', makeCtx()),
    ).toBe(true);
    // Second call without engine clearing: still active.
    expect(
      'action' in resolveDefaultAction(policy, 'loyal', 'team_vote', makeCtx()),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildAutoFillEvent
// ---------------------------------------------------------------------------

describe('buildAutoFillEvent', () => {
  it('produces a payload with reason=async_default_policy', () => {
    const policy = setPolicy('g1', {
      playerId: 'p1',
      voteOnTeam: 'normal',
      scope: 'until_quest_result',
    });
    const event = buildAutoFillEvent(
      policy,
      'team_vote',
      { kind: 'team_vote', vote: true },
      9_999,
    );
    expect(event).toEqual({
      playerId: 'p1',
      phase: 'team_vote',
      action: { kind: 'team_vote', vote: true },
      policyScope: 'until_quest_result',
      reason: 'async_default_policy',
      appliedAt: 9_999,
    });
  });

  it('preserves quest_vote action shape', () => {
    const policy = setPolicy('g1', {
      playerId: 'p1',
      questVote: 'success',
      scope: 'until_game_end',
    });
    const event = buildAutoFillEvent(
      policy,
      'quest_vote',
      { kind: 'quest_vote', vote: 'success' },
      1_234,
    );
    expect(event.action).toEqual({ kind: 'quest_vote', vote: 'success' });
    expect(event.policyScope).toBe('until_game_end');
  });
});
