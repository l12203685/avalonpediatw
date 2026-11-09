/**
 * 百科AI 對局 ⇄ DC 論壇 #百科問題回報（Edward 2026-11-05：「只要有百科AI參與的牌局就自動記錄在網站&DC上 我們可以直接針對AI的動作作反饋」）。
 *
 * 寫（scripts/signagePlayer.ts，GitHub Actions）：postAiGameTrace —— 一局開一篇討論串，標籤「百科AI對局」（論壇沒有這個標籤時用
 * API 加上去；加不了就不掛標籤照貼），起始訊息＝摘要＋回饋方式，附 trace.json＋trace.txt；後面幾則＝依局分組的決定
 * （每則 2000 字以內，貼太快被 429 時照 retry_after 等一下再送）。
 *
 * 讀（伺服器，routes/aiGames.ts）：createAiGameService —— 列出最近的百科AI對局討論串、讀某一篇起始訊息附的 trace.json、
 * 把網站的「這步怪怪的」貼成那篇的回覆。都用 DISCORD_BOT_TOKEN（Render 與 GitHub Actions 都已設定），記憶體快取 5 分鐘。
 * 只認這個論壇裡、標題以「百科AI對局」開頭、起始訊息是機器人發的討論串，附件只從 Discord 的 CDN 讀。
 *
 * 不丟錯：沒有 token／論壇關掉 → skipped；DC 失敗 → failed（只記狀態碼）。log 只寫狀態碼與數量，不寫標題、暱稱或內容。
 */
import {
  AI_GAME_TAG_NAME, formatFlagReply, paipuPostBody, paipuResultTag, paipuThreadNameOf, parseAiGameTrace,
  type AiGameTrace,
} from './aiGameTrace';

/**
 * 2026-11-09 起（Edward「我要的紀錄格式是跟阿瓦隆百科一樣的 你不要搞那麼複雜 百科AI參與的可以也一起放到牌譜紀錄區裡面」）：
 * 貼到 #牌譜紀錄與覆盤，格式同記錄員的待檢視貼文（標題「【待檢視】含百科機器人_…」、標籤 模擬＋線瓦＋結果），附 trace.json
 * （網站「百科AI 對局」頁讀它）；不再另貼依局的決定。每日匯入看到「待檢視」或「模擬」不收進真人戰績。
 */
export const PAIPU_FORUM_ID = '1132683080134578276';
const PAIPU_TAG_NAMES = ['模擬', '線瓦'] as const;

export const DISCORD_API = 'https://discord.com/api/v10';
/** 阿瓦隆百科 DC 群組（列出進行中的討論串要用）。 */
export const DEFAULT_AI_GAME_GUILD_ID = '1132682489840812113';
/** 網站上這一局的網址。 */
export const aiGameSiteUrl = (threadId: string): string => `https://avalonpediatw.com/#ai-games=${threadId}`;
export const discordThreadUrl = (guildId: string, threadId: string): string => `https://discord.com/channels/${guildId}/${threadId}`;
/** 討論串 7 天沒動才自動封存（封存的照樣列得出來，回覆時會自動解封）。 */
const AUTO_ARCHIVE_MINUTES = 10080;

/** AI_GAME_FORUM_CHANNEL_ID 可以換論壇（off＝不貼也不讀）；沒設＝#牌譜紀錄與覆盤。 */
export function resolveAiGameForumId(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.AI_GAME_FORUM_CHANNEL_ID || '').trim();
  if (['off', 'none', 'false', '0', 'no'].includes(raw.toLowerCase())) return '';
  return raw || PAIPU_FORUM_ID;
}

/** 論壇裡這些名字的標籤 id（找不到的略過）。 */
async function tagIdsByName(opts: { token: string; forumId: string; fetchImpl: Fetch }, names: readonly string[]): Promise<string[]> {
  try {
    const res = await opts.fetchImpl(`${DISCORD_API}/channels/${opts.forumId}`, { headers: botHeaders(opts.token) });
    if (!res.ok) return [];
    const tags = (((await res.json()) as { available_tags?: { id: string; name: string }[] }).available_tags ?? []);
    return names.map((n) => tags.find((t) => t.name === n)?.id).filter((x): x is string => Boolean(x));
  } catch {
    return [];
  }
}

