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
import { resolveFeedbackChannelId } from '../feedback/config';

/**
 * The PRIVATE spreadsheet the AI manager reads (shared with the service
 * account as editor). Never the public 阿瓦隆百科 spreadsheet: that one is
 * "anyone with the link can view" and its id is in this public repo.
 */
export const DEFAULT_CHAT_EXPORT_SHEET_ID = '1k-ZNYqCnnS__Oc-NLX_ciVmaHOnBwilHbFjXeE5orx8';

/** Tab the rows go to (created with a header row when missing). */
export const CHAT_EXPORT_TAB = '聊天紀錄';

export const CHAT_EXPORT_HEADER = ['週次', '時間（+08）', '頻道', '來源', '發言者代號', '內容'] as const;

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

/** When some channels could not be read, read again once before exporting what was read. */
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
  /** '' when turned off (CHAT_EXPORT_SHEET_ID=off). */
  sheetId: string;
  /**
   * GOOGLE_SERVICE_ACCOUNT_JSON is set AND parses as a service-account key
   * (client_email + private_key). The value itself never leaves digest/sheets.ts.
   */
  sheetCredentialsUsable: boolean;
  /** CHAT_EXPORT_SOURCE_CHANNEL_IDS — when non-empty, replaces the default source list. */
  sourceChannelIds: string[];
  /** CHAT_EXPORT_EXCLUDE_CHANNEL_IDS plus the /意見 channel (always left out). */
  excludeChannelIds: string[];
  /** LOBBY_MIRROR_DISCORD_CHANNEL_ID — always read (LINE + lobby relays land there). */
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
  const sheetId = OFF.includes(sheetRaw.toLowerCase()) ? '' : sheetRaw || DEFAULT_CHAT_EXPORT_SHEET_ID;
  // The /意見 channel (the owner's admin channel) is private: never exported.
  const feedbackChannelId = /^\d{5,30}$/.test(resolveFeedbackChannelId(env)) ? [resolveFeedbackChannelId(env)] : [];
  return {
    enabled: !OFF.includes(flag),
    sheetId,
    sheetCredentialsUsable: parseServiceAccountJson(env.GOOGLE_SERVICE_ACCOUNT_JSON) !== null,
    sourceChannelIds: idList(envFirst(env, 'CHAT_EXPORT_SOURCE_CHANNEL_IDS', 'COMMUNITY_DIGEST_SOURCE_CHANNEL_IDS')),
    excludeChannelIds: [
      ...new Set([...idList(envFirst(env, 'CHAT_EXPORT_EXCLUDE_CHANNEL_IDS', 'COMMUNITY_DIGEST_EXCLUDE_CHANNEL_IDS')), ...feedbackChannelId]),
    ],
    mirrorChannelId: (env.LOBBY_MIRROR_DISCORD_CHANNEL_ID || '').trim(),
    guildId: (env.DISCORD_GUILD_ID || '').trim(),
  };
}
