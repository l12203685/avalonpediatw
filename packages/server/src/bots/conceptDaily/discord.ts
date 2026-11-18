/**
 * 每日小觀念 — Discord 這一邊（2026-11-18）。開了小觀念的頻道（CONCEPT_DAILY_DISCORD_CHANNEL_IDS）裡，
 * 真人（不是 bot、不是 webhook）講話時：今天的第一則就回覆那一則附上小觀念；回覆（引用）bot 那一則小觀念、
 * 或打「觀念回饋 內容」就收成回饋並回一句確認。回覆一律不 @ 任何人。
 * bot 自己的訊息不會被同步到 LINE（mirrorInbound 略過 bot），所以鏡像頻道裡也不會在 LINE 多出一則。
 */

import { conceptDailyEnabledFor } from './config';
import { getConceptDaily, type ConceptDailyService } from './service';

/** discord.js Message 用得到的部分（測試直接給假的）。 */
export interface ConceptDiscordMessageLike {
  author: { bot: boolean; id: string };
  webhookId?: string | null;
  channelId: string;
  content: string;
  reference?: { messageId?: string | null } | null;
  reply(options: { content: string; allowedMentions: { parse: []; repliedUser: boolean } }): Promise<{ id: string } | unknown>;
}

export async function handleConceptDailyDiscord(message: ConceptDiscordMessageLike, svc: ConceptDailyService | null = getConceptDaily()): Promise<void> {
  if (!svc || message.author.bot || message.webhookId) return;
  if (!conceptDailyEnabledFor('discord', message.channelId)) return;
  const replies = await svc.handle({
    platform: 'discord',
    chatId: message.channelId,
    userId: message.author.id,
    text: message.content ?? '',
    quotedMessageId: message.reference?.messageId ?? undefined,
  }, { waitMs: 15_000 });
  for (const r of replies) {
    try {
      const sent = await message.reply({ content: r.text, allowedMentions: { parse: [], repliedUser: false } });
      const id = (sent as { id?: unknown } | null)?.id;
      r.delivered(typeof id === 'string' ? id : undefined);
    } catch (err) {
      r.failed();
      // 只寫錯誤種類：discord.js 的錯誤物件帶著要送的內容。
      console.warn(`[concept-daily] Discord reply failed (${err instanceof Error ? err.name : typeof err})`);
    }
  }
}
