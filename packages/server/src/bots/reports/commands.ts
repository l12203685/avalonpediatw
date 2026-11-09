/**
 * 百科回報／ID 認領指令（Edward 2026-11-09：「回報跟ID認領都改用DC/LINE指令」）— LINE 文字指令與 Discord 斜線指令
 * 共用的解析與回覆文字。送出（編號、貼到 DC 同步閒聊＋LINE 群組）在 services/communityReports.ts。
 *
 *   LINE    /回報 [錯誤｜建議｜文章內容] 內容        （類型沒寫＝錯誤；全形 ／ 也可以）
 *           /認領 主ID 其他ID1 其他ID2 …            （名字有空白用「」包起來；也可以用 、 或 , 隔開）
 *   Discord /回報 類型:… 內容:…、/認領 主id:… 其他id:…
 *
 * docs/BOT_SETUP.md「百科回報與 ID 認領」.
 */

import {
  CLAIM_MAX_OTHERS,
  CLAIM_NAME_MAX,
  FEEDBACK_KIND_LABEL,
  FEEDBACK_MESSAGE_MAX,
  parseIdClaim,
  submitClaim,
  submitReport,
  type FeedbackKind,
  type ReportSource,
  type SubmitResult,
  type SyncDeps,
} from '../../services/communityReports';

export type ReportPlatform = 'line' | 'discord';

/** 指令寫法（說明裡用）。 */
export const REPORT_USAGE: Record<ReportPlatform, string> = {
  line: '/回報 [錯誤｜建議｜文章內容] 內容',
  discord: '/回報 類型 內容',
};
export const CLAIM_USAGE: Record<ReportPlatform, string> = {
  line: '/認領 主ID 其他ID…',
  discord: '/認領 主id 其他id',
};
export const REPORT_HELP_TEXT = '回報網站或文章的錯誤、建議（貼到 DC 同步閒聊＋LINE 群組，管理者每天處理）';
export const CLAIM_HELP_TEXT = '紀錄裡同一個人用過好幾個 ID：請管理者合併到主 ID';

export const REPORT_RECEIVED_TEXT = '已收到，會在每天的處理裡看';
export const CLAIM_RECEIVED_TEXT = '已送出，等管理者核准';
export const SUBMIT_UNAVAILABLE_TEXT = '現在送不出去（DC 暫時連不上），請稍後再試。';
export const SUBMIT_RATE_LIMITED_TEXT = '送出太頻繁了，請過幾分鐘再試。';
export const SUBMIT_REDELIVERY_TEXT = '這則已經處理過了，不會重複送出。';

/** 類型的寫法 → 類型（第一個字是類型就拿掉，否則整段都是內容、類型＝錯誤）。 */
const KIND_WORDS: Record<string, FeedbackKind> = {
  錯誤: 'bug', 错误: 'bug', 錯: 'bug', bug: 'bug', 問題: 'bug',
  建議: 'suggestion', 建议: 'suggestion', suggestion: 'suggestion',
  文章內容: 'content', 文章内容: 'content', 文章: 'content', 內容: 'content', content: 'content',
};

/** Discord /回報 類型選單（value＝FeedbackKind）。 */
export const REPORT_KIND_CHOICES: ReadonlyArray<{ name: string; value: FeedbackKind }> = [
  { name: '錯誤', value: 'bug' },
  { name: '建議', value: 'suggestion' },
  { name: '文章內容', value: 'content' },
];

export function kindOf(word: string | null | undefined): FeedbackKind | null {
  if (!word) return null;
  const w = word.normalize('NFKC').trim().toLowerCase();
  return KIND_WORDS[w] ?? null;
}

const REPORT_RE = /^[/／][\s　]*(?:回報|回报)(?=[\s　]|$)([\s\S]*)$/u;
const CLAIM_RE = /^[/／][\s　]*(?:認領|认领|ID認領|id認領)(?=[\s　]|$)([\s\S]*)$/iu;

export interface ReportTextCommand {
  kind: FeedbackKind;
  /** 內容（原樣，頭尾去空白；'' = 沒寫）。 */
  message: string;
}

/** "/回報 建議 加深色模式" → { kind: 'suggestion', message: '加深色模式' }；"/回報 首頁打不開" → 類型＝錯誤；不是指令 → null。 */
export function parseReportText(text: string): ReportTextCommand | null {
  const m = REPORT_RE.exec((text ?? '').trim());
  if (!m) return null;
  const body = m[1].trim();
  const first = /^(\S+)(?:[\s　]+([\s\S]*))?$/u.exec(body);
  const kind = first ? kindOf(first[1]) : null;
  if (first && kind) return { kind, message: (first[2] ?? '').trim() };
  return { kind: 'bug', message: body };
}

export interface ClaimTextCommand {
  /** 拆出來的名字（第一個＝主 ID）。 */
  names: string[];
}

/** 名字清單：「…」包住的算一個（可以有空白），其他用空白、、、, 隔開；← < - 之類的箭頭略過。 */
export function splitClaimNames(body: string): string[] {
  const names: string[] = [];
  const re = /「([^」]*)」|『([^』]*)』|([^\s　、,，;；]+)/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const name = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (!name || /^(?:←|<-|<--|<|=|＝|:|：)$/u.test(name)) continue;
    names.push(name);
  }
  return names;
}

