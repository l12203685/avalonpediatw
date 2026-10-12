/**
 * Discord slash command `/意見 內容:…` (2026-10-12).
 *
 * Lives here (not in discord/commands.ts) because the command is owned by
 * the feedback module. The acknowledgement is ephemeral: the opinion itself
 * reaches the owner through the forwarded channel post, so the channel is
 * not spammed twice.
 */

import { ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import { FEEDBACK_OPTIONS } from '../discord/config';
import { FEEDBACK_CONFIG, FEEDBACK_DISABLED_TEXT } from './config';
import { getFeedbackService } from './service';

export async function handleFeedbackCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!FEEDBACK_CONFIG.commandEnabled) {
    await interaction.reply({ content: FEEDBACK_DISABLED_TEXT, flags: MessageFlags.Ephemeral });
    return;
  }
  const content = interaction.options.getString(FEEDBACK_OPTIONS.CONTENT, true) ?? '';
  // Forwarding needs a channel fetch + send; defer so the 3 s interaction window never bites.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const result = await getFeedbackService().submit('discord', content);
  // The forward runs detached from the reply (LINE cannot wait for it). Here
  // the interaction is deferred (15 min), so waiting keeps the 📮 post ahead
  // of the ack; the ack text is the same either way and `forwarded` never rejects.
  await result.forwarded;
  await interaction.editReply({ content: result.reply, allowedMentions: { parse: [] } });
}
