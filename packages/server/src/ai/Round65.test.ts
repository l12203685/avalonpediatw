import { describe, expect, it } from 'vitest';
import type { PlayerObservation } from './types';
import { DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING, parseTuningFlag, resolveAgentTuning } from './AgentTuning';
import { crowdApprovals65, redCrowdWhite65, redStackAllowed65 } from './Round65';
import { tuningForOpponent } from './humanProfile';

const ids = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);

/** Assassin P3 (sees P5, P8; Oberon P9 unseen) off the R3 team P1 P2 P4 P6, no history. */
function redObs(over: Partial<PlayerObservation> = {}): PlayerObservation {
  return {
    myPlayerId: 'P3', myRole: 'assassin', myTeam: 'evil', playerCount: 10, allPlayerIds: ids, knownEvils: ['P5', 'P8'],
    currentRound: 3, currentLeader: 'P1', failCount: 0, questResults: ['success', 'fail'], gamePhase: 'team_vote',
    voteHistory: [], questHistory: [], proposedTeam: ['P1', 'P2', 'P4', 'P6'], myLakeResults: [],
    ...over,
  } as PlayerObservation;
}

describe('round 65 switches', () => {
  it('crowd white off; stack rate 0.5 in the baseline only (site owner 2026-11-23); flags parse', () => {
    for (const t of [DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING]) expect(t.redCrowdWhite65).toBe(0);
    expect(DEFAULT_AGENT_TUNING.redStackRate65).toBe(0.5);
    expect(LEGACY_AGENT_TUNING.redStackRate65).toBe(0);
    expect(tuningForOpponent('ai').redStackRate65).toBe(0.5);
    for (const k of ['weakHuman', 'avgHuman', 'strongHuman'] as const) expect(tuningForOpponent(k).redStackRate65).toBe(0);
    expect(parseTuningFlag('redCrowdWhite65')).toEqual({ redCrowdWhite65: 0.5 });
    expect(parseTuningFlag('redCrowdWhite65=0.3')).toEqual({ redCrowdWhite65: 0.3 });
    expect(parseTuningFlag('redStackRate65=0.5')).toEqual({ redStackRate65: 0.5 });
    expect(() => parseTuningFlag('redStackRate65=2')).toThrow();
  });
});

describe('redCrowdWhite65', () => {
  it('counts the team as approving, off-team public seats by their clean estimate, never the off-team mates or itself', () => {
    const t = resolveAgentTuning({ redCrowdWhite65: 0.01 });
    // 4 on the team + P7, P9, P10 (public seats; P5, P8 are mates, P3 is me) at a near-zero bar.
    expect(crowdApprovals65(t, redObs(), 0.01)).toBe(7);
    // At bar 1 no public seat holds a 4-player team surely clean with no record: only the team.
    expect(crowdApprovals65(t, redObs(), 1)).toBe(4);
  });

  it('whites only when the team passes without its vote', () => {
    expect(redCrowdWhite65(resolveAgentTuning({ redCrowdWhite65: 0.01 }), redObs())).toBe(true);
    expect(redCrowdWhite65(resolveAgentTuning({ redCrowdWhite65: 0.99 }), redObs())).toBe(false);
  });

  it('off, on the team, R1–R2, the forced proposal and blue seats: never', () => {
    const on = resolveAgentTuning({ redCrowdWhite65: 0.01 });
    expect(redCrowdWhite65(DEFAULT_AGENT_TUNING, redObs())).toBe(false);
    expect(redCrowdWhite65(on, redObs({ proposedTeam: ['P1', 'P2', 'P3', 'P6'] }))).toBe(false);
    expect(redCrowdWhite65(on, redObs({ currentRound: 2, questResults: ['success'] }))).toBe(false);
    expect(redCrowdWhite65(on, redObs({ failCount: 4 }))).toBe(false);
    expect(redCrowdWhite65(on, redObs({ myTeam: 'good', myRole: 'loyal', knownEvils: [] }))).toBe(false);
    expect(redCrowdWhite65(on, redObs({ gamePhase: 'team_select' }))).toBe(false);
  });
});

describe('redStackAllowed65', () => {
  const lead = (over: Partial<PlayerObservation> = {}): PlayerObservation => redObs({ gamePhase: 'team_select', currentLeader: 'P3', ...over });

  it('off, Oberon, R4, R1–R2 and the forced proposal keep the stack', () => {
    const tiny = resolveAgentTuning({ redStackRate65: 1e-6 });
    expect(redStackAllowed65(DEFAULT_AGENT_TUNING, lead())).toBe(true);
    expect(redStackAllowed65(tiny, lead({ myRole: 'oberon', knownEvils: [] }))).toBe(true);
    expect(redStackAllowed65(tiny, lead({ currentRound: 4 }))).toBe(true);
    expect(redStackAllowed65(tiny, lead({ currentRound: 2 }))).toBe(true);
    expect(redStackAllowed65(tiny, lead({ failCount: 4 }))).toBe(true);
  });

  it('R3 / R5 non-forced: the stack only at rate p (hash of seat, round, proposal)', () => {
    expect(redStackAllowed65(resolveAgentTuning({ redStackRate65: 1e-6 }), lead())).toBe(false);
    expect(redStackAllowed65(resolveAgentTuning({ redStackRate65: 1 }), lead({ currentRound: 5 }))).toBe(true);
    const half = resolveAgentTuning({ redStackRate65: 0.5 });
    let kept = 0;
    for (const me of ids) for (const fc of [0, 1, 2, 3]) if (redStackAllowed65(half, lead({ myPlayerId: me, failCount: fc }))) kept++;
    expect(kept).toBeGreaterThan(8);
    expect(kept).toBeLessThan(32);
  });
});
