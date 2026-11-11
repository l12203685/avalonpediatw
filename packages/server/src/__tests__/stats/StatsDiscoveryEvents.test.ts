/**
 * 自動發現的新資料（兩紅之後的派隊、關鍵票、全部投票；@avalon/shared discoveryEvents.ts、discovery.ts 的叢集穩健檢定、
 * discoveryStrategy.ts 的策略範本）。合成的局：玩家池 45 人（15 強者 PR 90、15 一般人 PR 50、15 新手 PR 10），名字全是虛構的。
 *
 * 每一局：前兩局都紅，第 3 局是兩紅之後，有三次提議（第 1、2 次剛好 5 票沒過、第 3 次剛好 6 票過）。藍方隊長派全好的機率
 * planted = true 時跟隊長分組有關（強者 0.85、一般人 0.6、新手 0.35），否則都是 0.6；投票全部隨機（跟隊伍好壞無關）。
 */
import { describe, expect, it } from 'vitest';
import {
  ClusterAcc, DEFAULT_COHORT_CUTS, DISCOVERY_DIMENSIONS, DISCOVERY_METRICS, STRATEGY_HYPOTHESIS, STRATEGY_MIN_DIFF,
  buildStrategy, clusteredTwoProportion, decodeGamesDataset, discoverFindings, discoveryBase, eventUnits, isEventUnit, sequenceBefore, strategyLine,
  studentTwoSided, tCritical95,
  type DiscoveryFinding, type LineupTuple, type VotingProposal,
} from '@avalon/shared/stats';
import { makeDataset, type GameSpec } from './datasetBuilder';

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const SEATS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];
const RED = new Set(['1', '2', '3', '4']); // 配置 123456：1 刺客、2 莫甘娜、3 莫德雷德、4 奧伯倫
const BLUE = ['5', '6', '7', '8', '9', '0'];
const POOL = Array.from({ length: 45 }, (_, i) => ({ name: `虛構玩家${i + 1}`, pr: i < 15 ? 90 : i < 30 ? 50 : 10 }));
const ALL_GOOD: Record<number, number> = { 90: 0.85, 50: 0.6, 10: 0.35 };

function pick<T>(r: () => number, xs: readonly T[], k: number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, k);
}

/** 隊長 + 其他人；allGood 時全藍，否則放一個紅方。 */
function team(r: () => number, leader: string, size: number, allGood: boolean): string {
  const others = SEATS.filter((s) => s !== leader);
  const blues = others.filter((s) => !RED.has(s));
  const reds = others.filter((s) => RED.has(s));
  const members = allGood || RED.has(leader)
    ? pick(r, RED.has(leader) ? others : blues, size - 1)
    : [...pick(r, reds, 1), ...pick(r, blues, size - 2)];
  return [leader, ...members].join('');
}

/** 剛好 k 張贊成（隨機座位）。 */
const approvals = (r: () => number, k: number): string => pick(r, SEATS, k).join('');

function synthetic(n: number, planted: boolean, seed: number): GameSpec[] {
  const r = rng(seed);
  return Array.from({ length: n }, (_, gi) => {
    const players = pick(r, POOL, 10);
    const start = Math.floor(r() * 10);
    const leader = (k: number): string => SEATS[(start + k) % 10];
    const votes: VotingProposal[] = [];
    // 第 1 局兩次（第 2 次過）、第 2 局一次：都派有紅的隊、任務紅
    votes.push([1, 1, team(r, leader(0), 3, false), approvals(r, 5)]);
    votes.push([1, 2, team(r, leader(1), 3, false), approvals(r, 6)]);
    votes.push([2, 1, team(r, leader(2), 4, false), approvals(r, 6)]);
    let lastGood = false;
    for (let a = 1; a <= 3; a += 1) {
      const l = leader(2 + a);
      const pr = players[SEATS.indexOf(l)].pr;
      const p = planted ? ALL_GOOD[pr] : 0.6;
      const good = r() < p;
      votes.push([3, a, team(r, l, 4, good), approvals(r, a === 3 ? 6 : 5)]);
      lastGood = good;
    }
    const prs = players.map((p) => p.pr);
    const s10 = Math.round(prs.reduce((x, y) => x + y, 0));
    return {
      id: `G${gi}`, names: players.map((p) => p.name), config: '123456',
      outcome: lastGood ? '三藍活' : '三紅', rounds: lastGood ? 'RRB--' : 'RRR--',
      missions: `oox|ooxo|${lastGood ? 'oooo' : 'ooox'}||`, votes,
      lineup: [45, s10, prs, 0] as LineupTuple, // S×10 = 10 個 PR 的總和（S = 平均）
    };
  });
}

