/**
 * 每日例行作業用：列出 DC 同步閒聊裡 bot 發的【百科回報…】／【ID認領】（services/communityReports.ts），附處理狀態。
 *
 *   - 【ID認領】approved：群組擁有者（GET /guilds/{id} 的 owner_id）或 ADMIN_DISCORD_IDS 裡的人在那則按了 ✅；
 *     merged：那則被改成帶「（已合併）」，或 bot 回覆那則、內容有「已合併」。
 *   - 【百科回報】processed：那則被改成帶「（已處理）」，或 bot 回覆那則、內容有「已處理」。
 * markCommunityItem 把 bot 自己那則改成結尾加「（已合併）」／「（已處理）」。
 *
 * 只在本機跑（scripts/listCommunityReports.ts），不在 GitHub Actions：輸出的 JSON 有暱稱，只寫到 stdout；
 * log 只寫數量與狀態碼。
 */

import {
  CLAIM_DONE_MARK,
  CLAIM_LINE_PREFIX,
  CLAIM_PREFIX,
  DISCORD_API,
  FEEDBACK_KIND_LABEL,
  hasDoneMark,
  REPORT_DONE_MARK,
  REPORT_PREFIX,
  REPORT_SOURCE_LABEL,
  resolveSyncDiscordChannelId,
  unescapeDiscordMarkdown,
  type FeedbackKind,
  type ReportSource,
} from './communityReports';
import { DEFAULT_AI_GAME_GUILD_ID, snowflakeTime } from './aiGameForum';

export const APPROVE_EMOJI = '✅';
const MESSAGES_PAGE = 100;
const DEFAULT_MAX_PAGES = 100;

type Fetch = typeof fetch;

interface DiscordMessage {
  id?: string;
  content?: string;
  author?: { id?: string; bot?: boolean };
  message_reference?: { message_id?: string };
  reactions?: { emoji?: { name?: string | null }; count?: number }[];
  edited_timestamp?: string | null;
}

export interface ListedClaim {
  id: string;
  messageId: string;
  url: string;
  createdAt: string;
  main: string;
  others: string[];
  source: ReportSource | null;
  approved: boolean;
  /** 誰按的 ✅（只有身分，不寫名字）。 */
  approvedBy: Array<'owner' | 'admin'>;
  merged: boolean;
}

export interface ListedReport {
  id: string;
  messageId: string;
  url: string;
  createdAt: string;
  kind: FeedbackKind | null;
  text: string;
  source: ReportSource | null;
  processed: boolean;
}

export interface CommunityListing {
  channelId: string;
  since: string;
  generatedAt: string;
  claims: ListedClaim[];
  reports: ListedReport[];
}

export interface ListOptions {
  token: string;
  channelId?: string;
  /** 往回看幾天（預設 7）。 */
  days?: number;
  /** ADMIN_DISCORD_IDS 拆好的 id（擁有者另外查）。 */
  adminIds?: readonly string[];
  maxPages?: number;
  fetchImpl?: Fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (m: string) => void;
}

/** "1,2 3" → ['1','2','3']（只留數字 id）。 */
export function parseAdminIds(raw: string | undefined): string[] {
  return (raw ?? '').split(/[\s,;]+/).map((x) => x.trim()).filter((x) => /^\d{5,22}$/.test(x));
}

const KIND_BY_LABEL = new Map<string, FeedbackKind>(
  (Object.entries(FEEDBACK_KIND_LABEL) as [FeedbackKind, string][]).map(([k, v]) => [v, k]),
);
const SOURCE_BY_LABEL = new Map<string, ReportSource>(
  (Object.entries(REPORT_SOURCE_LABEL) as [ReportSource, string][]).map(([k, v]) => [v, k]),
);

function sourceOf(content: string): ReportSource | null {
  const m = /（來自(網站|LINE|DC)[・）]/u.exec(content);
  return m ? SOURCE_BY_LABEL.get(m[1]) ?? null : null;
}

/** 【百科回報・錯誤】#R… 內容 → 各欄位；不是這種訊息 → null。 */
export function parseReportMessage(content: string): { id: string; kind: FeedbackKind | null; text: string; source: ReportSource | null } | null {
  const m = /^【百科回報・([^】]+)】#([0-9A-Z]{4,12}) ?([\s\S]*)$/u.exec(content ?? '');
  if (!m) return null;
  const lines = m[3].split('\n');
  const fromAt = lines.map((l) => l.trim()).findIndex((l) => l.startsWith('（來自'));
  const body = (fromAt >= 0 ? lines.slice(0, fromAt) : lines).join('\n').replace(new RegExp(`${REPORT_DONE_MARK}\\s*$`), '').trim();
  return { id: m[2], kind: KIND_BY_LABEL.get(m[1]) ?? null, text: unescapeDiscordMarkdown(body), source: sourceOf(content) };
}

