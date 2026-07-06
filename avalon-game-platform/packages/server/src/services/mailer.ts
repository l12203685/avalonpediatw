/**
 * Gmail SMTP mailer for Phase A account flows (password reset + email verify).
 *
 * Transport: nodemailer over Gmail SMTP (`smtp.gmail.com:465` SSL) using an
 * App Password (16-char string) on `avalonpediatw@gmail.com`. App passwords
 * bypass 2FA without exposing the account password; operators rotate them
 * from https://myaccount.google.com/apppasswords when needed.
 *
 * Design goals:
 *   - Boot never fails on missing env / missing `nodemailer` package.
 *     `sendMail` returns `{ ok: false, reason: 'disabled' }` and the caller
 *     decides whether to 503 or degrade gracefully.
 *   - Tests can stub via `__setMailerForTest`.
 *   - Single render point for both reset + verify templates so copy stays
 *     consistent (Avalon Pedia 署名 + 5 分鐘提示 + 繁中).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

interface SendArgs {
  to:      string;
  subject: string;
  text:    string;
  html?:   string;
}

export interface SendResult {
  ok:      boolean;
  reason?: string;
  /** Provider messageId for logging; set when ok=true. */
  messageId?: string;
}

type Transport = {
  sendMail: (msg: {
    from:    string;
    to:      string;
    subject: string;
    text:    string;
    html?:   string;
  }) => Promise<{ messageId?: string }>;
};

const FROM_ADDRESS_DEFAULT = 'avalonpediatw@gmail.com';
const FROM_NAME_DEFAULT    = 'Avalon Pedia';

/**
 * Cached transport. Re-initialised lazily so test-time env changes take
 * effect — production boots once and keeps the connection pool warm.
 */
let cachedTransport: Transport | null = null;
let cachedEnvSig:    string            = '';
let testOverride:    Transport | null  = null;

/**
 * Read the SMTP login user. Accept both `GMAIL_SMTP_USER` (canonical in docs)
 * and `GMAIL_USER` (shorter alias already present in `.env.production`).
 */
function smtpUserEnv(): string {
  return process.env.GMAIL_SMTP_USER || process.env.GMAIL_USER || '';
}

/**
 * Read the visible From address. Accept both `MAIL_FROM` (canonical in docs)
 * and `GMAIL_FROM` (shorter alias already present in `.env.production`).
 */
function mailFromEnv(): string {
  return process.env.MAIL_FROM || process.env.GMAIL_FROM || '';
}

function currentEnvSignature(): string {
  return [
    smtpUserEnv(),
    process.env.GMAIL_APP_PASSWORD ? 'set' : '',
    mailFromEnv(),
  ].join('|');
}

/**
 * Injection point for tests. Pass `null` to restore the real transport.
 * The next `sendMail` call will use the override verbatim.
 */
export function __setMailerForTest(override: Transport | null): void {
  testOverride = override;
}

async function resolveTransport(): Promise<Transport | null> {
  if (testOverride) return testOverride;

  const sig = currentEnvSignature();
  if (cachedTransport && cachedEnvSig === sig) return cachedTransport;

  const smtpUser = smtpUserEnv() || FROM_ADDRESS_DEFAULT;
  const smtpPass = process.env.GMAIL_APP_PASSWORD;
  if (!smtpPass) {
    cachedTransport = null;
    cachedEnvSig    = sig;
    return null;
  }

  // Dynamic import keeps the boot path lazy — if something goes wrong loading
  // the package (e.g. broken install), we degrade to "mail disabled" instead
  // of crashing the whole server. In normal production nodemailer is a first-
  // class dependency and this import resolves immediately.
  let nodemailer: any;
  try {
    nodemailer = await import('nodemailer');
  } catch {
    cachedTransport = null;
    cachedEnvSig    = sig;
    // eslint-disable-next-line no-console
    console.warn('[mailer] nodemailer import failed — mail sending disabled. Run `pnpm install` in packages/server to restore.');
    return null;
  }

  try {
    const transport = (nodemailer.default ?? nodemailer).createTransport({
      host:   'smtp.gmail.com',
      port:   465,
      secure: true,
      auth: {
        user: smtpUser,
        pass: smtpPass,
      },
    }) as Transport;
    cachedTransport = transport;
    cachedEnvSig    = sig;
    return transport;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[mailer] createTransport failed:', err);
    cachedTransport = null;
    cachedEnvSig    = sig;
    return null;
  }
}

