/**
 * 第 54 回合（網站玩家回報 2026-11-19）：梅林不把出過失敗任務、他看得到的紅放上隊（`merlinKnownRed54`），
 * 忠臣／派西不每次整隊照派失敗過的照派（`failedReuse54`），以及真人局重播的特徵（`benchmark/knownRed54.ts`）。預設都關。
 */
import { describe, expect, it } from 'vitest';
import type { AgentTuning } from './AgentTuning';
import type { PlayerObservation } from './types';
import { DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING, parseTuningFlag } from './AgentTuning';
import { failedReuseBreakTeam54, failedReuseCores, merlinBarredReds54, merlinReuseTainted54, seenRedsOnFailedMissions } from './Round54';
import { merlinReuseNormTeam } from './MerlinLoyalStyle';
import { contaminatedSuccessTeams, knownRedFeatures } from './benchmark/knownRed54';
import { HeuristicAgent } from './HeuristicAgent';
import { ForwardAgent } from './forward/ForwardAgent';
import { withSeededRandom } from './benchmark/agreement';
import { buildReplayObservation, seatId, seatOfId } from './benchmark/replayObservation';
import type { ReplayGame, ReplayProposal } from './benchmark/sheetsReplay';

const IDS = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
// The default holds merlinKnownRed54=7 (site owner 2026-11-19); these tests start from the switch off.
const T = (over: Partial<AgentTuning> = {}): AgentTuning => ({ ...DEFAULT_AGENT_TUNING, merlinKnownRed54: 0, ...over });

/** 回報的那一局在第 3 局的局面：第 1 局 P4 P5 P7 成功、第 2 局 P4 P5 P7 P10 失敗一張；梅林 P2 看得到 P3 P5 P8（P7 是莫德雷德）。 */
function r3(over: Partial<PlayerObservation> = {}): PlayerObservation {
  return {
    myPlayerId: 'P2', myRole: 'merlin', myTeam: 'good', seatTeam: 'good', playerCount: 10, allPlayerIds: IDS, knownEvils: ['P3', 'P5', 'P8'],
    currentRound: 3, currentLeader: 'P2', gamePhase: 'team_select', failCount: 1, questResults: ['success', 'fail'],
    questHistory: [
      { round: 1, team: ['P4', 'P5', 'P7'], result: 'success', failCount: 0 },
      { round: 2, team: ['P4', 'P5', 'P7', 'P10'], result: 'fail', failCount: 1 },
    ],
    voteHistory: [], lakeHistory: [], myLakeResults: [], proposedTeam: [],
    ...over,
  } as unknown as PlayerObservation;
}

describe('round 54 flags', () => {
  it('exist, off in the legacy table, parse', () => {
    expect(LEGACY_AGENT_TUNING.merlinKnownRed54).toBe(0);
    expect(DEFAULT_AGENT_TUNING.merlinKnownRed54).toBe(7); // round 54 adopted by the site owner 2026-11-19 (confirmation passed)
    expect(LEGACY_AGENT_TUNING.failedReuse54).toBe(0);
    expect(DEFAULT_AGENT_TUNING.failedReuse54).toBe(0);
    expect(parseTuningFlag('merlinKnownRed54')).toEqual({ merlinKnownRed54: 3 });
    expect(parseTuningFlag('merlinKnownRed54=1')).toEqual({ merlinKnownRed54: 1 });
    expect(parseTuningFlag('failedReuse54')).toEqual({ failedReuse54: 2 });
    expect(parseTuningFlag('merlinKnownRed54=5')).toEqual({ merlinKnownRed54: 5 });
    expect(() => parseTuningFlag('merlinKnownRed54=8')).toThrow();
    expect(() => parseTuningFlag('failedReuse54=4')).toThrow();
  });
});

describe('failedReuseCores / seenRedsOnFailedMissions', () => {
  it('a successful team that sat whole on a later failed mission', () => {
    expect(failedReuseCores(r3())).toEqual([['P4', 'P5', 'P7']]);
    // R2 failed without the whole R1 team: no core.
    expect(failedReuseCores(r3({ questHistory: [
      { round: 1, team: ['P4', 'P5', 'P7'], result: 'success', failCount: 0 },
      { round: 2, team: ['P4', 'P5', 'P6', 'P10'], result: 'fail', failCount: 1 },
    ] }))).toEqual([]);
  });
  it('Merlin: the seen reds that sat on a failed mission (not the unseen Mordred, nobody for a loyal)', () => {
    expect(seenRedsOnFailedMissions(r3())).toEqual(['P5']);
    expect(seenRedsOnFailedMissions(r3({ myRole: 'loyal', knownEvils: [] }))).toEqual([]);
  });
});

