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

/** Legacy prefix tag — kept for backward compat in tests; no longer emitted. */
const OUTBOUND_PREFIX = '[Avalon]';

/** 2026-04-24 Edward 指令: 統一訊息格式 [MMDD hh:mm][來源][username] 內容 */
export type MirrorSource = 'AP' | 'DC' | 'LINE';

/**
 * Tag a LobbyChatSource value into the Edward-mandated short tag.
 * Kept pure so formatOutgoingUnified() can be tested without any clock/env.
 */
export function mapSourceTag(source: LobbyChatSource | undefined): MirrorSource {
  if (source === 'discord') return 'DC';
  if (source === 'line') return 'LINE';
  return 'AP';
}

/** Pad a positive integer to 2 digits (01..99). */
function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * Format a timestamp in Taipei (+08) as `MMDD hh:mm`. Accepts a ms-precision
 * epoch — the UTC-to-TPE offset is applied arithmetically so the result does
 * not depend on the host's `TZ` env var (servers run in UTC on Render /
 * Docker, so a toLocaleString fallback would silently render UTC digits).
 */
export function formatTaipeiStamp(epochMs: number): string {
  const TPE_OFFSET_MS = 8 * 60 * 60 * 1000;
  const d = new Date(epochMs + TPE_OFFSET_MS);
  const mm = pad2(d.getUTCMonth() + 1);
  const dd = pad2(d.getUTCDate());
  const hh = pad2(d.getUTCHours());
  const mi = pad2(d.getUTCMinutes());
  return `${mm}${dd} ${hh}:${mi}`;
}

/**
 * 2026-04-24 Edward 指令 — unified cross-platform message format.
 *   `[MMDD hh:mm][{來源}][{username}] {message_content}`
 *
 * Note the single space between the trailing `]` and the message body.
 * Used by every outbound path (lobby → LINE, lobby → Discord, as well as
 * LINE ↔ Discord cross-fanout) so the three chat surfaces stay visually
 * identical. System notices keep the speaker slot as `system` so the
 * bracket structure stays uniform (parseable downstream).
 */
export function formatOutgoingUnified(msg: LobbyChatMessage): string {
  const body = (msg.message ?? '').slice(0, OUTBOUND_TRUNCATE_AT);
  const tag = mapSourceTag(msg.source);
  const name = msg.isSystem
    ? 'system'
    : (msg.playerName ?? '').trim() || 'Unknown';
  const stamp = formatTaipeiStamp(msg.timestamp || Date.now());
  return `[${stamp}][${tag}][${name}] ${body}`;
}

/**
 * Backward-compat shim — pre-2026-04-24 callers expect `[Avalon] name: text`.
 * Kept only for tests that assert the old format; runtime paths now call
 * `formatOutgoingUnified()` directly via `formatOutgoing()`.
 *
 * @deprecated use formatOutgoingUnified
 */
export function formatOutgoingLegacy(msg: LobbyChatMessage): string {
  const body = (msg.message ?? '').slice(0, OUTBOUND_TRUNCATE_AT);
  if (msg.isSystem) {
    return `${OUTBOUND_PREFIX} ${body}`;
  }
  const name = (msg.playerName ?? 'Unknown').trim() || 'Unknown';
  return `${OUTBOUND_PREFIX} ${name}: ${body}`;
}

/**
 * Active outbound formatter. Dispatches to the unified (Edward-mandated)
 * format unless `CHAT_MIRROR_USE_LEGACY_FORMAT=true` is set — kept as an
 * escape hatch in case we need to revert without a redeploy.
 */
export function formatOutgoing(msg: LobbyChatMessage): string {
  if (process.env.CHAT_MIRROR_USE_LEGACY_FORMAT === 'true') {
    return formatOutgoingLegacy(msg);
  }
  return formatOutgoingUnified(msg);
}

// ─── Config surface ──────────────────────────────────────────────────────

/**
 * 2026-04-24 — POST-based enqueue path that routes LINE outbound through the
 * edward-listen-bot service. Avoids burning LINE monthly push quota by
 * buffering messages server-side and draining them on inbound reply_tokens.
 *
 * When configured (`listenBotEnqueueUrl` + `lineGroupId` both set), pushLine
 * sends a small JSON POST instead of calling the LINE SDK directly. The
 * legacy LineAdapter path stays as a fallback in case the listen-bot is
 * unreachable.
 */
