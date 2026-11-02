/**
 * 網站「問題回報」→ DC 論壇 #百科問題回報（Edward 2026-11-02：「DC + 百科網站上用個類似錯誤或是反映問題回報專區」
 * 「固定每天去收回報訊息 針對回報去處理」）。
 *
 * 每則回報在論壇開一篇討論串，掛類型標籤（錯誤／建議／文章內容）。用伺服器既有的 DISCORD_BOT_TOKEN（Render 上已設，
 * 牌譜回覆也用它）。論壇在 DC 群組裡大家都看得到，所以只貼回報者自己打的內容與自己填的暱稱（沒填 = 匿名），
 * 不帶登入帳號名稱；allowed_mentions 關掉，內容裡的 @everyone 不會叫人。記錄只寫狀態碼，不寫內容。
 *
 * 論壇與標籤 id 不是秘密（DC 網址上就看得到）；FEEDBACK_FORUM_CHANNEL_ID=off 關掉。
 */

export type FeedbackKind = 'bug' | 'suggestion' | 'content';

export const FEEDBACK_KINDS: readonly FeedbackKind[] = ['bug', 'suggestion', 'content'];

/** DC 論壇 #百科問題回報（2026-11-02 建立，在「阿瓦隆百科」分類下）。 */
export const DEFAULT_FEEDBACK_FORUM_ID = '1566833113248571514';

/** 論壇標籤 id：錯誤／建議／文章內容。 */
export const FEEDBACK_FORUM_TAGS: Record<FeedbackKind, string> = {
  bug: '1566833113248571515',
  suggestion: '1566833113248571516',
  content: '1566833113248571517',
};

export const FEEDBACK_KIND_LABEL: Record<FeedbackKind, string> = {
  bug: '錯誤',
  suggestion: '建議',
  content: '文章內容',
};

export const FEEDBACK_MESSAGE_MAX = 1000;
export const FEEDBACK_NAME_MAX = 32;
export const FEEDBACK_PAGE_MAX = 200;

export interface FeedbackReport {
  kind: FeedbackKind;
  message: string;
  /** 回報者自己填的暱稱（選填）。 */
  name?: string;
  /** 回報時所在的頁面（網址路徑＋#，選填）。 */
  page?: string;
}

export interface ForumThreadPayload {
  name: string;
  applied_tags: string[];
  message: { content: string; allowed_mentions: { parse: [] } };
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** 只留站內頁面路徑（/…或#…），其他（外部網址、怪字元）丟掉。 */
export function cleanPage(page: unknown): string {
  if (typeof page !== 'string') return '';
  const p = oneLine(page).slice(0, FEEDBACK_PAGE_MAX);
  return /^[/#][^\s<>`]*$/.test(p) ? p : '';
}

export function resolveFeedbackForumId(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.FEEDBACK_FORUM_CHANNEL_ID || '').trim();
  if (['off', 'none', 'false', '0', 'no'].includes(raw.toLowerCase())) return '';
  return raw || DEFAULT_FEEDBACK_FORUM_ID;
}

/** 組討論串：標題「[類型] 內容開頭」，內文＝內容＋頁面＋暱稱。 */
export function buildFeedbackThread(r: FeedbackReport): ForumThreadPayload {
  const label = FEEDBACK_KIND_LABEL[r.kind];
  const message = r.message.trim().slice(0, FEEDBACK_MESSAGE_MAX);
  const head = oneLine(message).slice(0, 60) || label;
  const name = oneLine(r.name ?? '').slice(0, FEEDBACK_NAME_MAX) || '匿名';
  const page = cleanPage(r.page);
  const lines = [message, '', `— 網站回報・${label}・${name}`];
  if (page) lines.push(`頁面：\`https://avalonpediatw.com${page.startsWith('#') ? '/' : ''}${page}\``);
  return {
    name: `[${label}] ${head}`.slice(0, 100),
    applied_tags: [FEEDBACK_FORUM_TAGS[r.kind]],
    message: { content: lines.join('\n').slice(0, 2000), allowed_mentions: { parse: [] } },
  };
}

export type FeedbackForumOutcome = 'sent' | 'skipped' | 'failed';

/** 開討論串。沒有 token／論壇關掉 → skipped；失敗只記狀態碼。 */
export async function postFeedbackThread(
  r: FeedbackReport,
  opts: { token?: string; forumId?: string; fetchImpl?: typeof fetch; log?: (m: string) => void } = {},
): Promise<FeedbackForumOutcome> {
  const token = (opts.token ?? process.env.DISCORD_BOT_TOKEN ?? '').trim();
  const forumId = opts.forumId ?? resolveFeedbackForumId();
  const log = opts.log ?? ((m: string): void => console.warn(`[feedback-forum] ${m}`));
  if (!token || !forumId) return 'skipped';
  try {
    const res = await (opts.fetchImpl ?? fetch)(`https://discord.com/api/v10/channels/${forumId}/threads`, {
      method: 'POST',
      headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(buildFeedbackThread(r)),
    });
    if (res.ok) return 'sent';
    log(`post failed: status=${res.status}`);
    return 'failed';
  } catch (err) {
    log(`post failed: ${err instanceof Error ? err.name : typeof err}`);
    return 'failed';
  }
}