export function resolveAiGameGuildId(env: NodeJS.ProcessEnv = process.env): string {
  return (env.DISCORD_GUILD_ID || '').trim() || DEFAULT_AI_GAME_GUILD_ID;
}

type Fetch = typeof fetch;

export interface AiGamePostOptions {
  token?: string;
  forumId?: string;
  fetchImpl?: Fetch;
  /** 後續訊息之間等多久（毫秒；測試用 0）。 */
  gapMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** 只寫狀態碼與數量。 */
  log?: (m: string) => void;
}

export interface AiGamePostResult {
  outcome: 'sent' | 'skipped' | 'failed';
  threadId?: string;
  /** 送出的後續訊息數。 */
  followups: number;
  /** 掛上標籤了沒有。 */
  tagged: boolean;
  /** 失敗時 DC 的狀態碼（網路錯誤 0）。 */
  status?: number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const botHeaders = (token: string): Record<string, string> => ({
  Authorization: `Bot ${token}`, 'User-Agent': 'DiscordBot (avalonpediatw, 1.0)',
});

interface ForumTag { id: string; name: string; moderated?: boolean; emoji_id?: string | null; emoji_name?: string | null }

/**
 * 論壇標籤「百科AI對局」的 id；沒有就加上去（PATCH available_tags，要「管理頻道」權限）。加不了回傳 null（照樣貼，只是不掛標籤）。
 */
export async function ensureAiGameTag(opts: { token: string; forumId: string; fetchImpl?: Fetch; log?: (m: string) => void }): Promise<string | null> {
  const f = opts.fetchImpl ?? fetch;
  const log = opts.log ?? ((): void => undefined);
  const headers = botHeaders(opts.token);
  try {
    const res = await f(`${DISCORD_API}/channels/${opts.forumId}`, { headers });
    if (!res.ok) { log(`讀論壇標籤失敗：HTTP ${res.status}`); return null; }
    const tags = ((await res.json()) as { available_tags?: ForumTag[] }).available_tags ?? [];
    const found = tags.find((t) => t.name === AI_GAME_TAG_NAME);
    if (found) return found.id;
    if (tags.length >= 20) { log('論壇標籤已滿 20 個，不掛標籤'); return null; }
    const next = [
      ...tags.map((t) => ({ id: t.id, name: t.name, moderated: t.moderated ?? false, emoji_id: t.emoji_id ?? null, emoji_name: t.emoji_name ?? null })),
      { name: AI_GAME_TAG_NAME, moderated: false },
    ];
    const patch = await f(`${DISCORD_API}/channels/${opts.forumId}`, {
      method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ available_tags: next }),
    });
    if (!patch.ok) { log(`新增論壇標籤失敗：HTTP ${patch.status}`); return null; }
    const after = ((await patch.json()) as { available_tags?: ForumTag[] }).available_tags ?? [];
    const id = after.find((t) => t.name === AI_GAME_TAG_NAME)?.id ?? null;
    if (id) log('已新增論壇標籤');
    return id;
  } catch (err) {
    log(`論壇標籤：${err instanceof Error ? err.name : 'error'}`);
    return null;
  }
}

/** 開討論串的 multipart 內容：payload_json＋files[0] trace.json（11/05 起不附 trace.txt：DC 只貼對局紀錄）。 */
/** 牌譜區的開串內容：標題、標籤、牌譜本文（同記錄員），附 trace.json。 */
export function paipuThreadBody(trace: AiGameTrace, tags: readonly string[]): FormData {
  const payload = {
    name: paipuThreadNameOf(trace),
    auto_archive_duration: AUTO_ARCHIVE_MINUTES,
    applied_tags: [...tags].slice(0, 5),
    message: {
      content: paipuPostBody(trace),
      allowed_mentions: { parse: [] },
      attachments: [{ id: 0, filename: 'trace.json' }],
    },
  };
  const form = new FormData();
  form.append('payload_json', JSON.stringify(payload));
  form.append('files[0]', new Blob([JSON.stringify(trace, null, 1)], { type: 'application/json' }), 'trace.json');
  return form;
}

