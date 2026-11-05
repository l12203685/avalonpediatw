/**
 * 補位機器人 dispatch service (2026-11-03, services/signagePlayerDispatch.ts):
 * room / games parsing, the abuse limits (global cooldown, Taipei daily cap,
 * same-room duplicate) on an injected clock, the workflow_dispatch request
 * shape on a mocked fetch, and the unset-token path. No network.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  normalizeRoom,
  parseBots,
  parsePassword,
  normalizeRoomTitle,
  parseSeatFillerArgs,
  SignagePlayerDispatcher,
  taipeiDayKey,
  SEAT_FILLER_LIMITS,
} from '../services/signagePlayerDispatch';

const TOKEN = 'test-dispatch-token';
const MIN = 60_000;

function harness(opts: { env?: NodeJS.ProcessEnv; status?: number; start?: number; throwOnFetch?: boolean } = {}) {
  let now = opts.start ?? Date.UTC(2026, 10, 3, 4, 0, 0); // 12:00 Taipei
  const calls: { url: string; init: { method: string; headers: Record<string, string>; body: string } }[] = [];
  const logs: string[] = [];
  let status = opts.status ?? 204;
  const fetchMock = vi.fn(async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
    calls.push({ url, init });
    if (opts.throwOnFetch) throw new TypeError('fetch failed');
    return { status, ok: status >= 200 && status < 300 };
  });
  const d = new SignagePlayerDispatcher({
    fetch: fetchMock,
    now: () => now,
    env: () => opts.env ?? { GITHUB_DISPATCH_TOKEN: TOKEN },
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
  });
  return {
    d,
    calls,
    logs,
    advance: (ms: number) => (now += ms),
    setStatus: (s: number) => (status = s),
  };
}

describe('parsing', () => {
  it('normalizes room names (case-insensitive, bare number, full-width)', () => {
    expect(normalizeRoom('Room-1460')).toBe('Room-1460');
    expect(normalizeRoom('room-1460')).toBe('Room-1460');
    expect(normalizeRoom('ROOM-7')).toBe('Room-7');
    expect(normalizeRoom('1460')).toBe('Room-1460');
    expect(normalizeRoom(' 123456 ')).toBe('Room-123456');
    expect(normalizeRoom('Ｒｏｏｍ－１４６０')).toBe('Room-1460');
  });

  it('rejects malformed rooms', () => {
    for (const bad of ['', 'Room', 'Room-', 'Room-1234567', '1234567', 'Room 1460', 'Room-14a', 'Lobby-1', '-5', '14.6']) {
      expect(normalizeRoom(bad)).toBeNull();
    }
  });

  it('bots: default 1, 1–9, 補滿 = 9', () => {
    expect(parseBots(undefined)).toBe(1);
    expect(parseBots('')).toBe(1);
    expect(parseBots('3')).toBe(3);
    expect(parseBots('3人')).toBe(3);
    expect(parseBots('９')).toBe(9);
    expect(parseBots('補滿')).toBe(9);
    expect(parseBots('fill')).toBe(9);
    for (const bad of ['0', '10', '-1', '1.5', 'two']) expect(parseBots(bad)).toBeNull();
  });

  it('room description and password', () => {
    expect(normalizeRoomTitle('百科陪練')).toBe('百科陪練');
    expect(normalizeRoomTitle('a"b')).toBeNull();
    expect(normalizeRoomTitle('x'.repeat(41))).toBeNull();
    expect(parsePassword('')).toBe('');
    expect(parsePassword('1234')).toBe('1234');
    expect(parsePassword('12 34')).toBeNull();
  });

  it('parseSeatFillerArgs reports which part is wrong', () => {
    expect(parseSeatFillerArgs('1460')).toEqual({ ok: true, request: { room: 'Room-1460', byTitle: false, bots: 1, password: '' } });
    expect(parseSeatFillerArgs('百科陪練', '補滿', '1234')).toEqual({ ok: true, request: { room: '百科陪練', byTitle: true, bots: 9, password: '1234' } });
    expect(parseSeatFillerArgs('')).toEqual({ ok: false, error: 'usage' });
    expect(parseSeatFillerArgs('a"b')).toEqual({ ok: false, error: 'room' });
    expect(parseSeatFillerArgs('1460', '12')).toEqual({ ok: false, error: 'bots' });
    expect(parseSeatFillerArgs('1460', '1', 'a b')).toEqual({ ok: false, error: 'password' });
  });

  it('taipeiDayKey rolls over at 00:00 +08 (16:00 UTC)', () => {
    expect(taipeiDayKey(Date.UTC(2026, 10, 3, 15, 59, 59))).toBe('2026-11-03');
    expect(taipeiDayKey(Date.UTC(2026, 10, 3, 16, 0, 0))).toBe('2026-11-04');
  });
});

describe('dispatch request', () => {
  it('POSTs workflow_dispatch with ref main and string inputs', async () => {
    const h = harness();
    const out = await h.d.dispatch({ room: 'Room-1460', byTitle: false, bots: 2, password: '' });
    expect(out).toEqual({ kind: 'dispatched', room: 'Room-1460', bots: 2 });
    expect(h.calls).toHaveLength(1);
    const { url, init } = h.calls[0];
    expect(url).toBe('https://api.github.com/repos/l12203685/avalonpediatw/actions/workflows/signage-player.yml/dispatches');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(init.headers.Accept).toBe('application/vnd.github+json');
    expect(JSON.parse(init.body)).toEqual({ ref: 'main', inputs: { room: 'Room-1460', bots: '2' } });
  });

  it('honours SIGNAGE_PLAYER_WORKFLOW and GITHUB_DISPATCH_REPO', async () => {
    const h = harness({
      env: { GITHUB_DISPATCH_TOKEN: TOKEN, SIGNAGE_PLAYER_WORKFLOW: 'other-player.yaml', GITHUB_DISPATCH_REPO: 'someone/fork-repo' },
    });
    await h.d.dispatch({ room: 'Room-1', byTitle: false, bots: 1, password: '' });
    expect(h.calls[0].url).toBe('https://api.github.com/repos/someone/fork-repo/actions/workflows/other-player.yaml/dispatches');
  });

  it('unset token → not_configured, no request', async () => {
    const h = harness({ env: {} });
    expect(h.d.isConfigured()).toBe(false);
    expect(await h.d.dispatch({ room: 'Room-1460', byTitle: false, bots: 1, password: '' })).toEqual({ kind: 'not_configured' });
    expect(h.calls).toHaveLength(0);
  });

  it('a malformed repo setting counts as not configured', async () => {
    const h = harness({ env: { GITHUB_DISPATCH_TOKEN: TOKEN, GITHUB_DISPATCH_REPO: 'no-slash' } });
    expect(await h.d.dispatch({ room: 'Room-1460', byTitle: false, bots: 1, password: '' })).toEqual({ kind: 'not_configured' });
    expect(h.calls).toHaveLength(0);
  });

  it('GitHub error status is reported and gives the slot back', async () => {
    const h = harness({ status: 404 });
    expect(await h.d.dispatch({ room: 'Room-1460', byTitle: false, bots: 1, password: '' })).toEqual({ kind: 'github_error', status: 404 });
    h.setStatus(204);
    // No cooldown / duplicate left behind by the failed attempt.
    expect(await h.d.dispatch({ room: 'Room-1460', byTitle: false, bots: 1, password: '' })).toMatchObject({ kind: 'dispatched' });
  });

  it('network error keeps the slot (GitHub may have accepted it)', async () => {
    const h = harness({ throwOnFetch: true });
    expect(await h.d.dispatch({ room: 'Room-1460', byTitle: false, bots: 1, password: '' })).toEqual({ kind: 'github_error', status: null });
    expect(h.d.check({ room: 'Room-1460', byTitle: false, bots: 1, password: '' })).toMatchObject({ kind: 'duplicate_room' });
  });

  it('logs never carry the token or the room', async () => {
    const h = harness({ status: 500 });
    await h.d.dispatch({ room: 'Room-1460', byTitle: false, bots: 1, password: '' });
    h.setStatus(204);
    await h.d.dispatch({ room: 'Room-1460', byTitle: false, bots: 1, password: '' });
    const all = h.logs.join('\n');
    expect(all).toContain('status=500');
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain('1460');
  });
});

describe('limits', () => {
  it('global cooldown: one dispatch per 3 minutes, with remaining time', async () => {
    const h = harness();
    expect(await h.d.dispatch({ room: 'Room-1', byTitle: false, bots: 1, password: '' })).toMatchObject({ kind: 'dispatched' });
    h.advance(MIN);
    expect(await h.d.dispatch({ room: 'Room-2', byTitle: false, bots: 1, password: '' })).toEqual({ kind: 'cooldown', retryAfterMs: 2 * MIN });
    h.advance(2 * MIN);
    expect(await h.d.dispatch({ room: 'Room-2', byTitle: false, bots: 1, password: '' })).toMatchObject({ kind: 'dispatched' });
    expect(h.calls).toHaveLength(2);
  });

  it('same room within 15 minutes is rejected, then allowed', async () => {
    const h = harness();
    await h.d.dispatch({ room: 'Room-1460', byTitle: false, bots: 1, password: '' });
    h.advance(5 * MIN);
    expect(await h.d.dispatch({ room: 'Room-1460', byTitle: false, bots: 1, password: '' })).toEqual({
      kind: 'duplicate_room',
      room: 'Room-1460',
      retryAfterMs: 10 * MIN,
    });
    h.advance(10 * MIN);
    expect(await h.d.dispatch({ room: 'Room-1460', byTitle: false, bots: 1, password: '' })).toMatchObject({ kind: 'dispatched' });
  });

  it('at most 10 per Taipei day; resets at Taipei midnight', async () => {
    // 08:00 Taipei: 10 dispatches 3 min apart fit well inside the day.
    const h = harness({ start: Date.UTC(2026, 10, 3, 0, 0, 0) });
    for (let i = 0; i < SEAT_FILLER_LIMITS.dailyMax; i++) {
      expect(await h.d.dispatch({ room: `Room-${i}`, games: 1 })).toMatchObject({ kind: 'dispatched' });
      h.advance(SEAT_FILLER_LIMITS.cooldownMs);
    }
    expect(await h.d.dispatch({ room: 'Room-99', byTitle: false, bots: 1, password: '' })).toEqual({ kind: 'daily_cap', max: 10 });
    expect(h.calls).toHaveLength(10);
    // 00:00 Taipei next day = 16:00 UTC.
    h.advance(Date.UTC(2026, 10, 3, 16, 0, 0) - Date.UTC(2026, 10, 3, 0, 30, 0));
    expect(await h.d.dispatch({ room: 'Room-99', byTitle: false, bots: 1, password: '' })).toMatchObject({ kind: 'dispatched' });
  });

  it('two concurrent commands: the second is refused while the first is in flight', async () => {
    const h = harness();
    const [a, b] = await Promise.all([
      h.d.dispatch({ room: 'Room-1', byTitle: false, bots: 1, password: '' }),
      h.d.dispatch({ room: 'Room-2', byTitle: false, bots: 1, password: '' }),
    ]);
    expect(a).toMatchObject({ kind: 'dispatched' });
    expect(b).toMatchObject({ kind: 'cooldown' });
    expect(h.calls).toHaveLength(1);
  });
});
