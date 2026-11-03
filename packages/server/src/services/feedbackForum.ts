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

export interface ForumPostOptions {
  token?: string;
  forumId?: string;
  fetchImpl?: typeof fetch;
  log?: (m: string) => void;
}

/** 在論壇開一篇討論串。沒有 token／論壇關掉 → skipped；失敗只記狀態碼（不記標題或內容）。 */
export async function postForumThread(payload: ForumThreadPayload, opts: ForumPostOptions = {}): Promise<FeedbackForumOutcome> {
  const token = (opts.token ?? process.env.DISCORD_BOT_TOKEN ?? '').trim();
  const forumId = opts.forumId ?? resolveFeedbackForumId();
  const log = opts.log ?? ((m: string): void => console.warn(`[feedback-forum] ${m}`));
  if (!token || !forumId) return 'skipped';
  try {
    const res = await (opts.fetchImpl ?? fetch)(`https://discord.com/api/v10/channels/${forumId}/threads`, {
      method: 'POST',
      headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.ok) return 'sent';
    log(`post failed: status=${res.status}`);
    return 'failed';
  } catch (err) {
    log(`post failed: ${err instanceof Error ? err.name : typeof err}`);
    return 'failed';
  }
}

/** 開問題回報的討論串。 */
export async function postFeedbackThread(r: FeedbackReport, opts: ForumPostOptions = {}): Promise<FeedbackForumOutcome> {
  return postForumThread(buildFeedbackThread(r), opts);
}

// ---------------------------------------------------------------------------
// ID 認領（Edward 2026-11-03：玩家在網站上說「這幾個 ID 是我」，不用登入；管理者逐筆核准）。
//
// 網站「ID 認領」頁送 POST /api/feedback/claim → 在同一個論壇開一篇，標籤「ID認領」。管理者核准 = 把標籤改成
// 「已處理」；每天的例行作業讀「ID認領＋已處理」的貼文最後一行 CLAIM:{…}，把其他 ID 寫進 player_aliases.json
// （{"其他ID": "主ID"}），下一次每日資料更新生效。場數是網站送出時算的，只供參考，不當依據。
// ---------------------------------------------------------------------------

/** 論壇標籤「ID認領」（2026-11-03 建立）。 */
export const CLAIM_FORUM_TAG = '1567091556085796878';
/** 一則認領最多幾個「其他 ID」。 */
export const CLAIM_MAX_OTHERS = 10;
export const CLAIM_NAME_MAX = 40;
export const CLAIM_CONTACT_MAX = 32;
export const CLAIM_NOTE_MAX = 500;
/** 機器可讀的最後一行的開頭；後面接單行 JSON {"main": "…", "others": ["…"]}。 */
export const CLAIM_LINE_PREFIX = 'CLAIM:';
export const CLAIM_APPROVAL_LINE = '核准：把這篇標籤改成「已處理」；不核准：改成「不處理」並回覆原因。';

export interface ClaimedId {
  name: string;
  /** 網站送出時顯示的場數（資訊用；沒給或不合理 = undefined）。 */
  games?: number;
}

export interface IdClaim {
  main: ClaimedId;
  others: ClaimedId[];
  /** 暱稱／DC 名稱（選填，方便聯絡）。 */
  contact?: string;
  note?: string;
  page?: string;
}

export type IdClaimParse = { ok: true; claim: IdClaim } | { ok: false; error: string };

// 控制字元、雙向文字控制（可把標題顯示順序倒過來）、BOM。
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

/** 名字：去掉控制字元、空白縮成一個、頭尾去空白；空的或太長 → ''（不截斷，截斷會變成另一個名字）。 */
export function cleanClaimName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const name = raw.replace(UNSAFE_CHARS, ' ').replace(/\s+/g, ' ').trim();
  return name.length > 0 && [...name].length <= CLAIM_NAME_MAX ? name : '';
}

