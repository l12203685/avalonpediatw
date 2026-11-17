/**
 * Discord 斜線指令 `/更正 局號:… 內容:…`（2026-11-17）：內容不填＝查這局；填了＝送出更正（跟 /回報 同一條路）。
 *
 * 回覆只有下指令的人看得到（ephemeral），跟 /回報 一樣不同步到 LINE：送出的那則（【百科回報・牌譜更正】）bot 已經
 * 直接貼到 DC 同步閒聊和 LINE 群組。貼 DC 可能要一兩秒，先 defer 免得超過 3 秒的互動時限。
 */

import { ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import { CORRECTION_OPTIONS } from '../discord/config';
import { answerCorrection } from './commands';

/** 送出的人的名字：伺服器暱稱 ＞ 顯示名稱 ＞ 使用者名稱。 */
export function discordNameOf(interaction: Pick<ChatInputCommandInteraction, 'member' | 'user'>): string {
  const member = interaction.member as { displayName?: unknown; nick?: unknown } | null;
  const fromMember = typeof member?.displayName === 'string' ? member.displayName : typeof member?.nick === 'string' ? member.nick : '';
  const user = (interaction.user ?? {}) as { globalName?: string | null; username?: string };
  return (fromMember || user.globalName || user.username || '').trim();
}

export async function handleCorrectionCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const id = (interaction.options.getString(CORRECTION_OPTIONS.ID, true) ?? '').trim();
  const content = (interaction.options.getString(CORRECTION_OPTIONS.CONTENT, false) ?? '').trim();
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const text = await answerCorrection(
    { id, content },
    { platform: 'discord', userId: interaction.user?.id, submitterName: async () => discordNameOf(interaction) },
  );
  await interaction.editReply({ content: text, allowedMentions: { parse: [] } });
}
