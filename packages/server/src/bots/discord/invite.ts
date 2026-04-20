/**
 * Discord Game Invite System
 *
 * Generates invite links to the web platform and posts them to Discord.
 * Used by /create command and triggered by the game server when a room opens.
 */

import { EmbedBuilder, TextChannel } from 'discord.js';
import { getDiscordBot } from './client';
import { DISCORD_CONFIG } from './config';

const SYNC_CHANNEL_ID = '1132901301802504242'; // #同步閒聊

/**
 * Build the web platform join URL for a given room.
 *
 * In production the WEB_BASE_URL environment variable MUST be set — otherwise
 * we throw rather than fall back to `http://localhost:3000`, which would be a
 * broken link for real Discord users. Local/dev environments still fall back
 * to localhost for convenience.
 */
export function buildGameJoinUrl(roomId: string): string {
  const baseUrl = process.env.WEB_BASE_URL;
  if (!baseUrl) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'WEB_BASE_URL is not configured. Set WEB_BASE_URL before starting the Discord bot in production.'
      );
    }
    return `http://localhost:3000/game/${roomId}`;
  }
  return `${baseUrl}/game/${roomId}`;
}

/**
 * Build an embed for a game invite.
 */
export function buildInviteEmbed(options: {
  roomId: string;
  hostName: string;
  playerCount?: number;
  maxPlayers?: number;
  joinUrl: string;
}): EmbedBuilder {
  const { roomId, hostName, playerCount = 1, maxPlayers = 10, joinUrl } = options;

  return new EmbedBuilder()
    .setColor(DISCORD_CONFIG.colors.neutral)
    .setTitle('🎭 新遊戲開始招募！')
    .setDescription(
      `**${hostName}** 開了一場阿瓦隆！\n快來加入，需要 5-10 人才能開始。`
    )
    .addFields(
      { name: 'Room ID', value: `\`${roomId}\``, inline: true },
      { name: '人數', value: `${playerCount} / ${maxPlayers}`, inline: true },
      { name: '狀態', value: '等待玩家中', inline: true },
      {
        name: '加入遊戲',
        value: `[點此進入房間](${joinUrl})\n\n或在 Discord 輸入:\n\`/join ${roomId}\``,
        inline: false,
      }
    )
    .setFooter({ text: '阿瓦隆百科 · avalonpediatw' })
    .setTimestamp();
}

/**
 * Post a game invite to #同步閒聊.
 * Called when a new room is created via the Discord /create command
 * or when the web platform triggers an announcement.
 *
 * Returns the message ID of the posted invite (for later editing), or null on failure.
 */
export async function postGameInvite(options: {
  roomId: string;
  hostName: string;
  playerCount?: number;
  maxPlayers?: number;
}): Promise<string | null> {
  const bot = getDiscordBot();
  if (!bot || !bot.isClientReady()) {
    console.warn('Discord invite: bot not ready, skipping invite post');
    return null;
  }

  try {
    const channel = await bot.getClient().channels.fetch(SYNC_CHANNEL_ID);
    if (!channel || !(channel instanceof TextChannel)) {
      console.warn(`Discord invite: channel ${SYNC_CHANNEL_ID} not found`);
      return null;
    }

    const joinUrl = buildGameJoinUrl(options.roomId);
    const embed = buildInviteEmbed({ ...options, joinUrl });

    const message = await channel.send({ embeds: [embed] });
    console.log(`Discord invite: posted invite for room ${options.roomId}, msg ${message.id}`);
    return message.id;
  } catch (error) {
    console.error('Discord invite: failed to post game invite:', error);
    return null;
  }
}

/**
 * Update an existing invite message with current player count.
 * Call this when players join the lobby.
 */
export async function updateInviteMessage(
  messageId: string,
  options: {
    roomId: string;
    hostName: string;
    playerCount: number;
    maxPlayers: number;
  }
): Promise<void> {
  const bot = getDiscordBot();
  if (!bot || !bot.isClientReady()) return;

  try {
    const channel = await bot.getClient().channels.fetch(SYNC_CHANNEL_ID);
    if (!channel || !(channel instanceof TextChannel)) return;

    const message = await channel.messages.fetch(messageId);
    if (!message) return;

    const joinUrl = buildGameJoinUrl(options.roomId);
    const embed = buildInviteEmbed({ ...options, joinUrl });

    await message.edit({ embeds: [embed] });
  } catch (error) {
    console.error('Discord invite: failed to update invite message:', error);
  }
}