/** 【ID認領】#C… → 編號、主 ID、其他 ID（從最後的 CLAIM:{…} 行讀）；不是這種訊息或讀不到 → null。 */
export function parseClaimMessage(content: string): { id: string; main: string; others: string[]; source: ReportSource | null } | null {
  const m = new RegExp(`^${CLAIM_PREFIX}#([0-9A-Z]{4,12})`, 'u').exec(content ?? '');
  if (!m) return null;
  const line = content.split('\n').map((l) => l.trim()).filter((l) => l.startsWith(CLAIM_LINE_PREFIX)).pop();
  if (!line) return null;
  try {
    const json = JSON.parse(line.slice(CLAIM_LINE_PREFIX.length).replace(new RegExp(`${CLAIM_DONE_MARK}$`), '')) as { main?: unknown; others?: unknown };
    if (typeof json.main !== 'string' || !Array.isArray(json.others) || !json.others.every((o) => typeof o === 'string')) return null;
    return { id: m[1], main: json.main, others: json.others as string[], source: sourceOf(content) };
  } catch {
    return null;
  }
}

/** 列出（見檔頭）。DC 讀不到頻道 → 丟錯（本機腳本，讓它失敗）；個別 ✅ 讀不到只當沒核准。 */
export async function listCommunityItems(opts: ListOptions): Promise<CommunityListing> {
  const f = opts.fetchImpl ?? fetch;
  const now = (opts.now ?? Date.now)();
  const sleep = opts.sleep ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)));
  const log = opts.log ?? ((m: string): void => console.error(m));
  const channelId = opts.channelId || resolveSyncDiscordChannelId();
  const cutoff = now - (opts.days ?? 7) * 86_400_000;
  const headers = { Authorization: `Bot ${opts.token}`, 'User-Agent': 'DiscordBot (avalonpediatw, 1.0)' };

  async function get(path: string): Promise<{ status: number; body: unknown }> {
    let res = await f(`${DISCORD_API}${path}`, { headers });
    if (res.status === 429) {
      const b = (await res.json().catch(() => ({}))) as { retry_after?: number };
      await sleep(Math.min(10, Math.max(0.5, Number(b.retry_after) || 1)) * 1000);
      res = await f(`${DISCORD_API}${path}`, { headers });
    }
    return { status: res.status, body: res.ok ? await res.json() : null };
  }

  const me = await get('/users/@me');
  if (me.status !== 200) throw new Error(`讀 bot 帳號失敗：HTTP ${me.status}`);
  const botId = String((me.body as { id?: string }).id ?? '');
  const ch = await get(`/channels/${channelId}`);
  if (ch.status !== 200) throw new Error(`讀頻道失敗：HTTP ${ch.status}`);
  const guildId = String((ch.body as { guild_id?: string }).guild_id ?? '') || DEFAULT_AI_GAME_GUILD_ID;
  const guild = await get(`/guilds/${guildId}`);
  if (guild.status !== 200) log(`讀群組擁有者失敗：HTTP ${guild.status}（只認 ADMIN_DISCORD_IDS）`);
  const ownerId = String((guild.body as { owner_id?: string } | null)?.owner_id ?? '');
  const approvers = new Map<string, 'owner' | 'admin'>();
  for (const id of opts.adminIds ?? []) approvers.set(id, 'admin');
  if (ownerId) approvers.set(ownerId, 'owner');

  // 往回翻訊息，直到比 cutoff 舊。
  const messages: DiscordMessage[] = [];
  let before = '';
  for (let page = 0; page < (opts.maxPages ?? DEFAULT_MAX_PAGES); page += 1) {
    const res = await get(`/channels/${channelId}/messages?limit=${MESSAGES_PAGE}${before ? `&before=${before}` : ''}`);
    if (res.status !== 200) throw new Error(`讀訊息失敗：HTTP ${res.status}`);
    const batch = Array.isArray(res.body) ? (res.body as DiscordMessage[]) : [];
    messages.push(...batch);
    const last = batch[batch.length - 1]?.id;
    if (batch.length < MESSAGES_PAGE || !last || Date.parse(snowflakeTime(last)) < cutoff) break;
    before = last;
  }

  const fromBot = messages.filter((m) => m.author?.id === botId && typeof m.id === 'string' && Date.parse(snowflakeTime(m.id)) >= cutoff);
  // bot 回覆某則、內容有 已合併／已處理 → 那則算處理完。
  const doneByReply = new Set<string>();
  for (const m of fromBot) {
    const ref = m.message_reference?.message_id;
    if (ref && /已合併|已處理/u.test(m.content ?? '')) doneByReply.add(ref);
  }

  const url = (id: string): string => `https://discord.com/channels/${guildId}/${channelId}/${id}`;
  const claims: ListedClaim[] = [];
  const reports: ListedReport[] = [];
  for (const m of fromBot) {
    const content = m.content ?? '';
    const id = m.id as string;
    if (content.startsWith(CLAIM_PREFIX)) {
      const c = parseClaimMessage(content);
      if (!c) continue;
      const approvedBy: Array<'owner' | 'admin'> = [];
      if ((m.reactions ?? []).some((r) => r.emoji?.name === APPROVE_EMOJI) && approvers.size > 0) {
        const users = await get(`/channels/${channelId}/messages/${id}/reactions/${encodeURIComponent(APPROVE_EMOJI)}?limit=100`);
        if (users.status === 200 && Array.isArray(users.body)) {
          for (const u of users.body as { id?: string }[]) {
            const role = u?.id ? approvers.get(u.id) : undefined;
            if (role && !approvedBy.includes(role)) approvedBy.push(role);
          }
        } else {
          log(`讀 ✅ 失敗：HTTP ${users.status}`);
        }
      }
      claims.push({
        id: c.id, messageId: id, url: url(id), createdAt: snowflakeTime(id), main: c.main, others: c.others, source: c.source,
        approved: approvedBy.length > 0, approvedBy, merged: hasDoneMark(content, CLAIM_DONE_MARK) || doneByReply.has(id),
      });
    } else if (content.startsWith(REPORT_PREFIX)) {
      const r = parseReportMessage(content);
      if (!r) continue;
      reports.push({
        id: r.id, messageId: id, url: url(id), createdAt: snowflakeTime(id), kind: r.kind, text: r.text, source: r.source,
        processed: hasDoneMark(content, REPORT_DONE_MARK) || doneByReply.has(id),
      });
    }
  }
  const oldestFirst = (a: { messageId: string }, b: { messageId: string }): number => (BigInt(a.messageId) < BigInt(b.messageId) ? -1 : 1);
  claims.sort(oldestFirst);
  reports.sort(oldestFirst);
  log(`讀了 ${messages.length} 則訊息：ID認領 ${claims.length}（已核准 ${claims.filter((c) => c.approved).length}、已合併 ${claims.filter((c) => c.merged).length}）、百科回報 ${reports.length}（已處理 ${reports.filter((r) => r.processed).length}）`);
  return { channelId, since: new Date(cutoff).toISOString(), generatedAt: new Date(now).toISOString(), claims, reports };
}

