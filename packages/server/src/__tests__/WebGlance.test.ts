/**
 * 數據分析「一眼看懂」的一句話與比例（web components/analysis/core/glance；站長 2026-11-25：「關於數據分析…希望能更直觀
 * 讓看到的人一目瞭然」）：
 *  - 句子裡的數字跟長條出自同一個結果，都從傳進來的資料算（合成的計數，不是寫死的結論）；
 *  - 句型跟著資料換：失敗後比較低才寫「只贏」，反過來寫「反而贏」，一樣就不比；
 *  - 兩段比例條加起來一定是 100%；沒有資料時回 null（畫面不寫 0%）；
 *  - 每一個句型在繁中、英文都有字，而且句子裡真的填了那些數字；
 *  - 自動發現卡片的差距寫成白話（多／少幾個百分點）。
 * 第二批（同日）：刺殺、任務路徑、湖中女神的角色與宣告、派隊與投票內頁的句子與長條；三藍死（梅林被刺中）改用紅色系。
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  anyThin, blueWinShare, captainGlance, extremes, firstTeamGlance, killDetailGlance, killGlance, lakeClaimGlance, lakeHolderGlance, missionOneGlance,
  missionRatesGlance, missionSwingGlance, overallGlance, pathsGlance, pctText, relation, restText, roleRankGlance, seatHalvesSentence, seatKillGlance,
  shareText, shownPct, twoRedGlance, twoWay, votersGlance, votesGlance, type Sentence,
} from '../../../web/src/components/analysis/core/glance';
import { OUTCOME_COLORS, TONE_HEX } from '../../../web/src/components/analysis/ui/tokens';
import { formatDiffPlain } from '../../../web/src/components/analysis/discovery/discoveryText';

const web = path.resolve(__dirname, '..', '..', '..', 'web', 'src');
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 讀 i18n JSON，結構很深
const load = (lang: string): Record<string, any> => JSON.parse(fs.readFileSync(path.join(web, 'i18n', 'locales', lang, 'common.json'), 'utf-8'));

/** 三種結局的計數：三紅、三藍死、三藍活。 */
const oc = (threeRed: number, threeBlueDead: number, threeBlueAlive: number) => ({ threeRed, threeBlueDead, threeBlueAlive });

/** 把句子的鍵換成那個語言的字，填進數字（跟 i18next 的 {{name}} 一樣）。 */
function render(lang: string, s: Sentence): string {
  const text = s.key.split('.').reduce<unknown>((node, k) => (node as Record<string, unknown> | undefined)?.[k], load(lang).analytics.glance);
  expect(typeof text, `${lang} analytics.glance.${s.key}`).toBe('string');
  return (text as string).replace(/\{\{(\w+)\}\}/g, (_m, name: string) => {
    expect(s.params[name], `${s.key} 缺 ${name}`).toBeDefined();
    return String(s.params[name]);
  });
}

describe('一眼看懂：數字的寫法', () => {
  it('百分比顯示整數；兩段比例條的另一段用減的，加起來 100%', () => {
    expect(pctText(23.6)).toBe('24%');
    expect(shownPct(43.5) + Number(restText(43.5).replace('%', ''))).toBe(100);
    // 各自四捨五入會變成 44% + 57%
    expect(pctText(43.5)).toBe('44%');
    expect(restText(43.5)).toBe('56%');
    expect(restText(100)).toBe('0%');
  });

  it('高低用顯示出來的整數比：23.6% 跟 24.4% 都是 24%，算一樣', () => {
    expect(relation(23.6, 24.4)).toBe('same');
    expect(relation(23.4, 24.4)).toBe('lower');
    expect(relation(40, 24)).toBe('higher');
  });

  it('藍方最後贏 = 三藍活 ÷ 局數（中文鍵、英文鍵都收）；0 局時 null', () => {
    expect(blueWinShare(oc(45, 24, 31))).toEqual({ pct: 31, n: 100 });
    expect(blueWinShare({ 三紅: 1, 三藍死: 1, 三藍活: 2 })).toEqual({ pct: 50, n: 4 });
    expect(blueWinShare(oc(0, 0, 0))).toBeNull();
    expect(blueWinShare(undefined)).toBeNull();
  });
});

describe('一眼看懂：樣本少要標出來', () => {
  it('有一組不到門檻就算；沒有資料的組不算', () => {
    expect(anyThin(30, { pct: 40, n: 982 }, { pct: 24, n: 1374 })).toBe(false);
    expect(anyThin(30, { pct: 30, n: 10 }, { pct: 40, n: 100 })).toBe(true);
    expect(anyThin(30, { pct: 30, n: 30 }, null, undefined)).toBe(false);
  });

  it('兩種語言都有「樣本少」的字', () => {
    for (const lang of ['zh-TW', 'en']) {
      const glance = load(lang).analytics.glance;
      expect(glance.thin).toBeTruthy();
      expect(glance.thinNote).toContain('{{min}}');
    }
  });
});

