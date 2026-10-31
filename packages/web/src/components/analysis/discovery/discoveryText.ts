/**
 * 自動發現的文字與連結（純函式，packages/server/src/__tests__/WebDiscovery.test.ts 測）：一句話的白話描述、差距與信賴
 * 區間的寫法、跟哪些分析分頁有關、可以套用的篩選子句或組成比較的分組。
 */
import {
  findingPages, type Clause, type DiscoveryFinding, type DiscoveryPage, type StrengthGrouping,
} from '@avalon/shared/stats';

export const PAGE_LABELS: Record<DiscoveryPage, string> = {
  overview: '總覽', teams: '派隊', votes: '投票', missions: '任務', lake: '湖中女神', assassination: '刺殺',
  position: '位置', roles: '角色與默契', strength: '陣容強度',
};

export function formatValue(v: number, kind: 'rate' | 'avg'): string {
  if (kind === 'avg') return v.toFixed(2);
  return `${v < 10 ? v.toFixed(1) : v.toFixed(0)}%`;
}

/** 差距：比率是百分點（pp），平均是同單位。 */
export function formatDiff(d: number, kind: 'rate' | 'avg'): string {
  const sign = d > 0 ? '+' : d < 0 ? '−' : '±';
  return kind === 'rate' ? `${sign}${Math.abs(d).toFixed(0)}pp` : `${sign}${Math.abs(d).toFixed(2)}`;
}

export function formatCi(f: Pick<DiscoveryFinding, 'lo' | 'hi' | 'metric'>): string {
  const k = f.metric.kind;
  const one = (v: number): string => (k === 'rate' ? `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(0)}` : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}`);
  return `95% CI ${one(f.lo)}～${one(f.hi)}${k === 'rate' ? 'pp' : ''}`;
}

/** 「梅林 PR 前 1/3（≥ 62）時，刺中率 38%；後 1/3（< 24）時 47%」。 */
export function findingSentence(f: DiscoveryFinding): string {
  const k = f.metric.kind;
  const dim = f.dimension.kind === 'category' ? `${f.dimension.label}是「${f.a.label}」` : `${f.dimension.label} ${f.a.label}`;
  const other = f.dimension.kind === 'category' ? '其他情況' : `${f.b.label}`;
  return `${dim}時，${f.metric.label} ${formatValue(f.a.value, k)}；${other}時 ${formatValue(f.b.value, k)}`;
}

/** 補充說明：跟 S 高度相關、控制 S 後的差。 */
export function findingNotes(f: DiscoveryFinding): string[] {
  const notes: string[] = [];
  if (typeof f.corrWithS === 'number' && Math.abs(f.corrWithS) >= 0.6) notes.push(`這個維度跟桌上 S 高度相關（r = ${f.corrWithS.toFixed(2)}）`);
  if (typeof f.withinS === 'number') notes.push(`在 S 三分層裡各自比，平均差 ${formatDiff(f.withinS, f.metric.kind)}`);
  return notes;
}

/** 可以直接套用的篩選子句（分類、年份、梅林座位）；沒有 = null。 */
export function findingClause(f: DiscoveryFinding): Clause | null {
  if (f.unit !== 'game' || f.dimension.kind !== 'category') return null;
  const v = f.a.label;
  if (f.dimension.id === 'category' && ['線瓦', '面瓦', '娛樂'].includes(v)) return { kind: 'category', in: [v as '線瓦'] };
  if (f.dimension.id === 'year' && /^\d{4}$/.test(v)) return { kind: 'date', from: `${v}-01-01`, to: `${v}-12-31` };
  const seat = /^(\d+) 號$/.exec(v);
  if (f.dimension.id === 'merlinSeat' && seat) return { kind: 'roleSeat', role: '梅林', seats: [Number(seat[1]) as 1] };
  return null;
}

/** 可以在組成比較打開的分組（陣容維度的三分位）。 */
export function findingGrouping(f: DiscoveryFinding): StrengthGrouping | null {
  return f.grouping ?? null;
}

export interface DiscoveryQuery {
  text: string;
  page: DiscoveryPage | 'all';
  unit: DiscoveryFinding['unit'] | 'all';
  structural: boolean;
  sort: 'effect' | 'q' | 'diff';
}

export const EMPTY_DISCOVERY_QUERY: DiscoveryQuery = { text: '', page: 'all', unit: 'all', structural: false, sort: 'effect' };

/** 清單的篩選與排序：關鍵字比對維度、組、指標的名字。 */
export function queryFindings(findings: readonly DiscoveryFinding[], q: DiscoveryQuery): DiscoveryFinding[] {
  const text = q.text.trim().toLowerCase();
  const out = findings.filter((f) => (q.structural || !f.dimension.structural)
    && (q.page === 'all' || findingPages(f).includes(q.page))
    && (q.unit === 'all' || f.unit === q.unit)
    && (!text || `${f.dimension.label} ${f.a.label} ${f.metric.label} ${f.metric.help}`.toLowerCase().includes(text)));
  const key = (f: DiscoveryFinding): number => (q.sort === 'q' ? f.q : q.sort === 'diff' ? -Math.abs(f.diff) : -Math.abs(f.effect));
  return out.sort((x, y) => key(x) - key(y));
}

/** 某分頁的前幾項（不含結構性維度）。 */
export function topForPage(findings: readonly DiscoveryFinding[], page: DiscoveryPage, n = 3): DiscoveryFinding[] {
  return queryFindings(findings, { ...EMPTY_DISCOVERY_QUERY, page }).slice(0, n);
}
