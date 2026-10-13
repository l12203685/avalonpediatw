/**
 * Daily chat-log export (2026-10-13, daily since round 3) — configuration and constants.
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
 * The 阿瓦隆百科 (stats) spreadsheet — "anyone with the link can view", its
 * id in this public repo (generate_cache.py SHEET_ID). The export's default
 * target since 2026-10-13 (DEFAULT_CHAT_EXPORT_SHEET_ID). Only the two chat
 * tabs below are ever touched there (the daily records importer and the
 * cache refresh read 牌譜 / Discord匯入 / Discord回覆 / 同贏… in the same
 * workbook).
 */
export const PUBLIC_STATS_SHEET_ID = '174L-by-dtP6IY1pRy8nMpG6_3RMBQXmAV4kTfIgmyIU';

/**
 * The private spreadsheet the export wrote to until 2026-10-13 (still the
 * practice-mode report sheet, src/practice/PracticeReportWriter.ts — its tab
 * 「練習回報」 is never touched here). Chosen again with CHAT_EXPORT_SHEET_ID
 * set to this id; the reading copy's default target (below).
 */
export const PRIVATE_CHAT_EXPORT_SHEET_ID = '1k-ZNYqCnnS__Oc-NLX_ciVmaHOnBwilHbFjXeE5orx8';

/**
 * The reading copy (2026-10-13): the same rows, days, 7-day window and export
 * log as the main target, in the two chat tabs of a SMALL spreadsheet, with
 * 「聊天紀錄」 kept as its FIRST tab. It exists only so the AI manager can
 * read the chat: its Google Drive connector reads the 阿瓦隆百科 workbook
 * only as a sample of its huge first tab 牌譜 (never reaching 聊天紀錄),
 * cannot download the whole workbook, but can download a spreadsheet's first
 * tab as CSV. Default: the private sheet above (owned by the owner, shared
 * with the service account as editor). CHAT_EXPORT_READING_COPY_SHEET_ID
 * picks another one (id or URL); off disables it. Never the main target's
 * sheet (a pointless duplicate) nor a public stats workbook (its first tab
 * must stay 牌譜): both leave the copy disabled; so does
 * CHAT_EXPORT_SHEET_ID=off (no sheet at all — review fix 2026-10-13).
 */
export const DEFAULT_CHAT_EXPORT_READING_COPY_SHEET_ID = PRIVATE_CHAT_EXPORT_SHEET_ID;

/**
 * The reading copy's run ids (執行代號) start with this, and in its sheet a
 * day counts as exported only with a 完成 row whose 執行代號 starts with it.
 * Earlier versions wrote the main export to the private sheet (until
 * 2026-10-13, without the later fixes: other servers, `/ 意見`, a day
 * written while the server was still loading); their 完成 rows do not count
 * there, so those days are deleted (cleanup lock) and written again with the
 * main target's rows — the copy never keeps an older version's day (review
 * fix 2026-10-13). Not hex, so never the start of an 8-hex run id.
 */
export const CHAT_EXPORT_READING_COPY_RUN_PREFIX = 'copy-';

/**
 * Where the export writes by default: the 阿瓦隆百科 workbook, the last 7
 * days, speakers as 成員N renumbered every day. Owner (Edward) 2026-10-13:
 * 「聊天紀錄可以一天同步一次嗎 不用搬到私人試算表 搬到 阿瓦隆百科 googlesheet
 * 就好 然後最多保留近一週的即可」 and, after being told the link is
 * effectively public, 「照搬 百科群組本身也是公開的 所以不影響」.
 * CHAT_EXPORT_ALLOW_PUBLIC_SHEET=0 refuses a public sheet (the export then
 * counts as not configured and writes no chat; days older than 7 already in
 * its two chat tabs are still deleted — 「最多保留近一週」); CHAT_EXPORT_SHEET_ID
 * picks another sheet.
 */
export const DEFAULT_CHAT_EXPORT_SHEET_ID = PUBLIC_STATS_SHEET_ID;

/**
 * The 阿瓦隆百科 Discord server (discord_records_import.py GUILD_ID). The
 * export only discovers channels in this one server, also when
 * DISCORD_GUILD_ID is unset: the bot's invite is public, and a server that
 * added it must never land in the link-public sheet (review fix 2026-10-13).
 * DISCORD_GUILD_ID names another server (a test server).
 */