describe('一眼看懂：總覽——誰比較常贏', () => {
  const stages = (bluePct: number) => ({
    final: { games: 200, bluePct },
    mission: { redPct: 45 },
    assassination: { merlinKilled: 48 },
  });

  it('紅方多很多：句子、大數字都是紅方，兩個數字加起來 100%', () => {
    const g = overallGlance(stages(31))!;
    expect(g).toMatchObject({ games: 200, blue: 31, lead: 'red', threeRed: 45, killed: 24 });
    expect(g.sentence).toEqual({ key: 'overall.redAhead', params: { red: '69%', blue: '31%' } });
    expect(render('zh-TW', g.sentence)).toBe('紅方比較常贏：紅方贏 69%，藍方贏 31%。');
  });

  it('藍方多、差不多時換句型（篩選後可能反過來）', () => {
    expect(overallGlance(stages(60))!.sentence.key).toBe('overall.blueAhead');
    expect(overallGlance(stages(60))!.lead).toBe('blue');
    expect(overallGlance(stages(49))!.sentence.key).toBe('overall.even');
    expect(overallGlance(stages(51.4))!.sentence.key).toBe('overall.even');
  });

  it('沒有資料、0 局：null', () => {
    expect(overallGlance(null)).toBeNull();
    expect(overallGlance({ ...stages(31), final: { games: 0, bluePct: 0 } })).toBeNull();
  });
});

describe('一眼看懂：任務結果', () => {
  it('第 1 個任務：失敗的局藍方贏得少 → 「只贏」，數字是那兩組局自己算的', () => {
    const g = missionOneGlance([
      { passed: true, outcomes: oc(30, 30, 40) },
      { passed: false, outcomes: oc(100, 52, 48) },
    ])!;
    expect(g.passed).toEqual({ pct: 40, n: 100 });
    expect(g.failed).toEqual({ pct: 24, n: 200 });
    expect(g.sentence).toEqual({ key: 'missions.m1.failLower', params: { passed: '40%', failed: '24%' } });
    expect(render('zh-TW', g.sentence)).toBe('第 1 個任務失敗的局，藍方最後只贏 24%；成功的局贏 40%。');
  });

  it('資料反過來就不寫「只贏」；一樣就不比；缺一邊 null', () => {
    const flipped = missionOneGlance([{ passed: true, outcomes: oc(8, 0, 2) }, { passed: false, outcomes: oc(5, 0, 5) }])!;
    expect(flipped.sentence.key).toBe('missions.m1.failHigher');
    expect(render('zh-TW', flipped.sentence)).toContain('反而贏 50%');
    const same = missionOneGlance([{ passed: true, outcomes: oc(7, 0, 3) }, { passed: false, outcomes: oc(14, 0, 6) }])!;
    expect(same.sentence.key).toBe('missions.m1.same');
    expect(missionOneGlance([{ passed: true, outcomes: oc(7, 0, 3) }])).toBeNull();
    expect(missionOneGlance([{ passed: true, outcomes: oc(7, 0, 3) }, { passed: false, outcomes: oc(0, 0, 0) }])).toBeNull();
    expect(missionOneGlance(undefined)).toBeNull();
  });

  it('刺殺：藍方做完三個任務的局裡刺中多少；沒有三藍局時 null', () => {
    const g = killGlance({ games: 1289, killPct: 43.5 })!;
    expect(g.hit).toEqual({ pct: 43.5, n: 1289 });
    expect(render('zh-TW', g.sentence)).toBe('藍方做完三個任務的局，刺客刺中梅林 44%。');
    expect(killGlance({ games: 0, killPct: 0 })).toBeNull();
    expect(killGlance(null)).toBeNull();
  });

  it('各任務成功率：最難、最容易的任務從資料找；沒有成功率的任務不畫', () => {
    const g = missionRatesGlance([
      { round: 1, n: 100, successRate: 42 },
      { round: 2, n: 100, successRate: 29 },
      { round: 3, n: 99, successRate: 46 },
      { round: 4, n: 60, successRate: 84 },
      { round: 5, n: 30, successRate: null },
    ]);
    expect(g.rows.map(r => r.round)).toEqual([1, 2, 3, 4]);
    expect(g.hardest).toBe(2);
    expect(g.easiest).toBe(4);
    expect(render('zh-TW', g.sentence!)).toBe('最難成功的是任務 2（29%），最容易的是任務 4（84%）。');
  });

  it('各任務成功率：只有一個任務、或全部一樣時不硬說最難最容易', () => {
    expect(missionRatesGlance([{ round: 1, n: 10, successRate: 50 }]).sentence).toBeNull();
    const flat = missionRatesGlance([{ round: 1, n: 10, successRate: 50.2 }, { round: 2, n: 10, successRate: 49.8 }]);
    expect(flat.sentence).toBeNull();
    expect(flat.hardest).toBeNull();
    expect(missionRatesGlance(null).rows).toEqual([]);
  });

  it('任務 → 結局：差最多的任務不算任務 4；差距用顯示的整數相減', () => {
    const g = missionSwingGlance([
      { round: 1, passedOutcomes: oc(30, 30, 40), failedOutcomes: oc(100, 52, 48) },   // 40% vs 24%，差 16
      { round: 2, passedOutcomes: oc(20, 20, 60), failedOutcomes: oc(60, 20, 20) },    // 60% vs 20%，差 40
      { round: 4, passedOutcomes: oc(0, 5, 95), failedOutcomes: oc(95, 5, 0) },        // 差 95，但不算
    ]);
    expect(g.rows).toHaveLength(3);
    expect(g.widest).toBe(2);
    expect(g.sentence).toEqual({ key: 'missions.swing.failLower', params: { round: 2, gap: 40, passed: '60%', failed: '20%' } });
    expect(render('zh-TW', g.sentence!)).toBe('影響最大的是任務 2：成功的局藍方最後贏 60%，失敗的局只贏 20%，差 40 個百分點。');
  });

  it('任務 → 結局：缺一邊的任務不畫；只剩任務 4 或沒資料時沒有一句話', () => {
    const g = missionSwingGlance([
      { round: 1, passedOutcomes: oc(1, 1, 2) },
      { round: 4, passedOutcomes: oc(0, 5, 95), failedOutcomes: oc(95, 5, 0) },
    ]);
    expect(g.rows.map(r => r.round)).toEqual([4]);
    expect(g.sentence).toBeNull();
    expect(g.widest).toBeNull();
    expect(missionSwingGlance(undefined)).toEqual({ rows: [], widest: null, sentence: null });
  });
});

