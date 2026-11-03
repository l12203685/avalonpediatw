/**
 * 優化迴圈第 21 回合・紅方（刺客）候選，預設關：「該照派而沒照派」的乘數分局數、用自我對打量到的比例（`assassinReuseRead=4`），
 * 兩局都用量到的比例（`=5`）、只第 2 局用量到的（`=6`）、再讀「照派了」（`=7`）、乾淨的隊沒照派也讀（`=8`）。
 */
import { describe, expect, it } from 'vitest';
import type { PlayerObservation, VoteRecord } from './types';
import { DEFAULT_AGENT_TUNING, parseTuningFlag } from './AgentTuning';
import { HeuristicAgent } from './HeuristicAgent';
import { missedReuseLeads, reuseLeadCounts, reuseLeadLogRatio, REUSE_LEAD_LR, REUSE_MODE_FACTORS } from './assassin/VisibleRedProposals';

const IDS = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
const vote = (round: number, attempt: number, leader: string, team: string[], approved = false): VoteRecord =>
  ({ round, attempt, leader, team, approved, votes: {} }) as unknown as VoteRecord;

// Assassin P1 (hid on R1), Morgana P2, Mordred P8, Oberon P9. R1 P1 P4 P5 succeeded; R2 P6 passed it over (failed);
// R3 P7 passed over R1, P4 re-proposed it (success); R4 P5 passed over R3 (success).
function assassination(extra: VoteRecord[] = []): PlayerObservation {
  return {
    myPlayerId: 'P1', myRole: 'assassin', myTeam: 'evil', playerCount: 10, allPlayerIds: IDS, knownEvils: ['P1', 'P2', 'P8'],
    allEvilIds: ['P1', 'P2', 'P8', 'P9'], allEvilRoles: { P1: 'assassin', P2: 'morgana', P8: 'mordred', P9: 'oberon' },
    currentRound: 5, gamePhase: 'assassination', failCount: 0,
    questResults: ['success', 'fail', 'success', 'success'],
    questHistory: [
      { round: 1, team: ['P1', 'P4', 'P5'], result: 'success', failCount: 0 },
      { round: 2, team: ['P2', 'P3', 'P6', 'P10'], result: 'fail', failCount: 1 },
      { round: 3, team: ['P1', 'P4', 'P5', 'P6'], result: 'success', failCount: 0 },
      { round: 4, team: ['P3', 'P4', 'P5', 'P6', 'P10'], result: 'success', failCount: 0 },
    ],
    voteHistory: [
      vote(1, 1, 'P3', ['P1', 'P4', 'P5'], true),
      vote(2, 1, 'P6', ['P2', 'P3', 'P6', 'P10'], true),
      vote(3, 1, 'P7', ['P1', 'P6', 'P7', 'P10']),
      vote(3, 2, 'P4', ['P1', 'P4', 'P5', 'P6'], true),
      vote(4, 1, 'P5', ['P3', 'P4', 'P5', 'P6', 'P10'], true),
      ...extra,
    ],
    lakeHistory: [], proposedTeam: [],
  } as unknown as PlayerObservation;
}

describe('flags', () => {
  it('parse 4 and 5; default 9 since round 23', () => {
    expect(parseTuningFlag('assassinReuseRead=4')).toEqual({ assassinReuseRead: 4 });
    expect(parseTuningFlag('assassinReuseRead=10')).toEqual({ assassinReuseRead: 10 });
    expect(() => parseTuningFlag('assassinReuseRead=12')).toThrow();
    expect(DEFAULT_AGENT_TUNING.assassinReuseRead).toBe(9); // round 23 adopted 9
  });
});

describe('reuseLeadCounts', () => {
  const obs = assassination();
  it('splits the norm leads by round and by passed over / re-proposed', () => {
    expect(reuseLeadCounts(obs, 'P6')).toEqual({ missR2: 1, missR3: 0, reuseR2: 0, reuseR3: 0, cleanMissR2: 0, cleanMissR3: 0 });
    expect(reuseLeadCounts(obs, 'P7')).toEqual({ missR2: 0, missR3: 1, reuseR2: 0, reuseR3: 0, cleanMissR2: 0, cleanMissR3: 0 });
    expect(reuseLeadCounts(obs, 'P4')).toEqual({ missR2: 0, missR3: 0, reuseR2: 0, reuseR3: 1, cleanMissR2: 0, cleanMissR3: 0 });
    expect(reuseLeadCounts(obs, 'P3')).toEqual({ missR2: 0, missR3: 0, reuseR2: 0, reuseR3: 0, cleanMissR2: 0, cleanMissR3: 0 });
  });
  it('the misses agree with mode 3', () => {
    for (const id of ['P3', 'P4', 'P5', 'P6', 'P7', 'P10']) {
      const c = reuseLeadCounts(obs, id);
      expect(c.missR2 + c.missR3).toBe(missedReuseLeads(obs, id));
    }
  });
  it('a forced lead and a lead after two fails do not count', () => {
    const forced = assassination([vote(5, 5, 'P10', ['P3', 'P6', 'P7', 'P10', 'P2'])]);
    expect(reuseLeadCounts(forced, 'P10')).toEqual({ missR2: 0, missR3: 0, reuseR2: 0, reuseR3: 0, cleanMissR2: 0, cleanMissR3: 0 });
  });
});

