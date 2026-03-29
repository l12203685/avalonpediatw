/**
 * Line Bot Configuration
 */

export const LINE_CONFIG = {
  // Channel access token (prefer new BOT_ prefix; fall back to legacy name)
  channelAccessToken:
    process.env.LINE_BOT_CHANNEL_ACCESS_TOKEN ||
    process.env.LINE_CHANNEL_ACCESS_TOKEN ||
    '',

  // Channel secret (prefer new BOT_ prefix; fall back to legacy name)
  channelSecret:
    process.env.LINE_BOT_CHANNEL_SECRET ||
    process.env.LINE_CHANNEL_SECRET ||
    '',

  // LINE Notify OAuth credentials (for push notifications via LINE Notify API)
  notifyClientId:     process.env.LINE_NOTIFY_CLIENT_ID     || '',
  notifyClientSecret: process.env.LINE_NOTIFY_CLIENT_SECRET || '',

  // Webhook endpoint
  webhookPath: '/webhook/line',

  // Message types
  messageTypes: {
    TEXT: 'text',
    IMAGE: 'image',
    VIDEO: 'video',
    AUDIO: 'audio',
    FILE: 'file',
    LOCATION: 'location',
    STICKER: 'sticker',
    TEMPLATE: 'template',
    FLEX: 'flex',
  },

  // User IDs
  groupId: process.env.LINE_GROUP_ID || '',
  userId:  process.env.LINE_USER_ID  || '',

  // Commands
  commands: {
    HELP: 'help',
    CREATE: 'create',
    JOIN: 'join',
    STATUS: 'status',
    VOTE: 'vote',
    RULES: 'rules',
    ROLES: 'roles',
  },
};

export const LINE_QUICK_REPLY_ACTIONS = {
  HELP: 'help',
  CREATE: 'create',
  RULES: 'rules',
  ROLES: 'roles',
};
