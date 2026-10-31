/**
 * GET /api/analysis/records/:id/replies 的資料：Discord 論壇 #牌譜紀錄與覆盤 某篇貼文討論串裡的回覆
 * （Edward 2026-10-30：「DC 討論串的回覆可以顯示，下面有些是補述或是針對牌譜的覆盤」）。
 *
 * 為什麼是執行期讀、不放進每日快取：回覆是聊天內容，寫進公開 repo 的 records_cache.json 就會永久留在 git 歷史裡，
 * 在 DC 刪掉或改掉的回覆也還在。這裡在有人打開那一局時才用伺服器既有的 DISCORD_BOT_TOKEN 讀，只放在記憶體
 * （每篇 REPLIES_TTL_MS），刪除與修改幾分鐘內就跟著 DC；伺服器 log 只印數量。
 *
 * - 只讀 records_cache.json 清單裡的貼文（路由先查）：不能拿來讀機器人看得到的其他頻道，模擬貼文也不在清單裡。
 * - 只留一般訊息與回覆（type 0 / 19），去掉起始訊息本身（牌譜）、機器人與 webhook 發的訊息（例如每日匯入的
 *   「🤖 牌譜格式檢查」）、系統訊息（改標題、釘選…）。
 * - 作者顯示伺服器暱稱（沒有就顯示 Discord 顯示名稱）；<@id> 提及換成 @暱稱，頻道／身分組／自訂表情換成文字。
 * - 讀取失敗：有舊的就回舊的（stale），沒有就 503（網站顯示「請到 DC 查看」）。
 */

export const DISCORD_API = 'https://discord.com/api/v10';
export const REPLIES_TTL_MS = 5 * 60 * 1000;
export const MEMBER_TTL_MS = 6 * 60 * 60 * 1000;
export const MAX_REPLY_PAGES = 5;
export const REPLIES_UNAVAILABLE = 'Thread replies temporarily unavailable';
export const REPLIES_NOT_CONFIGURED = 'Thread replies not configured';
const PAGE_SIZE = 100;
const MESSAGE_TYPES = new Set([0, 19]); // DEFAULT, REPLY
const TEXT_MAX = 4000;

export interface RecordReplyAttachment {
  name: string;
  url: string;
  image: boolean;
}

export interface RecordReply {
  id: string;
  author: string;
  /** ISO 8601（Discord 的 timestamp）。 */
  time: string;
  edited: boolean;
  text: string;
  attachments: RecordReplyAttachment[];
  /** 回覆的是哪一則（討論串裡的另一則回覆）。 */
  replyTo?: string;
}

export type RepliesLoad =
  | { ok: true; replies: RecordReply[]; fetchedAt: number; stale: boolean }
  | { ok: false; status: number; error: string };

interface DiscordUser { id?: string; username?: string; global_name?: string | null; bot?: boolean }
interface DiscordMessage {
  id: string;
  type?: number;
  content?: string;
  timestamp?: string;
  edited_timestamp?: string | null;
  author?: DiscordUser;
  webhook_id?: string;
  mentions?: DiscordUser[];
  attachments?: Array<{ filename?: string; url?: string; content_type?: string }>;
  message_reference?: { message_id?: string; channel_id?: string };
}

