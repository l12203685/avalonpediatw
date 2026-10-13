/**
 * Weekly community digest (2026-10-13) — configuration.
 *
 * Read on every call (not cached at module load) so tests can set env vars
 * and a Render env change takes effect after the redeploy without code.
 * docs/COMMUNITY_FEEDBACK.md「每週社群週報」explains the feature.
 */

import type { AdminChannelEnvId } from '../discord/adminChannel';
import { parseServiceAccountJson } from './sheets';

/** Default model (claude-api skill, 2026-10): Claude Opus 5.5. */
export const DEFAULT_COMMUNITY_DIGEST_MODEL = 'claude-opus-5-5';

/** Private sheet the AI manager reads; shared with the service account as writer. */
export const DEFAULT_COMMUNITY_DIGEST_SHEET_ID = '1k-ZNYqCnnS__Oc-NLX_ciVmaHOnBwilHbFjXeE5orx8';

/** Transcript cap in characters; beyond it the oldest messages are left out (and counted). */
export const DEFAULT_COMMUNITY_DIGEST_MAX_CHARS = 600_000;

/** One chat message is cut to this many characters in the transcript. */
export const DIGEST_MESSAGE_MAX_CHARS = 500;

/** Output cap for the summary call (thinking is always on and counts toward it). */
export const DIGEST_MAX_TOKENS = 16_000;

/** USD per million tokens for claude-opus-5-5 (for the cost estimate in the status reply). */
export const DIGEST_PRICE_PER_MTOK = { input: 4, output: 20 } as const;

/**
 * Scheduled run: starts Monday 09:00 +08 (for the previous Monday 00:00 →
 * Sunday 24:00). Until 12:00 the scheduler keeps trying — Discord not
 * connected yet, a deploy/restart at 09:00, a transient API error — so one
 * bad minute does not lose the week; the marker / sheet-row checks keep it
 * to one post.
 */
export const DIGEST_RUN_WEEKDAY = 1;
export const DIGEST_RUN_HOUR = 9;
export const DIGEST_RUN_WINDOW_MINUTES = 180;

/** Gap before the second attempt after a transient failure (rate limit, overload, network). */
export const DIGEST_RETRY_DELAY_MS = 10 * 60_000;

/** After a restart, this many recent admin-channel messages are searched for the week's marker. */
export const DIGEST_MARKER_LOOKBACK = 50;

/** Max summary attempts per scheduled week (a refusal is never retried). */
export const DIGEST_MAX_ATTEMPTS_PER_WEEK = 2;

/** Minimum gap between two manual /社群週報 runs (each one is a paid API call). */
export const DIGEST_MANUAL_COOLDOWN_MS = 5 * 60_000;

/** Receives fixed strings with counts and codes only — never chat text, names or the summary. */
export interface DigestLogger {
  info(message: string): void;
  warn(message: string): void;
}

export const defaultDigestLogger: DigestLogger = {
  // eslint-disable-next-line no-console
  info: (m) => console.log(`[community-digest] ${m}`),
  warn: (m) => console.warn(`[community-digest] ${m}`),
};

export interface CommunityDigestConfig {
  /** COMMUNITY_DIGEST_ENABLED: on/off; unset → on exactly when ANTHROPIC_API_KEY is set. */
  enabled: boolean;
  anthropicConfigured: boolean;
  model: string;
  maxChars: number;
  /** COMMUNITY_DIGEST_SOURCE_CHANNEL_IDS — when non-empty, replaces the default source list. */
  sourceChannelIds: string[];
  /** COMMUNITY_DIGEST_EXCLUDE_CHANNEL_IDS. */
  excludeChannelIds: string[];
  /** LOBBY_MIRROR_DISCORD_CHANNEL_ID — always read (LINE + lobby relays land there). */
  mirrorChannelId: string;
  /** Admin channel lookup order (then the channel named 管理者信箱). */
  adminChannelEnvIds: AdminChannelEnvId[];
  /** DISCORD_GUILD_ID — limits channel discovery to one server when set. */
  guildId: string;
  /** '' when the sheet destination is turned off (COMMUNITY_DIGEST_SHEET_ID=off). */
  sheetId: string;
  /**
   * GOOGLE_SERVICE_ACCOUNT_JSON is set AND parses as a service-account key
   * (client_email + private_key). The value itself never leaves sheets.ts.
   */
  sheetCredentialsUsable: boolean;
}

const OFF = ['false', '0', 'off', 'no'];
const ON = ['true', '1', 'on', 'yes'];

function idList(raw: string | undefined): string[] {
  return (raw || '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => /^\d{5,30}$/.test(s));
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number((raw || '').trim());
  return Number.isFinite(n) && n >= 1000 ? Math.floor(n) : fallback;
}

export function readDigestConfig(env: NodeJS.ProcessEnv = process.env): CommunityDigestConfig {
  const anthropicConfigured = !!(env.ANTHROPIC_API_KEY || '').trim();
  const flag = (env.COMMUNITY_DIGEST_ENABLED || '').trim().toLowerCase();
  const enabled = OFF.includes(flag) ? false : ON.includes(flag) ? true : anthropicConfigured;
  const sheetRaw = (env.COMMUNITY_DIGEST_SHEET_ID ?? '').trim();
  const sheetId = OFF.includes(sheetRaw.toLowerCase()) || sheetRaw.toLowerCase() === 'none'
    ? ''
    : sheetRaw || DEFAULT_COMMUNITY_DIGEST_SHEET_ID;
  return {
    enabled,
    anthropicConfigured,
    model: (env.COMMUNITY_DIGEST_MODEL || '').trim() || DEFAULT_COMMUNITY_DIGEST_MODEL,
    maxChars: positiveInt(env.COMMUNITY_DIGEST_MAX_CHARS, DEFAULT_COMMUNITY_DIGEST_MAX_CHARS),
    sourceChannelIds: idList(env.COMMUNITY_DIGEST_SOURCE_CHANNEL_IDS),
    excludeChannelIds: idList(env.COMMUNITY_DIGEST_EXCLUDE_CHANNEL_IDS),
    mirrorChannelId: (env.LOBBY_MIRROR_DISCORD_CHANNEL_ID || '').trim(),
    adminChannelEnvIds: [
      { env: 'COMMUNITY_DIGEST_CHANNEL_ID', id: (env.COMMUNITY_DIGEST_CHANNEL_ID || '').trim() },
      { env: 'FEEDBACK_DISCORD_CHANNEL_ID', id: (env.FEEDBACK_DISCORD_CHANNEL_ID || '').trim() },
    ],
    guildId: (env.DISCORD_GUILD_ID || '').trim(),
    sheetId,
    sheetCredentialsUsable: parseServiceAccountJson(env.GOOGLE_SERVICE_ACCOUNT_JSON) !== null,
  };
}
