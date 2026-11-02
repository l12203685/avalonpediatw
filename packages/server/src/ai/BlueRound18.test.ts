/**
 * 優化迴圈第 18 回合・藍方：`merlinReuseNorm` 2／3（梅林第 3 局起非關鍵局也照派成功的隊）。
 */
import { describe, expect, it } from 'vitest';
import type { PlayerObservation } from './types';
import { DEFAULT_AGENT_TUNING, parseTuningFlag } from './AgentTuning';
import { merlinReuseNormTeam, merlinReuseProposal } from './MerlinLoyalStyle';

const IDS = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);

describe('merlinReuseNorm 2 / 3 (round 3+ non-key rounds)', () => {
  // R2 P2 P3 P4 P5 succeeded with the seen red P3 on it; Merlin P1 leads R3 (size 4).
  const mobs = {
    myPlayerId: 'P1', myRole: 'merlin', myTeam: 'good', playerCount: 10, allPlayerIds: IDS, knownEvils: ['P3', 'P7', 'P9'],
    currentRound: 3, currentLeader: 'P1', failCount: 0, questResults: ['fail', 'success'], gamePhase: 'team_select',
    questHistory: [
      { round: 1, team: ['P6', 'P7', 'P8'], result: 'fail', failCount: 1 },
      { round: 2, team: ['P2', 'P3', 'P4', 'P5'], result: 'success', failCount: 0 },
    ],
    voteHistory: [], proposedTeam: [], lakeHistory: [],
  } as unknown as PlayerObservation;
  const at = (mode: number) => ({ ...DEFAULT_AGENT_TUNING, merlinLoyalStyle: true, merlinReuseNorm: mode });
  it('1 (round 17) stays at R2', () => {
    expect(merlinReuseNormTeam(at(1), mobs, 4)).toBeNull();
  });
  it('2: a full successful team is re-proposed as it was, Merlin off it', () => {
    expect(merlinReuseNormTeam(at(2), mobs, 4)).toEqual(['P2', 'P3', 'P4', 'P5']);
  });
  it('2: a bigger team adds Merlin first, then the cleanest public pick without a seen red', () => {
    const r4 = {
      ...mobs, currentRound: 4, questResults: ['success', 'fail', 'success'],
      questHistory: [
        { round: 1, team: ['P6', 'P8', 'P10'], result: 'success', failCount: 0 },
        { round: 2, team: ['P6', 'P7', 'P8', 'P10'], result: 'fail', failCount: 1 },
        { round: 3, team: ['P2', 'P3', 'P4', 'P5'], result: 'success', failCount: 0 },
      ],
    } as unknown as PlayerObservation;
    const t = merlinReuseNormTeam(at(2), r4, 5);
    expect(t?.slice(0, 5)).toEqual(['P1', 'P2', 'P3', 'P4', 'P5']);
  });
  it('2: not in a key round (red two fails), not on the forced proposal, not when the gate bars the team', () => {
    expect(merlinReuseNormTeam(at(2), { ...mobs, currentRound: 4, questResults: ['fail', 'success', 'fail'] } as PlayerObservation, 5)).toBeNull();
    expect(merlinReuseNormTeam(at(2), { ...mobs, failCount: 4 } as PlayerObservation, 4)).toBeNull();
    expect(merlinReuseNormTeam(at(2), mobs, 4, () => false)).toBeNull();
  });
  it('2 needs the previous mission; 3 goes back to the latest success', () => {
    const afterFail = {
      ...mobs, currentRound: 3, questResults: ['success', 'fail'],
      questHistory: [
        { round: 1, team: ['P2', 'P3', 'P4'], result: 'success', failCount: 0 },
        { round: 2, team: ['P5', 'P6', 'P7', 'P8'], result: 'fail', failCount: 1 },
      ],
    } as unknown as PlayerObservation;
    expect(merlinReuseNormTeam(at(2), afterFail, 4)).toBeNull();
    expect(merlinReuseNormTeam(at(3), afterFail, 4)).toEqual(['P1', 'P2', 'P3', 'P4']);
  });
  it('the flag takes 0–3', () => {
    expect(parseTuningFlag('merlinReuseNorm=3').merlinReuseNorm).toBe(3);
    expect(() => parseTuningFlag('merlinReuseNorm=4')).toThrow();
  });
  it('merlinReuseProposal (the invariant exemption) matches the re-proposal and nothing looser', () => {
    expect(merlinReuseProposal(mobs, ['P2', 'P3', 'P4', 'P5'])).toBe(true);
    expect(merlinReuseProposal(mobs, ['P1', 'P3', 'P4', 'P5'])).toBe(false); // not the whole successful team
    expect(merlinReuseProposal({ ...mobs, currentRound: 4, questResults: ['fail', 'success', 'fail'] } as PlayerObservation, ['P2', 'P3', 'P4', 'P5', 'P6'])).toBe(false); // key round
    expect(merlinReuseProposal({ ...mobs, currentRound: 2 } as PlayerObservation, ['P2', 'P3', 'P4', 'P5'])).toBe(false); // R1-R2: the doomed-proposal exemption
    expect(merlinReuseProposal(mobs, ['P2', 'P3', 'P4', 'P5', 'P7'])).toBe(false); // a seen red from outside the successful team
  });
});
