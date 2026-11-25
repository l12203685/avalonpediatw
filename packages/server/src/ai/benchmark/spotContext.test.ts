import { describe, expect, it } from 'vitest';
import type { Role } from '@avalon/shared';
import type { ReplayGame, ReplayProposal } from './sheetsReplay';
import { lakeContext, proposalFrame, spotContext, teamContext, voteContext, type LakeContext, type TeamContext, type VoteContext } from './spotContext';

/** 一次提議；票 = 在隊上贊成、不在隊上反對（`approve` 另外指定贊成的人）。 */
function prop(globalIndex: number, round: number, attempt: number, team: number[], went: boolean, approve?: number[]): ReplayProposal {
  const yes = approve ?? (went ? [1, 2, 3, 4, 5, 6] : team);
  const votes = Array.from({ length: 10 }, (_, i) => yes.includes(i + 1));
  return {
    round, attempt, globalIndex, leaderSeat: (globalIndex % 10) + 1, teamSeats: team, plusSeats: [], minusSeats: [], votes,
    approveCount: yes.length, forced: attempt === 5, wentOnMission: went, votesReliable: true,
  };
}

// 虛構的一局：紅方 = 4、7、8、9 家（刺客、莫甘娜、莫德雷德、奧伯倫），其他藍方；1、2、3、5 家是忠臣。
const ROLES: Role[] = ['loyal', 'loyal', 'loyal', 'assassin', 'loyal', 'merlin', 'morgana', 'mordred', 'oberon', 'percival'];
const GAME: ReplayGame = {
  id: 'T1',
  playerCount: 10,
  seatRoles: ROLES,
  names: [],
  proposals: [
    prop(0, 1, 1, [1, 2, 3], true), // 1家 隊長 → 成功
    prop(1, 2, 1, [2, 3, 4, 5], false), // 2家 隊長，被否決
    prop(2, 2, 2, [1, 2, 3, 7], true), // 3家 隊長 → 失敗（7家 紅）
    prop(3, 3, 1, [1, 2, 3, 10], false), // 4家 隊長（紅），被否決
    prop(4, 3, 2, [1, 2, 5, 6], true), // 5家 隊長 → 成功
  ],
  quests: [
    { round: 1, teamSeats: [1, 2, 3], successCount: 3, failCount: 0, failed: false },
    { round: 2, teamSeats: [1, 2, 3, 7], successCount: 3, failCount: 1, failed: true },
    { round: 3, teamSeats: [1, 2, 5, 6], successCount: 4, failCount: 0, failed: false },
  ],
  lakes: [
    { round: 2, holderSeat: 10, targetSeat: 3, claim: 'good' },
    { round: 3, holderSeat: 3, targetSeat: 7, claim: 'evil' },
  ],
  lakeChainValid: true,
  winner: 'good',
};

describe('proposalFrame', () => {
  it('the first proposal has no history', () => {
    expect(proposalFrame(GAME, 0)).toMatchObject({
      round: 1, attempt: 1, leaderSeat: 1, size: 3, blueWins: 0, redWins: 0, failedSeats: [], lastSuccessTeam: null,
      lastMissionSucceeded: false, lakeGoodSeats: [], lakeEvilSeats: [], prevLeaderSeat: null, prevTeam: null, prevSameRound: false,
    });
  });

  it('round 3 sees the failed mission, the last successful team and the first lake', () => {
    expect(proposalFrame(GAME, 4)).toMatchObject({
      round: 3, attempt: 2, leaderSeat: 5, blueWins: 1, redWins: 1, failedSeats: [1, 2, 3, 7], lastSuccessTeam: [1, 2, 3],
      lastMissionSucceeded: false, lakeGoodSeats: [3], lakeEvilSeats: [], prevLeaderSeat: 4, prevTeam: [1, 2, 3, 10], prevSameRound: true,
    });
  });

  it('a proposal right after a mission points at the previous round, not the same round', () => {
    const f = proposalFrame(GAME, 1);
    expect(f).toMatchObject({ round: 2, lastMissionSucceeded: true, prevLeaderSeat: 1, prevSameRound: false });
  });
});

