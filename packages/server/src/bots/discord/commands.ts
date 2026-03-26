import { CommandInteraction, EmbedBuilder, ChannelType } from 'discord.js';
import { DISCORD_CONFIG, COMMANDS } from './config';

/**
 * Discord Command Handlers
 */

export async function handleHelpCommand(interaction: CommandInteraction): Promise<void> {
  const embed = new EmbedBuilder()
    .setColor(DISCORD_CONFIG.colors.neutral)
    .setTitle('🎭 Avalon Bot Help')
    .setDescription('Complete guide to Avalon Discord Bot commands')
    .addFields(
      {
        name: `/${COMMANDS.CREATE}`,
        value: 'Create a new Avalon game in this channel',
        inline: false,
      },
      {
        name: `/${COMMANDS.JOIN} <room-id>`,
        value: 'Join an existing game room',
        inline: false,
      },
      {
        name: `/${COMMANDS.START}`,
        value: 'Start the game (host only)',
        inline: false,
      },
      {
        name: `/${COMMANDS.STATUS}`,
        value: 'Check current game status',
        inline: false,
      },
      {
        name: `/${COMMANDS.VOTE} <approve|reject>`,
        value: 'Vote on team proposal',
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

  await interaction.reply({ embeds: [embed] });
}

export async function handleCreateCommand(interaction: CommandInteraction): Promise<void> {
  const gameId = `discord-${interaction.guildId}-${Date.now()}`;

  const embed = new EmbedBuilder()
    .setColor(DISCORD_CONFIG.colors.neutral)
    .setTitle('🎭 New Game Created')
    .addFields(
      { name: 'Game ID', value: gameId, inline: true },
      { name: 'Host', value: `<@${interaction.user.id}>`, inline: true },
      { name: 'Max Players', value: '10', inline: true },
      { name: 'Status', value: '⏳ Waiting for players', inline: false },
      {
        name: 'How to Join',
        value: `Others can join using:\n\`/${COMMANDS.JOIN} ${gameId}\``,
        inline: false,
      }
    )
    .setFooter({ text: 'Use /start when ready to begin!' });

  await interaction.reply({ embeds: [embed] });
}

export async function handleJoinCommand(
  interaction: CommandInteraction,
  roomId: string
): Promise<void> {
  const embed = new EmbedBuilder()
    .setColor(DISCORD_CONFIG.colors.good)
    .setTitle('✅ Joined Game')
    .addFields(
      { name: 'Game ID', value: roomId, inline: true },
      { name: 'Player', value: `<@${interaction.user.id}>`, inline: true },
      { name: 'Status', value: '✅ Ready', inline: true }
    )
    .setDescription('Waiting for host to start the game...');

  await interaction.reply({ embeds: [embed] });
}

export async function handleStatusCommand(interaction: CommandInteraction): Promise<void> {
  const embed = new EmbedBuilder()
    .setColor(DISCORD_CONFIG.colors.neutral)
    .setTitle('📊 Game Status')
    .addFields(
      { name: 'Round', value: '1/5', inline: true },
      { name: 'State', value: 'Voting', inline: true },
      { name: 'Players', value: '5/10', inline: true },
      { name: 'Good Team', value: '3', inline: true },
      { name: 'Evil Team', value: '2', inline: true },
      { name: 'Quests Won', value: '0', inline: true }
    );

  await interaction.reply({ embeds: [embed] });
}

export async function handleVoteCommand(
  interaction: CommandInteraction,
  vote: 'approve' | 'reject'
): Promise<void> {
  const voteEmoji = vote === 'approve' ? '✅' : '❌';
  const embed = new EmbedBuilder()
    .setColor(vote === 'approve' ? DISCORD_CONFIG.colors.good : DISCORD_CONFIG.colors.evil)
    .setTitle(`${voteEmoji} Vote Recorded`)
    .setDescription(
      `You voted to **${vote.toUpperCase()}** the team proposal.\n\nWaiting for other players to vote...`
    )
    .setFooter({ text: 'Vote timeout: 30 seconds' });

  await interaction.reply({ embeds: [embed] });
}

export async function handleRulesCommand(interaction: CommandInteraction): Promise<void> {
  const embed = new EmbedBuilder()
    .setColor(DISCORD_CONFIG.colors.neutral)
    .setTitle('📋 Avalon Game Rules')
    .addFields(
      {
        name: '🎯 Objective',
        value:
          '**Good Team**: Complete 3 successful quests\n**Evil Team**: Complete 3 failed quests or assassinate Merlin',
        inline: false,
      },
      {
        name: '👥 Roles',
        value:
          '**Good**: Merlin, Percival, Loyal Servants\n**Evil**: Assassin, Morgana, Oberon (optional)',
        inline: false,
      },
      {
        name: '🗳️ Voting Phase',
        value:
          'All players vote to approve/reject the proposed team. Majority rules. 5 rejections = evil wins.',
        inline: false,
      },
      {
        name: '⚔️ Quest Phase',
        value:
          'Selected players choose success/fail. Even 1 fail fails the quest. Good needs 3 wins.',
        inline: false,
      },
      {
        name: '🗡️ Assassination',
        value: 'If good wins 3 quests, assassin tries to identify and kill Merlin.',
        inline: false,
      }
    )
    .setFooter({ text: 'Use /roles for detailed role information' });

  await interaction.reply({ embeds: [embed] });
}

export async function handleRolesCommand(interaction: CommandInteraction): Promise<void> {
  const embed = new EmbedBuilder()
    .setColor(DISCORD_CONFIG.colors.neutral)
    .setTitle('👥 Avalon Roles')
    .addFields(
      {
        name: '🟦 Merlin (Good)',
        value: 'Knows all evil players (except Morgana). Must hide identity.',
        inline: true,
      },
      {
        name: '🟦 Percival (Good)',
        value: 'Knows who Merlin and Morgana are, but not which is which.',
        inline: true,
      },
      {
        name: '🟦 Loyal Servants (Good)',
        value: 'Regular good players. No special information.',
        inline: true,
      },
      {
        name: '🟥 Assassin (Evil)',
        value: 'Can assassinate a player in the final phase. Kills Merlin = evil wins.',
        inline: true,
      },
      {
        name: '🟥 Morgana (Evil)',
        value: 'Evil team member. Appears as Merlin to Percival. Merlin cannot see her.',
        inline: true,
      },
      {
        name: '🟥 Oberon (Evil)',
        value: 'Evil player unknown to other evil members. Unique challenge.',
        inline: true,
      }
    )
    .setFooter({ text: 'Use /rules for complete game rules' });

  await interaction.reply({ embeds: [embed] });
}
