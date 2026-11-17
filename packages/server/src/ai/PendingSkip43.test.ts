/**
 * 第 42 回合補充（PR #46 第 9 節）：`beliefPendingSkip43` —— `beliefPendingProposal` 開著時，第 3 局在隊上的投票不讀表決中的提議。
 */
import { describe, expect, it } from 'vitest';
import type { PlayerObservation } from './types';
import { DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING, describeAgentTuning, parseTuningFlag } from './AgentTuning';
import { bayesOptionsOf, bayesTeamClean } from './belief/BayesBelief';

const IDS = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
const asObs = (o: object) => o as unknown as PlayerObservation;
const vote = (round: number, attempt: number, leader: string, team: string[], yes: string[]) => ({
  round, attempt, leader, team, approved: yes.length > 5, votes: Object.fromEntries(IDS.map((id) => [id, yes.includes(id)])),
});
const history = [
  vote(1, 1, 'P1', ['P1', 'P2', 'P3'], IDS),
  vote(2, 1, 'P2', ['P2', 'P4', 'P6', 'P9'], IDS),
];
const base = {
  myPlayerId: 'P7', myRole: 'loyal', myTeam: 'good', seatTeam: 'good', playerCount: 10, allPlayerIds: IDS, knownEvils: [], evilCount: 4,
  lakeHistory: [], myLakeResults: [], gamePhase: 'team_vote', currentLeader: 'P3', failCount: 0, voteHistory: history,
};
const q = (round: number, team: string[], result: 'success' | 'fail') => ({ round, team, result, failCount: result === 'fail' ? 1 : 0 });
// Round 3, score 1 red – 1 blue (red under two wins).
const r3 = (over: object) => asObs({
  ...base, currentRound: 3, questResults: ['success', 'fail'], questHistory: [q(1, ['P1', 'P2', 'P3'], 'success'), q(2, ['P2', 'P4', 'P6', 'P9'], 'fail')], ...over,
});
const PEND = { ...DEFAULT_AGENT_TUNING, beliefPendingProposal: true };
const clean = (o: PlayerObservation, team: string[], t: object) => bayesTeamClean(o, team, bayesOptionsOf({ ...DEFAULT_AGENT_TUNING, ...t }))!;

describe('beliefPendingSkip43', () => {
  it('off in the legacy table and the default; flag parses 0–7', () => {
    expect(LEGACY_AGENT_TUNING.beliefPendingSkip43).toBe(0);
    expect(DEFAULT_AGENT_TUNING.beliefPendingSkip43).toBe(0);
    expect(parseTuningFlag('beliefPendingSkip43')).toEqual({ beliefPendingSkip43: 1 });
    expect(parseTuningFlag('beliefPendingSkip43=2')).toEqual({ beliefPendingSkip43: 2 });
    expect(() => parseTuningFlag('beliefPendingSkip43=8')).toThrow();
    expect(describeAgentTuning({ ...DEFAULT_AGENT_TUNING, beliefPendingSkip43: 1 })).toContain('beliefPendingSkip43=1');
  });
  it('bit 1: on the team in round 3 with red under two wins reads as without the pending proposal', () => {
    const team = ['P3', 'P5', 'P7', 'P8'];
    const o = r3({ proposedTeam: team });
    const off = clean(o, team, {});
    const pend = clean(o, team, PEND);
    expect(Math.abs(off - pend)).toBeGreaterThan(1e-9);
    expect(clean(o, team, { ...PEND, beliefPendingSkip43: 1 })).toBeCloseTo(off, 12);
  });
  it('bit 1 leaves off-team votes, other rounds and red at two wins as `beliefPendingProposal`', () => {
    const offTeam = ['P3', 'P5', 'P8', 'P10'];
    const o1 = r3({ proposedTeam: offTeam });
    expect(clean(o1, offTeam, { ...PEND, beliefPendingSkip43: 1 })).toBeCloseTo(clean(o1, offTeam, PEND), 12);
    const team = ['P3', 'P5', 'P7', 'P8'];
    const twoWins = r3({ proposedTeam: team, questResults: ['fail', 'fail'], questHistory: [q(1, ['P1', 'P2', 'P3'], 'fail'), q(2, ['P2', 'P4', 'P6', 'P9'], 'fail')] });
    expect(clean(twoWins, team, { ...PEND, beliefPendingSkip43: 1 })).toBeCloseTo(clean(twoWins, team, PEND), 12);
    // bit 2 covers round 3 at any score
    expect(clean(twoWins, team, { ...PEND, beliefPendingSkip43: 2 })).toBeCloseTo(clean(twoWins, team, {}), 12);
    const r4 = asObs({ ...(r3({ proposedTeam: ['P3', 'P5', 'P7', 'P8', 'P1'] }) as object), currentRound: 4, questResults: ['success', 'fail', 'success'] });
    const t4 = ['P3', 'P5', 'P7', 'P8', 'P1'];
    expect(clean(r4, t4, { ...PEND, beliefPendingSkip43: 3 })).toBeCloseTo(clean(r4, t4, PEND), 12);
  });
  it('bit 4: loyal seats only (Percival / Merlin keep the pending read)', () => {
    const team = ['P3', 'P5', 'P7', 'P8'];
    const loyal = r3({ proposedTeam: team });
    expect(clean(loyal, team, { ...PEND, beliefPendingSkip43: 5 })).toBeCloseTo(clean(loyal, team, {}), 12);
    const perc = r3({ proposedTeam: team, myRole: 'percival' });
    expect(clean(perc, team, { ...PEND, beliefPendingSkip43: 5 })).toBeCloseTo(clean(perc, team, PEND), 12);
    const merlinPublic = r3({ proposedTeam: team, publicLoyalView: true });
    expect(clean(merlinPublic, team, { ...PEND, beliefPendingSkip43: 5 })).toBeCloseTo(clean(merlinPublic, team, PEND), 12);
  });
  it('without beliefPendingProposal the knob does nothing', () => {
    const team = ['P3', 'P5', 'P7', 'P8'];
    const o = r3({ proposedTeam: team });
    expect(clean(o, team, { beliefPendingSkip43: 3 })).toBeCloseTo(clean(o, team, {}), 12);
  });
});