export interface ListenBotEnqueueConfig {
  /** Full URL, e.g. `http://localhost:5678/enqueue/line` (local listen-bot)
   *  or future Cloud Run / aliased endpoint. The historical
   *  `edward-listen-bot.onrender.com` is dead (Render deleted 2026-04-23). */
  url: string;
  /** Optional shared-secret key matching listen-bot's `PUSH_API_KEY`. */
  apiKey?: string;
  /** Optional bot_key for observability (e.g. `avalon`). */
  botKey?: string;
  /** Request timeout in ms; defaults to 5000. */
  timeoutMs?: number;
}

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
   * 2026-04-24 — when set, `pushLine` routes through the listen-bot
   * enqueue endpoint (reply_token drain) instead of calling LINE push.
   * Leave unset to preserve legacy push behaviour.
   */
  listenBot?: ListenBotEnqueueConfig;
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
  private readonly listenBot?: ListenBotEnqueueConfig;
  private readonly inboundLimiter: SocketRateLimiter;
  private readonly logger: Required<ChatMirrorConfig>['logger'];
  private lobbyIngest: LobbyIngestFn | null = null;

  constructor(config: ChatMirrorConfig = {}) {
    this.lineGroupId = (config.lineGroupId ?? '').trim();
    this.discordChannelId = (config.discordChannelId ?? '').trim();
    this.line = config.line;
    this.discord = config.discord;
    this.listenBot = config.listenBot;

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
      this.pushLine(line, msg),
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
    if (src !== 'line') pushes.push(this.pushLine(line, msg));
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

  /**
   * Route outbound LINE text. Prefers the listen-bot enqueue path (no push
   * quota), falls back to direct LINE push if the listen-bot is unconfigured
   * or unreachable.
   *
   * `originMsg` is passed through so we can send the raw fields to the
   * listen-bot — the listen-bot is the single authority that applies the
   * Edward-mandated format, guaranteeing every chat surface sees the same
   * bracket structure.
   */
  private async pushLine(
    line: string,
    originMsg?: LobbyChatMessage,
  ): Promise<void> {
    if (!this.lineGroupId) return;

    // Prefer listen-bot enqueue (free, uses reply_token drain)
    if (this.listenBot?.url && originMsg) {
      const ok = await this.enqueueViaListenBot(originMsg);
      if (ok) return;
      // Fall through to legacy push only if enqueue failed — belt + braces
      // during rollout so a listen-bot outage doesn't silently drop messages.
      this.logger.warn(
        'listen-bot enqueue failed, falling back to LINE push',
      );
    }

    if (!this.line) return;
    try {
      await this.line.pushMessage(this.lineGroupId, {
        type: 'text',
        text: line,
      });
    } catch (err) {
      this.logger.error('LINE push failed', err);
    }
  }

  /**
   * POST a structured payload to the listen-bot's /enqueue/line endpoint.
   * The listen-bot applies the unified format and drains on the next LINE
   * reply_token, which is free (not subject to the monthly push quota).
   *
   * Returns true on 2xx, false on any other outcome (caller may fall back
   * to direct LINE push to avoid dropping the message).
   */
  private async enqueueViaListenBot(
    msg: LobbyChatMessage,
  ): Promise<boolean> {
    const cfg = this.listenBot;
    if (!cfg || !this.lineGroupId) return false;

    const tag = mapSourceTag(msg.source);
    const payload: Record<string, unknown> = {
      source: tag,
      username:
        msg.isSystem ? 'system' : (msg.playerName ?? 'Unknown').trim() || 'Unknown',
      content: msg.message ?? '',
      line_group_id: this.lineGroupId,
      ts: Math.floor((msg.timestamp || Date.now()) / 1000),
    };
    if (cfg.botKey) payload.bot_key = cfg.botKey;
    if (cfg.apiKey) payload.key = cfg.apiKey;

    const timeoutMs = cfg.timeoutMs ?? 5000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(cfg.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!resp.ok) {
        this.logger.warn(
          `listen-bot enqueue ${resp.status} for ${this.lineGroupId.slice(-8)}`,
        );
        return false;
      }
      return true;
    } catch (err) {
      this.logger.error('listen-bot enqueue threw', err);
      return false;
    } finally {
      clearTimeout(timer);
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

  /**
   * Direct (per-user) LINE push, used by `AsyncNotifier` to ping a specific
   * 棋瓦 (Avalon Chess) player when their phase opens. Bypasses the group
   * routing and the listen-bot enqueue path because the destination is a
   * specific userId, not the configured `lineGroupId`. Falls back gracefully
   * to a no-op when no LINE adapter is wired (so dev environments without
   * LINE credentials never crash the engine).
   *
   * Errors are NOT swallowed here — callers (AsyncNotifier) need to know
   * whether the push succeeded so its throttle / retry logic can decide
   * what to do. Other ChatMirror surfaces remain fire-and-forget; this one
   * is the explicit per-user-push contract.
   */
  public async pushDirect(lineUserId: string, text: string): Promise<void> {
    if (!this.line) {
      this.logger.warn('pushDirect called without a LINE adapter — no-op');
      return;
    }
    await this.line.pushMessage(lineUserId, {
      type: 'text',
      text,
    });
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
