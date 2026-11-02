/**
 * 優化迴圈第 21 回合・紅方（刺客）候選，預設關：「該照派而沒照派」的乘數分局數、用自我對打量到的比例（`assassinReuseRead=4`），
 * 再讀「照派了」（`assassinReuseRead=5`）。
 */
import { describe, expect, it } from 'vitest';
import type { PlayerObservation, VoteRecord } from './types';
import { DEFAULT_AGENT_TUNING, parseTuningFlag } from './AgentTuning';
import { HeuristicAgent } from './HeuristicAgent';
import { missedReuseLeads, reuseLeadCounts, reuseLeadLogRatio, REUSE_LEAD_LR } from './assassin/VisibleRedProposals';

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
  it('parse 4 and 5; default stays 3', () => {
    expect(parseTuningFlag('assassinReuseRead=4')).toEqual({ assassinReuseRead: 4 });
    expect(parseTuningFlag('assassinReuseRead=5')).toEqual({ assassinReuseRead: 5 });
    expect(() => parseTuningFlag('assassinReuseRead=6')).toThrow();
    expect(DEFAULT_AGENT_TUNING.assassinReuseRead).toBe(3);
  });
});

describe('reuseLeadCounts', () => {
  const obs = assassination();
  it('splits the norm leads by round and by passed over / re-proposed', () => {
    expect(reuseLeadCounts(obs, 'P6')).toEqual({ missR2: 1, missR3: 0, reuseR2: 0, reuseR3: 0 });
    expect(reuseLeadCounts(obs, 'P7')).toEqual({ missR2: 0, missR3: 1, reuseR2: 0, reuseR3: 0 });
    expect(reuseLeadCounts(obs, 'P4')).toEqual({ missR2: 0, missR3: 0, reuseR2: 0, reuseR3: 1 });
    expect(reuseLeadCounts(obs, 'P3')).toEqual({ missR2: 0, missR3: 0, reuseR2: 0, reuseR3: 0 });
  });
  it('the misses agree with mode 3', () => {
    for (const id of ['P3', 'P4', 'P5', 'P6', 'P7', 'P10']) {
      const c = reuseLeadCounts(obs, id);
      expect(c.missR2 + c.missR3).toBe(missedReuseLeads(obs, id));
    }
  });
  it('a forced lead and a lead after two fails do not count', () => {
    const forced = assassination([vote(5, 5, 'P10', ['P3', 'P6', 'P7', 'P10', 'P2'])]);
    expect(reuseLeadCounts(forced, 'P10')).toEqual({ missR2: 0, missR3: 0, reuseR2: 0, reuseR3: 0 });
  });
});

describe('reuseLeadLogRatio', () => {
  const obs = assassination();
  it('mode 4: R2 miss heavy, R3+ miss mild; re-proposals neutral', () => {
    expect(reuseLeadLogRatio(obs, 'P6', 4)).toBeCloseTo(Math.log(REUSE_LEAD_LR.missR2));
    expect(reuseLeadLogRatio(obs, 'P7', 4)).toBeCloseTo(Math.log(REUSE_LEAD_LR.missR3));
    expect(reuseLeadLogRatio(obs, 'P4', 4)).toBeCloseTo(0);
    expect(REUSE_LEAD_LR.missR2).toBeLessThan(REUSE_LEAD_LR.missR3);
    expect(REUSE_LEAD_LR.missR3).toBeLessThan(1);
  });
  it('mode 5 also credits the re-proposal', () => {
    expect(reuseLeadLogRatio(obs, 'P4', 5)).toBeCloseTo(Math.log(REUSE_LEAD_LR.reuseR3));
    expect(REUSE_LEAD_LR.reuseR3).toBeGreaterThan(1);
  });
});

describe('assassinate with modes 4 and 5', () => {
  it('returns a blue target', () => {
    for (const mode of [3, 4, 5]) {
      const agent = new HeuristicAgent('P1', undefined, undefined, { ...DEFAULT_AGENT_TUNING, assassinReuseRead: mode });
      const a = agent.act(assassination());
      expect(a.type).toBe('assassinate');
      if (a.type === 'assassinate') expect(['P3', 'P4', 'P5', 'P6', 'P7', 'P10']).toContain(a.targetId);
    }
  });
});