describe('teamContext', () => {
  it('compares the player team with the bot team on the same frame', () => {
    const c = teamContext(GAME, 4, [5, 6, 10, 3]);
    expect(c.human).toEqual({ hasSelf: true, failedOthers: 2, keepsLastSuccess: false, lakeGoodOthers: 0, lakeEvilOthers: 0, hasPrevLeader: false, overlapPrev: 2, reds: 0 });
    expect(c.agent).toMatchObject({ hasSelf: true, failedOthers: 1, lakeGoodOthers: 1, overlapPrev: 2, reds: 0 });
    expect(c.seatsDiffer).toBe(2);
  });

  it('keeping the last successful team and carrying a red', () => {
    const c = teamContext(GAME, 1, [1, 2, 3, 9]);
    expect(c.human).toMatchObject({ hasSelf: true, keepsLastSuccess: false, hasPrevLeader: false, reds: 1 });
    expect(c.agent).toMatchObject({ keepsLastSuccess: true, hasPrevLeader: true, overlapPrev: 3, reds: 1 });
  });

  it('a leader left off the team', () => {
    expect(teamContext(GAME, 3, [1, 2, 3, 4]).human).toMatchObject({ hasSelf: false, failedOthers: 3, lakeGoodOthers: 1 });
  });
});

describe('voteContext', () => {
  it('on-team voter: the others on the team, the leader side and what happened next', () => {
    const c = voteContext(GAME, 2, 1);
    expect(c).toMatchObject({ onTeam: true, isLeader: false, team: [1, 2, 3, 7], leaderRed: false, approved: true, missionFailed: true });
    expect(c.features).toMatchObject({ hasSelf: true, keepsLastSuccess: true, reds: 1 });
  });

  it('off-team voter on a rejected proposal by a red leader', () => {
    expect(voteContext(GAME, 3, 5)).toMatchObject({ onTeam: false, leaderRed: true, approved: false, missionFailed: null });
  });
});

describe('lakeContext', () => {
  it('first lake: the holder cannot be inspected; target kinds from the public record', () => {
    const c = lakeContext(GAME, 0, 7);
    expect(c).toMatchObject({ afterRound: 2, blueWins: 1, redWins: 1, valid: [1, 2, 3, 4, 5, 6, 7, 8, 9], validReds: 4, validMissions: { failed: 4, successOnly: 0, none: 5 } });
    expect(c.human).toEqual({ seat: 3, missions: 'failed', ledFailedMission: true, onHolderProposals: false, clockwise: 3, ring: 3, red: false });
    expect(c.agent).toMatchObject({ seat: 7, missions: 'failed', ledFailedMission: false, clockwise: 7, ring: 3, red: true });
  });

  it('second lake: earlier holders and targets are out; missions up to that round count', () => {
    const c = lakeContext(GAME, 1, 6);
    expect(c.valid).toEqual([1, 2, 4, 5, 6, 7, 8, 9]);
    expect(c.validMissions).toEqual({ failed: 3, successOnly: 2, none: 3 });
    expect(c.human).toMatchObject({ seat: 7, missions: 'failed', onHolderProposals: true, clockwise: 4, red: true });
    expect(c.agent).toMatchObject({ seat: 6, missions: 'successOnly', onHolderProposals: false, red: false });
    expect(lakeContext(GAME, 1, 4).agent).toMatchObject({ missions: 'none', red: true });
    expect(lakeContext(GAME, 1, null).agent).toBeNull();
  });
});

describe('spotContext', () => {
  it('dispatches by decision type', () => {
    const team = spotContext(GAME, { type: 'team', seat: 5, round: 3, attempt: 2, agent: '3,5,6,10' }) as TeamContext;
    expect(team.seatsDiffer).toBe(2);
    const vote = spotContext(GAME, { type: 'vote', seat: 5, round: 3, attempt: 1, agent: 'reject' }) as VoteContext;
    expect(vote.frame.leaderSeat).toBe(4);
    const lake = spotContext(GAME, { type: 'lakeTarget', seat: 3, round: 3, agent: '6' }) as LakeContext;
    expect(lake.agent?.seat).toBe(6);
  });

  it('no context for quest cards, lake claims, assassination or an unknown proposal', () => {
    expect(spotContext(GAME, { type: 'quest', seat: 7, round: 2, agent: 'fail' })).toBeNull();
    expect(spotContext(GAME, { type: 'assassinate', seat: 4, round: 3, agent: '6' })).toBeNull();
    expect(spotContext(GAME, { type: 'vote', seat: 5, round: 5, attempt: 1, agent: 'approve' })).toBeNull();
  });
});
