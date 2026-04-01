import { CommandInteraction, EmbedBuilder } from 'discord.js';
import { v4 as uuidv4 } from 'uuid';
import { DISCORD_CONFIG, COMMANDS } from './config';
import { buildInviteEmbed, buildGameJoinUrl, postGameInvite } from './invite';
import { getSharedRoomManager } from '../../game/roomManagerSingleton';

/**
 * Map Discord user IDs to the room they're currently in.
 * Enables /vote and /status without requiring a room-id argument.
 */
const userRoomMap = new Map<string, string>();

// ── /help ────────────────────────────────────────────────────────────────────

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

// ── /create ──────────────────────────────────────────────────────────────────

export async function handleCreateCommand(interaction: CommandInteraction): Promise<void> {
  const roomManager = getSharedRoomManager();

  const roomId = uuidv4();
  const hostName = interaction.user.displayName || interaction.user.username;
  const hostId = `discord:${interaction.user.id}`;

  const room = roomManager.createRoom(roomId, hostName, hostId);

  // Track this user's room for future commands
  userRoomMap.set(interaction.user.id, roomId);

  const joinUrl = buildGameJoinUrl(roomId);
  const playerCount = Object.keys(room.players).length;

  const embed = buildInviteEmbed({
    roomId,
    hostName,
    playerCount,
    maxPlayers: room.maxPlayers,
    joinUrl,
  });

  await interaction.reply({ embeds: [embed] });

  // Cross-post to #同步閒聊 for visibility (non-blocking)
  postGameInvite({ roomId, hostName, playerCount, maxPlayers: room.maxPlayers }).catch((err) =>
    console.error('handleCreateCommand: failed to post to sync channel:', err)
  );
}

// ── /join ────────────────────────────────────────────────────────────────────

export async function handleJoinCommand(
  interaction: CommandInteraction,
  roomId: string
): Promise<void> {
  if (!roomId) {
    await interaction.reply({
      content: 'Please provide a room ID. Usage: `/join <room-id>`',
      ephemeral: true,
    });
    return;
  }

  const roomManager = getSharedRoomManager();
  const room = roomManager.getRoom(roomId);

  if (!room) {
    await interaction.reply({
      content: `Room \`${roomId}\` not found. Check the ID and try again.`,
      ephemeral: true,
    });
    return;
  }

  if (room.state !== 'lobby') {
    await interaction.reply({
      content: 'This game is already in progress. You can only join rooms in the lobby.',
      ephemeral: true,
    });
    return;
  }

  const playerId = `discord:${interaction.user.id}`;
  const playerName = interaction.user.displayName || interaction.user.username;

  // Already in room?
  if (room.players[playerId]) {
    await interaction.reply({
      content: 'You are already in this room.',
      ephemeral: true,
    });
    return;
  }

  // Room full?
  if (Object.keys(room.players).length >= room.maxPlayers) {
    await interaction.reply({
      content: 'This room is full.',
      ephemeral: true,
    });
    return;
  }

  // Add player
  room.players[playerId] = {
    id: playerId,
    name: playerName,
    role: null,
    team: null,
    status: 'active',
    createdAt: Date.now(),
  };
  room.updatedAt = Date.now();

  // Track this user's room
  userRoomMap.set(interaction.user.id, roomId);

  const playerCount = Object.keys(room.players).length;

  const embed = new EmbedBuilder()
    .setColor(DISCORD_CONFIG.colors.good)
    .setTitle('Joined Game')
    .addFields(
      { name: 'Game ID', value: `\`${roomId}\``, inline: true },
      { name: 'Player', value: `<@${interaction.user.id}>`, inline: true },
      { name: 'Players', value: `${playerCount} / ${room.maxPlayers}`, inline: true }
    )
    .setDescription('Waiting for host to start the game...');

  await interaction.reply({ embeds: [embed] });
}

// ── /status ──────────────────────────────────────────────────────────────────

export async function handleStatusCommand(interaction: CommandInteraction): Promise<void> {
  const roomId = userRoomMap.get(interaction.user.id);

  if (!roomId) {
    await interaction.reply({
      content: 'You are not in any game. Use `/create` or `/join` first.',
      ephemeral: true,
    });
    return;
  }

  const roomManager = getSharedRoomManager();
  const room = roomManager.getRoom(roomId);

  if (!room) {
    userRoomMap.delete(interaction.user.id);
    await interaction.reply({
      content: 'Your game room no longer exists.',
      ephemeral: true,
    });
    return;
  }

  const playerCount = Object.keys(room.players).length;
  const goodWins = room.questResults.filter((r) => r === 'success').length;
  const evilWins = room.questResults.filter((r) => r === 'fail').length;

  const embed = new EmbedBuilder()
    .setColor(DISCORD_CONFIG.colors.neutral)
    .setTitle('Game Status')
    .addFields(
      { name: 'Room', value: `\`${roomId}\``, inline: true },
      { name: 'State', value: room.state, inline: true },
      { name: 'Round', value: `${room.currentRound}/${room.maxRounds}`, inline: true },
      { name: 'Players', value: `${playerCount}/${room.maxPlayers}`, inline: true },
      { name: 'Good Wins', value: String(goodWins), inline: true },
      { name: 'Evil Wins', value: String(evilWins), inline: true }
    );

  await interaction.reply({ embeds: [embed] });
}

// ── /vote ────────────────────────────────────────────────────────────────────

export async function handleVoteCommand(
  interaction: CommandInteraction,
  vote: 'approve' | 'reject'
): Promise<void> {
  const roomId = userRoomMap.get(interaction.user.id);

  if (!roomId) {
    await interaction.reply({
      content: 'You are not in any game. Use `/join` first.',
      ephemeral: true,
    });
    return;
  }

  const roomManager = getSharedRoomManager();
  const room = roomManager.getRoom(roomId);

  if (!room) {
    userRoomMap.delete(interaction.user.id);
    await interaction.reply({
      content: 'Your game room no longer exists.',
      ephemeral: true,
    });
    return;
  }

  if (room.state !== 'voting') {
    await interaction.reply({
      content: `Cannot vote right now. Current game state: **${room.state}**`,
      ephemeral: true,
    });
    return;
  }

  const playerId = `discord:${interaction.user.id}`;

  if (!room.players[playerId]) {
    await interaction.reply({
      content: 'You are not a player in this game.',
      ephemeral: true,
    });
    return;
  }

  // Record vote in the room's vote map
  const voteValue = vote === 'approve';
  room.votes[playerId] = voteValue;
  room.updatedAt = Date.now();

  const voteEmoji = voteValue ? '✅' : '❌';
  const votedCount = Object.keys(room.votes).length;
  const totalPlayers = Object.keys(room.players).length;

  const embed = new EmbedBuilder()
    .setColor(voteValue ? DISCORD_CONFIG.colors.good : DISCORD_CONFIG.colors.evil)
    .setTitle(`${voteEmoji} Vote Recorded`)
    .setDescription(
      `You voted to **${vote.toUpperCase()}** the team proposal.\n\nVotes: ${votedCount} / ${totalPlayers}`
    )
    .setFooter({ text: 'Waiting for other players to vote...' });

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

// ── /rules ───────────────────────────────────────────────────────────────────

export async function handleRulesCommand(interaction: CommandInteraction): Promise<void> {
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

  await interaction.reply({ embeds: [embed] });
}

// ── /roles ───────────────────────────────────────────────────────────────────

export async function handleRolesCommand(interaction: CommandInteraction): Promise<void> {
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

  await interaction.reply({ embeds: [embed] });
}
