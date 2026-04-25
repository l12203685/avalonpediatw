/**
 * Phase A — passwordHash service unit tests.
 *
 * Tests scrypt round-trip, strength validation, account-name / email
 * validators, and normalization helpers.
 */

import { describe, it, expect } from 'vitest';
import {
  hashPassword,
  verifyPassword,
  validatePasswordStrength,
  validateAccountName,
  validateEmail,
  normalizeEmail,
  normalizeAccountName,
} from './passwordHash';

describe('validatePasswordStrength', () => {
  it('accepts a plausible password', () => {
    expect(validatePasswordStrength('Passw0rd!').ok).toBe(true);
    expect(validatePasswordStrength('abcd1234').ok).toBe(true);
  });

  it('rejects short passwords', () => {
    const r = validatePasswordStrength('a1b');
    expect(r.ok).toBe(false);
    expect(r.code).toBe('too_short');
  });

  it('rejects missing digit / letter', () => {
    expect(validatePasswordStrength('abcdefgh').code).toBe('missing_digit');
    expect(validatePasswordStrength('12345678').code).toBe('missing_letter');
  });

  it('rejects non-strings', () => {
    expect(validatePasswordStrength(42 as unknown).ok).toBe(false);
    expect(validatePasswordStrength(null as unknown).ok).toBe(false);
  });

  it('rejects >256-char passwords', () => {
    const big = 'a1' + 'x'.repeat(300);
    expect(validatePasswordStrength(big).code).toBe('too_long');
  });
});

describe('hashPassword + verifyPassword', () => {
  it('round-trips the same password', async () => {
    const hash = await hashPassword('Passw0rdAvalon');
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('Passw0rdAvalon', hash)).toBe(true);
  });

  it('rejects wrong password', async () => {
    const hash = await hashPassword('Passw0rdAvalon');
    expect(await verifyPassword('Passw0rdAvalo2', hash)).toBe(false);
    expect(await verifyPassword('', hash)).toBe(false);
  });

  it('generates distinct salts per hash', async () => {
    const a = await hashPassword('abc12345');
    const b = await hashPassword('abc12345');
    expect(a).not.toBe(b);
    expect(await verifyPassword('abc12345', a)).toBe(true);
    expect(await verifyPassword('abc12345', b)).toBe(true);
  });

  it('verifyPassword returns false on malformed stored hash', async () => {
    expect(await verifyPassword('abc12345', '')).toBe(false);
    expect(await verifyPassword('abc12345', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('abc12345', 'scrypt$1$1$1')).toBe(false);
  });

  it('hashPassword throws on weak input', async () => {
    await expect(hashPassword('short')).rejects.toThrow();
  });
});

describe('validateAccountName', () => {
  it('accepts 3-20 chars alphanumeric + _.-', () => {
    expect(validateAccountName('Edward').ok).toBe(true);
    expect(validateAccountName('ed.ward_01').ok).toBe(true);
    expect(validateAccountName('ab-c').ok).toBe(true);
  });

  it('rejects out-of-range length', () => {
    expect(validateAccountName('aa').code).toBe('length');
    expect(validateAccountName('x'.repeat(25)).code).toBe('length');
  });

  it('rejects illegal chars', () => {
    expect(validateAccountName('Ed wa').code).toBe('charset');
    expect(validateAccountName('Ed王').code).toBe('charset');
  });
});

describe('validateEmail', () => {
  it('accepts well-formed emails', () => {
    expect(validateEmail('a@b.com').ok).toBe(true);
    expect(validateEmail('avalonpediatw@gmail.com').ok).toBe(true);
  });

  it('rejects malformed emails', () => {
    expect(validateEmail('no-at').ok).toBe(false);
    expect(validateEmail('a@b').ok).toBe(false);
    expect(validateEmail('').ok).toBe(false);
    expect(validateEmail('a@@b.com').ok).toBe(false);
  });
});

describe('normalizers', () => {
  it('normalizeEmail lowercases + trims', () => {
    expect(normalizeEmail('  FOO@Bar.com ')).toBe('foo@bar.com');
  });
  it('normalizeAccountName lowercases + trims', () => {
    expect(normalizeAccountName(' Edward_Lin ')).toBe('edward_lin');
  });
});
