/**
 * Unit tests for guestAuth middleware — Ticket #81 additions.
 *
 * Coverage:
 *   - generateGuestName() produces `Guest_NNN` with 3-digit zero-padded number
 *   - mintGuestToken() falls back to generated name when input is empty/whitespace
 *   - mintGuestToken() still honours valid user-supplied names
 *   - Guest token round-trip via verifyGuestToken()
 */
import { describe, it, expect, beforeAll } from 'vitest';

beforeAll(() => {
  // JWT secret must be present before guestAuth module reads it on import.
  if (!process.env.JWT_SECRET) {
    process.env.JWT_SECRET = 'test-secret-for-guest-auth-unit-tests';
  }
});

// Lazy import so env override above takes effect.
async function loadMod() {
  return await import('./guestAuth');
}

describe('generateGuestName', () => {
  it('returns Guest_ prefix with 3-digit padded number', async () => {
    const { generateGuestName } = await loadMod();
    for (let i = 0; i < 50; i += 1) {
      const name = generateGuestName();
      expect(name).toMatch(/^Guest_\d{3}$/);
      const suffix = name.slice(6);
      const num = Number(suffix);
      expect(num).toBeGreaterThanOrEqual(0);
      expect(num).toBeLessThanOrEqual(999);
    }
  });
});

describe('mintGuestToken', () => {
  it('generates a Guest_NNN default when raw name is empty', async () => {
    const { mintGuestToken } = await loadMod();
    const { displayName, uid, token } = mintGuestToken('');
    expect(displayName).toMatch(/^Guest_\d{3}$/);
    expect(uid).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof token).toBe('string');
    expect(token.split('.')).toHaveLength(3); // JWT format
  });

  it('generates a Guest_NNN default when raw name is whitespace only', async () => {
    const { mintGuestToken } = await loadMod();
    const { displayName } = mintGuestToken('   ');
    expect(displayName).toMatch(/^Guest_\d{3}$/);
  });

  it('keeps user-supplied name when valid', async () => {
    const { mintGuestToken } = await loadMod();
    const { displayName } = mintGuestToken('Merlin');
    expect(displayName).toBe('Merlin');
  });

  it('truncates overlong user-supplied name to 40 chars', async () => {
    const { mintGuestToken } = await loadMod();
    const long = 'A'.repeat(80);
    const { displayName } = mintGuestToken(long);
    expect(displayName.length).toBe(40);
  });

  it('round-trips through verifyGuestToken with signed=true', async () => {
    const { mintGuestToken, verifyGuestToken } = await loadMod();
    const minted = mintGuestToken('Percival');
    const identity = verifyGuestToken(minted.token);
    expect(identity).not.toBeNull();
    expect(identity!.uid).toBe(minted.uid);
    expect(identity!.displayName).toBe('Percival');
    expect(identity!.signed).toBe(true);
  });
});
