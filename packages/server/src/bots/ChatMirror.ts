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
 *
 * Images (2026-10-13, docs/LINE_DISCORD_SYNC.md「圖片同步」):
 *   - LINE → Discord: `postLineImageToDiscord()` uploads the picture as a
 *     file with the usual `[MMDD hh:mm][LINE][name]` prefix and a short
 *     label; over Discord's upload limit (or on any failure) a text note
 *     goes instead. The lobby only gets a text marker (MIRROR_MEDIA_TEXT).
 *   - Discord → LINE: `relayDiscordToLine()` keeps arrival order (one chain,
 *     one download at a time) and `crossFanoutWithLineMedia()` queues the
 *     text line and then one LINE image message per picture on the SAME
 *     reply queue (no push). The picture is served from this server's relay store
 *     (bots/media/relayMedia.ts); `lineMessagesFor()` turns a queued image
 *     whose copy is gone into its text note at drain time.
 *   - Never logged: chat text, names, image URLs or relay ids. SDK errors
 *     are reduced to a code by describeError() (they embed the request).
 *   - Rate limit: marker-only media (a picture, sticker, file… with no text)
 *     has its own per-user limit, so pictures never use up the text limit
 *     (review fix 2026-10-13).
 *   - Order: while Discord pictures are being copied, website lobby lines
 *     bound for LINE wait on the same chain, so LINE keeps the order the
 *     lobby and Discord show (review fix 2026-10-13).
 */

import {
  LobbyChatMessage,
  LobbyChatSource,
  LOBBY_CHAT_MAX_LEN,
} from '../socket/LobbyChatBuffer';
import { SocketRateLimiter } from '../middleware/rateLimit';
import {
  degradeAfterFailedReply,
  type LineReplyQueue,
  type QueuedLineImage,
  type QueuedLineItem,
} from './line/replyQueue';
import { describeError, imageExtension, raceTimeout, sniffImageType } from './media/bytes';
import {
  DISCORD_DEFAULT_UPLOAD_BYTES,
  MEDIA_RELAY_AFTER_SEND_MS,
  type RelayMediaStore,
} from './media/relayMedia';

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
  /**
   * Post `content` with file attachments (mentions disabled). Optional: an
   * adapter without it gets a text note instead of the picture.
   */
  sendFiles?(content: string, files: DiscordFile[]): Promise<unknown>;
  /** Largest attachment the bot may upload here, in bytes (default 10 MB). */
  maxUploadBytes?: number;
}

