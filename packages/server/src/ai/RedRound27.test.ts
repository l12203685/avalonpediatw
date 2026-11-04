/**
 * 優化迴圈第 27 回合・紅方：機器人紅方往強者紅方收斂——第 4 局落單的紅藏牌（`redHideR4Solo`）、第 1、2 局照強者比例藏牌（`redHideHuman`）、
 * 投票照強者紅方的同局面比例（`redHumanVote`，違反紅方利益的改投只在那一票不會決定時）、莫德雷德「只有那一白會決定時才白」（`redMatchPointApprove=3`）、
 * 紅方持湖照忠臣挑目標（`redLakeLoyal`）。
 */
import { describe, expect, it } from 'vitest';
import type { AgentTuning } from './AgentTuning';
import type { PlayerObservation } from './types';
import { DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING, parseTuningFlag } from './AgentTuning';
import { HeuristicAgent } from './HeuristicAgent';
import { ForwardAgent } from './forward/ForwardAgent';
import { withSeededRandom } from './benchmark/agreement';
import {
  HUMAN_HIDE_RATE, HUMAN_VOTE_FLIP, approveDecisive, humanVoteCell, othersApprovalEstimate, redHideHumanCard, redHideR4SoloCard,
  redHumanVoteFlip, redInterestVote, redMatchPointDecisiveApprove, voteNotDecisive,
} from './RedRound27';
import { redMatchPointApprove } from './RedRound25';
import { pickLakeTargetForTeam } from './LakePolicy';
import { merlinVoteLogRatio } from './assassin/MerlinVoteRead';

const IDS = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
const T = (over: Partial<AgentTuning> = {}): AgentTuning => ({ ...DEFAULT_AGENT_TUNING, ...over });
const agentOf = (id: string, t: AgentTuning): ForwardAgent => new ForwardAgent(id, new HeuristicAgent(id, undefined, undefined, t));

// Assassin P1 (teammates P2 morgana-side, P8 Mordred; Oberon P9 unseen). R4 team of five needs two fail cards.
function r4(over: Partial<PlayerObservation> = {}): PlayerObservation {
  return {
    myPlayerId: 'P1', myRole: 'assassin', myTeam: 'evil', playerCount: 10, allPlayerIds: IDS, knownEvils: ['P2', 'P8'],
    currentRound: 4, currentLeader: 'P5', gamePhase: 'quest_vote', failCount: 0,
    questResults: ['fail', 'success', 'fail'],
    questHistory: [
      { round: 1, team: ['P1', 'P4', 'P5'], result: 'fail', failCount: 1 },
      { round: 2, team: ['P3', 'P4', 'P6', 'P7'], result: 'success', failCount: 0 },
      { round: 3, team: ['P2', 'P5', 'P6', 'P7'], result: 'fail', failCount: 1 },
    ],
    voteHistory: [], proposedTeam: ['P1', 'P3', 'P4', 'P5', 'P6'], lakeHistory: [], myLakeResults: [],
    ...over,
  } as unknown as PlayerObservation;
}

describe('flags', () => {
  it('round 27 adopts redHideHuman + redHideR4Solo=1; the other knobs default off (all off in the legacy table)', () => {
    expect(DEFAULT_AGENT_TUNING.redHideHuman).toBe(true);
    expect(DEFAULT_AGENT_TUNING.redHideR4Solo).toBe(1);
    expect(LEGACY_AGENT_TUNING.redHideHuman).toBe(false);
    expect(LEGACY_AGENT_TUNING.redHideR4Solo).toBe(0);
    for (const t of [DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING]) {
      expect(t.redHumanVote).toBe(0);
      expect(t.redLakeLoyal).toBe(false);
      expect(t.oberonSelfOnTeam).toBe(false);
    }
  });
  it('parse the ranges', () => {
    expect(parseTuningFlag('redHideR4Solo')).toEqual({ redHideR4Solo: 1 });
    expect(parseTuningFlag('redHideR4Solo=3')).toEqual({ redHideR4Solo: 3 });
    expect(() => parseTuningFlag('redHideR4Solo=4')).toThrow();
    expect(parseTuningFlag('redHumanVote=2')).toEqual({ redHumanVote: 2 });
    expect(() => parseTuningFlag('redHumanVote=4')).toThrow();
    expect(parseTuningFlag('redHideHuman')).toEqual({ redHideHuman: true });
    expect(parseTuningFlag('redLakeLoyal')).toEqual({ redLakeLoyal: true });
    expect(parseTuningFlag('redMatchPointApprove=3')).toEqual({ redMatchPointApprove: 3 });
    expect(() => parseTuningFlag('redMatchPointApprove=4')).toThrow();
  });
});

