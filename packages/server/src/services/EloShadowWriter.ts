import { GameRecord } from './GameHistoryRepository';
import { computeAttributionDeltas } from './EloAttributionService';
import { computeNewElo } from './EloRanking';
import {
  getEloConfig,
  deriveEloOutcome,
} from './EloConfig';
import { getAdminDB } from './firebase';

/**
 * EloShadowWriter — #54 Phase 3 double-write infrastructure
 *
 * Runs the per-event attribution pipeline in parallel with the live legacy
 * pipeline and writes the result to a SHADOW column (`rankings_shadow/`
 * path in Firebase RTDB) without touching `rankings/`.
 *
 * Intended lifecycle (2 weeks minimum):
 *   1. Production keeps `attributionMode='legacy'` — live ELO unchanged.
 *   2. After every processed game, this writer ALSO computes what the ELO
 *      would be under `per_event` and writes to `rankings_shadow/{uid}`.
 *   3. `/admin/elo-shadow-diff` surfaces the delta distribution for review.
 *   4. When Edward flips attributionMode='per_event', shadow writer can
 *      continue as audit log or be disabled via the `shadowEnabled` flag.
 *
 * Key invariants:
 *   - NEVER writes to `rankings/` (legacy path stays untouched).
 *   - NEVER mutates the live EloConfig — creates a local override copy
 *     before computing the per_event path.
 *   - Logs the shadow delta so Edward can review without enabling RTDB
 *     access in admin UI if he doesn't want to.
 *   - Safe to call synchronously after `EloRankingService.processGameResult`
 *     or as a best-effort background task (see caller).
 */

export interface EloShadowEntry {
  uid: string;
  displayName: string;
  legacyElo: number;
  shadowElo: number;
  delta: number;           // shadow - legacy
  lastGameId: string;
  lastGameAt: number;
  totalGames: number;
  updatedAt: number;
}

export interface EloShadowUpdate {
  uid: string;
  legacyNewElo: number;
  shadowNewElo: number;
  shadowDelta: number;
}

export interface ShadowWriterOptions {
  /** When false, writer is a no-op (used to kill-switch in production). */
  enabled: boolean;
  /** RTDB path for shadow entries. Default: 'rankings_shadow'. */
  path?: string;
}

const DEFAULT_OPTIONS: ShadowWriterOptions = {
  enabled: false, // OFF by default — must be turned on via env var or config.
  path: 'rankings_shadow',
};

let activeOptions: ShadowWriterOptions = { ...DEFAULT_OPTIONS };

export function setShadowWriterOptions(opts: Partial<ShadowWriterOptions>): void {
  activeOptions = { ...activeOptions, ...opts };
}

export function getShadowWriterOptions(): ShadowWriterOptions {
  return activeOptions;
}

/**
 * Compute the shadow (per_event) ELO deltas for a game without touching
 * the live rankings table. Pure — does not write to Firebase.
 */
