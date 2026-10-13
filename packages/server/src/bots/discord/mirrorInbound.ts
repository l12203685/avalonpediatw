/**
 * Discord sync channel → lobby + LINE (#82), with pictures (2026-10-13).
 *
 * Kept out of client.ts so it can be tested without a discord.js gateway:
 * `handleDiscordMirrorMessage()` takes a structural slice of a discord.js
 * Message.
 *
 * Text only (no attachments / stickers): exactly the pre-2026-10-13 path —
 * ingestInbound → lobby, crossFanout → LINE reply queue.
 *
 * With attachments / stickers:
 *   1. JPEG / PNG pictures ≤ 10 MB (not spoilers) are downloaded NOW from
 *      the Discord CDN — the signed link expires, and LINE may only fetch
 *      the picture hours later when the reply queue drains — and kept in the
 *      relay store (bots/media/relayMedia.ts). A picture over 1 MB also gets
 *      a ≤ 1 MB preview from Discord's media proxy (resized); no preview →
 *      the picture is not sent (LINE requires one).
 *   2. The lobby / LINE text line is the message text plus a marker
 *      (「（圖片）」「（圖片 ×2、檔案）」「（貼圖）」); attachment-only → marker only.
 *   3. LINE gets, back to back on the reply queue: that text line, one LINE
 *      image message per prepared picture, and one note for the rest
 *      (「（Discord 有一張圖片，請到 Discord 看）」 for webp / gif / heic /
 *      spoiler / too large / failed downloads, 「…個檔案…」 for other files).
 *   Pictures only go to LINE in reply-queue mode (free); otherwise just the
 *   text line, as before. Rate-limited or loop-tagged messages download nothing.
 *
 * Nothing here logs text, names, file names or URLs.
 */

import {
  ChatMirror,
  discordLeftoverNote,
  discordMediaMarker,
  withMediaMarker,
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
export async function prepareLineImages(
  pictures: MirrorAttachmentLike[],
  relay: { store: RelayMediaStore; publicBaseUrl: string } | null,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<PreparedLineImages> {
  const out: PreparedLineImages = { images: [], unsent: 0 };
  for (const a of pictures) {
    const room = out.images.length < DISCORD_TO_LINE_MAX_IMAGES;
    const prepared = relay && room ? await prepareOne(a, relay, opts) : null;
    if (prepared) out.images.push(prepared);
    else out.unsent += 1;
  }
  return out;
}

async function prepareOne(
  a: MirrorAttachmentLike,
  relay: { store: RelayMediaStore; publicBaseUrl: string },
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<QueuedLineImage | null> {
  if (isSpoiler(a) || !declaredJpegOrPng(a)) return null;
  if (!(a.size > 0) || a.size > LINE_IMAGE_MAX_BYTES) return null;
  if (!isDiscordMediaUrl(a.url)) return null;

  const original = await fetchCapped(a.url, { maxBytes: LINE_IMAGE_MAX_BYTES, fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs });
  if (!original.ok) return null;
  const type = asRelayType(sniffImageType(original.data));
  if (!type) return null; // declared JPEG/PNG but is not — never serve it
  const id = relay.store.put(original.data, type);
  if (!id) return null;

  let previewId = id;
  let previewType: RelayImageType = type;
  if (original.data.length > LINE_PREVIEW_MAX_BYTES) {
    const preview = await fetchPreview(a, opts);
    const pid = preview ? relay.store.put(preview.data, preview.type) : null;
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
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<{ data: Buffer; type: RelayImageType } | null> {
  for (const side of DISCORD_PREVIEW_SIDES) {
    const url = discordPreviewUrl(a, side);
    if (!url) return null;
    const got = await fetchCapped(url, { maxBytes: LINE_PREVIEW_MAX_BYTES, fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs });
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

  if (attachments.length === 0 && stickers === 0) {
    const ingested = mirror.ingestInbound({
      source: 'discord',
      platformUserId: message.author.id,
      displayName,
      text: content,
      messageId: `discord:${message.id}`,
    });
    if (!ingested) return 'rate-limited';
    // Cross-push to LINE (lobby-ingest callback handles web clients).
    mirror.crossFanout(ingested).catch(() => {
      deps.logger?.warn('[Discord→LINE] crossFanout rejected');
    });
    return 'text';
  }

  const pictures = attachments.filter(isImageAttachment);
  const files = attachments.length - pictures.length;
  const marker = discordMediaMarker({ images: pictures.length, files, stickers });
  const text = withMediaMarker(content, marker);

  // Rate limit BEFORE downloading anything (a flood never touches the CDN).
  if (!mirror.wouldAdmitInbound('discord', message.author.id)) return 'rate-limited';

  const prepared = await prepareLineImages(pictures, mirror.lineImageRelay(), {
    fetchImpl: deps.fetchImpl,
    timeoutMs: deps.timeoutMs,
  });

  const ingested = mirror.ingestInbound({
    source: 'discord',
    platformUserId: message.author.id,
    displayName,
    text,
    messageId: `discord:${message.id}`,
  });
  if (!ingested) {
    mirror.releaseRelayMedia(prepared.images.flatMap((i) => i.mediaIds));
    return 'rate-limited';
  }
  const note = discordLeftoverNote({ images: prepared.unsent, files });
  await mirror.crossFanoutWithLineMedia(ingested, prepared.images, note);
  return 'media';
}
