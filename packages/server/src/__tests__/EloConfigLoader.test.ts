import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock the Firebase service layer. Vitest hoists vi.mock() factories above
// the imports, so the factory cannot close over top-level variables. We use
// `vi.hoisted()` to share mutable state between the factory and the test
// body, which is the supported pattern for this exact case.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  interface DocState {
    exists: boolean;
    data: Record<string, unknown> | null;
    getError: unknown;
  }

  const docState: DocState = {
    exists: false,
    data: null,
    getError: null,
  };

  return {
    docState,
    setSpy: vi.fn(async () => undefined),
    onSnapshotSpy: vi.fn(),
    unsubscribeSpy: vi.fn(),
  };
});

vi.mock('../services/firebase', () => {
  const ref = {
    get: vi.fn(async () => {
      if (mocks.docState.getError) throw mocks.docState.getError;
      return {
        exists: mocks.docState.exists,
        data: () => mocks.docState.data ?? undefined,
      };
    }),
    set: mocks.setSpy,
    onSnapshot: vi.fn(() => {
      mocks.onSnapshotSpy();
      return mocks.unsubscribeSpy;
    }),
  };

  const collection = vi.fn(() => ({
    doc: vi.fn(() => ref),
  }));

  const firestore = { collection };

  return {
    getAdminFirestore: vi.fn(() => firestore),
    isFirebaseAdminReady: vi.fn(() => true),
  };
});

import {
  DEFAULT_ELO_CONFIG,
  getEloConfig,
  setEloConfig,
} from '../services/EloConfig';
import {
  loadEloConfigFromFirestore,
  loadEloConfigFromSupabase,
  subscribeEloConfigChanges,
  unsubscribeEloConfigChanges,
  persistEloConfigOverride,
} from '../services/EloConfigLoader';

beforeEach(async () => {
  setEloConfig(); // reset singleton to DEFAULT_ELO_CONFIG
  mocks.docState.exists = false;
  mocks.docState.data = null;
  mocks.docState.getError = null;
  mocks.setSpy.mockClear();
  mocks.onSnapshotSpy.mockClear();
  mocks.unsubscribeSpy.mockClear();
  await unsubscribeEloConfigChanges();
});

// ---------------------------------------------------------------------------
// Boot path — loadEloConfigFromFirestore
// ---------------------------------------------------------------------------

describe('EloConfigLoader.loadEloConfigFromFirestore', () => {
  it('falls back to defaults when no doc is persisted', async () => {
    mocks.docState.exists = false;
    mocks.docState.data = null;

    const result = await loadEloConfigFromFirestore();

    expect(result.source).toBe('default');
    expect(getEloConfig().attributionMode).toBe(DEFAULT_ELO_CONFIG.attributionMode);
  });

  it('falls back to defaults when doc exists but config field is null', async () => {
    mocks.docState.exists = true;
    mocks.docState.data = { config: null };

    const result = await loadEloConfigFromFirestore();

    expect(result.source).toBe('default');
    expect(getEloConfig().attributionMode).toBe('legacy');
  });

  it('applies persisted attributionMode=per_event on boot', async () => {
    mocks.docState.exists = true;
    mocks.docState.data = {
      config: {
        attributionMode: 'per_event',
        attributionWeights: { proposal: 2.0, outerWhiteInnerBlack: 3.0 },
      },
    };

    const result = await loadEloConfigFromFirestore();

    expect(result.source).toBe('firestore');
    expect(getEloConfig().attributionMode).toBe('per_event');
  });

  it('ignores unknown keys in the persisted doc (safe-merge)', async () => {
    mocks.docState.exists = true;
    mocks.docState.data = {
      config: {
        attributionMode: 'per_event',
        __evil: 'rm -rf', // must be ignored by applyPartialConfig
      },
    };

    await loadEloConfigFromFirestore();

    expect(getEloConfig().attributionMode).toBe('per_event');
    expect((getEloConfig() as unknown as Record<string, unknown>)['__evil']).toBeUndefined();
  });

  it('falls back gracefully when the doc get throws', async () => {
    mocks.docState.getError = new Error('permission-denied');

    const result = await loadEloConfigFromFirestore();

    expect(result.source).toBe('error');
    expect(getEloConfig().attributionMode).toBe('legacy'); // untouched default
  });

  it('exposes loadEloConfigFromSupabase as a back-compat alias during the rewrite', () => {
    expect(loadEloConfigFromSupabase).toBe(loadEloConfigFromFirestore);
  });
});

// ---------------------------------------------------------------------------
// Subscribe path — subscribeEloConfigChanges
// ---------------------------------------------------------------------------

describe('EloConfigLoader.subscribeEloConfigChanges', () => {
  it('opens exactly one Firestore snapshot listener even if called twice', () => {
    const first = subscribeEloConfigChanges();
    const second = subscribeEloConfigChanges();
    expect(first).toBe(second);
    expect(mocks.onSnapshotSpy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Write path — persistEloConfigOverride (hot reload correctness)
// ---------------------------------------------------------------------------

describe('EloConfigLoader.persistEloConfigOverride', () => {
  it('applies in-memory change immediately before Firestore write', async () => {
    expect(getEloConfig().attributionMode).toBe('legacy');

    await persistEloConfigOverride({ attributionMode: 'per_event' }, 'admin@example.com');

    // setEloConfig is called synchronously in applyPartialConfig, so the
    // in-memory flip is visible before we even await the set.
    expect(getEloConfig().attributionMode).toBe('per_event');
    expect(mocks.setSpy).toHaveBeenCalledTimes(1);
  });

  it('preserves Phase 1 fields when merging partial override', async () => {
    mocks.docState.exists = true;
    mocks.docState.data = {
      config: {
        // Existing doc has a tweaked outcome weight from Phase 1 tuning.
        outcomeWeights: {
          good_wins_quests: 1.0,
          evil_wins_quests: 1.0,
          assassin_kills_merlin: 2.0, // bumped from 1.5 seed
        },
        attributionMode: 'legacy',
      },
    };

    // Flip only the attributionMode — assassin multiplier in the doc must
    // survive the set round-trip (read-modify-write inside the loader).
    await persistEloConfigOverride({ attributionMode: 'per_event' }, null);

    const writtenDoc = mocks.setSpy.mock.calls[0][0] as {
      config: { outcomeWeights?: { assassin_kills_merlin?: number }; attributionMode?: string };
    };
    expect(writtenDoc.config.attributionMode).toBe('per_event');
    expect(writtenDoc.config.outcomeWeights?.assassin_kills_merlin).toBe(2.0);
  });

  it('merges attribution weights without wiping companion factor', async () => {
    mocks.docState.exists = true;
    mocks.docState.data = {
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

    const writtenDoc = mocks.setSpy.mock.calls[0][0] as {
      config: { attributionWeights: { proposal: number; outerWhiteInnerBlack: number } };
    };
    expect(writtenDoc.config.attributionWeights.proposal).toBe(2.5);
    expect(writtenDoc.config.attributionWeights.outerWhiteInnerBlack).toBe(3.5);
  });

  it('flips shadow writer kill-switch when shadowEnabled is persisted', async () => {
    await persistEloConfigOverride({ shadowEnabled: true }, 'admin@example.com');
    expect(getEloConfig().shadowEnabled).toBe(true);
  });
});
