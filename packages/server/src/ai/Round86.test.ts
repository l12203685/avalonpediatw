import { describe, expect, it } from 'vitest';
import type { PlayerObservation } from './types';
import { DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING, parseTuningFlag, resolveAgentTuning, type AgentTuning } from './AgentTuning';
import { r1RideCard86 } from './Round86';
import { HeuristicAgent } from './HeuristicAgent';
import { ForwardAgent } from './forward/ForwardAgent';
import { OPPONENT_TYPES, tuningForOpponent } from './humanProfile';

const ids = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
const votes = (yes: readonly string[]): Record<string, boolean> => Object.fromEntries(ids.map((id) => [id, yes.includes(id)]));

/** P2 assassin (knows P3 Morgana, P7 Mordred; P9 Oberon unseen). Quest vote on round `r`; team given. */
function quest(team: string[], r: 1 | 2, over: Partial<PlayerObservation> = {}): PlayerObservation {
  const r1 = ['P1', 'P2', 'P4'];
  const history = r === 1 ? [] : [{ round: 1, team: r1, result: 'success' as const, failCount: 0 }];
  return {
    myPlayerId: 'P2', myRole: 'assassin', myTeam: 'evil', playerCount: 10, allPlayerIds: ids, knownEvils: ['P3', 'P7'],
    currentRound: r, currentLeader: r === 1 ? 'P1' : 'P5', failCount: 0, questResults: r === 1 ? [] : ['success'], gamePhase: 'quest_vote',
    voteHistory: r === 1
      ? [{ round: 1, attempt: 1, leader: 'P1', team, approved: true, votes: votes(['P1', 'P2', 'P4', 'P5', 'P6', 'P8']) }]
      : [
        { round: 1, attempt: 1, leader: 'P1', team: r1, approved: true, votes: votes(['P1', 'P2', 'P4', 'P5', 'P6', 'P8']) },
        { round: 2, attempt: 1, leader: 'P5', team, approved: true, votes: votes(['P1', 'P2', 'P4', 'P5', 'P6', 'P8']) },
      ],
    questHistory: history, proposedTeam: team, myLakeResults: [], lakeHistory: [],
    ...over,
  } as PlayerObservation;
}

const tun = (over: Partial<AgentTuning>): AgentTuning => resolveAgentTuning({ ...over });

describe('round 86 r1Ride86 (red exploit arm)', () => {
  it('legacy, default and every human table off; the flag parses', () => {
    expect(LEGACY_AGENT_TUNING.r1Ride86).toBe(0);
    expect(DEFAULT_AGENT_TUNING.r1Ride86).toBe(0);
    for (const o of OPPONENT_TYPES) expect(tuningForOpponent(o, DEFAULT_AGENT_TUNING).r1Ride86).toBe(0);
    expect(parseTuningFlag('r1Ride86')).toEqual({ r1Ride86: 1 });
    expect(parseTuningFlag('r1Ride86=3')).toEqual({ r1Ride86: 3 });
    expect(() => parseTuningFlag('r1Ride86=4')).toThrow();
  });

  it('bit 1: the lone red on the R1 mission hides; not with a teammate, not on R2, not when off', () => {
    const lone = quest(['P1', 'P2', 'P4'], 1);
    expect(r1RideCard86(tun({ r1Ride86: 1 }), lone)).toBe('success');
    expect(r1RideCard86(tun({ r1Ride86: 0 }), lone)).toBeNull();
    expect(r1RideCard86(tun({ r1Ride86: 2 }), lone)).toBeNull();
    expect(r1RideCard86(tun({ r1Ride86: 1 }), quest(['P1', 'P2', 'P3'], 1))).toBeNull();
    // off the team / a blue seat: no opinion
    expect(r1RideCard86(tun({ r1Ride86: 1 }), quest(['P1', 'P4', 'P5'], 1))).toBeNull();
    expect(r1RideCard86(tun({ r1Ride86: 1 }), { ...lone, myTeam: 'good', myRole: 'loyal', knownEvils: [] } as PlayerObservation)).toBeNull();
    // Oberon sees nobody: alone from his view even with another red on the team
    expect(r1RideCard86(tun({ r1Ride86: 1 }), { ...quest(['P1', 'P9', 'P3'], 1), myPlayerId: 'P9', myRole: 'oberon', knownEvils: [] } as PlayerObservation)).toBe('success');
  });

  it('bit 2: R2 after an R1 success only', () => {
    const r2 = quest(['P1', 'P2', 'P4', 'P5'], 2);
    expect(r1RideCard86(tun({ r1Ride86: 2 }), r2)).toBe('success');
    expect(r1RideCard86(tun({ r1Ride86: 1 }), r2)).toBeNull();
    expect(r1RideCard86(tun({ r1Ride86: 3 }), r2)).toBe('success');
    const afterFail = quest(['P1', 'P2', 'P4', 'P5'], 2, { questResults: ['fail'], questHistory: [{ round: 1, team: ['P1', 'P6', 'P8'], result: 'fail', failCount: 1 }] });
    expect(r1RideCard86(tun({ r1Ride86: 3 }), afterFail)).toBeNull();
    expect(r1RideCard86(tun({ r1Ride86: 3 }), quest(['P1', 'P2', 'P3', 'P5'], 2))).toBeNull();
  });

  it('ForwardAgent: on → success on the lone R1 mission; off → the path as before', () => {
    const play = (tuning: AgentTuning, o: PlayerObservation): string | null => {
      const base = new HeuristicAgent('P2', undefined, undefined, tuning);
      base.onGameStart({ ...o, gamePhase: 'team_select', questResults: [], questHistory: [], voteHistory: [] } as PlayerObservation);
      const a = new ForwardAgent('P2', base).decide({ ...o, seatTeam: 'evil' } as PlayerObservation).action;
      return a.type === 'quest_vote' ? a.vote : null;
    };
    const lone = quest(['P1', 'P2', 'P4'], 1);
    expect(play(tun({ r1Ride86: 1 }), lone)).toBe('success');
    expect(['success', 'fail']).toContain(play(tun({}), lone));
  });
});
