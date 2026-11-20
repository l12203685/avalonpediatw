/**
 * 網站「回報與修正」頁的資料（站長 2026-11-19：「bug 修正可以直接呈現在百科網站上嗎? (留言功能)」）。
 *
 * 來源：DC #同步閒聊 裡 bot 自己發的【百科回報…】訊息（網站「問題回報」、LINE／DC 的 /回報、/更正 都貼在那裡，
 * services/communityReports.ts），加上每日例行作業寫在那則最後的狀態行（services/reportStatus.ts）。
 * 伺服器用 DISCORD_BOT_TOKEN 往回讀頻道（最多 REPORT_BOARD_MAX_PAGES 頁、REPORT_BOARD_DAYS 天），記憶體快取 5 分鐘（同 aiGameForum）；
 * 讀過的回報留在記憶體，掃描範圍外的舊回報照樣列（重啟歸零）。
 *
 * 網站上是公開的，所以：
 *   - 只給 編號、日期、類型、來源平台、頁面、內容、狀態、說明、連結；不給暱稱、帳號、DC 訊息連結。
 *   - 「（來自網站・暱稱・頁面 …）」那行整行不給（只從裡面拿頁面路徑）；內容裡的 @提及、「暱稱：…」之類的換成 ○○。
 *   - 牌譜更正（/更正）的內容可能是整份牌譜（有暱稱），只給第一行「[更正] 局號」。
 *   - 狀態「隱藏」的不列；REPORTS_BOARD=off 整個關掉。
 * log 只寫數量與狀態碼。
 */
import {
  DISCORD_API, FEEDBACK_KIND_LABEL, hasDoneMark, REPORT_DONE_MARK, REPORT_PREFIX, resolveSyncDiscordChannelId,
  type FeedbackKind, type ReportSource,
} from './communityReports';
import { parseReportMessage } from './communityReportsList';
import { snowflakeTime } from './aiGameForum';
import { findStatus, type PublicReportStatus } from './reportStatus';

export const REPORT_BOARD_TTL_MS = 5 * 60_000;
export const REPORT_BOARD_DAYS = 60;
export const REPORT_BOARD_MAX_PAGES = 20;
export const REPORT_BOARD_LIST_MAX = 150;
export const REPORTS_NOT_CONFIGURED = 'reports not configured';
export const REPORTS_UNAVAILABLE = 'reports unavailable';
/** 換掉名字用的字。 */
export const NAME_MASK = '○○';

type Fetch = typeof fetch;

export interface PublicReport {
  /** #R… 編號（訊息裡的）。 */
  id: string;
  /** 送出的時間（ISO）。 */
  createdAt: string;
  kind: FeedbackKind | null;
  kindLabel: string;
  source: ReportSource | null;
  /** 回報時的頁面（/…或 /#…；網站送的才有）。 */
  page: string | null;
  text: string;
  status: PublicReportStatus;
  note: string | null;
  link: string | null;
  /** 狀態最後一次更新（DC 那則被編輯的時間）；沒有狀態行 → null。 */
  updatedAt: string | null;
}

interface DiscordMessage {
  id?: string;
  content?: string;
  author?: { id?: string };
  message_reference?: { message_id?: string };
  edited_timestamp?: string | null;
}

// 控制字元、雙向文字控制、BOM。
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
const NAME_LABELS = '暱稱|名字|名稱|署名|回報者|回報人|聯絡方式|聯絡|帳號|玩家名稱|使用者|用戶|稱呼|ID|nickname|username|name|user|contact|from';
/** 「我的ID是…」「暱稱叫…」「我叫…」：這幾個標籤後面接 是／為／叫 也算名字（「名字是」太常是一般句子，不算）。 */
const NAME_IS_LABELS = '暱稱|帳號|ID|署名';
/**
 * 名字：到空白或標點為止；英數結尾、後面空白再接英數開頭的字，一起算（「Kip Lune」不會只遮掉 Kip；「測試甲 abc」只遮測試甲）。
 */
