/**
 * Password hashing + strength validation for Phase A new-login architecture.
 *
 * Implementation: Node built-in `crypto.scrypt` (memory-hard KDF in the
 * argon2id security class). Chose scrypt over argon2 so the server has no
 * native compile step — deploy workflow stays `pnpm install && pnpm build`
 * without node-gyp / Python toolchain.
 *
 * Hash format (columnar, single line):
 *   `scrypt$N$r$p$keylen$<salt-b64>$<hash-b64>`
 *
 * Example:
 *   `scrypt$16384$8$1$64$bXlTYWx0RXhhbXBsZQ==$aGFzaEV4YW1wbGUxMjM0...`
 *
 * Parameters picked per 2024 OWASP guidance for interactive logins:
 *   N=16384 (cost), r=8 (block size), p=1 (parallelism), keylen=64 bytes.
 *
 * Swap-out note: to move to real argon2 later, keep the same function
 * signature and update the prefix + parser. `verifyPassword` already dispatches
 * on the `scrypt$` prefix.
 */

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'crypto';
import { promisify } from 'util';

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number, options: { N: number; r: number; p: number }) => Promise<Buffer>;

// KDF parameters — keep in sync with docstring above.
const SCRYPT_N       = 16384;
const SCRYPT_R       = 8;
const SCRYPT_P       = 1;
const SCRYPT_KEYLEN  = 64;
const SALT_BYTES     = 16;

const HASH_PREFIX = 'scrypt';

export interface PasswordStrengthResult {
  ok:      boolean;
  /** Short machine code, e.g. 'too_short', 'missing_digit' */
  code?:   string;
  /** Human-friendly 中文 reason — for API error body */
  reason?: string;
}

/**
 * Minimum acceptable password strength. 8+ chars AND at least one letter AND
 * one digit. Stops the most egregious credential-stuffing fodder without
 * pulling the zxcvbn dictionary (~800KB).
 *
 * Returns `{ ok: true }` when acceptable; otherwise `{ ok: false, code, reason }`.
 */
export function validatePasswordStrength(raw: unknown): PasswordStrengthResult {
  if (typeof raw !== 'string') {
    return { ok: false, code: 'not_string', reason: '密碼必須是文字' };
  }
  const pw = raw;
  if (pw.length < 8) {
    return { ok: false, code: 'too_short', reason: '密碼至少 8 個字元' };
  }
  if (pw.length > 256) {
    return { ok: false, code: 'too_long', reason: '密碼最多 256 個字元' };
  }
  if (!/[A-Za-z]/.test(pw)) {
    return { ok: false, code: 'missing_letter', reason: '密碼需包含至少一個英文字母' };
  }
  if (!/[0-9]/.test(pw)) {
    return { ok: false, code: 'missing_digit', reason: '密碼需包含至少一個數字' };
  }
  return { ok: true };
}

/**
 * Hash a plaintext password. Generates a fresh 16-byte salt per call.
 * Throws if `validatePasswordStrength` would reject the input — callers
 * should validate before hashing, but this guards against misuse.
 */
export async function hashPassword(plain: string): Promise<string> {
  const strength = validatePasswordStrength(plain);
  if (!strength.ok) {
    throw new Error(`Password rejected: ${strength.code ?? 'unknown'}`);
  }
  const salt   = randomBytes(SALT_BYTES);
  const buffer = await scrypt(plain, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return [
    HASH_PREFIX,
    String(SCRYPT_N),
    String(SCRYPT_R),
    String(SCRYPT_P),
    String(SCRYPT_KEYLEN),
    salt.toString('base64'),
    buffer.toString('base64'),
  ].join('$');
}

/**
 * Constant-time verify. Returns false when the stored hash is malformed,
 * unrecognised, or the plaintext doesn't match. Never throws.
 */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  if (typeof plain !== 'string' || typeof stored !== 'string' || stored.length === 0) {
    return false;
  }
  const parts = stored.split('$');
  if (parts.length !== 7 || parts[0] !== HASH_PREFIX) return false;

  const n      = parseInt(parts[1], 10);
  const r      = parseInt(parts[2], 10);
  const p      = parseInt(parts[3], 10);
  const keylen = parseInt(parts[4], 10);
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p) || !Number.isFinite(keylen)) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt     = Buffer.from(parts[5], 'base64');
    expected = Buffer.from(parts[6], 'base64');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length !== keylen) return false;

  try {
    const actual = await scrypt(plain, salt, keylen, { N: n, r, p });
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/**
 * Account name validation. 3-20 chars, alphanumeric + `_-.`.
 * Returns `{ ok, code?, reason? }` mirroring `validatePasswordStrength`.
 */
export function validateAccountName(raw: unknown): PasswordStrengthResult {
  if (typeof raw !== 'string') {
    return { ok: false, code: 'not_string', reason: '帳號必須是文字' };
  }
  const name = raw.trim();
  if (name.length < 3 || name.length > 20) {
    return { ok: false, code: 'length', reason: '帳號長度 3-20 字' };
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
    return { ok: false, code: 'charset', reason: '帳號只能用英數字加 _ - .' };
  }
  return { ok: true };
}

/**
 * Email validation. Permissive regex (checks shape, not deliverability) +
 * length cap. For full deliverability we rely on the email verification flow.
 */
export function validateEmail(raw: unknown): PasswordStrengthResult {
  if (typeof raw !== 'string') {
    return { ok: false, code: 'not_string', reason: '信箱必須是文字' };
  }
  const email = raw.trim();
  if (email.length === 0 || email.length > 254) {
    return { ok: false, code: 'length', reason: '信箱長度不合格' };
  }
  // RFC-5322 simplified: local@domain.tld
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, code: 'format', reason: '信箱格式不正確' };
  }
  return { ok: true };
}

/** Normalize email for uniqueness checks. Lowercase + trim; no plus-addressing strip. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Normalize account name for uniqueness checks. Lowercase + trim. */
export function normalizeAccountName(name: string): string {
  return name.trim().toLowerCase();
}
