/**
 * Bot Integration Hub
 * Initializes and manages Discord and Line bots
 */

import { Express, Request, Response } from 'express';
import { initializeDiscordBot, getDiscordBot } from './discord/client';
import { initializeLineBot, getLineBot } from './line/client';

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

  // Initialize Line Bot
  if (process.env.LINE_CHANNEL_ACCESS_TOKEN) {
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
    console.warn('⚠️ LINE_CHANNEL_ACCESS_TOKEN not set, skipping Line Bot');
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