describe('一眼看懂：湖中女神', () => {
  it('湖在紅方手上藍方贏得少 → 「只贏」；叫法原樣放進句子', () => {
    const g = lakeHolderGlance([
      { faction: '紅方', outcomes: oc(50, 23, 27) },
      { faction: '藍方', outcomes: oc(80, 54, 66) },
    ], '首位接湖者')!;
    expect(g.blueHolder).toEqual({ pct: 33, n: 200 });
    expect(g.redHolder).toEqual({ pct: 27, n: 100 });
    expect(render('zh-TW', g.sentence)).toBe('首位接湖者是藍方的局，藍方最後贏 33%；是紅方的局只贏 27%。');
  });

  it('反過來、一樣、缺一方', () => {
    const hi = lakeHolderGlance([{ faction: '紅方', outcomes: oc(5, 0, 5) }, { faction: '藍方', outcomes: oc(8, 0, 2) }], 'X')!;
    expect(hi.sentence.key).toBe('lake.redHigher');
    const same = lakeHolderGlance([{ faction: '紅方', outcomes: oc(7, 0, 3) }, { faction: '藍方', outcomes: oc(7, 0, 3) }], 'X')!;
    expect(same.sentence.key).toBe('lake.same');
    expect(lakeHolderGlance([{ faction: '藍方', outcomes: oc(7, 0, 3) }], 'X')).toBeNull();
    expect(lakeHolderGlance(null, 'X')).toBeNull();
  });
});

describe('一眼看懂：派隊與投票', () => {
  const pooled = (evil: number, good: number) => ({
    evilAll: { votes: 1000, rate: evil },
    goodAll: { votes: 400, rate: good },
  });

  it('全藍的隊反對 = 100 − 贊成；過半時寫「也有」', () => {
    const g = votesGlance(pooled(62.2, 45.1))!;
    expect(g.withRed).toEqual({ pct: 62.2, n: 1000 });
    expect(g.allBlueApprove).toEqual({ pct: 45.1, n: 400 });
    expect(g.sentence).toEqual({ key: 'votes.blueAlsoHalf', params: { withRed: '62%', allBlue: '55%' } });
    expect(render('zh-TW', g.sentence)).toBe('有紅方的隊，62% 的票投反對；全是藍方的隊也有 55% 的票投反對。');
  });

  it('句型跟著資料換', () => {
    expect(votesGlance(pooled(62, 70))!.sentence.key).toBe('votes.blueLower');
    expect(votesGlance(pooled(40, 30))!.sentence.key).toBe('votes.blueHigher');
    expect(votesGlance(pooled(55, 45))!.sentence.key).toBe('votes.same');
  });

  it('舊快取沒有票數、0 票：null', () => {
    expect(votesGlance(null)).toBeNull();
    expect(votesGlance({ evilAll: { votes: 0, rate: null }, goodAll: { votes: 10, rate: 50 } })).toBeNull();
    expect(votesGlance({ evilAll: { votes: 10, rate: 50 } })).toBeNull();
  });
});