/** 同一個人的判斷鍵（比照 generate_cache 的 player_name_key：只差大小寫／全半形算同一個）。 */
export function claimNameKey(name: string): string {
  return name.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function cleanGames(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= 100_000 ? raw : undefined;
}

/** 選填的單行文字：去控制字元、縮空白、截到 max。 */
function cleanLine(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return '';
  return [...raw.replace(UNSAFE_CHARS, ' ').replace(/\s+/g, ' ').trim()].slice(0, max).join('');
}

/** 備註：可多行；去控制字元（換行留著）、最多 CLAIM_NOTE_MAX 字。 */
function cleanNote(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const text = raw.replace(/\r\n?/g, '\n').replace(/[^\S\n]+/g, ' ').replace(UNSAFE_CHARS, (c) => (c === '\n' ? c : ' '));
  return [...text.replace(/\n{3,}/g, '\n\n').trim()].slice(0, CLAIM_NOTE_MAX).join('');
}

function parseId(raw: unknown): ClaimedId | null {
  const item = typeof raw === 'string' ? { name: raw } : raw;
  if (!item || typeof item !== 'object') return null;
  const name = cleanClaimName((item as { name?: unknown }).name);
  if (!name) return null;
  const games = cleanGames((item as { games?: unknown }).games);
  return games === undefined ? { name } : { name, games };
}

/**
 * POST /api/feedback/claim 的本體 → IdClaim。main / others[] 可以是字串或 {name, games}。
 * 錯誤：沒有主 ID、沒有其他 ID、超過 CLAIM_MAX_OTHERS、名字不合格、其他 ID 跟主 ID 相同。重複的其他 ID 只留一個。
 */
export function parseIdClaim(body: unknown): IdClaimParse {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body required' };
  const b = body as Record<string, unknown>;
  const main = parseId(b.main);
  if (!main) return { ok: false, error: 'main id required' };
  if (!Array.isArray(b.others) || b.others.length === 0) return { ok: false, error: 'at least one other id required' };
  if (b.others.length > CLAIM_MAX_OTHERS) return { ok: false, error: `at most ${CLAIM_MAX_OTHERS} other ids` };
  const mainKey = claimNameKey(main.name);
  const seen = new Set<string>();
  const others: ClaimedId[] = [];
  for (const raw of b.others) {
    const id = parseId(raw);
    if (!id) return { ok: false, error: 'invalid id' };
    const key = claimNameKey(id.name);
    if (key === mainKey) return { ok: false, error: 'other id same as main id' };
    if (seen.has(key)) continue;
    seen.add(key);
    others.push(id);
  }
  const claim: IdClaim = { main, others };
  const contact = cleanLine(b.contact, CLAIM_CONTACT_MAX);
  const note = cleanNote(b.note);
  const page = cleanPage(b.page);
  if (contact) claim.contact = contact;
  if (note) claim.note = note;
  if (page) claim.page = page;
  return { ok: true, claim };
}

/** DC 的 markdown 字元前面加反斜線，名字照原樣顯示（例如 __x__ 不會變底線）。 */
function escapeMarkdown(s: string): string {
  return s.replace(/[\\`*_~|>#[\]()<:-]/g, (c) => `\\${c}`);
}

function gamesText(games: number | undefined): string {
  return games === undefined ? '場數未知' : `${games} 場`;
}

/** 單行 JSON；反引號寫成 \u0060（還是合法 JSON），不會被 DC 當成程式碼標記。 */
export function claimLine(claim: Pick<IdClaim, 'main' | 'others'>): string {
  const json = JSON.stringify({ main: claim.main.name, others: claim.others.map((o) => o.name) });
  return `${CLAIM_LINE_PREFIX}${json.replace(/`/g, '\\u0060')}`;
}

/**
 * 組討論串：標題「[ID認領] 主ID ← 其他ID、…」（≤100 字），標籤 ID認領，內文＝主 ID、其他 ID（含網站算的場數）、
 * 聯絡、備註（引用格式，避免有一行假冒 CLAIM:）、頁面、核准方式，最後一行 CLAIM:{…}（永遠在、不會被截掉）。
 */
export function buildClaimThread(c: IdClaim): ForumThreadPayload {
  const othersTitle = c.others.map((o) => o.name).join('、');
  let title = `[ID認領] ${c.main.name} ← ${othersTitle}`;
  if ([...title].length > 100) title = `${[...title].slice(0, 99).join('')}…`;

  const lines = [
    '**ID 認領**（網站送出，未登入；管理者核准前不會改任何資料）',
    `主 ID：**${escapeMarkdown(c.main.name)}**（${gamesText(c.main.games)}）`,
    '其他 ID（同一個人）：',
    ...c.others.map((o) => `• ${escapeMarkdown(o.name)}（${gamesText(o.games)}）`),
    `聯絡：${c.contact ? escapeMarkdown(c.contact) : '未填'}`,
  ];
  if (c.note) lines.push('備註：', ...c.note.split('\n').map((l) => `> ${l}`));
  if (c.page) lines.push(`頁面：\`https://avalonpediatw.com${c.page.startsWith('#') ? '/' : ''}${c.page}\``);
  lines.push('（場數是網站送出時算的，僅供參考。）', CLAIM_APPROVAL_LINE);

  const tail = `\n${claimLine(c)}`;
  const head = lines.join('\n');
  const room = 2000 - tail.length;
  const body = head.length > room ? `${head.slice(0, room - 1)}…` : head;
  return {
    name: title,
    applied_tags: [CLAIM_FORUM_TAG],
    message: { content: `${body}${tail}`, allowed_mentions: { parse: [] } },
  };
}

/** 開 ID 認領的討論串。 */
export async function postClaimThread(c: IdClaim, opts: ForumPostOptions = {}): Promise<FeedbackForumOutcome> {
  return postForumThread(buildClaimThread(c), opts);
}