describe('redHideR4Solo', () => {
  it('mode 1: the lone red it sees hides on R4 while red is at match point (blue below two wins)', () => {
    expect(redHideR4SoloCard(T({ redHideR4Solo: 1 }), r4())).toBe('success');
    expect(redHideR4SoloCard(T({ redHideR4Solo: 0 }), r4())).toBeNull();
  });
  it('mode 1 not at blue match point (the mission passing ends the game); mode 2 there too', () => {
    const blue2 = r4({ questResults: ['success', 'success', 'fail'] });
    expect(redHideR4SoloCard(T({ redHideR4Solo: 1 }), blue2)).toBeNull();
    expect(redHideR4SoloCard(T({ redHideR4Solo: 2 }), blue2)).toBe('success');
  });
  it('not with a teammate it sees on the team, not on a one-fail mission, Oberon included (he sees nobody)', () => {
    const on = T({ redHideR4Solo: 2 });
    expect(redHideR4SoloCard(on, r4({ proposedTeam: ['P1', 'P2', 'P4', 'P5', 'P6'] }))).toBeNull();
    expect(redHideR4SoloCard(on, r4({ currentRound: 3, proposedTeam: ['P1', 'P4', 'P5', 'P6'] }))).toBeNull();
    expect(redHideR4SoloCard(on, r4({ myPlayerId: 'P9', myRole: 'oberon', knownEvils: [], proposedTeam: ['P2', 'P3', 'P4', 'P5', 'P9'] }))).toBe('success');
  });
  it('mode 3 is a deterministic half of mode 1', () => {
    const on = T({ redHideR4Solo: 3 });
    const teams = [['P1', 'P3', 'P4', 'P5', 'P6'], ['P1', 'P3', 'P4', 'P5', 'P7'], ['P1', 'P3', 'P4', 'P6', 'P7'], ['P1', 'P3', 'P5', 'P6', 'P7'],
      ['P1', 'P4', 'P5', 'P6', 'P7'], ['P1', 'P3', 'P4', 'P5', 'P10'], ['P1', 'P3', 'P4', 'P6', 'P10'], ['P1', 'P5', 'P6', 'P7', 'P10']];
    const cards = teams.map((t) => redHideR4SoloCard(on, r4({ proposedTeam: t })));
    expect(cards).toEqual(teams.map((t) => redHideR4SoloCard(on, r4({ proposedTeam: t }))));
    expect(cards.some((c) => c === 'success')).toBe(true);
    expect(cards.some((c) => c === null)).toBe(true);
  });
  it('ForwardAgent plays the hide card; with the knob off it fails', () => {
    expect(withSeededRandom('r27-r4', () => agentOf('P1', T({ redHideR4Solo: 1 })).act(r4()))).toEqual({ type: 'quest_vote', vote: 'success' });
    expect(withSeededRandom('r27-r4', () => agentOf('P1', T({ redHideR4Solo: 0 })).act(r4()))).toEqual({ type: 'quest_vote', vote: 'fail' });
  });
});

