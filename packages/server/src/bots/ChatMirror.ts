/**
 * ChatMirror — #82 大廳聊天 ↔ LINE 群 ↔ Discord 頻道 三向全同步核心模組
 *
 * Responsibility:
 *   The single source of truth for lobby ↔ LINE ↔ Discord message fan-out.
 *
 *   - `fanout(msg)`   — lobby-origin → LINE + Discord (outbound).
 *   - `crossFanout(msg)` — external-origin → the other external platform
 *     (so LINE ↔ Discord stays in sync even though the lobby is the "hub").
 *   - `ingestInbound({source, ...})` — external webhook / bot event →
 *     validate + rate-limit + push into the lobby ring buffer via the
 *     `setLobbyIngest()` callback wired up by GameServer.
 *
 * Three-way topology (updated 2026-04-23):
 *
 *       lobby ──[fanout]──▶ LINE
 *         ▲                   │
 *         │                   │
 *     [ingestInbound]    [crossFanout]
 *         │                   │
 *         │                   ▼
 *       lobby ◀─[ingestInbound]─ Discord ◀──[fanout]── lobby
 *         │                   ▲
 *         │                   │
 *     [ingestInbound]    [crossFanout]
 *         ▲                   │
 *         │                   │
 *       LINE ────────────[crossFanout]────────▶ Discord
 *
 *   Loop prevention relies on the `source` tag:
 *   - `fanout` only mirrors `source==='lobby'` messages — messages already
 *     tagged `line`/`discord` short-circuit, preventing lobby → LINE → lobby.
 *   - `crossFanout` pushes to every platform *except* the one the message
 *     originated from, so a LINE message reaches Discord but never bounces
 *     back to LINE.
 *
 * Design decisions:
 *   - Env-gated: if `LOBBY_MIRROR_LINE_GROUP_ID` / `LOBBY_MIRROR_DISCORD_CHANNEL_ID`
 *     are unset, the corresponding outbound is a no-op. Boot never fails.
 *   - Fire-and-forget: every push swallows per-platform errors (logged) and
 *     never throws into the socket hot path or a webhook response. A failed
 *     push to LINE cannot break the lobby emit for other clients.
 *   - Rate limit: per-platform userId, reuses the existing `SocketRateLimiter`
 *     so behaviour matches the rest of the server.
 *   - Adapter-based: `LineAdapter` and `DiscordAdapter` interfaces let unit
 *     tests inject mocks, and let real clients be swapped in without touching
 *     this module's contract.
 *
 * Identity mapping (guest-friendly):
 *   - LINE / Discord display names are preserved as `playerName` so lobby
 *     users recognise the speaker.
 *   - `playerId` is namespaced (`line:<userId>`, `discord:<userId>`) so
 *     #42 multi-account binding can join these identities to a single
 *     Avalon account later without data-migration pain.
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
   * Cross-platform fanout for a message that originated on LINE or Discord.
   *
   * Pushes the formatted one-liner to every *configured* external platform
   * **except** the one the message came from, so LINE ↔ Discord stays in sync
   * without having to round-trip through the lobby websocket layer.
   *
   *   source='line'    → pushes to Discord only
   *   source='discord' → pushes to LINE only
   *   source='lobby'   → pushes to both (equivalent to fanout — accepted for
   *                      symmetry; lobby-origin callers should still use
   *                      fanout() for clarity).
   *
   * Fire-and-forget: per-platform errors are logged and swallowed so a
   * webhook handler or Discord messageCreate listener never throws back
   * into the platform SDK.
   */
  public async crossFanout(msg: LobbyChatMessage): Promise<void> {
    const src: LobbyChatSource = msg.source ?? 'lobby';
    const line = formatOutgoing(msg);
    const pushes: Promise<void>[] = [];
    if (src !== 'line') pushes.push(this.pushLine(line));
    if (src !== 'discord') pushes.push(this.pushDiscord(line));
    await Promise.all(pushes);
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