describe('一眼看懂（第二批）：刺殺', () => {
  it('刺殺結算：梅林被刺中的比例與另一段加起來 100%，句子填同一組數字', () => {
    const g = killDetailGlance({ games: 1289, killPct: 43.5, merlinKilled: 561, merlinSurvived: 728 })!;
    expect(g.hit).toEqual({ pct: 43.5, n: 1289 });
    expect([g.killed, g.survived]).toEqual([561, 728]);
    expect(g.sentence).toEqual({ key: 'kill.flip', params: { hit: '44%', miss: '56%' } });
    expect(render('zh-TW', g.sentence)).toContain('44% 梅林被刺中');
    // 舊快取只有比例：局數從比例推
    expect(killDetailGlance({ games: 200, killPct: 25 })).toMatchObject({ killed: 50, survived: 150 });
    expect(killDetailGlance({ games: 10, killPct: 0 })!.sentence.key).toBe('kill.none');
    expect(killDetailGlance({ games: 10, killPct: 100 })!.sentence.key).toBe('kill.all');
    expect(killDetailGlance({ games: 0, killPct: 0 })).toBeNull();
    expect(killDetailGlance(null)).toBeNull();
  });

  it('座位：最高、最低只比樣本夠的座位；第十個座位照傳進來的寫（0 家）', () => {
    const rows = [
      { seat: '1', dead: 46, n: 100 },
      { seat: '2', dead: 53, n: 100 },
      { seat: '9', dead: 30, n: 100 },
      { seat: '0', dead: 34, n: 100 },
      // 樣本太少：4 局裡 4 局被刺中不算最高
      { seat: '5', dead: 4, n: 4 },
    ];
    const g = seatKillGlance(rows, 'merlin', 30);
    expect(g.rows).toHaveLength(5);
    expect([g.hi, g.lo]).toEqual(['2', '9']);
    expect(g.sentence).toEqual({ key: 'seatKill.merlin', params: { hiSeat: '2', hi: '53%', loSeat: '9', lo: '30%' } });
    expect(render('zh-TW', g.sentence!)).toBe('梅林坐 2 家最常被刺中（53%），坐 9 家最少（30%）：');
    expect(seatKillGlance(rows, 'assassin', 30).sentence!.key).toBe('seatKill.assassin');
    // 都一樣、只有一個座位、沒有資料：不比
    expect(seatKillGlance([{ seat: '1', dead: 5, n: 10 }, { seat: '2', dead: 50, n: 100 }], 'merlin', 5).sentence).toBeNull();
    expect(seatKillGlance([{ seat: '1', dead: 5, n: 10 }], 'merlin', 5).sentence).toBeNull();
    expect(seatKillGlance(null, 'merlin', 5)).toEqual({ rows: [], hi: null, lo: null, sentence: null });
  });

  it('前半、後半座位：句型跟著資料換', () => {
    const front = { pct: 50.2, n: 665 };
    const back = { pct: 37.1, n: 624 };
    expect(seatHalvesSentence(front, back)).toEqual({ key: 'seatKill.backLower', params: { front: '50%', back: '37%' } });
    expect(seatHalvesSentence(back, front)!.key).toBe('seatKill.backHigher');
    expect(seatHalvesSentence(front, { pct: 49.8, n: 10 })!.key).toBe('seatKill.halvesSame');
    expect(seatHalvesSentence(front, null)).toBeNull();
  });

  it('extremes：樣本夠的不到兩個才全部一起比', () => {
    const rows = [{ k: 'a', share: { pct: 80, n: 3 } }, { k: 'b', share: { pct: 40, n: 50 } }, { k: 'c', share: { pct: 20, n: 2 } }];
    expect(extremes(rows, 30)).toMatchObject({ hi: { k: 'a' }, lo: { k: 'c' } });
    expect(extremes([...rows, { k: 'd', share: { pct: 60, n: 40 } }], 30)).toMatchObject({ hi: { k: 'd' }, lo: { k: 'b' } });
  });
});

