/**
 * Invented weekly-chart data (no real player names) for the weekly chart tests
 * and scripts/weeklyChartSample.ts. Numbers are in the range the real boards show.
 */
import { chartPct, chartSigned, type WeeklyChartData } from '../../bots/stats/weeklyChart';

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

export function sampleWeeklyChartData(): WeeklyChartData {
  return {
    title: '每週排行',
    dateLabel: '11/9',
    subtitle: '資料至 2026-11-08｜總計 2311 場・226 位玩家',
    main: {
      title: '角色理論勝率排行 Top 10',
      note: '各角色近 10 場、忠臣近 40 場，近 90 天內有出賽、六個特殊角色各至少 10 場、忠臣至少 40 場',
      rows: bars(MAIN),
    },
    position: { title: '位置理論勝率排行 Top 10', note: '各人最近 100 場，近 90 天內有出賽、生涯至少 100 場', rows: bars(POSITION) },
    overall: { title: '整體理論勝率排行 Top 10', note: '各人生涯全部場次，近 90 天內有出賽、生涯至少 100 場', rows: bars(OVERALL) },
    improved: {
      title: '進步榜 Top 5',
      note: '各角色近 10 場 vs 再之前 10 場，近 90 天內有出賽',
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
    roleKings: {
      title: '角色王',
      note: '各人該角色最近 20 場',
      entries: [
        { role: '梅林', names: ['星野旅人'], valueLabel: '75%' },
        { role: '派西維爾', names: ['Mira K'], valueLabel: '70%' },
        { role: '忠臣', names: ['青石', '白楊'], valueLabel: '63%' },
        { role: '刺客', names: ['Ash Vale'], valueLabel: '80%' },
        { role: '莫甘娜', names: ['霧島'], valueLabel: '75%' },
        { role: '莫德雷德', names: ['Tovo Wren'], valueLabel: '70%' },
        { role: '奧伯倫', names: ['小橘子', 'juno_42', '夜貓子', '晨光'], valueLabel: '65%' },
      ],
    },
    newcomers: {
      title: '新人榜',
      note: '2026-08-11 ～ 2026-11-08 打滿 10 場，新人例外：看全部場次，角色理論每個角色最多算近 10 場、忠臣 40 場',
      rows: [
        { rank: 1, name: '晨光', value: 54.3, valueLabel: chartPct(54.3), detail: '18 場' },
        { rank: 2, name: 'Pip Hollow', value: 52.5, valueLabel: chartPct(52.5), detail: '12 場' },
        { rank: 3, name: '雪球', value: 50.8, valueLabel: chartPct(50.8), detail: '25 場' },
      ],
    },
    footerLines: ['查個人：/戰績 名字｜兩人默契：/默契 名字1 名字2', '完整圖表與個人戰績（不用登入）'],
    url: 'https://avalon-game-platform.web.app/#stats',
  };
}
