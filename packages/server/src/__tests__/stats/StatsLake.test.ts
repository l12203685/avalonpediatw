/**
 * 複合篩選的 lake 區塊與 L141「湖中宣告可信度」（Edward 2026-10-14「我希望所有數據都有可以複合篩選的功能 …
 * 線瓦/面瓦、娛樂局、排除某些條件玩家」；r9 設計 §3.6：lake 與 L141 在篩選後的局上重算）。
 *
 * 六局虛構的局（名字全是虛構的），每個數字都是手算的：分組順序 = 第一次出現的順序、沒有結果的局也算進分母、
 * 持湖座位查不到角色時整個湖不算、目標查不到時陣營是空字串、湖行座位查不到時當忠臣（藍方）、Python 的
 * 五成雙（rnd1、f"{x:.0f}"）。Wilson 區間的期望值是 generate_cache.wilson_interval 算的。
 */
import { describe, expect, it } from 'vitest';
import {
  applyFilter,
  claimCell,
  computeFeatureStudies,
  computeLake,
  computeLakeClaimFeature,
  decodeGamesDataset,
  refreshFeatureStudies,
  wilsonInterval,
  type Clause,
  type FeatureStudiesSection,
  type GameFilter,
} from '@avalon/shared/stats';
import { TEN, makeDataset, type GameSpec } from './datasetBuilder';

const AS_OF = '2026-10-14';

// 配置 123456：1 刺客、2 莫甘娜、3 莫德雷德、4 奧伯倫（紅方）；5 派西維爾、6 梅林、7 8 9 0 忠臣（藍方）。
// lakes：首湖 / 二湖 / 三湖 各兩字元（持湖、目標；"--" = 沒有）。claims：文字記錄的湖行，每條「持湖 目標 x/o/-」。
const SPECS: GameSpec[] = [
  // 首湖 7→1（藍→紅）；湖行 7>1 說紅（屬實）
  { id: 'A', cat: '線瓦', date: '2026-01-05', outcome: '三紅', lakes: '71----', claims: '71x' },
  // 首湖 1→7（紅→藍）、二湖 2→6（紅→藍）；1>7 說藍（屬實）、2>6 說紅（不實）
  { id: 'B', cat: '線瓦', date: '2026-01-10', outcome: '三藍活', kill: '7', lakes: '1726--', claims: '17o26x' },
  // 首湖 5→?（目標查不到角色）；5>? 說藍（? 當忠臣 → 屬實）。只有這局有「虛構子」。
  {
    id: 'C', cat: '面瓦', date: '2026-02-01', outcome: '三藍死', kill: '6', lakes: '5?----', claims: '5?o',
    names: [...TEN.slice(0, 9), '虛構子'],
  },
  // 持湖 ? → 首湖整個不算；沒有結果。湖行 ?>7 說紅（持湖 ? 當藍方，目標 7 藍 → 不實）
  { id: 'D', cat: '面瓦', outcome: '', lakes: '?7----', claims: '?7x' },
  // 首湖 6→8（藍→藍）、二湖 3→5（紅→藍）；沒有結果；6>8 沒宣告、3>5 說紅（不實）
  { id: 'E', cat: '娛樂', date: '2025-12-31', outcome: '', lakes: '6835--', claims: '68-35x' },
  // 首湖 7→8、二湖 8→9（藍→藍）、三湖 0→4（藍→紅）；三條湖行都屬實
  { id: 'F', cat: '線瓦', date: '2026-03-01', outcome: '三藍活', kill: '1', lakes: '788904', claims: '78o89o04x' },
];
const decoded = decodeGamesDataset(makeDataset(SPECS));
const config = decoded.config;

function gamesOf(...clauses: Clause[]) {
  return applyFilter(decoded, { asOf: AS_OF }, { v: 1, clauses }).games;
}

/** 三結果（數字照抄手算，不在這裡算）。 */
function o(threeRed: number, threeBlueDead: number, threeBlueAlive: number, pcts: [number, number, number]) {
  return {
    threeRed, threeBlueDead, threeBlueAlive,
    threeRedPct: pcts[0], threeBlueDeadPct: pcts[1], threeBlueAlivePct: pcts[2],
  };
}
const NONE = o(0, 0, 0, [0, 0, 0]);
const ALIVE1 = o(0, 0, 1, [0, 0, 100]);

