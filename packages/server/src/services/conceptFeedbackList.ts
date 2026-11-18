/**
 * 例行作業用：讀管理員頻道裡 bot 貼的【觀念卡回饋】（bots/conceptDaily/feedback.ts），附「已處理」旗標；
 * markConceptFeedback 把那一則的第一行結尾加「（已處理）」。
 *
 * 只在本機跑（scripts/conceptFeedback.ts）：輸出有群友打的原文，只寫到 stdout，不要放進 GitHub Actions、公開 log 或 repo。
 */

import { DISCORD_API, hasDoneMark, unescapeDiscordMarkdown } from './communityReports';
import { snowflakeTime } from './aiGameForum';
import { resolveFeedbackChannelId } from '../bots/feedback/config';
import { CONCEPT_FEEDBACK_DONE_MARK, CONCEPT_FEEDBACK_PREFIX } from '../bots/conceptDaily/feedback';

type Fetch = typeof fetch;

interface DiscordMessage {
  id?: string;
  content?: string;
  author?: { id?: string };
}

export interface ListedConceptFeedback {
  messageId: string;
  cardId: string;
  date: string;
  platform: 'line' | 'discord' | null;
  groupHash: string;
  userHash: string;
  createdAt: string;
  text: string;
  handled: boolean;
}

/** 【觀念卡回饋】<id>（可能帶「（已處理）」）＋欄位行＋內容 → 各欄位；不是這種訊息 → null。 */
export function parseConceptFeedbackMessage(content: string): Omit<ListedConceptFeedback, 'messageId'> | null {
  const lines = (content ?? '').split('\n');
  if (!lines[0]?.startsWith(CONCEPT_FEEDBACK_PREFIX)) return null;
  const head = lines[0].slice(CONCEPT_FEEDBACK_PREFIX.length);
  const handled = head.trimEnd().endsWith(CONCEPT_FEEDBACK_DONE_MARK) || hasDoneMark(lines[0], CONCEPT_FEEDBACK_DONE_MARK);
  const cardId = head.replace(CONCEPT_FEEDBACK_DONE_MARK, '').trim();
  const m = /^日期 (\S+)｜(LINE|DC)｜群 (\S+)｜人 (\S+)｜時間 (\S+)$/u.exec(lines[1] ?? '');
  if (!cardId || !m) return null;
  return {
    cardId,
    date: m[1],
    platform: m[2] === 'LINE' ? 'line' : 'discord',
    groupHash: m[3],
    userHash: m[4],
    createdAt: m[5],
    text: unescapeDiscordMarkdown(lines.slice(2).join('\n')),
    handled,
  };
}

export interface ListConceptFeedbackOptions {
  token: string;
  /** 預設 FEEDBACK_DISCORD_CHANNEL_ID（預設「大劍管理員」）。 */
  channelId?: string;
  /** 只列這個時間以後的（ISO 8601）。 */
  since: string;
  /** 也列已處理的（預設只列沒處理的）。 */
  includeHandled?: boolean;
  maxPages?: number;
  fetchImpl?: Fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface ConceptFeedbackListing {
  channelId: string;
  since: string;
  items: ListedConceptFeedback[];
}

function headersOf(token: string): Record<string, string> {
  return { Authorization: `Bot ${token}`, 'User-Agent': 'DiscordBot (avalonpediatw, 1.0)' };
}

export async function listConceptFeedback(opts: ListConceptFeedbackOptions): Promise<ConceptFeedbackListing> {
  const f = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)));
  const channelId = opts.channelId || resolveFeedbackChannelId();
  if (!channelId) throw new Error('沒有管理員頻道（FEEDBACK_DISCORD_CHANNEL_ID 是 off）');
  const cutoff = Date.parse(opts.since);
  if (!Number.isFinite(cutoff)) throw new Error('--since 要是 ISO 時間，例如 2026-11-18T00:00:00+08:00');
  const headers = headersOf(opts.token);
  const get = async (p: string): Promise<{ status: number; body: unknown }> => {
    let res = await f(`${DISCORD_API}${p}`, { headers });
    if (res.status === 429) {
      const b = (await res.json().catch(() => ({}))) as { retry_after?: number };
      await sleep(Math.min(10, Math.max(0.5, Number(b.retry_after) || 1)) * 1000);
      res = await f(`${DISCORD_API}${p}`, { headers });
    }
    return { status: res.status, body: res.ok ? await res.json() : null };
  };
  const me = await get('/users/@me');
  if (me.status !== 200) throw new Error(`讀 bot 帳號失敗：HTTP ${me.status}`);
  const botId = String((me.body as { id?: string }).id ?? '');
  const items: ListedConceptFeedback[] = [];
  let before = '';
  for (let page = 0; page < (opts.maxPages ?? 50); page++) {
    const res = await get(`/channels/${channelId}/messages?limit=100${before ? `&before=${before}` : ''}`);
    if (res.status !== 200) throw new Error(`讀訊息失敗：HTTP ${res.status}`);
    const batch = Array.isArray(res.body) ? (res.body as DiscordMessage[]) : [];
    for (const m of batch) {
      if (!m.id || m.author?.id !== botId || Date.parse(snowflakeTime(m.id)) < cutoff) continue;
      const parsed = parseConceptFeedbackMessage(m.content ?? '');
      if (parsed && (opts.includeHandled || !parsed.handled)) items.push({ messageId: m.id, ...parsed });
    }
    const last = batch[batch.length - 1]?.id;
    if (batch.length < 100 || !last || Date.parse(snowflakeTime(last)) < cutoff) break;
    before = last;
  }
  items.sort((a, b) => (BigInt(a.messageId) < BigInt(b.messageId) ? -1 : 1));
  return { channelId, since: new Date(cutoff).toISOString(), items };
}

export interface MarkConceptFeedbackOptions {
  token: string;
  messageId: string;
  channelId?: string;
  fetchImpl?: Fetch;
}

/** 把那一則第一行結尾加「（已處理）」（已經有就不動）。 */
export async function markConceptFeedback(opts: MarkConceptFeedbackOptions): Promise<'edited' | 'already' | 'not_found' | 'failed'> {
  const f = opts.fetchImpl ?? fetch;
  const channelId = opts.channelId || resolveFeedbackChannelId();
  if (!channelId) return 'failed';
  const headers = headersOf(opts.token);
  const url = `${DISCORD_API}/channels/${channelId}/messages/${opts.messageId}`;
  const res = await f(url, { headers });
  if (res.status === 404) return 'not_found';
  if (!res.ok) return 'failed';
  const content = ((await res.json()) as DiscordMessage).content ?? '';
  const parsed = parseConceptFeedbackMessage(content);
  if (!parsed) return 'not_found';
  if (parsed.handled) return 'already';
  const lines = content.split('\n');
  lines[0] = `${lines[0]}${CONCEPT_FEEDBACK_DONE_MARK}`;
  const next = lines.join('\n');
  if (next.length > 2000) return 'failed';
  const patch = await f(url, {
    method: 'PATCH',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: next, allowed_mentions: { parse: [] } }),
  });
  return patch.ok ? 'edited' : 'failed';
}
