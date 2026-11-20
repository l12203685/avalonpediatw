/**
 * 網站「百科AI 優化歷程」頁（#ai-history）：資料形狀（packages/web/src/data/aiHistory.json）、和回合紀錄表一致、頁面的純函式
 * （packages/web/src/utils/aiHistory.ts；web 沒有測試執行器，在這裡測）與深連結。
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  ROLE_LABEL, ROLE_ORDER, chartGeometry, deltaMean, deltaTrend, filterMilestones, formatDelta, isAdoptedText,
  isAiHistoryHash, parseRoundTable, roleSummary, roundOrder, roundStats, sortMilestones,
  type AiHistoryData, type AiMilestone,
} from '../../../web/src/utils/aiHistory';
import { PUBLIC_STATS_STATES, parseStatsHash } from '../../../web/src/utils/statsLinks';
import { buildAiHistory } from '../../../../scripts/build_ai_history';

const ROOT = path.resolve(__dirname, '../../../..');
const DATA = JSON.parse(fs.readFileSync(path.join(ROOT, 'packages/web/src/data/aiHistory.json'), 'utf8')) as AiHistoryData;
const LOOP_MD = fs.readFileSync(path.join(ROOT, 'docs/ai/optimization_loop.md'), 'utf8');
const CURATED = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/ai/ai_history.curated.json'), 'utf8')) as AiHistoryData;

function ms(over: Partial<AiMilestone>): AiMilestone {
  return {
    id: 'x', round: '1', date: '2026-10-28', side: 'blue', roles: ['loyal'], primary: 'loyal', kind: 'strategy',
    what: 'w', why: 'y', win: null, task: null, sample: 's', ...over,
  };
}

describe('aiHistory.json 的資料形狀', () => {
  it('頂層欄位與回合數', () => {
    expect(DATA.version).toBe(1);
    expect(DATA.stats.rounds).toBeGreaterThanOrEqual(55);
    expect(DATA.stats.adoptedRounds + DATA.stats.notAdoptedRounds).toBe(DATA.stats.rounds);
    expect(DATA.milestones.length).toBeGreaterThanOrEqual(40);
    expect(DATA.headline.map((h) => h.key)).toEqual(expect.arrayContaining(['start', 'now', 'human', 'strong']));
  });

  it('每個里程碑的欄位都合法', () => {
    const ids = new Set<string>();
    for (const m of DATA.milestones) {
      expect(ids.has(m.id)).toBe(false);
      ids.add(m.id);
      expect(m.date).toMatch(/^2026-\d{2}-\d{2}$/);
      expect(['blue', 'red']).toContain(m.side);
      expect(['strategy', 'reading', 'fix']).toContain(m.kind);
      expect(m.roles.length).toBeGreaterThan(0);
      for (const r of [...m.roles, m.primary]) expect(ROLE_LABEL[r]).toBeTruthy();
      expect(m.what.length).toBeGreaterThan(5);
      expect(m.why.length).toBeGreaterThan(5);
      for (const d of [m.win, m.task]) {
        if (!d) continue;
        expect(d.values.length).toBeGreaterThan(0);
        for (const v of d.values) expect(Number.isFinite(v)).toBe(true);
        if (d.lo !== undefined || d.hi !== undefined) {
          expect(d.values).toHaveLength(1);
          expect(d.lo!).toBeLessThanOrEqual(d.values[0]);
          expect(d.hi!).toBeGreaterThanOrEqual(d.values[0]);
        }
      }
      // 藍方的角色不出現在紅方列，反之亦然
      const sides = new Set(m.roles.map((r) => (['assassin', 'morgana', 'mordred', 'oberon', 'red'].includes(r) ? 'red' : 'blue')));
      expect([...sides]).toEqual([m.side]);
    }
  });

  it('里程碑新的在前', () => {
    expect(DATA.milestones.map((m) => m.id)).toEqual(sortMilestones(DATA.milestones).map((m) => m.id));
  });

  it('走勢圖的點是合理的百分比，回合照順序', () => {
    const orders = DATA.series.map((p) => roundOrder(p.round));
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    for (const p of DATA.series) {
      expect(p.win).toBeGreaterThan(0);
      expect(p.win).toBeLessThan(100);
      if (p.task !== null) {
        expect(p.task).toBeGreaterThanOrEqual(p.win); // 三藍活 ≤ 任務三藍
      }
    }
  });

  it('公開頁面：不放玩家名字或對話（只有角色與回合）', () => {
    const text = JSON.stringify(DATA);
    expect(text).not.toMatch(/百科AI_\d|@|https?:\/\//);
  });

  it('和產生腳本的輸出一致（改了 curated 或回合紀錄表要重跑 scripts/build_ai_history.ts）', () => {
    const { data, errors } = buildAiHistory(LOOP_MD, CURATED, DATA.generatedAt);
    expect(errors).toEqual([]);
    expect(data).toEqual(DATA);
  });
});

describe('回合紀錄表的解析', () => {
  it('採用欄', () => {
    expect(isAdoptedText('是')).toBe(true);
    expect(isAdoptedText('**是：L1**（站長 2026-11-19 採用）')).toBe(true);
    expect(isAdoptedText('是（B1、C1、位階法）')).toBe(true);
    expect(isAdoptedText('否（預設不變）')).toBe(false);
    expect(isAdoptedText('不採用（再校準）')).toBe(false);
    expect(isAdoptedText('—')).toBe(false);
  });

  it('回合順序', () => {
    expect(roundOrder('43b')).toBe(43.5);
    expect(roundOrder('7')).toBe(7);
    expect(Number.isNaN(roundOrder('x'))).toBe(true);
  });

  it('小表：照表頭找欄位、同一回合多列、遇到下一節停', () => {
    const md = [
      '## 4. 回合紀錄', '',
      '| 回合 | 陣營 | 改法 | 採用 | 參考版本 |', '|---|---|---|---|---|',
      '| 0 | — | 起點 | — | v0 |',
      '| 3 | 藍・忠臣 | a | 是 | — |',
      '| 3 | 藍・梅林 | b | 否 | — |',
      '| 43b | 藍 | c | **是**（V5） | — |',
      '| 9 | 藍 | d | 否 | — |',
      '', '### 第 1 回合', '| 99 | x | y | 是 | z |',
    ].join('\n');
    const rows = parseRoundTable(md);
    expect(rows.map((r) => [r.round, r.adopted])).toEqual([['0', false], ['3', true], ['3', false], ['43b', true], ['9', false]]);
    expect(roundStats(rows)).toEqual({ rounds: 3, adoptedRounds: 2, notAdoptedRounds: 1, latestRound: '43b' });
    expect(parseRoundTable('# 沒有表')).toEqual([]);
  });

  it('真的 optimization_loop.md：每個里程碑的回合都是「採用」，每個採用的回合都有里程碑', () => {
    const rows = parseRoundTable(LOOP_MD);
    const adopted = new Set(rows.filter((r) => r.adopted).map((r) => r.round));
    expect(adopted.has('1')).toBe(true);
    expect(adopted.has('54')).toBe(true);
    expect(adopted.has('55')).toBe(false);
    for (const m of DATA.milestones) expect(adopted.has(m.round)).toBe(true);
    const covered = new Set(DATA.milestones.map((m) => m.round));
    for (const r of adopted) expect(covered.has(r)).toBe(true);
  });
});

describe('顯示用的純函式', () => {
  it('formatDelta', () => {
    expect(formatDelta({ values: [0.16], lo: 0.13, hi: 0.19 })).toBe('+0.16 [+0.13, +0.19]');
    expect(formatDelta({ values: [-0.8], lo: -1.33, hi: -0.27 })).toBe('−0.80 [−1.33, −0.27]');
    expect(formatDelta({ values: [1.2, 0.8] })).toBe('+1.2／+0.8（2 組）');
    expect(formatDelta({ values: [4] })).toBe('+4.0');
    expect(formatDelta({ values: [0] })).toBe('±0.0');
    expect(formatDelta(null)).toBe('—');
  });

  it('deltaMean／deltaTrend', () => {
    expect(deltaMean({ values: [1.2, 0.8] })).toBeCloseTo(1.0);
    expect(deltaMean(null)).toBeNull();
    expect(deltaTrend({ values: [0.16], lo: 0.13, hi: 0.19 })).toBe('up');
    expect(deltaTrend({ values: [-0.8], lo: -1.33, hi: -0.27 })).toBe('down');
    expect(deltaTrend({ values: [0.03], lo: -0.01, hi: 0.07 })).toBe('flat');
    expect(deltaTrend({ values: [0.05] })).toBe('flat');
    expect(deltaTrend({ values: [-2.4] })).toBe('down');
    expect(deltaTrend(null)).toBeNull();
  });

  it('sortMilestones：日期新的在前，同一天回合大的在前', () => {
    const list = [
      ms({ id: 'a', date: '2026-10-28', round: '1' }),
      ms({ id: 'b', date: '2026-11-18', round: '43b' }),
      ms({ id: 'c', date: '2026-11-18', round: '46' }),
    ];
    expect(sortMilestones(list).map((m) => m.id)).toEqual(['c', 'b', 'a']);
  });

  it('filterMilestones：重點、陣營、角色', () => {
    const list = [
      ms({ id: 'a', highlight: true, roles: ['loyal', 'merlin'], primary: 'blue' }),
      ms({ id: 'b', roles: ['merlin'], primary: 'merlin' }),
      ms({ id: 'c', side: 'red', roles: ['assassin'], primary: 'assassin', highlight: true }),
    ];
    expect(filterMilestones(list, 'all', false).map((m) => m.id)).toEqual(['a', 'b', 'c']);
    expect(filterMilestones(list, 'all', true).map((m) => m.id)).toEqual(['a', 'c']);
    expect(filterMilestones(list, 'merlin', false).map((m) => m.id)).toEqual(['a', 'b']);
    expect(filterMilestones(list, 'redSide', false).map((m) => m.id)).toEqual(['c']);
    expect(filterMilestones(list, 'blueSide', true).map((m) => m.id)).toEqual(['a']);
  });

  it('roleSummary：每個里程碑只算進 primary 那一格，各格加起來 = 全部', () => {
    const list = [
      ms({ id: 'a', roles: ['loyal', 'merlin'], primary: 'blue', win: { values: [1.0], lo: 0.5, hi: 1.5 }, task: { values: [2] } }),
      ms({ id: 'b', roles: ['merlin'], primary: 'merlin', win: { values: [1.2, 0.8] } }),
      ms({ id: 'c', roles: ['merlin'], primary: 'merlin', win: null }),
    ];
    const rows = roleSummary(list);
    const merlin = rows.find((r) => r.role === 'merlin')!;
    expect(merlin).toMatchObject({ count: 2, touched: 3, winSum: 1.0, winCount: 1, taskCount: 0 });
    const loyal = rows.find((r) => r.role === 'loyal')!;
    expect(loyal).toMatchObject({ count: 0, touched: 1 });
    expect(rows.find((r) => r.role === 'blue')).toMatchObject({ count: 1, winSum: 1.0, taskSum: 2, taskCount: 1 });
    expect(rows.find((r) => r.role === 'assassin')).toBeUndefined();
    expect(rows.map((r) => r.role)).toEqual(ROLE_ORDER.filter((r) => rows.some((x) => x.role === r)));
    // 真資料：各格的 count 加起來 = 里程碑數
    const real = roleSummary(DATA.milestones);
    expect(real.reduce((a, r) => a + r.count, 0)).toBe(DATA.milestones.length);
  });

  it('chartGeometry：座標與任務三藍的斷線', () => {
    const box = { width: 100, height: 100, left: 10, right: 10, top: 10, bottom: 10 };
    const g = chartGeometry([
      { round: '0', side: null, win: 0, task: 40 },
      { round: '1', side: 'blue', win: 40, task: null },
      { round: '2', side: 'red', win: 80, task: 60 },
      { round: '3', side: 'blue', win: 20, task: 80 },
    ], box, 80);
    expect(g.points.map((p) => p.x)).toEqual([10, 10 + 80 / 3, 10 + 160 / 3, 90]);
    expect(g.yOf(0)).toBe(90);
    expect(g.yOf(80)).toBe(10);
    expect(g.yOf(120)).toBe(10); // 夾住
    expect(g.winPath.startsWith('M10.0,90.0 L')).toBe(true);
    expect(g.taskPath).toBe('M10.0,50.0 M63.3,30.0 L90.0,10.0');
    expect(g.ticks).toEqual([0, 20, 40, 60, 80]);
    expect(chartGeometry([{ round: '0', side: null, win: 40, task: null }], box).points[0].x).toBe(50);
  });
});

describe('#ai-history 深連結', () => {
  it('解析', () => {
    expect(isAiHistoryHash('#ai-history')).toBe(true);
    expect(isAiHistoryHash('aihistory')).toBe(true);
    expect(isAiHistoryHash('#AI-Progress')).toBe(true);
    expect(isAiHistoryHash('#ai-games')).toBe(false);
    expect(parseStatsHash('#ai-history')).toEqual({ kind: 'aiHistory' });
    expect(parseStatsHash('#ai-games')).toEqual({ kind: 'aiGames', id: null });
  });

  it('不用登入就能開', () => {
    expect(PUBLIC_STATS_STATES.has('aiHistory')).toBe(true);
  });
});
