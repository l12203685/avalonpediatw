/**
 * Relay media store + GET /media/relay/:file (Discord → LINE pictures,
 * 2026-10-13) and the small byte / URL helpers behind the image sync.
 * Synthetic bytes only — no real pictures, no network.
 */
import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'stream';
import express from 'express';
import request from 'supertest';
import {
  MEDIA_RELAY_PATH,
  MEDIA_RELAY_TTL_MS,
  RelayMediaStore,
  createRelayMediaHandler,
  discordUploadLimitBytes,
  isLineImageUrl,
  relayMediaUrl,
} from '../bots/media/relayMedia';
import { describeError, fetchCapped, raceTimeout, readStreamCapped, sniffImageType } from '../bots/media/bytes';
import { mirrorChannelAdapter, type MirrorChannelSendPayload } from '../bots/discord/mirrorChannel';
import { ChatMirror } from '../bots/ChatMirror';
import { resolvePublicBaseUrl } from '../bots/line/webhookEndpoint';
import { degradeAfterFailedReply, LineReplyQueue, type QueuedLineItem } from '../bots/line/replyQueue';

const JPEG_HEAD = [0xff, 0xd8, 0xff, 0xe0];
const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function jpeg(size: number, fill = 1): Buffer {
  const b = Buffer.alloc(size, fill);
  Buffer.from(JPEG_HEAD).copy(b);
  return b;
}
function png(size: number): Buffer {
  const b = Buffer.alloc(size, 2);
  Buffer.from(PNG_HEAD).copy(b);
  return b;
}

