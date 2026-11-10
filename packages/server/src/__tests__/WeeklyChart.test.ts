/**
 * Weekly ranking chart (2026-11-10): the Monday digest as ONE PNG.
 *   - weeklyChart.ts: SVG builder (escaping, optional sections, fitting) and the resvg PNG;
 *   - statsQueries.weeklyChartData: the same boards as the text digest, from a mocked cache;
 *   - the scheduler hands the PNG to each destination and falls back to the text;
 *   - ChatMirror.enqueueLineReplyImage: the chart as a LINE image message on the reply queue.
 * Every name here is invented.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  buildWeeklyChartSvg,
  chartPct,
  chartSigned,
  escapeXml,
  tierLine,
  TIER_LEGEND,
  fitNames,
  fitText,
  renderWeeklyChartPng,
  roundHalfUp,
  stripLeadingEmoji,
  textWidth,
  wrapText,
  WEEKLY_CHART_WIDTH,
  type WeeklyChartData,
} from '../bots/stats/weeklyChart';
import {
  WEEKLY_CHART_CAPTION,
  __resetLeaderboardChartCacheForTests,
  chartBaselines,
  populationTheoryAverages,
  leaderboardChart,
  leaderboardChartData,
  weeklyChartData,
  weeklyDigestPng,
} from '../bots/stats/statsQueries';
import { WeeklyDigestScheduler } from '../bots/stats/weeklyDigest';
import { ChatMirror } from '../bots/ChatMirror';
import { LineReplyQueue } from '../bots/line/replyQueue';
import { LINE_PREVIEW_MAX_BYTES, RelayMediaStore } from '../bots/media/relayMedia';
import type { LeaderboardBoard, LeaderboardRow } from '../services/sheetsAnalysis';
import { sampleWeeklyChartData } from './stats/weeklyChartSample';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const cache = vi.hoisted(() => {
  const theoryRow = (rank: number, name: string, roleTheory: number): LeaderboardRow => ({
    rank, name, value: roleTheory, roleTheory, positionTheory: roleTheory - 1, finalWinRate: roleTheory + 2, games: 100, careerGames: 300 + rank,
  });
  const boards = (): LeaderboardBoard[] => [
    {
      id: 'main', metric: 'roleTheory', title: '角色理論勝率排行', period: '各人最近 100 場', windowGames: 100, minGames: 100,
      note: '近 90 天內有出賽、生涯至少 100 場；角色理論 = 說明文字', rows: Array.from({ length: 12 }, (_, i) => theoryRow(i + 1, `甲${i + 1}`, 60 - i)),
    },
    {
      id: 'position', metric: 'positionTheory', title: '位置理論勝率排行', period: '各人最近 100 場', windowGames: 100, minGames: 100,
      note: '近 90 天內有出賽、生涯至少 100 場；說明', rows: Array.from({ length: 11 }, (_, i) => ({ ...theoryRow(i + 1, `戊${i + 1}`, 50), positionTheory: 61.5 - i, value: 61.5 - i })),
    },
    {
      id: 'overall', metric: 'overallTheory', title: '整體理論勝率排行', period: '各人生涯全部場次', minGames: 100,
      note: '近 90 天內有出賽、生涯至少 100 場；說明', rows: Array.from({ length: 10 }, (_, i) => ({ ...theoryRow(i + 1, `己${i + 1}`, 50), overallTheory: 54.4 - i, value: 54.4 - i })),
    },
    {
      id: 'improved', metric: 'roleTheoryDelta', title: '進步榜', period: '各人最近 50 場 vs 再之前 50 場', windowGames: 50, minGames: 100,
      note: '近 90 天內有出賽；說明', rows: Array.from({ length: 7 }, (_, i) => ({
        rank: i + 1, name: `乙${i + 1}`, value: 10 - i, recentRoleTheory: 50, priorRoleTheory: 40 + i, games: 50,
      })),
    },
    {
      id: 'newcomers', metric: 'roleTheory', title: '新人榜', period: '2026-08-11 ～ 2026-11-08 打滿 10 場', windowDays: 90, allGames: true, minGames: 10,
      note: '說明', rows: [{ ...theoryRow(1, '丙1', 47), games: 30, careerGames: 41 }, { ...theoryRow(2, '丙2', 45.5), games: 11, careerGames: 11 }],
    },
    {
      id: 'roleTitles', metric: 'finalWinRate', title: '角色王', period: '各人該角色最近 20 場', windowGames: 20, minGames: 20, note: '說明',
      rows: [
        { rank: 1, role: '刺客', name: '丁1', value: 90, games: 20 },
        { rank: 1, role: '刺客', name: '丁2', value: 90, games: 20 },
        { rank: 1, role: '梅林', name: '丁3', value: 55, games: 20 },
      ],
    },
  ];
  return {
    overview: {
      totalGames: 2228, totalPlayers: 221, redWinRate: 45.5, blueWinRate: 54.5, merlinKillRate: 43.9,
      // Population final win rates: red roles 70%, blue roles 30% → every theory average = 46%.
      roleFinalWinRates: { 刺客: 70, 莫甘娜: 70, 莫德雷德: 70, 奧伯倫: 70, 派西維爾: 30, 梅林: 30, 忠臣: 30 },
      seatFinalWinRates: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [String(i + 1), 44 + (i % 2) * 4])),
      roleSeatFinalWinRates: Object.fromEntries(
        ['刺客', '莫甘娜', '莫德雷德', '奧伯倫', '派西維爾', '梅林', '忠臣'].map((r) => [
          r, Object.fromEntries(Array.from({ length: 10 }, (_, i) => [String(i + 1), ['派西維爾', '梅林', '忠臣'].includes(r) ? 30 : 70])),
        ]),
      ),
    } as Record<string, unknown>,
    leaderboard: { asOf: '2026-11-08', boards: boards() } as { asOf: string; boards: LeaderboardBoard[] } | null,
    boards,
    rating: null as { theoryBaselines?: unknown } | null,
  };
});

vi.mock('../services/sheetsAnalysis', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/sheetsAnalysis')>()),
  getOverview: async () => cache.overview,
  getLeaderboard: async () => cache.leaderboard,
  getRatingBoard: async () => cache.rating,
}));

function minimal(overrides: Partial<WeeklyChartData> = {}): WeeklyChartData {
  return {
    dateLabel: '11/9',
    subtitle: null,
    main: { title: '角色理論勝率排行 Top 10', note: null, rows: [{ rank: 1, name: '星野', value: 60, valueLabel: '60.0%' }] },
    improved: null,
    roleKings: null,
    newcomers: null,
    footerLines: [],
    url: 'https://example.invalid/#stats',
    ...overrides,
  };
}

function pngSize(png: Buffer): { width: number; height: number } {
  // IHDR: width / height are the first two big-endian uint32 after the chunk header (offset 16).
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

describe('weekly chart text helpers', () => {
  it('escapes XML and drops control characters', () => {
    expect(escapeXml(`A&B <x> "q" 'r'`)).toBe('A&amp;B &lt;x&gt; &quot;q&quot; &apos;r&apos;');
    expect(escapeXml('a\u0000b\u001Fc')).toBe('abc');
  });

  it('strips the leading emoji of a title only', () => {
    expect(stripLeadingEmoji('🏆 角色理論勝率排行 Top 10')).toBe('角色理論勝率排行 Top 10');
    expect(stripLeadingEmoji('👑 角色王 🎉')).toBe('角色王 🎉');
    expect(stripLeadingEmoji('進步榜')).toBe('進步榜');
  });

  it('fits and wraps by estimated width (CJK = 1 em)', () => {
    expect(textWidth('一二三', 10)).toBe(30);
    expect(fitText('一二三四五六', 10, 40)).toBe('一二三…');
    expect(fitText('短', 10, 40)).toBe('短');
    expect(wrapText('一二三四五六七八九十', 10, 40, 2)).toEqual(['一二三四', '五六七…']);
    expect(wrapText('一二三', 10, 40, 2)).toEqual(['一二三']);
  });

  it('whole percents, rounded half up (owner 2026-11-10: no decimal points on the image)', () => {
    expect(roundHalfUp(62.5)).toBe(63);
    expect(roundHalfUp(62.49999999999999)).toBe(63); // float noise for 62.5
    expect(roundHalfUp(62.49)).toBe(62);
    expect(roundHalfUp(-2.5)).toBe(-2);
    expect(chartPct(63.4)).toBe('63%');
    expect(chartPct(45.5)).toBe('46%');
    expect(chartPct(null)).toBe('—');
    expect(chartSigned(12.4)).toBe('+12');
    expect(chartSigned(0.3)).toBe('0');
    expect(chartSigned(-2.6)).toBe('-3');
    expect(chartSigned(undefined)).toBe('—');
  });

  it('role-king holders: whole names that fit, then 「等 N 人」', () => {
    expect(fitNames(['甲', '乙'], 10, 200)).toBe('甲／乙');
    expect(fitNames(['甲', '乙', '丙', '丁'], 10, 200)).toBe('甲／乙／丙 等 4 人');
    expect(fitNames(['甲甲甲甲', '乙乙乙乙', '丙'], 10, 100)).toBe('甲甲甲甲 等 3 人');
    expect(fitNames(['很長很長很長很長的名字'], 10, 60)).toBe('很長很長很…');
    expect(fitNames([], 10, 60)).toBe('—');
  });
});

describe('buildWeeklyChartSvg', () => {
  it('escapes player names (never markup)', () => {
    const svg = buildWeeklyChartSvg(
      minimal({
        main: { title: 'T', note: null, rows: [{ rank: 1, name: 'A&<i>"', value: 55, valueLabel: '55%' }, { rank: 2, name: '<script>x</script>', value: 54, valueLabel: '54%' }] },
      }),
    );
    expect(svg).toContain('A&amp;&lt;i&gt;&quot;');
    expect(svg).toContain('&lt;script'); // cut to fit the column, still escaped
    expect(svg).not.toContain('<script>');
    expect(svg).not.toContain('<i>');
  });

  it('leaves out the sections the cache does not have', () => {
    const svg = buildWeeklyChartSvg(minimal());
    expect(svg).toContain('每週排行');
    expect(svg).toContain('11/9');
    expect(svg).toContain('星野');
    expect(svg).not.toContain('進步榜');
    expect(svg).not.toContain('角色王');
    expect(svg).not.toContain('新人榜');
    const full = buildWeeklyChartSvg(sampleWeeklyChartData());
    for (const s of ['位置理論勝率 Top 10', '整體理論勝率 Top 10', '進步榜 Top 5', '角色王 Top 3', '新人榜', '奧伯倫', '18 場', '41% → 53%', '全體 46%', '高 50%・中 45%・低 41%', TIER_LEGEND]) {
      expect(full).toContain(s);
    }
    // Order (third pass): the three theory columns, then 進步榜 | 新人榜, then 角色王 at the bottom.
    const at = (t: string): number => full.indexOf(t);
    const order = ['角色理論勝率 Top 10', '位置理論勝率 Top 10', '整體理論勝率 Top 10', '進步榜', '新人榜', '角色王'].map(at);
    expect(order.every((v) => v > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // No decimal point in any label of the sample (the URL and dates have none either).
    expect(full.replace(/<[^>]*>/g, ' ')).not.toMatch(/\d\.\d/);
    const height = (doc: string): number => Number(/height="(\d+)"/.exec(doc)?.[1]);
    expect(height(full)).toBeGreaterThan(height(svg));
  });

  it('the dashed baseline sits at the 全體 value, labelled 「全體 N%」 (no line without one)', () => {
    const withAvg = buildWeeklyChartSvg(minimal({ main: { title: 'T', note: null, rows: [{ rank: 1, name: '甲', value: 60, valueLabel: '60%' }], average: 46.1 } }));
    expect(withAvg).toContain('>全體 46%</text>');
    expect(withAvg).toContain('stroke-dasharray');
    const without = buildWeeklyChartSvg(minimal());
    expect(without).not.toContain('全體');
    expect(without).not.toContain(TIER_LEGEND);
    expect(without).not.toContain('stroke-dasharray');
  });

  it('Elo-PR tiers: one line per column, aligned, and the legend under the theory section', () => {
    expect(tierLine({ high: 50.2, mid: 45.4, low: 41.2 })).toBe('高 50%・中 45%・低 41%');
    expect(tierLine({ high: 50.2, mid: null, low: 41.2 })).toBe('高 50%・低 41%');
    expect(tierLine({ high: null, mid: null, low: null })).toBeNull();
    expect(tierLine(null)).toBeNull();
    const data = sampleWeeklyChartData();
    const svg = buildWeeklyChartSvg(data);
    const ys = [...svg.matchAll(/y="([\d.]+)"[^>]*>高 \d+%/g)].map((m) => m[1]);
    expect(ys.length).toBe(4); // three theory columns + 新人榜
    expect(new Set(ys.slice(0, 3)).size).toBe(1); // the theory columns' lines share one height
    expect(svg.split(TIER_LEGEND)).toHaveLength(2);
    const noTiers = buildWeeklyChartSvg({ ...data, main: { ...data.main, tiers: null }, position: { ...data.position!, tiers: null }, overall: { ...data.overall!, tiers: null } });
    expect(noTiers).not.toContain(TIER_LEGEND);
  });

  it('角色王 cards: red side tinted red, blue side tinted blue, up to three rank lines, ties on one line', () => {
    const svg = buildWeeklyChartSvg(sampleWeeklyChartData());
    expect(svg.match(/fill="#fdeceb"/g)).toHaveLength(4); // 刺客 莫甘娜 莫德雷德 奧伯倫
    expect(svg.match(/fill="#e9f1fd"/g)).toHaveLength(3); // 梅林 派西維爾 忠臣
    expect(svg).toContain('夜貓子／阿凱');
    expect(svg).toContain('等 4 人');
  });

  it('nothing smaller than 22 px', () => {
    const sizes = [...buildWeeklyChartSvg(sampleWeeklyChartData()).matchAll(/font-size="(\d+)"/g)].map((m) => Number(m[1]));
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(22);
  });

  it('an empty main board prints its note instead of bars', () => {
    const svg = buildWeeklyChartSvg(minimal({ main: { title: '角色理論勝率排行', note: null, rows: [], emptyNote: '目前沒有符合條件的玩家' } }));
    expect(svg).toContain('目前沒有符合條件的玩家');
    expect(svg).not.toContain('全體');
  });

  it('a missing value draws no bar and prints the dash', () => {
    const svg = buildWeeklyChartSvg(minimal({ main: { title: 'T', note: null, rows: [{ rank: 1, name: '甲', value: null, valueLabel: '—' }] } }));
    expect(svg).toContain('>—</text>');
    expect(svg).not.toMatch(/height="22" rx="4" fill="#2a78d6"/); // no bar (the heading's colour tick stays)
  });
});

describe('renderWeeklyChartPng', () => {
  it('renders the sample to a 1080-px-wide PNG under LINE\'s 1 MB preview limit', () => {
    const png = renderWeeklyChartPng(sampleWeeklyChartData());
    expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    const { width, height } = pngSize(png);
    expect(width).toBe(WEEKLY_CHART_WIDTH);
    expect(height).toBeGreaterThan(1500);
    expect(height).toBeLessThan(2600); // three columns: about half the single-column height
    expect(png.length).toBeLessThan(LINE_PREVIEW_MAX_BYTES);
  });

  it('renders hostile names and a minimal chart', () => {
    const png = renderWeeklyChartPng(
      minimal({ main: { title: 'T', note: null, rows: [{ rank: 1, name: '"><svg onload=x>&amp;\u0007', value: 51, valueLabel: '51.0%' }] } }),
    );
    expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
  });

  it('throws without the font (the caller then posts the text)', () => {
    expect(() => renderWeeklyChartPng(minimal(), { fontFile: '/nonexistent/font.ttf' })).toThrow(/font missing/);
  });
});

describe('weeklyChartData (mocked cache)', () => {
  const MONDAY = Date.UTC(2026, 10, 9, 4, 0); // 2026-11-09 12:00 +08

  it('the same boards as the text digest: main Top 10, 進步榜 Top 5, 角色王, 新人榜', async () => {
    cache.leaderboard = { asOf: '2026-11-08', boards: cache.boards() };
    const data = await weeklyChartData(MONDAY);
    expect(data.dateLabel).toBe('11/9');
    expect(data.subtitle).toBe('資料至 2026-11-08｜總計 2228 場・221 位玩家');
    expect(data.main.note).toBe('各人最近 100 場，近 90 天內有出賽、生涯至少 100 場');
    expect(data.main.rows).toHaveLength(10);
    expect(data.title).toBe('每週排行');
    expect(data.main.title).toBe('角色理論勝率 Top 10');
    expect(data.main.average).toBeCloseTo(46, 6);
    expect(data.main.rows[0]).toEqual({ rank: 1, name: '甲1', value: 60, valueLabel: '60%' });
    // 位置理論 / 整體理論: Top 10 from their own boards, title + qualifier from the cache, whole percents
    // (half up), the cache's order kept.
    expect(data.position?.title).toBe('位置理論勝率 Top 10');
    expect(data.position?.average).toBeCloseTo(46, 6);
    expect(data.position?.note).toBe('各人最近 100 場，近 90 天內有出賽、生涯至少 100 場');
    expect(data.position?.rows).toHaveLength(10);
    expect(data.position?.rows[0]).toEqual({ rank: 1, name: '戊1', value: 61.5, valueLabel: '62%' });
    expect(data.position?.rows.map((r) => r.name)).toEqual(Array.from({ length: 10 }, (_, i) => `戊${i + 1}`));
    expect(data.overall?.title).toBe('整體理論勝率 Top 10');
    expect(data.overall?.average).toBeCloseTo(46, 6);
    expect(data.overall?.note).toBe('各人生涯全部場次，近 90 天內有出賽、生涯至少 100 場');
    expect(data.overall?.rows[0]).toEqual({ rank: 1, name: '己1', value: 54.4, valueLabel: '54%' });
    expect(data.improved?.title).toBe('進步榜 Top 5');
    expect(data.improved?.rows).toHaveLength(5);
    expect(data.improved?.rows[0]).toMatchObject({ name: '乙1', value: 10, valueLabel: '+10', detail: '40% → 50%' });
    // This cache has no roleTop: the title holders (#1) only.
    expect(data.roleKings?.title).toBe('角色王');
    expect(data.roleKings?.entries).toEqual([
      { role: '刺客', side: 'red', ranks: [{ rank: 1, names: ['丁1', '丁2'], valueLabel: '90%' }] },
      { role: '梅林', side: 'blue', ranks: [{ rank: 1, names: ['丁3'], valueLabel: '55%' }] },
    ]);
    expect(data.newcomers?.average).toBeCloseTo(46, 6);
    expect(data.newcomers?.rows).toEqual([
      { rank: 1, name: '丙1', value: 47, valueLabel: '47%', detail: '41 場' },
      { rank: 2, name: '丙2', value: 45.5, valueLabel: '46%', detail: '11 場' },
    ]);
    expect(data.url).toContain('#stats');
    const png = await weeklyDigestPng(MONDAY);
    expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
  });

  it('角色王 Top 3 from roleTop: ranks ≤ 3, ties on one line, red roles before blue', async () => {
    const boards = cache.boards();
    const titles = boards.find((b) => b.id === 'roleTitles')!;
    titles.roleTop = {
      梅林: [
        { rank: 1, name: '丁3', value: 55, games: 25 },
        { rank: 2, name: '庚1', value: 52, games: 25 },
        { rank: 2, name: '庚2', value: 52, games: 25 },
        { rank: 4, name: '庚3', value: 48, games: 25 },
      ],
      刺客: [
        { rank: 1, name: '丁1', value: 90, games: 25 },
        { rank: 1, name: '丁2', value: 90, games: 25 },
        { rank: 3, name: '庚4', value: 84.5, games: 25 },
      ],
    };
    cache.leaderboard = { asOf: '2026-11-08', boards };
    const data = await weeklyChartData(Date.UTC(2026, 10, 9, 4, 0));
    expect(data.roleKings?.title).toBe('角色王 Top 3');
    expect(data.roleKings?.entries).toEqual([
      { role: '刺客', side: 'red', ranks: [{ rank: 1, names: ['丁1', '丁2'], valueLabel: '90%' }, { rank: 3, names: ['庚4'], valueLabel: '85%' }] },
      { role: '梅林', side: 'blue', ranks: [{ rank: 1, names: ['丁3'], valueLabel: '55%' }, { rank: 2, names: ['庚1', '庚2'], valueLabel: '52%' }] },
    ]);
    cache.leaderboard = { asOf: '2026-11-08', boards: cache.boards() };
  });

  it('全體 and the tiers from rating.theoryBaselines; without it 全體 = the population formula and no tiers', async () => {
    const group = (role: number, position: number, overall: number, players: number, games: number) => ({ role, position, overall, players, games });
    cache.rating = {
      theoryBaselines: {
        all: group(46.1, 46.2, 46.3, 194, 19273),
        tiers: { pr80plus: group(50.2, 50.4, 50.3, 14, 5296), pr20to80: group(45.2, 45.4, 45.3, 39, 10448), pr20minus: group(41.4, 41.2, 41.6, 13, 2457) },
        rule: { poolMinGames: 30, bounds: [20, 80] },
      },
    };
    try {
      const data = await weeklyChartData(Date.UTC(2026, 10, 9, 4, 0));
      expect(data.main.average).toBe(46.1);
      expect(data.main.tiers).toEqual({ high: 50.2, mid: 45.2, low: 41.4 });
      expect(data.position?.average).toBe(46.2);
      expect(data.position?.tiers).toEqual({ high: 50.4, mid: 45.4, low: 41.2 });
      expect(data.overall?.average).toBe(46.3);
      expect(data.overall?.tiers).toEqual({ high: 50.3, mid: 45.3, low: 41.6 });
      expect(data.newcomers?.tiers).toEqual(data.main.tiers); // 新人榜 uses the 角色理論 values
    } finally {
      cache.rating = null;
    }
    const data = await weeklyChartData(Date.UTC(2026, 10, 9, 4, 0));
    expect(data.main.average).toBeCloseTo(46, 6);
    expect(data.main.tiers).toBeNull();
    expect(chartBaselines(undefined, null)).toEqual({ all: { role: null, position: null, overall: null }, tiers: null });
  });

  it('population averages: the theory formulas fed the population\'s own final win rates; null when a cell is missing', () => {
    const avg = populationTheoryAverages(cache.overview as never);
    expect(avg.role).toBeCloseTo(0.1 * 70 * 4 + 0.1 * 30 * 2 + 0.4 * 30, 9);
    expect(avg.position).toBeCloseTo(46, 9);
    expect(avg.overall).toBeCloseTo(46, 9);
    expect(populationTheoryAverages(null)).toEqual({ role: null, position: null, overall: null });
    const partial = { ...(cache.overview as Record<string, unknown>), seatFinalWinRates: { 1: 50 } };
    expect(populationTheoryAverages(partial as never).position).toBeNull();
  });

  it('only the main board when the others are missing; the empty note on an old cache', async () => {
    cache.leaderboard = { asOf: '2026-11-08', boards: cache.boards().filter((b) => b.id === 'main') };
    let data = await weeklyChartData(MONDAY);
    expect(data.main.rows).toHaveLength(10);
    expect(data.position).toBeNull();
    expect(data.overall).toBeNull();
    expect(data.improved).toBeNull();
    expect(data.roleKings).toBeNull();
    expect(data.newcomers).toBeNull();

    cache.leaderboard = { asOf: '2026-11-08', boards: cache.boards().map(({ metric: _m, ...b }) => b) };
    data = await weeklyChartData(MONDAY);
    expect(data.main.rows).toEqual([]);
    expect(data.main.emptyNote).toContain('排行改版中');
    expect(data.improved).toBeNull();
    cache.leaderboard = { asOf: '2026-11-08', boards: cache.boards() };
  });
});

describe('/排行 chart (leaderboardChart)', () => {
  it('titled 「排行榜」, dated by the cache, the PNG rendered once per data version', async () => {
    __resetLeaderboardChartCacheForTests();
    cache.leaderboard = { asOf: '2026-11-08', boards: cache.boards() };
    const data = await leaderboardChartData();
    expect(data.title).toBe('排行榜');
    expect(data.dateLabel).toBe('11/8');
    const first = await leaderboardChart();
    expect(first.png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    const again = await leaderboardChart();
    expect(again.png).toBe(first.png); // same Buffer: not rendered again
    expect(again.key).toBe(first.key);

    cache.leaderboard = { asOf: '2026-11-09', boards: cache.boards() };
    const next = await leaderboardChart();
    expect(next.key).not.toBe(first.key);
    expect(next.png).not.toBe(first.png);
    cache.leaderboard = { asOf: '2026-11-08', boards: cache.boards() };
  });
});

describe('scheduler with the chart', () => {
  const MON_1200 = Date.UTC(2026, 10, 9, 4, 0);
  const quiet = { info: vi.fn(), warn: vi.fn() };

  it('hands the PNG and the fallback text to every destination', async () => {
    const got: Array<{ text: string; image: Buffer | null | undefined }> = [];
    const png = Buffer.from('png');
    const s = new WeeklyDigestScheduler({
      buildText: async () => 'TEXT',
      buildImage: async () => png,
      destinations: [{ name: 'a', send: async (text, image) => void got.push({ text, image }) }],
      logger: quiet,
    });
    expect(await s.tick(MON_1200)).toBe('posted');
    expect(got).toEqual([{ text: 'TEXT', image: png }]);
  });

  it('a failed render still posts the text', async () => {
    const got: Array<{ text: string; image: Buffer | null | undefined }> = [];
    const s = new WeeklyDigestScheduler({
      buildText: async () => 'TEXT',
      buildImage: async () => {
        throw new Error('no font');
      },
      destinations: [{ name: 'a', send: async (text, image) => void got.push({ text, image }) }],
      logger: quiet,
    });
    expect(await s.tick(MON_1200)).toBe('posted');
    expect(got).toEqual([{ text: 'TEXT', image: null }]);
    expect(quiet.warn).toHaveBeenCalledWith(expect.stringContaining('posting the text instead'), expect.any(Error));
  });
});

describe('ChatMirror.enqueueLineReplyImage', () => {
  const BASE = 'https://example.invalid';
  const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
  const png = renderWeeklyChartPng(minimal());

  function mirror(opts: { relay?: boolean } = {}): { m: ChatMirror; store: RelayMediaStore } {
    const store = new RelayMediaStore();
    const m = new ChatMirror({
      lineGroupId: 'Cgroup',
      lineReplyQueue: new LineReplyQueue(),
      lineImageRelay: opts.relay === false ? undefined : { store, publicBaseUrl: BASE },
      logger,
    });
    return { m, store };
  }

  it('queues the chart as a LINE image message plus the caption, served from the relay store', () => {
    const { m, store } = mirror();
    expect(m.enqueueLineReplyImage(png, 'TEXT DIGEST', WEEKLY_CHART_CAPTION)).toBe(true);
    const batch = m.drainLineReplies();
    expect(batch).toHaveLength(2);
    const { messages, images } = m.lineMessagesFor(batch);
    expect(images).toBe(1);
    const image = messages[0] as { type: string; originalContentUrl: string; previewImageUrl: string };
    expect(image.type).toBe('image');
    expect(image.originalContentUrl).toMatch(/^https:\/\/example\.invalid\/media\/relay\/[A-Za-z0-9_-]{32}\.png$/);
    expect(image.previewImageUrl).toBe(image.originalContentUrl);
    expect(messages[1]).toEqual({ type: 'text', text: WEEKLY_CHART_CAPTION });
    const id = /relay\/(.{32})\.png$/.exec(image.originalContentUrl)![1];
    expect(store.get(id)?.data.equals(png)).toBe(true);
  });

  it('the copy gone by drain time → the text digest instead', () => {
    const { m, store } = mirror();
    m.enqueueLineReplyImage(png, 'TEXT DIGEST');
    const batch = m.drainLineReplies();
    for (const id of batch[0].image!.mediaIds) store.delete(id);
    expect(m.lineMessagesFor(batch).messages).toEqual([{ type: 'text', text: 'TEXT DIGEST' }]);
  });

  it('relayReplyPngUrl: one live copy per key, reused; a new key stores a new copy', () => {
    const { m, store } = mirror();
    const a = m.relayReplyPngUrl(png, 'k1');
    expect(a).toMatch(/\/media\/relay\/[A-Za-z0-9_-]{32}\.png$/);
    expect(m.relayReplyPngUrl(png, 'k1')).toBe(a);
    expect(store.stats().entries).toBe(1);
    const b = m.relayReplyPngUrl(png, 'k2');
    expect(b).not.toBe(a);
    expect(store.stats().entries).toBe(2);
    // The copy gone (restart / expiry): stored again under the same key.
    store.delete(/relay\/(.{32})\.png$/.exec(a!)![1]);
    const c = m.relayReplyPngUrl(png, 'k1');
    expect(c).not.toBe(a);
    expect(mirror({ relay: false }).m.relayReplyPngUrl(png, 'k1')).toBeNull();
  });

  it('refuses (caller queues the text) without the relay or for a PNG over 1 MB', () => {
    expect(mirror({ relay: false }).m.enqueueLineReplyImage(png, 'T')).toBe(false);
    const { m, store } = mirror();
    expect(m.enqueueLineReplyImage(Buffer.alloc(LINE_PREVIEW_MAX_BYTES + 1), 'T')).toBe(false);
    expect(m.enqueueLineReplyImage(Buffer.alloc(0), 'T')).toBe(false);
    expect(store.stats().entries).toBe(0);
    expect(m.lineReplyQueueSize()).toBe(0);
  });
});