export interface DiscordFile {
  name: string;
  data: Buffer;
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

// ─── Media markers (2026-10-13) ──────────────────────────────────────────

/**
 * Fixed texts for pictures, stickers and files. They are the whole body of
 * the relayed line (never a file name, URL or caption), 繁體中文.
 */
export const MIRROR_MEDIA_TEXT = {
  image: '（圖片）',
  sticker: '（貼圖）',
  lineVideo: '（影片，請到 LINE 看）',
  lineAudio: '（語音訊息，請到 LINE 聽）',
  lineFile: '（檔案，請到 LINE 看）',
  lineLocation: '（位置資訊，請到 LINE 看）',
  lineImageTooLarge: '（圖片太大，請到 LINE 看）',
  lineImageFailed: '（圖片沒有同步過來，請到 LINE 看）',
  lineImageOff: '（圖片，請到 LINE 看）',
  discordImageOnDiscord: '（Discord 有一張圖片，請到 Discord 看）',
} as const;

function countWord(n: number, unit: string): string {
  return n === 1 ? `一${unit}` : `${n} ${unit}`;
}

/** Label of one LINE picture on Discord: （圖片） or, in a set, （圖片 2/3）. */
export function lineImageLabel(set?: { index?: number; total?: number } | null): string {
  const index = set?.index;
  const total = set?.total;
  if (index && total && total > 1) return `（圖片 ${index}/${total}）`;
  return MIRROR_MEDIA_TEXT.image;
}

/** Lobby marker for n pictures: （圖片） or （圖片 ×3）. */
export function imageCountMarker(n: number): string {
  return n > 1 ? `（圖片 ×${n}）` : MIRROR_MEDIA_TEXT.image;
}

/** Marker appended to a Discord message that carried media, e.g. （圖片 ×2、檔案）. */
export function discordMediaMarker(counts: { images: number; files: number; stickers: number }): string {
  const parts: string[] = [];
  if (counts.images > 0) parts.push(counts.images > 1 ? `圖片 ×${counts.images}` : '圖片');
  if (counts.files > 0) parts.push(counts.files > 1 ? `檔案 ×${counts.files}` : '檔案');
  if (counts.stickers > 0) parts.push('貼圖');
  return parts.length > 0 ? `（${parts.join('、')}）` : '';
}

/** LINE note for Discord pictures / files that cannot be shown there, or null. */
export function discordLeftoverNote(counts: { images: number; files: number }): string | null {
  const parts: string[] = [];
  if (counts.images > 0) parts.push(countWord(counts.images, '張圖片'));
  if (counts.files > 0) parts.push(countWord(counts.files, '個檔案'));
  if (parts.length === 0) return null;
  if (counts.images === 1 && counts.files === 0) return MIRROR_MEDIA_TEXT.discordImageOnDiscord;
  const joined = parts.join('、');
  return `（Discord 有${/^\d/.test(joined) ? ' ' : ''}${joined}，請到 Discord 看）`;
}

/**
 * `text` + ` ` + `marker`, cutting the text (not the marker) so the result
 * fits LOBBY_CHAT_MAX_LEN.
 */
export function withMediaMarker(text: string, marker: string): string {
  const body = text.trim();
  if (!marker) return body;
  if (!body) return marker;
  const room = LOBBY_CHAT_MAX_LEN - marker.length - 1;
  const cut = body.length > room ? `${body.slice(0, Math.max(0, room - 1))}…` : body;
  return `${cut} ${marker}`;
}

/** A LINE message object as sent by the reply drain. */
export type LineOutboundMessage =
  | { type: 'text'; text: string }
  | { type: 'image'; originalContentUrl: string; previewImageUrl: string };

/** Result of downloading a LINE picture for Discord. */
export type LineImageFetch = { ok: true; data: Buffer } | { ok: false; reason: 'too-large' | 'failed' };

/** Outcome code of one LINE → Discord picture (counts / logs only). */
export type LineImageRelayOutcome =
  | 'uploaded'
  | 'too-large'
  | 'download-failed'
  | 'upload-failed'
  | 'no-channel'
  | 'disabled'
  | 'failed'
  | 'timeout';

/** Never read more than this from LINE, whatever the Discord server allows. */
export const LINE_IMAGE_DOWNLOAD_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Discord → LINE ordering chain (relayDiscordToLine): messages waiting
 * before new pictures stop being copied, and the backstop per message.
 */
export const DISCORD_TO_LINE_MAX_WAITING = 10;
export const DISCORD_TO_LINE_STEP_TIMEOUT_MS = 90_000;

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
   * 2026-10-08 — in-process reply_token drain. When set (and no listen-bot
   * is configured), outbound LINE texts are queued here instead of pushed;
   * `bots/line/client.ts` flushes up to 5 per inbound reply_token from the
   * mirror group. Free (reply does not count against the push quota), at the
   * cost of latency: LINE sees the message when someone next speaks there.
   */
  lineReplyQueue?: LineReplyQueue;
  /**
   * 2026-10-13 — Discord → LINE images: where copies are kept and the public
   * https base they are served from (`<base>/media/relay/<id>.jpg`). Only
   * used together with `lineReplyQueue`; omit to send text markers only.
   */
  lineImageRelay?: { store: RelayMediaStore; publicBaseUrl: string };
  /**
   * 2026-10-13 — LINE → Discord pictures (download from LINE, upload as a
   * file). Default true; false (CHAT_MIRROR_IMAGES=false) sends the text
   * note MIRROR_MEDIA_TEXT.lineImageOff instead, nothing is downloaded.
   */
  lineImagesToDiscord?: boolean;
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
  private readonly lineReplyQueue?: LineReplyQueue;
  private readonly imageRelay?: { store: RelayMediaStore; publicBaseUrl: string };
  private readonly imagesToDiscord: boolean;
  /** Discord → LINE steps in arrival order while pictures are copied (relayDiscordToLine). */
  private discordToLineChain: Promise<void> = Promise.resolve();
  private discordToLineWaiting = 0;
  private readonly inboundLimiter: SocketRateLimiter;
  private readonly logger: Required<ChatMirrorConfig>['logger'];
  private lobbyIngest: LobbyIngestFn | null = null;

