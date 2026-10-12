/**
 * Community feedback (2026-10-12) — configuration and fixed texts.
 *
 * See docs/COMMUNITY_FEEDBACK.md. Nothing here is a secret: the env vars are
 * a feature flag (read once at module load — FEEDBACK_CONFIG.commandEnabled;
 * tests flip the field directly) and a Discord channel id (read on every
 * call by resolveFeedbackChannelId(), so tests can set the env var).
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
 * Discord channel that receives forwarded opinions: FEEDBACK_DISCORD_CHANNEL_ID
 * only. Unset → '' → the person is acknowledged and the opinion counted, but
 * nothing is forwarded.
 *
 * Deliberately NO fallback to LOBBY_MIRROR_DISCORD_CHANNEL_ID (the public
 * community channel): the forwarded line is anonymous by design and anyone
 * who friends the LINE OA or is in the Discord server can submit one, so the
 * target must be a channel the owner chose on purpose (a private one).
 */
export function resolveFeedbackChannelId(): string {
  return (process.env.FEEDBACK_DISCORD_CHANNEL_ID || '').trim();
}
