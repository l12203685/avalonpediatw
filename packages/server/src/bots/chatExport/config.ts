/**
 * Weekly chat-log export (2026-10-13) — configuration and constants.
 *
 * Read on every call (not cached at module load) so tests can set env vars
 * and a Render env change takes effect after the redeploy without code.
 * docs/COMMUNITY_FEEDBACK.md explains the feature. The env vars of the
 * removed paid digest (COMMUNITY_DIGEST_SHEET_ID / _SOURCE_CHANNEL_IDS /
 * _EXCLUDE_CHANNEL_IDS) are still read when the new name is unset.
 */

import { parseServiceAccountJson } from '../digest/sheets';
import { DEFAULT_FEEDBACK_DISCORD_CHANNEL_ID, resolveFeedbackChannelId } from '../feedback/config';

/**
 * The PRIVATE spreadsheet the AI manager reads (shared with the service
 * account as editor). Never the public 阿瓦隆百科 spreadsheet: that one is
 * "anyone with the link can view" and its id is in this public repo.
 */
export const DEFAULT_CHAT_EXPORT_SHEET_ID = '1k-ZNYqCnnS__Oc-NLX_ciVmaHOnBwilHbFjXeE5orx8';

/**
 * The public 阿瓦隆百科 (stats) spreadsheet — "anyone with the link can
 * view", its id in this public repo (generate_cache.py SHEET_ID). Chat must
 * never be written there: CHAT_EXPORT_SHEET_ID set to this id (or to the
 * AVALON_STATS_SHEET_ID override) is refused and the export counts as not
 * configured.
 */
export const PUBLIC_STATS_SHEET_ID = '174L-by-dtP6IY1pRy8nMpG6_3RMBQXmAV4kTfIgmyIU';

/** Tab the rows go to (created with a header row when missing). */
export const CHAT_EXPORT_TAB = '聊天紀錄';

export const CHAT_EXPORT_HEADER = ['週次', '時間（+08）', '頻道', '來源', '發言者代號', '內容'] as const;

/**
 * Tab of the export log: one 「進行中」 row when an instance takes a week
 * (claim), one 「完成」 row when the week is fully written. A week counts as
 * exported only with a 完成 row — rows in 聊天紀錄 without one are a write
 * that was cut off and are deleted before the week is written again.
 */
export const CHAT_EXPORT_LOG_TAB = '匯出紀錄';

export const CHAT_EXPORT_LOG_HEADER = ['週次', '狀態', '列數', '頻道數', '時間（+08）', '執行代號'] as const;

export const CHAT_EXPORT_STATE_CLAIM = '進行中';
export const CHAT_EXPORT_STATE_DONE = '完成';

/**
 * A 進行中 row older than this no longer holds the week (its instance died
 * or gave up), so another instance may take it. An instance renews its own
 * claim when it is older than CHAT_EXPORT_CLAIM_RENEW_MS, so a live claim
 * never reaches the stale age between two attempts (10 minutes apart).
 */
export const CHAT_EXPORT_CLAIM_STALE_MS = 30 * 60_000;
export const CHAT_EXPORT_CLAIM_RENEW_MS = 15 * 60_000;

/** Weeks kept in the tab, the exported week included; older rows are deleted after each export. */
export const CHAT_EXPORT_RETAIN_WEEKS = 8;

/** Rows per values:append request. */
export const CHAT_EXPORT_APPEND_BATCH = 500;

/** One message is cut to this many characters (a Sheets cell holds 50,000; Discord allows 4,000). */
export const CHAT_EXPORT_MESSAGE_MAX_CHARS = 4000;

/**
 * Scheduled run: starts Monday 09:00 +08 (for the previous Monday 00:00 →
 * Sunday 24:00). Until 12:00 the scheduler keeps trying — Discord not
 * connected yet, a deploy/restart at 09:00, a Sheets error — so one bad
 * minute does not lose the week; the sheet check keeps it to one copy.
 */
export const CHAT_EXPORT_RUN_WEEKDAY = 1;
export const CHAT_EXPORT_RUN_HOUR = 9;
export const CHAT_EXPORT_RUN_WINDOW_MINUTES = 180;

/** Gap before the next attempt after a failure (Sheets error, unreadable channels). */
export const CHAT_EXPORT_RETRY_DELAY_MS = 10 * 60_000;

/**
 * When some channels could not be read, read again once before exporting
 * what was read. When no channel could be read at all, the week is never
 * exported as empty: it is read again every 10 minutes until 12:00.
 */