function clock(start = 1_800_000_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

function appFor(store: RelayMediaStore): express.Express {
  const app = express();
  app.get(`${MEDIA_RELAY_PATH}/:file`, createRelayMediaHandler(store));
  return app;
}

function pathOf(url: string): string {
  return new URL(url).pathname;
}

describe('RelayMediaStore', () => {
  it('ids are 32 url-safe random characters and differ every time', () => {
    const store = new RelayMediaStore();
    const a = store.put(jpeg(10), 'jpeg')!;
    const b = store.put(jpeg(10), 'jpeg')!;
    expect(a).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(b).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(a).not.toBe(b);
  });

  it('expires entries after the TTL (72 h by default)', () => {
    const c = clock();
    const store = new RelayMediaStore({ now: c.now });
    const id = store.put(jpeg(10), 'jpeg')!;
    c.advance(MEDIA_RELAY_TTL_MS - 1);
    expect(store.has(id)).toBe(true);
    c.advance(1);
    expect(store.has(id)).toBe(false);
    expect(store.stats()).toMatchObject({ entries: 0, bytes: 0, expired: 1 });
  });

  it('keeps the total under the byte cap by evicting the oldest first', () => {
    const store = new RelayMediaStore({ maxTotalBytes: 100 });
    const a = store.put(jpeg(40), 'jpeg')!;
    const b = store.put(jpeg(40), 'jpeg')!;
    const c = store.put(jpeg(40), 'jpeg')!;
    expect(store.has(a)).toBe(false);
    expect(store.has(b)).toBe(true);
    expect(store.has(c)).toBe(true);
    expect(store.stats()).toMatchObject({ entries: 2, bytes: 80, evicted: 1, stored: 3 });
  });

  it('refuses an item larger than the whole cap, and empty items', () => {
    const store = new RelayMediaStore({ maxTotalBytes: 100 });
    expect(store.put(jpeg(101), 'jpeg')).toBeNull();
    expect(store.put(Buffer.alloc(0), 'jpeg')).toBeNull();
    expect(store.stats().entries).toBe(0);
  });

  it('stats are whole numbers only — never an id', () => {
    const store = new RelayMediaStore();
    const id = store.put(jpeg(10), 'jpeg')!;
    const st = store.stats();
    for (const v of Object.values(st)) expect(Number.isInteger(v)).toBe(true);
    expect(JSON.stringify(st)).not.toContain(id);
  });

  it('keepAlive extends a live entry to at least now + minMs, and is false once gone', () => {
    const c = clock();
    const store = new RelayMediaStore({ now: c.now, ttlMs: 1000 });
    const id = store.put(jpeg(10), 'jpeg')!;
    c.advance(900);
    expect(store.keepAlive(id, 5000)).toBe(true);
    c.advance(4000);
    expect(store.has(id)).toBe(true); // would have expired at 1000 without keepAlive
    c.advance(1000);
    expect(store.keepAlive(id, 5000)).toBe(false);
    expect(store.keepAlive('x'.repeat(32), 5000)).toBe(false);
  });

  it('the byte cap evicts copies not yet sent before copies already sent to LINE', () => {
    const store = new RelayMediaStore({ maxTotalBytes: 3000 });
    const sent = store.put(jpeg(1000), 'jpeg')!;
    store.keepAlive(sent); // a reply carried it
    const unsentOld = store.put(jpeg(1000), 'jpeg')!;
    const unsentNew = store.put(jpeg(1000), 'jpeg')!;
    const newest = store.put(jpeg(1000), 'jpeg')!;
    expect(store.has(sent)).toBe(true);
    expect(store.has(unsentOld)).toBe(false);
    expect(store.has(unsentNew)).toBe(true);
    expect(store.has(newest)).toBe(true);
  });

  it('never evicts the ids in `keep` (a picture\'s original while its preview is stored); null when there is no room without them', () => {
    const store = new RelayMediaStore({ maxTotalBytes: 10_000 });
    const sent = Array.from({ length: 4 }, () => store.put(jpeg(2000), 'jpeg')!);
    for (const id of sent) store.keepAlive(id); // 8 KB already sent to LINE
    const original = store.put(jpeg(2000), 'jpeg')!; // the new picture: cap reached
    const preview = store.put(jpeg(500), 'jpeg', [original])!;
    expect(store.has(original)).toBe(true); // before: the unsent original was evicted for its own preview
    expect(store.has(preview)).toBe(true);
    expect(sent.filter((id) => store.has(id))).toHaveLength(3); // the oldest sent copy made room instead
    // Kept ids alone leave no room: refused, nothing evicted.
    const tight = new RelayMediaStore({ maxTotalBytes: 1000 });
    const a = tight.put(jpeg(800), 'jpeg')!;
    expect(tight.put(jpeg(300), 'jpeg', [a])).toBeNull();
    expect(tight.has(a)).toBe(true);
  });

  it('when only sent copies are left, the oldest sent one goes', () => {
    const store = new RelayMediaStore({ maxTotalBytes: 2000 });
    const a = store.put(jpeg(1000), 'jpeg')!;
    const b = store.put(jpeg(1000), 'jpeg')!;
    store.keepAlive(a);
    store.keepAlive(b);
    const c = store.put(jpeg(1000), 'jpeg')!;
    expect([store.has(a), store.has(b), store.has(c)]).toEqual([false, true, true]);
    expect(store.stats()).toMatchObject({ entries: 2, bytes: 2000, evicted: 1 });
  });
});

describe('raceTimeout', () => {
  it('returns the work result when it is first', async () => {
    expect(await raceTimeout(Promise.resolve('done'), 1000, () => 'late')).toBe('done');
  });

  it('returns the fallback when the work never settles', async () => {
    expect(await raceTimeout(new Promise<string>(() => {}), 10, () => 'timeout')).toBe('timeout');
  });

  it('passes a rejection through, and ignores one that comes after the timeout', async () => {
    await expect(raceTimeout(Promise.reject(new Error('x')), 1000, () => 'late')).rejects.toThrow('x');
    let rejectLate: (e: Error) => void = () => {};
    const late = new Promise<string>((_, reject) => {
      rejectLate = reject;
    });
    expect(await raceTimeout(late, 5, () => 'timeout')).toBe('timeout');
    rejectLate(new Error('after')); // must not surface as an unhandled rejection
    await new Promise((r) => setTimeout(r, 5));
  });
});

describe('mirrorChannelAdapter (bots/index.ts Discord wiring)', () => {
  function channel(premiumTier?: number | null): { ch: Parameters<typeof mirrorChannelAdapter>[0]; calls: MirrorChannelSendPayload[] } {
    const calls: MirrorChannelSendPayload[] = [];
    return {
      calls,
      ch: {
        send: async (p: MirrorChannelSendPayload) => {
          calls.push(p);
          return {};
        },
        guild: premiumTier === undefined ? null : { premiumTier },
      },
    };
  }

  it('text and files both go with mentions disabled (a relayed "@everyone" or <@id> never pings)', async () => {
    const { ch, calls } = channel(0);
    const adapter = mirrorChannelAdapter(ch);
    await adapter.send('[1013 21:00][LINE][@everyone] <@123456789012345678> hello');
    const data = jpeg(10);
    await adapter.sendFiles!('[x] （圖片）', [{ name: 'line-image.jpg', data }]);
    expect(calls[0]).toEqual({ content: '[1013 21:00][LINE][@everyone] <@123456789012345678> hello', allowedMentions: { parse: [] } });
    expect(calls[1]).toEqual({
      content: '[x] （圖片）',
      files: [{ attachment: data, name: 'line-image.jpg' }],
      allowedMentions: { parse: [] },
    });
  });

  it('upload limit follows the server boost tier (10 MB default)', () => {
    expect(mirrorChannelAdapter(channel().ch).maxUploadBytes).toBe(10 * 1024 * 1024);
    expect(mirrorChannelAdapter(channel(1).ch).maxUploadBytes).toBe(10 * 1024 * 1024);
    expect(mirrorChannelAdapter(channel(2).ch).maxUploadBytes).toBe(50 * 1024 * 1024);
    expect(mirrorChannelAdapter(channel(3).ch).maxUploadBytes).toBe(100 * 1024 * 1024);
  });
});

describe('ChatMirror default error logger', () => {
  it('prints a short code, never the error object or a trailing "undefined"', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const mirror = new ChatMirror();
      mirror.setLobbyIngest(() => {
        throw Object.assign(new Error('secret chat text'), { name: 'BoomError', code: 'E1' });
      });
      mirror.ingestInbound({ source: 'line', platformUserId: 'U', displayName: 'n', text: 'hi', messageId: 'x' });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]).toEqual(['[ChatMirror] lobbyIngest threw (BoomError code=E1)']);
    } finally {
      spy.mockRestore();
    }
  });
});

