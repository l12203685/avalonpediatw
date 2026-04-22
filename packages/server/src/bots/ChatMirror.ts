/**
 * ChatMirror — #82 大廳聊天跨平台雙向同步核心模組
 *
 * Responsibility:
 *   Take lobby-origin chat messages (#63 `LobbyChatBuffer`) and fan them out
 *   to a designated LINE group and Discord channel. Inbound webhooks from
 *   LINE/Discord (Phase B, not in this pass) feed back into the lobby buffer
 *   via `ingestInbound()` — those messages carry `source: 'line' | 'discord'`
 *   so `fanout()` can suppress them and avoid the lobby → LINE → lobby loop.
 *
 * Design decisions:
 *   - Env-gated: if `LOBBY_MIRROR_LINE_GROUP_ID` / `LOBBY_MIRROR_DISCORD_CHANNEL_ID`
 *     are unset, the corresponding outbound is a no-op. Boot never fails.
 *   - Fire-and-forget: `fanout()` swallows per-platform errors (logged) and
 *     never throws into the socket hot path. A failed push to LINE cannot
 *     break the lobby emit for other clients.
 *   - Loop safety: only `source === 'lobby'` (or undefined, treated as lobby)
 *     is mirrored outward. Messages with source `'line'` / `'discord'`
 *     short-circuit at the top of `fanout()`.
 *   - Rate limit: per-platform userId, reuses the existing `SocketRateLimiter`
 *     so behaviour matches the rest of the server.
 *   - Adapter-based: `LineAdapter` and `DiscordAdapter` interfaces let unit
 *     tests inject mocks, and let Phase B swap in real clients without
 *     touching this module's contract.
 *
 * Out of scope in this pass (Phase B, separate task batch):
 *   - LINE webhook parsing for group messages
 *   - Discord `messageCreate` listener
 *   - Identity mapping with #42 account linking
 */

import {
  LobbyChatMessage,
  LobbyChatSource,
  LOBBY_CHAT_MAX_LEN,
} from '../socket/LobbyChatBuffer';
import { SocketRateLimiter } from '../middleware/rateLimit';

// ─── Adapter contracts ───────────────────────────────────────────────────

/** Minimal surface of a LINE push client — matches @line/bot-sdk's Client. */
export interface LineAdapter {
  pushMessage(to: string, messages: unknown): Promise<unknown>;
}

/**
 * Minimal surface of a Discord channel-send target. Deliberately narrow —
 * we only need `send(content)` so tests can mock without pulling discord.js.
 */
export interface DiscordChannelAdapter {
  send(content: string): Promise<unknown>;
}

export interface DiscordAdapter {
  /** Resolve a channel by id; return null if not found / not a text channel. */
  fetchChannel(channelId: string): Promise<DiscordChannelAdapter | null>;
}

// ─── Formatting ──────────────────────────────────────────────────────────

/** Max characters in a single outbound line — well below LINE's 5000/Discord 2000. */
const OUTBOUND_TRUNCATE_AT = LOBBY_CHAT_MAX_LEN;

/** Prefix tag identifying the source room when mirrored out. */
const OUTBOUND_PREFIX = '[Avalon]';

/**
 * Render a lobby message into the one-liner that gets mirrored out:
 *   `[Avalon] {name}: {text}`
 *
 * Guest names already arrive in `Guest_###` shape from the client (#81),
 * so no extra transformation is needed here. System notices render the
 * message alone (no speaker prefix) so "Alice 加入大廳" stays readable.
 */
export function formatOutgoing(msg: LobbyChatMessage): string {
  const body = (msg.message ?? '').slice(0, OUTBOUND_TRUNCATE_AT);
  if (msg.isSystem) {
    return `${OUTBOUND_PREFIX} ${body}`;
  }
  const name = (msg.playerName ?? 'Unknown').trim() || 'Unknown';
  return `${OUTBOUND_PREFIX} ${name}: ${body}`;
}

