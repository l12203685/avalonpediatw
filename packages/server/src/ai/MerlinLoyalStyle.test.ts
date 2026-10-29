/**
 * `merlinLoyalStyle` (Edward 2026-10-29): Merlin proposes the team a public-view loyal finds most plausible, never with
 * a red it sees.
 */
import { describe, expect, it } from 'vitest';
import type { PlayerObservation } from './types';
import { DEFAULT_AGENT_TUNING } from './AgentTuning';
import { merlinLoyalStyleTeam, merlinVoteCoverApprove, percivalLoyalStyleTeam } from './MerlinLoyalStyle';

const IDS = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
const ON = { ...DEFAULT_AGENT_TUNING, merlinLoyalStyle: true };
const obs = {
  myPlayerId: 'P1', myRole: 'merlin', myTeam: 'good', playerCount: 10, allPlayerIds: IDS, knownEvils: ['P4', 'P6', 'P9'],
  currentRound: 3, currentLeader: 'P1', failCount: 0, questResults: ['fail', 'success'], gamePhase: 'team_select',
  // R2 P2 P3 P5 P7 clean in public; R1 P4 P6 P8 one fail.
  questHistory: [
    { round: 1, team: ['P4', 'P6', 'P8'], result: 'fail', failCount: 1 },
    { round: 2, team: ['P2', 'P3', 'P5', 'P7'], result: 'success', failCount: 0 },
  ],
  voteHistory: [], proposedTeam: [], lakeHistory: [],
} as unknown as PlayerObservation;

describe('merlinLoyalStyle', () => {
  it('a team a loyal would send (the clean R2 seats), never a seen red', () => {
    const a = merlinLoyalStyleTeam(ON, obs, { type: 'team_select', teamIds: ['P1', 'P4', 'P8', 'P10'] });
    if (a.type !== 'team_select') throw new Error(a.type);
    expect(a.teamIds).toContain('P1');
    expect(a.teamIds.some((id) => ['P4', 'P6', 'P9'].includes(id))).toBe(false);
    expect(a.teamIds.filter((id) => ['P2', 'P3', 'P5', 'P7'].includes(id)).length).toBeGreaterThanOrEqual(2);
  });
  it('off / not Merlin: unchanged', () => {
    const t = { type: 'team_select' as const, teamIds: ['P1', 'P4', 'P8', 'P10'] };
    expect(merlinLoyalStyleTeam({ ...DEFAULT_AGENT_TUNING, merlinLoyalStyle: false }, obs, t)).toBe(t);
    expect(merlinLoyalStyleTeam(ON, { ...obs, myRole: 'loyal' } as PlayerObservation, t)).toBe(t);
  });
});

describe('percivalLoyalStyle (Edward 10/29: 信A/信B ± 派, or the AB intersection)', () => {
  // Thumbs P7 / P8; thumb P8 led an R3 team with both certain reds (P2, P3) → P8 reads as Morgana: trust P7.
  const pobs = {
    myPlayerId: 'P1', myRole: 'percival', myTeam: 'good', playerCount: 10, allPlayerIds: IDS, knownEvils: [],
    knownWizards: ['P7', 'P8'], currentRound: 4, currentLeader: 'P1', failCount: 0, questResults: ['fail', 'success', 'fail'],
    gamePhase: 'team_select', proposedTeam: [], lakeHistory: [],
    questHistory: [
      { round: 1, team: ['P1', 'P2', 'P3'], result: 'fail', failCount: 2 },
      { round: 2, team: ['P1', 'P4', 'P5', 'P6'], result: 'success', failCount: 0 },
      { round: 3, team: ['P8', 'P2', 'P3', 'P9'], result: 'fail', failCount: 2 },
    ],
    voteHistory: [{ round: 3, attempt: 1, leader: 'P8', team: ['P8', 'P2', 'P3', 'P9'], approved: true, votes: {} }],
  } as unknown as PlayerObservation;
  it('trusts the thumb whose information holds, never sends the certain reds', () => {
    const { action, plan } = percivalLoyalStyleTeam({ ...DEFAULT_AGENT_TUNING, percivalLoyalStyle: true }, pobs, { type: 'team_select', teamIds: ['P1', 'P2', 'P8', 'P9', 'P10'] });
    if (action.type !== 'team_select') throw new Error(action.type);
    expect(plan?.startsWith('信A')).toBe(true);
    expect(action.teamIds.some((id) => ['P2', 'P3', 'P8'].includes(id))).toBe(false);
  });
});

describe('merlinVoteCover (梅林只想裝雜魚)', () => {
  // R1 P2 P3 P5 and R2 P2 P3 P5 P7 both succeeded: in public the R2 team looks clean, but Merlin sees P7.
  const vobs = {
    myPlayerId: 'P1', myRole: 'merlin', myTeam: 'good', playerCount: 10, allPlayerIds: IDS, knownEvils: ['P4', 'P6', 'P7'],
    currentRound: 3, currentLeader: 'P2', failCount: 0, questResults: ['success', 'success'], gamePhase: 'team_vote',
    questHistory: [
      { round: 1, team: ['P2', 'P3', 'P5'], result: 'success', failCount: 0 },
      { round: 2, team: ['P2', 'P3', 'P5', 'P7'], result: 'success', failCount: 0 },
    ],
    voteHistory: [], proposedTeam: ['P2', 'P3', 'P5', 'P7'], lakeHistory: [],
  } as unknown as PlayerObservation;
  it('q = 1: approves the public-clean team with a seen red', () => {
    expect(merlinVoteCoverApprove({ ...DEFAULT_AGENT_TUNING, merlinVoteCover: 1 }, vobs)).toBe(true);
  });
  it('off, a team with no seen red, or a fail would be fatal: no cover', () => {
    const on = { ...DEFAULT_AGENT_TUNING, merlinVoteCover: 1 };
    expect(merlinVoteCoverApprove(DEFAULT_AGENT_TUNING, vobs)).toBe(false);
    expect(merlinVoteCoverApprove(on, { ...vobs, proposedTeam: ['P2', 'P3', 'P5', 'P8'] } as PlayerObservation)).toBe(false);
    expect(merlinVoteCoverApprove(on, { ...vobs, questResults: ['fail', 'fail'] } as PlayerObservation)).toBe(false);
    expect(merlinVoteCoverApprove(on, { ...vobs, failCount: 4 } as PlayerObservation)).toBe(false);
  });
});
