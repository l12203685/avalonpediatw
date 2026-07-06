/**
 * Bot Integration Hub
 * Initializes and manages Discord and Line bots
 */

import { Express, Request, Response } from 'express';
import { TextChannel } from 'discord.js';
import { initializeDiscordBot, getDiscordBot } from './discord/client';
import { initializeLineBot, getLineBot } from './line/client';
import {
  initializeChatMirror,
  LineAdapter,
  DiscordAdapter,
  DiscordChannelAdapter,
} from './ChatMirror';

export async function initializeBots(): Promise<void> {
  console.log('🤖 Initializing bots...');

  // Initialize Discord Bot
  if (process.env.DISCORD_BOT_TOKEN) {
    try {
      await initializeDiscordBot();
      console.log('✅ Discord Bot initialized');
    } catch (error) {
      console.error('❌ Failed to initialize Discord Bot:', error);
      if (process.env.NODE_ENV === 'production') {
        throw error;
      }
    }
  } else {
    console.warn('⚠️ DISCORD_BOT_TOKEN not set, skipping Discord Bot');
  }

  // Initialize Line Bot — accept both BOT_-prefixed (preferred) and legacy env names
  // to stay in sync with bots/line/config.ts which already supports both.
  const lineAccessToken =
    process.env.LINE_BOT_CHANNEL_ACCESS_TOKEN ||
    process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (lineAccessToken) {
    try {
      initializeLineBot();
      console.log('✅ Line Bot initialized');
    } catch (error) {
      console.error('❌ Failed to initialize Line Bot:', error);
      if (process.env.NODE_ENV === 'production') {
        throw error;
      }
    }
  } else {
    console.warn(
      '⚠️ LINE_BOT_CHANNEL_ACCESS_TOKEN / LINE_CHANNEL_ACCESS_TOKEN not set, skipping Line Bot'
    );
  }

  // Initialize ChatMirror (#82) — wires lobby chat to LINE + Discord push.
  // Safe even when bots / env vars missing: mirror no-ops if adapters absent.
  initializeLobbyChatMirror();
}

// ─── ChatMirror wiring (#82) ──────────────────────────────────────────────

/**
 * Wrap the real LINE bot client into the ChatMirror.LineAdapter shape.
 * Returns null if the bot isn't initialized (env missing or init failed).
 */
function buildLineAdapter(): LineAdapter | null {
  const bot = getLineBot();
  if (!bot) return null;
  const client = bot.getClient();
  return {
    pushMessage: async (to, messages) =>
      // @line/bot-sdk accepts a single Message or an array; we always hand it
      // a single text object built in ChatMirror, so this signature is safe.
      (client as unknown as {
        pushMessage: (to: string, m: unknown) => Promise<unknown>;
      }).pushMessage(to, messages),
  };
}

/**
 * Wrap the discord.js client into a minimal channel-fetching adapter.
 *
 * IMPORTANT: adapter is built LAZILY — readiness + bot singleton are re-read on
 * every `fetchChannel()` call. This avoids a boot-time race where
 * `initializeLobbyChatMirror()` runs right after `initializeDiscordBot()`
 * awaits `login()` (gateway handshake) but BEFORE the Discord `ready` event
 * fires. Previously the adapter returned `null` at init time and the mirror
 * permanently dropped lobby→Discord traffic for the life of the process.
 */
function buildDiscordAdapter(): DiscordAdapter {
  return {
    fetchChannel: async (channelId): Promise<DiscordChannelAdapter | null> => {
      const bot = getDiscordBot();
      if (!bot || !bot.isClientReady()) return null;
      try {
        const ch = await bot.getClient().channels.fetch(channelId);
        if (!ch || !(ch instanceof TextChannel)) return null;
        return {
          send: async (content: string) => ch.send(content),
        };
      } catch (err) {
        console.warn(`[ChatMirror] Discord fetchChannel(${channelId}) failed:`, err);
        return null;
      }
    },
  };
}

function initializeLobbyChatMirror(): void {
  const lineGroupId = process.env.LOBBY_MIRROR_LINE_GROUP_ID || '';
  const discordChannelId = process.env.LOBBY_MIRROR_DISCORD_CHANNEL_ID || '';

  if (!lineGroupId && !discordChannelId) {
    console.log(
      'ℹ️  LOBBY_MIRROR_* env vars unset — lobby mirror outbound disabled',
    );
  }

  // 2026-04-24 — route LINE outbound through edward-listen-bot so we stop
  // burning monthly push quota. When the env var is unset we keep the
  // legacy direct-push path untouched.
  const listenBotUrl =
    (process.env.LISTEN_BOT_ENQUEUE_URL || '').trim() ||
    (process.env.LOBBY_MIRROR_LISTEN_BOT_URL || '').trim();
  const listenBot = listenBotUrl
    ? {
        url: listenBotUrl,
        apiKey: (process.env.LISTEN_BOT_PUSH_API_KEY || '').trim() || undefined,
        botKey:
          (process.env.LISTEN_BOT_KEY || '').trim() || 'avalon',
      }
    : undefined;

  initializeChatMirror({
    lineGroupId,
    discordChannelId,
    line: buildLineAdapter() ?? undefined,
    discord: buildDiscordAdapter(),
    listenBot,
  });

  const enabledPlatforms: string[] = [];
  if (lineGroupId) enabledPlatforms.push('LINE');
  if (discordChannelId) enabledPlatforms.push('Discord');
  if (enabledPlatforms.length > 0) {
    const lineMode = listenBot ? 'listen-bot enqueue' : 'direct LINE push';
    console.log(
      `✅ ChatMirror enabled for: ${enabledPlatforms.join(', ')} (LINE via ${lineMode})`,
    );
  }
}

export function registerBotRoutes(app: Express): void {
  // Line Bot webhook
  const lineBot = getLineBot();
  if (lineBot) {
    app.post('/webhook/line', async (req: Request, res: Response) => {
      await lineBot.handleWebhook(req, res);
    });
    console.log('📍 Line Bot webhook registered at /webhook/line');
  }

  // Discord Bot status endpoint
  const discordBot = getDiscordBot();
  if (discordBot) {
    app.get('/api/bots/discord/status', (req: Request, res: Response) => {
      res.json({
        status: 'ok',
        ready: discordBot.isClientReady(),
        bot: discordBot.getClient().user?.tag,
      });
    });
    console.log('📍 Discord Bot status endpoint at /api/bots/discord/status');
  }

  // Line Bot status endpoint
  if (lineBot) {
    app.get('/api/bots/line/status', (req: Request, res: Response) => {
      res.json({
        status: 'ok',
        configured: !!process.env.LINE_CHANNEL_ACCESS_TOKEN,
      });
    });
    console.log('📍 Line Bot status endpoint at /api/bots/line/status');
  }

  // General bot status endpoint
  app.get('/api/bots/status', (req: Request, res: Response) => {
    res.json({
      discord: {
        enabled: !!process.env.DISCORD_BOT_TOKEN,
        ready: discordBot?.isClientReady() || false,
      },
      line: {
        enabled: !!process.env.LINE_CHANNEL_ACCESS_TOKEN,
        configured: !!lineBot,
      },
    });
  });
  console.log('📍 Bot status endpoint at /api/bots/status');
}

export { getDiscordBot, initializeDiscordBot } from './discord/client';
export { getLineBot, initializeLineBot } from './line/client';