function fromHeader(): string {
  const addr = mailFromEnv() || FROM_ADDRESS_DEFAULT;
  return `${FROM_NAME_DEFAULT} <${addr}>`;
}

/**
 * Send a raw email. Returns `{ ok: false, reason }` on any transport issue —
 * never throws. Callers typically log + surface a 503/degraded response.
 */
export async function sendMail(args: SendArgs): Promise<SendResult> {
  const t = await resolveTransport();
  if (!t) {
    return { ok: false, reason: 'mailer_not_configured' };
  }
  try {
    const info = await t.sendMail({
      from:    fromHeader(),
      to:      args.to,
      subject: args.subject,
      text:    args.text,
      html:    args.html,
    });
    return { ok: true, messageId: info.messageId };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[mailer] sendMail failed:', err);
    return { ok: false, reason: 'transport_error' };
  }
}

/**
 * Render + send the forgot-password email. `resetUrl` is the full
 * `${FRONTEND_URL}/reset-password?token=...` the user clicks.
 */
export async function sendPasswordResetEmail(
  to:          string,
  accountName: string,
  resetUrl:    string,
): Promise<SendResult> {
  const subject = 'Avalon Pedia 重設密碼';
  const text = [
    `Hi ${accountName}，`,
    '',
    '你（或有人冒用你的帳號）剛剛申請重設密碼。點下方連結設定新密碼，連結 30 分鐘內有效：',
    '',
    resetUrl,
    '',
    '如果不是你申請的，忽略這封信即可，密碼不會被更改。',
    '',
    '— Avalon Pedia',
  ].join('\n');
  const html = [
    `<p>Hi <b>${accountName}</b>，</p>`,
    '<p>你（或有人冒用你的帳號）剛剛申請重設密碼。點下方連結設定新密碼，連結 <b>30 分鐘</b>內有效：</p>',
    `<p><a href="${resetUrl}">${resetUrl}</a></p>`,
    '<p>如果不是你申請的，忽略這封信即可，密碼不會被更改。</p>',
    '<p>— Avalon Pedia</p>',
  ].join('');
  return sendMail({ to, subject, text, html });
}

/**
 * Render + send the email-verification mail (used during first-login profile
 * setup when the user adds a new email to their account).
 */
export async function sendEmailVerificationEmail(
  to:          string,
  accountName: string,
  verifyUrl:   string,
): Promise<SendResult> {
  const subject = 'Avalon Pedia 驗證信箱';
  const text = [
    `Hi ${accountName}，`,
    '',
    '點下方連結確認這個信箱是你的（連結 24 小時內有效）：',
    '',
    verifyUrl,
    '',
    '如果不是你申請的，忽略即可。',
    '',
    '— Avalon Pedia',
  ].join('\n');
  const html = [
    `<p>Hi <b>${accountName}</b>，</p>`,
    '<p>點下方連結確認這個信箱是你的（連結 <b>24 小時</b>內有效）：</p>',
    `<p><a href="${verifyUrl}">${verifyUrl}</a></p>`,
    '<p>如果不是你申請的，忽略即可。</p>',
    '<p>— Avalon Pedia</p>',
  ].join('');
  return sendMail({ to, subject, text, html });
}

/** True when SMTP is configured (env present + transport creatable). Used by /health. */
export async function isMailerReady(): Promise<boolean> {
  return (await resolveTransport()) !== null;
}
