/**
 * Weekly stats digest (2026-10-10): Monday 12:00 +08, posting window
 * 12:00–12:10, in-memory once-per-week guard, host-TZ independent.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DigestDestination,
  WeeklyDigestScheduler,
  digestDateLabel,
  digestWeekKey,
  isDigestWindow,
  taipeiClock,
} from '../bots/stats/weeklyDigest';

/** Epoch ms for a +08 wall-clock time (month is 1-based). */
const tpe = (y: number, mo: number, d: number, h: number, mi = 0, s = 0) => Date.UTC(y, mo - 1, d, h - 8, mi, s);

// 2026-10-12 is a Monday.
const MON_1200 = tpe(2026, 10, 12, 12, 0);

const quiet = { info: vi.fn(), warn: vi.fn() };

function recorder(name: string, result: boolean | 'skip' = true): DigestDestination & { sent: string[] } {
  const sent: string[] = [];
  return {
    name,
    sent,
    send: async (text: string) => {
      sent.push(text);
      return result;
    },
  };
}

function scheduler(dests: DigestDestination[], opts: { enabled?: boolean; buildText?: (now: number) => Promise<string> } = {}) {
  return new WeeklyDigestScheduler({
    buildText: opts.buildText ?? (async (now) => `排行 ${digestDateLabel(now)}`),
    destinations: dests,
    enabled: opts.enabled,
    logger: quiet,
  });
}

const originalTZ = process.env.TZ;
afterEach(() => {
  if (originalTZ === undefined) delete process.env.TZ;
  else process.env.TZ = originalTZ;
});

describe('+08 Monday detection', () => {
  it('Monday 12:00 +08 is Monday 04:00 UTC', () => {
    expect(MON_1200).toBe(Date.UTC(2026, 9, 12, 4, 0));
    expect(taipeiClock(MON_1200)).toEqual({ weekday: 1, hour: 12, minute: 0, date: '2026-10-12' });
  });

  it('uses +08, not UTC, across the date line', () => {
    // Sunday 16:30 UTC = Monday 00:30 +08.
    expect(taipeiClock(Date.UTC(2026, 9, 11, 16, 30))).toMatchObject({ weekday: 1, date: '2026-10-12' });
    // Monday 20:00 UTC = Tuesday 04:00 +08 — not Monday any more.
    expect(taipeiClock(Date.UTC(2026, 9, 12, 20, 0))).toMatchObject({ weekday: 2, date: '2026-10-13' });
    // Monday 12:00 UTC is Monday 20:00 +08 — outside the window.
    expect(isDigestWindow(Date.UTC(2026, 9, 12, 12, 0))).toBe(false);
  });

  it('window is exactly Monday 12:00:00 ≤ t < 12:10:00 +08', () => {
    expect(isDigestWindow(tpe(2026, 10, 12, 11, 59, 59))).toBe(false);
    expect(isDigestWindow(MON_1200)).toBe(true);
    expect(isDigestWindow(tpe(2026, 10, 12, 12, 9, 59))).toBe(true);
    expect(isDigestWindow(tpe(2026, 10, 12, 12, 10, 0))).toBe(false);
    expect(isDigestWindow(tpe(2026, 10, 13, 12, 0))).toBe(false); // Tuesday
    expect(isDigestWindow(tpe(2026, 10, 11, 12, 0))).toBe(false); // Sunday
  });

  it('does not depend on the host TZ', () => {
    const before = [taipeiClock(MON_1200), isDigestWindow(MON_1200), digestWeekKey(MON_1200)];
    for (const tz of ['UTC', 'America/Los_Angeles', 'Asia/Tokyo', 'Pacific/Kiritimati']) {
      process.env.TZ = tz;
      expect([taipeiClock(MON_1200), isDigestWindow(MON_1200), digestWeekKey(MON_1200)]).toEqual(before);
    }
  });

  it('week key is the +08 Monday of that week', () => {
    expect(digestWeekKey(MON_1200)).toBe('2026-10-12');
    expect(digestWeekKey(tpe(2026, 10, 18, 23, 59))).toBe('2026-10-12'); // Sunday night, same week
    expect(digestWeekKey(tpe(2026, 10, 19, 0, 0))).toBe('2026-10-19');
    expect(digestDateLabel(MON_1200)).toBe('10/12');
  });
});