export const AVALONPEDIA_DISCORD_GUILD_ID = '1132682489840812113';

/** Tab the rows go to (created with a header row when missing). */
export const CHAT_EXPORT_TAB = '聊天紀錄';

export const CHAT_EXPORT_HEADER = ['日期', '時間（+08）', '頻道', '來源', '發言者代號', '內容'] as const;

/**
 * Tab of the export log: one 「進行中」 row when an instance takes a day
 * (claim), one 「完成」 row when the day is fully written. A day counts as
 * exported only with a 完成 row — rows in 聊天紀錄 without one are a write
 * that was cut off and are deleted before the day is written again.
 */
export const CHAT_EXPORT_LOG_TAB = '匯出紀錄';

export const CHAT_EXPORT_LOG_HEADER = ['日期', '狀態', '列數', '頻道數', '時間（+08）', '執行代號'] as const;

/**
 * Tabs of the public 阿瓦隆百科 workbook other code reads or writes
 * (generate_cache.py, discord_records_import.py). The chat tabs must never
 * be one of these (checked by a test).
 */
export const STATS_WORKBOOK_TABS = ['牌譜', 'Discord匯入', 'Discord回覆', '同贏', '同輸', '贏相關', '同贏-同輸'] as const;

export const CHAT_EXPORT_STATE_CLAIM = '進行中';
export const CHAT_EXPORT_STATE_DONE = '完成';

/**
 * A 進行中 row older than this no longer holds the day (its instance died
 * or gave up), so another instance may take it. An instance renews its own
 * claim when it is older than CHAT_EXPORT_CLAIM_RENEW_MS, so a live claim
 * never reaches the stale age between two attempts (10 minutes apart).
 */
export const CHAT_EXPORT_CLAIM_STALE_MS = 30 * 60_000;
export const CHAT_EXPORT_CLAIM_RENEW_MS = 15 * 60_000;

/**
 * The sheet-wide cleanup lock, for every row deletion (retention, rows of an
 * interrupted write). Google deletes rows by INDEX, read just before: two
 * instances deleting at the same time (deploy overlap) would each remove
 * rows that the other's delete had just moved up — rows of a kept, complete
 * day, silently. So an instance deletes only while its 「清理中」 row is the
 * first live one in 「匯出紀錄」 (same rule as the day claims) and ends with
 * a 「清理結束」 row, also when it did not get the lock. Lock rows carry the
 * date (+08) they were written and are pruned with the days.
 */
export const CHAT_EXPORT_STATE_CLEANUP = '清理中';
export const CHAT_EXPORT_STATE_CLEANUP_END = '清理結束';
/** A 清理中 row older than this no longer holds the lock (its instance died mid-cleanup). */
export const CHAT_EXPORT_CLEANUP_STALE_MS = 10 * 60_000;
/**
 * The holder sends no delete request once it has held the lock this long
 * (a cleanup takes seconds); far enough inside the stale age that clocks a
 * few minutes apart never let two instances delete at once.
 */
export const CHAT_EXPORT_CLEANUP_MAX_MS = 3 * 60_000;

/**
 * Days kept in both tabs: the last 7 complete days (+08), i.e. yesterday and
 * the 6 days before it. Older rows are deleted after each export pass. The
 * catch-up looks at the same 7 days.
 */
export const CHAT_EXPORT_RETAIN_DAYS = 7;

/** Rows per values:append request. */
export const CHAT_EXPORT_APPEND_BATCH = 500;

/** One message is cut to this many characters (a Sheets cell holds 50,000; Discord allows 4,000). */
export const CHAT_EXPORT_MESSAGE_MAX_CHARS = 4000;

/**
 * Daily run: from 04:30 +08 (until 23:59 the same day) for the previous
 * calendar day 00:00 → 24:00. Right after a (re)start, as soon as Discord is
 * ready, every one of the last CHAT_EXPORT_RETAIN_DAYS complete days without
 * a 完成 row is exported, oldest first, whatever the time of day (catch-up).
 */
export const CHAT_EXPORT_RUN_HOUR = 4;
export const CHAT_EXPORT_RUN_MINUTE = 30;

/** Gap before the next attempt at a day after a failure (Sheets error, unreadable channels, another instance). */
export const CHAT_EXPORT_RETRY_DELAY_MS = 10 * 60_000;

