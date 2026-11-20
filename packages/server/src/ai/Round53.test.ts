/**
 * 第 53 回合：精確挑隊（`exactPick53`，預設關）——含自己的隊裡 P(這隊沒有紅) 最高的一隊；派西的拇指恰好一紅一藍。
 */
import { describe, expect, it } from 'vitest';
import type { AgentTuning } from './AgentTuning';
import type { PlayerObservation, VoteRecord } from './types';
import { DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING, parseTuningFlag } from './AgentTuning';
import { cleanScores53, exactPick53Applies, exactPick53Team, teamClean53 } from './Round53';
import { viewpointLog53, type ViewpointTerm53 } from './Viewpoint53';
import { bayesOptionsOf, bayesRedShare } from './belief/BayesBelief';
import { Q1, Q2, q1Pass, q2Pass } from '../../scripts/acceptRound53';

const IDS = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
// Round 56b: the acceptance cases compare against the reading before V3P became the default (2026-11-20); `T()` is that reading.
const T = (over: Partial<AgentTuning> = {}): AgentTuning => ({ ...DEFAULT_AGENT_TUNING, viewpoint53: 0, viewpointPow53: 0, ...over });

function vote(round: number, attempt: number, leader: string, team: string[], approvers: string[], approved = false): VoteRecord {
  return { round, attempt, leader, team, approved, votes: Object.fromEntries(IDS.map((id) => [id, approvers.includes(id)])) };
}

/** 第 3 局第 1 次提議、隊長 P10。第 1 局 P1 P2 P3 一張失敗；第 2 局 P4 P5 P6 P7 成功。 */
function r3(over: Partial<PlayerObservation> = {}): PlayerObservation {
  return {
    myPlayerId: 'P10', myRole: 'loyal', myTeam: 'good', seatTeam: 'good', playerCount: 10, allPlayerIds: IDS, knownEvils: [],
    currentRound: 3, currentLeader: 'P10', gamePhase: 'team_select', failCount: 0, questResults: ['fail', 'success'],
    questHistory: [
      { round: 1, team: ['P1', 'P2', 'P3'], result: 'fail', failCount: 1 },
      { round: 2, team: ['P4', 'P5', 'P6', 'P7'], result: 'success', failCount: 0 },
    ],
    voteHistory: [
      vote(1, 1, 'P1', ['P1', 'P2', 'P3'], ['P1', 'P2', 'P3', 'P4', 'P5', 'P6'], true),
      vote(2, 1, 'P4', ['P4', 'P5', 'P6', 'P7'], ['P4', 'P5', 'P6', 'P7', 'P8', 'P9'], true),
    ],
    lakeHistory: [], myLakeResults: [], proposedTeam: [],
    ...over,
  } as unknown as PlayerObservation;
}

describe('exactPick53 flag', () => {
  it('exists, off by default, parses 0–2', () => {
    expect(LEGACY_AGENT_TUNING.exactPick53).toBe(0);
    expect(DEFAULT_AGENT_TUNING.exactPick53).toBe(0);
    expect(parseTuningFlag('exactPick53')).toEqual({ exactPick53: 1 });
    expect(parseTuningFlag('exactPick53=2')).toEqual({ exactPick53: 2 });
    expect(() => parseTuningFlag('exactPick53=3')).toThrow();
  });
});

describe('cleanScores53 (uniform L1* worlds)', () => {
  it('every team of the size holds the leader; probabilities follow the mission record', () => {
    const s = cleanScores53(r3(), 4, 'uniform', T())!;
    expect(s).toHaveLength(84); // C(9, 3)
    expect(s.every((x) => x.team[0] === 'P10')).toBe(true);
    const p = (team: string[]): number => s.find((x) => x.team.join() === team.join())!.p;
    // At least one red among P1 P2 P3: a team of three from P1–P3 is never clean.
    expect(p(['P10', 'P1', 'P2', 'P3'])).toBe(0);
    // The best team leaves the failed mission out entirely.
    const best = Math.max(...s.map((x) => x.p));
    const top = s.filter((x) => x.p === best);
    expect(top.every((x) => !x.team.some((id) => ['P1', 'P2', 'P3'].includes(id)))).toBe(true);
  });
  it('Percival: two thumbs hold exactly one red — a team with both thumbs is never clean, each thumb alone is clean half the time', () => {
    const obs = r3({ myRole: 'percival', knownWizards: ['P8', 'P9'] });
    expect(teamClean53(obs, ['P10', 'P8', 'P9', 'P4'], 'uniform', T())).toBe(0);
    expect(teamClean53(r3(), ['P10', 'P8', 'P9', 'P4'], 'uniform', T())).toBeGreaterThan(0);
    expect(teamClean53(obs, ['P10', 'P8'], 'uniform', T())).toBeCloseTo(0.5, 12);
  });
});