const nameToken = (stop: string): string => String.raw`[^\s${stop}]+(?:(?<=[A-Za-z0-9_])[ \t]+[A-Za-z0-9_][^\s${stop}]*)*`;
const NAME_TOKEN = nameToken(',，。、;；)）');
const MENTION_TOKEN = nameToken('@＠,，.。、!！?？:：;；()（）「」『』[\\]<>');

/**
 * 內容去名字：DC 提及（<@123>、<@&123>）、@everyone／@here、「@某人」、「暱稱：某人」「name: 某人」這種標籤、
 * 「我的ID是某人」「我叫某人」、最後一行「by 某人」「—某人」「~某人」「某人 敬上」。
 * 其他照回報者寫的原樣（電子郵件的 @ 不動）。
 */
export function anonymizeReportText(raw: string): string {
  let s = (raw ?? '').replace(/\r\n?/g, '\n').replace(UNSAFE, '');
  s = s.replace(/<@[!&]?\d+>/g, `@${NAME_MASK}`).replace(/<#\d+>/g, '#頻道');
  s = s.replace(new RegExp(`(^|[^\\w.])[@＠]${MENTION_TOKEN}`, 'gu'), `$1@${NAME_MASK}`);
  s = s.replace(new RegExp(`(^|[^\\w])(${NAME_LABELS})\\s*[:：]\\s*${NAME_TOKEN}`, 'giu'), `$1$2：${NAME_MASK}`);
  s = s.replace(new RegExp(`(^|[^\\w])(${NAME_IS_LABELS})\\s*(是|為|叫)\\s*${NAME_TOKEN}`, 'giu'), `$1$2$3${NAME_MASK}`);
  s = s.replace(new RegExp(`我叫\\s*${NAME_TOKEN}`, 'gu'), `我叫${NAME_MASK}`);
  const lines = s.split('\n');
  const last = lines[lines.length - 1] ?? '';
  const signature = /^\s*(?:(?:by|from)(?:\s+|\s*[:：]\s*)|(?:—{1,2}|–|－{2}|-{2}|─{2}|[~～]{1,2})\s*)\S{1,20}\s*$/iu;
  if (lines.length > 1 && (signature.test(last) || /^\s*\S{1,20}\s*敬上\s*$/u.test(last))) lines.pop();
  return lines.join('\n').trim();
}

/**
 * 「（來自網站・…・頁面 <https://avalonpediatw.com/#records=123>）」→ '/#records'；沒有 → null。
 * 只給 # 後面的頁面名稱：#player=名字、#stats?f=…（篩選裡有玩家名字）後面的部分常常就是回報者自己，不公開
 * （網站也只拿頁面名稱顯示「牌譜紀錄」這種字）。
 */
export function pageOfReport(content: string): string | null {
  const from = (content ?? '').split('\n').map((l) => l.trim()).find((l) => l.startsWith('（來自')) ?? '';
  const m = /頁面 <?https:\/\/avalonpediatw\.com(\/[^\s<>）)]*)>?/u.exec(from);
  if (!m) return null;
  const route = /#([A-Za-z][\w-]{0,40})/.exec(m[1]);
  return route ? `/#${route[1]}` : null;
}

/**
 * bot 的一則【百科回報…】→ 網站版；不是回報、或狀態是「隱藏」→ null。
 * `doneByReply`：bot 回覆過這則、內容有「已處理」（舊的標記法）。
 */
