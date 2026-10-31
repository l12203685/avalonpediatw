/**
 * 數據分析「陣容強度」組成比較的分組選項與數字格式（純函式，packages/server/src/__tests__/WebStrength.test.ts 測）。
 */
import type { StrengthGrouping } from '@avalon/shared/stats';

export type GroupingKind = StrengthGrouping['kind'];

export const GROUPING_OPTIONS: { kind: GroupingKind; label: string; help: string }[] = [
  { kind: 'tier', label: 'S 分層', help: '高強度 ≥65／偏強 55–65／一般 38–55／偏弱 <38' },
  { kind: 'count', label: 'PR X 以上至少 Y 人', help: '開打前 PR 至少 X 的座位有 Y 個以上 vs 其他（暫定不算）' },
  { kind: 'merlin', label: '梅林 PR', help: '梅林的開打前 PR：≥70／40–70／<40' },
  { kind: 'percival', label: '派西 PR', help: '派西維爾的開打前 PR：≥70／40–70／<40' },
  { kind: 'merlinVsAssassin', label: '梅林對刺客', help: '梅林 PR − 刺客 PR：梅林強 ≥20／相差 <20／刺客強 ≥20' },
  { kind: 'gap', label: '紅藍平均 PR 差', help: '紅方 4 人平均 PR − 藍方 6 人平均 PR：紅強 ≥10／相差 <10／藍強 ≥10' },
  { kind: 'weakRed', label: '最弱紅方', help: '紅方 PR 最低的那位低於 X vs 每位都至少 X' },
  { kind: 'weakLoyal', label: '最弱忠臣', help: '忠臣 PR 最低的那位低於 X vs 每位都至少 X' },
  { kind: 'tertile', label: '任一維度三分位', help: '選一個強度維度（紅方／忠臣／角色／座位…），依這批局的 1/3、2/3 分位數分成前、中、後三組' },
];

export const LOW_SAMPLE = 30;

export function buildGrouping(kind: GroupingKind, pr: number, count: number, weak: number, dim = 's'): StrengthGrouping {
  if (kind === 'tertile') return { kind, dim };
  if (kind === 'count') return { kind, pr, count };
  if (kind === 'weakRed' || kind === 'weakLoyal') return { kind, pr: weak };
  return { kind } as StrengthGrouping;
}

/** 數字的寫法：比率整數 %（小於 10 留一位）、平均一位小數。 */
export function formatMetric(v: number | null, kind: 'rate' | 'avg'): string {
  if (v === null) return '—';
  if (kind === 'avg') return v.toFixed(1);
  return `${v < 10 ? v.toFixed(1) : v.toFixed(0)}%`;
}

/** 跟全部的差：比率是百分點，平均是同單位；差很小時灰色。 */
export function formatDelta(v: number | null, all: number | null, kind: 'rate' | 'avg'): { text: string; tone: 'up' | 'down' | 'flat' } | null {
  if (v === null || all === null) return null;
  const digits = kind === 'rate' ? 0 : 1;
  const d = Number((v - all).toFixed(digits));
  const big = kind === 'rate' ? Math.abs(d) >= 3 : Math.abs(d) >= Math.max(0.5, Math.abs(all) * 0.1);
  const text = `${d > 0 ? '+' : d < 0 ? '−' : '±'}${Math.abs(d).toFixed(digits)}`;
  return { text, tone: !big ? 'flat' : d > 0 ? 'up' : 'down' };
}

