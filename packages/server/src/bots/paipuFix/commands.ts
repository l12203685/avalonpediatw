/**
 * 待修正牌譜清單指令（2026-11-09，Edward：「你直接加入一個功能給line/dc bot 讓他們可以送出目前需要修正的牌譜跟原因」）——
 * LINE 文字指令與 Discord 斜線指令共用的解析與回覆文字。清單本身在 services/paipuFixList.ts。
 *
 *   LINE    /待修正（也接受 /牌譜待修正、全形 ／）
 *   Discord /待修正（公開回覆）
 *
 * docs/BOT_SETUP.md「待修正牌譜清單」.
 */

import { loadPaipuFixList, type PaipuFixItem, type PaipuFixLoad } from '../../services/paipuFixList';

export type PaipuFixPlatform = 'line' | 'discord';

/** 指令寫法（說明裡用）。 */
export const PAIPU_FIX_USAGE: Record<PaipuFixPlatform, string> = {
  line: '/待修正',
  discord: '/待修正',
};

/** 說明裡的一行描述。 */
export const PAIPU_FIX_HELP_TEXT = '列出 DC 牌譜區目前需要修正的牌譜和原因';

export const PAIPU_FIX_NONE_TEXT = '目前沒有需要修正的牌譜。';
export const PAIPU_FIX_FOOTER = '改好首篇後不用做別的，每天凌晨的匯入會自動重新讀取。';
export const PAIPU_FIX_UNAVAILABLE_TEXT = '暫時讀不到 DC 牌譜區的待修正清單，請稍後再試。';
export const PAIPU_FIX_NOT_CONFIGURED_TEXT = '待修正清單還沒設定好（伺服器沒有 Discord bot token），暫時不能查。';
/** 找不到機器人的原因回覆時的原因欄。 */
export const PAIPU_FIX_NO_REASON = '（沒找到機器人的「🤖 牌譜格式檢查」回覆，請直接看討論串）';

/** 一則回覆的上限：LINE 5000 字、Discord 2000 字（用 UTF-16 長度算，比較保守）。 */
export const PAIPU_FIX_MAX_CHARS: Record<PaipuFixPlatform, number> = { line: 5000, discord: 2000 };
/** 一次最多列幾篇（再多只說還有幾篇）。 */
export const PAIPU_FIX_MAX_ITEMS = 15;
const TITLE_MAX_CHARS = 80;

/**
 * "/待修正"、"／牌譜待修正"、"/ 待修正" → true；其他 → false。指令後面要是結尾或空白，
 * 所以「/待修正的好多」仍是一般聊天。
 */
export function parsePaipuFixText(text: string): boolean {
  const t = (text ?? '').normalize('NFKC').trim();
  return /^\/\s*(?:牌譜待修正|牌谱待修正|待修正)(?:\s|$)/u.test(t);
}

/** 是不是待修正指令（意見主題計數與聊天匯出要略過）。 */
export function isPaipuFixCommandText(text: string): boolean {
  return parsePaipuFixText(text);
}

/** Discord 會把 * _ ~ ` | 等當格式：標題與原因照字面顯示。 */
function escapeDiscord(text: string): string {
  return text.replace(/([\\`*_~|[\]<])/g, '\\$1');
}

function cut(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

function itemBlock(item: PaipuFixItem, index: number, platform: PaipuFixPlatform): string {
  const title = cut(item.title, TITLE_MAX_CHARS) || '（沒有標題）';
  const reason = item.reason ? cut(item.reason, 200) : PAIPU_FIX_NO_REASON;
  const show = platform === 'discord' ? escapeDiscord : (s: string): string => s;
  return [`${index + 1}. ${show(title)}`, `原因：${show(reason)}`, item.url].join('\n');
}

/**
 * 清單 → 回覆文字：「目前有 N 篇牌譜需要修正：」、每篇（標題／原因／連結）、結尾提示。
 * 超過上限（字數或 PAIPU_FIX_MAX_ITEMS 篇）時只列前面的，並說還有幾篇。`staleMinutes`：DC 讀不到、用的是舊清單。
 */
export function formatPaipuFixReply(
  items: readonly PaipuFixItem[],
  platform: PaipuFixPlatform = 'line',
  opts: { maxChars?: number; maxItems?: number; staleMinutes?: number } = {},
): string {
  if (items.length === 0) return PAIPU_FIX_NONE_TEXT;
  const maxChars = opts.maxChars ?? PAIPU_FIX_MAX_CHARS[platform];
  const maxItems = Math.max(0, opts.maxItems ?? PAIPU_FIX_MAX_ITEMS);
  const head = [`目前有 ${items.length} 篇牌譜需要修正：`];
  if (opts.staleMinutes !== undefined) head.push(`（DC 暫時讀不到，這是約 ${Math.max(1, opts.staleMinutes)} 分鐘前的清單）`);
  const blocks = items.map((item, i) => itemBlock(item, i, platform));
  const build = (shown: number): string => {
    const parts = [head.join('\n'), ...blocks.slice(0, shown)];
    if (shown < items.length) {
      parts.push(`…還有 ${items.length - shown} 篇沒列出，請到 DC #牌譜紀錄與覆盤 用「待修正」標籤篩選。`);
    }
    parts.push(PAIPU_FIX_FOOTER);
    return parts.join('\n\n');
  };
  for (let shown = Math.min(items.length, maxItems); shown > 0; shown -= 1) {
    const text = build(shown);
    if (text.length <= maxChars) return text;
  }
  const text = build(0);
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

/** 讀清單的結果 → 回覆文字。 */
export function formatPaipuFixLoad(load: PaipuFixLoad, platform: PaipuFixPlatform, now: number = Date.now()): string {
  if (!load.ok) return load.error === 'not_configured' ? PAIPU_FIX_NOT_CONFIGURED_TEXT : PAIPU_FIX_UNAVAILABLE_TEXT;
  const staleMinutes = load.stale ? Math.round((now - load.fetchedAt) / 60000) : undefined;
  return formatPaipuFixReply(load.items, platform, { staleMinutes });
}

/** 目前待修正清單的回覆文字。不丟錯。 */
export async function answerPaipuFix(platform: PaipuFixPlatform): Promise<string> {
  return formatPaipuFixLoad(await loadPaipuFixList(), platform);
}

/** 打字的待修正指令 → 回覆文字；不是這個指令時 null。 */
export async function answerPaipuFixTextCommand(text: string, platform: PaipuFixPlatform = 'line'): Promise<string | null> {
  if (!parsePaipuFixText(text)) return null;
  return answerPaipuFix(platform);
}
