/**
 * 資訊流研究原型（src/ai/infl）的單元測試（2026-11-04）。正式流程沒有讀這些模組；這裡只確認原型算的是它說的東西。
 * 固定局 = `benchmark/benchmark.test.ts` 的牌譜 #1（手工核對過）。
 */
import { describe, it, expect } from 'vitest';
import { parseReplayGame, type PaipuRow, type ReplayGame } from '../benchmark/sheetsReplay';
import { fitLogisticRegression, sigmoid } from './logistic';
import { bitOf, flowOfGame, lakeSig, seatViewObs } from './flow';
import { BASE_FEATURES, FlowFeatures, N_BASE, N_EXTRA } from './voteFeatures';
import { PolicyVoteReader, featureColumns, truthOf, type PolicyModel } from './policyModel';
import { fitCellTables } from './cellTables';
import { bestTeamMask, sharesOf, skeletonPosterior } from './posterior';
import { roleKingLabel, roleKings } from './roleKings';
import { buildReplayObservation } from '../benchmark/replayObservation';
import { ROLE_CLASSES } from './voteFeatures';

const NAMES = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9', 'A0'];
function row(text: string, code: string, result: string): PaipuRow {
  const r: Record<string, string> = { 流水號: 'T1', 文字記錄: text, 配置: code, 結果: result, 刺殺: '' };
  ['玩1', '玩2', '玩3', '玩4', '玩5', '玩6', '玩7', '玩8', '玩9', '玩0'].forEach((col, i) => { r[col] = NAMES[i]; });
  return r;
}
const GAME1_TEXT = [
  '147', '269', '349', '468', '358', 'ooo',
  '3589 6+', '3578', '4589', '3589 1+', '3590', 'ooox',
  '0>2 x',
  '1358 5-', '2358 5-', '3459 59-', '3457 45-', '3568', 'ooox',
  '2>8 x',
  '12347 7- 6+', '14679', 'oooxx',
].join('\n');
function game1(): ReplayGame {
  const res = parseReplayGame(row(GAME1_TEXT, '901836', '三紅'));
  if (!res.ok) throw new Error(res.reason);
  return res.game;
}

describe('fitLogisticRegression', () => {
  it('recovers the coefficients of a synthetic logistic model', () => {
    let s = 12345;
    const rnd = (): number => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
    const xs: number[][] = [];
    const ys: number[] = [];
    for (let n = 0; n < 20000; n++) {
      const x = [1, rnd() * 2 - 1, rnd() < 0.5 ? 1 : 0];
      xs.push(x);
      ys.push(rnd() < sigmoid(-0.5 + 2 * x[1] + 1.2 * x[2]) ? 1 : 0);
    }
    const b = fitLogisticRegression(xs, ys, { lambda: 0.01 });
    expect(b[0]).toBeCloseTo(-0.5, 0);
    expect(b[1]).toBeCloseTo(2, 0);
    expect(b[2]).toBeCloseTo(1.2, 0);
  });

  it('keeps masked columns at zero', () => {
    const b = fitLogisticRegression([[1, 1], [1, 0], [1, 1], [1, 0]], [1, 0, 1, 1], { cols: [1, 0] });
    expect(b[1]).toBe(0);
  });
});

describe('flow — INFL as seen from a seat at a proposal', () => {
  const g = game1();
  const flow = flowOfGame(g);
  const truth = truthOf(g, flow);

  it('cuts the history at the proposal and adds only the seat’s own lake results (under the world)', () => {
    // proposal 12 = R3 third proposal (3459); the R2 lake 10>2 is public by then, the R3 lake 2>8 is not.
    const o = seatViewObs(flow, 12, 'P10', truth.w);
    expect(o.voteHistory).toHaveLength(12);
    expect(o.questHistory.map((q) => q.round)).toEqual([1, 2]);
    expect(o.lakeHistory?.map((l) => l.holderId)).toEqual(['P10']);
    expect(o.myLakeResults).toEqual([{ round: 2, targetId: 'P2', result: 'good' }]);
    // In a world where P2 is red, P10 saw red.
    expect(seatViewObs(flow, 12, 'P10', truth.w | bitOf(flow, 'P2')).myLakeResults?.[0].result).toBe('evil');
    expect(lakeSig(flow, 12, 'P10', truth.w)).not.toBe(lakeSig(flow, 12, 'P10', truth.w | bitOf(flow, 'P2')));
    expect(lakeSig(flow, 12, 'P3', truth.w)).toBe(lakeSig(flow, 12, 'P3', truth.w | bitOf(flow, 'P2')));
  });

  it('marks 鐵咬: R3 3459 keeps the R2 failed team 3590 but seat 10', () => {
    const ff = new FlowFeatures(flow);
    const bite = BASE_FEATURES.indexOf('bite');
    expect(ff.base(12, 'P10', truth.w)[bite]).toBe(1);
    expect(ff.base(12, 'P9', truth.w)[bite]).toBe(0);
    expect(ff.base(10, 'P10', truth.w)[bite]).toBe(0); // 1358 drops 9 and 10
  });
});

describe('policy posterior', () => {
  const g = game1();
  const flow = flowOfGame(g);
  const ff = new FlowFeatures(flow);
  const cells = fitCellTables([g]);
  const obs = buildReplayObservation(g, 2, { kind: 'team_vote', proposal: 16 });

  it('a flat vote model (p = ½ for every vote) reads nothing: same posterior as not reading votes', () => {
    const zero: PolicyModel = { beta: Object.fromEntries(ROLE_CLASSES.map((c) => [c, new Float64Array(N_BASE + N_EXTRA)])) as PolicyModel['beta'], residual: false, useBayesView: false };
    const pol = skeletonPosterior(obs, cells, { kind: 'policy', reader: new PolicyVoteReader(zero, ff) });
    const none = skeletonPosterior(obs, cells, { kind: 'none' });
    expect(pol.worlds).toEqual(none.worlds);
    pol.wts.forEach((w, i) => expect(w).toBeCloseTo(none.wts[i], 10));
    expect(sharesOf(pol)[1]).toBe(0); // the viewer (P2, loyal) is never red
  });

  it('feature columns: no residual and no Bayes view drop exactly those columns', () => {
    const cols = featureColumns({ residual: false, useBayesView: false });
    expect(cols.reduce((a, b) => a + b, 0)).toBe(N_BASE + N_EXTRA - 2 - 5);
  });

  it('bestTeamMask enumerates every team with the leader', () => {
    let seen = 0;
    const best = bestTeamMask((m) => { seen++; return m === 0b1111 ? 1 : 0; }, flow.ids, 'P1', 4);
    expect(seen).toBe(84); // C(9, 3)
    expect(best.mask).toBe(0b1111);
  });
});

describe('roleKings', () => {
  it('ranks by raw win rate with a game floor and labels by role and rank only', () => {
    expect(roleKingLabel('merlin', 1)).toBe('梅林王#1');
    const c = roleKings([], 3);
    expect(c.rank.size).toBe(0);
  });
});