  constructor(config: ChatMirrorConfig = {}) {
    this.lineGroupId = (config.lineGroupId ?? '').trim();
    this.discordChannelId = (config.discordChannelId ?? '').trim();
    this.line = config.line;
    this.discord = config.discord;
    this.listenBot = config.listenBot;
    this.lineReplyQueue = config.lineReplyQueue;
    this.imageRelay = config.lineImageRelay;
    this.imagesToDiscord = config.lineImagesToDiscord ?? true;

    const rl = config.inboundRateLimit ?? { windowMs: 60_000, maxRequests: 5 };
    this.inboundLimiter = new SocketRateLimiter({
      windowMs: rl.windowMs,
      maxRequests: rl.maxRequests,
    });

    this.logger = {
      warn: config.logger?.warn ?? ((m) => console.warn(`[ChatMirror] ${m}`)),
      // Never the error object itself: SDK errors embed the request (chat text).
      error:
        config.logger?.error ??
        ((m, err) =>
          console.error(`[ChatMirror] ${m}${err === undefined ? '' : ` (${describeError(err)})`}`)),
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
    // LINE waits behind Discord messages whose pictures are still being copied.
    await Promise.all([
      this.pushLineInOrder(line, msg),
      this.pushDiscord(line),
    ]);
  }

  /**
   * pushLine, but behind any Discord → LINE step still on the chain
   * (relayDiscordToLine), so a lobby line sent while a Discord picture is
   * downloading reaches LINE after it — the order the lobby and Discord show.
   * Without pending steps (or without the picture relay) it goes at once.
   */
  private pushLineInOrder(line: string, msg: LobbyChatMessage): Promise<void> {
    if (!this.lineImageRelay() || this.discordToLineWaiting === 0) return this.pushLine(line, msg);
    return this.onDiscordToLineChain(() => this.pushLine(line, msg));
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
    /**
     * 'media' — a marker-only line for a picture / sticker / file with no
     * text: counted against a separate per-user limit, so a burst of
     * pictures never uses up the text limit. Default 'text'.
     */
    kind?: 'text' | 'media';
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

    const rlKey = params.kind === 'media' ? `${source}-media:${platformUserId}` : `${source}:${platformUserId}`;
    if (!this.inboundLimiter.isAllowed(rlKey)) {
      // Platform only — never the user id (counts and codes only in logs).
      this.logger.info?.(`inbound rate-limited: source=${source}`);
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

  // ─── LINE reply-token drain (2026-10-08) ──────────────────────────────

  /** True when outbound LINE goes through the in-process reply queue. */
  public isLineReplyQueueEnabled(): boolean {
    return !!this.lineReplyQueue && !!this.lineGroupId;
  }

  /** Pop up to `max` (≤5) queued LINE messages (texts and images), oldest first. */
  public drainLineReplies(max?: number): QueuedLineItem[] {
    return this.lineReplyQueue ? this.lineReplyQueue.drain(max) : [];
  }

  /**
   * Put a failed batch back at the head so the next reply_token re-sends it.
   * Texts go back exactly as drained; an image goes back as its text note
   * when LINE rejected an image URL (`imageRejected`) or it already failed
   * before (degradeAfterFailedReply), so one bad image cannot jam the queue.
   */
  public requeueLineReplies(batch: QueuedLineItem[], opts: { imageRejected?: boolean } = {}): void {
    if (!this.lineReplyQueue || batch.length === 0) return;
    const { retry, degraded, releasedMediaIds } = degradeAfterFailedReply(batch, opts);
    this.releaseRelayMedia(releasedMediaIds);
    if (degraded > 0) {
      this.logger.warn(`LINE reply failed — ${degraded} image(s) will be sent as a text note`);
    }
    const { dropped, releasedMediaIds: droppedMedia } = this.lineReplyQueue.requeueFront(retry);
    this.releaseRelayMedia(droppedMedia);
    if (dropped > 0) {
      this.logger.warn(`LINE reply queue overflow on requeue — dropped ${dropped} newest message(s)`);
    }
  }

  /**
   * LINE message objects for a drained batch. A queued image becomes an
   * image message only while its relay copy is still live (and is then kept
   * alive ≥ 24 h for LINE to fetch); otherwise its text note goes instead.
   */
  public lineMessagesFor(batch: QueuedLineItem[]): {
    messages: LineOutboundMessage[];
    images: number;
    fallbacks: number;
  } {
    let images = 0;
    let fallbacks = 0;
    const store = this.imageRelay?.store;
    const messages = batch.map((item): LineOutboundMessage => {
      if (!item.image) return { type: 'text', text: item.text };
      const ids = item.image.mediaIds;
      // Check every copy first, so a picture whose preview is gone does not
      // pin its original for another day; those leftovers are freed.
      const live = !!store && ids.length > 0 && ids.every((id) => store.has(id));
      if (!live) {
        this.releaseRelayMedia(ids);
        fallbacks += 1;
        return { type: 'text', text: item.text };
      }
      for (const id of ids) store.keepAlive(id, MEDIA_RELAY_AFTER_SEND_MS);
      images += 1;
      return { type: 'image', originalContentUrl: item.image.originalUrl, previewImageUrl: item.image.previewUrl };
    });
    return { messages, images, fallbacks };
  }

  public lineReplyQueueSize(): number {
    return this.lineReplyQueue?.size() ?? 0;
  }

  /**
   * Queue a bot-authored text (the weekly stats digest, 2026-10-10) for the
   * LINE mirror group as-is — it goes out on the next reply_token like any
   * queued mirror line. Not a fan-out: nothing reaches the lobby or Discord.
   * Returns false when the reply queue is not in use (listen-bot / push
   * mode); callers must not fall back to push (it costs monthly quota).
   */
  public enqueueLineReplyText(text: string): boolean {
    if (!this.lineReplyQueue || !this.isLineReplyQueueEnabled()) return false;
    const { dropped, releasedMediaIds } = this.lineReplyQueue.enqueue(text);
    this.releaseRelayMedia(releasedMediaIds);
    if (dropped > 0) {
      this.logger.warn(`LINE reply queue full — dropped ${dropped} oldest message(s)`);
    }
    return true;
  }

  // ─── Images (2026-10-13) ──────────────────────────────────────────────

  /** True when outbound LINE goes into the in-process reply queue (not listen-bot, not push). */
  private usesLineReplyQueue(): boolean {
    return !!this.lineReplyQueue && !!this.lineGroupId && !this.listenBot?.url;
  }

  /**
   * True when Discord → LINE goes out through the in-process reply queue —
   * free, nothing pushed or enqueued elsewhere. Marker-only Discord messages
   * (a picture or sticker with no text) only go to LINE then; in push /
   * listen-bot mode they would cost quota or extra enqueues (review fix 2026-10-13).
   */
  public lineOutboundUsesReplyQueue(): boolean {
    return this.usesLineReplyQueue();
  }

  /** LINE → Discord pictures are copied (CHAT_MIRROR_IMAGES not false). */
  public lineImagesToDiscordEnabled(): boolean {
    return this.imagesToDiscord;
  }

  /**
   * Relay store + public base for Discord → LINE pictures, or null when
   * pictures cannot reach LINE for free (no reply queue, no https base, or
   * turned off) — callers then send the text marker only.
   */
  public lineImageRelay(): { store: RelayMediaStore; publicBaseUrl: string } | null {
    return this.imageRelay && this.usesLineReplyQueue() ? this.imageRelay : null;
  }

  /** Free relay copies that will not be sent after all. */
  public releaseRelayMedia(ids: string[]): void {
    const store = this.imageRelay?.store;
    if (!store) return;
    for (const id of ids) store.delete(id);
  }

  /**
   * Relay an already-ingested Discord message to LINE (review fix 2026-10-13).
   *
   * While pictures can be copied (`lineImageRelay()` non-null, i.e. reply
   * queue mode), every Discord → LINE step — text-only messages too — runs
   * on ONE chain in arrival order:
   *   - a quick text posted while an earlier picture is still downloading
   *     waits for it, so LINE sees the messages in the order they were sent
   *     (LINE only gets them at the next reply_token anyway);
   *   - downloads run one at a time across all users, so at most one
   *     picture (≤ 10 MB) is in flight however many arrive at once;
   *   - with DISCORD_TO_LINE_MAX_WAITING messages already waiting, a new
   *     message's pictures are not downloaded (they go as the text note).
   * Each step is bounded by DISCORD_TO_LINE_STEP_TIMEOUT_MS so nothing can
   * hold the chain. Without the relay (push / listen-bot / images off)
   * nothing is downloaded and the message goes straight out as before.
   *
   * `media` is null for a text-only message; otherwise `prepare(relay)`
   * copies the pictures (relay null → copy nothing) and returns the LINE
   * image refs plus the note for whatever stays on Discord. Never rejects.
   */
  public relayDiscordToLine(
    msg: LobbyChatMessage,
    media: {
      prepare: (
        relay: { store: RelayMediaStore; publicBaseUrl: string } | null,
      ) => Promise<{ images: QueuedLineImage[]; note: string | null }>;
    } | null,
  ): Promise<void> {
    const relay = this.lineImageRelay();
    const step = async (useRelay: typeof relay): Promise<void> => {
      if (!media) {
        await this.crossFanout(msg);
        return;
      }
      const prepared = await media.prepare(useRelay);
      await this.crossFanoutWithLineMedia(msg, prepared.images, prepared.note);
    };
    const failed = (err: unknown): void => {
      this.logger.warn(`Discord → LINE relay failed (${describeError(err)})`);
    };
    if (!relay) return step(null).catch(failed);

    const crowded = this.discordToLineWaiting >= DISCORD_TO_LINE_MAX_WAITING;
    return this.onDiscordToLineChain(() => step(crowded ? null : relay).catch(failed));
  }

  /**
   * Run `work` as the next step of the Discord → LINE chain (arrival order),
   * bounded by DISCORD_TO_LINE_STEP_TIMEOUT_MS. Resolves when it has run; never rejects.
   */
  private onDiscordToLineChain(work: () => Promise<void>): Promise<void> {
    this.discordToLineWaiting += 1;
    const run = this.discordToLineChain.then(() =>
      raceTimeout(
        work().catch((err: unknown) => {
          this.logger.warn(`Discord → LINE relay failed (${describeError(err)})`);
        }),
        DISCORD_TO_LINE_STEP_TIMEOUT_MS,
        () => {
          this.logger.warn('Discord → LINE relay step timed out — continuing with the next message');
        },
      ),
    );
    this.discordToLineChain = run.finally(() => {
      this.discordToLineWaiting -= 1;
    });
    return this.discordToLineChain;
  }

  /**
   * Discord-origin message that carried media → LINE. In reply-queue mode the
   * text line, each picture (a LINE image message) and the optional note are
   * queued back to back in one synchronous step, so nothing can slip between
   * them. In any other mode only the text line goes (as crossFanout) and the
   * prepared copies are freed — pictures are never pushed (push costs quota).
   * Never echoes to Discord for a Discord-origin message.
   */
  public async crossFanoutWithLineMedia(
    msg: LobbyChatMessage,
    images: QueuedLineImage[],
    note: string | null,
  ): Promise<void> {
    const src: LobbyChatSource = msg.source ?? 'lobby';
    if (src === 'line' || !this.usesLineReplyQueue() || !this.lineReplyQueue) {
      this.releaseRelayMedia(images.flatMap((i) => i.mediaIds));
      await this.crossFanout(msg);
      return;
    }
    const queue = this.lineReplyQueue;
    const now = Date.now();
    // One group: on overflow the whole message leaves the queue together, so a
    // picture never stays behind without its speaker line.
    const { dropped, releasedMediaIds } = queue.enqueueGroup([
      { text: formatOutgoing(msg), enqueuedAt: now },
      ...images.map((image) => ({ text: MIRROR_MEDIA_TEXT.discordImageOnDiscord, enqueuedAt: now, image })),
      ...(note ? [{ text: note, enqueuedAt: now }] : []),
    ]);
    this.releaseRelayMedia(releasedMediaIds);
    if (dropped > 0) {
      this.logger.warn(`LINE reply queue full — dropped ${dropped} oldest message(s)`);
    }
    if (src !== 'discord') await this.pushDiscord(formatOutgoing(msg));
  }

  /**
   * LINE picture → Discord sync channel as a file, content = the unified
   * prefix + `msg.message` (the label, e.g. （圖片 2/3）). `fetchImage` gets
   * the byte cap (the channel's upload limit, at most 25 MB) and must stop
   * past it. Too large / download failed / upload refused → the same prefix
   * with a text note instead. Never throws; returns an outcome code.
   */
  public async postLineImageToDiscord(
    msg: LobbyChatMessage,
    fetchImage: (maxBytes: number) => Promise<LineImageFetch>,
  ): Promise<LineImageRelayOutcome> {
    if (!this.discordChannelId || !this.discord) return 'disabled';
    let ch: DiscordChannelAdapter | null = null;
    try {
      ch = await this.discord.fetchChannel(this.discordChannelId);
    } catch (err) {
      this.logger.warn(`Discord channel lookup failed (${describeError(err)})`);
    }
    if (!ch) {
      this.logger.warn('Discord sync channel unavailable — LINE picture not relayed');
      return 'no-channel';
    }
    const limit = Math.min(
      ch.maxUploadBytes && ch.maxUploadBytes > 0 ? ch.maxUploadBytes : DISCORD_DEFAULT_UPLOAD_BYTES,
      LINE_IMAGE_DOWNLOAD_MAX_BYTES,
    );

    let outcome: LineImageRelayOutcome = 'download-failed';
    let note: string = MIRROR_MEDIA_TEXT.lineImageFailed;
    if (ch.sendFiles) {
      let got: LineImageFetch;
      try {
        got = await fetchImage(limit);
      } catch {
        got = { ok: false, reason: 'failed' };
      }
      if (got.ok) {
        const name = `line-image.${imageExtension(sniffImageType(got.data))}`;
        try {
          await ch.sendFiles(formatOutgoing(msg), [{ name, data: got.data }]);
          return 'uploaded';
        } catch (err) {
          this.logger.warn(`LINE picture upload to Discord failed (${describeError(err)}) — sending a note`);
          outcome = 'upload-failed';
        }
      } else if (got.reason === 'too-large') {
        outcome = 'too-large';
        note = MIRROR_MEDIA_TEXT.lineImageTooLarge;
      }
    }
    try {
      await ch.send(formatOutgoing({ ...msg, message: note }));
    } catch (err) {
      this.logger.error(`Discord push failed (${describeError(err)})`);
      return 'failed';
    }
    return outcome;
  }

  // ─── Internals ────────────────────────────────────────────────────────

  /**
   * Route outbound LINE text. Order of preference:
   *   1. listen-bot enqueue (external service, no push quota)
   *   2. in-process reply_token queue (no push quota, drained on next inbound)
   *   3. direct LINE push (costs quota) — only when neither of the above is
   *      configured, or as a fallback when the listen-bot is unreachable and
   *      no queue exists.
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

    if (this.lineReplyQueue) {
      const { dropped, releasedMediaIds } = this.lineReplyQueue.enqueue(line);
      this.releaseRelayMedia(releasedMediaIds);
      if (dropped > 0) {
        this.logger.warn(`LINE reply queue full — dropped ${dropped} oldest message(s)`);
      }
      return;
    }

    if (!this.line) return;
    try {
      await this.line.pushMessage(this.lineGroupId, {
        type: 'text',
        text: line,
      });
    } catch (err) {
      // SDK errors embed the request body (chat text) — log a code only.
      this.logger.error(`LINE push failed (${describeError(err)})`);
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
      // DiscordAPIError carries the request body (chat text) — log a code only.
      this.logger.error(`Discord push failed (${describeError(err)})`);
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