describe('redHideHuman', () => {
  const r1 = (over: Partial<PlayerObservation> = {}): PlayerObservation => r4({
    currentRound: 1, questResults: [], questHistory: [], proposedTeam: ['P1', 'P4', 'P5'], ...over,
  });
  it('applies to the lone red it sees on R1–R2 only', () => {
    const on = T({ redHideHuman: true });
    expect(redHideHumanCard(on, r1())).not.toBeNull();
    expect(redHideHumanCard(T({ redHideHuman: false }), r1())).toBeNull();
    expect(redHideHumanCard(on, r1({ proposedTeam: ['P1', 'P2', 'P5'] }))).toBeNull();
    expect(redHideHumanCard(on, r4())).toBeNull();
  });
  it('the R1 hide share follows the strong human rate of the role (hash over teams)', () => {
    const on = T({ redHideHuman: true });
    for (const [role, me] of [['assassin', 'P1'], ['mordred', 'P8'], ['oberon', 'P9']] as const) {
      let hide = 0;
      let n = 0;
      for (let a = 2; a <= 10; a++) for (let b = a + 1; b <= 10; b++) {
        const team = [me, `P${a}`, `P${b}`];
        if (new Set(team).size < 3 || team.some((id) => id !== me && ['P1', 'P2', 'P8'].includes(id) && role !== 'oberon')) continue;
        const obs = r1({ myPlayerId: me, myRole: role, knownEvils: role === 'oberon' ? [] : ['P1', 'P2', 'P8'].filter((x) => x !== me), proposedTeam: team });
        const card = redHideHumanCard(on, obs);
        if (card === null) continue;
        n++;
        if (card === 'success') hide++;
      }
      expect(Math.abs(hide / n - HUMAN_HIDE_RATE[role][0])).toBeLessThan(0.17);
    }
  });
  it('supersedes mordredHideR1 (the lone Mordred no longer always hides)', () => {
    const on = T({ redHideHuman: true });
    const cards = ['P3', 'P4', 'P5', 'P6', 'P7'].flatMap((x) => ['P10', 'P9'].map((y) => {
      const obs = r1({ myPlayerId: 'P8', myRole: 'mordred', knownEvils: ['P1', 'P2'], proposedTeam: ['P8', x, y] });
      return withSeededRandom('r27-hh', () => agentOf('P8', on).act(obs));
    }));
    expect(cards.some((c) => c.type === 'quest_vote' && c.vote === 'fail')).toBe(true);
  });
});

// Assassin P1 off an R3 team; blue has two wins (the team passing sends the game to the assassination).
function blueTwo(over: Partial<PlayerObservation> = {}): PlayerObservation {
  return {
    myPlayerId: 'P1', myRole: 'assassin', myTeam: 'evil', playerCount: 10, allPlayerIds: IDS, knownEvils: ['P2', 'P8'],
    currentRound: 3, currentLeader: 'P5', gamePhase: 'team_vote', failCount: 0,
    questResults: ['success', 'success'],
    questHistory: [
      { round: 1, team: ['P3', 'P4', 'P5'], result: 'success', failCount: 0 },
      { round: 2, team: ['P3', 'P4', 'P6', 'P7'], result: 'success', failCount: 0 },
    ],
    voteHistory: [], proposedTeam: ['P3', 'P4', 'P5', 'P6'], lakeHistory: [], myLakeResults: [],
    ...over,
  } as unknown as PlayerObservation;
}

