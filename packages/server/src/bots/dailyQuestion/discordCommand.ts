/**
 * Discord 斜線指令 `/每日一題`（2026-11-25）：今天的阿瓦隆每日一題（問題、牌譜連結、怎麼在這裡作答）。
 *
 * 公開回覆（跟 /戰績 一樣，頻道裡大家都看得到；同步頻道裡也會同步到 LINE 群）。讀題庫和 GitHub 可能要幾秒，
 * 先 defer 免得超過 3 秒的互動時限。回覆沒有任何人的名字，也不回顯使用者打的字。
 */

import { ChatInputCommandInteraction } from 'discord.js';
import { answerDailyQuestion } from './commands';

export async function handleDailyQuestionCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();
  const content = await answerDailyQuestion('discord');
  await interaction.editReply({ content, allowedMentions: { parse: [] } });
}
