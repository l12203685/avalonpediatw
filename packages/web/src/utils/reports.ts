/**
 * 網站「回報與修正」頁的型別與純函式（站長 2026-11-19：「bug 修正可以直接呈現在百科網站上嗎? (留言功能)」）。
 *
 * 資料：伺服器 GET /api/reports（packages/server/src/services/reportBoard.ts 的 PublicReport；沒有暱稱）。
 * 純函式放這裡，packages/server/src/__tests__/WebReports.test.ts 測（web 沒有測試執行器）。
 */

export type ReportStatus = '收到' | '處理中' | '已修正' | '已處理' | '不處理';
export type ReportKind = 'bug' | 'suggestion' | 'content' | 'correction';
export type ReportSource = 'web' | 'line' | 'discord';

export interface PublicReport {
  id: string;
  createdAt: string;
  kind: ReportKind | null;
  kindLabel: string;
  source: ReportSource | null;
  page: string | null;
  text: string;
  status: ReportStatus;
  note: string | null;
  link: string | null;
  updatedAt: string | null;
}

/** 篩選的順序與顏色（Tailwind class）。 */
export const REPORT_STATUS_ORDER: readonly ReportStatus[] = ['收到', '處理中', '已修正', '已處理', '不處理'];
export const REPORT_STATUS_STYLE: Readonly<Record<ReportStatus, string>> = {
  收到: 'border-sky-700 bg-sky-950/60 text-sky-200',
  處理中: 'border-amber-600 bg-amber-950/60 text-amber-200',
  已修正: 'border-emerald-600 bg-emerald-950/60 text-emerald-200',
  已處理: 'border-teal-700 bg-teal-950/50 text-teal-200',
  不處理: 'border-zinc-600 bg-zinc-800/80 text-zinc-300',
};
/** 狀態的一句話說明（chip 的 title）。 */
export const REPORT_STATUS_HINT: Readonly<Record<ReportStatus, string>> = {
  收到: '管理者已經收到，還沒處理',
  處理中: '正在處理',
  已修正: '已經修好或改好',
  已處理: '已處理（舊的回報，沒有附說明）',
  不處理: '看過了，這次不改（下面有原因）',
};

export const SOURCE_LABEL: Readonly<Record<ReportSource, string>> = { web: '網站', line: 'LINE', discord: 'DC' };

export type StatusFilter = ReportStatus | 'all' | 'open';

/** 篩選：all＝全部、open＝還沒處理完（收到＋處理中）、其他＝那個狀態。 */
export function filterReports(reports: readonly PublicReport[], filter: StatusFilter): PublicReport[] {
  if (filter === 'all') return [...reports];
  if (filter === 'open') return reports.filter((r) => r.status === '收到' || r.status === '處理中');
  return reports.filter((r) => r.status === filter);
}

/** 每個狀態幾筆（篩選按鈕上的數字）。 */
export function countByStatus(reports: readonly PublicReport[]): Record<ReportStatus, number> {
  const out = { 收到: 0, 處理中: 0, 已修正: 0, 已處理: 0, 不處理: 0 } as Record<ReportStatus, number>;
  for (const r of reports) if (r.status in out) out[r.status] += 1;
  return out;
}

/** 篩選按鈕上的數字。 */
export function filterCount(counts: Readonly<Record<ReportStatus, number>>, filter: StatusFilter): number {
  if (filter === 'all') return REPORT_STATUS_ORDER.reduce((n, s) => n + counts[s], 0);
  if (filter === 'open') return counts['收到'] + counts['處理中'];
  return counts[filter];
}

/** 處理說明的連結字：GitHub PR →「PR #123」，其他 → 網域。 */
export function reportLinkText(url: string): string {
  const pr = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/.exec(url);
  if (pr) return `PR #${pr[1]}`;
  try {
    return new URL(url).hostname;
  } catch {
    return '連結';
  }
}

/** 新的在前（同一秒的照編號）。 */
export function sortNewest(reports: readonly PublicReport[]): PublicReport[] {
  return [...reports].sort((a, b) => (b.createdAt === a.createdAt ? b.id.localeCompare(a.id) : b.createdAt.localeCompare(a.createdAt)));
}