/** "/認領 星野路 小路 「Kip Lune」" → { names: ['星野路', '小路', 'Kip Lune'] }；不是指令 → null。 */
export function parseClaimText(text: string): ClaimTextCommand | null {
  const m = CLAIM_RE.exec((text ?? '').trim());
  if (!m) return null;
  return { names: splitClaimNames(m[1]) };
}

/** 是不是回報／認領指令（意見主題計數、聊天匯出、LINE→DC 同步都略過；送出的那則已經貼到兩邊）。 */
export function isCommunityCommandText(text: string): boolean {
  return parseReportText(text) !== null || parseClaimText(text) !== null;
}

export function reportUsageText(platform: ReportPlatform): string {
  const example = platform === 'line' ? '/回報 牌譜頁在手機上表格超出畫面、/回報 建議 加一個深色模式' : '/回報 類型:建議 內容:加一個深色模式';
  return `用法：${REPORT_USAGE[platform]}（類型不寫就是錯誤），例如 ${example}。內容最多 ${FEEDBACK_MESSAGE_MAX} 字，會公開貼到 DC 同步閒聊和 LINE 群組。`;
}

export function claimUsageText(platform: ReportPlatform): string {
  const example = platform === 'line' ? '/認領 星野路 小路 「Kip Lune」' : '/認領 主id:星野路 其他id:小路 Kip_Lune';
  return `用法：${CLAIM_USAGE[platform]}，例如 ${example}。第一個是你要留的主 ID，後面是同一個人用過的其他 ID（最多 ${CLAIM_MAX_OTHERS} 個；名字有空白用「」包起來）。會公開貼到 DC 同步閒聊和 LINE 群組，管理者核准後在下一次每日資料更新生效。`;
}

/** parseIdClaim 的錯誤 → 中文。 */
export function claimErrorText(error: string, platform: ReportPlatform): string {
  if (error === 'main id required' || error === 'body required') return claimUsageText(platform);
  if (error === 'at least one other id required') return `至少要一個其他 ID。${claimUsageText(platform)}`;
  if (error.startsWith('at most')) return `其他 ID 最多 ${CLAIM_MAX_OTHERS} 個，請分次送。`;
  if (error === 'other id same as main id') return '其他 ID 不能跟主 ID 一樣（只差大小寫或全半形也算一樣）。';
  return `ID 不能是空的，最多 ${CLAIM_NAME_MAX} 個字。`;
}

export function submitResultText(result: SubmitResult, okText: string): string {
  if (result.ok) return `${okText}（編號 #${result.id}）`;
  return result.error === 'rate_limited' ? SUBMIT_RATE_LIMITED_TEXT : SUBMIT_UNAVAILABLE_TEXT;
}

export interface CommandContext {
  platform: ReportPlatform;
  /** 平台上的使用者 id（只拿來做頻率限制，不貼出去、不寫 log）。 */
  userId?: string;
  /** LINE 重送了這個程序處理過的事件：回覆，但不再送一次。 */
  redelivery?: boolean;
  deps?: SyncDeps;
}

/** 送一筆回報 → 回覆文字。 */
export async function answerReport(kind: FeedbackKind, message: string, ctx: CommandContext): Promise<string> {
  const text = message.trim();
  if (!text) return reportUsageText(ctx.platform);
  const source: ReportSource = ctx.platform;
  const result = await submitReport(
    { kind, message: text.slice(0, FEEDBACK_MESSAGE_MAX), source },
    { ...ctx.deps, userKey: ctx.userId ? `${ctx.platform}:${ctx.userId}` : undefined },
  );
  return submitResultText(result, REPORT_RECEIVED_TEXT);
}

/** 送一筆認領 → 回覆文字。 */
export async function answerClaim(names: string[], ctx: CommandContext): Promise<string> {
  if (names.length === 0) return claimUsageText(ctx.platform);
  const parsed = parseIdClaim({ main: names[0], others: names.slice(1) });
  if (!parsed.ok) return claimErrorText(parsed.error, ctx.platform);
  const result = await submitClaim(parsed.claim, ctx.platform, { ...ctx.deps, userKey: ctx.userId ? `${ctx.platform}:${ctx.userId}` : undefined });
  return submitResultText(result, CLAIM_RECEIVED_TEXT);
}

/** 打字的回報／認領指令 → 回覆文字；不是這兩個指令時 null。 */
export async function answerCommunityTextCommand(text: string, ctx: CommandContext): Promise<string | null> {
  const report = parseReportText(text);
  if (report) {
    if (ctx.redelivery) return SUBMIT_REDELIVERY_TEXT;
    return answerReport(report.kind, report.message, ctx);
  }
  const claim = parseClaimText(text);
  if (claim) {
    if (ctx.redelivery) return SUBMIT_REDELIVERY_TEXT;
    return answerClaim(claim.names, ctx);
  }
  return null;
}

export { FEEDBACK_KIND_LABEL };
