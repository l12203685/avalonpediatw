/**
 * 優化迴圈第 40 回合・藍方：投票門檻分局面、分角色（`vote40*`）、派西在只有一根拇指的隊上的票（`percivalThumbVote40`）、
 * 讀法放進派西自己的後驗（`percivalRead39=1`）、持湖者宣告的份量（`beliefLakeCal40`）、宣告紅的持湖者第 3 局不上隊（`loyalLakePair` 位元 2／8）、
 * 梅林照忠臣整條流程的隊只從第 2 局起（`merlinPublicPipeline=3`）、湖的位元 4 拿掉照座位的同分排序。全部預設關。
 */
import { describe, expect, it } from 'vitest';
import type { PlayerObservation } from './types';
import { DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING, parseTuningFlag } from './AgentTuning';
import { percivalThumbVote40, vote40Bar, vote40TailBar, voteCell40, voteRole40 } from './BlueRound40';
import { lakeHolderBarred40 } from './BlueRound39';
import { merlinPublicPipelineOn } from './MerlinLoyalStyle';
import { bayesOptionsOf, bayesRedShare } from './belief/BayesBelief';
import { percivalRead39 } from './BlueRound39Percival';

const IDS = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
const asObs = (o: object) => o as unknown as PlayerObservation;
const T = (over: object) => ({ ...DEFAULT_AGENT_TUNING, ...over });
const vote = (round: number, attempt: number, leader: string, team: string[], yes: string[]) => ({
  round, attempt, leader, team, approved: yes.length > 5, votes: Object.fromEntries(IDS.map((id) => [id, yes.includes(id)])),
});
const base = {
  myPlayerId: 'P10', myRole: 'loyal', myTeam: 'good', playerCount: 10, allPlayerIds: IDS, knownEvils: [], evilCount: 4,
  lakeHistory: [], myLakeResults: [], proposedTeam: [], failCount: 0,
};
const R1 = [
  vote(1, 1, 'P1', ['P1', 'P2', 'P3'], ['P1', 'P2', 'P3']), vote(1, 2, 'P2', ['P2', 'P4', 'P6'], ['P2', 'P4', 'P6']),
  vote(1, 3, 'P3', ['P3', 'P5', 'P9'], ['P3', 'P5', 'P9']), vote(1, 4, 'P4', ['P4', 'P7', 'P10'], ['P4', 'P7', 'P10']),
  vote(1, 5, 'P5', ['P5', 'P1', 'P8'], IDS),
];
const R2 = [
  vote(2, 1, 'P6', ['P6', 'P2', 'P3', 'P4'], ['P6', 'P2', 'P3', 'P4']), vote(2, 2, 'P7', ['P7', 'P2', 'P3', 'P9'], ['P7', 'P2', 'P3', 'P9']),
  vote(2, 3, 'P8', ['P8', 'P4', 'P6', 'P9'], ['P8', 'P4', 'P6', 'P9']), vote(2, 4, 'P9', ['P9', 'P2', 'P4', 'P7'], ['P9', 'P2', 'P4', 'P7']),
  vote(2, 5, 'P10', ['P10', 'P2', 'P3', 'P4'], IDS),
];
const QH = [{ round: 1, team: ['P5', 'P1', 'P8'], result: 'success', failCount: 0 }, { round: 2, team: ['P10', 'P2', 'P3', 'P4'], result: 'fail', failCount: 1 }];

describe('round 40 tuning fields', () => {
  it('all new knobs are off in the legacy table and the default; flags parse', () => {
    const keys = ['percivalThumbVote40', 'beliefLakeCal40', ...['On', 'Off', 'KeyOn', 'KeyOff', 'R5On', 'R5Off', 'Tail'].flatMap((c) => ['L', 'P', 'M'].map((r) => `vote40${c}${r}`))];
    for (const k of keys) {
      expect((LEGACY_AGENT_TUNING as unknown as Record<string, number>)[k]).toBe(0);
      expect((DEFAULT_AGENT_TUNING as unknown as Record<string, number>)[k]).toBe(0);
    }
    expect(parseTuningFlag('vote40OnL=0.95')).toEqual({ vote40OnL: 0.95 });
    expect(() => parseTuningFlag('vote40OnL=1.5')).toThrow();
    expect(parseTuningFlag('percivalThumbVote40')).toEqual({ percivalThumbVote40: 3 });
    expect(parseTuningFlag('merlinPublicPipeline=3')).toEqual({ merlinPublicPipeline: 3 });
    expect(parseTuningFlag('loyalLakePair=10')).toEqual({ loyalLakePair: 10 });
  });
});

