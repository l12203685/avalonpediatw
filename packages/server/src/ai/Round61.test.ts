/**
 * 第 61 回合（紅方）：刺客在「第 1 局成功、第 2 局失敗」的三藍局降低投票／隊長／照派三項讀法的倍數（`assassinPath61`），
 * 第 2 局（1:0）落單的紅照真人比例出牌（`redR2Lead61`）。兩個開關預設關。
 */
import { describe, expect, it } from 'vitest';
import type { AgentTuning } from './AgentTuning';
import type { PlayerObservation } from './types';
import { DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING, parseTuningFlag } from './AgentTuning';
import { PATH61_MULTS, R2_LEAD_HIDE_RATE, assassinPathFeatures61, missionOrder61, path61Mults, redR2LeadCard61 } from './RedRound61';
import { redHideHumanCard } from './RedRound27';
import { HeuristicAgent } from './HeuristicAgent';
import { withSeededRandom } from './benchmark/agreement';
import { buildReplayObservation, seatId } from './benchmark/replayObservation';
import type { ReplayGame, ReplayProposal } from './benchmark/sheetsReplay';
import type { Role } from '@avalon/shared';

const T = (over: Partial<AgentTuning> = {}): AgentTuning => ({ ...DEFAULT_AGENT_TUNING, ...over });

// 1 忠臣、2 梅林、3 刺客、4 忠臣、5 莫甘娜、6 派西、7 莫德雷德、8 忠臣、9 奧伯倫、10 忠臣
const ROLES: Role[] = ['loyal', 'merlin', 'assassin', 'loyal', 'morgana', 'percival', 'mordred', 'loyal', 'oberon', 'loyal'] as Role[];

function prop(gi: number, round: number, attempt: number, leader: number, team: number[], yes: number[], went: boolean): ReplayProposal {
  const votes = Array.from({ length: 10 }, (_, i) => yes.includes(i + 1));
  return {
    round, attempt, globalIndex: gi, leaderSeat: leader, teamSeats: team,
    plusSeats: yes.filter((s) => !team.includes(s)), minusSeats: team.filter((s) => !yes.includes(s)),
    votes, approveCount: yes.length, forced: false, wentOnMission: went, votesReliable: true,
  };
}

/** order 'BRBB'（第 1 局成功、第 2 局失敗）或 'BBRB'。 */
function game(order: 'BRBB' | 'BBRB'): ReplayGame {
  const r2fail = order === 'BRBB';
  const proposals = [
    prop(0, 1, 1, 1, [1, 2, 4], [1, 2, 4, 6, 8, 10], true),
    prop(1, 2, 1, 2, r2fail ? [1, 2, 4, 5] : [1, 2, 4, 6], [1, 2, 4, 5, 3, 7], true),
    prop(2, 3, 1, 3, [3, 6, 8, 10], [3, 5, 7, 9], false),
    prop(3, 3, 2, 4, r2fail ? [1, 2, 6, 8] : [1, 3, 6, 8], [1, 2, 4, 6, 8, 10], true),
    prop(4, 4, 1, 5, [1, 2, 4, 6, 8], [1, 2, 4, 6, 8, 10, 5], true),
  ];
  const quest = (round: number, team: number[], fails: number) => ({ round, teamSeats: team, successCount: team.length - fails, failCount: fails, failed: fails >= (round === 4 ? 2 : 1) });
  return {
    id: `r61-${order}`, playerCount: 10, seatRoles: ROLES, names: Array(10).fill(''), proposals,
    quests: [quest(1, [1, 2, 4], 0), quest(2, proposals[1].teamSeats, r2fail ? 1 : 0), quest(3, proposals[3].teamSeats, r2fail ? 0 : 1), quest(4, [1, 2, 4, 6, 8], 0)],
    lakes: [], lakeChainValid: false, assassinTargetSeat: 6, winner: 'good',
  };
}

describe('round 61 flags', () => {
  it('exist, off in both tables, parse', () => {
    for (const t of [LEGACY_AGENT_TUNING, DEFAULT_AGENT_TUNING]) {
      expect(t.assassinPath61).toBe(0);
      expect(t.redR2Lead61).toBe(0);
    }
    expect(parseTuningFlag('assassinPath61')).toEqual({ assassinPath61: 1 });
    expect(parseTuningFlag('redR2Lead61=1')).toEqual({ redR2Lead61: 1 });
    expect(() => parseTuningFlag('assassinPath61=x')).toThrow();
  });
});

