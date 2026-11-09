/**
 * 百科回報與 ID 認領 → DC #同步閒聊＋LINE 群組（Edward 2026-11-09：「回報跟ID認領都改用DC/LINE指令，然後整區刪掉
 * 網站上的回報跟ID認領都同步傳到 line群組/dc 同步閒聊頻道」）。
 *
 * 2026-11-02～11-09 這兩種東西是在 DC 論壇 #百科問題回報 開討論串；那個論壇要刪掉，這裡起完全不再用它。
 *
 * 來源：網站的「問題回報」（POST /api/feedback）、「ID 認領」頁（POST /api/feedback/claim），以及 bot 指令
 * （LINE 打 /回報、/認領；Discord 斜線指令 /回報、/認領，bots/reports/）。每一筆：
 *   - 給一個短編號（#R…＝回報、#C…＝認領；時間＋亂數，寫在訊息裡，之後就固定不變）；
 *   - 用伺服器的 DISCORD_BOT_TOKEN 直接貼到 DC 同步閒聊（LOBBY_MIRROR_DISCORD_CHANNEL_ID，預設 #同步閒聊）；
 *   - 同一段文字放進 LINE 群組（LOBBY_MIRROR_LINE_GROUP_ID）：有 reply_token 佇列就排進去（免費，下一個人說話時一起送出；
 *     LINE 群組裡打的指令當場就送出），沒有佇列才 push（每天有上限，省每月額度）。
 * 兩邊都由 bot 直接貼，不靠同步：同步本來就略過 bot 自己的訊息（Discord 的 bot／webhook 訊息不轉 LINE，
 * bot 送到 LINE 的訊息也不會變成 webhook 事件），所以不會出現重複的一則。
 *
 * 每日例行作業掃 DC 同步閒聊裡 bot 發的、開頭「【百科回報」或「【ID認領】」的訊息（services/communityReportsList.ts、
 * scripts/listCommunityReports.ts）：管理者（群組擁有者或 ADMIN_DISCORD_IDS）在【ID認領】按 ✅ = 核准；
 * 處理完把訊息改成結尾「（已合併）」／「（已處理）」。
 *
 * 公開的地方只貼回報者自己打的內容與自己填的暱稱（選填），不帶登入帳號名稱；不 @ 任何人。log 只寫狀態碼。
 */

import { getChatMirror } from '../bots/ChatMirror';

// ─── 回報的類型與欄位（原 feedbackForum.ts） ────────────────────────────────────────

export type FeedbackKind = 'bug' | 'suggestion' | 'content';

export const FEEDBACK_KINDS: readonly FeedbackKind[] = ['bug', 'suggestion', 'content'];

export const FEEDBACK_KIND_LABEL: Record<FeedbackKind, string> = {
  bug: '錯誤',
  suggestion: '建議',
  content: '文章內容',
};

export const FEEDBACK_MESSAGE_MAX = 1000;
export const FEEDBACK_NAME_MAX = 32;
export const FEEDBACK_PAGE_MAX = 200;

/** 從哪裡送來的。 */
export type ReportSource = 'web' | 'line' | 'discord';
export const REPORT_SOURCE_LABEL: Record<ReportSource, string> = { web: '網站', line: 'LINE', discord: 'DC' };

export interface FeedbackReport {
  kind: FeedbackKind;
  message: string;
  source: ReportSource;
  /** 回報者自己填的暱稱（選填）。 */
  name?: string;
  /** 回報時所在的頁面（網址路徑＋#，選填）。 */
  page?: string;
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

function pageUrl(page: string): string {
  return `https://avalonpediatw.com${page.startsWith('#') ? '/' : ''}${page}`;
}

// ─── ID 認領的驗證（原 feedbackForum.ts，規則不變） ─────────────────────────────────
// 玩家說「這幾個 ID 是我」（Edward 2026-11-03），不用登入；管理者逐筆核准後，每日例行作業把其他 ID 寫進
// player_aliases.json（{"其他ID": "主ID"}），下一次每日資料更新生效。場數是網站送出時算的，只供參考。

/** 一則認領最多幾個「其他 ID」。 */
export const CLAIM_MAX_OTHERS = 10;
export const CLAIM_NAME_MAX = 40;
export const CLAIM_CONTACT_MAX = 32;
export const CLAIM_NOTE_MAX = 500;
/** 機器可讀的最後一行的開頭；後面接單行 JSON {"main": "…", "others": ["…"]}（只在 DC 那則）。 */
export const CLAIM_LINE_PREFIX = 'CLAIM:';
export const CLAIM_APPROVAL_LINE = '核准：管理者在這則訊息按 ✅；合併好會在這則加註已合併。';

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

// 控制字元、雙向文字控制（可把顯示順序倒過來）、BOM。
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩﻿]/g;

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
 * POST /api/feedback/claim 的本體（或 /認領 指令拆出來的名字）→ IdClaim。main / others[] 可以是字串或 {name, games}。
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