/** ISO → 台北時間「11/19」（今年）或「2025/11/19」；壞的 → ''。 */
export function reportDateText(iso: string | null | undefined, now: number = Date.now()): string {
  const t = Date.parse(iso ?? '');
  if (!Number.isFinite(t)) return '';
  const d = new Date(t + 8 * 3600_000);
  const thisYear = new Date(now + 8 * 3600_000).getUTCFullYear();
  const md = `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  return d.getUTCFullYear() === thisYear ? md : `${d.getUTCFullYear()}/${md}`;
}

const PAGE_LABELS: readonly [RegExp, string][] = [
  [/^(stats|analytics|leaderboard|rank)\b/i, '戰績排行'],
  [/^(analysis|player|study)\b/i, '數據分析'],
  [/^(wiki|concepts)\b/i, '百科攻略'],
  [/^(streams)\b/i, '直播回放'],
  [/^(records|paipu)\b/i, '牌譜紀錄'],
  [/^(ai-?games?|seat-?filler|fill)\b/i, '百科AI 對局'],
  [/^practice\b/i, '與機器人練習'],
  [/^(id-?)?claim\b|^idClaim\b/i, 'ID 認領'],
  [/^(reports?|feedback)\b/i, '回報與修正'],
];

/** 回報時的頁面（'/#records=123'）→「牌譜紀錄」；認不得 → 原樣；沒有或只有 '/' → ''。 */
export function pageLabel(page: string | null | undefined): string {
  const p = (page ?? '').trim();
  const hash = p.includes('#') ? p.slice(p.indexOf('#') + 1) : '';
  if (!hash) return p && p !== '/' ? p : '';
  for (const [re, label] of PAGE_LABELS) if (re.test(hash)) return label;
  return `#${hash}`.slice(0, 40);
}

/** 網站回報時要帶的頁面：網址有 # 就用它，沒有就用現在的頁面（App 切頁籤時會清掉 #）。 */
export function feedbackPage(pathname: string, hash: string, gameState: string | null | undefined): string {
  if (hash && hash !== '#') return `${pathname}${hash}`;
  return gameState && gameState !== 'home' ? `${pathname}#${gameState}` : pathname;
}

// ── 網址 ──────────────────────────────────────────────────────────────────────────────

/** #reports（#report、#feedback、#fixes、#回報）→ true。 */
export function isReportsHash(hash: string | null | undefined): boolean {
  let raw = (hash ?? '').replace(/^#/, '').trim();
  try {
    raw = decodeURIComponent(raw);
  } catch {
    // 留原樣
  }
  return /^(reports?|feedback|fixes|回報|回報與修正)$/i.test(raw);
}

export const REPORTS_HASH = '#reports';

// ── 自己送過的編號（只存在這個瀏覽器，用來標「你送的」） ─────────────────────────────

export const MY_REPORTS_KEY = 'avalon.reports.mine';
const MY_REPORTS_MAX = 50;

/** localStorage 的字串 → 編號清單（壞的 → []）。 */
export function parseMyReports(raw: string | null | undefined): string[] {
  try {
    const v = JSON.parse(raw ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && /^R[0-9A-Z]{4,12}$/.test(x)).slice(0, MY_REPORTS_MAX) : [];
  } catch {
    return [];
  }
}

/** 加一個編號（新的在前、不重複、最多 50 個）。 */
export function addMyReport(list: readonly string[], id: string): string[] {
  if (!/^R[0-9A-Z]{4,12}$/.test(id)) return [...list];
  return [id, ...list.filter((x) => x !== id)].slice(0, MY_REPORTS_MAX);
}

export function loadMyReports(): string[] {
  try {
    return parseMyReports(localStorage.getItem(MY_REPORTS_KEY));
  } catch {
    return [];
  }
}

export function rememberMyReport(id: string): string[] {
  const next = addMyReport(loadMyReports(), id);
  try {
    localStorage.setItem(MY_REPORTS_KEY, JSON.stringify(next));
  } catch {
    // 私密視窗等：不記也沒關係
  }
  return next;
}
