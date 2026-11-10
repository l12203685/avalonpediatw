import { createHmac } from 'crypto';
import { describe, expect, it, vi } from 'vitest';
import { verifyDigestSignature } from '../bots/index';
import { WeeklyDigestScheduler } from '../bots/stats/weeklyDigest';

const sign = (secret: string, sec: number): string =>
  `${sec}.${createHmac('sha256', secret).update(`stats-digest-send:${sec}`).digest('hex')}`;

describe('manual weekly digest send', () => {
  it('accepts only a fresh signature made with the secret', () => {
    const now = 1_790_000_000_000;
    const sec = Math.floor(now / 1000);
    expect(verifyDigestSignature(sign('s3cret', sec), 's3cret', now)).toBe(true);
    expect(verifyDigestSignature(sign('other', sec), 's3cret', now)).toBe(false);
    expect(verifyDigestSignature(sign('s3cret', sec - 600), 's3cret', now)).toBe(false);
    expect(verifyDigestSignature(undefined, 's3cret', now)).toBe(false);
    expect(verifyDigestSignature(sign('s3cret', sec), undefined, now)).toBe(false);
    expect(verifyDigestSignature('garbage', 's3cret', now)).toBe(false);
  });

  it('sendNow posts to every destination outside the window and leaves the weekly state alone', async () => {
    const sent: string[] = [];
    const scheduler = new WeeklyDigestScheduler({
      buildText: async () => 'text',
      buildImage: async () => Buffer.from([1, 2, 3]),
      destinations: [
        { name: 'discord', send: async (_t, img) => { sent.push(`discord:${img?.length}`); return true; } },
        { name: 'line', send: async () => 'skip' },
      ],
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    const tuesday = Date.parse('2026-11-10T02:00:00Z');
    const out = await scheduler.sendNow(tuesday);
    expect(out).toEqual({ chart: 'png 3 bytes', discord: 'sent', line: 'not configured' });
    expect(sent).toEqual(['discord:3']);
    expect(scheduler.getState().lastPostedWeek).toEqual({});
  });
});
