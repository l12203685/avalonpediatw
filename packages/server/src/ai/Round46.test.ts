/**
 * 優化迴圈第 46 回合：第 45 回合診斷的六個候選裡新增的五個開關（預設關）。
 *   藍方：`beliefLakePick45`（湖的「挑誰來驗」概似）、`tailRedNoVouch45`（尾家外白不採用可疑持湖者對尾家的「藍」宣告）；
 *   紅方：`assassinTailRead45`（刺客讀強制局完全沒有紅的隊）、`redLeadOff45`（紅隊長第 3 局起以比例不放自己）、
 *   `redRankOrderR2Fix45`（位階法第 2 局莫甘娜出失敗）。
 */
import { describe, expect, it } from 'vitest';
import type { AgentTuning } from './AgentTuning';
import type { PlayerObservation } from './types';
import { DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING, describeAgentTuning, parseTuningFlag } from './AgentTuning';
import { HeuristicAgent } from './HeuristicAgent';
import { ForwardAgent } from './forward/ForwardAgent';
import { bayesOptionsOf, bayesRedShare } from './belief/BayesBelief';
import { withoutSuspectVouch } from './GoodVoteAlt';
import { TAIL_CLEAN_LOG_LR, redLeadOffNow, tailCleanLogRatio, teamWithoutSelf } from './RedRound46';

const IDS = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
const T = (over: Partial<AgentTuning> = {}): AgentTuning => ({ ...DEFAULT_AGENT_TUNING, ...over });
const KEYS = ['beliefLakePick45', 'tailRedNoVouch45', 'assassinTailRead45', 'redLeadOff45', 'redRankOrderR2Fix45'] as const;

// A loyal P3 voting in R3 after a 0:2 start. R1 (forced, P5's team) and R2 (forced, P10's team) failed; P10 held the first lake on P5
// and declared P5 blue.
function r3(over: Partial<PlayerObservation> = {}): PlayerObservation {
  return {
    myPlayerId: 'P3', myRole: 'loyal', myTeam: 'good', seatTeam: 'good', playerCount: 10, allPlayerIds: IDS, knownEvils: [],
    currentRound: 3, currentLeader: 'P1', gamePhase: 'team_vote', failCount: 0, questResults: ['fail', 'fail'],
    questHistory: [
      { round: 1, team: ['P5', 'P6', 'P7'], result: 'fail', failCount: 1 },
      { round: 2, team: ['P10', 'P8', 'P9', 'P2'], result: 'fail', failCount: 1 },
    ],
    voteHistory: [
      { round: 1, attempt: 5, leader: 'P5', team: ['P5', 'P6', 'P7'], approved: true, votes: {} },
      { round: 2, attempt: 5, leader: 'P10', team: ['P10', 'P8', 'P9', 'P2'], approved: true, votes: {} },
    ],
    lakeHistory: [{ round: 3, holderId: 'P10', targetId: 'P5', declaredClaim: 'good' }],
    myLakeResults: [], proposedTeam: ['P1', 'P3', 'P4', 'P6'],
    ...over,
  } as unknown as PlayerObservation;
}

describe('flags', () => {
  it('exist, are off in the legacy table, off in the default except tailRedNoVouch45 (0.5), and parse their ranges', () => {
    for (const k of KEYS) {
      expect(LEGACY_AGENT_TUNING[k]).toBe(0);
      expect(DEFAULT_AGENT_TUNING[k]).toBe(k === 'tailRedNoVouch45' ? 0.5 : 0); // round 46 tailRedNoVouch45=0.5 adopted (site owner 2026-11-18)
    }
    expect(parseTuningFlag('beliefLakePick45')).toEqual({ beliefLakePick45: 0.17 });
    expect(parseTuningFlag('tailRedNoVouch45')).toEqual({ tailRedNoVouch45: 0.5 });
    expect(parseTuningFlag('redLeadOff45')).toEqual({ redLeadOff45: 0.197 });
    expect(parseTuningFlag('assassinTailRead45=2')).toEqual({ assassinTailRead45: 2 });
    expect(parseTuningFlag('redRankOrderR2Fix45')).toEqual({ redRankOrderR2Fix45: 1 });
    expect(() => parseTuningFlag('beliefLakePick45=1')).toThrow();
    expect(() => parseTuningFlag('assassinTailRead45=3')).toThrow();
    expect(() => parseTuningFlag('redRankOrderR2Fix45=2')).toThrow();
    expect(describeAgentTuning(T({ beliefLakePick45: 0.17 }))).toContain('beliefLakePick45=0.17');
  });
});