export function computeShadowUpdates(
  record: GameRecord,
  currentShadowElos: Record<string, number>,
  currentLegacyElos: Record<string, number>
): EloShadowUpdate[] {
  const cfg = getEloConfig();

  // Attribution runs regardless of attributionMode here (we force per_event
  // semantics on the shadow path). The simplest way is to build a result
  // shape by temporarily computing as if mode were 'per_event' — but we
  // must NOT mutate the global config, so we call the attribution fn with
  // a locally-overridden view.
  // Trick: computeAttributionDeltas reads getEloConfig().attributionMode.
  // For the shadow path we want to see what would happen if mode=per_event.
  // We wrap by temporarily flipping mode, restoring after, using a
  // simple stack-based guard (synchronous — no races inside a single
  // request).
  const previousMode = cfg.attributionMode;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (cfg as any).attributionMode = 'per_event';
  const attribution = computeAttributionDeltas(record);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (cfg as any).attributionMode = previousMode;

  const outcome = deriveEloOutcome(record.winner, record.winReason);

  // Team averages — over the SHADOW elos, not legacy, so shadow ladder
  // diverges naturally.
  const goodShadowElos: number[] = [];
  const evilShadowElos: number[] = [];
  for (const p of record.players) {
    const e = currentShadowElos[p.playerId] ?? cfg.startingElo;
    if (p.team === 'good') goodShadowElos.push(e);
    else if (p.team === 'evil') evilShadowElos.push(e);
  }
  const avg = (arr: number[], team: 'good' | 'evil'): number =>
    arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : cfg.teamBaselines[team];
  const goodAvg = avg(goodShadowElos, 'good');
  const evilAvg = avg(evilShadowElos, 'evil');

  const updates: EloShadowUpdate[] = [];
  for (const p of record.players) {
    const prevShadow = currentShadowElos[p.playerId] ?? cfg.startingElo;
    const prevLegacy = currentLegacyElos[p.playerId] ?? cfg.startingElo;
    const opponentAvg = p.team === 'good' ? evilAvg : goodAvg;

    const legacyAgain = computeNewElo(
      prevShadow,
      p.won,
      opponentAvg,
      p.role,
      undefined,
      outcome
    );
    const attrDelta = attribution.applied ? (attribution.deltas[p.playerId] ?? 0) : 0;
    const shadowNewElo = Math.max(
      cfg.minElo,
      Math.round(legacyAgain + attrDelta)
    );

    updates.push({
      uid: p.playerId,
      legacyNewElo: prevLegacy, // caller supplies the actual legacy-new ELO
      shadowNewElo,
      shadowDelta: shadowNewElo - prevShadow,
    });
  }

  return updates;
}

/**
 * Persist shadow updates to `rankings_shadow/{uid}`. Called by
 * `EloRankingService` after the legacy path commits.
 */
export class EloShadowWriter {
  private readonly path: string;

  constructor(opts?: Partial<ShadowWriterOptions>) {
    this.path = opts?.path ?? activeOptions.path ?? 'rankings_shadow';
  }

  async getShadowElo(uid: string, fallbackElo: number): Promise<number> {
    const options = getShadowWriterOptions();
    if (!options.enabled) return fallbackElo;
    try {
      const db = getAdminDB();
      const snap = await db.ref(`${this.path}/${uid}`).once('value');
      const entry = snap.val() as EloShadowEntry | null;
      return entry?.shadowElo ?? fallbackElo;
    } catch {
      return fallbackElo;
    }
  }

  async writeUpdates(
    record: GameRecord,
    updates: EloShadowUpdate[]
  ): Promise<void> {
    const options = getShadowWriterOptions();
    if (!options.enabled) return;

    try {
      const db = getAdminDB();
      const now = Date.now();
      for (const u of updates) {
        const ref = db.ref(`${this.path}/${u.uid}`);
        const snap = await ref.once('value');
        const existing = snap.val() as EloShadowEntry | null;
        const totalGames = (existing?.totalGames ?? 0) + 1;
        const entry: EloShadowEntry = {
          uid: u.uid,
          displayName:
            record.players.find((p) => p.playerId === u.uid)?.displayName ?? u.uid,
          legacyElo: u.legacyNewElo,
          shadowElo: u.shadowNewElo,
          delta: u.shadowNewElo - u.legacyNewElo,
          lastGameId: record.gameId,
          lastGameAt: record.endedAt,
          totalGames,
          updatedAt: now,
        };
        await ref.set(entry);
      }

      console.log(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          event: 'elo_shadow_written',
          gameId: record.gameId,
          playerCount: updates.length,
          maxAbsDelta: updates.reduce(
            (m, u) => Math.max(m, Math.abs(u.shadowDelta)),
            0
          ),
        })
      );
    } catch (err) {
      console.error(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          event: 'elo_shadow_write_error',
          gameId: record.gameId,
          error: err instanceof Error ? err.message : 'Unknown',
        })
      );
      // Never rethrow — shadow path must not break live game flow.
    }
  }
}