describe('vote40: one threshold per cell and blue role', () => {
  const vt = asObs({ ...base, currentRound: 3, gamePhase: 'team_vote', questResults: ['success', 'fail'], proposedTeam: ['P1', 'P10', 'P5'], currentLeader: 'P1' });
  it('roles: loyal / Percival / Merlin and Merlin\'s public loyal view; red seats and their loyal views get none', () => {
    expect(voteRole40(vt)).toBe('L');
    expect(voteRole40(asObs({ ...(vt as object), myRole: 'percival' }))).toBe('P');
    expect(voteRole40(asObs({ ...(vt as object), myRole: 'merlin' }))).toBe('M');
    expect(voteRole40(asObs({ ...(vt as object), publicLoyalView: true, seatTeam: 'good' }))).toBe('M');
    expect(voteRole40(asObs({ ...(vt as object), publicLoyalView: true, seatTeam: 'evil' }))).toBeNull();
    expect(voteRole40(asObs({ ...(vt as object), redLoyalView: true }))).toBeNull();
    expect(voteRole40(asObs({ ...(vt as object), myTeam: 'evil', myRole: 'assassin' }))).toBeNull();
  });
  it('cells: rounds 3–4 before / after red has two wins, round 5; on / off the team', () => {
    expect(voteCell40(vt, true)).toBe('On');
    expect(voteCell40(vt, false)).toBe('Off');
    expect(voteCell40(asObs({ ...(vt as object), questResults: ['fail', 'fail'] }), true)).toBe('KeyOn');
    expect(voteCell40(asObs({ ...(vt as object), currentRound: 5, questResults: ['fail', 'fail', 'success', 'success'] }), false)).toBe('R5Off');
  });
  it('the knob of the cell and role applies; unset (0) falls back to the old threshold', () => {
    expect(vote40Bar(T({}), vt, true)).toBe(0);
    expect(vote40Bar(T({ vote40OnL: 0.9, vote40OnP: 0.6 }), vt, true)).toBe(0.9);
    expect(vote40Bar(T({ vote40OnL: 0.9, vote40OnP: 0.6 }), asObs({ ...(vt as object), myRole: 'percival' }), true)).toBe(0.6);
    expect(vote40Bar(T({ vote40OnL: 0.9 }), asObs({ ...(vt as object), seatTeam: 'evil' }), true)).toBe(0);
    expect(vote40TailBar(T({ vote40TailM: 0.4 }), vt, 'M')).toBe(0.4);
    expect(vote40TailBar(T({ vote40TailM: 0.4 }), asObs({ ...(vt as object), currentRound: 2 }), 'M')).toBe(0);
  });
});

describe('percivalThumbVote40 (Percival on a team with one thumb)', () => {
  const perc = asObs({
    ...base, myPlayerId: 'P10', myRole: 'percival', knownWizards: ['P7', 'P8'], currentRound: 3, gamePhase: 'team_vote', questResults: ['success', 'fail'],
    voteHistory: [...R1, ...R2], questHistory: QH, currentLeader: 'P1',
  });
  const read = percivalRead39(perc)!;
  it('only the favoured thumb on the team: approve (rounds 3–4; not when the other thumb leads; not round 5)', () => {
    expect(read.fav).toBeDefined();
    const team = ['P1', 'P10', read.fav!];
    expect(percivalThumbVote40(T({ percivalThumbVote40: 1 }), perc, team)).toBe(true);
    expect(percivalThumbVote40(T({ percivalThumbVote40: 1 }), asObs({ ...(perc as object), currentLeader: read.unfav }), team)).toBeNull();
    expect(percivalThumbVote40(T({ percivalThumbVote40: 1 }), asObs({ ...(perc as object), currentRound: 5 }), team)).toBeNull();
    expect(percivalThumbVote40(T({}), perc, team)).toBeNull();
    // both thumbs or none on the team: not this rule
    expect(percivalThumbVote40(T({ percivalThumbVote40: 3 }), perc, ['P1', 'P10', 'P7', 'P8'])).toBeNull();
    expect(percivalThumbVote40(T({ percivalThumbVote40: 3 }), perc, ['P1', 'P10', 'P2'])).toBeNull();
  });
  it('only the other thumb on the team: reject only at confidence >= 0.9 and not a re-proposal of the last success', () => {
    const team = ['P1', 'P10', read.unfav!];
    expect(percivalThumbVote40(T({ percivalThumbVote40: 2 }), perc, team)).toBe(!(read.conf >= 0.9));
  });
});

describe('percivalRead39=1: the fitted read inside Percival\'s own posterior', () => {
  const perc = asObs({
    ...base, myPlayerId: 'P10', myRole: 'percival', knownWizards: ['P7', 'P8'], currentRound: 3, gamePhase: 'team_select', questResults: ['success', 'fail'],
    voteHistory: [...R1, ...R2], questHistory: QH, seatTeam: 'good',
  });
  it('P(thumb red) follows 1 − P(thumb is Merlin) of the read; the default keeps the old posterior', () => {
    const read = percivalRead39(perc)!;
    const share = bayesRedShare(perc, bayesOptionsOf(T({ percivalRead39: 1 })));
    expect(share.get('P7')!).toBeCloseTo(1 - read.pFirst, 6);
    expect(share.get('P8')!).toBeCloseTo(read.pFirst, 6);
    expect(bayesOptionsOf(T({})).thumbRead39).toBeUndefined();
  });
});