type Fetcher = (url: string, init: { headers: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface RepliesServiceOptions {
  token: string;
  guildId: string;
  fetcher?: Fetcher;
  now?: () => number;
}

function byId(a: { id: string }, b: { id: string }): number {
  const x = BigInt(a.id);
  const y = BigInt(b.id);
  return x < y ? -1 : x > y ? 1 : 0;
}

function displayName(user: DiscordUser | undefined): string {
  return (user?.global_name || user?.username || '').trim() || '（未知）';
}

/** 一則訊息的文字：提及、頻道、身分組、自訂表情、時間戳換成可讀文字。 */
export function readableContent(content: string, names: ReadonlyMap<string, string>): string {
  const text = content
    .replace(/<@!?(\d+)>/g, (_m, id: string) => `@${names.get(id) ?? '某人'}`)
    .replace(/<@&\d+>/g, '@身分組')
    .replace(/<#\d+>/g, '#頻道')
    .replace(/<a?:([A-Za-z0-9_~]+):\d+>/g, ':$1:')
    .replace(/<t:(\d+)(?::[tTdDfFR])?>/g, (_m, s: string) => {
      const d = new Date(Number(s) * 1000);
      return Number.isNaN(d.getTime())
        ? ''
        : d.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
    });
  return text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX - 1)}…` : text;
}

/** 本站機器人在討論串貼的戰報（Edward 10/31：戰報寫在討論串回覆）：機器人訊息裡唯一要顯示的。 */
export const BATTLE_REPORT_PREFIX = '**【戰報】**';
export function isBattleReport(message: DiscordMessage): boolean {
  return Boolean(message.author?.bot) && (message.content ?? '').startsWith(BATTLE_REPORT_PREFIX);
}

/** 會顯示的回覆：一般訊息／回覆，不是起始訊息、機器人或 webhook（戰報例外），且有文字或附件。 */
export function isShownReply(message: DiscordMessage, threadId: string): boolean {
  if (message.id === threadId) return false;
  if (!MESSAGE_TYPES.has(message.type ?? 0)) return false;
  if ((message.author?.bot || message.webhook_id) && !isBattleReport(message)) return false;
  return Boolean((message.content ?? '').trim() || (message.attachments ?? []).length);
}

export function createRepliesService(options: RepliesServiceOptions) {
  const fetcher: Fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
  const now = options.now ?? Date.now;
  const threads = new Map<string, { replies: RecordReply[]; fetchedAt: number }>();
  const members = new Map<string, { name: string | null; fetchedAt: number }>();
  const inflight = new Map<string, Promise<RepliesLoad>>();
  const headers = { Authorization: `Bot ${options.token}`, 'User-Agent': 'DiscordBot (avalonpediatw, 1.0)' };

  async function get(path: string): Promise<{ status: number; body: unknown }> {
    const res = await fetcher(`${DISCORD_API}${path}`, { headers });
    return { status: res.status, body: res.ok ? await res.json() : null };
  }

  /** 伺服器暱稱（每人快取 MEMBER_TTL_MS）；讀不到時 null（改用 Discord 顯示名稱）。 */
  async function nickname(userId: string): Promise<string | null> {
    const cached = members.get(userId);
    if (cached && now() - cached.fetchedAt < MEMBER_TTL_MS) return cached.name;
    let name: string | null = null;
    try {
      const { status, body } = await get(`/guilds/${options.guildId}/members/${userId}`);
      if (status === 200 && body && typeof body === 'object') {
        const nick = (body as { nick?: string | null }).nick;
        name = typeof nick === 'string' && nick.trim() ? nick.trim() : null;
      }
    } catch {
      name = cached?.name ?? null;
    }
    members.set(userId, { name, fetchedAt: now() });
    return name;
  }

  async function fetchReplies(threadId: string): Promise<RecordReply[]> {
    const messages: DiscordMessage[] = [];
    let after = threadId;
    for (let page = 0; page < MAX_REPLY_PAGES; page += 1) {
      const { status, body } = await get(`/channels/${threadId}/messages?limit=${PAGE_SIZE}&after=${after}`);
      if (status !== 200 || !Array.isArray(body)) throw new Error(`HTTP ${status}`);
      const batch = (body as DiscordMessage[]).filter((m) => m && typeof m.id === 'string' && /^\d+$/.test(m.id));
      messages.push(...batch);
      if (batch.length < PAGE_SIZE) break;
      after = batch.reduce((max, m) => (byId(m, { id: max }) > 0 ? m.id : max), after);
    }
    const shown = messages.filter((m) => isShownReply(m, threadId)).sort(byId);
    const users = new Map<string, DiscordUser>();
    for (const m of shown) {
      if (m.author?.id) users.set(m.author.id, m.author);
      for (const u of m.mentions ?? []) if (u.id) users.set(u.id, u);
    }
    const names = new Map<string, string>();
    await Promise.all([...users.entries()].slice(0, 30).map(async ([id, user]) => {
      names.set(id, (await nickname(id)) ?? displayName(user));
    }));
    for (const [id, user] of users) if (!names.has(id)) names.set(id, displayName(user));
    const shownIds = new Set(shown.map((m) => m.id));
    return shown.map((m) => {
      const reply: RecordReply = {
        id: m.id,
        author: isBattleReport(m) ? '阿瓦隆百科・戰報' : names.get(m.author?.id ?? '') ?? displayName(m.author),
        time: m.timestamp ?? '',
        edited: Boolean(m.edited_timestamp),
        text: readableContent(m.content ?? '', names),
        attachments: (m.attachments ?? [])
          .filter((a) => typeof a.url === 'string' && a.url.startsWith('https://'))
          .map((a) => ({
            name: a.filename ?? '附件',
            url: a.url as string,
            image: (a.content_type ?? '').startsWith('image/'),
          })),
      };
      const ref = m.message_reference?.message_id;
      if (ref && shownIds.has(ref)) reply.replyTo = ref;
      return reply;
    });
  }

  /** 一篇貼文的回覆（快取 REPLIES_TTL_MS；同時多個請求只讀一次）。 */
  async function load(threadId: string): Promise<RepliesLoad> {
    const cached = threads.get(threadId);
    if (cached && now() - cached.fetchedAt < REPLIES_TTL_MS) {
      return { ok: true, replies: cached.replies, fetchedAt: cached.fetchedAt, stale: false };
    }
    const running = inflight.get(threadId);
    if (running) return running;
    const task = (async (): Promise<RepliesLoad> => {
      try {
        const replies = await fetchReplies(threadId);
        const fetchedAt = now();
        threads.set(threadId, { replies, fetchedAt });
        return { ok: true, replies, fetchedAt, stale: false };
      } catch {
        console.warn('[analysis/records replies] 讀取失敗：1');
        if (cached) return { ok: true, replies: cached.replies, fetchedAt: cached.fetchedAt, stale: true };
        return { ok: false, status: 503, error: REPLIES_UNAVAILABLE };
      } finally {
        inflight.delete(threadId);
      }
    })();
    inflight.set(threadId, task);
    return task;
  }

  return { load };
}

export type RepliesService = ReturnType<typeof createRepliesService>;

let service: RepliesService | null = null;
let serviceKey = '';
let override: RepliesService | null | undefined;

/** 伺服器的回覆服務（DISCORD_BOT_TOKEN 沒設時 null）。 */
export function repliesService(guildId: string): RepliesService | null {
  if (override !== undefined) return override;
  const token = process.env.DISCORD_BOT_TOKEN?.trim() ?? '';
  if (!token) return null;
  const key = `${token}:${guildId}`;
  if (!service || serviceKey !== key) {
    service = createRepliesService({ token, guildId });
    serviceKey = key;
  }
  return service;
}

/** 測試用：換掉伺服器的回覆服務（null = 沒設定；undefined = 回到正常）。 */
export function setRepliesServiceForTests(next: RepliesService | null | undefined): void {
  override = next;
}