export interface MarkOptions {
  token: string;
  messageId: string;
  mark: 'merged' | 'processed';
  channelId?: string;
  fetchImpl?: Fetch;
}

/**
 * bot 自己那則改成結尾加「（已合併）」／「（已處理）」（已經有就不動）。CLAIM 行要留在最後一行，所以加在它前一行的結尾。
 * 回傳 'edited' | 'already' | 'not_found' | 'failed'。
 */
export async function markCommunityItem(opts: MarkOptions): Promise<'edited' | 'already' | 'not_found' | 'failed'> {
  const f = opts.fetchImpl ?? fetch;
  const channelId = opts.channelId || resolveSyncDiscordChannelId();
  const headers = { Authorization: `Bot ${opts.token}`, 'User-Agent': 'DiscordBot (avalonpediatw, 1.0)' };
  const res = await f(`${DISCORD_API}/channels/${channelId}/messages/${opts.messageId}`, { headers });
  if (res.status === 404) return 'not_found';
  if (!res.ok) return 'failed';
  const msg = (await res.json()) as DiscordMessage;
  const content = msg.content ?? '';
  const mark = opts.mark === 'merged' ? CLAIM_DONE_MARK : REPORT_DONE_MARK;
  const prefix = opts.mark === 'merged' ? CLAIM_PREFIX : REPORT_PREFIX;
  if (!content.startsWith(prefix)) return 'not_found';
  if (hasDoneMark(content, mark)) return 'already';
  const lines = content.split('\n');
  const at = lines.length > 1 && lines[lines.length - 1].startsWith(CLAIM_LINE_PREFIX) ? lines.length - 2 : lines.length - 1;
  lines[at] = `${lines[at]}${mark}`;
  const next = lines.join('\n');
  if (next.length > 2000) return 'failed';
  const patch = await f(`${DISCORD_API}/channels/${channelId}/messages/${opts.messageId}`, {
    method: 'PATCH',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: next, allowed_mentions: { parse: [] } }),
  });
  return patch.ok ? 'edited' : 'failed';
}
