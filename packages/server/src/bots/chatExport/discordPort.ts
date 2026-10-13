/**
 * The Discord side of the daily chat-log export behind a small interface,
 * so the service can be tested without discord.js and bots/index.ts can hand
 * in the live client lazily (the gateway may come up after boot).
 *
 * Two services read through it — the main target and the reading copy
 * (config.ts DEFAULT_CHAT_EXPORT_READING_COPY_SHEET_ID) — so bots/index.ts
 * wraps it in shareChatExportReads(): a day is read from Discord once and the
 * same messages become the same rows in both sheets.
 */

import type { Client } from 'discord.js';
import { collectDiscordMessages, emptyCollectResult, type CollectResult } from './collector';
import { CHAT_EXPORT_SHARED_READ_TTL_MS, type ChatExportConfig } from './config';
import type { ExportWindow } from './window';

export interface ChatExportDiscordPort {
  isReady(): boolean;
  /** One day's messages (text channels, the sync channel, forum posts). */
  collect(cfg: ChatExportConfig, window: ExportWindow): Promise<CollectResult>;
}

/** `getClient` returns the discord.js client once the gateway is ready, else null. */
export function createDiscordChatExportPort(getClient: () => Client | null): ChatExportDiscordPort {
  return {
    isReady: () => !!getClient(),
    async collect(cfg, window): Promise<CollectResult> {
      const client = getClient();
      if (!client) return emptyCollectResult();
      return collectDiscordMessages(client, cfg, window);
    },
  };
}

/** What decides a read: the day and the source selection (never the sheet). */
function readKey(cfg: ChatExportConfig, w: ExportWindow): string {
  return JSON.stringify([
    w.dayKey,
    w.start,
    w.end,
    cfg.guildId,
    cfg.sourceChannelIds,
    cfg.extraSourceIds,
    cfg.excludeChannelIds,
    cfg.mirrorChannelId,
  ]);
}

/** Each caller gets its own arrays (the service never mutates them; defensive). */
function copyResult(r: CollectResult): CollectResult {
  return { ...r, messages: [...r.messages], channels: [...r.channels] };
}

/**
 * One Discord read per day for both targets: a read of the same day (and the
 * same sources) that is still running is joined, and one that finished less
 * than `ttlMs` ago (CHAT_EXPORT_SHARED_READ_TTL_MS, 5 minutes) is reused.
 * Kept shorter than the 10-minute retry delay, so a retry (some channels
 * unreadable) always reads again. A failed read is not kept. Entries are
 * dropped when they expire (the messages are not held in memory longer).
 */
export function shareChatExportReads(
  inner: ChatExportDiscordPort,
  opts: { ttlMs?: number; now?: () => number } = {},
): ChatExportDiscordPort {
  const ttl = opts.ttlMs ?? CHAT_EXPORT_SHARED_READ_TTL_MS;
  const now = opts.now ?? Date.now;
  const reads = new Map<string, { promise: Promise<CollectResult>; doneAt: number | null }>();
  return {
    isReady: () => inner.isReady(),
    collect(cfg, window): Promise<CollectResult> {
      const t = now();
      for (const [k, e] of reads) if (e.doneAt !== null && t - e.doneAt >= ttl) reads.delete(k);
      const key = readKey(cfg, window);
      const hit = reads.get(key);
      if (hit) return hit.promise.then(copyResult);
      const entry: { promise: Promise<CollectResult>; doneAt: number | null } = { promise: inner.collect(cfg, window), doneAt: null };
      reads.set(key, entry);
      entry.promise.then(
        () => {
          entry.doneAt = now();
          const drop = setTimeout(() => {
            if (reads.get(key) === entry) reads.delete(key);
          }, ttl);
          drop.unref?.();
        },
        () => {
          if (reads.get(key) === entry) reads.delete(key);
        },
      );
      return entry.promise.then(copyResult);
    },
  };
}