describe('reuseLeadLogRatio', () => {
  const obs = assassination();
  const L = REUSE_LEAD_LR;
  it('mode 3 through the factors equals the round-19 read', () => {
    for (const id of ['P3', 'P4', 'P5', 'P6', 'P7', 'P10']) expect(reuseLeadLogRatio(obs, id, 3)).toBeCloseTo(Math.log(0.25) * missedReuseLeads(obs, id));
  });
  it('mode 4: R2 miss ×0.25 as mode 3, R3+ miss measured; re-proposals neutral', () => {
    expect(reuseLeadLogRatio(obs, 'P6', 4)).toBeCloseTo(Math.log(0.25));
    expect(reuseLeadLogRatio(obs, 'P7', 4)).toBeCloseTo(Math.log(L.missR3));
    expect(reuseLeadLogRatio(obs, 'P4', 4)).toBeCloseTo(0);
  });
  it('modes 5 and 6: the measured R2 ratio', () => {
    expect(reuseLeadLogRatio(obs, 'P6', 5)).toBeCloseTo(Math.log(L.missR2));
    expect(reuseLeadLogRatio(obs, 'P7', 5)).toBeCloseTo(Math.log(L.missR3));
    expect(reuseLeadLogRatio(obs, 'P6', 6)).toBeCloseTo(Math.log(L.missR2));
    expect(reuseLeadLogRatio(obs, 'P7', 6)).toBeCloseTo(Math.log(0.25));
  });
  it('mode 7 also credits the re-proposal', () => {
    expect(reuseLeadLogRatio(obs, 'P4', 7)).toBeCloseTo(Math.log(L.reuseR3));
    expect(L.reuseR3).toBeGreaterThan(1);
    expect(reuseLeadLogRatio(obs, 'P4', 3)).toBeCloseTo(0);
    expect(reuseLeadLogRatio(obs, 'P7', 7)).toBeCloseTo(Math.log(0.25));
  });
  it('modes 9 and 10 use the fitted factors', () => {
    for (const mode of [9, 10]) {
      const f = REUSE_MODE_FACTORS[mode];
      expect(reuseLeadLogRatio(obs, 'P4', mode)).toBeCloseTo(Math.log(f.reuse[1]));
      expect(reuseLeadLogRatio(obs, 'P6', mode)).toBeCloseTo(Math.log(f.miss[0]));
      expect(reuseLeadLogRatio(obs, 'P7', mode)).toBeCloseTo(Math.log(f.miss[1]));
    }
  });
  it('mode 8 also reads a clean norm team passed over', () => {
    // R1 P3 P4 P5 (clean) succeeded; R2 P6 left it out.
    const clean = {
      ...obs,
      questResults: ['success', 'fail'],
      questHistory: [
        { round: 1, team: ['P3', 'P4', 'P5'], result: 'success', failCount: 0 },
        { round: 2, team: ['P2', 'P3', 'P6', 'P10'], result: 'fail', failCount: 1 },
      ],
      voteHistory: [vote(1, 1, 'P3', ['P3', 'P4', 'P5'], true), vote(2, 1, 'P6', ['P2', 'P3', 'P6', 'P10'], true)],
    } as unknown as PlayerObservation;
    expect(reuseLeadCounts(clean, 'P6').cleanMissR2).toBe(1);
    expect(reuseLeadLogRatio(clean, 'P6', 3)).toBeCloseTo(0);
    expect(reuseLeadLogRatio(clean, 'P6', 8)).toBeCloseTo(Math.log(L.cleanMissR2));
    expect(missedReuseLeads(clean, 'P6')).toBe(0);
  });
});

describe('assassinate with modes 4 and 5', () => {
  it('returns a blue target', () => {
    for (const mode of [3, 4, 5, 6, 7, 8, 9, 10]) {
      const agent = new HeuristicAgent('P1', undefined, undefined, { ...DEFAULT_AGENT_TUNING, assassinReuseRead: mode });
      const a = agent.act(assassination());
      expect(a.type).toBe('assassinate');
      if (a.type === 'assassinate') expect(['P3', 'P4', 'P5', 'P6', 'P7', 'P10']).toContain(a.targetId);
    }
  });
});
