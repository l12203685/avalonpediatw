/**
 * Community feedback without moving chat text off Render (2026-10-12).
 * docs/COMMUNITY_FEEDBACK.md explains the why; this module is the how:
 *
 *   topicCounter.ts  — keyword → weekly per-platform counts (numbers only)
 *   commands.ts      — /意見 parsing + the forwarded line's format
 *   service.ts       — FeedbackService singleton (observe / submit / snapshot)
 *   discordCommand.ts— the Discord slash handler
 *   discordForwarder.ts — the real Discord sender (FEEDBACK_DISCORD_CHANNEL_ID, else a private 管理者信箱)
 */

export * from './config';
export * from './topicCounter';
export * from './commands';
export * from './service';
export * from './discordForwarder';