describe('一眼看懂（第二批）：任務路徑', () => {
  const states = [
    { state: '紅紅紅', games: 290, outcomes: oc(290, 0, 0) },
    { state: '紅藍藍藍', games: 110, outcomes: oc(0, 38, 72) },
    { state: '藍藍藍', games: 100, outcomes: oc(0, 31, 69) },
    { state: '藍紅紅藍藍', games: 70, outcomes: oc(0, 43, 27) },
    { state: '藍紅藍紅紅', games: 3, outcomes: oc(3, 0, 0) },
    // 樣本太少的藍方走法不拿來比最高最低
    { state: '紅藍紅藍藍', games: 2, outcomes: oc(0, 0, 2) },
  ];

  it('分成「三個任務失敗」和「藍方做完三個任務」兩組，分母是全部的局（不是列出來的加總）', () => {
    const g = pathsGlance(states, 1000, 30);
    expect(g.redPaths.map(p => p.path)).toEqual(['紅紅紅', '藍紅藍紅紅']);
    expect(g.bluePaths.map(p => p.path)).toEqual(['紅藍藍藍', '藍藍藍', '藍紅紅藍藍', '紅藍紅藍藍']);
    expect(g.redPaths[0]).toMatchObject({ games: 290, blue: null });
    expect(g.redPaths[0].ofAll).toBeCloseTo(29, 6);
    expect(g.bluePaths[1].blue).toEqual({ pct: 69, n: 100 });
    expect(g.top!.path).toBe('紅紅紅');
    expect(g.sentence).toEqual({ key: 'paths.top', params: { path: '紅紅紅', share: '29%' } });
    expect([g.best, g.worst]).toEqual(['藍藍藍', '藍紅紅藍藍']);
    expect(g.killSentence).toEqual({ key: 'paths.kill', params: { best: '藍藍藍', bestRate: '69%', worst: '藍紅紅藍藍', worstRate: '39%' } });
  });

  it('佔不到 1% 的寫「<1%」，不寫 0%', () => {
    expect(shareText(0.3)).toBe('<1%');
    expect(shareText(0)).toBe('0%');
    expect(shareText(0.6)).toBe('1%');
    expect(shareText(28.9)).toBe('29%');
  });

  it('沒有總局數、沒有資料：空的結果，畫面改顯示原本的表', () => {
    expect(pathsGlance(states, 0, 30).top).toBeNull();
    expect(pathsGlance(null, 100, 30)).toMatchObject({ redPaths: [], bluePaths: [], sentence: null, killSentence: null });
  });
});

describe('一眼看懂（第二批）：湖中女神的角色與宣告', () => {
  it('角色：照藍方最後贏的比例高到低排，句子用藍方勝率', () => {
    const stats = [
      { role: '刺客', outcomes: oc(56, 18, 26) },
      { role: '梅林', outcomes: oc(36, 21, 43) },
      { role: '忠臣', outcomes: oc(43, 26, 31) },
      { role: '奧伯倫', outcomes: oc(2, 0, 2) },
    ];
    const g = roleRankGlance(stats, 'holderRole', '首位接湖者', 30);
    expect(g.rows.map(r => r.role)).toEqual(['奧伯倫', '梅林', '忠臣', '刺客']);
    // 奧伯倫只有 4 局：排在表上，但不拿來當最高
    expect([g.hi, g.lo]).toEqual(['梅林', '刺客']);
    expect(g.sentence).toEqual({ key: 'lake.holderRole', params: { who: '首位接湖者', hi: '梅林', hiRate: '43%', lo: '刺客', loRate: '26%' } });
    expect(render('zh-TW', g.sentence!)).toBe('首位接湖者：拿湖的是梅林時，藍方最後贏最多（43%）；是刺客時最少（26%）：');
    expect(roleRankGlance(stats, 'targetRole', 'X', 30).sentence!.key).toBe('lake.targetRole');
    expect(roleRankGlance([], 'holderRole', 'X', 30)).toEqual({ rows: [], hi: null, lo: null, sentence: null });
  });

  it('宣告：照誰拿湖、第幾次湖分組；紅方拿湖說「紅」比較低才寫「只有」', () => {
    const cell = (extra: Record<string, string>, declaredEn: string, n: number, hitRate: number) => ({ declared: declaredEn === 'evil' ? '紅' : '藍', declaredEn, n, hitRate, ...extra });
    const rows = [
      cell({ lake: '首湖' }, 'evil', 571, 70.1), cell({ lake: '首湖' }, 'good', 1756, 85.7),
      cell({ lake: '二湖' }, 'evil', 304, 84.9), cell({ lake: '二湖' }, 'good', 1072, 89.9),
    ];
    const holderRows = [
      cell({ holderEn: 'evil', holder: '紅' }, 'evil', 339, 26.5), cell({ holderEn: 'evil', holder: '紅' }, 'good', 1121, 63.5),
      cell({ holderEn: 'good', holder: '藍' }, 'evil', 773, 98.7), cell({ holderEn: 'good', holder: '藍' }, 'good', 2141, 99.7),
    ];
    const g = lakeClaimGlance(rows, holderRows);
    expect(g.byLake.map(p => p.key)).toEqual(['首湖', '二湖']);
    expect(g.byLake[0]).toEqual({ key: '首湖', saidRed: { pct: 70.1, n: 571 }, saidBlue: { pct: 85.7, n: 1756 } });
    // 藍方拿湖排前面
    expect(g.byHolder.map(p => p.key)).toEqual(['blue', 'red']);
    expect(g.redHolderSaidRed).toEqual({ pct: 26.5, n: 339 });
    expect(g.sentence).toEqual({ key: 'claim.redLower', params: { blue: '99%', red: '27%' } });
    expect(g.lakeSentence).toEqual({ key: 'claim.byLake', params: { lake: '首湖', saidRed: '70%', saidBlue: '86%' } });
    expect(render('zh-TW', g.sentence!)).toContain('紅方拿湖說「紅」只有 27% 是真的');
    // 沒有依持湖者分的資料（舊快取）：只剩依湖的那一句
    const old = lakeClaimGlance(rows, undefined);
    expect(old.sentence).toBeNull();
    expect(old.lakeSentence!.key).toBe('claim.byLake');
    expect(lakeClaimGlance(null, null)).toEqual({ byLake: [], byHolder: [], redHolderSaidRed: null, sentence: null, lakeSentence: null });
  });
});

