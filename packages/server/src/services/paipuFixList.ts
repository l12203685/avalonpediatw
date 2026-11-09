/**
 * 待修正牌譜清單（Edward 2026-11-09：「你直接加入一個功能給line/dc bot 讓他們可以送出目前需要修正的牌譜跟原因」）。
 *
 * DC 論壇 #牌譜紀錄與覆盤 的貼文，每日匯入（packages/server/discord_records_import.py，GitHub Actions）讀不懂時會：
 *   - 掛上「待修正」標籤（PAIPU_FIX_TAG_ID；先照名字從論壇的 available_tags 找，找不到用這個 id）；
 *   - 在討論串回一則「🤖 牌譜格式檢查」，第三行是原因（「第 22 行「…」：…」或「原因：…」）。
 * 這裡列出論壇裡（進行中＋已封存的公開討論串）掛著「待修正」的貼文，排除記錄員／機器人的貼文（標題有「待檢視」、或掛「模擬」標籤），
 * 每篇取機器人最新一則「🤖 牌譜格式檢查」的原因行，新的在前。
 *
 * 用 DISCORD_BOT_TOKEN 走 REST（同 services/aiGameForum.ts），記憶體快取 5 分鐘；讀不到時有舊的回舊的。
 * 不丟錯；log 只寫狀態碼與數量，不寫標題、暱稱或內容。指令在 bots/paipuFix/（LINE /待修正、Discord /待修正）。
 */
import { DISCORD_API, PAIPU_FORUM_ID, discordThreadUrl, resolveAiGameGuildId, snowflakeTime } from './aiGameForum';

/** 論壇標籤「待修正」的 id（匯入程式掛的；論壇裡照名字找不到時用）。 */
export const PAIPU_FIX_TAG_ID = '1559708839283265641';
export const PAIPU_FIX_TAG_NAME = '待修正';
/** 記錄員／百科AI 的模擬局：不是真人牌譜，不列。 */
export const PAIPU_SIM_TAG_NAME = '模擬';
/** 記錄員還沒人工檢視的貼文（標題「【待檢視】…」）：不列。 */
export const PAIPU_UNVERIFIED_TITLE = '待檢視';
/** 匯入程式的原因回覆開頭（discord_records_import.py REPLY_MARKER）。 */
export const PAIPU_FIX_REPLY_MARKER = '🤖 牌譜格式檢查';

export const PAIPU_FIX_TTL_MS = 5 * 60 * 1000;
/** 最多讀幾篇的原因（新的在前；清單一次最多列 15 篇，再多只算篇數）。 */
export const PAIPU_FIX_REASON_MAX = 30;
/** 已封存討論串最多翻幾頁（每頁 100 篇）。 */
const ARCHIVED_PAGES_MAX = 30;
/** 每篇讀最近幾則訊息找原因回覆。 */
const MESSAGES_PER_THREAD = 50;
/** 同時讀幾篇的訊息。 */
const REASON_CONCURRENCY = 4;
/** 原因行最長幾個字（太長的截掉）。 */
const REASON_MAX_CHARS = 200;

type Fetch = typeof fetch;

export interface PaipuFixItem {
  /** 討論串 id（＝起始訊息 id）。 */
  id: string;
  title: string;
  /** 原因行；找不到機器人的回覆（或沒讀）時 ''。 */
  reason: string;
  /** https://discord.com/channels/<guild>/<thread> */
  url: string;
  /** 開串時間（ISO，從 id 算）。 */
  createdAt: string;
}

export type PaipuFixLoad =
  | { ok: true; items: PaipuFixItem[]; fetchedAt: number; stale: boolean }
  | { ok: false; error: 'not_configured' | 'unavailable' };

export interface DiscordForumThread {
  id?: string;
  name?: string;
  parent_id?: string;
  applied_tags?: string[];
  last_message_id?: string | null;
  thread_metadata?: { archived?: boolean; archive_timestamp?: string };
}

interface DiscordMessage {
  id?: string;
  content?: string;
  author?: { bot?: boolean };
}

const botHeaders = (token: string): Record<string, string> => ({
  Authorization: `Bot ${token}`,
  'User-Agent': 'DiscordBot (avalonpediatw, 1.0)',
});