export function toPublicReport(m: DiscordMessage, doneByReply = false): PublicReport | null {
  const content = m.content ?? '';
  if (!content.startsWith(REPORT_PREFIX) || typeof m.id !== 'string') return null;
  const r = parseReportMessage(content);
  if (!r) return null;
  const st = findStatus(content);
  if (st?.status === '隱藏') return null;
  const status: PublicReportStatus = st
    ? (st.status as PublicReportStatus)
    : (hasDoneMark(content, REPORT_DONE_MARK) || doneByReply ? '已處理' : '收到');
  // 牌譜更正：只給第一行（[更正] 局號），後面可能是整份牌譜。
  const text = r.kind === 'correction' ? r.text.split('\n')[0].trim() : r.text;
  return {
    id: r.id,
    createdAt: snowflakeTime(m.id),
    kind: r.kind,
    kindLabel: r.kind ? FEEDBACK_KIND_LABEL[r.kind] : '回報',
    source: r.source,
    page: pageOfReport(content),
    text: anonymizeReportText(text),
    status,
    note: st?.note ? anonymizeReportText(st.note) : null,
    link: st?.link ?? null,
    updatedAt: st && m.edited_timestamp ? new Date(m.edited_timestamp).toISOString() : null,
  };
}

export type ReportBoardLoad =
  | { ok: true; reports: PublicReport[]; fetchedAt: number; stale: boolean }
  | { ok: false; status: number; error: string };

export interface ReportBoardOptions {
  token: string;
  channelId: string;
  fetchImpl?: Fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (m: string) => void;
  days?: number;
  maxPages?: number;
}

const byNewest = (a: { key: string }, b: { key: string }): number => (BigInt(b.key) > BigInt(a.key) ? 1 : BigInt(b.key) < BigInt(a.key) ? -1 : 0);

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- 回傳型別由實作推導（同 createAiGameService）
export function createReportBoardService(options: ReportBoardOptions) {
  const f = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)));
  const log = options.log ?? ((m: string): void => console.warn(`[reports] ${m}`));
  const headers = { Authorization: `Bot ${options.token}`, 'User-Agent': 'DiscordBot (avalonpediatw, 1.0)' };
  let botId = '';
  /** 讀過的回報（DC 訊息 id → 網站版）。 */
  const known = new Map<string, PublicReport>();
  let cache: { reports: PublicReport[]; fetchedAt: number } | null = null;
  let task: Promise<ReportBoardLoad> | null = null;
  let dirty = false;

  async function get(path: string): Promise<{ status: number; body: unknown }> {
    let res = await f(`${DISCORD_API}${path}`, { headers });
    if (res.status === 429) {
      const b = (await res.json().catch(() => ({}))) as { retry_after?: number };
      await sleep(Math.min(5, Math.max(0.5, Number(b.retry_after) || 1)) * 1000);
      res = await f(`${DISCORD_API}${path}`, { headers });
    }
    return { status: res.status, body: res.ok ? await res.json() : null };
  }

  async function scan(): Promise<PublicReport[]> {
    if (!botId) {
      const me = await get('/users/@me');
      if (me.status !== 200) throw new Error(`HTTP ${me.status}`);
      botId = String((me.body as { id?: string }).id ?? '');
      if (!botId) throw new Error('no bot id');
    }
    const cutoff = now() - (options.days ?? REPORT_BOARD_DAYS) * 86_400_000;
    const messages: DiscordMessage[] = [];
    let before = '';
    let reachedEnd = false;
    for (let page = 0; page < (options.maxPages ?? REPORT_BOARD_MAX_PAGES); page += 1) {
      const res = await get(`/channels/${options.channelId}/messages?limit=100${before ? `&before=${before}` : ''}`);
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      const batch = Array.isArray(res.body) ? (res.body as DiscordMessage[]) : [];
      messages.push(...batch);
      const last = batch[batch.length - 1]?.id;
      if (batch.length < 100 || !last) { reachedEnd = true; break; }
      if (Date.parse(snowflakeTime(last)) < cutoff) { reachedEnd = true; break; }
      before = last;
    }
    const fromBot = messages.filter((m) => m.author?.id === botId && typeof m.id === 'string' && /^\d+$/.test(m.id));
    const doneByReply = new Set<string>();
    for (const m of fromBot) {
      const ref = m.message_reference?.message_id;
      if (ref && /已處理/u.test(m.content ?? '')) doneByReply.add(ref);
    }
    // 這次掃到的範圍裡：重新算（刪掉的、改成隱藏的拿掉）；範圍外的舊回報留著。
    const ids = messages.map((m) => m.id).filter((x): x is string => typeof x === 'string' && /^\d+$/.test(x));
    const oldest = reachedEnd ? 0n : ids.reduce((min, x) => (BigInt(x) < min ? BigInt(x) : min), ids.length ? BigInt(ids[0]) : 0n);
    for (const key of [...known.keys()]) if (BigInt(key) >= oldest) known.delete(key);
    for (const m of fromBot) {
      const r = toPublicReport(m, doneByReply.has(m.id as string));
      if (r && Date.parse(r.createdAt) >= cutoff) known.set(m.id as string, r);
    }
    for (const [key, r] of known) if (Date.parse(r.createdAt) < cutoff) known.delete(key);
    const sorted = [...known.entries()].map(([key, r]) => ({ key, r })).sort(byNewest);
    for (const { key } of sorted.slice(REPORT_BOARD_LIST_MAX)) known.delete(key);
    log(`讀了 ${messages.length} 則訊息，回報 ${known.size} 則`);
    return sorted.slice(0, REPORT_BOARD_LIST_MAX).map((x) => x.r);
  }

  /** 最近的回報（快取 REPORT_BOARD_TTL_MS；讀不到時有舊的回舊的）。 */
  async function listReports(): Promise<ReportBoardLoad> {
    if (cache && !dirty && now() - cache.fetchedAt < REPORT_BOARD_TTL_MS) return { ok: true, ...cache, stale: false };
    if (task) return task;
    dirty = false;
    task = (async (): Promise<ReportBoardLoad> => {
      try {
        const reports = await scan();
        cache = { reports, fetchedAt: now() };
        return { ok: true, ...cache, stale: false };
      } catch (err) {
        log(`讀取失敗：${err instanceof Error ? err.message : 'error'}`);
        if (cache) return { ok: true, ...cache, stale: true };
        return { ok: false, status: 503, error: REPORTS_UNAVAILABLE };
      } finally {
        task = null;
      }
    })();
    return task;
  }

  /** 有人剛送出回報：下一次讀就重新掃（不用等 5 分鐘）。 */
  function invalidate(): void {
    dirty = true;
  }

  return { listReports, invalidate };
}

