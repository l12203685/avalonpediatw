/**
 * Discord Bot Configuration
 */

export const DISCORD_CONFIG = {
  // Bot Token (從環境變數)
  token: process.env.DISCORD_BOT_TOKEN || '',

  // Client ID
  clientId: process.env.DISCORD_CLIENT_ID || '',

  // Guild ID (for testing)
  guildId: process.env.DISCORD_GUILD_ID || '',

  // Channel IDs
  channels: {
    // #同步閒聊 — game results and invite announcements
    syncChat: process.env.DISCORD_SYNC_CHANNEL_ID || '1132901301802504242',
  },

  // Web platform base URL for invite links
  webBaseUrl: process.env.WEB_BASE_URL || 'http://localhost:3000',

  // Command prefix
  prefix: '!avalon',

  // Embed colors
  colors: {
    good: 0x00ff00, // Green - Good team
    evil: 0xff0000, // Red - Evil team
    neutral: 0xffff00, // Yellow - Neutral/Info
    error: 0xff6b6b, // Light Red - Errors
  },

  // Timeouts (in milliseconds)
  timeouts: {
    voteTimeout: 30000, // 30 seconds for voting
    questTimeout: 60000, // 1 minute for quest
    discussionTimeout: 120000, // 2 minutes for discussion
  },

  // Game status rotation
  statuses: [
    { name: 'Avalon | /help', type: 'PLAYING' },
    { name: 'Resistance Games', type: 'WATCHING' },
    { name: 'Discord Servers', type: 'LISTENING' },
  ],
};

export const COMMANDS = {
  HELP: 'help',
  CREATE: 'create',
  JOIN: 'join',
  START: 'start',
  STATUS: 'status',
  VOTE: 'vote',
  QUEST: 'quest',
  ASSASSINATE: 'assassinate',
  RULES: 'rules',
  ROLES: 'roles',
};