// ─── Config surface ──────────────────────────────────────────────────────

export interface ChatMirrorConfig {
  /**
   * LINE group id to push lobby messages to. Omit (or leave empty string)
   * to disable outbound LINE mirror.
   */
  lineGroupId?: string;
  /**
   * Discord channel id to push lobby messages to. Omit to disable outbound
   * Discord mirror.
   */
  discordChannelId?: string;
  /** Injected LINE push client; required if `lineGroupId` is set. */
  line?: LineAdapter;
  /** Injected Discord client wrapper; required if `discordChannelId` is set. */
  discord?: DiscordAdapter;
  /**
   * Rate limit per platform-user per window. Defaults to 5 msgs / 60s to
   * keep spam bots from flooding the channel while staying generous for
   * real chatter. Only applied on inbound, since lobby-side is already
   * rate-limited upstream by the lobbyChatLimiter in GameServer.
   */
  inboundRateLimit?: {
    windowMs: number;
    maxRequests: number;
  };
  /** Optional logger for observability; defaults to console. */
  logger?: {
    warn: (msg: string) => void;
    error: (msg: string, err?: unknown) => void;
    info?: (msg: string) => void;
  };
}

/**
 * Appended-to-lobby callback — injected from GameServer so inbound messages
 * can land in the ring buffer + fire the standard `lobby:message-received`
 * socket event. Keeps ChatMirror decoupled from Socket.IO.
 */
export type LobbyIngestFn = (msg: LobbyChatMessage) => void;

// ─── Core class ──────────────────────────────────────────────────────────

export class ChatMirror {
  private readonly lineGroupId: string;
  private readonly discordChannelId: string;
  private readonly line?: LineAdapter;
  private readonly discord?: DiscordAdapter;
  private readonly inboundLimiter: SocketRateLimiter;
  private readonly logger: Required<ChatMirrorConfig>['logger'];
  private lobbyIngest: LobbyIngestFn | null = null;

  constructor(config: ChatMirrorConfig = {}) {
    this.lineGroupId = (config.lineGroupId ?? '').trim();
    this.discordChannelId = (config.discordChannelId ?? '').trim();
    this.line = config.line;
    this.discord = config.discord;

    const rl = config.inboundRateLimit ?? { windowMs: 60_000, maxRequests: 5 };
    this.inboundLimiter = new SocketRateLimiter({
      windowMs: rl.windowMs,
      maxRequests: rl.maxRequests,
    });

    this.logger = {
      warn: config.logger?.warn ?? ((m) => console.warn(`[ChatMirror] ${m}`)),
      error:
        config.logger?.error ??
        ((m, err) => console.error(`[ChatMirror] ${m}`, err)),
      info: config.logger?.info ?? ((m) => console.log(`[ChatMirror] ${m}`)),
    };
  }

  /** Register the "append-to-ring + emit to sockets" callback from GameServer. */
  public setLobbyIngest(fn: LobbyIngestFn): void {
    this.lobbyIngest = fn;
  }

  /**
   * Send a lobby-origin message to every configured external platform.
   * No-ops (and logs at debug level) for non-lobby sources to prevent loops.
   */
  public async fanout(msg: LobbyChatMessage): Promise<void> {
    const src: LobbyChatSource = msg.source ?? 'lobby';
    if (src !== 'lobby') {
      // Explicit log so operators can see when loop-prevention fires.
      this.logger.info?.(
        `skip fanout: source=${src} id=${msg.id} (loop-safe)`,
      );
      return;
    }

    const line = formatOutgoing(msg);

    // Run both pushes in parallel; individual failures are logged and swallowed.
    await Promise.all([
      this.pushLine(line),
      this.pushDiscord(line),
    ]);
  }

