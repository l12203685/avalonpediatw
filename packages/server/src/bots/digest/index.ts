/**
 * Weekly community digest (2026-10-13, docs/COMMUNITY_FEEDBACK.md「每週社群週報」).
 *
 *   config.ts        — env vars, constants, logger
 *   window.ts        — +08 week math, marker line
 *   collector.ts     — Discord history for one window (discord.js)
 *   transcript.ts    — relay parsing, filtering, pseudonyms, size cap (pure)
 *   summarizer.ts    — the Claude API call (@anthropic-ai/sdk)
 *   format.ts        — Discord post, chunking, failure notice (pure)
 *   sheets.ts        — Google Sheets append with a service-account JWT
 *   discordPort.ts   — Discord adapter (admin channel + collection)
 *   service.ts       — orchestration, Monday schedule, status
 *   discordCommand.ts— /社群週報 (admins, ephemeral status reply)
 */

export * from './config';
export * from './window';
export * from './transcript';
export * from './summarizer';
export * from './format';
export * from './sheets';
export * from './discordPort';
export * from './service';