export type ReportBoardService = ReturnType<typeof createReportBoardService>;

let service: ReportBoardService | null = null;
let serviceKey = '';
let override: ReportBoardService | null | undefined;

/** 伺服器的回報看板（DISCORD_BOT_TOKEN 沒設、或 REPORTS_BOARD=off → null）。 */
export function reportBoardService(env: NodeJS.ProcessEnv = process.env): ReportBoardService | null {
  if (override !== undefined) return override;
  const token = (env.DISCORD_BOT_TOKEN ?? '').trim();
  if (!token || ['off', 'none', 'false', '0', 'no'].includes((env.REPORTS_BOARD ?? '').trim().toLowerCase())) return null;
  const channelId = resolveSyncDiscordChannelId(env);
  const key = `${token}:${channelId}`;
  if (!service || serviceKey !== key) {
    service = createReportBoardService({ token, channelId });
    serviceKey = key;
  }
  return service;
}

/** 網站剛送出一筆回報（routes/feedback.ts）：看板下一次讀就重新掃。 */
export function invalidateReportBoard(env: NodeJS.ProcessEnv = process.env): void {
  reportBoardService(env)?.invalidate();
}

/** 測試用：換掉伺服器的服務（null＝沒設定；undefined＝回到正常）。 */
export function setReportBoardServiceForTests(next: ReportBoardService | null | undefined): void {
  override = next;
}
