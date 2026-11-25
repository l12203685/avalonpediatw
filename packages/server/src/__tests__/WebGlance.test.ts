/**
 * 數據分析「一眼看懂」的一句話與比例（web components/analysis/core/glance；站長 2026-11-25：「關於數據分析…希望能更直觀
 * 讓看到的人一目瞭然」）：
 *  - 句子裡的數字跟長條出自同一個結果，都從傳進來的資料算（合成的計數，不是寫死的結論）；
 *  - 句型跟著資料換：失敗後比較低才寫「只贏」，反過來寫「反而贏」，一樣就不比；
 *  - 兩段比例條加起來一定是 100%；沒有資料時回 null（畫面不寫 0%）；
 *  - 每一個句型在繁中、英文都有字，而且句子裡真的填了那些數字；
 *  - 自動發現卡片的差距寫成白話（多／少幾個百分點）。
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  anyThin, blueWinShare, killGlance, lakeHolderGlance, missionOneGlance, missionRatesGlance, missionSwingGlance, overallGlance, pctText, relation,
  restText, shownPct, votesGlance, type Sentence,
} from '../../../web/src/components/analysis/core/glance';
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

describe('一眼看懂：每個句型兩種語言都有字', () => {
  const sentences: Sentence[] = [
    ...['overall.redAhead', 'overall.blueAhead', 'overall.even'].map(key => ({ key, params: { red: '69%', blue: '31%' } })),
    ...['failLower', 'failHigher', 'same'].map(k => ({ key: `missions.m1.${k}`, params: { passed: '40%', failed: '24%' } })),
    { key: 'missions.kill', params: { rate: '44%' } },
    { key: 'missions.rates', params: { hard: 2, hardRate: '29%', easy: 4, easyRate: '84%' } },
    ...['failLower', 'failHigher', 'same'].map(k => ({ key: `missions.swing.${k}`, params: { round: 1, gap: 16, passed: '40%', failed: '24%' } })),
    ...['redLower', 'redHigher', 'same'].map(k => ({ key: `lake.${k}`, params: { who: '首位接湖者', blue: '33%', red: '27%' } })),
    ...['blueAlsoHalf', 'blueLower', 'blueHigher', 'same'].map(k => ({ key: `votes.${k}`, params: { withRed: '62%', allBlue: '55%' } })),
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
