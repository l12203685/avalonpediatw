/**
 * Discord 斜線指令 `/待修正`（2026-11-09）：列出 DC 牌譜區目前需要修正的牌譜和原因。
 *
 * 公開回覆（頻道裡大家都看得到誰的牌譜要改）。讀 DC 可能要幾秒，先 defer 免得超過 3 秒的互動時限。
 */

import { ChatInputCommandInteraction } from 'discord.js';
import { answerPaipuFix } from './commands';

export async function handlePaipuFixCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();
  const content = await answerPaipuFix('discord');
  await interaction.editReply({ content, allowedMentions: { parse: [] } });
}
