import { gzipSync, gunzipSync } from 'zlib';
import {
  ReasoningEntry,
  ReasoningDecisionType,
  SelfplayReasoningRecord,
} from '@avalon/shared';
import { getAdminFirestore } from './firebase';

/**
 * Selfplay reasoning Repository (Wave D 2026-04-29).
 *
 * Collection: `selfplay_reasoning/{gameId}` — separate from `games_v2/`
 * so leaderboard / stats queries don't accidentally pull the gzip blob.
 *
 * Storage strategy (Option F):
 *   1. Atoms (派/投/任務/湖中/刺殺) live in `games_v2/{gameId}`.
 *   2. Reasoning trace lives here as `gzip(JSONL) → base64`. ~2.4 KB per
 *      10p game (down from ~48 KB raw JSON).
 *   3. ML / replay flow batch-reads this collection separately when it
 *      needs the natural-language thoughts.
 *
 * See `staging/subagent_results/selfplay_db_storage_eval_2026-04-29.md`
 * for the full design rationale.
 */
export class SelfPlayReasoningRepository {
  private readonly collection = 'selfplay_reasoning';

  /**
   * Build the storage doc from raw entries (caller does NOT compress —
   * keeps the contract one-step). Returns the doc plus the un-encoded
   * size so callers can log compression stats.
   */
  static buildRecord(gameId: string, entries: ReasoningEntry[]): SelfplayReasoningRecord {
    const jsonl = entries.map((e) => JSON.stringify(e)).join('\n');
    const gzipped = gzipSync(Buffer.from(jsonl, 'utf8'));
    const gzReasoningB64 = gzipped.toString('base64');

    const decisionTypes: Partial<Record<ReasoningDecisionType, number>> = {};
    let keptForRender = 0;
    for (const e of entries) {
      decisionTypes[e.decisionType] = (decisionTypes[e.decisionType] ?? 0) + 1;
      // Renderer keeps: anomaly votes (anomalyType !== null), red-side
      // mission votes (missionVoteType !== null), every lake event
      // (lake_target / lake_declare), every team_select, and assassinate.
      const kept =
        e.decisionType === 'team_select' ||
        e.decisionType === 'lake_target' ||
        e.decisionType === 'lake_declare' ||
        e.decisionType === 'assassinate' ||
        (e.decisionType === 'team_vote' && e.anomalyType !== null) ||
        (e.decisionType === 'quest_vote' && e.missionVoteType !== null);
      if (kept) keptForRender += 1;
    }

    return {
      schemaVersion: 1,
      gameId,
      rowCount: entries.length,
      gzReasoningB64,
      meta: {
        decisionTypes,
        keptForRender,
      },
    };
  }

  /**
   * Reverse the gzip+base64 to recover the original entries (used by
   * future replay / training pipeline).
   */
  static decodeEntries(record: SelfplayReasoningRecord): ReasoningEntry[] {
    const gz = Buffer.from(record.gzReasoningB64, 'base64');
    const jsonl = gunzipSync(gz).toString('utf8');
    if (!jsonl.trim()) return [];
    return jsonl
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as ReasoningEntry);
  }

  /**
   * Persist a reasoning record. Idempotent on `gameId`.
   */
  async save(record: SelfplayReasoningRecord): Promise<void> {
    try {
      const firestore = getAdminFirestore();
      const docRef = firestore.collection(this.collection).doc(record.gameId);
      await docRef.set(record);
      console.log(JSON.stringify({
        timestamp: new Date().toISOString(),
        event: 'selfplay_reasoning_saved',
        gameId: record.gameId,
        rowCount: record.rowCount,
        keptForRender: record.meta.keptForRender,
        sizeBytes: record.gzReasoningB64.length,
      }));
    } catch (error) {
      console.error(JSON.stringify({
        timestamp: new Date().toISOString(),
        event: 'selfplay_reasoning_save_error',
        gameId: record.gameId,
        error: error instanceof Error ? error.message : 'Unknown error',
      }));
      throw error;
    }
  }

  /**
   * Convenience: build + save in one shot. Returns the saved record.
   */
  async saveFromEntries(gameId: string, entries: ReasoningEntry[]): Promise<SelfplayReasoningRecord> {
    const record = SelfPlayReasoningRepository.buildRecord(gameId, entries);
    await this.save(record);
    return record;
  }

  /** Read a single record; null when missing. */
  async get(gameId: string): Promise<SelfplayReasoningRecord | null> {
    try {
      const firestore = getAdminFirestore();
      const doc = await firestore.collection(this.collection).doc(gameId).get();
      if (!doc.exists) return null;
      return doc.data() as SelfplayReasoningRecord;
    } catch (error) {
      console.error(JSON.stringify({
        timestamp: new Date().toISOString(),
        event: 'selfplay_reasoning_load_error',
        gameId,
        error: error instanceof Error ? error.message : 'Unknown error',
      }));
      return null;
    }
  }
}
