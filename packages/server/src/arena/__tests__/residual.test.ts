import { describe, expect, it } from 'vitest';
import type { PlayerObservation } from '../../ai/types';
import { SelfPlayEngine } from '../../ai/SelfPlayEngine';
import { DEFAULT_AGENT_TUNING } from '../../ai/AgentTuning';
import {
  ResidualPolicy, SEAT_FEATURES, TEAM_FEATURES, VOTE_FEATURES, combinations, rankTeamsFrom, seatFeatures, teamCandidatesFrom,
  validateResidual, voteFeatures, type ResidualWeights,
} from '../residual';
import { fitChoice, fitLogistic, prf, solve, toWeights, fromWeights } from '../residualFit';
import { abnormalKind, firstSwitch, trustEvidence, trustPath } from '../fidelityMetrics';
import { validateProfile, type BotProfile } from '../profile';
import { formatKnightProfile } from '../styleKnights';
import { playTable, quietly, type Entrant } from '../table';

const IDS = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);

function obs(over: Partial<PlayerObservation> = {}): PlayerObservation {
  return {
    myPlayerId: 'P1', myRole: 'loyal' as PlayerObservation['myRole'], myTeam: 'good', playerCount: 10, allPlayerIds: IDS,
    knownEvils: [], currentRound: 1, currentLeader: 'P1', failCount: 0, questResults: [], gamePhase: 'team_select',
    voteHistory: [], questHistory: [], proposedTeam: [], lakeHistory: [], myLakeResults: [],
    ...over,
  };
}

/** 只看 `eng`（引擎選的）的權重：殘差層會照引擎選。 */
const FOLLOW: ResidualWeights = {
  version: 1,
  team: { loyal: { eng: 3, exactEng: 5 }, red: { eng: 3, exactEng: 5 }, merlin: { eng: 3 }, percival: { eng: 3 } },
  vote: Object.fromEntries(['red', 'merlin', 'percival', 'loyal'].flatMap((g) => [[`${g}_on`, { eng: 4 }], [`${g}_off`, { eng: 4 }]])),
  quest: { eng: 4 },
  lakeTarget: { good: { eng: 4 }, evil: { eng: 4 } },
  lakeClaim: { eng: 4 },
  assassinate: { eng: 4 },
};

describe('residual features', () => {
  it('enumerates every legal team once and marks the engine team', () => {
    expect(combinations(10, 3)).toHaveLength(120);
    expect(combinations(10, 5)).toHaveLength(252);
    const o = obs();
    const S = seatFeatures(o, ['P1', 'P2', 'P3'], DEFAULT_AGENT_TUNING);
    expect(S).toHaveLength(10);
    expect(S[0]).toHaveLength(SEAT_FEATURES.length);
    expect(S[0][SEAT_FEATURES.indexOf('self')]).toBe(1);
    const c = teamCandidatesFrom(IDS, S, 3, ['P1', 'P2', 'P3'], [], []);
    expect(c.teams).toHaveLength(120);
    expect(c.X[0]).toHaveLength(TEAM_FEATURES.length);
    const exact = c.X.filter((x) => x[TEAM_FEATURES.indexOf('exactEng')] === 1);
    expect(exact).toHaveLength(1);
    // 加總：引擎的隊三個人都在引擎的隊上。
    expect(exact[0][TEAM_FEATURES.indexOf('eng')]).toBe(3);
  });

  it('ranks the top three teams with descending probabilities', () => {
    const o = obs();
    const S = seatFeatures(o, ['P1', 'P2', 'P3'], DEFAULT_AGENT_TUNING);
    const top = rankTeamsFrom(teamCandidatesFrom(IDS, S, 3, ['P1', 'P2', 'P3'], [], []), FOLLOW.team!.loyal, 3);
    expect(top).toHaveLength(3);
    expect([...top[0].team].sort()).toEqual(['P1', 'P2', 'P3']);
    expect(top[0].p).toBeGreaterThanOrEqual(top[1].p);
    expect(top[1].p).toBeGreaterThanOrEqual(top[2].p);
    expect(top.reduce((s, t) => s + t.p, 0)).toBeLessThanOrEqual(1 + 1e-9);
  });

  it('vote features carry the engine vote and the history', () => {
    const o = obs({
      gamePhase: 'team_vote', currentRound: 2, currentLeader: 'P3', proposedTeam: ['P2', 'P3', 'P4', 'P5'],
      questHistory: [{ round: 1, team: ['P2', 'P6', 'P7'], result: 'fail', failCount: 1 }], questResults: ['fail'],
    });
    const x = voteFeatures(o, false, DEFAULT_AGENT_TUNING);
    expect(x).toHaveLength(VOTE_FEATURES.length);
    expect(x[VOTE_FEATURES.indexOf('eng')]).toBe(-1);
    expect(x[VOTE_FEATURES.indexOf('teamFailOn')]).toBe(1);
    expect(x[VOTE_FEATURES.indexOf('redFails')]).toBe(1);
  });
});