/** 單行 JSON；反引號寫成 `（還是合法 JSON），不會被 DC 當成程式碼標記。 */
export function claimLine(claim: Pick<IdClaim, 'main' | 'others'>): string {
  const json = JSON.stringify({ main: claim.main.name, others: claim.others.map((o) => o.name) });
  return `${CLAIM_LINE_PREFIX}${json.replace(/`/g, '\\u0060')}`;
}

// ─── 編號與訊息格式 ────────────────────────────────────────────────────────────

/** 每日例行作業找訊息用的開頭。 */
export const REPORT_PREFIX = '【百科回報';
export const CLAIM_PREFIX = '【ID認領】';
/** 處理完的標記（例行作業把訊息的一行結尾加上這幾個字；hasDoneMark 只認行尾）。 */
export const REPORT_DONE_MARK = '（已處理）';
export const CLAIM_DONE_MARK = '（已合併）';

/** 訊息裡有沒有某一行以這個標記結尾。 */
export function hasDoneMark(content: string, mark: string): boolean {
  return content.split('\n').some((l) => l.trimEnd().endsWith(mark));
}

export type SyncPlatform = 'discord' | 'line';

/** Crockford base32：沒有 I L O U，口頭或手抄不會把 0／O、1／I 看錯。 */
const ID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ID_RE = /^[RC][0-9A-HJKMNP-TV-Z]{8}$/;

function base32(n: number, width: number): string {
  let out = '';
  let x = Math.max(0, Math.floor(n));
  for (let i = 0; i < width; i += 1) {
    out = ID_ALPHABET[x % 32] + out;
    x = Math.floor(x / 32);
  }
  return out;
}

/**
 * 短編號：R（回報）／C（認領）＋送出時間（秒，base32 6 碼）＋2 碼亂數，例如 R1KZ8Q4M7。寫在訊息裡，之後不變；
 * 同一秒兩筆撞號的機會 1/1024。
 */
export function makeItemId(prefix: 'R' | 'C', now: number = Date.now(), rand: () => number = Math.random): string {
  return `${prefix}${base32(now / 1000, 6)}${base32(Math.floor(rand() * 1024), 2)}`;
}

export function isItemId(id: string): boolean {
  return ID_RE.test(id);
}

/** DC 的 markdown 字元前面加反斜線，照原樣顯示（例如 __x__ 不會變底線）。 */
export function escapeDiscordMarkdown(s: string): string {
  return s.replace(/[\\`*_~|>#[\]()<:-]/g, (c) => `\\${c}`);
}

