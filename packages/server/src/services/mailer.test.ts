/**
 * Phase A — mailer service unit tests.
 *
 * Uses `__setMailerForTest` to stub the transport — so the tests never hit
 * real SMTP but still cover the full render → send code path.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  sendMail,
  sendPasswordResetEmail,
  sendEmailVerificationEmail,
  __setMailerForTest,
  isMailerReady,
} from './mailer';

describe('mailer (stubbed transport)', () => {
  let sent: Array<{ to: string; subject: string; text: string; html?: string }> = [];

  beforeEach(() => {
    sent = [];
    __setMailerForTest({
      async sendMail(msg) {
        sent.push({ to: msg.to, subject: msg.subject, text: msg.text, html: msg.html });
        return { messageId: `stub-${Math.random().toString(36).slice(2)}` };
      },
    });
  });

  afterEach(() => {
    __setMailerForTest(null);
    vi.restoreAllMocks();
  });

  it('sendMail delivers message to stub transport', async () => {
    const r = await sendMail({ to: 'a@b.com', subject: 'hi', text: 'body' });
    expect(r.ok).toBe(true);
    expect(r.messageId).toMatch(/^stub-/);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('a@b.com');
    expect(sent[0].subject).toBe('hi');
  });

  it('sendPasswordResetEmail includes reset URL and account name', async () => {
    const url = 'https://example.com/reset-password?token=abcd';
    await sendPasswordResetEmail('alice@ex.com', 'Alice', url);
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toContain('重設密碼');
    expect(sent[0].text).toContain('Alice');
    expect(sent[0].text).toContain(url);
    expect(sent[0].html).toContain(url);
  });

  it('sendEmailVerificationEmail includes verify URL and account name', async () => {
    const url = 'https://example.com/verify-email?token=wxyz';
    await sendEmailVerificationEmail('bob@ex.com', 'Bob', url);
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toContain('驗證信箱');
    expect(sent[0].text).toContain('Bob');
    expect(sent[0].text).toContain(url);
  });

  it('isMailerReady returns true when stub is installed', async () => {
    expect(await isMailerReady()).toBe(true);
  });
});

describe('mailer (disabled)', () => {
  afterEach(() => {
    __setMailerForTest(null);
  });

  it('falls back to disabled state when no transport available', async () => {
    __setMailerForTest(null);
    const original = process.env.GMAIL_APP_PASSWORD;
    delete process.env.GMAIL_APP_PASSWORD;
    try {
      const r = await sendMail({ to: 'a@b.com', subject: 'x', text: 'y' });
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('mailer_not_configured');
    } finally {
      if (original !== undefined) process.env.GMAIL_APP_PASSWORD = original;
    }
  });
});