describe('merlinKnownRed54', () => {
  it('bit 1: no re-proposal of a successful team whose seen red sat on a later failed mission', () => {
    expect(merlinReuseTainted54(T(), r3(), ['P4', 'P5', 'P7'], 1)).toBe(false);
    expect(merlinReuseTainted54(T({ merlinKnownRed54: 1 }), r3(), ['P4', 'P5', 'P7'], 1)).toBe(true);
    // the default `merlinReuseNorm=3` re-proposes 457 + Merlin; with bit 1 it does not
    expect(merlinReuseNormTeam(T(), r3(), 4)).toEqual(['P2', 'P4', 'P5', 'P7']);
    expect(merlinReuseNormTeam(T({ merlinKnownRed54: 1 }), r3(), 4)).toBeNull();
    // bit 4: round 4 as before
    const r4 = r3({ currentRound: 4, questResults: ['success', 'fail', 'success'], questHistory: [...r3().questHistory, { round: 3, team: ['P1', 'P2', 'P6', 'P9'], result: 'success', failCount: 0 }] });
    expect(merlinReuseTainted54(T({ merlinKnownRed54: 1 }), r4, ['P4', 'P5', 'P7'], 1)).toBe(true);
    expect(merlinReuseTainted54(T({ merlinKnownRed54: 5 }), r4, ['P4', 'P5', 'P7'], 1)).toBe(false);
  });
  it('bit 2: R2, R3, R5 only (R4 needs two fails)', () => {
    expect(merlinBarredReds54(T({ merlinKnownRed54: 2 }), r3())).toEqual(['P5']);
    expect(merlinBarredReds54(T({ merlinKnownRed54: 1 }), r3())).toEqual([]);
    expect(merlinBarredReds54(T({ merlinKnownRed54: 2 }), r3({ currentRound: 4 }))).toEqual([]);
    expect(merlinBarredReds54(T({ merlinKnownRed54: 2 }), r3({ myRole: 'loyal' }))).toEqual([]);
    expect(merlinReuseNormTeam(T({ merlinKnownRed54: 2 }), r3(), 4)).toBeNull();
  });
});

describe('failedReuse54', () => {
  const loyal = r3({ myPlayerId: 'P1', myRole: 'loyal', knownEvils: [], currentLeader: 'P1', failCount: 0 });
  const share = new Map(IDS.map((id) => [id, id === 'P10' ? 0.9 : id === 'P7' ? 0.4 : id === 'P5' ? 0.3 : 0.2] as const));
  const outs = (): string[] => ['P6', 'P9', 'P3', 'P8'];
  it('1: the core member the posterior holds most red makes way for the first outsider that passes', () => {
    expect(failedReuseBreakTeam54(T(), loyal, ['P1', 'P4', 'P5', 'P7'], share, outs, () => true)).toBeNull();
    expect(failedReuseBreakTeam54(T({ failedReuse54: 1 }), loyal, ['P1', 'P4', 'P5', 'P7'], share, outs, () => true)).toEqual(['P1', 'P4', 'P5', 'P6']);
    // the gate refuses P6 in place of P7: the next outsider
    expect(failedReuseBreakTeam54(T({ failedReuse54: 1 }), loyal, ['P1', 'P4', 'P5', 'P7'], share, outs, (t) => !t.includes('P6'))).toEqual(['P1', 'P4', 'P5', 'P9']);
  });
  it('only a team holding the whole core, only a true loyal / Percival seat', () => {
    expect(failedReuseBreakTeam54(T({ failedReuse54: 1 }), loyal, ['P1', 'P4', 'P5', 'P6'], share, outs, () => true)).toBeNull();
    expect(failedReuseBreakTeam54(T({ failedReuse54: 1 }), { ...loyal, myRole: 'merlin' } as PlayerObservation, ['P1', 'P4', 'P5', 'P7'], share, outs, () => true)).toBeNull();
    expect(failedReuseBreakTeam54(T({ failedReuse54: 1 }), { ...loyal, seatTeam: 'evil' } as PlayerObservation, ['P1', 'P4', 'P5', 'P7'], share, outs, () => true)).toBeNull();
    expect(failedReuseBreakTeam54(T({ failedReuse54: 1 }), { ...loyal, myRole: 'percival' } as PlayerObservation, ['P1', 'P4', 'P5', 'P7'], share, outs, () => true)).not.toBeNull();
  });
  it('2 / 3: keeps the core on a hashed share of the situations (the same situation always the same)', () => {
    let kept2 = 0;
    let kept3 = 0;
    const n = 400;
    for (let i = 0; i < n; i++) {
      const o = { ...loyal, myPlayerId: IDS[i % 10], failCount: i % 4, currentRound: 3 } as PlayerObservation;
      const team = [IDS[i % 10], 'P4', 'P5', 'P7'].filter((x, k, a) => a.indexOf(x) === k);
      const t = team.length === 4 ? team : [...team, IDS[(i + 3) % 10] === 'P4' ? 'P9' : 'P6'];
      if (failedReuseBreakTeam54(T({ failedReuse54: 2 }), o, t, share, outs, () => true) === null) kept2++;
      if (failedReuseBreakTeam54(T({ failedReuse54: 3 }), o, t, share, outs, () => true) === null) kept3++;
      expect(failedReuseBreakTeam54(T({ failedReuse54: 2 }), o, t, share, outs, () => true)).toEqual(failedReuseBreakTeam54(T({ failedReuse54: 2 }), o, t, share, outs, () => true));
    }
    expect(kept2 / n).toBeGreaterThan(0.1);
    expect(kept2 / n).toBeLessThan(0.6);
    expect(kept3).toBeGreaterThan(kept2);
  });
});

