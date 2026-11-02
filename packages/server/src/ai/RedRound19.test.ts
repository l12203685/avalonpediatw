/**
 * 優化迴圈第 19 回合・紅方（刺客）候選，預設關：刺客不把「照派成功的隊」當成非梅林的證據（`assassinReuseRead`）；
 * 第 1 局藏牌的刺客在自己那一隊被照派時再藏一次（`redHideReuse`）。
 */
import { describe, expect, it } from 'vitest';
import type { PlayerObservation, VoteRecord } from './types';
import { DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING, parseTuningFlag } from './AgentTuning';
import { redHideReuseCard } from './RedRound2';
import { missedReuseLeads, successfulTeamReuse, visibleRedEvidence, withoutReuseLeaders } from './assassin/VisibleRedProposals';
import { merlinLeadLogRatio } from './assassin/MerlinLeadRead';

const IDS = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);

describe('flags', () => {
  it('parse; legacy off, assassinReuseRead=3 by default', () => {
    expect(parseTuningFlag('assassinReuseRead=2')).toEqual({ assassinReuseRead: 2 });
    expect(() => parseTuningFlag("assassinReuseRead=9")).toThrow();
    expect(parseTuningFlag('redHideReuse=0.5')).toEqual({ redHideReuse: 0.5 });
    expect(() => parseTuningFlag('redHideReuse=2')).toThrow();
    expect(LEGACY_AGENT_TUNING.assassinReuseRead).toBe(0);
    expect(DEFAULT_AGENT_TUNING.assassinReuseRead).toBe(3); // adopted in round 19 (1, then 3)
    expect(DEFAULT_AGENT_TUNING.redHideReuse).toBe(0);
    expect(LEGACY_AGENT_TUNING.redHideReuse).toBe(0);
  });
});

// Assassin P1 (hid on R1), Morgana P2, Mordred P8, Oberon P9. R1 P1 P4 P5 succeeded; R2 failed; at R3 P4 re-proposed
// P1 P4 P5 + P6 (the reuse), P7 proposed P1 P6 P7 P10 (a seen red, no successful team on it).
function assassination(extra: VoteRecord[] = []): PlayerObservation {
  const vote = (round: number, attempt: number, leader: string, team: string[], approved = false): VoteRecord =>
    ({ round, attempt, leader, team, approved, votes: {} }) as unknown as VoteRecord;
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

describe('assassinReuseRead', () => {
  const obs = assassination();
  it('successfulTeamReuse: the whole successful team with its seen red, R3+, non-forced, red short of two fails', () => {
    expect(successfulTeamReuse(obs, obs.voteHistory[3])).toBe(true);
    expect(successfulTeamReuse(obs, obs.voteHistory[2])).toBe(false); // seen red, no successful team on it
    expect(successfulTeamReuse(obs, obs.voteHistory[4])).toBe(false); // clean: left to the reads
    expect(successfulTeamReuse(obs, { ...obs.voteHistory[3], attempt: 5 })).toBe(false); // forced
    expect(successfulTeamReuse(obs, { ...obs.voteHistory[3], team: ['P1', 'P4', 'P5', 'P9'] })).toBe(false); // Oberon from outside
  });
  it('the visible-red tier skips the re-proposal only when asked', () => {
    const cands = ['P3', 'P4', 'P5', 'P6', 'P7', 'P10'];
    expect(visibleRedEvidence(obs, cands, true).get('P4')?.tier).toBe(1);
    expect(visibleRedEvidence(obs, cands, true, true).get('P4')?.tier).toBe(0);
    expect(visibleRedEvidence(obs, cands, true, true).get('P7')?.tier).toBe(1);
  });
  it('the lead read drops the re-proposal from the evidence', () => {
    const reds = ['P1', 'P2', 'P8', 'P9'];
    expect(merlinLeadLogRatio(obs, 'P4', reds, {}, false)).toBeLessThan(0);
    expect(merlinLeadLogRatio(obs, 'P4', reds, {}, true)).toBe(0); // no other lead
  });
  it('mode 3 counts the leads that passed over the re-proposal Merlin\u2019s norm makes', () => {
    expect(missedReuseLeads(obs, 'P4')).toBe(0); // the re-proposal itself
    expect(missedReuseLeads(obs, 'P7')).toBe(1); // R3 without the successful R1 team
    expect(missedReuseLeads(obs, 'P5')).toBe(1); // R4 without the latest success (R3, the assassin on it)
    expect(missedReuseLeads(obs, 'P6')).toBe(1); // R2 without the successful R1 team
    expect(missedReuseLeads(obs, 'P3')).toBe(0); // R1 lead: nothing to re-propose
  });
  it('mode 2 unattributes only blue captains’ re-proposals for the model', () => {
    const red = assassination([{ round: 4, attempt: 2, leader: 'P2', team: ['P1', 'P4', 'P5', 'P6', 'P2'], approved: false, votes: {} } as unknown as VoteRecord]);
    const m = withoutReuseLeaders(red, new Set(['P1', 'P2', 'P8', 'P9']));
    expect(m.voteHistory[3].leader).toBe('');
    expect(m.voteHistory[2].leader).toBe('P7');
    expect(m.voteHistory[5].leader).toBe('P2');
  });
});

describe('redHideReuse', () => {
  const quest = (partial: Partial<PlayerObservation> = {}): PlayerObservation => ({
    myPlayerId: 'P1', myRole: 'assassin', myTeam: 'evil', playerCount: 10, allPlayerIds: IDS, knownEvils: ['P1', 'P2', 'P8'],
    currentRound: 3, gamePhase: 'quest_vote', proposedTeam: ['P1', 'P4', 'P5', 'P6'], questResults: ['success', 'fail'],
    questHistory: [
      { round: 1, team: ['P1', 'P4', 'P5'], result: 'success', failCount: 0 },
      { round: 2, team: ['P2', 'P3', 'P6', 'P10'], result: 'fail', failCount: 1 },
    ],
    voteHistory: [], lakeHistory: [], ...partial,
  }) as unknown as PlayerObservation;
  const on = { ...DEFAULT_AGENT_TUNING, redHideReuse: 1 };
  it('off by default; the assassin hides on his re-proposed successful team', () => {
    expect(redHideReuseCard(DEFAULT_AGENT_TUNING, quest())).toBeNull();
    expect(redHideReuseCard(on, quest())).toBe('success');
  });
  it('not for other reds, not with a seen teammate, not on a different team, not when red or blue has two', () => {
    expect(redHideReuseCard(on, quest({ myRole: 'morgana' } as Partial<PlayerObservation>))).toBeNull();
    expect(redHideReuseCard(on, quest({ proposedTeam: ['P1', 'P2', 'P4', 'P5'] }))).toBeNull();
    expect(redHideReuseCard(on, quest({ proposedTeam: ['P1', 'P4', 'P6', 'P7'] }))).toBeNull();
    expect(redHideReuseCard(on, quest({ currentRound: 2 }))).toBeNull();
    expect(redHideReuseCard(on, quest({ currentRound: 4, questResults: ['success', 'fail', 'fail'] }))).toBeNull();
    expect(redHideReuseCard(on, quest({ currentRound: 4, questResults: ['success', 'fail', 'success'] }))).toBeNull();
  });
});
