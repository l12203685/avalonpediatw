/**
 * The Discord side of the weekly community digest behind a small interface,
 * so the service can be tested without discord.js and bots/index.ts can hand
 * in the live client lazily (the gateway may come up after boot).
 */

import type { Client, Message } from 'discord.js';
import {
  describeAdminChannelProblem,
  resolveAdminChannel,
  type AdminChannelProblem,
} from '../discord/adminChannel';
import { collectDiscordMessages, type CollectResult } from './collector';
import { DIGEST_MARKER_LOOKBACK, type CommunityDigestConfig } from './config';
import type { DigestWindow } from './window';

export interface DigestAdminTarget {
  id: string;
  /** Post one message (≤ 2000 chars) with no pings. */
  send(content: string): Promise<void>;
  /** True when one of the last ~50 messages is the bot's post starting with `marker`. */
  hasRecentMarker(marker: string): Promise<boolean>;
}

export type DigestAdminResolution =
  | { ok: true; target: DigestAdminTarget }
  | { ok: false; problem: AdminChannelProblem; detail: string };

export interface DigestDiscordPort {
  isReady(): boolean;
  resolveAdmin(cfg: CommunityDigestConfig): Promise<DigestAdminResolution>;
  collect(cfg: CommunityDigestConfig, window: DigestWindow, excludeIds: string[]): Promise<CollectResult>;
}

/** `getClient` returns the discord.js client once the gateway is ready, else null. */
export function createDiscordDigestPort(getClient: () => Client | null): DigestDiscordPort {
  return {
    isReady: () => !!getClient(),

    async resolveAdmin(cfg): Promise<DigestAdminResolution> {
      const client = getClient();
      // needHistory: without Read Message History Discord returns an empty
      // history, the restart marker check would see nothing and post twice.
      const res = await resolveAdminChannel(client, cfg.adminChannelEnvIds, { guildId: cfg.guildId, needHistory: true });
      if (!res.ok) return { ok: false, problem: res.problem, detail: describeAdminChannelProblem(res) };
      const channel = res.channel;
      const selfId = client?.user?.id ?? '';
      return {
        ok: true,
        target: {
          id: channel.id,
          send: async (content: string): Promise<void> => {
            await channel.send({ content, allowedMentions: { parse: [] } });
          },
          hasRecentMarker: async (marker: string): Promise<boolean> => {
            const recent = await channel.messages.fetch({ limit: DIGEST_MARKER_LOOKBACK, cache: false });
            return [...recent.values()].some(
              (m: Message) => m.author.id === selfId && (m.content ?? '').startsWith(marker),
            );
          },
        },
      };
    },

    async collect(cfg, window, excludeIds): Promise<CollectResult> {
      const client = getClient();
      if (!client) return { messages: [], channels: [], truncatedChannels: 0, failedChannels: 0, publicChannelsFound: null };
      return collectDiscordMessages(client, cfg, window, { excludeIds });
    },
  };
}
