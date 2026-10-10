import { CommandInteraction, EmbedBuilder, MessageFlags } from 'discord.js';
import { PLAY_PLATFORM_URL } from '@avalon/shared';
import { DISCORD_CONFIG, COMMANDS, PLAY_PLATFORM_COMMANDS } from './config';

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
    `🎲 對局已改到 signage-cloud 進行，\`/${commandName}\` 不再在本站開房或操作對局。`,
    `👉 前往 signage-cloud 開局：${PLAY_PLATFORM_URL}`,
    'Games are now played on signage-cloud — open the link above to create or join a game.',
  ].join('\n');
}

export async function handlePlayPlatformCommand(interaction: CommandInteraction): Promise<void> {
  await interaction.reply({
    content: buildPlayPlatformMessage(interaction.commandName),
    flags: MessageFlags.Ephemeral,
  });
}

// ── /help ────────────────────────────────────────────────────────────────────

export async function handleHelpCommand(interaction: CommandInteraction): Promise<void> {
  await interaction.deferReply();

  const embed = new EmbedBuilder()
    .setColor(DISCORD_CONFIG.colors.neutral)
    .setTitle('🎭 Avalon Bot Help')
    .setDescription(
      `對局已改到 signage-cloud 進行 — Games are now played on signage-cloud:\n${PLAY_PLATFORM_URL}`
    )
    .addFields(
      {
        name: '🎲 開局 / Play',
        value:
          `${PLAY_PLATFORM_COMMANDS.map((name) => `/${name}`).join(' ')}\n` +
          '只會回覆 signage-cloud 開局連結，不再在本站開房。\n' +
          'These commands now just reply with the signage-cloud link.',
        inline: false,
      },
      {
        name: `/${COMMANDS.RULES}`,
        value: 'Display game rules',
        inline: false,
      },
      {
        name: `/${COMMANDS.ROLES}`,
        value: 'Display role descriptions',
        inline: false,
      }
    )
    .setFooter({ text: 'Use /help to see all commands' });

  await interaction.editReply({ embeds: [embed] });
}

// ── /rules ───────────────────────────────────────────────────────────────────

export async function handleRulesCommand(interaction: CommandInteraction): Promise<void> {
  await interaction.deferReply();

  const embed = new EmbedBuilder()
    .setColor(DISCORD_CONFIG.colors.neutral)
    .setTitle('Avalon Game Rules')
    .addFields(
      {
        name: 'Objective',
        value:
          '**Good Team**: Complete 3 successful quests\n**Evil Team**: Complete 3 failed quests or assassinate Merlin',
        inline: false,
      },
      {
        name: 'Roles',
        value:
          '**Good**: Merlin, Percival, Loyal Servants\n**Evil**: Assassin, Morgana, Oberon (optional)',
        inline: false,
      },
      {
        name: 'Voting Phase',
        value:
          'All players vote to approve/reject the proposed team. Majority rules. 5 rejections = evil wins.',
        inline: false,
      },
      {
        name: 'Quest Phase',
        value:
          'Selected players choose success/fail. Even 1 fail fails the quest. Good needs 3 wins.',
        inline: false,
      },
      {
        name: 'Assassination',
        value: 'If good wins 3 quests, assassin tries to identify and kill Merlin.',
        inline: false,
      }
    )
    .setFooter({ text: 'Use /roles for detailed role information' });

  await interaction.editReply({ embeds: [embed] });
}

// ── /roles ───────────────────────────────────────────────────────────────────

export async function handleRolesCommand(interaction: CommandInteraction): Promise<void> {
  await interaction.deferReply();

  const embed = new EmbedBuilder()
    .setColor(DISCORD_CONFIG.colors.neutral)
    .setTitle('Avalon Roles')
    .addFields(
      {
        name: 'Merlin (Good)',
        value: 'Knows all evil players (except Morgana). Must hide identity.',
        inline: true,
      },
      {
        name: 'Percival (Good)',
        value: 'Knows who Merlin and Morgana are, but not which is which.',
        inline: true,
      },
      {
        name: 'Loyal Servants (Good)',
        value: 'Regular good players. No special information.',
        inline: true,
      },
      {
        name: 'Assassin (Evil)',
        value: 'Can assassinate a player in the final phase. Kills Merlin = evil wins.',
        inline: true,
      },
      {
        name: 'Morgana (Evil)',
        value: 'Evil team member. Appears as Merlin to Percival. Merlin cannot see her.',
        inline: true,
      },
      {
        name: 'Oberon (Evil)',
        value: 'Evil player unknown to other evil members. Unique challenge.',
        inline: true,
      }
    )
    .setFooter({ text: 'Use /rules for complete game rules' });

  await interaction.editReply({ embeds: [embed] });
}
