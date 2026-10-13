/**
 * Relay media store + route — Discord → LINE images (2026-10-13).
 *
 * Why this exists: a LINE image message is only two HTTPS URLs
 * (originalContentUrl ≤ 10 MB, previewImageUrl ≤ 1 MB, JPEG/PNG) that LINE
 * fetches itself. Outbound LINE goes through the reply_token queue, so the
 * message may leave hours after the Discord post — long after a signed
 * Discord CDN link could have expired. So the server copies the image when
 * the Discord message arrives and serves the copy from its own public URL:
 *
 *   GET /media/relay/<32-char random id>.jpg|png
 *
 * - The id is 192 random bits (unguessable); it is never logged and never
 *   shown on /api/bots/status. Unknown, expired or malformed ids → 404.
 * - In memory only, total ≤ MEDIA_RELAY_MAX_TOTAL_BYTES (50 MB). Each entry
 *   lives MEDIA_RELAY_TTL_MS (72 h); when a reply actually carries it, it is
 *   marked sent and its life is extended to at least
 *   MEDIA_RELAY_AFTER_SEND_MS (24 h) from then, in case LINE fetches the full
 *   image only when someone opens it. Adding past the cap evicts expired
 *   entries first, then the oldest NOT yet sent (that picture later goes to
 *   LINE as its text note), and only then the oldest sent one — a sent copy
 *   that disappears would be a silently broken image in LINE.
 * - A restart empties the store (and the reply queue, which is in memory
 *   too). On Render every deploy is a restart, and the daily stats-cache
 *   commit deploys at least once a day, so "72 h" is an upper bound. A
 *   queued image whose copy is gone goes out as a text note instead.
 * - Free: no storage service, no paid API.
 */

import crypto from 'crypto';
import type { Request, Response } from 'express';

export const MEDIA_RELAY_PATH = '/media/relay';
export const MEDIA_RELAY_TTL_MS = 72 * 60 * 60 * 1000;
export const MEDIA_RELAY_AFTER_SEND_MS = 24 * 60 * 60 * 1000;
export const MEDIA_RELAY_MAX_TOTAL_BYTES = 50 * 1024 * 1024;

/**
 * LINE image message limits (Messaging API reference, image message object:
 * original ≤ 10 MB, preview ≤ 1 MB). Decimal megabytes, the stricter reading.
 */
export const LINE_IMAGE_MAX_BYTES = 10_000_000;
export const LINE_PREVIEW_MAX_BYTES = 1_000_000;
export const LINE_IMAGE_URL_MAX_CHARS = 2000;

/** Discord attachment upload limit for bots by server boost tier (2024-09 onward). */
export const DISCORD_DEFAULT_UPLOAD_BYTES = 10 * 1024 * 1024;

export function discordUploadLimitBytes(premiumTier: number | null | undefined): number {
  if (premiumTier === 3) return 100 * 1024 * 1024;
  if (premiumTier === 2) return 50 * 1024 * 1024;
  return DISCORD_DEFAULT_UPLOAD_BYTES;
}

export type RelayImageType = 'jpeg' | 'png';

const ID_RE = /^[A-Za-z0-9_-]{32}$/;
const FILE_RE = /^([A-Za-z0-9_-]{32})\.(jpg|png)$/;
const EXT: Record<RelayImageType, 'jpg' | 'png'> = { jpeg: 'jpg', png: 'png' };
const CONTENT_TYPE: Record<RelayImageType, string> = { jpeg: 'image/jpeg', png: 'image/png' };

interface Entry {
  data: Buffer;
  type: RelayImageType;
  expiresAt: number;
  /** A reply carried this copy to LINE (keepAlive); evicted only after unsent ones. */
  sent: boolean;
}

/** Counters for /api/bots/status — numbers only. */
export interface RelayMediaStats {
  entries: number;
  bytes: number;
  stored: number;
  evicted: number;
  expired: number;
  served: number;
  notFound: number;
}

export interface RelayMediaStoreOptions {
  ttlMs?: number;
  maxTotalBytes?: number;
  now?: () => number;
  /** Test hook; must return 32 chars of [A-Za-z0-9_-]. */
  newId?: () => string;
}

export class RelayMediaStore {
  /** Insertion order = age (Map keeps it), so the first key is the oldest. */
  private readonly entries = new Map<string, Entry>();
  private bytes = 0;
  private readonly ttlMs: number;
  private readonly maxTotalBytes: number;
  private readonly now: () => number;
  private readonly newId: () => string;
  private counters = { stored: 0, evicted: 0, expired: 0, served: 0, notFound: 0 };

  constructor(opts: RelayMediaStoreOptions = {}) {
    this.ttlMs = opts.ttlMs ?? MEDIA_RELAY_TTL_MS;
    this.maxTotalBytes = opts.maxTotalBytes ?? MEDIA_RELAY_MAX_TOTAL_BYTES;
    this.now = opts.now ?? Date.now;
    this.newId = opts.newId ?? ((): string => crypto.randomBytes(24).toString('base64url'));
  }

