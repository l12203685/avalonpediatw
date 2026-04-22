import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  DEFAULT_ELO_CONFIG,
  getEloConfig,
  setEloConfig,
} from '../services/EloConfig';

// ---------------------------------------------------------------------------
// Mock the Supabase service layer. We don't try to simulate a real
// postgres_changes socket; instead we verify the loader wires the boot-
// path row through `setEloConfig` and the write-path through the upsert.
// ---------------------------------------------------------------------------

const readState: { data: Record<string, unknown> | null; error: unknown } = {
  data: null,
  error: null,
};

const upsertSpy = vi.fn(async () => ({ error: null }));
const subscribeSpy = vi.fn();

vi.mock('../services/supabase', () => {
  const channel = {
    on: vi.fn(function () {
      return channel;
    }),
    subscribe: vi.fn(function () {
      subscribeSpy();
      return channel;
    }),
    unsubscribe: vi.fn(async () => {}),
  };

  const client = {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn(async () => ({
            data: readState.data,
            error: readState.error,
          })),
        })),
      })),
      upsert: upsertSpy,
    })),
    channel: vi.fn(() => channel),
  };

  return {
    getSupabaseClient: vi.fn(() => client),
    isSupabaseReady: vi.fn(() => true),
  };
});

// Import after mock
import {
  loadEloConfigFromSupabase,
  subscribeEloConfigChanges,
  persistEloConfigOverride,
} from '../services/EloConfigLoader';

beforeEach(() => {
  setEloConfig(); // reset singleton to DEFAULT_ELO_CONFIG
  readState.data = null;
  readState.error = null;
  upsertSpy.mockClear();
  subscribeSpy.mockClear();
});

// ---------------------------------------------------------------------------
// Boot path — loadEloConfigFromSupabase
// ---------------------------------------------------------------------------

describe('EloConfigLoader.loadEloConfigFromSupabase', () => {
  it('falls back to defaults when no row is persisted', async () => {
    readState.data = null;

    const result = await loadEloConfigFromSupabase();

    expect(result.source).toBe('default');
    expect(getEloConfig().attributionMode).toBe(DEFAULT_ELO_CONFIG.attributionMode);
  });

  it('applies persisted attributionMode=per_event on boot', async () => {
    readState.data = {
      key: 'active',
      config: {
        attributionMode: 'per_event',
        attributionWeights: { proposal: 2.0, outerWhiteInnerBlack: 3.0 },
      },
    };

    const result = await loadEloConfigFromSupabase();

    expect(result.source).toBe('supabase');
    expect(getEloConfig().attributionMode).toBe('per_event');
  });

  it('ignores unknown keys in the persisted row (safe-merge)', async () => {
    readState.data = {
      key: 'active',
      config: {
        attributionMode: 'per_event',
        __evil: 'rm -rf', // must be ignored by applyPartialConfig
      },
    };

    await loadEloConfigFromSupabase();

    expect(getEloConfig().attributionMode).toBe('per_event');
    // Ensure no injected key leaks into the active config.
    expect((getEloConfig() as unknown as Record<string, unknown>)['__evil']).toBeUndefined();
  });

  it('falls back gracefully when the select errors out', async () => {
    readState.data = null;
    readState.error = { code: '42P01', message: 'relation "elo_config" does not exist' };

    const result = await loadEloConfigFromSupabase();

    expect(result.source).toBe('error');
    expect(getEloConfig().attributionMode).toBe('legacy'); // untouched default
  });
});

// ---------------------------------------------------------------------------
// Subscribe path — subscribeEloConfigChanges
// ---------------------------------------------------------------------------

describe('EloConfigLoader.subscribeEloConfigChanges', () => {
  it('opens exactly one realtime channel even if called twice', () => {
    const first = subscribeEloConfigChanges();
    const second = subscribeEloConfigChanges();
    expect(first).toBe(second);
    expect(subscribeSpy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Write path — persistEloConfigOverride (hot reload correctness)
// ---------------------------------------------------------------------------

describe('EloConfigLoader.persistEloConfigOverride', () => {
  it('applies in-memory change immediately before Supabase write', async () => {
    expect(getEloConfig().attributionMode).toBe('legacy');

    await persistEloConfigOverride({ attributionMode: 'per_event' }, 'admin@example.com');

    // setEloConfig is called synchronously in applyPartialConfig, so the
    // in-memory flip is visible before we even await the upsert.
    expect(getEloConfig().attributionMode).toBe('per_event');
    expect(upsertSpy).toHaveBeenCalledTimes(1);
  });

  it('preserves Phase 1 fields when merging partial override', async () => {
    readState.data = {
      key: 'active',
      config: {
        // Existing row has a tweaked outcome weight from Phase 1 tuning.
        outcomeWeights: {
          good_wins_quests: 1.0,
          evil_wins_quests: 1.0,
          assassin_kills_merlin: 2.0, // bumped from 1.5 seed
        },
        attributionMode: 'legacy',
      },
    };

    // Flip only the attributionMode — assassin multiplier in the row must
    // survive the upsert round-trip (read-modify-write inside the loader).
    await persistEloConfigOverride({ attributionMode: 'per_event' }, null);

    const upsertArgs = upsertSpy.mock.calls[0][0] as {
      config: { outcomeWeights?: { assassin_kills_merlin?: number }; attributionMode?: string };
    };
    expect(upsertArgs.config.attributionMode).toBe('per_event');
    expect(upsertArgs.config.outcomeWeights?.assassin_kills_merlin).toBe(2.0);
  });

  it('merges attribution weights without wiping companion factor', async () => {
    readState.data = {
      key: 'active',
      config: {
        attributionMode: 'per_event',
        attributionWeights: { proposal: 2.0, outerWhiteInnerBlack: 3.5 },
      },
    };

    // Admin tweaks only proposal — outerWhiteInnerBlack must be preserved.
    await persistEloConfigOverride(
      { attributionWeights: { proposal: 2.5 } },
      null,
    );

    const upsertArgs = upsertSpy.mock.calls[0][0] as {
      config: { attributionWeights: { proposal: number; outerWhiteInnerBlack: number } };
    };
    expect(upsertArgs.config.attributionWeights.proposal).toBe(2.5);
    expect(upsertArgs.config.attributionWeights.outerWhiteInnerBlack).toBe(3.5);
  });
});