/** 在討論串送一則文字；429 時照 retry_after（最多 10 秒）等一次再送。回傳狀態碼（網路錯誤 0）。 */
async function sendMessage(f: Fetch, token: string, threadId: string, content: string, sleep: (ms: number) => Promise<void>): Promise<number> {
  const send = (): Promise<Response> => f(`${DISCORD_API}/channels/${threadId}/messages`, {
    method: 'POST',
    headers: { ...botHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
  });
  try {
    let res = await send();
    if (res.status === 429) {
      const body = (await res.json().catch(() => ({}))) as { retry_after?: number };
      await sleep(Math.min(10, Math.max(0.5, Number(body.retry_after) || 2)) * 1000);
      res = await send();
    }
    return res.status;
  } catch {
    return 0;
  }
}

/**
 * 把一局貼到論壇（見檔頭）。不丟錯；起始訊息貼不出去 → failed；後續訊息有幾則失敗只少那幾則（outcome 仍是 sent）。
 */
export async function postAiGameTrace(trace: AiGameTrace, opts: AiGamePostOptions = {}): Promise<AiGamePostResult> {
  const token = (opts.token ?? process.env.DISCORD_BOT_TOKEN ?? '').trim();
  const forumId = opts.forumId ?? resolveAiGameForumId();
  const log = opts.log ?? ((): void => undefined);
  const f = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const gap = opts.gapMs ?? 1100;
  if (!token || !forumId) return { outcome: 'skipped', followups: 0, tagged: false };
  const tags = await tagIdsByName({ token, forumId, fetchImpl: f }, [...PAIPU_TAG_NAMES, paipuResultTag(trace)].filter(Boolean));
  let threadId = '';
  try {
    const res = await f(`${DISCORD_API}/channels/${forumId}/threads`, {
      method: 'POST', headers: botHeaders(token), body: paipuThreadBody(trace, tags),
    });
    if (!res.ok) { log(`開討論串失敗：HTTP ${res.status}`); return { outcome: 'failed', followups: 0, tagged: false, status: res.status }; }
    threadId = String(((await res.json()) as { id?: string }).id ?? '');
  } catch (err) {
    log(`開討論串失敗：${err instanceof Error ? err.name : 'error'}`);
    return { outcome: 'failed', followups: 0, tagged: false, status: 0 };
  }
  if (!/^\d+$/.test(threadId)) return { outcome: 'failed', followups: 0, tagged: false, status: 0 };
  void gap; void sleep;
  return { outcome: 'sent', threadId, followups: 0, tagged: tags.length > 0 };
}

// ── 伺服器端：讀論壇、讀 trace、貼回饋 ────────────────────────────────────────────────────

export const AI_GAMES_TTL_MS = 5 * 60 * 1000;
export const AI_GAMES_LIST_MAX = 50;
/** 全站每小時最多貼幾則網站回饋（每個 IP 另有每分鐘上限，見 routes/aiGames.ts）。 */
export const AI_GAME_FLAGS_PER_HOUR = 120;
const TRACE_CACHE_MAX = 100;
const TRACE_MAX_BYTES = 3 * 1024 * 1024;

export interface AiGameListItem {
  /** 討論串 id（＝起始訊息 id）。 */
  id: string;
  name: string;
  /** 開串時間（ISO，從 id 算）。 */
  createdAt: string;
  archived: boolean;
}

interface DiscordThread {
  id?: string; name?: string; parent_id?: string; applied_tags?: string[];
  thread_metadata?: { archived?: boolean; locked?: boolean };
}
interface DiscordMessage {
  id?: string; author?: { bot?: boolean };
  attachments?: { filename?: string; url?: string; size?: number }[];
}

export type ServiceError = { ok: false; status: number; error: string };
export type ListLoad = { ok: true; games: AiGameListItem[]; fetchedAt: number; stale: boolean } | ServiceError;
export type TraceLoad = { ok: true; trace: AiGameTrace; thread: { id: string; name: string; url: string } } | ServiceError;
export type FlagResult = { ok: true } | ServiceError;

export const AI_GAMES_UNAVAILABLE = 'AI games temporarily unavailable';
export const AI_GAMES_NOT_CONFIGURED = 'AI games not configured';

/** Discord id → 時間（ISO）。 */
export function snowflakeTime(id: string): string {
  try {
    return new Date(Number((BigInt(id) >> 22n) + 1420070400000n)).toISOString();
  } catch {
    return '';
  }
}

/** 是不是這個論壇裡的百科AI對局討論串（標題開頭「百科AI對局」）。 */
export function isAiGameThread(t: DiscordThread, forumId: string): boolean {
  return t.parent_id === forumId && typeof t.id === 'string' && /^\d+$/.test(t.id)
    && typeof t.name === 'string' && (t.name.startsWith(AI_GAME_TAG_NAME) || t.name.includes('含百科機器人'));
}

/** 只讀 Discord 自己 CDN 上的附件（不讓 trace 的網址指到別處）。 */
export function isDiscordCdnUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.hostname === 'cdn.discordapp.com' || u.hostname === 'media.discordapp.net');
  } catch {
    return false;
  }
}

