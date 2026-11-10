/**
 * Invented weekly-chart data (no real player names) for the weekly chart tests
 * and scripts/weeklyChartSample.ts. Numbers are in the range the real boards show.
 */
import type { WeeklyChartData } from '../../bots/stats/weeklyChart';

const MAIN: Array<[string, number]> = [
  ['星野旅人', 63.4],
  ['Ash Vale', 61.9],
  ['青石', 60.2],
  ['Mira K', 59.8],
  ['北風與太陽的長名字玩家', 58.7],
  ['小橘子', 58.1],
  ['Tovo Wren', 57.6],
  ['霧島', 56.9],
  ['juno_42', 56.2],
  ['白楊', 55.5],
];

export function sampleWeeklyChartData(): WeeklyChartData {
  return {
    dateLabel: '11/9',
    subtitle: '資料至 2026-11-08｜總計 2311 場・226 位玩家',
    main: {
      title: '角色理論勝率排行 Top 10',
      note: '各角色近 10 場、忠臣近 40 場，近 90 天內有出賽、六個特殊角色各至少 10 場、忠臣至少 40 場',
      rows: MAIN.map(([name, v], i) => ({ rank: i + 1, name, value: v, valueLabel: `${v.toFixed(1)}%` })),
    },
    improved: {
      title: '進步榜 Top 5',
      note: '各角色近 10 場 vs 再之前 10 場，近 90 天內有出賽',
      rows: [
        ['Ilse Marr', 12.4, 41.2, 53.6],
        ['藍莓派', 9.8, 44.0, 53.8],
        ['Kestrel', 7.1, 47.5, 54.6],
        ['阿凱', 5.6, 49.9, 55.5],
        ['夜貓子', 4.2, 50.3, 54.5],
      ].map(([name, d, prior, recent], i) => ({
        rank: i + 1,
        name: name as string,
        value: d as number,
        valueLabel: `+${(d as number).toFixed(1)}`,
        detail: `${(prior as number).toFixed(1)}% → ${(recent as number).toFixed(1)}%`,
      })),
    },
    roleKings: {
      title: '角色王',
      note: '各人該角色最近 20 場',
      entries: [
        { role: '梅林', names: ['星野旅人'], valueLabel: '75.0%' },
        { role: '派西維爾', names: ['Mira K'], valueLabel: '70.0%' },
        { role: '忠臣', names: ['青石', '白楊'], valueLabel: '62.5%' },
        { role: '刺客', names: ['Ash Vale'], valueLabel: '80.0%' },
        { role: '莫甘娜', names: ['霧島'], valueLabel: '75.0%' },
        { role: '莫德雷德', names: ['Tovo Wren'], valueLabel: '70.0%' },
        { role: '奧伯倫', names: ['小橘子', 'juno_42', '夜貓子', '晨光'], valueLabel: '65.0%' },
      ],
    },
    newcomers: {
      title: '新人榜',
      note: '2026-08-11 ～ 2026-11-08 打滿 10 場，新人例外：看全部場次，角色理論每個角色最多算近 10 場、忠臣 40 場',
      rows: [
        { rank: 1, name: '晨光', value: 54.3, valueLabel: '54.3%', detail: '18 場' },
        { rank: 2, name: 'Pip Hollow', value: 52.0, valueLabel: '52.0%', detail: '12 場' },
        { rank: 3, name: '雪球', value: 50.8, valueLabel: '50.8%', detail: '25 場' },
      ],
    },
    footerLines: ['查個人：/戰績 名字｜兩人默契：/默契 名字1 名字2', '完整圖表與個人戰績（不用登入）'],
    url: 'https://avalon-game-platform.web.app/#stats',
  };
}
