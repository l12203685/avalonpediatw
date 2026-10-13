/**
 * Discord sync channel → lobby + LINE (#82), with pictures (2026-10-13).
 *
 * Kept out of client.ts so it can be tested without a discord.js gateway:
 * `handleDiscordMirrorMessage()` takes a structural slice of a discord.js
 * Message.
 *
 * Every relayed message is first ingested (rate limit + lobby) the moment it
 * arrives, so the lobby keeps arrival order and a rate-limited message never
 * downloads anything. LINE then gets it through ChatMirror.relayDiscordToLine
 * (arrival order, one download at a time across all users).
 *
 * Text only (no attachments / stickers): the text line, as before — the
 * WHOLE text (2026-10-13; only the website lobby shows a cut copy). Over
 * LINE's 5000 characters it is queued as parts (ChatMirror).
 *
 * With attachments / stickers:
 *   1. The lobby / LINE text line is the message text plus a marker
 *      (「（圖片）」「（圖片 ×2、檔案）」「（貼圖）」); attachment-only → marker only.
 *   2. JPEG / PNG pictures ≤ 10 MB (not spoilers) are downloaded from the
 *      Discord CDN when the message's turn comes (seconds, not hours) — the
 *      signed link expires, and LINE may only fetch the picture hours later
 *      when the reply queue drains — and kept in the relay store
 *      (bots/media/relayMedia.ts). A picture over 1 MB also gets a ≤ 1 MB
 *      preview from Discord's media proxy (resized); no preview → the
 *      picture is not sent (LINE requires one). All downloads of one message
 *      share DISCORD_TO_LINE_PREP_BUDGET_MS; what does not fit becomes the note.
 *   3. LINE gets, back to back on the reply queue: that text line, one LINE
 *      image message per prepared picture, and one note for the rest
 *      (「（Discord 有一張圖片，請到 Discord 看）」 for webp / gif / heic /
 *      spoiler / too large / failed downloads, 「…個檔案…」 for other files).
 *   Pictures only go to LINE in reply-queue mode (free); otherwise just the
 *   text line, as before — and a message with NO text (a picture or sticker
 *   alone) does not go to LINE at all then: the lobby still gets its marker,
 *   but push / listen-bot mode would spend quota on it (review fix 2026-10-13).
 *   Rate-limited or loop-tagged messages download nothing. A marker-only
 *   message counts against its own per-user limit (ChatMirror kind 'media'),
 *   so screenshots never use up the text limit.
 *
 * Nothing here logs text, names, file names or URLs.
 */

import {
  ChatMirror,
  discordLeftoverNote,
  discordMediaMarker,
} from '../ChatMirror';
import type { QueuedLineImage } from '../line/replyQueue';
import { fetchCapped, sniffImageType, type SniffedImageType } from '../media/bytes';
import {
  LINE_IMAGE_MAX_BYTES,
  LINE_PREVIEW_MAX_BYTES,
  RelayMediaStore,
  isLineImageUrl,
  relayMediaUrl,
  type RelayImageType,
} from '../media/relayMedia';

/** The parts of a discord.js Attachment this module reads. */
export interface MirrorAttachmentLike {
  name?: string | null;
  url: string;
  proxyURL?: string | null;
  size: number;
  contentType?: string | null;
  width?: number | null;
  height?: number | null;
  spoiler?: boolean;
}

/** The parts of a discord.js Message this module reads. */
export interface MirrorMessageLike {
  id: string;
  channelId: string;
  content?: string | null;
  webhookId?: string | null;
  author: { id: string; bot: boolean; globalName?: string | null; username?: string | null };
  member?: { displayName?: string | null } | null;
  attachments?: { values(): IterableIterator<MirrorAttachmentLike> } | null;
  stickers?: { size: number } | null;
}

export interface DiscordMirrorDeps {
  /** LOBBY_MIRROR_DISCORD_CHANNEL_ID (trimmed); '' disables the mirror. */
  targetChannelId: string;
  mirror: ChatMirror | null;
  /** Feedback topic counter (numbers only) — called with the message text. */
  observe?: (text: string) => void;
  fetchImpl?: typeof fetch;
  /** Per-download timeout (ms). */
  timeoutMs?: number;
  /** Download budget of one message (ms). */
  budgetMs?: number;
  logger?: { warn: (msg: string) => void };
}

export type DiscordMirrorOutcome =
  | 'ignored'
  | 'no-mirror'
  | 'rate-limited'
  | 'text'
  | 'media';

/**
 * Pictures per Discord message sent to LINE as images: the text line + 4
 * pictures fill exactly one reply. The rest are named in the note.
 */
export const DISCORD_TO_LINE_MAX_IMAGES = 4;

/** Preview sizes tried on Discord's media proxy (longest side, px). */
export const DISCORD_PREVIEW_SIDES = [640, 320] as const;

/** Per-download timeout and the total download budget of one Discord message. */
export const DISCORD_FETCH_TIMEOUT_MS = 20_000;
export const DISCORD_TO_LINE_PREP_BUDGET_MS = 45_000;

