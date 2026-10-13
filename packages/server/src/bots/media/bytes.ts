/**
 * Byte helpers for the LINE ↔ Discord image sync (2026-10-13).
 *
 * - `sniffImageType` decides the format from the first bytes, never from a
 *   file name or a header the sender controls.
 * - `readStreamCapped` / `fetchCapped` stop reading as soon as a download
 *   passes its byte cap, so an oversized file never sits in memory.
 * - `describeError` turns an SDK / HTTP error into a short code for logs.
 *   SDK errors carry the request (LINE: the reply body with chat text and
 *   image URLs; Discord: the message content), so they are never logged whole.
 *
 * Nothing here logs.
 */

export type SniffedImageType = 'jpeg' | 'png' | 'gif' | 'webp';

/** Image format from magic bytes, or null when it is none of the four. */
export function sniffImageType(buf: Buffer | Uint8Array | null | undefined): SniffedImageType | null {
  if (!buf || buf.length < 4) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) {
    return 'png';
  }
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'gif';
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return 'webp';
  }
  return null;
}

/** File extension for an image type (Discord picks inline preview by extension). */
export function imageExtension(type: SniffedImageType | null): string {
  switch (type) {
    case 'png':
      return 'png';
    case 'gif':
      return 'gif';
    case 'webp':
      return 'webp';
    default:
      return 'jpg';
  }
}

export type CappedRead = { ok: true; data: Buffer } | { ok: false; reason: 'too-large' };

type ChunkSource = AsyncIterable<unknown> & { destroy?: (err?: Error) => void };

function toBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  if (typeof chunk === 'string') return Buffer.from(chunk);
  throw new TypeError('unexpected stream chunk');
}

/**
 * Read a stream (Node Readable or web ReadableStream) into one Buffer, giving
 * up — and destroying the stream — as soon as more than `maxBytes` arrived.
 */
export async function readStreamCapped(source: ChunkSource, maxBytes: number): Promise<CappedRead> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const raw of source) {
    const chunk = toBuffer(raw);
    total += chunk.length;
    if (total > maxBytes) {
      try {
        source.destroy?.();
      } catch {
        /* already closed */
      }
      return { ok: false, reason: 'too-large' };
    }
    chunks.push(chunk);
  }
  return { ok: true, data: Buffer.concat(chunks, total) };
}

export type FetchCappedResult =
  | { ok: true; data: Buffer }
  | { ok: false; reason: 'too-large' | 'http' | 'network' | 'timeout'; status?: number };

export interface FetchCappedOptions {
  maxBytes: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * GET `url` and return at most `maxBytes` bytes. A Content-Length over the
 * cap is refused before any body is read; a body that grows past the cap is
 * aborted. Never throws.
 */
export async function fetchCapped(url: string, opts: FetchCappedOptions): Promise<FetchCappedResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20_000);
  try {
    const res = await fetchImpl(url, { signal: controller.signal, redirect: 'follow' });
    if (!res.ok) return { ok: false, reason: 'http', status: res.status };
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > opts.maxBytes) {
      controller.abort();
      return { ok: false, reason: 'too-large' };
    }
    if (!res.body) return { ok: true, data: Buffer.alloc(0) };
    const body = res.body as unknown as AsyncIterable<unknown> & { cancel?: () => Promise<void> };
    const read = await readStreamCapped(
      Object.assign(body, {
        destroy: () => {
          controller.abort();
        },
      }),
      opts.maxBytes,
    );
    return read.ok ? read : { ok: false, reason: 'too-large' };
  } catch {
    return { ok: false, reason: controller.signal.aborted ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Short, log-safe description of an error: class name, HTTP status and
 * error code only. Never the message body, request or response.
 */
export function describeError(err: unknown): string {
  if (!err || typeof err !== 'object') return typeof err;
  const e = err as {
    name?: unknown;
    status?: unknown;
    statusCode?: unknown;
    httpStatus?: unknown;
    code?: unknown;
  };
  const parts: string[] = [typeof e.name === 'string' ? e.name : 'Error'];
  const status = [e.status, e.statusCode, e.httpStatus].find((v) => typeof v === 'number');
  if (typeof status === 'number') parts.push(`status=${status}`);
  if (typeof e.code === 'string' || typeof e.code === 'number') parts.push(`code=${String(e.code).slice(0, 40)}`);
  return parts.join(' ');
}
