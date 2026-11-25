import { AttachmentBuilder, ChatInputCommandInteraction, CommandInteraction, DiscordAPIError, MessageFlags } from 'discord.js';
import { PLAY_PLATFORM_URL } from '@avalon/shared';
import { STATS_OPTIONS } from './config';
import {
  WEEKLY_CHART_CAPTION,
  chemistryReply,
  leaderboardChart,
  leaderboardChartEnabled,
  leaderboardReply,
  leaderboardScopeText,
  playerCardReply,
} from '../stats/statsQueries';
import { helpText, helpTopicOf } from '../help';
import { rolesText, rulesText } from '../rules';

/** Option name of /help (2026-11-17: /help 主題:模擬 → that topic's details). */
export const HELP_TOPIC_OPTION = '主題';

/**
 * Fallback replies of the command dispatcher (client.ts), Traditional Chinese since 2026-11-25
 * (they were 「❌ Unknown command!」 and 「❌ An error occurred while executing the command.」).
 * Fixed texts: they never echo what the person typed and never carry the error itself.
 */
export const UNKNOWN_COMMAND_TEXT = '這個指令機器人不認得（可能是舊的指令）。打 /help 看現在有哪些指令。';
export const COMMAND_ERROR_TEXT = '指令執行時出了問題，請稍後再試一次；一直不行的話請用 /回報 告訴我們。';

// ── Play platform pointer (2026-10-09) ───────────────────────────────────────

/**
 * Owner decision 2026-10-09: games are no longer hosted on this server —
 * everyone plays on signage-cloud (PLAY_PLATFORM_URL). The game-flow slash
 * commands (/create /join /start /status /vote /quest /assassinate /end) stay
 * registered so existing users get a helpful pointer, but they no longer
 * create, join or touch rooms here; they only reply with the play URL.
 */
export function buildPlayPlatformMessage(commandName: string): string {
  return [
    `🎲 對局已改到 signage-cloud，\`/${commandName}\` 不在這裡開房或操作對局了。`,
    `👉 開局、加入都在這裡：${PLAY_PLATFORM_URL}`,
  ].join('\n');
}

export async function handlePlayPlatformCommand(interaction: CommandInteraction): Promise<void> {
  await interaction.reply({
    content: buildPlayPlatformMessage(interaction.commandName),
    flags: MessageFlags.Ephemeral,
  });
}

// ── /help、/說明 ─────────────────────────────────────────────────────────────

/**
 * /help［主題］ and /說明［主題］ (bots/help.ts). Since 2026-11-25 the reply without a topic is the same
 * one-line-per-feature text LINE gets (Edward 2026-11-17：「機器人最基本的說明就是 /help 剩下可以再靠後面打
 * 指令細查」); before, Discord answered with a long half-English embed that also led with the retired
 * game-flow commands. Plain text, public, mentions off.
 */
export async function handleHelpCommand(interaction: CommandInteraction): Promise<void> {
  await interaction.deferReply();
  const options = (interaction as unknown as Partial<ChatInputCommandInteraction>).options;
  const raw = typeof options?.getString === 'function' ? options.getString(HELP_TOPIC_OPTION) : null;
  const topic = raw ? helpTopicOf(raw) : null;
  // The window /排行 ranks by, from the cache (a schemaVersion-3 cache still ranks by 各人最近 100 場).
  const scope = topic === '戰績' ? await leaderboardScopeText() : null;
  await interaction.editReply({ content: helpText(topic, 'discord', scope), allowedMentions: { parse: [] } });
}

// ── Stats lookup (2026-10-10) ────────────────────────────────────────────────

/**
 * /戰績 /排行 /默契 — public replies (not ephemeral) so the whole channel sees
 * the answer; same text as the LINE bot (bots/stats). Mentions are disabled
 * because the reply can echo what the user typed (e.g. "@everyone").
 */
async function replyStats(interaction: ChatInputCommandInteraction, build: () => Promise<string>): Promise<void> {
  await interaction.deferReply();
  const content = await build();
  await interaction.editReply({ content, allowedMentions: { parse: [] } });
}

export async function handleStatsCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const name = interaction.options.getString(STATS_OPTIONS.NAME, true);
  await replyStats(interaction, () => playerCardReply(name));
}

/**
 * /排行 (2026-11-10): the ranking chart (same image as the Monday post, titled 「排行榜」) as an
 * attachment plus the one-line caption. The PNG is rendered once per data version
 * (statsQueries.leaderboardChart). Falls back to the text when the chart is off
 * (STATS_LEADERBOARD_CHART=false), cannot be rendered, or Discord refuses the upload.
 */
export async function handleLeaderboardCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();
  if (leaderboardChartEnabled()) {
    let png: Buffer | null = null;
    try {
      png = (await leaderboardChart()).png;
    } catch (err) {
      console.error('[stats] /排行 chart failed, answering with text:', err);
    }
    if (png) {
      try {
        const file = new AttachmentBuilder(png, { name: 'ranking.png', description: '排行榜圖表' });
        await interaction.editReply({ content: WEEKLY_CHART_CAPTION, files: [file], allowedMentions: { parse: [] } });
        return;
      } catch (err) {
        if (!(err instanceof DiscordAPIError)) throw err;
        console.warn(`[stats] Discord refused the /排行 chart (${err.code}) — answering with text`);
      }
    }
  }
  const content = await leaderboardReply();
  await interaction.editReply({ content, allowedMentions: { parse: [] } });
}

export async function handleChemistryCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const a = interaction.options.getString(STATS_OPTIONS.PLAYER_A, true);
  const b = interaction.options.getString(STATS_OPTIONS.PLAYER_B, true);
  await replyStats(interaction, () => chemistryReply(a, b));
}

// ── /規則、/角色（/rules、/roles）───────────────────────────────────────────────

/**
 * /規則 = /rules and /角色 = /roles (bots/rules.ts; the Chinese names since 2026-11-25 batch 2, the English
 * ones stay registered): the 10-player rules and the seven roles, one line each, in
 * Traditional Chinese (2026-11-25). The old English embeds were wrong for this community — they said
 * Merlin cannot see Morgana, left Mordred out and ended the game on five rejections.
 */
export async function handleRulesCommand(interaction: CommandInteraction): Promise<void> {
  await interaction.deferReply();
  await interaction.editReply({ content: rulesText(), allowedMentions: { parse: [] } });
}

export async function handleRolesCommand(interaction: CommandInteraction): Promise<void> {
  await interaction.deferReply();
  await interaction.editReply({ content: rolesText(), allowedMentions: { parse: [] } });
}