describe('lake section (compute_lake), hand-calculated', () => {
  const lake = computeLake(decoded.games);

  it('perLake: games with a holder whose role is known, grouped in first-seen order', () => {
    expect(lake.perLake.map((l) => [l.lake, l.totalGames])).toEqual([['首湖', 5], ['二湖', 3], ['三湖', 1]]);
    expect(lake.perLake[0]).toEqual({
      lake: '首湖',
      totalGames: 5, // A B C E F（D 的持湖是 ?）
      holderStats: [
        // A C E F：紅勝只有 A；E 沒有結果仍在分母
        { faction: '藍方', games: 4, redWinRate: 25, outcomes: o(1, 1, 1, [25, 25, 25]) },
        { faction: '紅方', games: 1, redWinRate: 0, outcomes: ALIVE1 },
      ],
      comboStats: [
        { holderFaction: '藍方', targetFaction: '紅方', games: 1, redWinRate: 100, outcomes: o(1, 0, 0, [100, 0, 0]) },
        { holderFaction: '紅方', targetFaction: '藍方', games: 1, redWinRate: 0, outcomes: ALIVE1 },
        { holderFaction: '藍方', targetFaction: '', games: 1, redWinRate: 0, outcomes: o(0, 1, 0, [0, 100, 0]) },
        { holderFaction: '藍方', targetFaction: '藍方', games: 2, redWinRate: 0, outcomes: o(0, 0, 1, [0, 0, 50]) },
      ],
    });
    expect(lake.perLake[1].holderStats).toEqual([
      { faction: '紅方', games: 2, redWinRate: 0, outcomes: o(0, 0, 1, [0, 0, 50]) }, // B E
      { faction: '藍方', games: 1, redWinRate: 0, outcomes: ALIVE1 }, // F
    ]);
    expect(lake.perLake[2].comboStats).toEqual([
      { holderFaction: '藍方', targetFaction: '紅方', games: 1, redWinRate: 0, outcomes: ALIVE1 },
    ]);
  });

  it('holderRoleStats / targetRoleStats: 首湖 only, a target without a role is left out', () => {
    expect(lake.holderRoleStats).toEqual([
      { role: '忠臣', games: 2, redWinRate: 50, blueWinRate: 50, outcomes: o(1, 0, 1, [50, 0, 50]) }, // A F
      { role: '刺客', games: 1, redWinRate: 0, blueWinRate: 100, outcomes: ALIVE1 }, // B
      { role: '派西維爾', games: 1, redWinRate: 0, blueWinRate: 100, outcomes: o(0, 1, 0, [0, 100, 0]) }, // C：三藍死也是藍勝（任務階段）
      { role: '梅林', games: 1, redWinRate: 0, blueWinRate: 0, outcomes: NONE }, // E：沒有結果
    ]);
    expect(lake.targetRoleStats).toEqual([
      { role: '刺客', games: 1, redWinRate: 100, outcomes: o(1, 0, 0, [100, 0, 0]) }, // A
      { role: '忠臣', games: 3, redWinRate: 0, outcomes: o(0, 0, 2, [0, 0, 66.7]) }, // B E F
    ]);
  });

  it('allLakeRoleStats: per lake, same / different faction (an unknown target is in neither)', () => {
    const [l1, l2, l3] = lake.allLakeRoleStats;
    expect(l1.holderRoleStats).toEqual(lake.holderRoleStats);
    expect(l1.targetRoleStats).toEqual(lake.targetRoleStats);
    expect(l1.sameFaction).toEqual({ games: 2, redWinRate: 0, outcomes: o(0, 0, 1, [0, 0, 50]) }); // E F
    expect(l1.diffFaction).toEqual({ games: 2, redWinRate: 50, outcomes: o(1, 0, 1, [50, 0, 50]) }); // A B
    expect(l2.holderRoleStats.map((r) => [r.role, r.games, r.blueWinRate])).toEqual([
      ['莫甘娜', 1, 100], ['莫德雷德', 1, 0], ['忠臣', 1, 100],
    ]);
    expect(l2.targetRoleStats.map((r) => r.role)).toEqual(['梅林', '派西維爾', '忠臣']);
    expect(l2.diffFaction).toEqual({ games: 2, redWinRate: 0, outcomes: o(0, 0, 1, [0, 0, 50]) }); // B E
    expect(l3.sameFaction).toEqual({ games: 0, redWinRate: 0, outcomes: NONE });
    expect(l3.diffFaction).toEqual({ games: 1, redWinRate: 0, outcomes: ALIVE1 });
  });

  it('no game with a lake: every list is empty', () => {
    expect(computeLake(gamesOf({ kind: 'gameId', in: ['D'] }))).toEqual({
      perLake: [], holderRoleStats: [], targetRoleStats: [], allLakeRoleStats: [],
    });
  });
});

