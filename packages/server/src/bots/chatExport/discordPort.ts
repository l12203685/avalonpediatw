/**
 * The Discord side of the daily chat-log export behind a small interface,
 * so the service can be tested without discord.js and bots/index.ts can hand
 * in the live client lazily (the gateway may come up after boot).
 */

import type { Client } from 'discord.js';
import { collectDiscordMessages, emptyCollectResult, type CollectResult } from './collector';
import type { ChatExportConfig } from './config';
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
