/**
 * Daily chat-log export (2026-10-13, daily with a 7-day window since round 3;
 * docs/COMMUNITY_FEEDBACK.md). Replaced the paid weekly digest: free, rows
 * only, no summary, no LLM.
 *
 *   config.ts      — env vars (incl. the public-sheet opt-in), constants, logger
 *   window.ts      — +08 day math, the 04:30 run time, the 7-day window
 *   collector.ts   — Discord history for one day: text channels, sync channel, forum posts (discord.js)
 *   rows.ts        — relay parsing, filtering, per-day pseudonyms, sheet rows (pure)
 *   sheetWriter.ts — tabs 「聊天紀錄」 + 「匯出紀錄」 (export log) only: create, append, read, prune
 *   discordPort.ts — Discord adapter (collection)
 *   service.ts     — catch-up on start, daily 04:30 run, claim / 完成 (one copy across restarts and instances), status
 *
 * Google auth + Sheets REST: ../digest/sheets.ts (shared helper).
 */

export * from './config';
export * from './window';
export * from './rows';
export * from './collector';
export * from './sheetWriter';
export * from './discordPort';
export * from './service';
