/**
 * 百科回報的「處理狀態」行（站長 2026-11-19：「bug 修正可以直接呈現在百科網站上嗎? (留言功能)」）。
 *
 * 狀態存在 DC #同步閒聊 裡 bot 自己那則【百科回報…】訊息：每日例行作業用
 *   scripts/listCommunityReports.ts --mark-processed <訊息 id> --note "…" --link <網址> [--status 已修正｜不處理｜處理中｜收到｜隱藏]
 * 把那則訊息的最後加一行（已經有就換掉）：
 *
 *   【處理・已修正】牌譜頁的表格改成可以左右滑｜<https://github.com/l12203685/avalonpediatw/pull/123>（已處理）
 *
 *   - 已修正／不處理／隱藏 的那行結尾帶「（已處理）」，所以舊的判斷（hasDoneMark）照樣算處理完；處理中／收到 不帶。
 *   - 說明跳脫 DC markdown（同回報內容），網址包在 <> 裡（DC 不展開預覽）。
 *   - 網站「回報與修正」頁（GET /api/reports，services/reportBoard.ts）讀這一行；隱藏＝不上網站。
 * 沒有這一行、只有舊的「（已處理）」標記（或 bot 回覆那則寫「已處理」）＝ 已處理（沒附說明）。
 */
import { escapeDiscordMarkdown, unescapeDiscordMarkdown } from './communityReports';

export const REPORT_STATUSES = ['收到', '處理中', '已修正', '不處理', '隱藏'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];
/** 網站上顯示的狀態：上面幾個（隱藏不會出現）＋舊標記的「已處理」。 */
export type PublicReportStatus = Exclude<ReportStatus, '隱藏'> | '已處理';

/** 這幾個狀態算處理完（那行結尾帶「（已處理）」）。 */
export const DONE_STATUSES: ReadonlySet<ReportStatus> = new Set<ReportStatus>(['已修正', '不處理', '隱藏']);

export const STATUS_LINE_PREFIX = '【處理・';
export const STATUS_NOTE_MAX = 300;
export const STATUS_LINK_MAX = 300;
const DONE = '（已處理）';

const STATUS_ALIASES: Record<string, ReportStatus> = {
  收到: '收到', received: '收到', open: '收到',
  處理中: '處理中', 'in-progress': '處理中', progress: '處理中', wip: '處理中',
  已修正: '已修正', 修正: '已修正', 已修好: '已修正', fixed: '已修正', done: '已修正',
  不處理: '不處理', wontfix: '不處理', "won't-fix": '不處理', 'wont-fix': '不處理', declined: '不處理',
  隱藏: '隱藏', hide: '隱藏', hidden: '隱藏',
};

/** "已修正" / "fixed" / "wontfix" … → 狀態；不認得 → null。 */
export function parseStatusName(raw: string | undefined): ReportStatus | null {
  const key = (raw ?? '').trim().toLowerCase();
  return STATUS_ALIASES[key] ?? null;
}

/** 只收 https 網址（不能有空白或 <>），太長或不是 → null。 */
export function cleanStatusLink(raw: string | undefined | null): string | null {
  const s = (raw ?? '').trim();
  if (!s || s.length > STATUS_LINK_MAX || !/^https:\/\/[^\s<>|｜]+$/.test(s)) return null;
  try {
    return new URL(s).protocol === 'https:' ? s : null;
  } catch {
    return null;
  }
}

/** 說明：一行、去掉開頭重複寫的狀態（「已修正：…」→「…」）。 */
export function cleanStatusNote(raw: string | undefined | null, status?: ReportStatus): string {
  // eslint-disable-next-line no-control-regex
  let s = (raw ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  for (const name of REPORT_STATUSES) {
    if (status && name !== status) continue;
    const m = new RegExp(`^${name}\\s*[:：]\\s*`).exec(s);
    if (m) { s = s.slice(m[0].length); break; }
  }
  return s.replace(/[|｜]/g, '／');
}

export interface StatusInfo {
  status: ReportStatus;
  note: string;
  link: string | null;
}

/** 狀態行（DC 版：說明跳脫 markdown、網址包 <>）。 */
export function formatStatusLine(info: StatusInfo): string {
  const note = escapeDiscordMarkdown(info.note);
  const link = info.link ? `｜<${info.link}>` : '';
  return `${STATUS_LINE_PREFIX}${info.status}】${note}${link}${DONE_STATUSES.has(info.status) ? DONE : ''}`;
}

/** 一行 → 狀態；不是狀態行 → null。 */
export function parseStatusLine(line: string): StatusInfo | null {
  const m = /^【處理・(收到|處理中|已修正|不處理|隱藏)】(.*)$/u.exec((line ?? '').trim());
  if (!m) return null;
  let rest = m[2];
  if (rest.endsWith(DONE)) rest = rest.slice(0, -DONE.length);
  let link: string | null = null;
  const lm = /｜<?(https:\/\/[^\s<>|｜]+?)>?$/u.exec(rest);
  if (lm) {
    link = cleanStatusLink(lm[1]);
    rest = rest.slice(0, lm.index);
  }
  return { status: m[1] as ReportStatus, note: unescapeDiscordMarkdown(rest).trim(), link };
}

/** 訊息裡最後一行狀態行（沒有 → null）。 */
export function findStatus(content: string): StatusInfo | null {
  let found: StatusInfo | null = null;
  for (const line of (content ?? '').split('\n')) {
    const s = parseStatusLine(line);
    if (s) found = s;
  }
  return found;
}

/**
 * 換上新的狀態行：拿掉舊的狀態行與行尾的「（已處理）」，最後加一行新的。
 * 換完的訊息超過 DC 的 2000 字 → null（呼叫的人回報失敗，不截斷）。
 */
export function applyStatus(content: string, info: StatusInfo): string | null {
  const lines = (content ?? '').split('\n').filter((l) => !parseStatusLine(l))
    .map((l) => (l.trimEnd().endsWith(DONE) ? l.trimEnd().slice(0, -DONE.length) : l));
  while (lines.length > 1 && lines[lines.length - 1].trim() === '') lines.pop();
  const next = [...lines, formatStatusLine(info)].join('\n');
  return next.length > 2000 ? null : next;
}
