/**
 * 優化迴圈第 23 回合・紅方（刺客）候選（採用 1）：第 1、2 局注定被否決的提議放了確定看得到的紅，排到第二層（`assassinDoomedRead=1`）、
 * 讀派隊時那些提議用 ε = 0.05（`=2`）、兩者一起（`=3`）；第 2 局照派成功的第 1 局隊不算。
 */
import { describe, expect, it } from 'vitest';
import type { PlayerObservation, VoteRecord } from './types';
import { DEFAULT_AGENT_TUNING, parseTuningFlag } from './AgentTuning';
import { HeuristicAgent } from './HeuristicAgent';
import { doomedTierCandidates, r2ReuseOfR1, DOOMED_LEAD_EPS } from './assassin/VisibleRedProposals';
import { merlinLeadLogRatio } from './assassin/MerlinLeadRead';

const IDS = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
const BLUES = ['P3', 'P4', 'P5', 'P6', 'P7', 'P10'];
const vote = (round: number, attempt: number, leader: string, team: string[], approved = false): VoteRecord =>
  ({ round, attempt, leader, team, approved, votes: {} }) as unknown as VoteRecord;

// Assassin P1 (hid on R1), Morgana P2, Mordred P8, Oberon P9. R1: P7 proposed P2 (doomed, rejected), P3 led P1 P4 P5 (success).
// R2: P6 re-proposed the R1 team plus himself (doomed), P10 led P2 P3 P6 P10 (fail). R3: P4 led a clean team (success).
function assassination(extra: VoteRecord[] = []): PlayerObservation {
  return {
    myPlayerId: 'P1', myRole: 'assassin', myTeam: 'evil', playerCount: 10, allPlayerIds: IDS, knownEvils: ['P1', 'P2', 'P8'],
    allEvilIds: ['P1', 'P2', 'P8', 'P9'], allEvilRoles: { P1: 'assassin', P2: 'morgana', P8: 'mordred', P9: 'oberon' },
    currentRound: 4, gamePhase: 'assassination', failCount: 0,
    questResults: ['success', 'fail', 'success'],
    questHistory: [
      { round: 1, team: ['P1', 'P4', 'P5'], result: 'success', failCount: 0 },
      { round: 2, team: ['P2', 'P3', 'P6', 'P10'], result: 'fail', failCount: 1 },
      { round: 3, team: ['P3', 'P4', 'P5', 'P6'], result: 'success', failCount: 0 },
    ],
    voteHistory: [
      vote(1, 1, 'P7', ['P2', 'P7', 'P10']),
      vote(1, 2, 'P3', ['P1', 'P4', 'P5'], true),
      vote(2, 1, 'P6', ['P1', 'P4', 'P5', 'P6']),
      vote(2, 2, 'P10', ['P2', 'P3', 'P6', 'P10'], true),
      vote(3, 1, 'P4', ['P3', 'P4', 'P5', 'P6'], true),
      ...extra,
    ],
    lakeHistory: [], proposedTeam: [],
  } as unknown as PlayerObservation;
}

describe('flags', () => {
  it('parse 0–3; default 1 since round 23', () => {
    expect(parseTuningFlag('assassinDoomedRead')).toEqual({ assassinDoomedRead: 1 });
    expect(parseTuningFlag('assassinDoomedRead=3')).toEqual({ assassinDoomedRead: 3 });
    expect(() => parseTuningFlag('assassinDoomedRead=4')).toThrow();
    expect(DEFAULT_AGENT_TUNING.assassinDoomedRead).toBe(1);
  });
});

describe('r2ReuseOfR1', () => {
  const obs = assassination();
  it('the R2 re-proposal of the successful R1 team (every seen red from R1) is the norm', () => {
    expect(r2ReuseOfR1(obs, obs.voteHistory[2])).toBe(true);
    expect(r2ReuseOfR1(obs, obs.voteHistory[3])).toBe(false);
    expect(r2ReuseOfR1(obs, obs.voteHistory[0])).toBe(false);
  });
  it('an extra seen red not from R1 breaks it; a failed R1 has no norm', () => {
    expect(r2ReuseOfR1(obs, vote(2, 1, 'P6', ['P1', 'P4', 'P5', 'P2']))).toBe(false);
    const failed = { ...obs, questResults: ['fail', 'fail', 'success'] } as unknown as PlayerObservation;
    expect(r2ReuseOfR1(failed, obs.voteHistory[2])).toBe(false);
  });
});

describe('doomedTierCandidates', () => {
  const obs = assassination();
  it('drops a doomed R1–R2 captain with a seen red; keeps the R2 re-proposal and the clean captains', () => {
    expect(doomedTierCandidates(obs, BLUES)).toEqual(['P4', 'P5', 'P6']); // P3's R1 lead held the hidden assassin, P10's R2 lead the Morgana (both non-forced)
  });
  it('a forced R1 proposal is the standard tier, not this one', () => {
    const forced = assassination([vote(1, 5, 'P5', ['P2', 'P5', 'P6'])]);
    expect(doomedTierCandidates(forced, BLUES)).not.toContain('P7');
    expect(doomedTierCandidates(forced, BLUES)).toContain('P5');
  });
  it('everyone flagged keeps the whole pool', () => {
    expect(doomedTierCandidates(obs, ['P7'])).toEqual(['P7']);
  });
});

describe('lead read ε', () => {
  const obs = assassination();
  const reds = ['P1', 'P2', 'P8', 'P9'];
  it('mode 2 reads the seen-red doomed lead harder; the R2 re-proposal and clean leads are unchanged', () => {
    expect(merlinLeadLogRatio(obs, 'P7', reds, {}, true, DOOMED_LEAD_EPS)).toBeLessThan(merlinLeadLogRatio(obs, 'P7', reds, {}, true));
    expect(merlinLeadLogRatio(obs, 'P6', reds, {}, true, DOOMED_LEAD_EPS)).toBeCloseTo(merlinLeadLogRatio(obs, 'P6', reds, {}, true));
    expect(merlinLeadLogRatio(obs, 'P4', reds, {}, true, DOOMED_LEAD_EPS)).toBeCloseTo(merlinLeadLogRatio(obs, 'P4', reds, {}, true));
  });
});

describe('assassinate', () => {
  it('modes 1 and 3 never pick the doomed seen-red captain while another candidate is left; every mode returns a blue', () => {
    for (const mode of [0, 1, 2, 3]) {
      const agent = new HeuristicAgent('P1', undefined, undefined, { ...DEFAULT_AGENT_TUNING, assassinDoomedRead: mode });
      const a = agent.act(assassination());
      expect(a.type).toBe('assassinate');
      if (a.type === 'assassinate') {
        expect(BLUES).toContain(a.targetId);
        if (mode === 1 || mode === 3) expect(a.targetId).not.toBe('P7');
      }
    }
  });
});

describe('practice review', () => {
  it('states the second tier when it applies', async () => {
    const { explainAssassination } = await import('./explain');
    const ex = explainAssassination(assassination(), 'P4', undefined, DEFAULT_AGENT_TUNING);
    expect(ex.reason).toContain('第 1、2 局注定被否決的提議放了梅林看得到的紅');
  });
});