describe('WeeklyDigestScheduler', () => {
  it('posts once inside the window, to every destination', async () => {
    const discord = recorder('discord');
    const line = recorder('line');
    const s = scheduler([discord, line]);
    expect(await s.tick(MON_1200 + 30_000)).toBe('posted');
    expect(discord.sent).toEqual(['排行 10/12']);
    expect(line.sent).toEqual(['排行 10/12']);
    expect(s.getState().lastPostedWeek).toEqual({ discord: '2026-10-12', line: '2026-10-12' });
  });

  it('never posts twice in the same week (every minute of the window)', async () => {
    const discord = recorder('discord');
    const s = scheduler([discord]);
    const results: string[] = [];
    for (let m = 0; m < 10; m++) results.push(await s.tick(MON_1200 + m * 60_000));
    expect(results[0]).toBe('posted');
    expect(results.slice(1).every((r) => r === 'already-posted')).toBe(true);
    expect(discord.sent).toHaveLength(1);
  });

  it('never posts outside the window, including right after a restart', async () => {
    const discord = recorder('discord');
    // A fresh instance has no memory — e.g. Render restarted at 12:15 after posting at 12:00.
    const restarted = scheduler([discord]);
    for (const t of [tpe(2026, 10, 12, 12, 15), tpe(2026, 10, 12, 11, 59), tpe(2026, 10, 13, 12, 0), tpe(2026, 10, 12, 0, 0)]) {
      expect(await restarted.tick(t)).toBe('outside-window');
    }
    expect(discord.sent).toEqual([]);
  });

  it('posts again the following Monday', async () => {
    const discord = recorder('discord');
    const s = scheduler([discord]);
    await s.tick(MON_1200);
    expect(await s.tick(MON_1200 + 7 * 24 * 3600_000)).toBe('posted');
    expect(discord.sent).toEqual(['排行 10/12', '排行 10/19']);
  });

  it('retries an unavailable destination within the window only, without reposting the others', async () => {
    const line = recorder('line');
    let discordReady = false;
    const discordSent: string[] = [];
    const discord: DigestDestination = {
      name: 'discord',
      send: async (text) => {
        if (!discordReady) return false;
        discordSent.push(text);
        return true;
      },
    };
    const s = scheduler([discord, line]);
    expect(await s.tick(MON_1200)).toBe('partial');
    discordReady = true;
    expect(await s.tick(MON_1200 + 60_000)).toBe('posted');
    expect(discordSent).toHaveLength(1);
    expect(line.sent).toHaveLength(1);

    // Discord never ready during the next window → nothing after it closes.
    discordReady = false;
    const nextMon = MON_1200 + 7 * 24 * 3600_000;
    await s.tick(nextMon);
    discordReady = true;
    expect(await s.tick(nextMon + 10 * 60_000)).toBe('outside-window');
    expect(discordSent).toHaveLength(1);
  });

  it("'skip' (destination not configured) counts as done; thrown errors are retried", async () => {
    const skipped = recorder('line', 'skip');
    let calls = 0;
    const flaky: DigestDestination = {
      name: 'discord',
      send: async () => {
        calls += 1;
        if (calls === 1) throw new Error('fetch failed');
        return true;
      },
    };
    const s = scheduler([flaky, skipped]);
    expect(await s.tick(MON_1200)).toBe('partial');
    expect(await s.tick(MON_1200 + 60_000)).toBe('posted');
    expect(skipped.sent).toHaveLength(1);
    expect(calls).toBe(2);
  });

  it('does not post when the text cannot be built (cache unreadable)', async () => {
    const discord = recorder('discord');
    const s = scheduler([discord], { buildText: async () => { throw new Error('no cache'); } });
    expect(await s.tick(MON_1200)).toBe('failed');
    expect(discord.sent).toEqual([]);
  });

  it('concurrent ticks post once', async () => {
    const discord = recorder('discord');
    const s = scheduler([discord]);
    const [a, b] = await Promise.all([s.tick(MON_1200), s.tick(MON_1200)]);
    expect([a, b].sort()).toEqual(['busy', 'posted']);
    expect(discord.sent).toHaveLength(1);
  });

  it('STATS_DIGEST_ENABLED=false (enabled: false) never posts', async () => {
    const discord = recorder('discord');
    const s = scheduler([discord], { enabled: false });
    expect(await s.tick(MON_1200)).toBe('disabled');
    s.start();
    expect(s.getState().running).toBe(false);
    expect(discord.sent).toEqual([]);
  });

  it('start() ticks every minute and stop() clears the timer', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(MON_1200 - 60_000); // 11:59 +08
      const discord = recorder('discord');
      const s = scheduler([discord]);
      s.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(discord.sent).toEqual([]);
      await vi.advanceTimersByTimeAsync(60_000); // 12:00
      expect(discord.sent).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(9 * 60_000);
      expect(discord.sent).toHaveLength(1);
      s.stop();
      expect(s.getState().running).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