describe(`GET ${MEDIA_RELAY_PATH}/:file`, () => {
  const BASE = 'https://avalon.example.test';

  it('serves a valid id with the stored bytes and safe headers', async () => {
    const store = new RelayMediaStore();
    const bytes = jpeg(2048);
    const id = store.put(bytes, 'jpeg')!;
    const res = await request(appFor(store)).get(pathOf(relayMediaUrl(BASE, id, 'jpeg'))).buffer(true);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(Number(res.headers['content-length'])).toBe(2048);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-robots-tag']).toContain('noindex');
    expect(Buffer.compare(res.body as Buffer, bytes)).toBe(0);
    expect(store.stats().served).toBe(1);
  });

  it('serves PNG with image/png', async () => {
    const store = new RelayMediaStore();
    const id = store.put(png(100), 'png')!;
    const res = await request(appFor(store)).get(`${MEDIA_RELAY_PATH}/${id}.png`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
  });

  it('404s an expired id', async () => {
    const c = clock();
    const store = new RelayMediaStore({ now: c.now, ttlMs: 1000 });
    const id = store.put(jpeg(10), 'jpeg')!;
    c.advance(1000);
    const res = await request(appFor(store)).get(`${MEDIA_RELAY_PATH}/${id}.jpg`);
    expect(res.status).toBe(404);
    expect(res.text ?? '').toBe('');
  });

  it('404s an unknown id, a malformed name and the wrong extension', async () => {
    const store = new RelayMediaStore();
    const id = store.put(jpeg(10), 'jpeg')!;
    const app = appFor(store);
    for (const file of [`${'A'.repeat(32)}.jpg`, `${id}.png`, `${id}`, `${id}.jpg.exe`, '..%2F..%2Fetc%2Fpasswd', `${id.slice(1)}.jpg`]) {
      const res = await request(app).get(`${MEDIA_RELAY_PATH}/${file}`);
      expect(res.status).toBe(404);
    }
    expect(store.stats().notFound).toBe(6);
  });

  it('HEAD answers like GET but counts neither as served nor as notFound (served = LINE fetched the picture)', async () => {
    const store = new RelayMediaStore();
    const id = store.put(jpeg(64), 'jpeg')!;
    const app = appFor(store);
    const head = await request(app).head(`${MEDIA_RELAY_PATH}/${id}.jpg`);
    expect(head.status).toBe(200);
    expect((await request(app).head(`${MEDIA_RELAY_PATH}/${'B'.repeat(32)}.jpg`)).status).toBe(404);
    expect(store.stats()).toMatchObject({ served: 0, notFound: 0 });
    await request(app).get(`${MEDIA_RELAY_PATH}/${id}.jpg`);
    expect(store.stats()).toMatchObject({ served: 1, notFound: 0 });
  });

  it('404s an id evicted by the byte cap', async () => {
    const store = new RelayMediaStore({ maxTotalBytes: 100 });
    const first = store.put(jpeg(60), 'jpeg')!;
    const second = store.put(jpeg(60), 'jpeg')!;
    const app = appFor(store);
    expect((await request(app).get(`${MEDIA_RELAY_PATH}/${first}.jpg`)).status).toBe(404);
    expect((await request(app).get(`${MEDIA_RELAY_PATH}/${second}.jpg`)).status).toBe(200);
  });
});

describe('media helpers', () => {
  it('sniffImageType reads magic bytes only', () => {
    expect(sniffImageType(jpeg(8))).toBe('jpeg');
    expect(sniffImageType(png(16))).toBe('png');
    expect(sniffImageType(Buffer.from('GIF89a......'))).toBe('gif');
    expect(sniffImageType(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('webp');
    expect(sniffImageType(Buffer.from('<svg xmlns='))).toBeNull();
    expect(sniffImageType(Buffer.alloc(2))).toBeNull();
  });

  it('readStreamCapped stops pulling once the cap is passed', async () => {
    let pulled = 0;
    function* chunks(): Generator<Buffer> {
      for (let i = 0; i < 1000; i++) {
        pulled += 1;
        yield Buffer.alloc(1024);
      }
    }
    const r = await readStreamCapped(Readable.from(chunks()), 4096);
    expect(r).toEqual({ ok: false, reason: 'too-large' });
    expect(pulled).toBeLessThan(10);
    const ok = await readStreamCapped(Readable.from([Buffer.alloc(10), Buffer.alloc(5)]), 4096);
    expect(ok.ok && ok.data.length).toBe(15);
  });

  it('fetchCapped refuses a declared Content-Length over the cap without reading', async () => {
    const fetchImpl = (async () =>
      new Response(new Uint8Array(10), { status: 200, headers: { 'content-length': '999999' } })) as unknown as typeof fetch;
    expect(await fetchCapped('https://cdn.discordapp.com/x', { maxBytes: 100, fetchImpl })).toEqual({ ok: false, reason: 'too-large' });
  });

  it('fetchCapped reports http errors and network errors as codes', async () => {
    const notFound = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
    expect(await fetchCapped('https://cdn.discordapp.com/x', { maxBytes: 100, fetchImpl: notFound })).toEqual({ ok: false, reason: 'http', status: 404 });
    const broken = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect(await fetchCapped('https://cdn.discordapp.com/x', { maxBytes: 100, fetchImpl: broken })).toEqual({ ok: false, reason: 'network' });
  });

  it('describeError keeps name / status / code and drops everything else', () => {
    const err = Object.assign(new Error('Request failed'), {
      name: 'HTTPError',
      statusCode: 400,
      originalError: { config: { data: '{"messages":[{"type":"text","text":"secret chat"}]}' } },
    });
    const d = describeError(err);
    expect(d).toBe('HTTPError status=400');
    expect(d).not.toContain('secret');
    expect(describeError(Object.assign(new Error('x'), { name: 'DiscordAPIError', status: 403, code: 50013, requestBody: { json: { content: 'hi' } } }))).toBe(
      'DiscordAPIError status=403 code=50013',
    );
  });

  it('discordUploadLimitBytes: 10 MB unless the server is boosted to tier 2 / 3', () => {
    expect(discordUploadLimitBytes(undefined)).toBe(10 * 1024 * 1024);
    expect(discordUploadLimitBytes(1)).toBe(10 * 1024 * 1024);
    expect(discordUploadLimitBytes(2)).toBe(50 * 1024 * 1024);
    expect(discordUploadLimitBytes(3)).toBe(100 * 1024 * 1024);
  });

  it('isLineImageUrl: https only, ≤ 2000 chars', () => {
    expect(isLineImageUrl('https://a.test/media/relay/x.jpg')).toBe(true);
    expect(isLineImageUrl('http://a.test/x.jpg')).toBe(false);
    expect(isLineImageUrl(`https://a.test/${'x'.repeat(2000)}`)).toBe(false);
  });
});

describe('resolvePublicBaseUrl', () => {
  it('prefers PUBLIC_BASE_URL, then RENDER_EXTERNAL_URL (trailing slash removed)', () => {
    expect(resolvePublicBaseUrl({ PUBLIC_BASE_URL: 'https://a.test/', RENDER_EXTERNAL_URL: 'https://b.test' })).toBe('https://a.test');
    expect(resolvePublicBaseUrl({ RENDER_EXTERNAL_URL: 'https://svc.onrender.com' })).toBe('https://svc.onrender.com');
  });

  it('falls back to the origin (and path prefix) of LINE_WEBHOOK_URL', () => {
    expect(resolvePublicBaseUrl({ LINE_WEBHOOK_URL: 'https://h.test/webhook/line' })).toBe('https://h.test');
    expect(resolvePublicBaseUrl({ LINE_WEBHOOK_URL: 'https://h.test/api/webhook/line' })).toBe('https://h.test/api');
    expect(resolvePublicBaseUrl({ LINE_WEBHOOK_URL: 'https://h.test/line/webhook/avalon' })).toBe('https://h.test');
  });

  it('is null without an https base', () => {
    expect(resolvePublicBaseUrl({})).toBeNull();
    expect(resolvePublicBaseUrl({ PUBLIC_BASE_URL: 'http://localhost:3001' })).toBeNull();
    expect(resolvePublicBaseUrl({ LINE_WEBHOOK_URL: 'http://h.test/webhook/line' })).toBeNull();
  });
});

describe('reply queue items with images', () => {
  const image = (n: number) => ({
    originalUrl: `https://a.test/media/relay/${String(n).padStart(32, 'o')}.jpg`,
    previewUrl: `https://a.test/media/relay/${String(n).padStart(32, 'p')}.jpg`,
    mediaIds: [String(n).padStart(32, 'o'), String(n).padStart(32, 'p')],
  });

  it('keep their order and their image through drain / requeueFront', () => {
    const q = new LineReplyQueue();
    q.enqueue('t0', 1);
    q.enqueueItem({ text: 'note', enqueuedAt: 2, image: image(1) });
    q.enqueue('t2', 3);
    expect(q.imageCount()).toBe(1);
    const batch = q.drain();
    expect(batch.map((b) => (b.image ? 'IMG' : b.text))).toEqual(['t0', 'IMG', 't2']);
    q.requeueFront(batch);
    expect(q.drain()).toEqual(batch);
  });

  it('degradeAfterFailedReply: texts untouched; an image retries once, then becomes its note', () => {
    const batch: QueuedLineItem[] = [
      { text: 'a', enqueuedAt: 1 },
      { text: 'note', enqueuedAt: 2, image: image(1) },
    ];
    const first = degradeAfterFailedReply(batch);
    expect(first.retry[0]).toBe(batch[0]);
    expect(first.retry[1].image?.failedAttempts).toBe(1);
    expect(first.degraded).toBe(0);
    const second = degradeAfterFailedReply(first.retry);
    expect(second.retry[1]).toEqual({ text: 'note', enqueuedAt: 2 });
    expect(second.degraded).toBe(1);
    expect(second.releasedMediaIds).toEqual(image(1).mediaIds);
  });

  it('overflow drops the oldest message WHOLE (text line, pictures, note) and returns the dropped pictures\' relay ids', () => {
    const q = new LineReplyQueue(4);
    q.enqueueGroup([
      { text: 'first', enqueuedAt: 1 },
      { text: 'n1', enqueuedAt: 1, image: image(1) },
      { text: 'n2', enqueuedAt: 1, image: image(2) },
    ]);
    expect(q.enqueue('second', 2)).toEqual({ dropped: 0, releasedMediaIds: [] });
    const r = q.enqueue('third', 3);
    // Before: [IMG, IMG, 'second', 'third'] — two pictures without their speaker line.
    expect(r).toEqual({ dropped: 3, releasedMediaIds: [...image(1).mediaIds, ...image(2).mediaIds] });
    expect(q.drain().map((b) => (b.image ? 'IMG' : b.text))).toEqual(['second', 'third']);
    // Plain texts still drop one by one; a dropped image without a group frees its copy too.
    const p = new LineReplyQueue(2);
    p.enqueueItem({ text: 'n', enqueuedAt: 1, image: image(3) });
    p.enqueue('a', 2);
    expect(p.enqueue('b', 3)).toEqual({ dropped: 1, releasedMediaIds: image(3).mediaIds });
    // requeueFront trims the newest tail and reports its pictures as well.
    const t = new LineReplyQueue(2);
    t.enqueueItem({ text: 'n', enqueuedAt: 1, image: image(4) });
    expect(t.requeueFront([{ text: 'x', enqueuedAt: 0 }, { text: 'y', enqueuedAt: 0 }])).toEqual({ dropped: 1, releasedMediaIds: image(4).mediaIds });
  });

  it('degradeAfterFailedReply: imageRejected degrades every image at once', () => {
    const r = degradeAfterFailedReply([{ text: 'note', enqueuedAt: 2, image: image(1) }], { imageRejected: true });
    expect(r.retry).toEqual([{ text: 'note', enqueuedAt: 2 }]);
  });
});
