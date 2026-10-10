/**
 * Bot Integration Hub
 * Initializes and manages Discord and Line bots
 */

import { Express, Request, Response } from 'express';
import { TextChannel } from 'discord.js';
import { initializeDiscordBot, getDiscordBot } from './discord/client';
import { initializeLineBot, getLineBot } from './line/client';
import { LINE_CONFIG } from './line/config';
import { LineReplyQueue } from './line/replyQueue';
import {
  ensureLineWebhookEndpoint,
  getLineWebhookState,
  isAutosetEnabled,
  recheckIntervalMs,
  resolveExpectedWebhookUrl,
  LineWebhookState,
} from './line/webhookEndpoint';
import {
  initializeChatMirror,
  getChatMirror,
  LineAdapter,
  DiscordAdapter,
  DiscordChannelAdapter,
} from './ChatMirror';
import { getKeepAliveState, KeepAliveState } from '../services/keepAlive';
import { WeeklyDigestScheduler, DigestDestination } from './stats/weeklyDigest';
import { weeklyDigestText } from './stats/statsQueries';

/** Last initialisation error per bot — surfaced on /api/bots/status. */
const initErrors: { discord: string | null; line: string | null } = {
  discord: null,
  line: null,
};

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function envFlagOff(name: string): boolean {
  const raw = (process.env[name] || '').trim().toLowerCase();
  return ['false', '0', 'off', 'no'].includes(raw);
}

