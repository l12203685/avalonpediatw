/**
 * The real Discord sender for forwarded /意見 texts (2026-10-13).
 *
 * Target channel:
 *   - FEEDBACK_DISCORD_CHANNEL_ID when set — any guild text channel, exactly
 *     as before 2026-10-13 (the owner chose it on purpose);
 *   - otherwise the private guild text channel named 「管理者信箱」 (the same
 *     channel the weekly community digest uses, so the owner creates one
 *     private channel for both). This fallback is only used when it is
 *     private (resolveAdminChannel: not visible to @everyone or to an
 *     ordinary role); anonymous text must never be laundered into a
 *     members-visible channel the owner did not pick.
 * Lazy like the other adapters: the client is re-read on every call because
 * the gateway may come up after boot.
 */

import { ChannelType } from 'discord.js';
import type { Client, TextChannel } from 'discord.js';
import { resolveAdminChannel } from '../discord/adminChannel';
import type { FeedbackDiscordForwarder, FeedbackForwardPayload } from './service';

export interface FeedbackForwarderOptions {
  /** DISCORD_GUILD_ID — limits the 管理者信箱 lookup to one server. */
  guildId?: string;
  /** Fixed strings only (never the opinion text). */
  logger?: { warn: (m: string) => void };
}

export function createFeedbackDiscordForwarder(
  getClient: () => Client | null,
  opts: FeedbackForwarderOptions = {},
): FeedbackDiscordForwarder {
  const warn = opts.logger?.warn ?? ((m: string): void => console.warn(`[feedback] ${m}`));
  return {
    send: async (channelId: string, payload: FeedbackForwardPayload): Promise<boolean> => {
      const client = getClient();
      if (!client) return false;
      const ch = await client.channels.fetch(channelId);
      if (!ch || ch.type !== ChannelType.GuildText) return false;
      await (ch as TextChannel).send(payload);
      return true;
    },
    resolveFallbackChannelId: async (): Promise<string> => {
      const res = await resolveAdminChannel(getClient(), [], { guildId: opts.guildId });
      if (res.ok) return res.channel.id;
      if (res.problem !== 'discord-not-ready') warn(`no private admin channel for opinions (${res.problem})`);
      return '';
    },
  };
}