  /**
   * Keep a copy; returns its id, or null when the item alone exceeds the
   * total cap or is empty. Makes room by dropping expired items, then the
   * oldest unsent ones, then the oldest sent ones — never the ids in `keep`
   * (the copies already prepared for the same message, e.g. a picture's
   * original while its preview is stored: review fix 2026-10-13); null when
   * there is no room without them.
   */
  put(data: Buffer, type: RelayImageType, keep: readonly string[] = []): string | null {
    if (data.length === 0 || data.length > this.maxTotalBytes) return null;
    this.sweep();
    const kept = new Set(keep);
    let keptBytes = 0;
    for (const id of kept) keptBytes += this.entries.get(id)?.data.length ?? 0;
    if (keptBytes + data.length > this.maxTotalBytes) return null;
    for (const evictSent of [false, true]) {
      for (const [id, e] of this.entries) {
        if (this.bytes + data.length <= this.maxTotalBytes) break;
        if (e.sent !== evictSent || kept.has(id)) continue;
        this.remove(id);
        this.counters.evicted += 1;
      }
    }
    let id = this.newId();
    while (this.entries.has(id)) id = this.newId();
    if (!ID_RE.test(id)) throw new Error('RelayMediaStore id must be 32 url-safe characters');
    this.entries.set(id, { data, type, expiresAt: this.now() + this.ttlMs, sent: false });
    this.bytes += data.length;
    this.counters.stored += 1;
    return id;
  }

  /** The live entry, or null (unknown or expired; an expired one is dropped). */
  get(id: string): { data: Buffer; type: RelayImageType; expiresAt: number } | null {
    const e = this.entries.get(id);
    if (!e) return null;
    if (e.expiresAt <= this.now()) {
      this.remove(id);
      this.counters.expired += 1;
      return null;
    }
    return { data: e.data, type: e.type, expiresAt: e.expiresAt };
  }

  has(id: string): boolean {
    return this.get(id) !== null;
  }

  /**
   * True when `id` is live; its expiry is moved to at least now + `minMs`
   * and it is marked sent (used when a reply is about to carry the URL to
   * LINE). Callers check every id of an image with has() first, so a
   * picture whose preview is gone does not pin its original.
   */
  keepAlive(id: string, minMs: number = MEDIA_RELAY_AFTER_SEND_MS): boolean {
    const e = this.entries.get(id);
    if (!e || e.expiresAt <= this.now()) {
      if (e) {
        this.remove(id);
        this.counters.expired += 1;
      }
      return false;
    }
    e.expiresAt = Math.max(e.expiresAt, this.now() + minMs);
    e.sent = true;
    return true;
  }

  delete(id: string): void {
    this.remove(id);
  }

  /** Drop every expired entry. */
  sweep(): void {
    const now = this.now();
    for (const [id, e] of this.entries) {
      if (e.expiresAt <= now) {
        this.remove(id);
        this.counters.expired += 1;
      }
    }
  }

  stats(): RelayMediaStats {
    this.sweep();
    return { entries: this.entries.size, bytes: this.bytes, ...this.counters };
  }

  /** Route bookkeeping (served / 404), kept here so the status page has one source. */
  noteServed(found: boolean): void {
    if (found) this.counters.served += 1;
    else this.counters.notFound += 1;
  }

  private remove(id: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    this.entries.delete(id);
    this.bytes -= e.data.length;
  }
}

/** Public URL of a stored item: `<base>/media/relay/<id>.<ext>`. */
export function relayMediaUrl(publicBaseUrl: string, id: string, type: RelayImageType): string {
  return `${publicBaseUrl.replace(/\/+$/, '')}${MEDIA_RELAY_PATH}/${id}.${EXT[type]}`;
}

/** True for an https URL LINE accepts as an image URL. */
export function isLineImageUrl(url: string): boolean {
  return /^https:\/\//i.test(url) && url.length <= LINE_IMAGE_URL_MAX_CHARS;
}

/**
 * Express handler for `GET /media/relay/:file`. 404 (empty body) for
 * anything that is not a live id with the matching extension. No logging.
 * Only GET counts as served / notFound: Express answers HEAD with the same
 * handler, and `served` is the post-launch check that LINE fetched a picture.
 */
export function createRelayMediaHandler(store: RelayMediaStore): (req: Request, res: Response) => void {
  return (req, res) => {
    const counted = req.method !== 'HEAD';
    const m = FILE_RE.exec(String(req.params.file ?? ''));
    const entry = m ? store.get(m[1]) : null;
    if (!m || !entry || EXT[entry.type] !== m[2]) {
      if (counted) store.noteServed(false);
      res.status(404).set('Cache-Control', 'no-store').end();
      return;
    }
    if (counted) store.noteServed(true);
    const maxAge = Math.max(0, Math.floor((entry.expiresAt - Date.now()) / 1000));
    res
      .status(200)
      .set({
        'Content-Type': CONTENT_TYPE[entry.type],
        'Content-Length': String(entry.data.length),
        'Cache-Control': `private, max-age=${Math.min(maxAge, 86_400)}`,
        'X-Content-Type-Options': 'nosniff',
        'X-Robots-Tag': 'noindex, nofollow',
        'Referrer-Policy': 'no-referrer',
      })
      .end(entry.data);
  };
}