/** 反過來：把 escapeDiscordMarkdown 加的反斜線拿掉（例行作業讀回內容用）。 */
export function unescapeDiscordMarkdown(s: string): string {
  return s.replace(/\\([\\`*_~|>#[\]()<:-])/g, '$1');
}

const DISCORD_MAX = 2000;
const LINE_MAX = 5000;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * 回報的訊息：「【百科回報・錯誤】#R8X3KQ2A 內容…」＋「（來自網站・暱稱・頁面 …）」。
 * DC 版內容跳脫 markdown；兩邊都不超過一則的上限。
 */
export function formatReportMessage(id: string, r: FeedbackReport, platform: SyncPlatform): string {
  const label = FEEDBACK_KIND_LABEL[r.kind];
  const show = platform === 'discord' ? escapeDiscordMarkdown : (s: string): string => s;
  const message = r.message.replace(UNSAFE_CHARS, (c) => (c === '\n' ? c : ' ')).trim().slice(0, FEEDBACK_MESSAGE_MAX);
  const name = oneLine((r.name ?? '').replace(UNSAFE_CHARS, ' ')).slice(0, FEEDBACK_NAME_MAX);
  const page = cleanPage(r.page);
  const from = [`來自${REPORT_SOURCE_LABEL[r.source]}`];
  if (name) from.push(show(name));
  if (page) from.push(platform === 'discord' ? `頁面 <${pageUrl(page)}>` : `頁面 ${pageUrl(page)}`);
  const head = `${REPORT_PREFIX}・${label}】#${id} `;
  const tail = `\n（${from.join('・')}）`;
  const room = (platform === 'discord' ? DISCORD_MAX : LINE_MAX) - head.length - tail.length;
  return `${head}${clip(show(message), room)}${tail}`;
}

function gamesText(games: number | undefined): string {
  return games === undefined ? '場數未知' : `${games} 場`;
}

/**
 * 認領的訊息：「【ID認領】#C8X3KQ2B 主ID ← 其他ID、…」＋來源／聯絡、場數、備註；DC 版再加核准方式與最後一行
 * CLAIM:{…}（機器讀的，永遠在、不會被截掉）。
 */
export function formatClaimMessage(id: string, c: IdClaim, source: ReportSource, platform: SyncPlatform): string {
  const show = platform === 'discord' ? escapeDiscordMarkdown : (s: string): string => s;
  const lines = [`${CLAIM_PREFIX}#${id} ${show(c.main.name)} ← ${c.others.map((o) => show(o.name)).join('、')}`];
  lines.push(`（來自${REPORT_SOURCE_LABEL[source]}${c.contact ? `・聯絡：${show(c.contact)}` : ''}）`);
  const withGames = [c.main, ...c.others].some((x) => x.games !== undefined);
  if (withGames) {
    lines.push(`場數（送出時算的，僅供參考）：${[c.main, ...c.others].map((x) => `${show(x.name)} ${gamesText(x.games)}`).join('；')}`);
  }
  if (c.note) lines.push('備註：', ...c.note.split('\n').map((l) => (platform === 'discord' ? `> ${show(l)}` : `  ${l}`)));
  if (platform === 'line') return clip(lines.join('\n'), LINE_MAX);
  lines.push(CLAIM_APPROVAL_LINE);
  const tail = `\n${claimLine(c)}`;
  const head = lines.join('\n');
  return `${clip(head, DISCORD_MAX - tail.length)}${tail}`;
}

// ─── 貼到 DC 同步閒聊＋LINE 群組 ───────────────────────────────────────────────────

/** #同步閒聊（LINE↔DC 同步頻道，bots/discord/broadcaster.ts SYNC_CHANNEL_ID；公開值）。 */
export const DEFAULT_SYNC_DISCORD_CHANNEL_ID = '1132901301802504242';
export const DISCORD_API = 'https://discord.com/api/v10';
/** 沒有 reply_token 佇列時，每天（台北時間）最多 push 幾則到 LINE 群組（省每月額度）。 */
export const LINE_PUSH_DAILY_DEFAULT = 20;
const SUPPRESS_EMBEDS = 1 << 2;

/** 回報／認領貼到哪個 DC 頻道：COMMUNITY_REPORT_DISCORD_CHANNEL_ID ＞ LOBBY_MIRROR_DISCORD_CHANNEL_ID ＞ #同步閒聊。 */
export function resolveSyncDiscordChannelId(env: NodeJS.ProcessEnv = process.env): string {
  return (env.COMMUNITY_REPORT_DISCORD_CHANNEL_ID || '').trim()
    || (env.LOBBY_MIRROR_DISCORD_CHANNEL_ID || '').trim()
    || DEFAULT_SYNC_DISCORD_CHANNEL_ID;
}

export interface SyncLinePusher {
  pushMessage: (to: string, messages: unknown) => Promise<unknown>;
}

interface MirrorLike {
  enqueueLineReplyText: (text: string) => boolean;
  runOnDiscordSendChain: <T>(post: () => Promise<T>) => Promise<T>;
}

export interface SyncDeps {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  /** ChatMirror（LINE reply_token 佇列、DC 發文順序）；預設 getChatMirror()。 */
  mirror?: () => MirrorLike | null;
  /** 沒有佇列時直接 push 用的 LINE client；預設 registerSyncLinePusher 登記的那個。 */
  linePusher?: () => SyncLinePusher | null;
  now?: () => number;
  log?: (m: string) => void;
}

let registeredLinePusher: (() => SyncLinePusher | null) | null = null;

/** bots/index.ts 在 LINE bot 起來後登記（這裡不 import LINE client，免得循環相依）。 */
export function registerSyncLinePusher(get: (() => SyncLinePusher | null) | null): void {
  registeredLinePusher = get;
}

const linePushes = { day: '', count: 0 };

function taipeiDay(now: number): string {
  return new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
}

export interface DiscordPostResult {
  outcome: 'sent' | 'skipped' | 'failed';
  messageId?: string;
  status?: number;
}
export type LinePostOutcome = 'queued' | 'pushed' | 'skipped' | 'failed';
export interface SyncPostResult {
  discord: DiscordPostResult;
  line: LinePostOutcome;
}

async function postDiscord(text: string, deps: SyncDeps): Promise<DiscordPostResult> {
  const env = deps.env ?? process.env;
  const token = (env.DISCORD_BOT_TOKEN ?? '').trim();
  const channelId = resolveSyncDiscordChannelId(env);
  const log = deps.log ?? ((m: string): void => console.warn(`[community-reports] ${m}`));
  if (!token) return { outcome: 'skipped' };
  const f = deps.fetchImpl ?? fetch;
  const post = async (): Promise<DiscordPostResult> => {
    try {
      const res = await f(`${DISCORD_API}/channels/${channelId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'DiscordBot (avalonpediatw, 1.0)' },
        body: JSON.stringify({ content: text, allowed_mentions: { parse: [] }, flags: SUPPRESS_EMBEDS }),
      });
      if (!res.ok) {
        log(`DC 發文失敗：HTTP ${res.status}`);
        return { outcome: 'failed', status: res.status };
      }
      const body = (await res.json().catch(() => ({}))) as { id?: unknown };
      return { outcome: 'sent', status: res.status, messageId: typeof body.id === 'string' ? body.id : undefined };
    } catch (err) {
      log(`DC 發文失敗：${err instanceof Error ? err.name : 'error'}`);
      return { outcome: 'failed', status: 0 };
    }
  };
  const mirror = (deps.mirror ?? getChatMirror)();
  // 跟同步的其他發文排同一條隊，長訊息的幾段之間不會插進來。
  return mirror ? mirror.runOnDiscordSendChain(post) : post();
}

async function postLine(text: string, deps: SyncDeps): Promise<LinePostOutcome> {
  const env = deps.env ?? process.env;
  const groupId = (env.LOBBY_MIRROR_LINE_GROUP_ID ?? '').trim();
  const log = deps.log ?? ((m: string): void => console.warn(`[community-reports] ${m}`));
  if (!groupId) return 'skipped';
  const mirror = (deps.mirror ?? getChatMirror)();
  if (mirror && mirror.enqueueLineReplyText(text)) return 'queued';
  const pusher = (deps.linePusher ?? registeredLinePusher ?? ((): null => null))();
  if (!pusher) return 'skipped';
  const now = (deps.now ?? Date.now)();
  const day = taipeiDay(now);
  if (linePushes.day !== day) { linePushes.day = day; linePushes.count = 0; }
  const max = Number.parseInt(env.COMMUNITY_REPORT_LINE_PUSH_MAX_PER_DAY ?? '', 10);
  if (linePushes.count >= (Number.isFinite(max) && max >= 0 ? max : LINE_PUSH_DAILY_DEFAULT)) {
    log('LINE push 今天的上限到了，略過');
    return 'skipped';
  }
  try {
    await pusher.pushMessage(groupId, { type: 'text', text });
    linePushes.count += 1;
    return 'pushed';
  } catch (err) {
    log(`LINE push 失敗：${err instanceof Error ? err.name : 'error'}`);
    return 'failed';
  }
}

/**
 * 兩邊各貼一則：DC 先，貼成功才放 LINE（每日例行作業只掃 DC；DC 沒有的那筆不該只出現在 LINE）。
 * 不丟錯；log 只寫狀態碼。
 */
export async function postToSyncTargets(texts: { discord: string; line: string }, deps: SyncDeps = {}): Promise<SyncPostResult> {
  const discord = await postDiscord(texts.discord, deps);
  if (discord.outcome !== 'sent') return { discord, line: 'skipped' };
  const line = await postLine(texts.line, deps);
  return { discord, line };
}

/** 測試用：LINE push 的每日計數歸零。 */
export function __resetSyncLinePushesForTests(): void {
  linePushes.day = '';
  linePushes.count = 0;
}

// ─── 送出（網站與指令共用） ──────────────────────────────────────────────────────

/** bot 指令的頻率限制：每個人 10 分鐘 5 筆；全部來源加起來每小時 60 筆（網站另有每個 IP 的限制）。 */
export const SUBMIT_LIMITS = { perUser: 5, perUserWindowMs: 10 * 60_000, globalPerHour: 60 } as const;
const userStamps = new Map<string, number[]>();
let globalStamps: number[] = [];

function allow(userKey: string | undefined, now: number): boolean {
  globalStamps = globalStamps.filter((t) => now - t < 3600_000);
  if (globalStamps.length >= SUBMIT_LIMITS.globalPerHour) return false;
  if (userKey) {
    const mine = (userStamps.get(userKey) ?? []).filter((t) => now - t < SUBMIT_LIMITS.perUserWindowMs);
    if (mine.length >= SUBMIT_LIMITS.perUser) { userStamps.set(userKey, mine); return false; }
    mine.push(now);
    userStamps.set(userKey, mine);
    if (userStamps.size > 5000) userStamps.delete(userStamps.keys().next().value as string);
  }
  globalStamps.push(now);
  return true;
}

/** 測試用：頻率限制歸零。 */
export function __resetSubmitLimitsForTests(): void {
  userStamps.clear();
  globalStamps = [];
}

export type SubmitResult =
  | { ok: true; id: string; discord: DiscordPostResult; line: LinePostOutcome }
  | { ok: false; error: 'rate_limited' | 'unavailable' };

/**
 * 送出一筆回報：編號、DC＋LINE 各貼一則。DC 貼不出去 → unavailable（每日例行作業只掃 DC，沒進 DC 就等於沒收到）。
 * `userKey`：bot 指令的 平台:使用者（頻率限制用，不寫 log）。
 */
export async function submitReport(r: FeedbackReport, opts: SyncDeps & { userKey?: string; rand?: () => number } = {}): Promise<SubmitResult> {
  const now = (opts.now ?? Date.now)();
  if (!allow(opts.userKey, now)) return { ok: false, error: 'rate_limited' };
  const id = makeItemId('R', now, opts.rand);
  const res = await postToSyncTargets({ discord: formatReportMessage(id, r, 'discord'), line: formatReportMessage(id, r, 'line') }, opts);
  if (res.discord.outcome !== 'sent') return { ok: false, error: 'unavailable' };
  return { ok: true, id, ...res };
}

/** 送出一筆 ID 認領（同 submitReport；核准在 DC 那則按 ✅，所以 DC 一定要貼得出去）。 */
export async function submitClaim(c: IdClaim, source: ReportSource, opts: SyncDeps & { userKey?: string; rand?: () => number } = {}): Promise<SubmitResult> {
  const now = (opts.now ?? Date.now)();
  if (!allow(opts.userKey, now)) return { ok: false, error: 'rate_limited' };
  const id = makeItemId('C', now, opts.rand);
  const res = await postToSyncTargets({ discord: formatClaimMessage(id, c, source, 'discord'), line: formatClaimMessage(id, c, source, 'line') }, opts);
  if (res.discord.outcome !== 'sent') return { ok: false, error: 'unavailable' };
  return { ok: true, id, ...res };
}