describe('beliefLakePick45', () => {
  it('off: the options and the posterior are the default ones', () => {
    expect(bayesOptionsOf(T())).toEqual(bayesOptionsOf(DEFAULT_AGENT_TUNING));
    expect('lakePick' in bayesOptionsOf(T())).toBe(false);
  });
  it('a red holder who mostly inspects teammates makes the declared-blue target redder; at the strong-human rate (fewer than at random) bluer', () => {
    const obs = r3();
    const base = bayesRedShare(obs, bayesOptionsOf(T())).get('P5')!;
    const strong = bayesRedShare(r3(), bayesOptionsOf(T({ beliefLakePick45: 0.17 }))).get('P5')!;
    const bot = bayesRedShare(r3(), bayesOptionsOf(T({ beliefLakePick45: 0.82 }))).get('P5')!;
    expect(bot).toBeGreaterThan(base + 0.05);
    expect(strong).toBeLessThan(base);
    // the holder's own share is a joint matter; it stays a probability
    const holder = bayesRedShare(r3(), bayesOptionsOf(T({ beliefLakePick45: 0.82 }))).get('P10')!;
    expect(holder).toBeGreaterThan(0);
    expect(holder).toBeLessThan(1);
  });
  it('red seats keep their reading (red frozen)', () => {
    const red = r3({ myPlayerId: 'P4', myRole: 'assassin', myTeam: 'evil', seatTeam: 'evil', knownEvils: ['P6', 'P8'] });
    const a = bayesRedShare(red, bayesOptionsOf(T())).get('P5');
    const b = bayesRedShare({ ...red }, bayesOptionsOf(T({ beliefLakePick45: 0.82 }))).get('P5');
    expect(b).toBe(a);
  });
});

describe('tailRedNoVouch45', () => {
  it('drops the blue declaration on the tail only when the holder reads as likely red', () => {
    const obs = r3();
    const opts = bayesOptionsOf(T());
    expect(withoutSuspectVouch(obs, 'P5', 0, opts)).toBe(obs);
    const p10 = bayesRedShare(obs, opts).get('P10')!;
    const dropped = withoutSuspectVouch(obs, 'P5', Math.max(0.01, p10 - 0.01), opts);
    expect(dropped).not.toBe(obs);
    expect(dropped.lakeHistory![0].declaredClaim).toBe('none');
    expect(obs.lakeHistory![0].declaredClaim).toBe('good');
    expect(withoutSuspectVouch(obs, 'P5', Math.min(0.99, p10 + 0.01), opts)).toBe(obs);
    expect(withoutSuspectVouch(obs, 'P6', 0.01, opts)).toBe(obs); // nobody vouched for P6
  });
});

describe('assassinTailRead45', () => {
  const obs = {
    voteHistory: [
      { round: 1, attempt: 5, leader: 'P5', team: ['P5', 'P6', 'P7'], approved: true, votes: {} },
      { round: 3, attempt: 5, leader: 'P5', team: ['P5', 'P6', 'P7', 'P1'], approved: true, votes: {} },
      { round: 2, attempt: 5, leader: 'P10', team: ['P10', 'P8', 'P9', 'P2'], approved: true, votes: {} },
      { round: 3, attempt: 2, leader: 'P2', team: ['P2', 'P6', 'P7', 'P4'], approved: false, votes: {} },
    ],
  } as unknown as PlayerObservation;
  const reds = new Set(['P1', 'P8', 'P9', 'P4']);
  it('counts forced teams with no red at all; teams with a red and non-forced teams do not count', () => {
    expect(tailCleanLogRatio(obs, 'P5', reds, 1)).toBeCloseTo(TAIL_CLEAN_LOG_LR[1]);
    expect(tailCleanLogRatio(obs, 'P10', reds, 1)).toBe(0);
    expect(tailCleanLogRatio(obs, 'P2', reds, 2)).toBe(0);
    expect(tailCleanLogRatio(obs, 'P5', reds, 0)).toBe(0);
    expect(TAIL_CLEAN_LOG_LR[1]).toBeCloseTo(Math.log(0.535 / 0.381));
    expect(TAIL_CLEAN_LOG_LR[2]).toBeGreaterThan(TAIL_CLEAN_LOG_LR[1]);
  });
});