describe('一眼看懂（第二批）：派隊與投票的內頁', () => {
  it('第 3 個任務起的票用自己的句型；投票的人比忠臣和紅方', () => {
    const pooled = {
      evilAll: { votes: 1000, rate: 62.2 }, goodAll: { votes: 400, rate: 45.1 },
      evilR3: { votes: 600, rate: 58.1 }, goodR3: { votes: 300, rate: 54.2 },
      loyalR3: { votes: 380, rate: 50.2 }, redR3: { votes: 385, rate: 60.1 },
    };
    const late = votesGlance(pooled, 'evilR3', 'goodR3', 'votesR3')!;
    expect(late.sentence).toEqual({ key: 'votesR3.blueLower', params: { withRed: '58%', allBlue: '46%' } });
    expect(votesGlance(pooled)!.sentence.key).toBe('votes.blueAlsoHalf');
    const v = votersGlance(pooled)!;
    expect(v.loyal).toEqual({ pct: 50.2, n: 380 });
    expect(v.sentence).toEqual({ key: 'voters.higher', params: { a: '50%', b: '60%' } });
    expect(render('zh-TW', v.sentence)).toBe('第 3 個任務起，紅方比忠臣更常投反對：紅方 60% 的票是反對，忠臣 50%。');
    expect(votersGlance({ ...pooled, redR3: { votes: 10, rate: 40 } })!.sentence.key).toBe('voters.lower');
    expect(votersGlance({ loyalR3: { votes: 10, rate: 40 } })).toBeNull();
  });

  it('twoWay：b 比 a 高、低、一樣', () => {
    const a = { pct: 44.4, n: 10 };
    expect(twoWay(a, { pct: 84.1, n: 10 }, 'x')).toEqual({ key: 'x.higher', params: { a: '44%', b: '84%' } });
    expect(twoWay(a, { pct: 10, n: 10 }, 'x', { first: 1 })).toEqual({ key: 'x.lower', params: { first: 1, a: '44%', b: '10%' } });
    expect(twoWay(a, { pct: 44, n: 10 }, 'x')!.key).toBe('x.same');
    expect(twoWay(a, null, 'x')).toBeNull();
  });

  it('隊長：紅方、藍方隊長的任務各失敗多少；紅方當隊長的機會怎麼變', () => {
    const g = captainGlance(
      { red: { failPct: 84.0, missions: 2397 }, blue: { failPct: 44.4, missions: 6839 } },
      [{ mission: 1, redCaptainRate: 35.2, games: 2356 }, { mission: 2, redCaptainRate: 28, games: 2356 }, { mission: 5, redCaptainRate: 10.3, games: 747 }],
    )!;
    expect(g.redFail).toEqual({ pct: 84, n: 2397 });
    expect(g.sentence).toEqual({ key: 'captain.higher', params: { a: '44%', b: '84%' } });
    expect(render('zh-TW', g.sentence)).toBe('紅方當隊長帶出去的任務，84% 失敗；藍方當隊長是 44%。');
    expect(g.perMission.map(m => m.mission)).toEqual([1, 2, 5]);
    expect(g.trend).toEqual({ key: 'captain.trend.lower', params: { first: 1, last: 5, a: '35%', b: '10%' } });
    expect(render('zh-TW', g.trend!)).toBe('紅方當隊長的機會從任務 1 的 35% 降到任務 5 的 10%。');
    expect(captainGlance({ red: { failPct: 30, missions: 10 }, blue: { failPct: 50, missions: 10 } }, [])!).toMatchObject({ sentence: { key: 'captain.lower' }, trend: null });
    expect(captainGlance({ red: { failPct: null, missions: 10 }, blue: { failPct: 50, missions: 10 } }, [])).toBeNull();
  });

  it('第一支隊伍：有沒有梅林、有幾個紅方 → 藍方最後贏的比例', () => {
    const g = firstTeamGlance(
      { merlinInTeam: { outcomes: oc(45, 24, 31) }, merlinNotInTeam: { outcomes: oc(450, 240, 310) }, percivalInTeam: { outcomes: oc(46, 24, 30) } },
      [{ redCount: 0, outcomes: oc(40, 26, 34) }, { redCount: 1, outcomes: oc(45, 24, 31) }, { redCount: 2, outcomes: oc(47, 24, 29) }, { redCount: 3, outcomes: oc(0, 1, 1) }],
      30,
    );
    expect(g.merlinIn).toEqual({ pct: 31, n: 100 });
    expect(g.percivalOut).toBeNull();
    expect(g.merlinSentence).toEqual({ key: 'firstTeam.merlin.same', params: { a: '31%', b: '31%' } });
    // 3 個紅方只有 2 局：不當最高
    expect(g.redSentence).toEqual({ key: 'firstTeam.reds', params: { hi: 0, hiRate: '34%', lo: 2, loRate: '29%' } });
    expect(firstTeamGlance(null, null, 30)).toMatchObject({ merlinIn: null, redCounts: [], merlinSentence: null, redSentence: null });
  });

  it('兩紅之後的派隊：每個任務、每個隊長角色派出全藍隊的比例；句子講第一個比得出高低的任務', () => {
    const g = twoRedGlance([
      { round: 3, role: '梅林', cell: { n: 380, allGood: 270 } },
      { round: 3, role: '忠臣', cell: { n: 1595, allGood: 494 } },
      { round: 3, role: '派西維爾', cell: { n: 3, allGood: 3 } },
      { round: 5, role: '梅林', cell: { n: 164, allGood: 130 } },
      { round: 4, role: '梅林', cell: { n: 0, allGood: 0 } },
    ], 5);
    expect(g.rounds.map(r => r.round)).toEqual([3, 5]);
    expect(g.rounds[0].rows[1]).toEqual({ role: '忠臣', clean: { pct: (494 / 1595) * 100, n: 1595 } });
    expect(g.sentence).toEqual({ key: 'twoRed.best', params: { round: 3, hi: '梅林', hiRate: '71%', lo: '忠臣', loRate: '31%' } });
    expect(twoRedGlance([], 5)).toEqual({ rounds: [], sentence: null });
  });
});