describe('lake section under filters (the numbers move as the hand calculation says)', () => {
  it('只看線瓦 (A B F)', () => {
    const lake = computeLake(gamesOf({ kind: 'category', in: ['線瓦'] }));
    expect(lake.perLake.map((l) => l.totalGames)).toEqual([3, 2, 1]);
    expect(lake.perLake[0].holderStats).toEqual([
      { faction: '藍方', games: 2, redWinRate: 50, outcomes: o(1, 0, 1, [50, 0, 50]) }, // A F
      { faction: '紅方', games: 1, redWinRate: 0, outcomes: ALIVE1 }, // B
    ]);
    expect(lake.targetRoleStats).toEqual([
      { role: '刺客', games: 1, redWinRate: 100, outcomes: o(1, 0, 0, [100, 0, 0]) },
      { role: '忠臣', games: 2, redWinRate: 0, outcomes: o(0, 0, 2, [0, 0, 100]) }, // B F
    ]);
  });

  it('排除娛樂局 (E out): 二湖 loses its 莫德雷德 holder, 首湖 its 梅林 holder', () => {
    const lake = computeLake(gamesOf({ kind: 'category', in: ['娛樂'], not: true }));
    expect(lake.perLake.map((l) => l.totalGames)).toEqual([4, 2, 1]);
    expect(lake.perLake[0].holderStats[0]).toEqual(
      { faction: '藍方', games: 3, redWinRate: 33.3, outcomes: o(1, 1, 1, [33.3, 33.3, 33.3]) }, // A C F：1 / 3
    );
    expect(lake.holderRoleStats.map((r) => r.role)).toEqual(['忠臣', '刺客', '派西維爾']);
    expect(lake.allLakeRoleStats[1].holderRoleStats.map((r) => r.role)).toEqual(['莫甘娜', '忠臣']);
  });

  it('dropping the games of a player (排除玩家：丟掉他們的局) takes C out', () => {
    const app = applyFilter(decoded, { asOf: AS_OF }, {
      v: 1, clauses: [{ kind: 'excludePlayers', scope: 'dropGames', who: { by: 'names', names: ['虛構子'] } }],
    });
    expect(app.games.map((g) => g.id)).toEqual(['A', 'B', 'D', 'E', 'F']);
    const lake = computeLake(app.games);
    expect(lake.perLake[0].comboStats.map((c) => `${c.holderFaction}|${c.targetFaction}`))
      .toEqual(['藍方|紅方', '紅方|藍方', '藍方|藍方']); // 「藍方|」只在 C
    expect(lake.holderRoleStats.map((r) => r.role)).toEqual(['忠臣', '刺客', '梅林']);
  });

  it('hiding players (只是不上榜) changes nothing here', () => {
    const app = applyFilter(decoded, { asOf: AS_OF }, {
      v: 1, clauses: [{ kind: 'excludePlayers', scope: 'hideFromLists', who: { by: 'names', names: ['虛構子'] } }],
    });
    expect(computeLake(app.games)).toEqual(computeLake(decoded.games));
  });
});