const plantedGames = decodeGamesDataset(makeDataset(synthetic(700, true, 11))).games;
const nullGames = decodeGamesDataset(makeDataset(synthetic(700, false, 23))).games;
const NAMES = POOL.map((p) => p.name);

describe('event rows', () => {
  it('two-red proposals, decisive votes and all votes become rows with clusters and the role', () => {
    // 第一局有藍方隊長在第 3 局提議、隊長推得出來的
    const g = plantedGames.find((x) => eventUnits(x).twoRed.length > 0)!;
    const u = eventUnits(g);
    expect(u.twoRed.length).toBeGreaterThan(0);
    for (const row of u.twoRed) {
      expect(row.dims.round).toBe('第 3 局');
      expect(row.dims.sequence).toBe('紅紅');
      expect(['梅林', '派西維爾', '忠臣']).toContain(row.stratum);
      expect(row.cluster?.game).toBe(g.seq);
      expect(NAMES).toContain(row.cluster?.player);
      expect(row.metrics.get('allGood')?.[1]).toBe(1);
      expect(row.metrics.has('r4Safe')).toBe(false); // 第 4 局才有
    }
    // 全部投票：第 3 局 3 次提議 × 6 個藍方座位，同一座位同一局合成一列（第 1～2 局不算）
    expect(u.blueVote).toHaveLength(6);
    expect(u.blueVote.every((x) => x.dims.twoRedState === '紅方已兩勝')).toBe(true);
    expect(u.decisive.length).toBeGreaterThan(0);
    expect(sequenceBefore(g, 1)).toBe('（開局）');
    // 有藍方隊長在第 3 局提議、而且隊長推得出來的局（隊長推不出來或第 3 局的隊長都是紅方的局沒有列）
    expect(plantedGames.filter((x) => eventUnits(x).twoRed.length > 0).length).toBeGreaterThan(200);
  });

  it('dimensions and metrics are registered with pages and links', () => {
    const twoRedDims = DISCOVERY_DIMENSIONS.filter((d) => d.unit === 'twoRed').map((d) => d.id);
    expect(twoRedDims).toEqual(expect.arrayContaining(['playerTier', 'tableTier', 'role', 'seat', 'round', 'slot', 'sequence']));
    expect(DISCOVERY_DIMENSIONS.find((d) => d.unit === 'decisive' && d.id === 'playerTier')?.pair).toEqual(['強者', '新手']);
    const m = DISCOVERY_METRICS.find((x) => x.unit === 'twoRed' && x.id === 'r4Safe');
    expect(m).toMatchObject({ kind: 'rate', pages: ['teams'], link: 'twoRedCohort' });
    expect(DISCOVERY_METRICS.find((x) => x.unit === 'blueVote' && x.id === 'acc')?.link).toBe('decisiveBoardAll');
    expect(DISCOVERY_METRICS.filter((x) => x.unit === 'decisive')).toHaveLength(13); // 正確率 + 四組對率 + 八格
  });
});