const DISCORD_MEDIA_HOSTS = /(^|\.)(discordapp\.com|discordapp\.net|discord\.com|discord\.net)$/i;

function isDiscordMediaUrl(raw: string | null | undefined): raw is string {
  if (!raw) return false;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && DISCORD_MEDIA_HOSTS.test(u.hostname);
  } catch {
    return false;
  }
}

const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp|heic|heif|avif|bmp|tiff?|svg)$/i;

/** Picture vs other file, from the declared content type, else the file extension. */
export function isImageAttachment(a: MirrorAttachmentLike): boolean {
  const ct = (a.contentType ?? '').toLowerCase();
  if (ct) return ct.startsWith('image/');
  return IMAGE_EXT_RE.test(a.name ?? '');
}

/** Declared JPEG / PNG (the only formats LINE image messages take). */
function declaredJpegOrPng(a: MirrorAttachmentLike): boolean {
  const ct = (a.contentType ?? '').toLowerCase().split(';')[0].trim();
  if (ct) return ct === 'image/jpeg' || ct === 'image/jpg' || ct === 'image/png';
  return /\.(jpe?g|png)$/i.test(a.name ?? '');
}

function isSpoiler(a: MirrorAttachmentLike): boolean {
  return a.spoiler === true || /^SPOILER_/i.test(a.name ?? '');
}

/**
 * Media-proxy URL of a resized copy whose longest side is `maxSide`.
 * Keeps Discord's signature parameters; null when there is no usable proxy URL.
 */
export function discordPreviewUrl(a: MirrorAttachmentLike, maxSide: number): string | null {
  if (!isDiscordMediaUrl(a.proxyURL)) return null;
  const u = new URL(a.proxyURL);
  const w = a.width && a.width > 0 ? a.width : 0;
  const h = a.height && a.height > 0 ? a.height : 0;
  if (w > 0 && h > 0) {
    const scale = Math.min(1, maxSide / Math.max(w, h));
    u.searchParams.set('width', String(Math.max(1, Math.round(w * scale))));
    u.searchParams.set('height', String(Math.max(1, Math.round(h * scale))));
  } else {
    u.searchParams.set('width', String(maxSide));
  }
  return u.toString();
}

function asRelayType(t: SniffedImageType | null): RelayImageType | null {
  return t === 'jpeg' || t === 'png' ? t : null;
}

export interface PreparedLineImages {
  images: QueuedLineImage[];
  /** Pictures that will reach LINE only as a note. */
  unsent: number;
}

/**
 * Copy the JPEG / PNG pictures (at most DISCORD_TO_LINE_MAX_IMAGES) into the
 * relay store and return LINE image refs. Without a relay (`relay` null)
 * nothing is downloaded and every picture counts as unsent. Never throws;
 * failures only raise `unsent`.
 */
export interface PrepareOptions {
  fetchImpl?: typeof fetch;
  /** Per-download timeout (default DISCORD_FETCH_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Total budget for all downloads of this message (default DISCORD_TO_LINE_PREP_BUDGET_MS). */
  budgetMs?: number;
}

/** A download's timeout within what is left of the message's budget; ≤ 0 → do not start it. */
function fetchTimeout(opts: PrepareOptions, deadline: number): number {
  return Math.min(opts.timeoutMs ?? DISCORD_FETCH_TIMEOUT_MS, deadline - Date.now());
}

export async function prepareLineImages(
  pictures: MirrorAttachmentLike[],
  relay: { store: RelayMediaStore; publicBaseUrl: string } | null,
  opts: PrepareOptions = {},
): Promise<PreparedLineImages> {
  const out: PreparedLineImages = { images: [], unsent: 0 };
  const deadline = Date.now() + (opts.budgetMs ?? DISCORD_TO_LINE_PREP_BUDGET_MS);
  for (const a of pictures) {
    const room = out.images.length < DISCORD_TO_LINE_MAX_IMAGES;
    // The copies already prepared for this message are never evicted to make room for the next one.
    const held = out.images.flatMap((i) => i.mediaIds);
    const prepared = relay && room ? await prepareOne(a, relay, opts, deadline, held) : null;
    if (prepared) out.images.push(prepared);
    else out.unsent += 1;
  }
  return out;
}