describe('knownRedFeatures (replay)', () => {
  const quests = [{ round: 1, teamSeats: [4, 5, 7], failed: false }, { round: 2, teamSeats: [4, 5, 7, 10], failed: true }];
  const seen = new Set([3, 5, 8]);
  it('the reported game: 2457 holds a seen red from the failed re-proposal', () => {
    expect(contaminatedSuccessTeams(quests)).toEqual([[4, 5, 7]]);
    expect(knownRedFeatures([2, 4, 5, 7], quests, seen)).toEqual({
      seenOn: 1, seenFailedOn: true, seenContaminatedOn: true, reuseAny: true, reuseLast: true, reuseContaminated: true, lastFailOverlap: 3, lastFailSize: 4,
    });
    expect(knownRedFeatures([1, 2, 4, 7], quests, seen)).toMatchObject({ seenOn: 0, seenFailedOn: false, reuseContaminated: false, lastFailOverlap: 2 });
  });
});

/** 回報的那一局（座位 = 網站座位，10 = 0 家）：第 3 局梅林 2 家當隊長。 */
function reportedGame(): ReplayGame {
  const rounds = [
    [[1, 2, 3], [2, 6, 8], [3, 9, 10], [4, 1, 6], [4, 5, 7]],
    [[4, 5, 6, 7], [4, 5, 7, 1], [4, 5, 7, 8], [4, 5, 7, 9], [4, 5, 7, 10]],
    [[4, 5, 7, 1], [4, 5, 7, 9]],
  ];
  const went = new Set([4, 9]);
  const proposals: ReplayProposal[] = [];
  let g = 0;
  rounds.forEach((rp, ri) => rp.forEach((t, ai) => {
    const votes = Array.from({ length: 10 }, (_, k) => t.includes(k + 1));
    proposals.push({ round: ri + 1, attempt: ai + 1, globalIndex: g, leaderSeat: (g % 10) + 1, teamSeats: t, plusSeats: [], minusSeats: [], votes,
      approveCount: votes.filter(Boolean).length, forced: ai === 4, wentOnMission: went.has(g), votesReliable: ai < 4 });
    g++;
  }));
  return {
    id: 'R54', playerCount: 10, names: Array(10).fill(''), proposals,
    seatRoles: ['loyal', 'merlin', 'assassin', 'loyal', 'morgana', 'loyal', 'mordred', 'oberon', 'loyal', 'percival'],
    quests: [{ round: 1, teamSeats: [4, 5, 7], successCount: 3, failCount: 0, failed: false }, { round: 2, teamSeats: [4, 5, 7, 10], successCount: 3, failCount: 1, failed: true }],
    lakes: [{ round: 2, holderSeat: 10, targetSeat: 4, claim: 'good' }], lakeChainValid: true, winner: 'evil',
  } as unknown as ReplayGame;
}

function merlinTeamAt(tuning: AgentTuning): number[] {
  const game = reportedGame();
  const agent = new ForwardAgent(seatId(2), new HeuristicAgent(seatId(2), undefined, undefined, tuning));
  agent.onGameStart(buildReplayObservation(game, 2, { kind: 'team_select', proposal: 0 }));
  const obs = buildReplayObservation(game, 2, { kind: 'team_select', proposal: 11 });
  const a = withSeededRandom('R54|2|team-11', () => agent.act(obs));
  return a.type === 'team_select' ? a.teamIds.map(seatOfId) : [];
}

describe('the reported game, Merlin 2 at 3-2', () => {
  it('switch off: re-proposes 457 + himself (5 is a red he sees); merlinKnownRed54 (the default since 2026-11-19) drops the red he sees', () => {
    expect(merlinTeamAt(T()).sort((a, b) => a - b)).toEqual([2, 4, 5, 7]);
    expect(merlinTeamAt({ ...DEFAULT_AGENT_TUNING }).some((s) => [3, 5, 8].includes(s))).toBe(false);
    for (const bits of [1, 2, 3]) {
      const team = merlinTeamAt(T({ merlinKnownRed54: bits }));
      expect(team).toHaveLength(4);
      expect(team.some((s) => [3, 5, 8].includes(s))).toBe(false);
    }
  });
});