describe('cluster-robust test', () => {
  it('player-level clustering widens the interval: 10 players per group, each always 1 or always 0', () => {
    // A：6 人全 1、4 人全 0（60%）；B：4 人全 1、6 人全 0（40%）；每人 50 次，每次在不同局
    const a = new ClusterAcc();
    const b = new ClusterAcc();
    let game = 0;
    for (let p = 0; p < 20; p += 1) {
      const acc = p < 10 ? a : b;
      const one = p < 10 ? p < 6 : p < 14;
      for (let k = 0; k < 50; k += 1) { acc.add(one ? 1 : 0, 1, game, p, game); game += 1; }
    }
    const t = clusteredTwoProportion(a, b);
    expect(t.diff).toBeCloseTo(20, 6);
    expect(t.naiveP).toBeLessThan(1e-6); // 當成 1000 次獨立的事件：非常顯著
    expect(t.p).toBeGreaterThan(0.2); // 其實只有 20 位玩家：看不出差別
    expect(t.se).toBeGreaterThan(5 * 3.1);
  });

  it('without clustering (each event its own game and player) it matches the two-proportion z test', () => {
    const a = new ClusterAcc();
    const b = new ClusterAcc();
    for (let i = 0; i < 400; i += 1) a.add(i % 10 < 6 ? 1 : 0, 1, i, i, i);
    for (let i = 0; i < 400; i += 1) b.add(i % 10 < 4 ? 1 : 0, 1, 1000 + i, 1000 + i, 1000 + i);
    const t = clusteredTwoProportion(a, b);
    const naiveSe = 100 * Math.sqrt((0.6 * 0.4) / 400 + (0.4 * 0.6) / 400);
    expect(t.se).toBeCloseTo(naiveSe, 0);
    expect(t.p).toBeLessThan(1e-6);
  });
});

describe('cluster-robust test: floor and small-cluster correction', () => {
  it('never smaller than the unclustered variance (negative intraclass correlation: every player exactly 50% vs exactly 30%)', () => {
    const a = new ClusterAcc();
    const b = new ClusterAcc();
    let game = 0;
    for (let p = 0; p < 30; p += 1) {
      const acc = p < 15 ? a : b;
      const ones = p < 15 ? 5 : 3;
      for (let k = 0; k < 10; k += 1) { acc.add(k < ones ? 1 : 0, 1, game, p, game); game += 1; }
    }
    // 每位玩家都剛好 50%／30%：玩家叢集的殘差全是 0，以前的 V_玩家 = 0 會比不管叢集的檢定還顯著
    const t = clusteredTwoProportion(a, b);
    const iidSe = 100 * Math.sqrt((0.5 * 0.5) / 150 + (0.3 * 0.7) / 150);
    expect(t.se).toBeGreaterThanOrEqual(iidSe - 1e-9);
    expect(t.p).toBeGreaterThanOrEqual(t.naiveP * 0.5); // 不會比不管叢集的檢定更顯著（兩個 p 的算法略有不同）
    expect(t.df).toBe(14); // 每組 15 位玩家
  });

  it('t distribution for few clusters: matches the table and tends to the normal', () => {
    expect(studentTwoSided(2.228, 10)).toBeCloseTo(0.05, 3);
    expect(studentTwoSided(3.25, 9)).toBeCloseTo(0.01, 3);
    expect(tCritical95(10)).toBeCloseTo(2.228, 2);
    expect(tCritical95(13)).toBeCloseTo(2.160, 2);
    expect(tCritical95(100000)).toBeCloseTo(1.96, 2);
    expect(studentTwoSided(1.96, 1e7)).toBeCloseTo(0.05, 3);
  });
});