/** 匯入程式引用牌譜時加的 markdown 跳脫（quote_line）拿掉，變回純文字。 */
export function unescapeMarkdown(text: string): string {
  return text.replace(/\\([\\`*_~|[\]<])/g, '$1');
}

/**
 * 「🤖 牌譜格式檢查」回覆 → 原因行（純文字），不是這種回覆時 null。
 * 回覆的格式（reply_text）：標記／說明／「第 N 行「…」：原因」或「原因：…」／格式提示…；
 * 「原因：」開頭的只留後面的字。舊格式找不到這兩種行時，取說明之後的第一行。
 */
export function extractFixReason(content: string | null | undefined): string | null {
  const text = (content ?? '').trim();
  if (!text.startsWith(PAIPU_FIX_REPLY_MARKER)) return null;
  const lines = text.split(/\r?\n/).slice(1).map((l) => l.trim()).filter(Boolean);
  let reason = lines.find((l) => /^第\s*\d+\s*行/u.test(l) || /^原因[:：]/u.test(l));
  if (reason === undefined) {
    const rest = lines.filter((l) => !/^格式提示/u.test(l) && !l.startsWith('・'));
    reason = rest.length > 1 ? rest[1] : rest[0];
  }
  if (reason === undefined) return null;
  let out = unescapeMarkdown(reason.replace(/^原因[:：]\s*/u, '').trim());
  if (out.length > REASON_MAX_CHARS) out = `${out.slice(0, REASON_MAX_CHARS - 1)}…`;
  return out || null;
}

/** 討論串的訊息（新的在前）→ 機器人最新一則原因回覆的原因行。 */
export function latestFixReason(messages: readonly DiscordMessage[]): string | null {
  for (const m of messages) {
    if (!m?.author?.bot) continue;
    const reason = extractFixReason(m.content);
    if (reason) return reason;
  }
  return null;
}

/** 要不要列：這個論壇裡、掛「待修正」、標題沒有「待檢視」、沒掛「模擬」。 */
export function isPaipuFixThread(
  t: DiscordForumThread,
  opts: { forumId: string; fixTagId: string; simTagId?: string | null },
): boolean {
  if (!t || t.parent_id !== opts.forumId || typeof t.id !== 'string' || !/^\d+$/.test(t.id)) return false;
  const tags = Array.isArray(t.applied_tags) ? t.applied_tags.map(String) : [];
  if (!tags.includes(opts.fixTagId)) return false;
  if ((t.name ?? '').includes(PAIPU_UNVERIFIED_TITLE)) return false;
  if (opts.simTagId && tags.includes(opts.simTagId)) return false;
  return true;
}

const byIdDesc = (a: { id: string }, b: { id: string }): number => {
  const x = BigInt(a.id);
  const y = BigInt(b.id);
  return x > y ? -1 : x < y ? 1 : 0;
};

export interface PaipuFixServiceOptions {
  token: string;
  forumId?: string;
  /** 網址用的群組 id；沒給就用論壇回傳的 guild_id，再沒有用 DISCORD_GUILD_ID／阿瓦隆百科。 */
  guildId?: string;
  fetchImpl?: Fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** 只寫狀態碼與數量。 */
  log?: (m: string) => void;
}

export function createPaipuFixService(options: PaipuFixServiceOptions) {
  const f = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)));
  const log = options.log ?? ((m: string): void => console.warn(`[paipu-fix] ${m}`));
  const forumId = options.forumId ?? PAIPU_FORUM_ID;
  const headers = botHeaders(options.token);
  let cache: { items: PaipuFixItem[]; fetchedAt: number } | null = null;
  let task: Promise<PaipuFixLoad> | null = null;
  /** 原因快取：討論串最後一則訊息沒變就不重讀。 */
  const reasons = new Map<string, { lastMessageId: string; reason: string }>();

  /** GET；429 照 retry_after（最多 5 秒）等一次再讀。網路錯誤 status 0。 */
  async function getJson(path: string): Promise<{ status: number; body: unknown }> {
    try {
      let res = await f(`${DISCORD_API}${path}`, { headers });
      if (res.status === 429) {
        const body = (await res.json().catch(() => ({}))) as { retry_after?: number };
        await sleep(Math.min(5, Math.max(0.5, Number(body.retry_after) || 1)) * 1000);
        res = await f(`${DISCORD_API}${path}`, { headers });
      }
      return { status: res.status, body: res.ok ? await res.json() : null };
    } catch {
      return { status: 0, body: null };
    }
  }

  async function listThreads(guildId: string): Promise<DiscordForumThread[]> {
    const active = await getJson(`/guilds/${guildId}/threads/active`);
    if (active.status !== 200) log(`進行中討論串讀取失敗：HTTP ${active.status}`);
    const threads: DiscordForumThread[] = [
      ...(((active.body as { threads?: DiscordForumThread[] } | null)?.threads) ?? []),
    ];
    let archivedOk = false;
    let before = '';
    for (let page = 0; page < ARCHIVED_PAGES_MAX; page += 1) {
      const q = `?limit=100${before ? `&before=${encodeURIComponent(before)}` : ''}`;
      const res = await getJson(`/channels/${forumId}/threads/archived/public${q}`);
      if (res.status !== 200) { log(`已封存討論串讀取失敗：HTTP ${res.status}`); break; }
      archivedOk = true;
      const body = res.body as { threads?: DiscordForumThread[]; has_more?: boolean } | null;
      const batch = body?.threads ?? [];
      threads.push(...batch);
      if (!body?.has_more || batch.length === 0) break;
      const next = batch[batch.length - 1]?.thread_metadata?.archive_timestamp ?? '';
      if (!next || next === before) break;
      before = next;
      if (page === ARCHIVED_PAGES_MAX - 1) log(`已封存討論串超過 ${ARCHIVED_PAGES_MAX} 頁，只讀前面的`);
    }
    if (active.status !== 200 && !archivedOk) throw new Error(`HTTP ${active.status}`);
    return threads;
  }

  async function reasonFor(t: DiscordForumThread): Promise<string> {
    const id = t.id as string;
    const last = String(t.last_message_id ?? '');
    const cached = reasons.get(id);
    if (cached && last && cached.lastMessageId === last) return cached.reason;
    const res = await getJson(`/channels/${id}/messages?limit=${MESSAGES_PER_THREAD}`);
    if (res.status !== 200) { log(`討論串訊息讀取失敗：HTTP ${res.status}`); return cached?.reason ?? ''; }
    const reason = latestFixReason(Array.isArray(res.body) ? (res.body as DiscordMessage[]) : []) ?? '';
    if (last) reasons.set(id, { lastMessageId: last, reason });
    return reason;
  }

  async function fetchItems(): Promise<PaipuFixItem[]> {
    const forum = await getJson(`/channels/${forumId}`);
    if (forum.status !== 200) throw new Error(`HTTP ${forum.status}`);
    const ch = forum.body as { guild_id?: string; available_tags?: { id?: string; name?: string }[] } | null;
    const tags = ch?.available_tags ?? [];
    const fixTagId = String(tags.find((x) => x?.name === PAIPU_FIX_TAG_NAME)?.id ?? PAIPU_FIX_TAG_ID);
    const simTagId = tags.find((x) => x?.name === PAIPU_SIM_TAG_NAME)?.id ?? null;
    const guildId = options.guildId || String(ch?.guild_id ?? '') || resolveAiGameGuildId();

    const seen = new Set<string>();
    const chosen: DiscordForumThread[] = [];
    for (const t of await listThreads(guildId)) {
      if (!isPaipuFixThread(t, { forumId, fixTagId, simTagId }) || seen.has(t.id as string)) continue;
      seen.add(t.id as string);
      chosen.push(t);
    }
    chosen.sort((a, b) => byIdDesc(a as { id: string }, b as { id: string }));

    const items: PaipuFixItem[] = chosen.map((t) => ({
      id: t.id as string,
      title: (t.name ?? '').trim(),
      reason: '',
      url: discordThreadUrl(guildId, t.id as string),
      createdAt: snowflakeTime(t.id as string),
    }));
    const toRead = chosen.slice(0, PAIPU_FIX_REASON_MAX);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < toRead.length) {
        const i = next++;
        items[i].reason = await reasonFor(toRead[i]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(REASON_CONCURRENCY, toRead.length) }, worker));
    for (const id of reasons.keys()) if (!seen.has(id)) reasons.delete(id);
    return items;
  }

  /** 目前待修正的牌譜（快取 PAIPU_FIX_TTL_MS；同時多個請求只讀一次；讀不到時有舊的回舊的）。不丟錯。 */
  async function list(): Promise<PaipuFixLoad> {
    if (cache && now() - cache.fetchedAt < PAIPU_FIX_TTL_MS) return { ok: true, ...cache, stale: false };
    if (task) return task;
    task = (async (): Promise<PaipuFixLoad> => {
      try {
        const items = await fetchItems();
        cache = { items, fetchedAt: now() };
        return { ok: true, ...cache, stale: false };
      } catch (err) {
        log(`清單讀取失敗：${err instanceof Error ? err.message : 'error'}`);
        if (cache) return { ok: true, ...cache, stale: true };
        return { ok: false, error: 'unavailable' };
      } finally {
        task = null;
      }
    })();
    return task;
  }

  return { list };
}

export type PaipuFixService = ReturnType<typeof createPaipuFixService>;

let service: PaipuFixService | null = null;
let serviceToken = '';
let override: PaipuFixService | null | undefined;

/** 伺服器的待修正清單服務（DISCORD_BOT_TOKEN 沒設時 null）。 */
export function paipuFixService(env: NodeJS.ProcessEnv = process.env): PaipuFixService | null {
  if (override !== undefined) return override;
  const token = (env.DISCORD_BOT_TOKEN ?? '').trim();
  if (!token) return null;
  if (!service || serviceToken !== token) {
    service = createPaipuFixService({ token });
    serviceToken = token;
  }
  return service;
}

/** 目前待修正的牌譜；沒設定 → { ok: false, error: 'not_configured' }。不丟錯。 */
export async function loadPaipuFixList(env: NodeJS.ProcessEnv = process.env): Promise<PaipuFixLoad> {
  const svc = paipuFixService(env);
  if (!svc) return { ok: false, error: 'not_configured' };
  try {
    return await svc.list();
  } catch {
    return { ok: false, error: 'unavailable' };
  }
}

/** 測試用：換掉伺服器的服務（null＝沒設定；undefined＝回到正常）。 */
export function setPaipuFixServiceForTests(next: PaipuFixService | null | undefined): void {
  override = next;
}
