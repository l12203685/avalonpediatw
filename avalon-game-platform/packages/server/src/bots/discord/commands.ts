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

/**
 * Resolve the web URL for a given room, or null when the host is unresolvable.
 *
 * Wraps buildGameJoinUrl so handlers can show a human-readable error when
 * WEB_BASE_URL is missing in production instead of a broken localhost link.
 */
function resolveJoinUrl(roomId: string): { url: string | null; reason?: string } {
  try {
    return { url: buildGameJoinUrl(roomId) };
  } catch (err) {
    return {
      url: null,
      reason: err instanceof Error ? err.message : 'WEB_BASE_URL not configured',
    };
  }
}

// ── /help ────────────────────────────────────────────────────────────────────

export async function handleHelpCommand(interaction: CommandInteraction): Promise<void> {
  await interaction.deferReply();

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
        value: 'Open the web lobby so the host can start the game',
        inline: false,
      },
      {
        name: `/${COMMANDS.END}`,
        value: 'Force-end the current room (host only)',
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
        name: `/${COMMANDS.QUEST} <success|fail>`,
        value: 'Open the web game to submit your quest vote',
        inline: false,
      },
      {
        name: `/${COMMANDS.ASSASSINATE}`,
        value: 'Open the web game to submit the assassination target',
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

// ── /create ──────────────────────────────────────────────────────────────────

export async function handleCreateCommand(interaction: CommandInteraction): Promise<void> {
  await interaction.deferReply();

  const roomManager = getSharedRoomManager();

  const roomId = uuidv4();
  const hostName = interaction.user.displayName || interaction.user.username;
  const hostId = `discord:${interaction.user.id}`;

  const room = roomManager.createRoom(roomId, hostName, hostId);

  // Track this user's room for future commands
  userRoomMap.set(interaction.user.id, roomId);

  const join = resolveJoinUrl(roomId);
  if (!join.url) {
    await interaction.editReply({
      content: `❌ Could not build a web link for this room: ${join.reason ?? 'unknown error'}. Please contact the admin.`,
    });
    return;
  }
  const playerCount = Object.keys(room.players).length;

  const embed = buildInviteEmbed({
    roomId,
    hostName,
    playerCount,
    maxPlayers: room.maxPlayers,
    joinUrl: join.url,
  });

  await interaction.editReply({ embeds: [embed] });

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
  await interaction.deferReply({ ephemeral: !roomId });

  if (!roomId) {
    await interaction.editReply({
      content: 'Please provide a room ID. Usage: `/join <room-id>`',
    });
    return;
  }

  const roomManager = getSharedRoomManager();
  const room = roomManager.getRoom(roomId);

  if (!room) {
    await interaction.editReply({
      content: `Room \`${roomId}\` not found. Check the ID and try again.`,
    });
    return;
  }

  if (room.state !== 'lobby') {
    await interaction.editReply({
      content: 'This game is already in progress. You can only join rooms in the lobby.',
    });
    return;
  }

  const playerId = `discord:${interaction.user.id}`;
  const playerName = interaction.user.displayName || interaction.user.username;

  // Already in room?
  if (room.players[playerId]) {
    await interaction.editReply({
      content: 'You are already in this room.',
    });
    return;
  }

  // Room full?
  if (Object.keys(room.players).length >= room.maxPlayers) {
    await interaction.editReply({
      content: 'This room is full.',
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

  await interaction.editReply({ embeds: [embed] });
}

// ── /status ──────────────────────────────────────────────────────────────────

export async function handleStatusCommand(interaction: CommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const roomId = userRoomMap.get(interaction.user.id);

  if (!roomId) {
    await interaction.editReply({
      content: 'You are not in any game. Use `/create` or `/join` first.',
    });
    return;
  }

  const roomManager = getSharedRoomManager();
  const room = roomManager.getRoom(roomId);

  if (!room) {
    userRoomMap.delete(interaction.user.id);
    await interaction.editReply({
      content: 'Your game room no longer exists.',
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

  await interaction.editReply({ embeds: [embed] });
}

// ── /vote ────────────────────────────────────────────────────────────────────

export async function handleVoteCommand(
  interaction: CommandInteraction,
  vote: 'approve' | 'reject'
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const roomId = userRoomMap.get(interaction.user.id);

  if (!roomId) {
    await interaction.editReply({
      content: 'You are not in any game. Use `/join` first.',
    });
    return;
  }

  const roomManager = getSharedRoomManager();
  const room = roomManager.getRoom(roomId);

  if (!room) {
    userRoomMap.delete(interaction.user.id);
    await interaction.editReply({
      content: 'Your game room no longer exists.',
    });
    return;
  }

  if (room.state !== 'voting') {
    await interaction.editReply({
      content: `Cannot vote right now. Current game state: **${room.state}**`,
    });
    return;
  }

  const playerId = `discord:${interaction.user.id}`;

  if (!room.players[playerId]) {
    await interaction.editReply({
      content: 'You are not a player in this game.',
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

// ── /start ───────────────────────────────────────────────────────────────────

/**
 * /start is a lobby-level convenience command: it surfaces the web URL so
 * the host (or a joined player) can press the real start button on the web.
 *
 * The Discord bot does not drive the game engine directly — all in-game
 * actions (start, team selection, quest voting, assassination) go through
 * the Socket.IO server. This handler keeps the Discord surface honest by
 * pointing users at the web where those interactions happen.
 */
export async function handleStartCommand(interaction: CommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const roomId = userRoomMap.get(interaction.user.id);

  if (!roomId) {
    await interaction.editReply({
      content: 'You are not in any game. Use `/create` or `/join` first.',
    });
    return;
  }

  const roomManager = getSharedRoomManager();
  const room = roomManager.getRoom(roomId);

  if (!room) {
    userRoomMap.delete(interaction.user.id);
    await interaction.editReply({
      content: 'Your game room no longer exists.',
    });
    return;
  }

  if (room.state !== 'lobby') {
    await interaction.editReply({
      content: `This game is already in **${room.state}** state — no need to start it again.`,
    });
    return;
  }

  const playerCount = Object.keys(room.players).length;
  if (playerCount < 5) {
    await interaction.editReply({
      content: `Need at least 5 players to start. Currently ${playerCount}/${room.maxPlayers}. Share the room link so more players can join.`,
    });
    return;
  }

  const join = resolveJoinUrl(roomId);
  if (!join.url) {
    await interaction.editReply({
      content: `❌ Could not build a web link for this room: ${join.reason ?? 'unknown error'}. Please contact the admin.`,
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(DISCORD_CONFIG.colors.good)
    .setTitle('🎬 Ready to Start')
    .setDescription(
      `Room \`${roomId}\` has ${playerCount} players. The host presses **Start Game** on the web to begin.`
    )
    .addFields({
      name: 'Open Game',
      value: `[Click here to open the lobby](${join.url})`,
      inline: false,
    })
    .setFooter({ text: 'Only the host can press Start Game' });

  await interaction.editReply({ embeds: [embed] });
}

// ── /quest ───────────────────────────────────────────────────────────────────

/**
 * /quest acknowledges a quest-vote intent and points the user to the web
 * game. The actual success/fail submission is driven by the Socket.IO
 * handler `game:submit-quest-vote`, which requires a live socket identity.
 */
export async function handleQuestCommand(
  interaction: CommandInteraction,
  vote: 'success' | 'fail'
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const roomId = userRoomMap.get(interaction.user.id);

  if (!roomId) {
    await interaction.editReply({
      content: 'You are not in any game. Use `/join` first.',
    });
    return;
  }

  const roomManager = getSharedRoomManager();
  const room = roomManager.getRoom(roomId);

  if (!room) {
    userRoomMap.delete(interaction.user.id);
    await interaction.editReply({
      content: 'Your game room no longer exists.',
    });
    return;
  }

  if (room.state !== 'quest') {
    await interaction.editReply({
      content: `Cannot submit a quest vote right now. Current game state: **${room.state}**`,
    });
    return;
  }

  const playerId = `discord:${interaction.user.id}`;
  if (!room.players[playerId]) {
    await interaction.editReply({
      content: 'You are not a player in this game.',
    });
    return;
  }

  if (!room.questTeam.includes(playerId)) {
    await interaction.editReply({
      content: 'You are not on the current quest team — only selected members can submit a quest vote.',
    });
    return;
  }

  const join = resolveJoinUrl(roomId);
  if (!join.url) {
    await interaction.editReply({
      content: `❌ Could not build a web link for this room: ${join.reason ?? 'unknown error'}. Please contact the admin.`,
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(vote === 'success' ? DISCORD_CONFIG.colors.good : DISCORD_CONFIG.colors.evil)
    .setTitle(`⚔️ Quest Vote: ${vote.toUpperCase()}`)
    .setDescription(
      `Quest votes must be submitted on the web to protect anonymity. Open the game and press **${vote === 'success' ? 'Success' : 'Fail'}** there.`
    )
    .addFields({
      name: 'Open Game',
      value: `[Click here to submit your quest vote](${join.url})`,
      inline: false,
    })
    .setFooter({ text: 'Quest votes are anonymous — never posted in chat' });

  await interaction.editReply({ embeds: [embed] });
}

// ── /assassinate ─────────────────────────────────────────────────────────────

/**
 * /assassinate points the assassin to the web UI to pick the target. The
 * actual assassination is handled by the Socket.IO event
 * `game:assassinate` once the assassin submits the choice on the web.
 */
export async function handleAssassinateCommand(interaction: CommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const roomId = userRoomMap.get(interaction.user.id);

  if (!roomId) {
    await interaction.editReply({
      content: 'You are not in any game. Use `/join` first.',
    });
    return;
  }

  const roomManager = getSharedRoomManager();
  const room = roomManager.getRoom(roomId);

  if (!room) {
    userRoomMap.delete(interaction.user.id);
    await interaction.editReply({
      content: 'Your game room no longer exists.',
    });
    return;
  }

  if (room.state !== 'discussion') {
    await interaction.editReply({
      content: `Assassination is only available after good completes 3 quests. Current game state: **${room.state}**`,
    });
    return;
  }

  const playerId = `discord:${interaction.user.id}`;
  const self = room.players[playerId];
  if (!self) {
    await interaction.editReply({
      content: 'You are not a player in this game.',
    });
    return;
  }

  if (self.role !== 'assassin') {
    await interaction.editReply({
      content: 'Only the assassin can submit an assassination target.',
    });
    return;
  }

  const join = resolveJoinUrl(roomId);
  if (!join.url) {
    await interaction.editReply({
      content: `❌ Could not build a web link for this room: ${join.reason ?? 'unknown error'}. Please contact the admin.`,
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(DISCORD_CONFIG.colors.evil)
    .setTitle('🗡️ Assassination Phase')
    .setDescription(
      'As the assassin, you must pick the target on the web. Click below to open the game and submit your choice.'
    )
    .addFields({
      name: 'Open Game',
      value: `[Click here to pick the assassination target](${join.url})`,
      inline: false,
    })
    .setFooter({ text: 'If the target is Merlin, evil wins' });

  await interaction.editReply({ embeds: [embed] });
}

// ── /end ─────────────────────────────────────────────────────────────────────

/**
 * /end lets the room host force-end the current room from Discord. Only the
 * player who created the room (`room.host`) may invoke this command; all
 * other players receive a host-only error. The handler:
 *
 *   1. Looks up the caller's active room via userRoomMap.
 *   2. Verifies the caller is the host.
 *   3. Marks the room as ended (`state='ended'`, `evilWins=null` if still
 *      mid-game — treat as a host cancellation rather than a win) so any
 *      live socket clients receive a clean state transition, then removes
 *      the room from RoomManager.
 *   4. Clears every tracked player's userRoomMap entry so subsequent
 *      `/status` / `/vote` / `/quest` calls from other players return the
 *      "not in a game" path instead of a dangling room reference.
 *
 * We intentionally do NOT call GameEngine.cleanup() here because the bot
 * package does not hold a reference to the engine — that lives in
 * GameServer. Deleting the room from RoomManager + broadcasting state is
 * enough for the bot's own commands; GameServer's own cleanup sweeper
 * clears orphan engine references every 10 minutes.
 */
export async function handleEndCommand(interaction: CommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const roomId = userRoomMap.get(interaction.user.id);

  if (!roomId) {
    await interaction.editReply({
      content: 'You are not in any game. Use `/create` or `/join` first.',
    });
    return;
  }

  const roomManager = getSharedRoomManager();
  const room = roomManager.getRoom(roomId);

  if (!room) {
    userRoomMap.delete(interaction.user.id);
    await interaction.editReply({
      content: 'Your game room no longer exists.',
    });
    return;
  }

  const callerId = `discord:${interaction.user.id}`;
  if (room.host !== callerId) {
    await interaction.editReply({
      content: 'Only the room host can end the game. Ask the host to run `/end`.',
    });
    return;
  }

  // Snapshot player IDs BEFORE deletion so we can clear every userRoomMap entry.
  const affectedPlayerIds = Object.keys(room.players);

  // Mark room as ended (so any listening socket gets a clean transition),
  // then delete it. Room.evilWins stays null because this is a host
  // cancellation, not a game outcome — downstream stats/ELO code checks
  // `room.endReason` and should treat 'host_cancelled' as a non-counting end.
  room.state = 'ended';
  room.endReason = 'host_cancelled';
  room.evilWins = null;
  room.updatedAt = Date.now();

  roomManager.deleteRoom(roomId);

  // Clear every affected player's userRoomMap entry (strip 'discord:' prefix
  // to match the Discord user ID the Map is keyed on).
  for (const pid of affectedPlayerIds) {
    if (pid.startsWith('discord:')) {
      userRoomMap.delete(pid.slice('discord:'.length));
    }
  }

  const embed = new EmbedBuilder()
    .setColor(DISCORD_CONFIG.colors.neutral)
    .setTitle('🛑 Room Ended')
    .setDescription(
      `Room \`${roomId}\` has been force-ended by the host. ${affectedPlayerIds.length} player(s) have been released.`
    )
    .setFooter({ text: 'Use /create to start a new game.' });

  await interaction.editReply({ embeds: [embed] });
}

/**
 * Testing helper: clear the in-memory user→room map so each test starts
 * from a clean slate. NOT exported via the public index; unit tests import
 * it directly.
 */
export function __resetUserRoomMapForTest(): void {
  userRoomMap.clear();
}

/**
 * Testing helper: force-set a user→room mapping so tests can exercise
 * handlers that normally rely on prior /create or /join calls.
 */
export function __setUserRoomForTest(discordUserId: string, roomId: string): void {
  userRoomMap.set(discordUserId, roomId);
}