describe('L141 lake claim reliability (compute_lake_claim_feature), hand-calculated', () => {
  const feature = computeLakeClaimFeature(decoded.games, config, AS_OF);

  it('cells by lake line and declaration; undeclared lines and games without a result count', () => {
    expect(feature.sampleSize).toEqual({ games: 6, links: 10 });
    expect(feature.data.undeclared).toBe(1);
    expect(feature.data.minSample).toBe(30);
    expect(feature.data.rows.map((r) => [r.lake, r.declared, r.n, r.hits, r.hitRate, r.ciLow, r.ciHigh, r.lowSample])).toEqual([
      ['首湖', '紅', 2, 1, 50, 9.5, 90.5, true], // A 屬實、D 不實
      ['首湖', '藍', 3, 3, 100, 43.9, 100, true], // B C F
      ['二湖', '紅', 2, 0, 0, 0, 65.8, true], // B E
      ['二湖', '藍', 1, 1, 100, 20.7, 100, true], // F
      ['三湖', '紅', 1, 1, 100, 20.7, 100, true], // F
      ['三湖', '藍', 0, 0, 0, 0, 0, true],
    ]);
    expect(feature.data.rows[0]).toEqual({
      lake: '首湖', lakeEn: 'Lake 1', declared: '紅', declaredEn: 'evil', n: 2, hits: 1, hitRate: 50, ciLow: 9.5, ciHigh: 90.5, lowSample: true,
    });
  });

  it('cells by the holder’s faction (a holder seat without a role counts as 忠臣 = 藍)', () => {
    expect(feature.data.holderRows.map((r) => [r.holder, r.holderEn, r.declared, r.n, r.hits, r.hitRate, r.ciLow, r.ciHigh])).toEqual([
      ['藍', 'good', '紅', 3, 2, 66.7, 20.8, 93.9], // A 屬實、D（持湖 ?）不實、F 三湖屬實
      ['藍', 'good', '藍', 3, 3, 100, 43.9, 100], // C F F
      ['紅', 'evil', '紅', 2, 0, 0, 0, 65.8], // B E
      ['紅', 'evil', '藍', 1, 1, 100, 20.7, 100], // B
    ]);
  });

  it('the zh / en sentences, word for word', () => {
    expect(feature.oneLineHook).toBe(
      '持湖者說紅時，目標真的是紅方：首湖 50.0%（n=2）、二湖 0.0%（n=2）、三湖 100.0%（n=1）；'
      + '說藍時目標真的是藍方：首湖 100.0%（n=3）、二湖 100.0%（n=1）、三湖 0.0%（n=0）；n < 30 的格子樣本不足',
    );
    expect(feature.oneLineHookEn).toBe(
      'When the lake holder says evil, the target really is evil: Lake 1 50.0% (n=2), Lake 2 0.0% (n=2), Lake 3 100.0% (n=1); '
      + 'when they say good, the target really is good: Lake 1 100.0% (n=3), Lake 2 100.0% (n=1), Lake 3 0.0% (n=0); '
      + 'cells with n < 30 are small samples',
    );
    // 紅方持湖合計 1 / 3 = 33.3% → 「約 33%」
    expect(feature.takeaway).toBe(
      '藍方持湖幾乎不說謊（說紅 66.7%、說藍 100.0% 屬實），所以看到湖中宣告先判斷持湖者的陣營，再決定信不信；'
      + '紅方持湖宣告的可信度只有約 33%（說紅 0.0%、說藍 100.0% 屬實，n=3），紅方說「紅」多半是在誣陷藍方。',
    );
    expect(feature.takeawayEn).toBe(
      'A good lake holder almost never lies (66.7% of their evil calls and 100.0% of their good calls are true), '
      + "so judge the holder's side first; an evil holder's claim is right only about 33% of the time "
      + '(0.0% of evil calls, 100.0% of good calls, n=3): an evil holder calling someone evil is usually framing a good player.',
    );
    expect([feature.loopId, feature.visualType, feature.sourceReport, feature.computedAt])
      .toEqual(['L141', 'lakeClaim', 'generate_cache.py', AS_OF]);
  });

  it('只看線瓦 (A B F): 6 lines, nothing undeclared', () => {
    const online = computeLakeClaimFeature(gamesOf({ kind: 'category', in: ['線瓦'] }), config, AS_OF);
    expect(online.sampleSize).toEqual({ games: 3, links: 6 });
    expect(online.data.undeclared).toBe(0);
    expect(online.data.rows.map((r) => [r.n, r.hits])).toEqual([[1, 1], [2, 2], [1, 0], [1, 1], [1, 1], [0, 0]]);
    expect(online.data.holderRows.map((r) => [r.n, r.hits, r.hitRate])).toEqual([[2, 2, 100], [2, 2, 100], [1, 0, 0], [1, 1, 100]]);
  });

  it('a date range moves computedAt / generatedAt to its end (the effective as-of day)', () => {
    const filter: GameFilter = { v: 1, clauses: [{ kind: 'date', from: '2025-12-01', to: '2026-01-31' }] };
    const app = applyFilter(decoded, { asOf: AS_OF }, filter);
    expect(app.games.map((g) => g.id)).toEqual(['A', 'B', 'E']);
    const studies = computeFeatureStudies(app.games, config, app.asOf);
    expect(studies.generatedAt).toBe('2026-01-31');
    expect(studies.sampleSize).toEqual({ games: 3, lakeLinks: 5 });
    const l141 = studies.features[0] as ReturnType<typeof computeLakeClaimFeature>;
    expect(l141.computedAt).toBe('2026-01-31');
    expect(l141.data.undeclared).toBe(1);
  });
});

