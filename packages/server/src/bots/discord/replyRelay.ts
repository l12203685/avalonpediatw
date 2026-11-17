/**
 * Discord 的機器人指令回覆同步到 LINE 群（Edward 2026-11-17：「在dc/line 輸入機器人指令, line/dc 不會同步另一邊的機器人指令回覆」）。
 *
 * 只在同步頻道（LOBBY_MIRROR_DISCORD_CHANNEL_ID）、公開的回覆才送；/意見（只有本人看得到）、/回報 /認領（機器人自己會貼）、
 * /help（embed）不送。slash 指令本身不是訊息，沒有同步過，所以先送一行「名字 打的指令」，再送機器人的回覆
 * （ChatMirror.relayBotReply：排進 LINE 回覆佇列，下一次有人在 LINE 群說話時用 reply_token 一起送，不用 push）。
 */
import { MessageFlags, type ChatInputCommandInteraction } from 'discord.js';
import { COMMANDS } from './config';
import type { ChatMirror } from '../ChatMirror';

export const RELAYED_DISCORD_COMMANDS: ReadonlySet<string> = new Set([
  COMMANDS.STATS,
  COMMANDS.LEADERBOARD,
  COMMANDS.CHEMISTRY,
  COMMANDS.SIM,
  COMMANDS.SIM_PROPOSE,
  COMMANDS.SIM_INTERVAL,
  COMMANDS.SIM_ANALYSIS,
  COMMANDS.SIM_ASSASSINATE,
  COMMANDS.SIM_REVEAL,
  COMMANDS.SIM_END,
  COMMANDS.SEAT_FILLER,
  COMMANDS.PAIPU_FIX,
]);

/** 回覆附了圖（/排行 的圖表）：LINE 那邊只有文字，加一行說明。 */
export const RELAY_ATTACHMENT_NOTE = '（附圖在 Discord）';

/** Discord 的 code block 圍欄與粗體記號在 LINE 只會變成雜字：拿掉。 */
export function plainForLine(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^```\w*$/u.test(line.trim()))
    .join('\n')
    .replace(/\*\*(.+?)\*\*/gu, '$1')
    .trim();
}

type RelayInteraction = Pick<ChatInputCommandInteraction, 'commandName' | 'channelId' | 'deferred' | 'replied' | 'fetchReply' | 'toString' | 'user' | 'member'>;

function askerName(interaction: RelayInteraction): string {
  const member = interaction.member as { displayName?: unknown; nick?: unknown } | null;
  const fromMember = typeof member?.displayName === 'string' ? member.displayName : typeof member?.nick === 'string' ? member.nick : '';
  const user = interaction.user as { globalName?: string | null; username?: string };
  return (fromMember || user.globalName || user.username || 'Discord').trim();
}

/**
 * 回覆送出之後呼叫。true = 排進 LINE 了。從不丟錯（讀不到回覆、ephemeral、不是同步頻道都回 false）。
 */
export async function relayInteractionReply(
  interaction: RelayInteraction,
  deps: { mirror: Pick<ChatMirror, 'relayBotReply'> | null; channelId: string },
): Promise<boolean> {
  if (!deps.mirror || !deps.channelId) return false;
  if (!RELAYED_DISCORD_COMMANDS.has(interaction.commandName)) return false;
  if (interaction.channelId !== deps.channelId) return false;
  if (!interaction.deferred && !interaction.replied) return false;
  try {
    const msg = await interaction.fetchReply();
    const flags = msg.flags as { has?: (f: number) => boolean } | undefined;
    if (flags?.has?.(MessageFlags.Ephemeral)) return false;
    let text = plainForLine(msg.content ?? '');
    const attachments = msg.attachments as { size?: number } | undefined;
    if ((attachments?.size ?? 0) > 0) text = text ? `${text}\n${RELAY_ATTACHMENT_NOTE}` : RELAY_ATTACHMENT_NOTE;
    if (!text) return false;
    return await deps.mirror.relayBotReply({ origin: 'discord', reply: text, command: interaction.toString(), asker: askerName(interaction) });
  } catch {
    return false;
  }
}