describe('discoverFindings on the new data', () => {
  const planted = discoverFindings(plantedGames);
  const nul = discoverFindings(nullGames);
  const strongVsNovice = (r: typeof planted): DiscoveryFinding | undefined =>
    r.findings.find((f) => f.unit === 'twoRed' && f.dimension.id === 'playerTier' && f.metric.id === 'allGood');

  it('finds the planted difference (strong vs novice leaders) with a clustered test and a strategy line', () => {
    const f = strongVsNovice(planted);
    expect(f).toBeDefined();
    expect(f!.a.label).toBe('強者');
    expect(f!.b.label).toBe('新手');
    expect(f!.diff).toBeGreaterThan(30);
    expect(f!.lo).toBeGreaterThan(0);
    expect(f!.clustered).toBe(true);
    expect(f!.a.players).toBe(15);
    expect(f!.q).toBeLessThanOrEqual(0.05);
    expect(f!.strategy?.text).toMatch(/^強者在兩紅後比較常派全好的隊（\d+% vs 新手 \d+%） → 兩紅之後當隊長，優先派全好/);
    expect(strategyLine(f!.strategy!)).toContain('相關不是因果');
  });

  it('does not report the same comparison when nothing was planted', () => {
    expect(strongVsNovice(nul)).toBeUndefined();
  });

  it('multiple-comparison control: raw p < 0.05 happens by chance among the new tests, BH keeps none of them', () => {
    const all = discoverFindings(nullGames, { fdr: 1 }).findings.filter((f) => isEventUnit(f.unit));
    expect(all.length).toBeGreaterThan(40);
    // 投票是隨機的、派隊跟分組無關：分組、桌、座位上新資料的檢定全部是虛無假設（第幾次提議不算：第 3 次提議一定剛好 6 票過）
    const nullOnes = all.filter((f) => ['playerTier', 'tableTier', 'seat'].includes(f.dimension.id));
    expect(nullOnes.length).toBeGreaterThan(20);
    expect(nullOnes.filter((f) => f.p < 0.05).length).toBeGreaterThan(0); // 沒有校正就會列出來的假發現
    expect(nul.findings.filter((f) => isEventUnit(f.unit) && ['playerTier', 'tableTier', 'seat'].includes(f.dimension.id))).toEqual([]);
    for (const f of all) expect(f.q).toBeGreaterThanOrEqual(f.p - 1e-12);
  });

  it('strategy lines never name players and every new finding links to where its numbers live', () => {
    const ev = planted.findings.filter((f) => isEventUnit(f.unit));
    expect(ev.length).toBeGreaterThan(0);
    for (const f of ev) {
      expect(f.metric.link).toBeDefined();
      const text = f.strategy?.text ?? '';
      for (const name of NAMES) expect(text).not.toContain(name);
    }
  });

  it('every group has at least 20 games and 10 named players', () => {
    for (const f of [...planted.findings, ...nul.findings].filter((x) => x.clustered)) {
      expect(f.a.games).toBeGreaterThanOrEqual(20);
      expect(f.b.games).toBeGreaterThanOrEqual(20);
      expect(f.a.players).toBeGreaterThanOrEqual(10);
      expect(f.b.players).toBeGreaterThanOrEqual(10);
    }
  });

  it('the non-event half can be computed once and reused when the cut points change', () => {
    const base = discoveryBase(plantedGames);
    expect(base.candidates.every((c) => !isEventUnit(c.unit))).toBe(true);
    const withBase = discoverFindings(plantedGames, { base });
    expect(withBase.tests).toBe(planted.tests);
    expect(withBase.findings.map((f) => `${f.id}|${f.q}`)).toEqual(planted.findings.map((f) => `${f.id}|${f.q}`));
    expect(withBase.units).toEqual(planted.units);
    // 局數不符（不是同一批局）就不用它
    const stale = discoverFindings(nullGames, { base });
    expect(stale.findings.map((f) => f.id)).toEqual(nul.findings.map((f) => f.id));
  });

  it('role findings are hidden by default and 忠臣 vs 其他 is not repeated after 梅林 vs 其他', () => {
    expect(DISCOVERY_DIMENSIONS.filter((d) => isEventUnit(d.unit) && d.id === 'role').every((d) => d.structural && d.role)).toBe(true);
    const roles = planted.findings.filter((f) => isEventUnit(f.unit) && f.dimension.role);
    const merlin = new Set(roles.filter((f) => f.a.label === '梅林').map((f) => `${f.unit}|${f.metric.id}`));
    for (const f of roles.filter((x) => x.a.label === '忠臣')) expect(merlin.has(`${f.unit}|${f.metric.id}`)).toBe(false);
  });

  it('cut points move the groups: with prHi 95 nobody is strong', () => {
    const moved = discoverFindings(plantedGames, { cuts: { ...DEFAULT_COHORT_CUTS, prHi: 95 } });
    expect(strongVsNovice(moved)).toBeUndefined();
  });
});