describe('redHumanVote', () => {
  it('cells: round, on/off the team, a teammate it sees on the team, score; none for the leader or the forced fifth', () => {
    expect(humanVoteCell(blueTwo())).toBe('R|R3|隊外|沒隊友|藍兩勝');
    expect(humanVoteCell(blueTwo({ proposedTeam: ['P1', 'P2', 'P5', 'P6'], questResults: ['fail', 'fail'] }))).toBe('R|R3|隊上|有隊友|紅兩勝');
    expect(humanVoteCell(blueTwo({ myPlayerId: 'P9', myRole: 'oberon', knownEvils: [] }))).toBe('O|R3|隊外|沒隊友|藍兩勝');
    expect(humanVoteCell(blueTwo({ currentLeader: 'P1' }))).toBeNull();
    expect(humanVoteCell(blueTwo({ failCount: 4 }))).toBeNull();
    expect(HUMAN_VOTE_FLIP['R|R3|隊外|沒隊友|藍兩勝']).toBeGreaterThan(0.5);
  });
  it("red's interest: its known reds can fail the team", () => {
    expect(redInterestVote(blueTwo())).toBe(false);
    expect(redInterestVote(blueTwo({ proposedTeam: ['P2', 'P4', 'P5', 'P6'] }))).toBe(true);
    expect(redInterestVote(r4({ gamePhase: 'team_vote', proposedTeam: ['P1', 'P3', 'P4', 'P5', 'P6'] }))).toBe(false);
    expect(redInterestVote(r4({ gamePhase: 'team_vote', proposedTeam: ['P1', 'P2', 'P4', 'P5', 'P6'] }))).toBe(true);
  });
  it('the vote estimate: leader yes, on-team blues by their posterior threshold, off-team blues no', () => {
    expect(othersApprovalEstimate(T({ goodCleanVote: 1e-9 }), blueTwo())).toBe(4);
    expect(othersApprovalEstimate(T({ goodCleanVote: 1 }), blueTwo())).toBe(1);
    expect(voteNotDecisive(T({ goodCleanVote: 1 }), blueTwo())).toBe(true);
    expect(voteNotDecisive(T({ goodCleanVote: 1e-9 }), blueTwo())).toBe(false);
    // R1–R2: every on-team seat approves.
    expect(othersApprovalEstimate(T(), blueTwo({ currentRound: 2, questResults: ['success'] }))).toBe(4);
  });
  it('a flip against red interest only when the vote cannot decide; deterministic', () => {
    const variants = [0, 1, 2, 3].flatMap((fc) => [['P3', 'P4', 'P5', 'P6'], ['P3', 'P4', 'P5', 'P7'], ['P4', 'P5', 'P6', 'P7'], ['P3', 'P5', 'P6', 'P10']]
      .map((team) => blueTwo({ failCount: fc, proposedTeam: team })));
    const safe = T({ redHumanVote: 1, goodCleanVote: 1 });
    const decisive = T({ redHumanVote: 1, goodCleanVote: 1e-9 });
    const flips = variants.map((o) => redHumanVoteFlip(safe, o, false));
    expect(flips.filter(Boolean).length).toBeGreaterThan(4);
    expect(flips.filter((x) => !x).length).toBeGreaterThan(0);
    expect(variants.map((o) => redHumanVoteFlip(safe, o, false))).toEqual(flips);
    expect(variants.every((o) => redHumanVoteFlip(decisive, o, false) === false)).toBe(true);
    // Oberon cells are mode 2.
    expect(redHumanVoteFlip(T({ redHumanVote: 1 }), blueTwo({ myPlayerId: 'P9', myRole: 'oberon', knownEvils: [] }), false)).toBe(false);
  });
  it('ForwardAgent: the knob changes some red votes, never the leader own-proposal white', () => {
    const t = T({ redHumanVote: 1, goodCleanVote: 1 });
    const variants = [0, 1, 2, 3].flatMap((fc) => [['P3', 'P4', 'P5', 'P6'], ['P3', 'P4', 'P5', 'P7'], ['P4', 'P5', 'P6', 'P7']].map((team) => blueTwo({ failCount: fc, proposedTeam: team })));
    const votes = variants.map((o) => withSeededRandom('r27-hv', () => agentOf('P1', t).act(o)));
    expect(votes.some((v) => v.type === 'team_vote' && v.vote)).toBe(true);
    const lead = blueTwo({ currentLeader: 'P1', proposedTeam: ['P1', 'P3', 'P4', 'P5'] });
    expect(withSeededRandom('r27-hv', () => agentOf('P1', t).act(lead))).toEqual({ type: 'team_vote', vote: true });
  });
});

describe('redMatchPointApprove=3', () => {
  // Mordred P8 on an R3 team after two fails (as in RedRound25.test).
  const mp = (over: Partial<PlayerObservation> = {}): PlayerObservation => ({
    myPlayerId: 'P8', myRole: 'mordred', myTeam: 'evil', playerCount: 10, allPlayerIds: IDS, knownEvils: ['P1', 'P2'],
    currentRound: 3, currentLeader: 'P5', gamePhase: 'team_vote', failCount: 0, questResults: ['fail', 'fail'],
    questHistory: [], voteHistory: [], proposedTeam: ['P3', 'P5', 'P6', 'P8'], lakeHistory: [], myLakeResults: [],
    ...over,
  }) as unknown as PlayerObservation;
  it('white only when the white may decide; mode 1 path stays off for mode 3', () => {
    // leader P5 + teammates P1, P2 (known red on the team at red match point) + P3, P6 by the key threshold.
    expect(approveDecisive(T({ goodKeyVote: 1e-9 }), mp())).toBe(true);
    expect(redMatchPointDecisiveApprove(T({ redMatchPointApprove: 3, goodKeyVote: 1e-9 }), mp())).toBe(true);
    expect(redMatchPointDecisiveApprove(T({ redMatchPointApprove: 3, goodKeyVote: 1 }), mp())).toBe(false);
    expect(redMatchPointApprove(T({ redMatchPointApprove: 3 }), mp())).toBe(false);
    expect(redMatchPointDecisiveApprove(T({ redMatchPointApprove: 1, goodKeyVote: 1e-9 }), mp())).toBe(false);
    expect(redMatchPointDecisiveApprove(T({ redMatchPointApprove: 3, goodKeyVote: 1e-9 }), mp({ questResults: ['fail', 'success'] }))).toBe(false);
  });
});

