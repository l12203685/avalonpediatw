/**
 * Line Bot Configuration
 */

export const LINE_CONFIG = {
  // Channel access token
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',

  // Channel secret (for signature verification)
  channelSecret: process.env.LINE_CHANNEL_SECRET || '',

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
  userId: process.env.LINE_USER_ID || '',

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