describe('Python rounding in L141', () => {
  it('rnd1 is half to even: 1 of 16 = 6.25% → 6.2 (Math.round would give 6.3)', () => {
    expect(claimCell(1, 16, 30)).toEqual({ n: 16, hits: 1, hitRate: 6.2, ciLow: 1.1, ciHigh: 28.3, lowSample: true });
  });

  it('f"{x:.0f}" is half to even: an evil holder right 5 of 8 times = 62.5% → 「約 62%」 (toFixed gives 63)', () => {
    const specs: GameSpec[] = [
      ...Array.from({ length: 5 }, (): GameSpec => ({ claims: '17o' })), // 紅方說藍、屬實
      ...Array.from({ length: 3 }, (): GameSpec => ({ claims: '26x' })), // 紅方說紅、不實
    ];
    const f = computeLakeClaimFeature(decodeGamesDataset(makeDataset(specs)).games, config, AS_OF);
    expect(f.takeaway).toContain('紅方持湖宣告的可信度只有約 62%（說紅 0.0%、說藍 100.0% 屬實，n=8）');
    expect(f.takeawayEn).toContain('right only about 62% of the time');
  });

  it('wilsonInterval: no sample, all hits, no hits', () => {
    expect(wilsonInterval(0, 0)).toEqual([0, 0]);
    expect(wilsonInterval(2, 2)).toEqual([34.2, 100]);
    expect(wilsonInterval(0, 1)).toEqual([0, 79.3]);
    expect(wilsonInterval(5, 8)).toEqual([30.6, 86.3]);
  });

  it('lowSample follows the dataset config (lakeClaimMinSample)', () => {
    const f = computeLakeClaimFeature(decoded.games, { ...config, lakeClaimMinSample: 2 }, AS_OF);
    expect(f.data.minSample).toBe(2);
    expect(f.data.rows.map((r) => r.lowSample)).toEqual([false, false, false, true, true, true]);
  });
});

describe('featureStudies: the filtered L141 swapped into the served section (refresh_feature_studies)', () => {
  const feature = computeLakeClaimFeature(decoded.games, config, AS_OF);

  it('replaces L141 in place; the other studies, extra keys and extra sampleSize keys stay', () => {
    const previous: FeatureStudiesSection = {
      generatedAt: '2025-01-01',
      sampleSize: { games: 1, lakeLinks: 1, proposals: 7 },
      note: '虛構的沿用區塊',
      features: [{ loopId: 'L901', title: '虛構研究甲' }, { loopId: 'L141', title: '舊的' }, { loopId: 'L902' }],
    };
    const out = refreshFeatureStudies(previous, feature, AS_OF);
    expect(Object.keys(out)).toEqual(['generatedAt', 'sampleSize', 'note', 'features']);
    expect(out.generatedAt).toBe(AS_OF);
    expect(out.sampleSize).toEqual({ games: 6, lakeLinks: 10, proposals: 7 });
    expect(out.features.map((f) => f.loopId)).toEqual(['L901', 'L141', 'L902']);
    expect(out.features[1]).toBe(feature);
    expect(previous.features[1]).toEqual({ loopId: 'L141', title: '舊的' }); // 不改呼叫者的物件
  });

  it('without L141 it goes first; without a section it is the only study', () => {
    const out = refreshFeatureStudies({ generatedAt: 'x', sampleSize: { games: 0, lakeLinks: 0 }, features: [{ loopId: 'L142' }] }, feature, AS_OF);
    expect(out.features.map((f) => f.loopId)).toEqual(['L141', 'L142']);
    expect(refreshFeatureStudies(null, feature, AS_OF)).toEqual({
      generatedAt: AS_OF, sampleSize: { games: 6, lakeLinks: 10 }, features: [feature],
    });
  });
});