/**
 * When some channels could not be read, read again once before exporting
 * what was read. When no channel could be read at all, the day is never
 * exported as empty: it is read again every 10 minutes.
 */
export const CHAT_EXPORT_READ_ATTEMPTS = 2;

// ─── Discord bounds (per day exported) ───────────────────────────────────

/** Pages of 100 per text channel (5,000 messages a day) before giving up on the oldest part (reported). */
export const CHAT_EXPORT_MAX_PAGES_PER_CHANNEL = 50;
/** Pages of 100 per forum thread. */
export const CHAT_EXPORT_MAX_PAGES_PER_THREAD = 10;
/** Pages of 100 archived threads listed per forum (newest archived first; stops earlier at the day start). */
export const CHAT_EXPORT_MAX_ARCHIVED_PAGES = 10;
/** Forum threads whose messages are read for one day (all forums together); the rest is counted as truncated. */
export const CHAT_EXPORT_MAX_THREADS_PER_DAY = 300;

/**
 * The records forum 「牌譜紀錄與覆盤」: one post per game. A post's starter
 * message is the game record (data, not an opinion) and is skipped; the
 * replies under it are kept.
 */
export const RECORDS_FORUM_CHANNEL_ID = '1132683080134578276';

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

/** The reading copy's lines (same rules: counts, dates and codes only). */
export const readingCopyChatExportLogger: ChatExportLogger = {
  // eslint-disable-next-line no-console
  info: (m) => console.log(`[chat-export:reading-copy] ${m}`),
  warn: (m) => console.warn(`[chat-export:reading-copy] ${m}`),
};

/**
 * A Discord read of one day is reused by the other target (main ↔ reading
 * copy) for this long after it finished — both run at the same minutes, so
 * a day is normally read from Discord once. Below CHAT_EXPORT_RETRY_DELAY_MS
 * on purpose: a retry 10 minutes later (some channels unreadable) always
 * reads again. So while one target keeps failing after its read (e.g. its
 * sheet refuses the rows), each of its retries reads the day again: at most
 * one extra read per retry, i.e. never more than the two targets reading on
 * their own.
 */
export const CHAT_EXPORT_SHARED_READ_TTL_MS = 5 * 60_000;

export interface ChatExportConfig {
  /** CHAT_EXPORT_ENABLED: default on; false / 0 / off / no turns it off. */
  enabled: boolean;
  /** '' when turned off (CHAT_EXPORT_SHEET_ID=off) or refused (sheetIdRefused). */
  sheetId: string;
  /**
   * The sheet whose two chat tabs are kept to the last 7 days: the target
   * (the default included) even when it is refused or CHAT_EXPORT_ENABLED is
   * false — rows already written there are still pruned (retention only:
   * nothing is created or appended); '' with CHAT_EXPORT_SHEET_ID=off.
   */
  retentionSheetId: string;
  /** The target came from the retired name COMMUNITY_DIGEST_SHEET_ID (warned at start). */
  sheetIdFromRetiredName: boolean;
  /**
   * The id (the default included) is a public stats spreadsheet and
   * CHAT_EXPORT_ALLOW_PUBLIC_SHEET refuses it (0 / false / off / no, or any
   * value that is not a yes): refused, sheetId ''.
   */
  sheetIdRefused: boolean;
  /** The id is a public stats spreadsheet (the default) and not refused: written there (two chat tabs only). */
  publicSheet: boolean;
  /**
   * GOOGLE_SERVICE_ACCOUNT_JSON is set AND parses as a service-account key
   * (client_email + private_key). The value itself never leaves digest/sheets.ts.
   */
  sheetCredentialsUsable: boolean;
  /**
   * CHAT_EXPORT_SOURCE_CHANNEL_IDS — when non-empty, REPLACES the default
   * source list (text / announcement channels and forums; a single forum post
   * id is not a source and is counted as ignored).
   */
  sourceChannelIds: string[];
  /**
   * CHAT_EXPORT_EXTRA_SOURCE_IDS — read IN ADDITION to the default list (or
   * to CHAT_EXPORT_SOURCE_CHANNEL_IDS), even when @everyone cannot see them:
   * e.g. the records forum if it is hidden from @everyone. Same id kinds as
   * above; the exclude list still wins.
   */
  extraSourceIds: string[];
  /**
   * CHAT_EXPORT_EXCLUDE_CHANNEL_IDS plus the admin channel 「大劍管理員」 and
   * the /意見 channel when it is another one (always left out). Applies to
   * text channels, forums and single forum threads.
   */
  excludeChannelIds: string[];
  /** LOBBY_MIRROR_DISCORD_CHANNEL_ID — read even when not visible to @everyone (LINE + lobby relays land there), unless excluded. */
  mirrorChannelId: string;
  /**
   * The one server whose channels are discovered: DISCORD_GUILD_ID, else
   * the 阿瓦隆百科 server (AVALONPEDIA_DISCORD_GUILD_ID). Never every server
   * the bot is in.
   */
  guildId: string;
  /**
   * The reading copy's config only (readChatExportReadingCopyConfig): chat
   * tab kept as the spreadsheet's first tab (created at index 0, moved back
   * there when found elsewhere; best effort — a refused move never stops the
   * rows or the retention). Absent / false for the main target.
   */
  pinChatTabFirst?: boolean;
  /**
   * The reading copy's config only: CHAT_EXPORT_READING_COPY_RUN_PREFIX — the
   * service's run ids start with it and only 完成 rows whose 執行代號 starts
   * with it count. Absent for the main target (any 完成 row counts).
   */
  runIdPrefix?: string;
}

