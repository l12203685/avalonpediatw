/**
 * Discord slash command /社群週報 (admins only, 2026-10-13).
 *
 * Summarizes the last 7 days now and delivers the digest to the private
 * admin channel and the sheet, exactly like the Monday run. The reply is
 * ephemeral and carries status only (counts, destinations, errors) — never
 * the summary or any chat text. Registered with ManageGuild as the default
 * member permission and re-checked here; not listed in /help.
 */

import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import { NO_PUBLIC_CHANNELS_TEXT, summaryOutcomeText } from './format';
import { getCommunityDigestService, type DigestRunReport } from './service';
import { estimateCostUsd, type SummaryOutcome } from './summarizer';
import { formatPeriod } from './window';

export const COMMUNITY_DIGEST_NOT_ALLOWED_TEXT = '只有伺服器管理者可以使用 /社群週報。';
export const COMMUNITY_DIGEST_NOT_READY_TEXT = '社群週報功能還沒啟動，請稍後再試。';

const SUMMARY_OUTCOMES: readonly string[] = [
  'ok',
  'truncated',
  'refused',
  'empty',
  'no-api-key',
  'auth-error',
  'permission-error',
  'rate-limited',
  'bad-request',
  'api-error',
  'connection-error',
  'error',
];

function n(x: number): string {
  return x.toLocaleString('en-US');
}

/** The ephemeral status reply. Counts and fixed phrases only. */
export function formatRunReport(r: DigestRunReport): string {
  switch (r.outcome) {
    case 'disabled':
      return '社群週報目前關閉（沒有設定 ANTHROPIC_API_KEY，或 COMMUNITY_DIGEST_ENABLED=false）。';
    case 'busy':
      return '社群週報正在產生中，請幾分鐘後再試。';
    case 'cooldown':
      return '剛剛才手動產生過，請 5 分鐘後再試。';
    case 'discord-not-ready':
      return 'Discord 還沒完全連上，請稍後再試。';
    default:
      break;
  }
  const lines = [`社群週報（手動，最近 7 天：${formatPeriod(r.window)}）`];
  if (r.outcome === 'no-destination') {
    lines.push('沒有可以送出的地方，所以沒有產生摘要：');
  } else {
    lines.push(
      `- 讀取：${r.channelsRead} 個頻道，收錄 ${n(r.included)} 則訊息（${r.channels} 個頻道有訊息）；` +
        `因篇幅省略 ${n(r.omitted)} 則；略過機器人、指令、空白等 ${n(r.skipped)} 則`,
    );
    if (r.truncatedChannels > 0) lines.push(`- 有 ${r.truncatedChannels} 個頻道訊息太多，最早的一部分沒有讀取`);
    if (r.failedChannels > 0) lines.push(`- 有 ${r.failedChannels} 個頻道讀取失敗`);
    if (r.noPublicChannels) lines.push(`- ${NO_PUBLIC_CHANNELS_TEXT}`);
    if (r.outcome === 'no-messages') {
      lines.push('- 摘要：沒有訊息可以彙整（沒有呼叫 AI）');
    } else if (SUMMARY_OUTCOMES.includes(r.outcome)) {
      const usage =
        r.inputTokens + r.outputTokens > 0
          ? `；輸入 ${n(r.inputTokens)}／輸出 ${n(r.outputTokens)} tokens，約 US$${estimateCostUsd(r.inputTokens, r.outputTokens).toFixed(2)}`
          : '';
      lines.push(`- 摘要：${summaryOutcomeText(r.outcome as SummaryOutcome)}${r.model ? `（${r.model}）` : ''}${usage}`);
    }
  }
  lines.push(`- 管理者頻道：${r.discord.detail}`);
  lines.push(`- Google 試算表：${r.sheet.detail}`);
  return lines.join('\n');
}

export async function handleCommunityDigestCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inGuild() || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({ content: COMMUNITY_DIGEST_NOT_ALLOWED_TEXT, flags: MessageFlags.Ephemeral });
    return;
  }
  const service = getCommunityDigestService();
  if (!service) {
    await interaction.reply({ content: COMMUNITY_DIGEST_NOT_READY_TEXT, flags: MessageFlags.Ephemeral });
    return;
  }
  // Collecting + one API call can take minutes; a deferred reply stays editable for 15 minutes.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const report = await service.runManual();
  await interaction.editReply({ content: formatRunReport(report), allowedMentions: { parse: [] } });
}