describe('redLakeLoyal', () => {
  it('the red holder picks what a public-view loyal in its seat would', () => {
    const obs = {
      ...r4({ gamePhase: 'lake' as never, currentRound: 2, questResults: ['fail', 'success'] }),
      questHistory: [
        { round: 1, team: ['P1', 'P4', 'P5'], result: 'fail', failCount: 1 },
        { round: 2, team: ['P3', 'P4', 'P6', 'P7'], result: 'success', failCount: 0 },
      ],
    } as PlayerObservation;
    const valid = IDS.filter((id) => id !== 'P1' && id !== 'P10');
    const t = T({ redLakeLoyal: true });
    const loyal = { ...obs, myRole: 'loyal', myTeam: 'good', knownEvils: [], knownWizards: undefined, allEvilIds: undefined, publicLoyalView: true } as PlayerObservation;
    expect(pickLakeTargetForTeam('evil', obs, valid, t)).toBe(pickLakeTargetForTeam('good', loyal, valid, t));
  });
});

describe('assassinVoteModel=4 (round-26 generic-blue rates)', () => {
  const REDS = ['P1', 'P2', 'P3', 'P4'];
  const v = (team: string[], yes: string[]) => ({ round: 3, attempt: 1, leader: team[0], team, approved: true, votes: Object.fromEntries(IDS.map((id) => [id, yes.includes(id)])) });
  const base = {
    myPlayerId: 'P1', myRole: 'assassin', myTeam: 'evil', playerCount: 10, allPlayerIds: IDS, knownEvils: ['P2', 'P3'], allEvilIds: REDS,
    allEvilRoles: { P1: 'assassin', P2: 'morgana', P3: 'mordred', P4: 'oberon' }, currentRound: 5, gamePhase: 'assassination',
    questHistory: [], lakeHistory: [], questResults: ['success', 'fail', 'success', 'success'],
  };
  it('the flag maps to the round-26 rates: an off-team approve of a seen-red team rules Merlin out a bit less than round 13', () => {
    const o = { ...base, voteHistory: [v(['P1', 'P6', 'P7', 'P8'], ['P1', 'P5', 'P6', 'P7', 'P8'])] } as unknown as PlayerObservation;
    // generic blue approves 3.8% (round 13: 7.2%) — the approve is rarer for a blue too, so the ratio falls less.
    expect(merlinVoteLogRatio(o, 'P5', REDS, 'normalFit26')).toBeGreaterThan(merlinVoteLogRatio(o, 'P5', REDS, 'normalFit13'));
    expect(merlinVoteLogRatio(o, 'P5', REDS, 'normalFit26')).toBeLessThan(0);
    expect(parseTuningFlag('assassinVoteModel=4')).toEqual({ assassinVoteModel: 4 });
  });
});

describe('oberonSelfOnTeam', () => {
  it('Oberon on an R3+ team counts himself as a red on it: the knob turns his on-team rejects into approves', () => {
    const obs = (team: string[]) => blueTwo({ myPlayerId: 'P9', myRole: 'oberon', knownEvils: [], questResults: ['fail', 'success'], proposedTeam: team });
    const teams = [['P3', 'P4', 'P5', 'P9'], ['P3', 'P6', 'P5', 'P9'], ['P4', 'P6', 'P5', 'P9'], ['P5', 'P6', 'P7', 'P9'], ['P5', 'P7', 'P10', 'P9']];
    const on = teams.map((t) => withSeededRandom('r27-ost', () => agentOf('P9', T({ oberonSelfOnTeam: true })).act(obs(t))));
    expect(on.every((a) => a.type === 'team_vote' && a.vote)).toBe(true);
    const off = teams.map((t) => withSeededRandom('r27-ost', () => agentOf('P9', T()).act(obs(t))));
    expect(off.some((a) => a.type === 'team_vote' && !a.vote)).toBe(true);
    expect(parseTuningFlag('oberonSelfOnTeam')).toEqual({ oberonSelfOnTeam: true });
  });
});