describe('assassinPath61', () => {
  it('reads the mission order and applies only after an R1 success and an R2 fail', () => {
    const br = buildReplayObservation(game('BRBB'), 3, { kind: 'assassination' });
    const bb = buildReplayObservation(game('BBRB'), 3, { kind: 'assassination' });
    expect(missionOrder61(br)).toBe('BRBB');
    expect(missionOrder61(bb)).toBe('BBRB');
    expect(path61Mults(T(), br)).toBeNull();
    expect(path61Mults(T({ assassinPath61: 1 }), br)).toEqual(PATH61_MULTS.BR);
    expect(path61Mults(T({ assassinPath61: 1 }), bb)).toBeNull();
  });

  it('scales the vote / lead / re-proposal terms of every candidate, leaves the model term; other orders unchanged', () => {
    for (const order of ['BRBB', 'BBRB'] as const) {
      const obs = buildReplayObservation(game(order), 3, { kind: 'assassination' });
      const off = new HeuristicAgent(seatId(3), undefined, undefined, T()).assassinationReadout(obs)!;
      const on = new HeuristicAgent(seatId(3), undefined, undefined, T({ assassinPath61: 1 })).assassinationReadout(obs)!;
      expect(on.candidates).toEqual(off.candidates);
      expect(on.front).toEqual(off.front);
      const m = order === 'BRBB' ? PATH61_MULTS.BR : { vote: 1, lead: 1, reuse: 1 };
      for (const id of off.candidates) {
        const a = off.terms.get(id)!;
        const b = on.terms.get(id)!;
        expect(b.model).toBe(a.model);
        expect(b.vote).toBeCloseTo(a.vote * m.vote, 12);
        expect(b.lead).toBeCloseTo(a.lead * m.lead, 12);
        expect(b.reuse).toBeCloseTo(a.reuse * m.reuse, 12);
        expect(on.scores.get(id)!).toBeCloseTo(b.model + b.vote + b.lake + b.lead + b.reuse, 12);
      }
      if (order === 'BBRB') expect([...on.scores]).toEqual([...off.scores]);
    }
  });

  it('the assassin still picks a non-red candidate (all four reds pooled at the assassination)', () => {
    const obs = buildReplayObservation(game('BRBB'), 3, { kind: 'assassination' });
    expect(obs.allEvilIds?.sort()).toEqual(['P3', 'P5', 'P7', 'P9']);
    const act = withSeededRandom('r61', () => new HeuristicAgent(seatId(3), undefined, undefined, T({ assassinPath61: 1 })).act(obs));
    expect(act.type).toBe('assassinate');
    if (act.type === 'assassinate') expect(['P3', 'P5', 'P7', 'P9']).not.toContain(act.targetId);
  });

  it('study features: R1 / R2 mission teams and leads', () => {
    const obs = buildReplayObservation(game('BRBB'), 3, { kind: 'assassination' });
    const f = assassinPathFeatures61(obs, 'P2', obs.allEvilIds ?? []);
    expect(f.onR1).toBe(1);
    expect(f.onR2).toBe(1);
    expect(f.ledR2).toBe(1);
    expect(f.ledR1).toBe(0);
    expect(f.onFail).toBe(1);
  });
});

describe('redR2Lead61', () => {
  const quest = (role: string, team: string[], over: Partial<PlayerObservation> = {}): PlayerObservation => ({
    gamePhase: 'quest_vote', myTeam: 'evil', myRole: role, myPlayerId: 'P3', currentRound: 2, questResults: ['success'],
    proposedTeam: team, knownEvils: role === 'oberon' ? [] : ['P5', 'P7'], ...over,
  } as unknown as PlayerObservation);
  const teams: string[][] = [];
  const others = ['P1', 'P2', 'P4', 'P6', 'P8', 'P9', 'P10'];
  for (let a = 0; a < others.length; a++) for (let b = a + 1; b < others.length; b++) for (let c = b + 1; c < others.length; c++) teams.push(['P3', others[a], others[b], others[c]]);

  it('off, another score, another round, or a teammate on the team: no opinion', () => {
    expect(redR2LeadCard61(T(), quest('assassin', ['P1', 'P2', 'P3', 'P4']))).toBeNull();
    const on = T({ redR2Lead61: 1 });
    expect(redR2LeadCard61(on, quest('assassin', ['P1', 'P2', 'P3', 'P4'], { questResults: ['fail'] }))).toBeNull();
    expect(redR2LeadCard61(on, quest('assassin', ['P1', 'P2', 'P3', 'P4'], { currentRound: 3, questResults: ['success', 'fail'] }))).toBeNull();
    expect(redR2LeadCard61(on, quest('assassin', ['P1', 'P2', 'P3', 'P5']))).toBeNull();
    expect(redR2LeadCard61(on, quest('assassin', ['P1', 'P2', 'P4', 'P6']))).toBeNull(); // not on the team
  });

  it('hides at the real-game rate, and only where redHideHuman also hides (it only turns hides into fails)', () => {
    const on = T({ redR2Lead61: 1 });
    for (const role of ['assassin', 'morgana', 'mordred', 'oberon']) {
      let hide = 0;
      for (const team of teams) {
        const o = quest(role, team);
        const card = redR2LeadCard61(on, o);
        expect(card).not.toBeNull();
        if (card === 'success') {
          hide++;
          expect(redHideHumanCard(on, o)).toBe('success');
        }
      }
      expect(hide / teams.length).toBeLessThanOrEqual(R2_LEAD_HIDE_RATE[role] + 0.1);
    }
  });
});