describe('exactPick53Team', () => {
  it('off (0) or not a good loyal / Percival team pick: unchanged', () => {
    const a = { type: 'team_select' as const, teamIds: ['P10', 'P1', 'P2', 'P3'] };
    expect(exactPick53Team(T(), r3(), a)).toBe(a);
    expect(exactPick53Applies(T({ exactPick53: 2 }), r3({ myRole: 'merlin' }), a)).toBe(false);
    expect(exactPick53Applies(T({ exactPick53: 2 }), r3({ myTeam: 'evil', myRole: 'assassin' }), a)).toBe(false);
    expect(exactPick53Applies(T({ exactPick53: 2 }), r3(), { type: 'team_vote', vote: true })).toBe(false);
  });
  it('uniform: a team with a sure red is replaced by a highest-P(clean) team; a top team is kept', () => {
    const t = T({ exactPick53: 2 });
    const a = { type: 'team_select' as const, teamIds: ['P10', 'P1', 'P2', 'P3'] };
    const b = exactPick53Team(t, r3(), a);
    expect(b.type).toBe('team_select');
    const team = b.type === 'team_select' ? b.teamIds : [];
    const best = Math.max(...cleanScores53(r3(), 4, 'uniform', t)!.map((x) => x.p));
    expect(teamClean53(r3(), team, 'uniform', t)).toBeCloseTo(best, 12);
    const keep = { type: 'team_select' as const, teamIds: team };
    expect(exactPick53Team(t, r3(), keep)).toBe(keep);
  });
  it('posterior: the replacement is a highest-posterior team', () => {
    const t = T({ exactPick53: 1 });
    const a = { type: 'team_select' as const, teamIds: ['P10', 'P1', 'P2', 'P3'] };
    const b = exactPick53Team(t, r3(), a);
    const team = b.type === 'team_select' ? b.teamIds : [];
    const best = Math.max(...cleanScores53(r3(), 4, 'posterior', t)!.map((x) => x.p));
    expect(teamClean53(r3(), team, 'posterior', t)!).toBeGreaterThanOrEqual(best - 1e-9);
  });
});

describe('viewpoint53 (leader-viewpoint reading)', () => {
  it('flag exists, off in the legacy table, V3P (=3, power 0.5) by default since round 56b, parses 0–15', () => {
    expect(LEGACY_AGENT_TUNING.viewpoint53).toBe(0);
    expect(DEFAULT_AGENT_TUNING.viewpoint53).toBe(3);
    expect(DEFAULT_AGENT_TUNING.viewpointPow53).toBe(0.5);
    expect(parseTuningFlag('viewpoint53')).toEqual({ viewpoint53: 1 });
    expect(parseTuningFlag('viewpoint53=3')).toEqual({ viewpoint53: 3 });
    expect(() => parseTuningFlag('viewpoint53=16')).toThrow();
  });
  it('a good leader\'s clean team raises the world; an unclean one lowers it; a red leader with no mate on the team lowers it slightly', () => {
    // leader bit 1; teams {1,2}, {1,4}; P_L flat.
    const t: ViewpointTerm53 = { lb: 1, masks: Int32Array.from([1 | 2, 1 | 4]), pl: Float64Array.from([0.5, 0.5]), actual: 1 | 2, forced: false };
    expect(viewpointLog53([t], 4, 1)).toBeGreaterThan(0); // reds {4}: the actual team is clean
    expect(viewpointLog53([t], 2, 1)).toBeLessThan(0); // reds {2}: unclean
    expect(viewpointLog53([t], 1 | 8, 1)).toBeLessThan(0); // leader red, no mate on the team
    expect(viewpointLog53([t], 4, 0)).toBe(0);
  });
  it('acceptance Q1: the default reads 1, 4, 9 as suspicious as 2, 3; viewpoint53=1 separates them', () => {
    expect(q1Pass(bayesRedShare(Q1(), bayesOptionsOf(T())))).toBe(false);
    expect(q1Pass(bayesRedShare(Q1(), bayesOptionsOf(T({ viewpoint53: 1 }))))).toBe(true);
  });
  it('acceptance Q2 (recorded, not yet met): neither the default nor viewpoint53=1 reads thumb 1 as Merlin', () => {
    expect(q2Pass(bayesRedShare(Q2(), bayesOptionsOf(T())))).toBe(false);
    expect(q2Pass(bayesRedShare(Q2(), bayesOptionsOf(T({ viewpoint53: 1 }))))).toBe(false);
  });
});