export interface AiGameServiceOptions {
  token: string;
  forumId: string;
  guildId: string;
  fetchImpl?: Fetch;
  now?: () => number;
  log?: (m: string) => void;
}

export function createAiGameService(options: AiGameServiceOptions) {
  const f = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((m: string): void => console.warn(`[ai-games] ${m}`));
  const headers = botHeaders(options.token);
  let list: { games: AiGameListItem[]; fetchedAt: number } | null = null;
  let listTask: Promise<ListLoad> | null = null;
  const traces = new Map<string, { load: TraceLoad & { ok: true }; fetchedAt: number }>();
  const traceTasks = new Map<string, Promise<TraceLoad>>();
  let flagStamps: number[] = [];

  async function getJson(path: string): Promise<{ status: number; body: unknown }> {
    const res = await f(`${DISCORD_API}${path}`, { headers });
    return { status: res.status, body: res.ok ? await res.json() : null };
  }

  async function fetchList(): Promise<AiGameListItem[]> {
    const active = await getJson(`/guilds/${options.guildId}/threads/active`);
    const archived = await getJson(`/channels/${options.forumId}/threads/archived/public?limit=100`);
    if (active.status !== 200 && archived.status !== 200) throw new Error(`HTTP ${active.status}/${archived.status}`);
    const threads = [
      ...(((active.body as { threads?: DiscordThread[] } | null)?.threads) ?? []),
      ...(((archived.body as { threads?: DiscordThread[] } | null)?.threads) ?? []),
    ];
    const seen = new Set<string>();
    const out: AiGameListItem[] = [];
    for (const t of threads) {
      if (!t || !isAiGameThread(t, options.forumId) || seen.has(t.id as string)) continue;
      seen.add(t.id as string);
      out.push({ id: t.id as string, name: t.name as string, createdAt: snowflakeTime(t.id as string), archived: Boolean(t.thread_metadata?.archived) });
    }
    out.sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : BigInt(b.id) < BigInt(a.id) ? -1 : 0));
    return out.slice(0, AI_GAMES_LIST_MAX);
  }

  /** 最近的百科AI對局（快取 AI_GAMES_TTL_MS；讀不到時有舊的回舊的）。 */
  async function listGames(): Promise<ListLoad> {
    if (list && now() - list.fetchedAt < AI_GAMES_TTL_MS) return { ok: true, ...list, stale: false };
    if (listTask) return listTask;
    listTask = (async (): Promise<ListLoad> => {
      try {
        const games = await fetchList();
        list = { games, fetchedAt: now() };
        return { ok: true, ...list, stale: false };
      } catch (err) {
        log(`列表讀取失敗：${err instanceof Error ? err.message : 'error'}`);
        if (list) return { ok: true, ...list, stale: true };
        return { ok: false, status: 503, error: AI_GAMES_UNAVAILABLE };
      } finally {
        listTask = null;
      }
    })();
    return listTask;
  }

  async function fetchTrace(threadId: string): Promise<TraceLoad> {
    const ch = await getJson(`/channels/${threadId}`);
    if (ch.status === 404 || ch.status === 403) return { ok: false, status: 404, error: 'Game not found' };
    if (ch.status !== 200) throw new Error(`HTTP ${ch.status}`);
    const thread = ch.body as DiscordThread;
    if (!isAiGameThread(thread, options.forumId)) return { ok: false, status: 404, error: 'Game not found' };
    const msg = await getJson(`/channels/${threadId}/messages/${threadId}`);
    if (msg.status === 404) return { ok: false, status: 404, error: 'Game not found' };
    if (msg.status !== 200) throw new Error(`HTTP ${msg.status}`);
    const starter = msg.body as DiscordMessage;
    const file = (starter.attachments ?? []).find((a) => a.filename === 'trace.json');
    if (!starter.author?.bot || !file?.url || !isDiscordCdnUrl(file.url) || (file.size ?? 0) > TRACE_MAX_BYTES) {
      return { ok: false, status: 404, error: 'Trace not found' };
    }
    const res = await f(file.url, {});
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const trace = parseAiGameTrace(await res.json());
    if (!trace) return { ok: false, status: 404, error: 'Trace not found' };
    return { ok: true, trace, thread: { id: threadId, name: thread.name as string, url: discordThreadUrl(options.guildId, threadId) } };
  }

  /** 一局的 trace（快取 AI_GAMES_TTL_MS；同時多個請求只讀一次）。 */
  async function getTrace(threadId: string): Promise<TraceLoad> {
    if (!/^\d{15,22}$/.test(threadId)) return { ok: false, status: 404, error: 'Game not found' };
    const cached = traces.get(threadId);
    if (cached && now() - cached.fetchedAt < AI_GAMES_TTL_MS) return cached.load;
    const running = traceTasks.get(threadId);
    if (running) return running;
    const task = (async (): Promise<TraceLoad> => {
      try {
        const load = await fetchTrace(threadId);
        if (load.ok) {
          traces.set(threadId, { load, fetchedAt: now() });
          if (traces.size > TRACE_CACHE_MAX) traces.delete(traces.keys().next().value as string);
        }
        return load;
      } catch (err) {
        log(`trace 讀取失敗：${err instanceof Error ? err.message : 'error'}`);
        if (cached) return cached.load;
        return { ok: false, status: 503, error: AI_GAMES_UNAVAILABLE };
      } finally {
        traceTasks.delete(threadId);
      }
    })();
    traceTasks.set(threadId, task);
    return task;
  }

  /** 網站的「這步怪怪的」→ 那篇討論串的回覆（決定的內容從 trace 取）。 */
  async function flag(threadId: string, decisionId: number, note: string, name: string): Promise<FlagResult> {
    const load = await getTrace(threadId);
    if (!load.ok) return load;
    const d = load.trace.decisions.find((x) => x.id === decisionId);
    if (!d) return { ok: false, status: 400, error: 'Decision not found' };
    const t = now();
    flagStamps = flagStamps.filter((x) => t - x < 3600_000);
    if (flagStamps.length >= AI_GAME_FLAGS_PER_HOUR) return { ok: false, status: 429, error: 'Too many feedback posts this hour' };
    flagStamps.push(t);
    try {
      const res = await f(`${DISCORD_API}/channels/${threadId}/messages`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: formatFlagReply(d, note, name), allowed_mentions: { parse: [] } }),
      });
      if (res.ok) return { ok: true };
      log(`回饋貼文失敗：HTTP ${res.status}`);
    } catch (err) {
      log(`回饋貼文失敗：${err instanceof Error ? err.name : 'error'}`);
    }
    flagStamps = flagStamps.filter((x) => x !== t);
    return { ok: false, status: 503, error: AI_GAMES_UNAVAILABLE };
  }

  return { listGames, getTrace, flag };
}

export type AiGameService = ReturnType<typeof createAiGameService>;

let service: AiGameService | null = null;
let serviceKey = '';
let override: AiGameService | null | undefined;

/** 伺服器的百科AI對局服務（DISCORD_BOT_TOKEN 沒設、或論壇關掉時 null）。 */
export function aiGameService(env: NodeJS.ProcessEnv = process.env): AiGameService | null {
  if (override !== undefined) return override;
  const token = (env.DISCORD_BOT_TOKEN ?? '').trim();
  const forumId = resolveAiGameForumId(env);
  if (!token || !forumId) return null;
  const guildId = resolveAiGameGuildId(env);
  const key = `${token}:${forumId}:${guildId}`;
  if (!service || serviceKey !== key) {
    service = createAiGameService({ token, forumId, guildId });
    serviceKey = key;
  }
  return service;
}

/** 測試用：換掉伺服器的服務（null＝沒設定；undefined＝回到正常）。 */
export function setAiGameServiceForTests(next: AiGameService | null | undefined): void {
  override = next;
}
