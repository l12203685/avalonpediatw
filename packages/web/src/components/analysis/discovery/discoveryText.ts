/**
 * 自動發現的文字與連結（純函式，packages/server/src/__tests__/WebDiscovery.test.ts 測）：一句話的白話描述、差距與信賴
 * 區間的寫法、跟哪些分析分頁有關、可以套用的篩選子句或組成比較的分組。
 */
import {
  findingPages, strategyLine, type Clause, type DiscoveryFinding, type DiscoveryLink, type DecisiveRankScope, type DiscoveryPage, type StrengthGrouping,
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
  // 兩組直接比（強者 vs 新手、高端 vs 歡樂）時寫出另一組的名字
  const other = f.dimension.kind !== 'category' ? `${f.b.label}` : f.dimension.pair ? `「${f.b.label}」` : '其他情況';
  return `${dim}時，${f.metric.label} ${formatValue(f.a.value, k)}；${other}時 ${formatValue(f.b.value, k)}`;
}

/** 補充說明：跟 S 高度相關、控制 S 後的差；事件單位：同一個角色裡比的差。 */
export function findingNotes(f: DiscoveryFinding): string[] {
  const notes: string[] = [];
  if (typeof f.corrWithS === 'number' && Math.abs(f.corrWithS) >= 0.6) notes.push(`這個維度跟桌上 S 高度相關（r = ${f.corrWithS.toFixed(2)}）`);
  if (typeof f.withinS === 'number') notes.push(`在 S 三分層裡各自比，平均差 ${formatDiff(f.withinS, f.metric.kind)}`);
  if (typeof f.withinRole === 'number') notes.push(`在同一個角色裡比，平均差 ${formatDiff(f.withinRole, f.metric.kind)}`);
  return notes;
}

/** 事件單位的樣本：幾局、幾位有寫名字的玩家（檢定已算進同一局、同一位玩家的相關）。 */
export function findingClusters(f: DiscoveryFinding): string | null {
  if (!f.clustered) return null;
  const side = (g: DiscoveryFinding['a']): string => `${g.label} ${g.games ?? 0} 局 ${g.players ?? 0} 人`;
  return `${side(f.a)}、${side(f.b)}（同一局、同一人的相關已算進檢定）`;
}

/** 可能的策略那一行（沒有或不給 = null）。 */
export function findingStrategy(f: DiscoveryFinding): string | null {
  return f.strategy ? strategyLine(f.strategy) : null;
}

/** 數字所在的分頁：哪一頁、按鈕的字、數據排行要切的範圍（兩紅之後／第 3～5 局）。 */
export interface FindingLink {
  kind: DiscoveryLink;
  label: string;
  scope?: DecisiveRankScope;
}

export function findingLink(f: DiscoveryFinding): FindingLink | null {
  const kind = f.metric.link;
  if (!kind) return null;
  if (kind === 'twoRedCohort') return { kind, label: '看數字：陣容強度 › 兩紅派隊分組' };
  const scope: DecisiveRankScope = f.dimension.id === 'twoRedState' && f.a.label === '紅方已兩勝' ? 'twoRed' : 'r35';
  const which = kind === 'decisiveBoard' ? '關鍵票' : '全部投票';
  return { kind, scope, label: `看數字：數據排行 › 關鍵外白／內黑（${which}、${scope === 'twoRed' ? '兩紅之後' : '第 3～5 局'}）` };
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
    && (!text || `${f.dimension.label} ${f.a.label} ${f.b.label} ${f.metric.label} ${f.metric.help} ${f.strategy?.text ?? ''}`.toLowerCase().includes(text)));
  const key = (f: DiscoveryFinding): number => (q.sort === 'q' ? f.q : q.sort === 'diff' ? -Math.abs(f.diff) : -Math.abs(f.effect));
  return out.sort((x, y) => key(x) - key(y));
}

/** 某分頁的前幾項（不含結構性維度）。 */
export function topForPage(findings: readonly DiscoveryFinding[], page: DiscoveryPage, n = 3): DiscoveryFinding[] {
  return queryFindings(findings, { ...EMPTY_DISCOVERY_QUERY, page }).slice(0, n);
}