describe('ResidualPolicy hard rules', () => {
  const pol = new ResidualPolicy({ version: 1, quest: { bias: -10 }, lakeClaim: { bias: 10 }, assassinate: { knownRed: 30 } }, DEFAULT_AGENT_TUNING);

  it('blue always plays success; red keeps the engine card at two red wins (A1)', () => {
    expect(pol.questCard(obs({ gamePhase: 'quest_vote' }), 'fail')).toBe('success');
    const red = obs({ myRole: 'assassin' as PlayerObservation['myRole'], myTeam: 'evil', knownEvils: ['P2'], gamePhase: 'quest_vote', proposedTeam: ['P1', 'P3', 'P4'] });
    expect(pol.questCard(red, 'fail')).toBe('success'); // 權重叫它藏
    expect(pol.questCard({ ...red, questResults: ['fail', 'success', 'fail'] }, 'fail')).toBe('fail');
  });

  it('a blue lake holder declares what the engine says (A0); red follows the weights', () => {
    expect(pol.lakeClaim(obs(), 'P4', 'good', 'good')).toBe('good');
    const red = obs({ myRole: 'morgana' as PlayerObservation['myRole'], myTeam: 'evil', knownEvils: ['P2'] });
    expect(pol.lakeClaim(red, 'P4', 'good', 'good')).toBe('evil');
  });

  it('the assassin never targets a known red even when the weights prefer it', () => {
    const o = obs({ myRole: 'assassin' as PlayerObservation['myRole'], myTeam: 'evil', knownEvils: ['P2', 'P3'], allEvilIds: ['P1', 'P2', 'P3', 'P4'], gamePhase: 'assassination' });
    const t = pol.assassinate(o, 'P5');
    expect(['P1', 'P2', 'P3', 'P4']).not.toContain(t);
  });

  it('without weights every decision is the engine’s', () => {
    const none = new ResidualPolicy({ version: 1 }, DEFAULT_AGENT_TUNING);
    expect(none.team(obs(), ['P1', 'P4', 'P5'])).toEqual(['P1', 'P4', 'P5']);
    expect(none.vote(obs({ gamePhase: 'team_vote', proposedTeam: ['P2', 'P3', 'P4'] }), true)).toBe(true);
    expect(none.lakeTarget(obs(), ['P3', 'P4'], 'P4')).toBe('P4');
  });

  it('picks only legal lake targets and a team of the right size', () => {
    const fol = new ResidualPolicy(FOLLOW, DEFAULT_AGENT_TUNING);
    expect(fol.lakeTarget(obs(), ['P3', 'P4'], 'P4')).toBe('P4');
    const lakeOnly = new ResidualPolicy({ version: 1, lakeTarget: { good: { dist: 50 } } }, DEFAULT_AGENT_TUNING);
    expect(['P3', 'P4']).toContain(lakeOnly.lakeTarget(obs(), ['P3', 'P4'], 'P4'));
    const team = fol.team(obs({ currentRound: 4 }), ['P1', 'P2', 'P3', 'P4', 'P5']);
    expect(team).toHaveLength(5);
  });
});

