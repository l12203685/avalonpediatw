/**
 * The real Discord sender for forwarded /意見 texts.
 *
 * Target channel (feedback/config.ts → resolveFeedbackChannelId):
 * FEEDBACK_DISCORD_CHANNEL_ID when set, otherwise the owner's admin channel
 * 「大劍管理員」 (2026-10-13). The id is used as is — the owner chose the
 * channel, so its visibility is not checked — but it must be a server
 * channel the bot can post in (a text or announcement channel, or a thread);
 * a DM, a voice channel without text, a forum itself or an unknown id
 * resolve to false ("not forwarded"). The client is re-read on every call
 * because the gateway may come up after boot.
 */

import type { Channel, Client } from 'discord.js';
import type { FeedbackDiscordForwarder, FeedbackForwardPayload } from './service';

/** A server channel the bot can post a message in. */
function isPostableGuildChannel(ch: Channel | null): ch is Channel & { send: (p: FeedbackForwardPayload) => Promise<unknown> } {
  return !!ch && !ch.isDMBased() && ch.isSendable();
}

export function createFeedbackDiscordForwarder(getClient: () => Client | null): FeedbackDiscordForwarder {
  return {
    send: async (channelId: string, payload: FeedbackForwardPayload): Promise<boolean> => {
      const client = getClient();
      if (!client) return false;
      const ch = await client.channels.fetch(channelId);
      if (!isPostableGuildChannel(ch)) return false;
      await ch.send(payload);
      return true;
    },
  };
}
