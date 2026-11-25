/**
 * Discord 斜線指令 `/每日一題`（2026-11-25）：今天的阿瓦隆每日一題（問題、牌譜連結、怎麼在這裡作答）。
 * 選項 `哪一天:昨天`（第二批）：昨天的題目和答案；不選＝今天。今天的題目不附答案。
 *
 * 公開回覆（跟 /戰績 一樣，頻道裡大家都看得到；同步頻道裡也會同步到 LINE 群）。讀題庫和 GitHub 可能要幾秒，
 * 先 defer 免得超過 3 秒的互動時限。回覆沒有任何人的名字，也不回顯使用者打的字。
 */

import { ChatInputCommandInteraction } from 'discord.js';
import { DAILY_QUESTION_OPTIONS } from '../discord/config';
import { DAILY_QUESTION_USAGE_HINT, answerDailyQuestion, dailyQuestionDayOf } from './commands';

export async function handleDailyQuestionCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();
  // 選項只有「今天」「昨天」兩個值；讀到別的（指令清單換版中的舊選項）就回用法。
  const options = (interaction as Partial<ChatInputCommandInteraction>).options;
  const raw = typeof options?.getString === 'function' ? options.getString(DAILY_QUESTION_OPTIONS.DAY) : null;
  const day = dailyQuestionDayOf(raw);
  const content = day ? await answerDailyQuestion('discord', {}, day) : DAILY_QUESTION_USAGE_HINT;
  await interaction.editReply({ content, allowedMentions: { parse: [] } });
}