describe('redLeadOff45', () => {
  const lead = (over: Partial<PlayerObservation> = {}): PlayerObservation => r3({
    myPlayerId: 'P1', myRole: 'assassin', myTeam: 'evil', seatTeam: 'evil', knownEvils: ['P6', 'P8'], gamePhase: 'team_select',
    questResults: ['success', 'fail'], proposedTeam: [], ...over,
  });
  it('only red leaders (not Oberon), R3+, non-forced, red under two fails; deterministic', () => {
    const t = T({ redLeadOff45: 0.999 });
    expect(redLeadOffNow(t, lead())).toBe(true);
    expect(redLeadOffNow(T(), lead())).toBe(false);
    expect(redLeadOffNow(t, lead({ myRole: 'oberon' }))).toBe(false);
    expect(redLeadOffNow(t, lead({ currentRound: 2 }))).toBe(false);
    expect(redLeadOffNow(t, lead({ failCount: 4 }))).toBe(false);
    expect(redLeadOffNow(t, lead({ questResults: ['fail', 'fail'] }))).toBe(false);
    expect(redLeadOffNow(t, lead({ myTeam: 'good', myRole: 'loyal' }))).toBe(false);
    const half = T({ redLeadOff45: 0.5 });
    expect(redLeadOffNow(half, lead())).toBe(redLeadOffNow(half, lead()));
  });
  it('the team leaves the leader off, replaced by the cleanest outsider', () => {
    const share = new Map([['P2', 0.6], ['P4', 0.2], ['P7', 0.1], ['P9', 0.4], ['P10', 0.9], ['P5', 0.5], ['P6', 0.5], ['P8', 0.5]]);
    expect(teamWithoutSelf(lead(), ['P1', 'P3', 'P5', 'P6'], share)).toEqual(['P7', 'P3', 'P5', 'P6']);
    expect(teamWithoutSelf(lead(), ['P2', 'P3', 'P5', 'P6'], share)).toEqual(['P2', 'P3', 'P5', 'P6']);
  });
  it('in the pipeline: switch on → a legal team without the leader; switch off → the leader is on it', () => {
    const run = (t: AgentTuning): string[] => {
      const fa = new ForwardAgent('P1', new HeuristicAgent('P1', undefined, undefined, t));
      fa.onGameStart(lead());
      const a = fa.decide(lead()).action;
      if (a.type !== 'team_select') throw new Error(a.type);
      return a.teamIds;
    };
    const on = run(T({ redLeadOff45: 0.999 }));
    expect(on).toHaveLength(4);
    expect(new Set(on).size).toBe(4);
    expect(on).not.toContain('P1');
    expect(run(T())).toContain('P1');
  });
});

describe('redRankOrderR2Fix45', () => {
  // Morgana P2 with Mordred P3 on an R2 mission (the assassin P1 off it): the rank order has both hide on R2.
  const card = (t: AgentTuning, round: number): string => {
    const o = {
      myPlayerId: 'P2', myRole: 'morgana', myTeam: 'evil', playerCount: 10, allPlayerIds: IDS, knownEvils: ['P1', 'P3'],
      currentRound: round, currentLeader: 'P5', failCount: 0, gamePhase: 'quest_vote', proposedTeam: ['P2', 'P3', 'P5', 'P6'],
      questResults: ['success'], lakeHistory: [],
      voteHistory: [{ round, attempt: 1, leader: 'P5', team: ['P2', 'P3', 'P5', 'P6'], approved: true, votes: {} }],
      questHistory: [{ round: 1, team: ['P5', 'P6', 'P7'], result: 'success', failCount: 0 }],
    } as unknown as PlayerObservation;
    const fa = new ForwardAgent('P2', new HeuristicAgent('P2', undefined, undefined, t));
    fa.onGameStart(o);
    const a = fa.decide(o).action;
    if (a.type !== 'quest_vote') throw new Error(a.type);
    return a.vote;
  };
  it('off: Morgana observes on her first joint R2 mission; on: she fails (as on R3)', () => {
    expect(card(T(), 2)).toBe('success');
    expect(card(T({ redRankOrderR2Fix45: 1 }), 2)).toBe('fail');
  });
});