describe('顏色：梅林被刺中（三藍死）是紅方贏，用紅色系', () => {
  const rgb = (hex: string): [number, number, number] => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];

  it('三紅是亮紅、三藍死是紫紅（不是琥珀），跟三紅分得出來；三藍活是藍', () => {
    const [r, g, b] = rgb(OUTCOME_COLORS.三藍死);
    expect(r).toBeGreaterThan(g);
    // 琥珀／黃是「綠比藍多很多」；紫紅是藍比綠多、紅最多（站長 2026-11-25：三紅亮紅、三藍死紫紅）
    expect(g - b).toBeLessThan(30);
    expect(b).toBeGreaterThan(g);
    expect(r).toBeGreaterThan(b);
    expect(OUTCOME_COLORS.三紅).toBe('#ef4444');
    expect(OUTCOME_COLORS.三藍死).not.toBe(OUTCOME_COLORS.三紅);
    const [br, , bb] = rgb(OUTCOME_COLORS.三藍活);
    expect(bb).toBeGreaterThan(br);
    expect(TONE_HEX.kill).toBe(OUTCOME_COLORS.三藍死);
  });

  it('畫三種結局的元件沒有自己寫死琥珀色', () => {
    const read = (file: string): string => fs.readFileSync(path.join(web, file), 'utf-8');
    for (const file of ['components/analysis/OutcomeBar.tsx', 'components/analysis/AssassinationCard.tsx']) {
      expect(read(file), file).not.toMatch(/#f59e0b|amber/);
    }
    // 牌譜紀錄的結局標籤
    expect(read('components/records/RecordsGameView.tsx')).not.toMatch(/三藍死: '[^']*amber/);
  });
});