describe('beliefLakeCal40 (another holder\'s claim term, blue seats only)', () => {
  it('only in blue options; the recursive reader\'s level 0 never takes it', () => {
    const o = bayesOptionsOf(T({ beliefLakeCal40: 0.5 }));
    expect(o.lakeCal).toBe(0.5);
    if (o.recursiveLevel0) expect(o.recursiveLevel0.lakeCal).toBeUndefined();
    expect(bayesOptionsOf(T({})).lakeCal).toBeUndefined();
  });
  it('a holder who declared someone evil reads redder with the claim tempered (blue seat); a red seat\'s view is unchanged', () => {
    const obs = asObs({
      ...base, myPlayerId: 'P2', currentRound: 3, gamePhase: 'team_vote', questResults: ['success', 'fail'], voteHistory: [...R1, ...R2], questHistory: QH,
      lakeHistory: [{ round: 2, holderId: 'P10', targetId: 'P5', declaredClaim: 'evil' }], proposedTeam: ['P3', 'P4', 'P6'], currentLeader: 'P3', seatTeam: 'good',
    });
    const a = bayesRedShare(obs, bayesOptionsOf(T({}))).get('P10')!;
    const b = bayesRedShare(obs, bayesOptionsOf(T({ beliefLakeCal40: 0.3 }))).get('P10')!;
    expect(b).toBeGreaterThan(a);
    const red = asObs({ ...(obs as object), seatTeam: 'evil' });
    expect(bayesRedShare(red, bayesOptionsOf(T({ beliefLakeCal40: 0.3 }))).get('P10')).toBeCloseTo(bayesRedShare(red, bayesOptionsOf(T({}))).get('P10')!, 12);
  });
});

describe('loyalLakePair bits 2 / 8 (LP-12 part 2: the holder of last round\'s evil claim, round 3 proposals 1–3)', () => {
  const obs = asObs({
    ...base, myPlayerId: 'P1', currentRound: 3, gamePhase: 'team_select', questResults: ['success', 'fail'], voteHistory: [...R1, ...R2], questHistory: QH,
    lakeHistory: [{ round: 2, holderId: 'P10', targetId: 'P5', declaredClaim: 'evil' }],
  });
  it('bit 2: the holder sat on a failed mission → off; not round 4, not proposal 4, not the holder / target, not Merlin or red seats', () => {
    expect(lakeHolderBarred40(T({ loyalLakePair: 2 }), obs)).toBe('P10');
    expect(lakeHolderBarred40(T({}), obs)).toBeNull();
    expect(lakeHolderBarred40(T({ loyalLakePair: 2 }), asObs({ ...(obs as object), currentRound: 4 }))).toBeNull();
    expect(lakeHolderBarred40(T({ loyalLakePair: 2 }), asObs({ ...(obs as object), failCount: 3 }))).toBeNull();
    expect(lakeHolderBarred40(T({ loyalLakePair: 2 }), asObs({ ...(obs as object), myPlayerId: 'P5' }))).toBeNull();
    expect(lakeHolderBarred40(T({ loyalLakePair: 2 }), asObs({ ...(obs as object), myRole: 'merlin' }))).toBeNull();
    expect(lakeHolderBarred40(T({ loyalLakePair: 2 }), asObs({ ...(obs as object), seatTeam: 'evil' }))).toBeNull();
    // a holder who never sat on a failed mission is not barred by bit 2
    expect(lakeHolderBarred40(T({ loyalLakePair: 2 }), asObs({ ...(obs as object), questHistory: [QH[0], { ...QH[1], result: 'success', failCount: 0 }], questResults: ['success', 'success'] }))).toBeNull();
  });
});

describe('merlinPublicPipeline=3 (value 2 from round 2 on)', () => {
  it('off in round 1, on from round 2; values 1 / 2 every round', () => {
    expect(merlinPublicPipelineOn(T({ merlinPublicPipeline: 3 }), asObs({ ...base, currentRound: 1 }))).toBe(false);
    expect(merlinPublicPipelineOn(T({ merlinPublicPipeline: 3 }), asObs({ ...base, currentRound: 2 }))).toBe(true);
    expect(merlinPublicPipelineOn(T({ merlinPublicPipeline: 2 }), asObs({ ...base, currentRound: 1 }))).toBe(true);
    expect(merlinPublicPipelineOn(T({}), asObs({ ...base, currentRound: 2 }))).toBe(false);
  });
});