async function prepareOne(
  a: MirrorAttachmentLike,
  relay: { store: RelayMediaStore; publicBaseUrl: string },
  opts: PrepareOptions,
  deadline: number,
  held: readonly string[] = [],
): Promise<QueuedLineImage | null> {
  if (isSpoiler(a) || !declaredJpegOrPng(a)) return null;
  if (!(a.size > 0) || a.size > LINE_IMAGE_MAX_BYTES) return null;
  if (!isDiscordMediaUrl(a.url)) return null;

  const timeoutMs = fetchTimeout(opts, deadline);
  if (timeoutMs <= 0) return null;
  const original = await fetchCapped(a.url, { maxBytes: LINE_IMAGE_MAX_BYTES, fetchImpl: opts.fetchImpl, timeoutMs });
  if (!original.ok) return null;
  const type = asRelayType(sniffImageType(original.data));
  if (!type) return null; // declared JPEG/PNG but is not — never serve it
  const id = relay.store.put(original.data, type, held);
  if (!id) return null;

  let previewId = id;
  let previewType: RelayImageType = type;
  if (original.data.length > LINE_PREVIEW_MAX_BYTES) {
    const preview = await fetchPreview(a, opts, deadline);
    // The original stored a moment ago must not be evicted for its own preview.
    const pid = preview ? relay.store.put(preview.data, preview.type, [...held, id]) : null;
    if (!preview || !pid) {
      relay.store.delete(id);
      return null;
    }
    previewId = pid;
    previewType = preview.type;
  }

  const originalUrl = relayMediaUrl(relay.publicBaseUrl, id, type);
  const previewUrl = relayMediaUrl(relay.publicBaseUrl, previewId, previewType);
  const mediaIds = previewId === id ? [id] : [id, previewId];
  if (!isLineImageUrl(originalUrl) || !isLineImageUrl(previewUrl)) {
    for (const m of mediaIds) relay.store.delete(m);
    return null;
  }
  return { originalUrl, previewUrl, mediaIds };
}

async function fetchPreview(
  a: MirrorAttachmentLike,
  opts: PrepareOptions,
  deadline: number,
): Promise<{ data: Buffer; type: RelayImageType } | null> {
  for (const side of DISCORD_PREVIEW_SIDES) {
    const url = discordPreviewUrl(a, side);
    if (!url) return null;
    const timeoutMs = fetchTimeout(opts, deadline);
    if (timeoutMs <= 0) return null;
    const got = await fetchCapped(url, { maxBytes: LINE_PREVIEW_MAX_BYTES, fetchImpl: opts.fetchImpl, timeoutMs });
    if (!got.ok) continue;
    const type = asRelayType(sniffImageType(got.data));
    if (type) return { data: got.data, type };
  }
  return null;
}

/**
 * Handle one messageCreate in the sync channel. Returns an outcome code
 * (tests / counters). Never throws for platform errors.
 */
export async function handleDiscordMirrorMessage(
  message: MirrorMessageLike,
  deps: DiscordMirrorDeps,
): Promise<DiscordMirrorOutcome> {
  if (!deps.targetChannelId || message.channelId !== deps.targetChannelId) return 'ignored';
  if (message.author.bot) return 'ignored';
  if (message.webhookId) return 'ignored'; // webhook posts (e.g. /api/feedback relay) are not people talking

  const content = (message.content ?? '').trim();
  if (content.startsWith('[Avalon]')) return 'ignored';
  const attachments = message.attachments ? [...message.attachments.values()] : [];
  const stickers = message.stickers?.size ?? 0;
  if (!content && attachments.length === 0 && stickers === 0) return 'ignored';

  // 2026-10-12 community feedback: reduce this human message to topic
  // counts (numbers only, see bots/feedback). Independent of the mirror.
  if (content) deps.observe?.(content);

  const mirror = deps.mirror;
  if (!mirror) {
    deps.logger?.warn('[Discord→lobby] ChatMirror not initialised yet, dropping message');
    return 'no-mirror';
  }

  // Prefer guild nickname for recognisability; fall back to global username.
  const displayName =
    (message.member?.displayName ?? '').trim() ||
    message.author.globalName ||
    message.author.username ||
    '';

  const pictures = attachments.filter(isImageAttachment);
  const files = attachments.length - pictures.length;
  const hasMedia = attachments.length > 0 || stickers > 0;
  const marker = hasMedia ? discordMediaMarker({ images: pictures.length, files, stickers }) : '';

  // Rate limit + lobby NOW, before any download: the speaker's slot is taken
  // at arrival, so a burst of picture messages never reaches the CDN.
  const ingested = mirror.ingestInbound({
    source: 'discord',
    platformUserId: message.author.id,
    displayName,
    text: content,
    marker,
    messageId: `discord:${message.id}`,
    kind: content ? 'text' : 'media',
  });
  if (!ingested) return 'rate-limited';

  // A picture / sticker alone reaches LINE only when that is free (reply queue).
  if (!content && !mirror.lineOutboundUsesReplyQueue()) return 'media';

  // → LINE in arrival order (lobby-ingest callback already handled web clients).
  await mirror.relayDiscordToLine(
    ingested,
    hasMedia
      ? {
          prepare: async (relay): Promise<{ images: QueuedLineImage[]; note: string | null }> => {
            const prepared = await prepareLineImages(pictures, relay, {
              fetchImpl: deps.fetchImpl,
              timeoutMs: deps.timeoutMs,
              budgetMs: deps.budgetMs,
            });
            return { images: prepared.images, note: discordLeftoverNote({ images: prepared.unsent, files }) };
          },
        }
      : null,
  );
  return hasMedia ? 'media' : 'text';
}