  /**
   * Accept an inbound message from LINE or Discord, validate + rate-limit it,
   * and push it into the lobby buffer via the registered ingest callback.
   * Returns the resulting LobbyChatMessage on success, null if rejected
   * (invalid body / rate-limited / unconfigured / bad source).
   *
   * Phase B wires LINE webhooks + Discord messageCreate to this method.
   */
  public ingestInbound(params: {
    source: LobbyChatSource;
    platformUserId: string;
    displayName: string;
    text: unknown;
    messageId: string;
  }): LobbyChatMessage | null {
    const { source, platformUserId, displayName, text, messageId } = params;

    if (source === 'lobby') {
      this.logger.warn(
        `ingestInbound called with source=lobby (use socket handler instead)`,
      );
      return null;
    }

    if (!this.lobbyIngest) {
      this.logger.warn('ingestInbound called before setLobbyIngest — dropping');
      return null;
    }

    const trimmed = validateInboundBody(text);
    if (!trimmed) return null;

    const rlKey = `${source}:${platformUserId}`;
    if (!this.inboundLimiter.isAllowed(rlKey)) {
      this.logger.info?.(`inbound rate-limited: ${rlKey}`);
      return null;
    }

    const msg: LobbyChatMessage = {
      id: messageId,
      playerId: `${source}:${platformUserId}`,
      playerName: (displayName ?? '').trim() || `${source}-user`,
      message: trimmed,
      timestamp: Date.now(),
      source,
    };

    try {
      this.lobbyIngest(msg);
    } catch (err) {
      this.logger.error('lobbyIngest threw', err);
      return null;
    }

    return msg;
  }

  // ─── Internals ────────────────────────────────────────────────────────

  private async pushLine(line: string): Promise<void> {
    if (!this.lineGroupId || !this.line) return;
    try {
      await this.line.pushMessage(this.lineGroupId, {
        type: 'text',
        text: line,
      });
    } catch (err) {
      this.logger.error('LINE push failed', err);
    }
  }

  private async pushDiscord(line: string): Promise<void> {
    if (!this.discordChannelId || !this.discord) return;
    try {
      const ch = await this.discord.fetchChannel(this.discordChannelId);
      if (!ch) {
        this.logger.warn(
          `Discord channel ${this.discordChannelId} unavailable`,
        );
        return;
      }
      await ch.send(line);
    } catch (err) {
      this.logger.error('Discord push failed', err);
    }
  }
}

// ─── Inbound validation ──────────────────────────────────────────────────

/**
 * Mirror of `LobbyChatBuffer.validateBody` but duplicated here so Phase B
 * doesn't need to import socket-layer internals into the bot layer.
 * Exported for direct unit testing.
 */
export function validateInboundBody(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.length > LOBBY_CHAT_MAX_LEN) {
    // Truncate rather than reject — external users shouldn't silently lose
    // long messages; `…` suffix signals the trim.
    return trimmed.slice(0, LOBBY_CHAT_MAX_LEN - 1) + '…';
  }
  return trimmed;
}

// ─── Singleton wiring (runtime side) ─────────────────────────────────────

let chatMirrorInstance: ChatMirror | null = null;

/**
 * Build (once) and return the process-wide ChatMirror. Reads env vars for
 * the destination ids; adapters are injected by the caller (GameServer)
 * so the bot clients stay lazily loaded and the vitest build doesn't need
 * to resolve them.
 *
 * Safe to call when adapters / env are missing — the resulting instance
 * simply skips the corresponding outbound.
 */
export function initializeChatMirror(config: ChatMirrorConfig): ChatMirror {
  if (chatMirrorInstance) return chatMirrorInstance;
  chatMirrorInstance = new ChatMirror(config);
  return chatMirrorInstance;
}

export function getChatMirror(): ChatMirror | null {
  return chatMirrorInstance;
}

/** Test-only: reset the singleton so each test gets a clean instance. */
export function __resetChatMirrorForTests(): void {
  chatMirrorInstance = null;
}
