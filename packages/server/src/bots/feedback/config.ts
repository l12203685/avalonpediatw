/**
 * Community feedback (2026-10-12) — configuration and fixed texts.
 *
 * See docs/COMMUNITY_FEEDBACK.md. Nothing here is a secret: the env vars are
 * a feature flag (read once at module load — FEEDBACK_CONFIG.commandEnabled;
 * tests flip the field directly) and a Discord channel id (read on every
 * call by resolveFeedbackChannelId(), so tests can set the env var; default
 * the owner's admin channel 「大劍管理員」, 2026-10-13).
 */

export type FeedbackPlatform = 'line' | 'discord';

export const FEEDBACK_CONFIG = {
  /**
   * Feature flag for the /意見 command on both platforms. Default ON;
   * FEEDBACK_COMMAND_ENABLED=false / 0 / no / off disables it. Topic
   * counting is NOT gated by this flag (it never replies to anyone).
   */
  commandEnabled: !['false', '0', 'no', 'off'].includes(
    (process.env.FEEDBACK_COMMAND_ENABLED || '').trim().toLowerCase(),
  ),
};

/** Fixed acknowledgement — identical on LINE and Discord. */
export const FEEDBACK_ACK_TEXT = '已收到，謝謝。管理者每週彙整後調整。';

/** Shown when /意見 is typed without any content. */
export const FEEDBACK_USAGE_TEXT = '請在 /意見 後面寫下內容，例如：/意見 排行榜希望加上場次。';

/** Discord reply when FEEDBACK_COMMAND_ENABLED is off (the slash command stays registered). */
export const FEEDBACK_DISABLED_TEXT = '/意見 目前停用，請直接在群組裡說。';

/** Opinion content forwarded to Discord is cut to this many characters. */
export const FEEDBACK_CONTENT_MAX_CHARS = 500;

/** Topic buckets kept in memory (ISO weeks, +08). */
export const FEEDBACK_RETAIN_WEEKS = 8;

/** Global cap on forwarded opinions per rolling hour (anti-flood; the ack is still sent). */
export const FEEDBACK_MAX_FORWARDS_PER_HOUR = 30;

/**
 * The owner's admin channel 「大劍管理員」 (Edward 2026-10-13: "大劍管理員就是
 * 管理員頻道了"): forwarded /意見 texts go here unless
 * FEEDBACK_DISCORD_CHANNEL_ID says otherwise.
 * https://discord.com/channels/1132682489840812113/1145513360545296574
 */
export const DEFAULT_FEEDBACK_DISCORD_CHANNEL_ID = '1145513360545296574';

const OFF = ['false', '0', 'off', 'no', 'none'];

/**
 * Discord channel that receives forwarded opinions:
 *   FEEDBACK_DISCORD_CHANNEL_ID when set (the owner's choice, used as is);
 *   'off' / 'none' / 'false' / '0' / 'no' → '' (opinions are acknowledged and
 *   counted, not forwarded);
 *   unset → DEFAULT_FEEDBACK_DISCORD_CHANNEL_ID (the admin channel).
 * Either way the id is used as is: the bot does not second-guess the
 * channel's visibility (the owner picked it). Deliberately never the public
 * LINE↔Discord sync channel (LOBBY_MIRROR_DISCORD_CHANNEL_ID) as a fallback:
 * the forwarded line is anonymous and anyone can submit one.
 */
export function resolveFeedbackChannelId(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.FEEDBACK_DISCORD_CHANNEL_ID || '').trim();
  if (OFF.includes(raw.toLowerCase())) return '';
  return raw || DEFAULT_FEEDBACK_DISCORD_CHANNEL_ID;
}
