/**
 * Weekly chat-log export (2026-10-13, docs/COMMUNITY_FEEDBACK.md).
 * Replaced the paid weekly digest: free, rows only, no summary.
 *
 *   config.ts      — env vars, constants, logger
 *   window.ts      — +08 week math
 *   collector.ts   — Discord history for one week (discord.js)
 *   rows.ts        — relay parsing, filtering, pseudonyms, sheet rows (pure)
 *   sheetWriter.ts — the 「聊天紀錄」 tab: create, check, append, prune
 *   discordPort.ts — Discord adapter (collection)
 *   service.ts     — Monday schedule, idempotency, status
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