describe('一眼看懂：每個句型兩種語言都有字', () => {
  const sentences: Sentence[] = [
    ...['overall.redAhead', 'overall.blueAhead', 'overall.even'].map(key => ({ key, params: { red: '69%', blue: '31%' } })),
    ...['failLower', 'failHigher', 'same'].map(k => ({ key: `missions.m1.${k}`, params: { passed: '40%', failed: '24%' } })),
    { key: 'missions.kill', params: { rate: '44%' } },
    { key: 'missions.rates', params: { hard: 2, hardRate: '29%', easy: 4, easyRate: '84%' } },
    ...['failLower', 'failHigher', 'same'].map(k => ({ key: `missions.swing.${k}`, params: { round: 1, gap: 16, passed: '40%', failed: '24%' } })),
    ...['redLower', 'redHigher', 'same'].map(k => ({ key: `lake.${k}`, params: { who: '首位接湖者', blue: '33%', red: '27%' } })),
    ...['blueAlsoHalf', 'blueLower', 'blueHigher', 'same'].map(k => ({ key: `votes.${k}`, params: { withRed: '62%', allBlue: '55%' } })),
    // 第二批
    ...['flip', 'none', 'all'].map(k => ({ key: `kill.${k}`, params: { hit: '44%', miss: '56%' } })),
    ...['merlin', 'assassin'].map(k => ({ key: `seatKill.${k}`, params: { hiSeat: '2', hi: '53%', loSeat: '0', lo: '30%' } })),
    ...['backLower', 'backHigher', 'halvesSame'].map(k => ({ key: `seatKill.${k}`, params: { front: '50%', back: '37%' } })),
    { key: 'paths.top', params: { path: '紅紅紅', share: '29%' } },
    { key: 'paths.kill', params: { best: '藍藍藍', bestRate: '69%', worst: '藍紅紅藍藍', worstRate: '38%' } },
    ...['holderRole', 'targetRole'].map(k => ({ key: `lake.${k}`, params: { who: '首位接湖者', hi: '梅林', hiRate: '43%', lo: '奧伯倫', loRate: '26%' } })),
    ...['redLower', 'redHigher', 'same'].map(k => ({ key: `claim.${k}`, params: { blue: '99%', red: '27%' } })),
    { key: 'claim.byLake', params: { lake: '首湖', saidRed: '70%', saidBlue: '86%' } },
    ...['blueAlsoHalf', 'blueLower', 'blueHigher', 'same'].map(k => ({ key: `votesR3.${k}`, params: { withRed: '58%', allBlue: '46%' } })),
    ...['higher', 'lower', 'same'].map(k => ({ key: `voters.${k}`, params: { a: '50%', b: '60%' } })),
    ...['higher', 'lower', 'same'].map(k => ({ key: `captain.${k}`, params: { a: '44%', b: '84%' } })),
    ...['higher', 'lower', 'same'].map(k => ({ key: `captain.trend.${k}`, params: { first: 1, last: 5, a: '35%', b: '10%' } })),
    ...['higher', 'lower', 'same'].map(k => ({ key: `firstTeam.merlin.${k}`, params: { a: '31%', b: '30%' } })),
    { key: 'firstTeam.reds', params: { hi: 0, hiRate: '34%', lo: 2, loRate: '29%' } },
    { key: 'twoRed.best', params: { round: 3, hi: '梅林', hiRate: '71%', lo: '忠臣', loRate: '31%' } },
  ];
  for (const lang of ['zh-TW', 'en']) {
    it(`${lang}：句型都有字、要填的數字都給了、沒有寫死的百分比`, () => {
      const glance = load(lang).analytics.glance;
      for (const s of sentences) {
        const text = render(lang, s);
        expect(text, s.key).toMatch(/\S{6}/);
        expect(text, s.key).not.toContain('{{');
      }
      // 句型本身不能帶數字結論（數字只能從資料填進去）
      expect(JSON.stringify(glance)).not.toMatch(/\d+\s*%/);
      for (const k of ['games', 'votes']) expect(glance.sample[k]).toContain('{{n}}');
    });
  }

  it('繁中的字不寫統計術語、座位不寫 10 家', () => {
    // 只看字，不看鍵名
    const values = (node: unknown): string[] => (typeof node === 'string' ? [node] : Object.values(node as Record<string, unknown>).flatMap(values));
    const text = values(load('zh-TW').analytics.glance).join('\n');
    expect(text).not.toMatch(/n=|pp|CI|卡方|條件機率|10\s*[號家]/);
  });
});

describe('自動發現：差距寫成白話', () => {
  it('比率是「多／少幾個百分點」，平均是同單位；四捨五入後是 0 寫「一樣」', () => {
    expect(formatDiffPlain(-20.6, 'rate')).toBe('少 21 個百分點');
    expect(formatDiffPlain(16.2, 'rate')).toBe('多 16 個百分點');
    expect(formatDiffPlain(0.3, 'rate')).toBe('一樣');
    expect(formatDiffPlain(-1.717, 'avg')).toBe('少 1.72');
    expect(formatDiffPlain(0.001, 'avg')).toBe('一樣');
  });
});