export async function initializeBots(): Promise<void> {
  console.log('🤖 Initializing bots...');

  // Each bot is isolated on purpose. Until 2026-10-08 a Discord failure in
  // production rethrew out of this function, which skipped LINE *and* the
  // ChatMirror entirely — one bad token silently killed the whole sync. Now
  // every failure is logged loudly and exposed on /api/bots/status instead.

  if (process.env.DISCORD_BOT_TOKEN) {
    try {
      await initializeDiscordBot();
      initErrors.discord = null;
      console.log('✅ Discord Bot initialized');
    } catch (error) {
      initErrors.discord = errMsg(error);
      console.error('❌ Failed to initialize Discord Bot:', error);
    }
  } else {
    console.warn('⚠️ DISCORD_BOT_TOKEN not set, skipping Discord Bot');
  }

  // LINE_CONFIG already accepts both BOT_-prefixed (preferred) and legacy names.
  if (LINE_CONFIG.channelAccessToken) {
    try {
      initializeLineBot();
      initErrors.line = null;
      console.log('✅ Line Bot initialized');
    } catch (error) {
      initErrors.line = errMsg(error);
      console.error('❌ Failed to initialize Line Bot:', error);
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

type LineOutboundMode = 'listen-bot' | 'reply-drain' | 'push' | 'disabled';
let lineOutboundMode: LineOutboundMode = 'disabled';

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

  // 2026-10-08 — without a listen-bot (e.g. on Render), queue outbound LINE
  // texts and flush them on the next inbound reply_token. LINE_REPLY_DRAIN=false
  // reverts to per-message push (costs monthly quota).
  const replyDrain = !!lineGroupId && !listenBot && !envFlagOff('LINE_REPLY_DRAIN');
  const lineReplyQueue = replyDrain ? new LineReplyQueue() : undefined;

  initializeChatMirror({
    lineGroupId,
    discordChannelId,
    line: buildLineAdapter() ?? undefined,
    discord: buildDiscordAdapter(),
    listenBot,
    lineReplyQueue,
  });

  if (!lineGroupId) lineOutboundMode = 'disabled';
  else if (listenBot) lineOutboundMode = 'listen-bot';
  else if (lineReplyQueue) lineOutboundMode = 'reply-drain';
  else lineOutboundMode = 'push';

  const enabledPlatforms: string[] = [];
  if (lineGroupId) enabledPlatforms.push('LINE');
  if (discordChannelId) enabledPlatforms.push('Discord');
  if (enabledPlatforms.length > 0) {
    console.log(
      `✅ ChatMirror enabled for: ${enabledPlatforms.join(', ')} (LINE outbound via ${lineOutboundMode})`,
    );
  }
}

// ─── LINE webhook URL ownership (Layer 1) ────────────────────────────────

/**
 * Make LINE's registered webhook URL match what this deployment serves.
 * Call once AFTER the HTTP port is bound (LINE test-calls the endpoint), then
 * `startLineWebhookWatchdog()` re-checks periodically. Never throws.
 */
export async function syncLineWebhookEndpoint(opts: { test?: boolean } = {}): Promise<LineWebhookState | null> {
  const token = LINE_CONFIG.channelAccessToken;
  if (!token || !getLineBot()) return null; // LINE leg disabled — nothing to own
  const state = await ensureLineWebhookEndpoint({
    token,
    expected: resolveExpectedWebhookUrl(),
    autoset: isAutosetEnabled(),
    test: opts.test ?? true,
  });
  console.log(
    `[LINE webhook] action=${state.action} expected=${state.expected ?? '-'} actual=${state.actual ?? '-'} ` +
      `active=${state.active ?? '?'} verified=${state.verified ?? '?'}` +
      (state.lastError ? ` error=${state.lastError}` : ''),
  );
  return state;
}

export function startLineWebhookWatchdog(): void {
  const ms = recheckIntervalMs();
  if (ms <= 0 || !getLineBot()) return;
  const timer = setInterval(() => {
    void syncLineWebhookEndpoint({ test: false });
  }, ms);
  timer.unref();
}

// ─── Weekly stats digest (2026-10-10) ────────────────────────────────────

let statsDigest: WeeklyDigestScheduler | null = null;

/** Discord mirror channel: post directly (the bot's own message is never mirrored back). */
function discordDigestDestination(channelId: string): DigestDestination {
  return {
    name: 'discord',
    send: async (text): Promise<boolean | 'skip'> => {
      if (!channelId) return 'skip';
      const bot = getDiscordBot();
      if (!bot) return 'skip'; // Discord leg not configured
      if (!bot.isClientReady()) return false; // gateway not up yet — retry next tick
      const ch = await bot.getClient().channels.fetch(channelId);
      if (!ch || !(ch instanceof TextChannel)) return false;
      await ch.send({ content: text, allowedMentions: { parse: [] } });
      return true;
    },
  };
}

/** LINE mirror group: queue on the ChatMirror reply_token queue (free; sent when someone next speaks). */
function lineDigestDestination(groupId: string): DigestDestination {
  return {
    name: 'line',
    send: async (text): Promise<boolean | 'skip'> => {
      if (!groupId) return 'skip';
      const mirror = getChatMirror();
      if (!mirror) return false;
      // Never push (monthly quota): without the reply queue, LINE is skipped.
      return mirror.enqueueLineReplyText(text) ? true : 'skip';
    },
  };
}

/**
 * Every Monday 12:00 +08 post the leaderboard to the mirror channel / group.
 * STATS_DIGEST_ENABLED=false turns it off. Call once after initializeBots().
 */
export function startStatsDigest(): void {
  if (statsDigest) return;
  if (envFlagOff('STATS_DIGEST_ENABLED')) {
    console.log('ℹ️  STATS_DIGEST_ENABLED=false — weekly stats digest disabled');
    return;
  }
  const discordChannelId = (process.env.LOBBY_MIRROR_DISCORD_CHANNEL_ID || '').trim();
  const lineGroupId = (process.env.LOBBY_MIRROR_LINE_GROUP_ID || '').trim();
  if (!discordChannelId && !lineGroupId) return;
  statsDigest = new WeeklyDigestScheduler({
    buildText: (now) => weeklyDigestText(now),
    destinations: [discordDigestDestination(discordChannelId), lineDigestDestination(lineGroupId)],
  });
  statsDigest.start();
  console.log('✅ Weekly stats digest armed (Mondays 12:00–12:10 +08)');
}

// ─── Status (Layer 3) ────────────────────────────────────────────────────

export interface BotStatus {
  generatedAt: string;
  /** Render Free self-ping; if disabled on Render the Discord leg dies every 15 idle minutes. */
  keepAlive: KeepAliveState;
  /** Monday 12:00 +08 leaderboard post; lastPostedWeek is in-memory (resets on restart). */
  statsDigest: { running: boolean; lastPostedWeek: Record<string, string> };
  discord: {
    enabled: boolean;
    ready: boolean;
    error: string | null;
    mirrorChannelConfigured: boolean;
  };
  line: {
    enabled: boolean;
    ready: boolean;
    error: string | null;
    commandsEnabled: boolean;
    statsCommandsEnabled: boolean;
    mirrorGroupConfigured: boolean;
    outbound: LineOutboundMode;
    replyQueueSize: number;
    webhook: LineWebhookState;
    stats: ReturnType<NonNullable<ReturnType<typeof getLineBot>>['getWebhookStats']> | null;
  };
}

/**
 * Snapshot for /api/bots/status. Contract used by
 * .github/workflows/verify-line-webhook.yml:
 *   line.ready === true
 *   line.webhook.expected !== null && line.webhook.actual === line.webhook.expected
 *   line.webhook.active === true
 *   discord.enabled === false || discord.ready === true
 * No secrets or ids are included — only booleans, counters and our own URL.
 */
export function buildBotStatus(): BotStatus {
  const discordBot = getDiscordBot();
  const lineBot = getLineBot();
  const mirror = getChatMirror();
  return {
    generatedAt: new Date().toISOString(),
    keepAlive: getKeepAliveState(),
    statsDigest: statsDigest?.getState() ?? { running: false, lastPostedWeek: {} },
    discord: {
      enabled: !!process.env.DISCORD_BOT_TOKEN,
      ready: discordBot?.isClientReady() ?? false,
      error: initErrors.discord,
      mirrorChannelConfigured: !!(process.env.LOBBY_MIRROR_DISCORD_CHANNEL_ID || '').trim(),
    },
    line: {
      enabled: !!LINE_CONFIG.channelAccessToken,
      ready: !!lineBot,
      error: initErrors.line,
      commandsEnabled: LINE_CONFIG.commandsEnabled,
      statsCommandsEnabled: LINE_CONFIG.statsCommandsEnabled,
      mirrorGroupConfigured: !!(process.env.LOBBY_MIRROR_LINE_GROUP_ID || '').trim(),
      outbound: lineOutboundMode,
      replyQueueSize: mirror?.lineReplyQueueSize() ?? 0,
      webhook: getLineWebhookState(),
      stats: lineBot?.getWebhookStats() ?? null,
    },
  };
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
        error: initErrors.discord,
      });
    });
    console.log('📍 Discord Bot status endpoint at /api/bots/discord/status');
  }

  // Line Bot status endpoint
  if (lineBot) {
    app.get('/api/bots/line/status', (req: Request, res: Response) => {
      res.json({ status: 'ok', ...buildBotStatus().line });
    });
    console.log('📍 Line Bot status endpoint at /api/bots/line/status');
  }

  // General bot status endpoint — always registered, even when both bots are
  // off, so the CI probe can tell "disabled" from "server down".
  app.get('/api/bots/status', (req: Request, res: Response) => {
    res.json(buildBotStatus());
  });
  console.log('📍 Bot status endpoint at /api/bots/status');
}

export { getDiscordBot, initializeDiscordBot } from './discord/client';
export { getLineBot, initializeLineBot } from './line/client';
