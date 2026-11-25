/**
 * 數據分析「一眼看懂」的一句話與比例（web components/analysis/core/glance；站長 2026-11-25：「關於數據分析…希望能更直觀
 * 讓看到的人一目瞭然」）：
 *  - 句子裡的數字跟長條出自同一個結果，都從傳進來的資料算（合成的計數，不是寫死的結論）；
 *  - 句型跟著資料換：失敗後比較低才寫「只贏」，反過來寫「反而贏」，一樣就不比；
 *  - 兩段比例條加起來一定是 100%；沒有資料時回 null（畫面不寫 0%）；
 *  - 每一個句型在繁中、英文都有字，而且句子裡真的填了那些數字；
 *  - 自動發現卡片的差距寫成白話（多／少幾個百分點）。
 * 第二批（同日）：刺殺、任務路徑、湖中女神的角色與宣告、派隊與投票內頁的句子與長條；三藍死（梅林被刺中）改用紅色系。
 * 第三批（同日）：戰績排行（前三名一句話、上榜條件白話）、局勢樹（同比分不同順序）、個人分析（跟全體比最強／最弱）。
 * 第四批（同日）：決定性票（全體投對多少、外白／內黑）、陣容強度（強弱桌比、分層、走勢）、個人分析其他小分頁
 *   （三塊勝率、理論勝率、Elo）、各位置／各角色最後誰贏。
 * 玩家名字都是假的（測試玩家甲…）。
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  decisiveGlance, eloGlance, playerBlocksGlance, strengthCurveGlance, strengthTiersGlance, strengthTrendGlance, theoryGlance, winExtremesSentence,
  boardGlance, boardRulesGlance, radarGlance, stateTreeGlance,
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

describe('一眼看懂（第三批）：戰績排行', () => {
  const rows = [
    { name: '測試玩家甲', value: 60 },
    { name: '測試玩家乙', value: 55.5 },
    { name: '測試玩家丙', value: null },
    { name: '測試玩家丁', value: 54.4 },
    { name: '測試玩家戊', value: 50 },
  ];

  it('一句話講榜上前三名（照榜的順序，沒有數字的跳過），數字寫整數；對照是不算散客的全體', () => {
    const g = boardGlance(rows, '角色理論', pctText, 46.2);
    expect(g.top.map(r => r.name)).toEqual(['測試玩家甲', '測試玩家乙', '測試玩家丁']);
    expect(g.sentence?.key).toBe('board.top3');
    const text = render('zh-TW', g.sentence as Sentence);
    for (const part of ['角色理論', '測試玩家甲（60%）', '測試玩家乙（56%）', '測試玩家丁（54%）']) expect(text).toContain(part);
    expect(text).not.toContain('測試玩家丙');
    expect(render('zh-TW', g.baseSentence as Sentence)).toContain('46%');
    expect(render('en', g.sentence as Sentence)).toContain('60%');
  });

  it('榜上只有一兩位：句型跟著人數換；沒有人、沒有對照時不寫', () => {
    expect(boardGlance(rows.slice(0, 2), '刺中率').sentence?.key).toBe('board.top2');
    expect(boardGlance(rows.slice(0, 1), '刺中率').sentence?.key).toBe('board.top1');
    expect(boardGlance(rows.slice(0, 1), '刺中率').baseSentence).toBeNull();
    expect(boardGlance([], '刺中率', pctText, 44).sentence).toBeNull();
    expect(boardGlance(null, '刺中率', pctText, 44).baseSentence).toBeNull();
    expect(boardGlance([{ name: '測試玩家甲', value: null }], '刺中率').sentence).toBeNull();
  });

  it('數字的寫法由榜決定（進步榜寫百分點、場數寫場）', () => {
    const g = boardGlance([{ name: '測試玩家甲', value: 16 }, { name: '測試玩家乙', value: 11 }], '角色理論進步', v => `+${v} 個百分點`, null, 'most');
    expect(g.sentence?.key).toBe('board.most2');
    expect(render('zh-TW', g.sentence as Sentence)).toBe('角色理論進步最多的是測試玩家甲（+16 個百分點），再來是測試玩家乙（+11 個百分點）。');
  });

  it('上榜條件寫成白話：幾個條件用頓號接，數字看最近幾場', () => {
    const zh = load('zh-TW').analytics.glance.rules;
    const say = (r: Parameters<typeof boardRulesGlance>[0]): string => {
      const g = boardRulesGlance(r);
      const who = g.who.length
        ? (zh.who as string).replace('{{list}}', g.who.map(p => render('zh-TW', p)).join(zh.sep))
        : zh.everyone;
      return who + render('zh-TW', g.window);
    };
    const base = { activeDays: 90, mainGames: 100, theoryMinGames: 50, requireRoleWindows: 1, roleWindowGames: 10, loyalWindowGames: 40 };
    expect(say(base)).toBe('理論勝率榜要最近 90 天有打、生涯至少 50 場、六個特殊角色各打過 10 場、忠臣 40 場才上榜；數字看每個人自己最近 100 場。');
    expect(say({ ...base, requireRoleWindows: 0 })).toBe('理論勝率榜要最近 90 天有打、生涯至少 50 場才上榜；數字看每個人自己最近 100 場。');
    // 全部放寬：打過的人都列，數字看生涯
    expect(say({ ...base, activeDays: 0, theoryMinGames: 0, requireRoleWindows: 0, mainGames: 0 })).toBe('理論勝率榜打過的人都列；數字看每個人生涯全部場次。');
    // 英文也組得出來
    const en = boardRulesGlance(base);
    for (const p of [...en.who, en.window]) expect(render('en', p)).toMatch(/\S{6}/);
  });
});

describe('一眼看懂（第三批）：局勢樹', () => {
  const seq = (s: string, n: number, blueWin: number | null) => ({ seq: s, n, blueWin });

  it('講差最多的那一組：同樣的比分，哪個順序藍方贏最多、哪個最少（比例是 0–1，畫面寫整數百分比）', () => {
    const g = stateTreeGlance({
      total: 2000, baseline: { blueWin: 0.31 },
      contrasts: [
        { score: '1:2', high: seq('紅紅藍', 292, 0.4315), low: seq('藍紅紅', 431, 0.1508) },
        { score: '2:2', high: seq('紅紅藍藍', 291, 0.44), low: seq('藍紅紅藍', 304, 0.21) },
      ],
    });
    expect(g.sentence?.key).toBe('tree.order');
    expect(g.high).toEqual({ seq: '紅紅藍', blue: { pct: 43.15, n: 292 } });
    expect(g.low?.blue.n).toBe(431);
    const text = render('zh-TW', g.sentence as Sentence);
    for (const part of ['1 個任務成功', '2 個失敗', '「紅紅藍」', '43%', '「藍紅紅」', '15%']) expect(text).toContain(part);
  });

  it('兩個順序顯示出來一樣：不寫「只有」', () => {
    const g = stateTreeGlance({ total: 100, baseline: { blueWin: 0.3 }, contrasts: [{ score: '1:1', high: seq('紅藍', 40, 0.304), low: seq('藍紅', 40, 0.296) }] });
    expect(g.sentence?.key).toBe('tree.orderSame');
    expect(render('zh-TW', g.sentence as Sentence)).not.toContain('只有');
  });

  it('局太少、沒有可比的順序：只講全部局藍方贏多少；0 局不寫', () => {
    const g = stateTreeGlance({ total: 12, baseline: { blueWin: 0.25 }, contrasts: [] });
    expect(g.sentence).toEqual({ key: 'tree.overall', params: { n: 12, blue: '25%' } });
    expect(g.high).toBeNull();
    expect(stateTreeGlance({ total: 0, baseline: { blueWin: null }, contrasts: [] }).sentence).toBeNull();
    expect(stateTreeGlance(null).sentence).toBeNull();
  });
});

describe('一眼看懂（第三批）：個人分析', () => {
  const axis = (key: string, value: number | null, field: number | null, n: number | null = 200) => ({ key, value, field, n });

  it('有高有低：最強＝比全體高最多的，最弱＝比全體低最多的；經驗不是勝率，不比', () => {
    const g = radarGlance([
      axis('winRate', 52, 46), axis('redWinRate', 80, 70), axis('missionWinRate', 48, 51),
      axis('redMerlinKillRate', null, 43), axis('experience', 100, null),
    ], '測試玩家甲', 5);
    expect(g.rows.map(r => r.key)).toEqual(['winRate', 'redWinRate', 'missionWinRate', 'experience']);
    expect(g.best).toBe('redWinRate');
    expect(g.worst).toBe('missionWinRate');
    expect(g.sentence?.key).toBe('radar.mixed');
    expect(g.sentence?.params).toMatchObject({ name: '測試玩家甲', bestValue: '80%', bestField: '70%', worstValue: '48%', worstField: '51%' });
    expect(g.rows.find(r => r.key === 'redWinRate')?.diff).toBe(10);
    expect(g.rows.find(r => r.key === 'experience')?.diff).toBeNull();
  });

  it('句型跟著資料：全部不輸全體、全部沒贏過全體', () => {
    const above = radarGlance([axis('winRate', 54, 46), axis('blueMerlinProtect', 62, 57), axis('positionTheory', 60.1, 46.2)], '測試玩家甲', 5);
    expect(above.sentence?.key).toBe('radar.allAbove');
    expect([above.best, above.worst]).toEqual(['positionTheory', 'blueMerlinProtect']);
    const below = radarGlance([axis('winRate', 40, 46), axis('redWinRate', 69, 70), axis('missionWinRate', 51, 51)], '測試玩家乙', 5);
    expect(below.sentence?.key).toBe('radar.allBelow');
    expect([below.best, below.worst]).toEqual(['missionWinRate', 'winRate']);
    expect(render('zh-TW', below.sentence as Sentence)).toContain('測試玩家乙');
  });

  it('場數不夠的那一項不當最強、最弱（夠的有兩項以上時）', () => {
    const g = radarGlance([axis('winRate', 52, 46), axis('missionWinRate', 49, 51), axis('redMerlinKillRate', 100, 43, 2)], '測試玩家甲', 5);
    expect(g.best).toBe('winRate');
    expect(g.rows).toHaveLength(3);
  });

  it('全體還沒算好：只比自己的各項（不比經驗）；可比的不到兩項就不寫', () => {
    const g = radarGlance([axis('winRate', 52, null), axis('redWinRate', 80, null), axis('experience', 100, null)], '測試玩家甲', 5);
    expect(g.sentence?.key).toBe('radar.own');
    expect([g.best, g.worst]).toEqual(['redWinRate', 'winRate']);
    expect(radarGlance([axis('winRate', 52, 46)], '測試玩家甲', 5).sentence).toBeNull();
    expect(radarGlance([], '測試玩家甲', 5).rows).toEqual([]);
    // 每一項都跟全體一樣：沒有最強最弱
    expect(radarGlance([axis('winRate', 46, 46), axis('redWinRate', 70, 70)], '測試玩家甲', 5).sentence).toBeNull();
  });
});

describe('一眼看懂（第四批）：決定性票', () => {
  const groups = [
    { group: 'onYes', right: 1243, wrong: 667 },
    { group: 'onNo', right: 294, wrong: 194 },
    { group: 'offYes', right: 230, wrong: 205 },
    { group: 'offNo', right: 1364, wrong: 404 },
  ];

  it('全體正確率用表上同一個數（0–1 → 整數百分比），四組的對率 = 對 ÷（對 + 錯）', () => {
    const g = decisiveGlance(0.681, groups, '兩紅之後');
    expect(g.overall?.pct).toBeCloseTo(68.1, 6);
    expect(g.overall?.n).toBe(1910 + 488 + 435 + 1768);
    expect(g.sentence).toEqual({ key: 'decisive.lead', params: { scope: '兩紅之後', rate: '68%' } });
    expect(g.groups.map(x => pctText(x.share.pct))).toEqual(['65%', '60%', '53%', '77%']);
    expect(g.abnormalSentence).toEqual({ key: 'decisive.abnormal', params: { offYes: '53%', onNo: '60%' } });
  });

  it('沒有票的組不列、外白或內黑沒有票就不寫那一句；沒有全體正確率不寫第一句', () => {
    const g = decisiveGlance(null, [{ group: 'onYes', right: 3, wrong: 1 }, { group: 'offYes', right: 0, wrong: 0 }], '第 3～5 局');
    expect(g.groups.map(x => x.group)).toEqual(['onYes']);
    expect(g.sentence).toBeNull();
    expect(g.abnormalSentence).toBeNull();
  });
});

describe('一眼看懂（第四批）：陣容強度', () => {
  it('強弱桌：最後一箱跟第一箱比，句型跟著高低換', () => {
    const bins = [{ n: 210, rate: 49.2 }, { n: 213, rate: 46 }, { n: 211, rate: 46.6 }];
    expect(strengthCurveGlance(bins, 47.1, '三個任務失敗')).toEqual({
      key: 'strength.curve.lower', params: { metric: '三個任務失敗', strong: '47%', weak: '49%', all: '47%' },
    });
    expect(strengthCurveGlance([{ n: 10, rate: 20 }, { n: 10, rate: 31 }], 25, '藍方贏')?.key).toBe('strength.curve.higher');
    expect(strengthCurveGlance([{ n: 10, rate: 30.2 }, { n: 10, rate: 29.8 }], 30, '藍方贏')?.key).toBe('strength.curve.same');
    expect(strengthCurveGlance([{ n: 10, rate: 30 }], 30, '藍方贏')).toBeNull();
  });

  it('分層：藍方贏（三藍活 ÷ 這層的局）最多、最少的分層；局數不夠的不比', () => {
    const tiers = [
      { label: '高強度', n: 154, threeRed: 72, blueDead: 36, blueAlive: 46 },
      { label: '偏強', n: 189, threeRed: 89, blueDead: 41, blueAlive: 59 },
      { label: '偏弱', n: 421, threeRed: 214, blueDead: 89, blueAlive: 118 },
      { label: '極少', n: 5, threeRed: 0, blueDead: 0, blueAlive: 5 },
    ];
    const g = strengthTiersGlance(tiers, 20);
    expect(g.sentence).toEqual({ key: 'strength.tiers', params: { hi: '偏強', hiRate: '31%', lo: '偏弱', loRate: '28%' } });
    expect(g.rows[0].threeRed).toBeCloseTo((72 / 154) * 100, 6);
  });

  it('走勢：差不到門檻說「前後差不多」，不把 3 分說成變低', () => {
    const a = { date: '2023-11', median: 1491.2 };
    expect(strengthTrendGlance(a, { date: '2026-11', median: 1488.4 }, '賽前 Elo', 10)?.key).toBe('strength.trend.same');
    expect(strengthTrendGlance(a, { date: '2026-11', median: 1512 }, '賽前 Elo', 10)).toEqual({
      key: 'strength.trend.up', params: { measure: '賽前 Elo', from: '2023-11', to: '2026-11', a: 1491, b: 1512 },
    });
    expect(strengthTrendGlance(a, { date: '2026-11', median: 1470 }, '賽前 Elo', 10)?.key).toBe('strength.trend.down');
    expect(strengthTrendGlance(null, a, 'PR')).toBeNull();
  });
});

describe('一眼看懂（第四批）：個人分析的其他小分頁、各位置／各角色', () => {
  it('三塊勝率：當紅方、藍方最後各贏多少；角色只比場數夠的', () => {
    const roles = [
      { role: '刺客', win: 85.2, n: 122 }, { role: '忠臣', win: 33.1, n: 499 }, { role: '梅林', win: 90, n: 3 },
    ];
    const g = playerBlocksGlance({ win: 80.1, n: 438 }, { win: 38.2, n: 731 }, roles, '測試玩家甲', 10);
    expect(g.sentence).toEqual({ key: 'blocks.higher', params: { name: '測試玩家甲', red: '80%', blue: '38%' } });
    expect(g.roleSentence).toEqual({ key: 'blocks.roles', params: { hi: '刺客', hiRate: '85%', lo: '忠臣', loRate: '33%' } });
    expect(playerBlocksGlance({ win: null, n: 0 }, { win: 50, n: 10 }, null, '測試玩家甲', 10).sentence).toBeNull();
  });

  it('理論勝率：實際比預期高／低／一樣；沒有角色理論時用位置理論', () => {
    expect(theoryGlance({ rate: 56.04, actual: 61 }, null, '測試玩家甲')).toEqual({
      key: 'theory.role.higher', params: { name: '測試玩家甲', rate: '56%', actual: '61%' },
    });
    expect(theoryGlance({ rate: 56, actual: 50 }, null, '測試玩家甲')?.key).toBe('theory.role.lower');
    expect(theoryGlance({ rate: null, actual: 50 }, { rate: 60.1, actual: 60 }, '測試玩家甲')?.key).toBe('theory.position.same');
    expect(theoryGlance(null, null, '測試玩家甲')).toBeNull();
  });

  it('Elo：最高點用走勢圖同一份 series；現在就是最高點時換句型', () => {
    const series = [['2024-01-01', 1490, 30, 10], ['2025-05-01', 1580, 10, 500], ['2026-11-01', 1560, 8, 1100]] as const;
    expect(eloGlance(1559.6, 3, series, '測試玩家甲')).toEqual({
      key: 'elo.peak', params: { name: '測試玩家甲', elo: 1560, rank: 3, peak: 1580, date: '2025-05-01' },
    });
    expect(eloGlance(1590, 1, series, '測試玩家甲')?.key).toBe('elo.atPeak');
    expect(eloGlance(null, 1, series, '測試玩家甲')).toBeNull();
  });

  it('各位置／各角色：最後贏最多、最少的（只比場數夠的）', () => {
    const rows = [{ name: '1', win: 54.1, n: 900 }, { name: '0', win: 59.3, n: 880 }, { name: '5', win: 70, n: 4 }, { name: '7', win: 49.6, n: 870 }];
    expect(winExtremesSentence(rows, 'seatWin.blue', 10)).toEqual({ key: 'seatWin.blue', params: { hi: '0', hiRate: '59%', lo: '7', loRate: '50%' } });
    expect(winExtremesSentence([{ name: '1', win: 50, n: 10 }], 'seatWin.red', 10)).toBeNull();
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
    // 第三批
    { key: 'board.top3', params: { metric: '角色理論', first: '測試玩家甲', firstValue: '60%', second: '測試玩家乙', secondValue: '56%', third: '測試玩家丙', thirdValue: '54%' } },
    { key: 'board.top2', params: { metric: '角色理論', first: '測試玩家甲', firstValue: '60%', second: '測試玩家乙', secondValue: '56%' } },
    { key: 'board.top1', params: { metric: '角色理論', first: '測試玩家甲', firstValue: '60%' } },
    { key: 'board.base', params: { metric: '角色理論', base: '46%' } },
    { key: 'board.most3', params: { metric: '場數', first: '測試玩家甲', firstValue: '1,200 場', second: '測試玩家乙', secondValue: '1,100 場', third: '測試玩家丙', thirdValue: '1,000 場' } },
    { key: 'board.most2', params: { metric: '場數', first: '測試玩家甲', firstValue: '1,200 場', second: '測試玩家乙', secondValue: '1,100 場' } },
    { key: 'board.most1', params: { metric: '場數', first: '測試玩家甲', firstValue: '1,200 場' } },
    ...['order', 'orderSame'].map(k => ({ key: `tree.${k}`, params: { blues: '1', reds: '2', high: '紅紅藍', highRate: '43%', low: '藍紅紅', lowRate: '15%' } })),
    { key: 'tree.overall', params: { n: 2336, blue: '31%' } },
    ...['mixed', 'allAbove', 'allBelow'].map(k => ({
      key: `radar.${k}`,
      params: { name: '測試玩家甲', best: '紅方最終勝率', bestValue: '80%', bestField: '70%', worst: '任務勝率', worstValue: '48%', worstField: '51%' },
    })),
    { key: 'radar.own', params: { name: '測試玩家甲', best: '紅方最終勝率', bestValue: '80%', worst: '任務勝率', worstValue: '48%' } },
    { key: 'rules.window', params: { n: 100 } },
    // 第四批
    { key: 'decisive.lead', params: { scope: '兩紅之後', rate: '68%' } },
    { key: 'decisive.abnormal', params: { offYes: '53%', onNo: '60%' } },
    ...['higher', 'lower', 'same'].map(k => ({ key: `strength.curve.${k}`, params: { metric: '三個任務失敗', strong: '47%', weak: '49%', all: '47%' } })),
    { key: 'strength.tiers', params: { hi: '偏強', hiRate: '32%', lo: '偏弱', loRate: '29%' } },
    ...['up', 'down', 'same'].map(k => ({ key: `strength.trend.${k}`, params: { measure: '賽前 Elo', from: '2023-11', to: '2026-11', a: 1491, b: 1488 } })),
    ...['higher', 'lower', 'same'].map(k => ({ key: `blocks.${k}`, params: { name: '測試玩家甲', red: '80%', blue: '38%' } })),
    { key: 'blocks.roles', params: { hi: '刺客', hiRate: '85%', lo: '忠臣', loRate: '33%' } },
    ...['role', 'position'].flatMap(kind => ['higher', 'lower', 'same'].map(k => ({ key: `theory.${kind}.${k}`, params: { name: '測試玩家甲', rate: '56%', actual: '56%' } }))),
    { key: 'elo.peak', params: { name: '測試玩家甲', elo: 1565, rank: 1, peak: 1580, date: '2025-05-01' } },
    { key: 'elo.atPeak', params: { name: '測試玩家甲', elo: 1565, rank: 1 } },
    ...['blue', 'red'].map(k => ({ key: `seatWin.${k}`, params: { hi: '0', hiRate: '59%', lo: '7', loRate: '50%' } })),
    { key: 'roleWin.lead', params: { hi: '刺客', hiRate: '85%', lo: '忠臣', loRate: '33%' } },
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