const OFF = ['false', '0', 'off', 'no', 'none'];
const ON = ['true', '1', 'on', 'yes'];

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

/** A pasted spreadsheet URL (also a …/spreadsheets/u/0/d/<id>/… one) → its id; anything else unchanged. */
export function spreadsheetIdFrom(raw: string): string {
  const m = /\/spreadsheets\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{10,})/.exec(raw);
  return m ? m[1] : raw;
}

/** `id` is a public stats spreadsheet: the 阿瓦隆百科 workbook, or the one AVALON_STATS_SHEET_ID names. */
function isPublicStatsSheet(id: string, env: NodeJS.ProcessEnv): boolean {
  const publicIds = [PUBLIC_STATS_SHEET_ID, spreadsheetIdFrom((env.AVALON_STATS_SHEET_ID || '').trim())].filter(Boolean);
  return id !== '' && publicIds.some((p) => id === p || (p.length >= 20 && id.includes(p)));
}

export function readChatExportConfig(env: NodeJS.ProcessEnv = process.env): ChatExportConfig {
  const flag = (env.CHAT_EXPORT_ENABLED || '').trim().toLowerCase();
  const sheetRaw = envFirst(env, 'CHAT_EXPORT_SHEET_ID', 'COMMUNITY_DIGEST_SHEET_ID');
  const sheetIdFromRetiredName = !(env.CHAT_EXPORT_SHEET_ID ?? '').trim() && !!sheetRaw;
  const wanted = OFF.includes(sheetRaw.toLowerCase()) ? '' : spreadsheetIdFrom(sheetRaw || DEFAULT_CHAT_EXPORT_SHEET_ID);
  // The public stats spreadsheet is the default by the owner's decision (2026-10-13).
  // CHAT_EXPORT_ALLOW_PUBLIC_SHEET unset (or a yes) keeps it; any other value refuses it — 0 / false / off / no,
  // and a value not understood too, so a mistyped "no" never publishes chat.
  const isPublic = isPublicStatsSheet(wanted, env);
  const allowRaw = (env.CHAT_EXPORT_ALLOW_PUBLIC_SHEET || '').trim().toLowerCase();
  const allowPublic = allowRaw === '' || ON.includes(allowRaw);
  const sheetIdRefused = isPublic && !allowPublic;
  // The admin channel 「大劍管理員」 and the /意見 channel (if another one) are private: never exported.
  const feedbackChannelId = resolveFeedbackChannelId(env);
  const privateChannelIds = [DEFAULT_FEEDBACK_DISCORD_CHANNEL_ID, ...(/^\d{5,30}$/.test(feedbackChannelId) ? [feedbackChannelId] : [])];
  return {
    enabled: !OFF.includes(flag),
    sheetId: sheetIdRefused ? '' : wanted,
    retentionSheetId: wanted,
    sheetIdFromRetiredName,
    sheetIdRefused,
    publicSheet: isPublic && allowPublic,
    sheetCredentialsUsable: parseServiceAccountJson(env.GOOGLE_SERVICE_ACCOUNT_JSON) !== null,
    sourceChannelIds: idList(envFirst(env, 'CHAT_EXPORT_SOURCE_CHANNEL_IDS', 'COMMUNITY_DIGEST_SOURCE_CHANNEL_IDS')),
    extraSourceIds: idList(env.CHAT_EXPORT_EXTRA_SOURCE_IDS || ''),
    excludeChannelIds: [
      ...new Set([...idList(envFirst(env, 'CHAT_EXPORT_EXCLUDE_CHANNEL_IDS', 'COMMUNITY_DIGEST_EXCLUDE_CHANNEL_IDS')), ...privateChannelIds]),
    ],
    mirrorChannelId: (env.LOBBY_MIRROR_DISCORD_CHANNEL_ID || '').trim(),
    guildId: (env.DISCORD_GUILD_ID || '').trim() || AVALONPEDIA_DISCORD_GUILD_ID,
  };
}

