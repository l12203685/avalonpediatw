/**
 * The ChatMirror view of the Discord sync channel (2026-10-13).
 *
 * Kept apart from bots/index.ts so the picture wiring can be tested without
 * a discord.js gateway: `mirrorChannelAdapter()` takes the slice of a
 * discord.js TextChannel it uses.
 *
 *   send        plain text, exactly as before
 *   sendFiles   LINE pictures as attachments; mentions disabled so a relayed
 *               label can never ping anyone (needs Attach Files in the channel)
 *   maxUploadBytes  the bot's upload limit for this server's boost tier
 */

import type { DiscordChannelAdapter } from '../ChatMirror';
import { discordUploadLimitBytes } from '../media/relayMedia';

/** What a discord.js message send accepts here (string or options object). */
export type MirrorChannelSendPayload =
  | string
  | {
      content: string;
      files: { attachment: Buffer; name: string }[];
      allowedMentions: { parse: [] };
    };

/** The parts of a discord.js TextChannel the mirror uses. */
export interface MirrorTextChannelLike {
  send(payload: MirrorChannelSendPayload): Promise<unknown>;
  guild?: { premiumTier?: number | null } | null;
}

export function mirrorChannelAdapter(ch: MirrorTextChannelLike): DiscordChannelAdapter {
  return {
    send: async (content: string) => ch.send(content),
    sendFiles: async (content, files) =>
      ch.send({
        content,
        files: files.map((f) => ({ attachment: f.data, name: f.name })),
        allowedMentions: { parse: [] },
      }),
    maxUploadBytes: discordUploadLimitBytes(ch.guild?.premiumTier),
  };
}
