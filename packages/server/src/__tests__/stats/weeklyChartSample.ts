/**
 * Invented weekly-chart data (no real player names) for the weekly chart tests
 * and scripts/weeklyChartSample.ts. Numbers are in the range the real boards show.
 */
import { chartPct, chartSigned, type WeeklyChartData, type WeeklyChartRoleRank } from '../../bots/stats/weeklyChart';

const MAIN: Array<[string, number]> = [
  ['星野旅人', 63],
  ['Ash Vale', 62],
  ['青石', 60],
  ['Mira K', 59],
  ['北風與太陽的長名字玩家', 58],
  ['小橘子', 57],
  ['Tovo Wren', 57],
  ['霧島', 56],
  ['juno_42', 55],
  ['白楊', 54],
];

// 位置理論 / 整體理論 are not whole percents in the cache (seat windows, career games); the chart rounds them.
const POSITION: Array<[string, number]> = [
  ['青石', 61.1],
  ['星野旅人', 60.6],
  ['Kestrel', 58.3],
  ['小橘子', 55.8],
  ['霧島', 55.2],
  ['Ash Vale', 54.9],
  ['藍莓派', 54.5],
  ['Pip Hollow', 53.7],
  ['白楊', 53.1],
  ['Mira K', 52.6],
];

const OVERALL: Array<[string, number]> = [
  ['Ash Vale', 54.1],
  ['星野旅人', 50.1],
  ['北風與太陽的長名字玩家', 50.1],
  ['Tovo Wren', 49.9],
  ['青石', 49.4],
  ['juno_42', 48.7],
  ['夜貓子', 48.3],
  ['小橘子', 47.6],
  ['阿凱', 47.2],
  ['霧島', 46.5],
];

const bars = (list: Array<[string, number]>) =>
  list.map(([name, v], i) => ({ rank: i + 1, name, value: v, valueLabel: chartPct(v) }));

const ranks = (...list: Array<[number, string[], number]>): WeeklyChartRoleRank[] =>
  list.map(([rank, names, v]) => ({ rank, names, valueLabel: chartPct(v) }));

/** Population averages like the real cache's (≈ 46%: red wins about 69% of games finally). */
export const SAMPLE_AVERAGE = 46.1;

export function sampleWeeklyChartData(): WeeklyChartData {
  return {
    title: '每週排行',
    dateLabel: '11/9',
    subtitle: '資料至 2026-11-08｜總計 2311 場・226 位玩家',
    main: {
      title: '角色理論勝率 Top 10',
      note: '各角色近 10 場、忠臣近 40 場，近 90 天內有出賽、六個特殊角色各至少 10 場、忠臣至少 40 場',
      rows: bars(MAIN),
      average: SAMPLE_AVERAGE,
    },
    position: { title: '位置理論勝率 Top 10', note: '各人最近 100 場，近 90 天內有出賽、生涯至少 100 場', rows: bars(POSITION), average: 46.2 },
    overall: { title: '整體理論勝率 Top 10', note: '各人生涯全部場次，近 90 天內有出賽、生涯至少 100 場', rows: bars(OVERALL), average: 46.0 },
    improved: {
      title: '進步榜 Top 5',
      note: '各角色近 10 場、忠臣近 40 場 vs 再之前同樣場數，近 90 天內有出賽',
      rows: [
        ['Ilse Marr', 12, 41, 53],
        ['藍莓派', 10, 44, 54],
        ['Kestrel', 7, 48, 55],
        ['阿凱', 6, 49, 55],
        ['夜貓子', 4, 50, 54],
      ].map(([name, d, prior, recent], i) => ({
        rank: i + 1,
        name: name as string,
        value: d as number,
        valueLabel: chartSigned(d as number),
        detail: `${chartPct(prior as number)} → ${chartPct(recent as number)}`,
      })),
    },
    newcomers: {
      title: '新人榜',
      note: '2026-08-11 ～ 2026-11-08 打滿 10 場，新人例外：看全部場次，角色理論每個角色最多算近 10 場、忠臣 40 場',
      average: SAMPLE_AVERAGE,
      rows: [
        ['晨光', 54.3, 18],
        ['Pip Hollow', 52.5, 12],
        ['雪球', 50.8, 25],
        ['小滿', 48.2, 14],
        ['Rowan', 47.6, 31],
      ].map(([name, v, games], i) => ({ rank: i + 1, name: name as string, value: v as number, valueLabel: chartPct(v as number), detail: `${games} 場` })),
    },
    roleKings: {
      title: '角色王 Top 3',
      note: '忠臣近 100 場、其他角色近 25 場',
      entries: [
        { role: '刺客', side: 'red', ranks: ranks([1, ['Ash Vale'], 80], [2, ['霧島'], 76], [3, ['夜貓子', '阿凱'], 72]) },
        { role: '莫甘娜', side: 'red', ranks: ranks([1, ['霧島'], 76], [2, ['青石'], 72], [3, ['Kestrel'], 68]) },
        { role: '莫德雷德', side: 'red', ranks: ranks([1, ['Tovo Wren'], 72], [2, ['小橘子'], 68], [3, ['白楊'], 64]) },
        { role: '奧伯倫', side: 'red', ranks: ranks([1, ['小橘子', 'juno_42', '夜貓子', '晨光'], 68], [3, ['Mira K'], 64]) },
        { role: '梅林', side: 'blue', ranks: ranks([1, ['星野旅人'], 48], [2, ['Mira K'], 44], [3, ['青石'], 40]) },
        { role: '派西維爾', side: 'blue', ranks: ranks([1, ['Mira K'], 44], [2, ['藍莓派', 'Pip Hollow'], 40]) },
        { role: '忠臣', side: 'blue', ranks: ranks([1, ['青石', '白楊'], 39], [3, ['北風與太陽的長名字玩家'], 37]) },
      ],
    },
    footerLines: ['查個人：/戰績 名字｜兩人默契：/默契 名字1 名字2', '完整圖表與個人戰績（不用登入）'],
    url: 'https://avalon-game-platform.web.app/#stats',
  };
}