export const CHAT_EXPORT_READ_ATTEMPTS = 2;

/** Receives fixed strings with counts and codes only — never chat text, names or channel names. */
export interface ChatExportLogger {
  info(message: string): void;
  warn(message: string): void;
}

export const defaultChatExportLogger: ChatExportLogger = {
  // eslint-disable-next-line no-console
  info: (m) => console.log(`[chat-export] ${m}`),
  warn: (m) => console.warn(`[chat-export] ${m}`),
};

export interface ChatExportConfig {
  /** CHAT_EXPORT_ENABLED: default on; false / 0 / off / no turns it off. */
  enabled: boolean;
  /** '' when turned off (CHAT_EXPORT_SHEET_ID=off) or refused (sheetIdRefused). */
  sheetId: string;
  /** The configured id is the public stats spreadsheet: refused, sheetId ''. */
  sheetIdRefused: boolean;
  /**
   * GOOGLE_SERVICE_ACCOUNT_JSON is set AND parses as a service-account key
   * (client_email + private_key). The value itself never leaves digest/sheets.ts.
   */
  sheetCredentialsUsable: boolean;
  /** CHAT_EXPORT_SOURCE_CHANNEL_IDS — when non-empty, replaces the default source list. */
  sourceChannelIds: string[];
  /**
   * CHAT_EXPORT_EXCLUDE_CHANNEL_IDS plus the admin channel 「大劍管理員」 and
   * the /意見 channel when it is another one (always left out).
   */
  excludeChannelIds: string[];
  /** LOBBY_MIRROR_DISCORD_CHANNEL_ID — read even when not visible to @everyone (LINE + lobby relays land there), unless excluded. */
  mirrorChannelId: string;
  /** DISCORD_GUILD_ID — limits channel discovery to one server when set. */
  guildId: string;
}

const OFF = ['false', '0', 'off', 'no', 'none'];

/** First non-empty value among `names`. */
function envFirst(env: NodeJS.ProcessEnv, ...names: string[]): string {
  for (const name of names) {
    const v = (env[name] ?? '').trim();
    if (v) return v;
  }
  return '';
}

function idList(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => /^\d{5,30}$/.test(s));
}

export function readChatExportConfig(env: NodeJS.ProcessEnv = process.env): ChatExportConfig {
  const flag = (env.CHAT_EXPORT_ENABLED || '').trim().toLowerCase();
  const sheetRaw = envFirst(env, 'CHAT_EXPORT_SHEET_ID', 'COMMUNITY_DIGEST_SHEET_ID');
  const wanted = OFF.includes(sheetRaw.toLowerCase()) ? '' : sheetRaw || DEFAULT_CHAT_EXPORT_SHEET_ID;
  // Never the public stats spreadsheet (one wrong env value would publish a week of chat).
  const publicIds = [PUBLIC_STATS_SHEET_ID, (env.AVALON_STATS_SHEET_ID || '').trim()].filter(Boolean);
  // (also when pasted inside a URL)
  const sheetIdRefused = wanted !== '' && publicIds.some((id) => wanted === id || (id.length >= 20 && wanted.includes(id)));
  // The admin channel 「大劍管理員」 and the /意見 channel (if another one) are private: never exported.
  const feedbackChannelId = resolveFeedbackChannelId(env);
  const privateChannelIds = [DEFAULT_FEEDBACK_DISCORD_CHANNEL_ID, ...(/^\d{5,30}$/.test(feedbackChannelId) ? [feedbackChannelId] : [])];
  return {
    enabled: !OFF.includes(flag),
    sheetId: sheetIdRefused ? '' : wanted,
    sheetIdRefused,
    sheetCredentialsUsable: parseServiceAccountJson(env.GOOGLE_SERVICE_ACCOUNT_JSON) !== null,
    sourceChannelIds: idList(envFirst(env, 'CHAT_EXPORT_SOURCE_CHANNEL_IDS', 'COMMUNITY_DIGEST_SOURCE_CHANNEL_IDS')),
    excludeChannelIds: [
      ...new Set([...idList(envFirst(env, 'CHAT_EXPORT_EXCLUDE_CHANNEL_IDS', 'COMMUNITY_DIGEST_EXCLUDE_CHANNEL_IDS')), ...privateChannelIds]),
    ],
    mirrorChannelId: (env.LOBBY_MIRROR_DISCORD_CHANNEL_ID || '').trim(),
    guildId: (env.DISCORD_GUILD_ID || '').trim(),
  };
}