describe('strategy templates', () => {
  const dim = (unit: string, id: string) => DISCOVERY_DIMENSIONS.find((d) => d.unit === unit && d.id === id)!;
  const met = (unit: string, id: string) => DISCOVERY_METRICS.find((m) => m.unit === unit && m.id === id)!;
  const f = (over: Partial<DiscoveryFinding>): DiscoveryFinding => ({
    id: 'x', unit: 'twoRed', dimension: dim('twoRed', 'playerTier'), metric: met('twoRed', 'r4Safe'),
    a: { label: '強者', value: 80, n: 200, units: 200 }, b: { label: '新手', value: 56, n: 200, units: 200 },
    diff: 24, lo: 10, hi: 38, p: 0.001, q: 0.01, effect: 0.5, withinRole: 22, ...over,
  });

  it('the example: strong leaders send at-most-one-red teams in round 4', () => {
    expect(buildStrategy(f({}))?.text).toBe('強者在兩紅後第 4 局比較常派最多一紅的隊（80% vs 新手 56%） → 第 4 局可以優先找最多一紅、出任務一定成功的隊');
    expect(strategyLine(buildStrategy(f({}))!)).toBe(`可能的策略（${STRATEGY_HYPOTHESIS}）：強者在兩紅後第 4 局比較常派最多一紅的隊（80% vs 新手 56%） → 第 4 局可以優先找最多一紅、出任務一定成功的隊`);
  });

  it(`only above the threshold (${STRATEGY_MIN_DIFF} points)`, () => {
    expect(buildStrategy(f({ diff: STRATEGY_MIN_DIFF - 0.1, a: { label: '強者', value: 60.9, n: 2000, units: 2000 }, b: { label: '新手', value: 56, n: 2000, units: 2000 } }))).toMatchObject({ text: null, suppressed: 'small' });
    expect(buildStrategy(f({ diff: -(STRATEGY_MIN_DIFF - 0.1) }))?.suppressed).toBe('small');
    expect(buildStrategy(f({ diff: STRATEGY_MIN_DIFF + 0.1, withinRole: STRATEGY_MIN_DIFF + 0.1 }))?.text).toBeTruthy();
  });

  it('suppressed when explained by role, in the wrong direction, or for a category with no good or bad', () => {
    expect(buildStrategy(f({ dimension: dim('twoRed', 'role'), a: { label: '梅林', value: 97, n: 220, units: 220 }, withinRole: undefined }))?.suppressed).toBe('role');
    expect(buildStrategy(f({ withinRole: 2 }))?.suppressed).toBe('role'); // 在同一個角色裡比就沒差
    expect(buildStrategy(f({ withinRole: -8 }))?.suppressed).toBe('role'); // 方向相反
    expect(buildStrategy(f({ diff: -24, a: { label: '強者', value: 56, n: 200, units: 200 }, b: { label: '新手', value: 80, n: 200, units: 200 }, withinRole: -22 }))?.suppressed).toBe('direction');
    expect(buildStrategy(f({ metric: met('twoRed', 'oneThumb') }))?.suppressed).toBe('neutral');
    expect(buildStrategy(f({ unit: 'decisive', dimension: dim('decisive', 'tableTier'), metric: met('decisive', 'offYesRight'), a: { label: '高端', value: 30, n: 300, units: 300 }, b: { label: '歡樂', value: 20, n: 300, units: 300 } }))?.suppressed).toBe('context');
    expect(buildStrategy(f({ unit: 'proposal', dimension: dim('proposal', 'leaderCamp'), metric: met('proposal', 'passed') }))).toBeUndefined(); // 舊指標沒有範本
  });

  it('the table tier gives a descriptive reading, not an instruction', () => {
    const s = buildStrategy(f({
      unit: 'decisive', dimension: dim('decisive', 'tableTier'), metric: met('decisive', 'offYes'),
      a: { label: '高端', value: 62, n: 300, units: 300 }, b: { label: '歡樂', value: 48, n: 300, units: 300 }, diff: 14, withinRole: 13,
    }));
    expect(s?.text).toBe('在高端桌，藍方的關鍵外白對率比較高（62% vs 歡樂桌 48%） → 在高端桌，藍方外白時，隊伍比較常全好');
    const t = buildStrategy(f({ dimension: dim('twoRed', 'tableTier'), metric: met('twoRed', 'thumb'), a: { label: '高端', value: 43, n: 900, units: 900 }, b: { label: '歡樂', value: 21, n: 900, units: 900 }, diff: 22, withinRole: 21 }));
    expect(t?.text).toBe('在高端桌，藍方隊長兩紅後第 3、5 局比較常派到拇指（43% vs 歡樂桌 21%） → 在高端桌，隊上比較常有拇指，投票前多檢查一次');
  });

  it('structural dimensions (seat, round, proposal number, sequence, two-red state) get no strategy', () => {
    const big = { diff: 40, withinRole: 39, a: { label: 'x', value: 90, n: 900, units: 900 }, b: { label: '其他', value: 50, n: 900, units: 900 } };
    for (const [unit, id, m] of [['twoRed', 'seat', 'thumb'], ['twoRed', 'round', 'thumb'], ['twoRed', 'slot', 'allGood'], ['twoRed', 'sequence', 'allGood'],
      ['blueVote', 'sequence', 'onYes'], ['blueVote', 'round', 'onYes'], ['decisive', 'twoRedState', 'acc']] as const) {
      const s = buildStrategy(f({ unit, dimension: dim(unit, id), metric: met(unit, m), ...big }));
      expect(s).toMatchObject({ text: null, suppressed: 'structure' });
    }
  });

  it('cell shares get no strategy on any dimension, including strong vs novice', () => {
    expect(buildStrategy(f({ unit: 'decisive', dimension: dim('decisive', 'playerTier'), metric: met('decisive', 'onYesRight'), diff: 9, withinRole: 8 }))?.suppressed).toBe('context');
    // 四組的對率照樣給
    expect(buildStrategy(f({ unit: 'decisive', dimension: dim('decisive', 'playerTier'), metric: met('decisive', 'onYes'), diff: 9, withinRole: 8 }))?.text).toMatch(/^強者的關鍵場內白對率比較高/);
  });

  it('withheld when the within-role check cannot be made', () => {
    expect(buildStrategy(f({ withinRole: null }))).toMatchObject({ text: null, suppressed: 'role' });
    expect(buildStrategy(f({ withinRole: undefined }))).toMatchObject({ text: null, suppressed: 'role' });
  });

  it('no template claims what was not measured', () => {
    const lines: string[] = [];
    for (const m of DISCOVERY_METRICS.filter((x) => isEventUnit(x.unit))) {
      for (const [diff, a, b] of [[20, 70, 50], [-20, 50, 70]] as const) {
        const s = buildStrategy(f({ unit: m.unit, metric: m, dimension: dim(m.unit, 'tableTier'), diff, withinRole: diff, a: { label: '高端', value: a, n: 300, units: 300 }, b: { label: '歡樂', value: b, n: 300, units: 300 } }));
        if (s?.text) lines.push(s.text);
      }
    }
    expect(lines.length).toBeGreaterThan(10);
    for (const l of lines) expect(l).not.toMatch(/梅林的提示|放心|可以參考藍方的票型/);
  });
});
