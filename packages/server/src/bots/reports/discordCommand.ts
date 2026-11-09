/**
 * Discord 斜線指令 `/回報 類型:… 內容:…`、`/認領 主id:… 其他id:…`（2026-11-09）。
 *
 * 回覆只有下指令的人看得到（ephemeral）：大家要看的那則（【百科回報…】／【ID認領】）bot 已經直接貼到 DC 同步閒聊
 * 和 LINE 群組。貼 DC 可能要一兩秒，先 defer 免得超過 3 秒的互動時限。
 */

import { ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import { CLAIM_OPTIONS, REPORT_OPTIONS } from '../discord/config';
import { answerClaim, answerReport, kindOf, splitClaimNames } from './commands';

export async function handleReportCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const kind = kindOf(interaction.options.getString(REPORT_OPTIONS.KIND, false)) ?? 'bug';
  const content = interaction.options.getString(REPORT_OPTIONS.CONTENT, true) ?? '';
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const text = await answerReport(kind, content, { platform: 'discord', userId: interaction.user?.id });
  await interaction.editReply({ content: text, allowedMentions: { parse: [] } });
}

export async function handleClaimCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const main = interaction.options.getString(CLAIM_OPTIONS.MAIN, true) ?? '';
  const others = interaction.options.getString(CLAIM_OPTIONS.OTHERS, true) ?? '';
  // 主 ID 整格就是一個名字（可以有空白）；其他 ID 照 LINE 的規則拆。
  const names = main.trim() ? [main.trim(), ...splitClaimNames(others)] : [];
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const text = await answerClaim(names, { platform: 'discord', userId: interaction.user?.id });
  await interaction.editReply({ content: text, allowedMentions: { parse: [] } });
}
