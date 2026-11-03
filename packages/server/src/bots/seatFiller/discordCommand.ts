/**
 * Discord slash command `/機器人補位 房號:… [局數:…]` (2026-11-03).
 *
 * Refusals (format, limits, not configured) are ephemeral — only the person
 * who typed it needs them. A request that passes the limits is answered in
 * public, so the channel sees a bot is on its way (and nobody calls a second
 * one); a GitHub error found only after the request edits that public reply.
 */

import { ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import { SEAT_FILLER_OPTIONS } from '../discord/config';
import { getSignagePlayerDispatcher, parseSeatFillerArgs } from '../../services/signagePlayerDispatch';
import { formatSeatFillerOutcome, formatSeatFillerParseError } from './commands';

export async function handleSeatFillerCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const room = interaction.options.getString(SEAT_FILLER_OPTIONS.ROOM, true) ?? '';
  const games = interaction.options.getInteger(SEAT_FILLER_OPTIONS.GAMES, false);
  const parsed = parseSeatFillerArgs(room, games);
  if (!parsed.ok) {
    await interaction.reply({ content: formatSeatFillerParseError(parsed.error, 'discord'), flags: MessageFlags.Ephemeral });
    return;
  }
  const dispatcher = getSignagePlayerDispatcher();
  const rejected = dispatcher.check(parsed.request);
  if (rejected) {
    await interaction.reply({ content: formatSeatFillerOutcome(rejected), flags: MessageFlags.Ephemeral });
    return;
  }
  // The GitHub call can take a few seconds; defer so the 3 s interaction window never bites.
  await interaction.deferReply();
  const outcome = await dispatcher.dispatch(parsed.request);
  await interaction.editReply({ content: formatSeatFillerOutcome(outcome), allowedMentions: { parse: [] } });
}