describe('residual fitting', () => {
  it('solves a linear system', () => {
    const x = solve([[2, 1], [1, 3]], [3, 5]);
    expect(x[0]).toBeCloseTo(0.8, 6);
    expect(x[1]).toBeCloseTo(1.4, 6);
  });

  it('logistic recovers the sign of a real effect and shrinks to the prior with a large λ', () => {
    const rows = Array.from({ length: 400 }, (_, i) => {
      const f = i % 2 === 0 ? 1 : -1;
      const y: 0 | 1 = (f > 0 ? i % 10 !== 0 : i % 10 === 1) ? 1 : 0;
      return { x: [1, f], y };
    });
    const b = fitLogistic(rows, [0, 0], 0.1);
    expect(b[1]).toBeGreaterThan(1);
    const shrunk = fitLogistic(rows, [0, -2], 1e6);
    expect(shrunk[1]).toBeCloseTo(-2, 2);
  });

  it('conditional logit learns which candidate feature people pick', () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({ X: [[1, 0], [0, 1], [0, 0]], y: i % 4 === 0 ? 1 : 0 }));
    const b = fitChoice(rows, [0, 0], 0.01);
    expect(b[0]).toBeGreaterThan(b[1]);
    expect(b[1]).toBeGreaterThan(0);
  });

  it('weights round-trip through the named map', () => {
    const w = toWeights(['a', 'b', 'c'], [1.23456, 0, -0.5]);
    expect(w).toEqual({ a: 1.235, c: -0.5 });
    expect(fromWeights(['a', 'b', 'c'], w)).toEqual([1.235, 0, -0.5]);
  });

  it('precision / recall / F1', () => {
    const p = prf([[true, true], [true, false], [false, true], [false, false]]);
    expect(p.precision).toBe(0.5);
    expect(p.recall).toBe(0.5);
    expect(p.f1).toBe(0.5);
  });
});

describe('fidelity metrics', () => {
  it('abnormal votes: leader counts as on the team', () => {
    expect(abnormalKind(true, false, false)).toBe('內黑');
    expect(abnormalKind(false, true, false)).toBe('內黑');
    expect(abnormalKind(false, false, true)).toBe('外白');
    expect(abnormalKind(false, false, false)).toBeNull();
  });

  it('Percival trust follows which thumb he keeps putting on teams', () => {
    expect(trustEvidence('T', [1, 4, 5], [4, 7])).toBe(1);
    expect(trustEvidence('T', [1, 7, 5], [4, 7])).toBe(-1);
    expect(trustEvidence('V', [1, 7, 5], [4, 7], false)).toBe(0.5);
    const path = trustPath([{ round: 1, e: 1 }, { round: 3, e: -1 }, { round: 3, e: -1 }]);
    expect(path).toEqual([1, 1, -1, -1, -1]);
    expect(firstSwitch(path)).toBe(3);
    expect(firstSwitch([0, 1, 1, 0, 1])).toBe(0);
  });
});

describe('profile schema 2 (residual weights)', () => {
  const house: BotProfile = { schema: 2, name: 'AI騎士_測試_01', author: 'AI騎士團', official: true, style: '測試', residual: FOLLOW };

  it('accepts residual weights only on official knights', () => {
    expect(validateProfile(house, 'knight-test-01', { house: true }).ok).toBe(true);
    const community = { ...house, name: 'Test', author: 'octocat', official: undefined };
    const v = validateProfile(community, 'test-bot');
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/residual|schema 2/);
  });

  it('rejects unknown features and out-of-range weights', () => {
    const errors: string[] = [];
    expect(validateResidual({ version: 1, quest: { nope: 1 } }, errors)).toBeUndefined();
    expect(validateResidual({ version: 1, quest: { eng: 999 } }, [])).toBeUndefined();
    expect(validateResidual({ version: 2 }, [])).toBeUndefined();
    expect(validateResidual({ version: 1, team: { loyal: { eng: 1 } } }, [])).toEqual({ version: 1, team: { loyal: { eng: 1 } } });
  });

  it('the compact profile format parses back to a valid profile', () => {
    const text = formatKnightProfile(house);
    const back = JSON.parse(text) as BotProfile;
    expect(back.residual).toEqual(FOLLOW);
    expect(validateProfile(back, 'knight-test-01', { house: true }).ok).toBe(true);
  });

  it('a knight with residual weights plays a legal, reproducible table', async () => {
    const engine = new SelfPlayEngine();
    const knight: Entrant = { id: 'knight', profile: house };
    const baike: Entrant = { id: 'baike', profile: null };
    const seats = [knight, baike, knight, baike, knight, baike, knight, baike, knight, baike];
    const a = await quietly(() => playTable(engine, seats, 'residual-test|0'));
    const b = await quietly(() => playTable(engine, seats, 'residual-test|0'));
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.seats).toHaveLength(10);
  }, 60_000);
});