/**
 * Where the reading copy goes:
 *   'on'              — `sheetId` (CHAT_EXPORT_READING_COPY_SHEET_ID, id or URL; default the private sheet);
 *   'off'             — CHAT_EXPORT_READING_COPY_SHEET_ID=off (or false / 0 / no / none);
 *   'primary-off'     — CHAT_EXPORT_SHEET_ID=off (or the retired name): no sheet at all, the
 *                       copy of nothing is not written either;
 *   'same-as-primary' — the main target's sheet (a pointless duplicate; also the default
 *                       when CHAT_EXPORT_SHEET_ID names the private sheet);
 *   'public-refused'  — a public stats workbook (its first tab must stay 牌譜; the chat
 *                       is already in the 百科 workbook when that is the main target).
 * CHAT_EXPORT_ALLOW_PUBLIC_SHEET=0 (the 百科 workbook refused) leaves the copy 'on': it
 * is private, and the AI manager still reads the chat there.
 */
export type ChatExportReadingCopyState = 'on' | 'off' | 'primary-off' | 'same-as-primary' | 'public-refused';

export function readingCopyTarget(
  env: NodeJS.ProcessEnv = process.env,
  primary: ChatExportConfig = readChatExportConfig(env),
): { sheetId: string; state: ChatExportReadingCopyState } {
  const raw = (env.CHAT_EXPORT_READING_COPY_SHEET_ID || '').trim();
  if (OFF.includes(raw.toLowerCase())) return { sheetId: '', state: 'off' };
  const id = spreadsheetIdFrom(raw || DEFAULT_CHAT_EXPORT_READING_COPY_SHEET_ID);
  // The main target before any refusal ('' = CHAT_EXPORT_SHEET_ID=off: no sheet at all, so no copy either).
  const main = primary.retentionSheetId;
  if (main === '') return { sheetId: '', state: 'primary-off' };
  if (id === main || (main.length >= 20 && id.includes(main))) return { sheetId: '', state: 'same-as-primary' };
  if (isPublicStatsSheet(id, env)) return { sheetId: '', state: 'public-refused' };
  return { sheetId: id, state: 'on' };
}

/**
 * The reading copy as a ChatExportConfig for its own ChatExportService: the
 * main target's sources, exclusions, server and on/off switch
 * (CHAT_EXPORT_ENABLED) — so the same messages become the same rows — with
 * its own sheet, the chat tab pinned first and its own run-id prefix. Not
 * 'on' → enabled false and nothing to prune (the copy is not written
 * there). CHAT_EXPORT_ENABLED=false with the copy 'on' → retention only,
 * like the main target (days older than 7 still leave it).
 * CHAT_EXPORT_ALLOW_PUBLIC_SHEET does not apply (the copy is never public).
 */
export function readChatExportReadingCopyConfig(env: NodeJS.ProcessEnv = process.env): ChatExportConfig {
  const primary = readChatExportConfig(env);
  const copy = readingCopyTarget(env, primary);
  return {
    ...primary,
    enabled: primary.enabled && copy.state === 'on',
    sheetId: copy.sheetId,
    retentionSheetId: copy.sheetId,
    sheetIdFromRetiredName: false,
    sheetIdRefused: false,
    publicSheet: false,
    pinChatTabFirst: true,
    runIdPrefix: CHAT_EXPORT_READING_COPY_RUN_PREFIX,
  };
}
