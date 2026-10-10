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
  END: 'end',
  STATUS: 'status',
  VOTE: 'vote',
  QUEST: 'quest',
  ASSASSINATE: 'assassinate',
  RULES: 'rules',
  ROLES: 'roles',
  // 2026-10-10 stats lookup (analysis_cache.json). CJK names on purpose:
  // Discord allows them (no case, 1–32 chars of \p{L}\p{N}_-), and they are
  // exactly what the LINE group types, so one syntax works on both platforms
  // and in every client locale (English names + zh-TW localizations would
  // show /stats to English-UI users while the docs and LINE say /戰績).
  // Users pick them from the "/" menu, so no IME is needed to run them.
  STATS: '戰績',
  LEADERBOARD: '排行',
  CHEMISTRY: '默契',
};

/** Option names of the stats slash commands (same CJK naming rules). */
export const STATS_OPTIONS = {
  NAME: '名字',
  PLAYER_A: '玩家1',
  PLAYER_B: '玩家2',
} as const;

/**
 * Game-flow commands that used to drive the self-hosted game. Since the
 * 2026-10-09 owner decision (games are played on signage-cloud, not on this
 * server) they stay registered — so existing users get a pointer instead of
 * "unknown command" — but only reply with the play URL.
 */
export const PLAY_PLATFORM_COMMANDS: readonly string[] = [
  COMMANDS.CREATE,
  COMMANDS.JOIN,
  COMMANDS.START,
  COMMANDS.STATUS,
  COMMANDS.VOTE,
  COMMANDS.QUEST,
  COMMANDS.ASSASSINATE,
  COMMANDS.END,
];
