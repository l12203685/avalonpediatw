/**
 * GameImportService — historical game import wrapped behind an HTTP API.
 *
 * Backs the `POST /api/admin/games/import/{sheets,json}` endpoints. The CLI
 * form lives in `scripts/import-games.ts` and is kept around for ops /
 * scripted bulk imports; the JSON-parsing logic here is a deliberate copy
 * of that script rather than a cross-package import, because:
 *
 *   1. `scripts/` is outside `packages/server/src/`, so the server tsconfig
 *      (`rootDir: ./src`) can't pull it in without widening the compile scope.
 *   2. The CLI script pulls in `googleapis` which isn't a server runtime dep,
 *      and adding it just for the HTTP path would bloat the server image.
 *   3. Keeping the two surfaces separate means a regression in the admin API
 *      can't take out the batch ops tool, and vice versa.
 *
 * Design:
 *   - Sheets mode is a 501 stub here. Admins who need it go through the CLI
 *     script. The UI shows the radio option disabled with a "CLI only (Phase
 *     2)" hint so nobody clicks it expecting it to work.
 *   - JSON mode takes the ProAvalon-legacy JSON shape (array of objects) as
 *     a raw `unknown`, validates each row, and writes in Firestore batches
 *     of up to 500 (Firestore batched-write cap).
 *   - Dry-run skips all writes but still returns a preview + counts so the
 *     admin can eyeball before committing.
 *
 * Security: callers MUST be wrapped in `requireAdminAuth`; this module has
 * no auth check on its own.
 */

import { getAdminFirestore, isFirebaseAdminReady } from './firebase';

// ── Shared types (copied from scripts/import-games.ts to stay in sync) ─────

type QuestResult = 'success' | 'fail';

type Role =
  | 'merlin'
  | 'percival'
  | 'loyal'
  | 'assassin'
  | 'morgana'
  | 'oberon'
  | 'mordred'
  | 'minion';

export interface GamePlayerRecord {
  playerId: string;
  displayName: string;
  role: Role | null;
  team: 'good' | 'evil' | null;
  won: boolean;
}

export interface GameRecord {
  gameId: string;
  roomName: string;
  playerCount: number;
  winner: 'good' | 'evil';
  winReason: string;
  questResults: QuestResult[];
  duration: number;
  players: GamePlayerRecord[];
  createdAt: number;
  endedAt: number;
  source: 'import';
}

export interface ImportResult {
  sourceTag: 'sheets' | 'json';
  preview: GameRecord[];
  totalCount: number;
  writtenCount: number;
  skippedExisting: number;
  errors: { row: number; reason: string }[];
}

// ── JSON source (ProAvalon legacy shape) ────────────────────────────────────

interface SourceRecord {
  _id: string;
  timeGameStarted: string;
  timeGameFinished: string;
  winningTeam: string;
  spyTeam: string[];
  resistanceTeam: string[];
  playerUsernamesOrdered: string[];
  numberOfPlayers: number;
  howTheGameWasWon: string;
  missionHistory: string[];
  roles: string[];
  [key: string]: unknown;
}

function isSourceRecord(v: unknown): v is SourceRecord {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r._id === 'string' &&
    typeof r.timeGameStarted === 'string' &&
    typeof r.timeGameFinished === 'string' &&
    typeof r.winningTeam === 'string' &&
    Array.isArray(r.playerUsernamesOrdered) &&
    typeof r.numberOfPlayers === 'number'
  );
}

function mapJsonQuestResult(mission: string): QuestResult | null {
  if (mission === 'succeeded') return 'success';
  if (mission === 'failed') return 'fail';
  return null;
}

function mapJsonWinReason(howWon: string, winningTeam: string): string {
  if (!howWon) return winningTeam === 'Resistance' ? 'Good team won' : 'Evil team won';
  return howWon;
}

function mapJsonPlayers(source: SourceRecord, winner: 'good' | 'evil'): GamePlayerRecord[] {
  const spySet = new Set(source.spyTeam);
  return source.playerUsernamesOrdered.map((username) => {
    const isEvil = spySet.has(username);
    const team: 'good' | 'evil' = isEvil ? 'evil' : 'good';
    return {
      playerId: username,
      displayName: username,
      role: null,
      team,
      won: team === winner,
    };
  });
}

function jsonRecordToGameRecord(source: SourceRecord): GameRecord | null {
  if (!isSourceRecord(source)) return null;

  const winner: 'good' | 'evil' = source.winningTeam === 'Resistance' ? 'good' : 'evil';
  const startedAt = new Date(source.timeGameStarted).getTime();
  const endedAt = new Date(source.timeGameFinished).getTime();
  if (Number.isNaN(startedAt) || Number.isNaN(endedAt)) return null;

  const questResults: QuestResult[] = [];
  for (const m of source.missionHistory ?? []) {
    const r = mapJsonQuestResult(m);
    if (r) questResults.push(r);
  }

  return {
    gameId: source._id,
    roomName: `Imported Game ${source._id.slice(-6)}`,
    playerCount: source.numberOfPlayers,
    winner,
    winReason: mapJsonWinReason(source.howTheGameWasWon, source.winningTeam),
    questResults,
    duration: Math.max(0, endedAt - startedAt),
    players: mapJsonPlayers(source, winner),
    createdAt: startedAt,
    endedAt,
    source: 'import',
  };
}

// ── Firestore batch import ──────────────────────────────────────────────────

const FIRESTORE_BATCH_LIMIT = 500;
const PREVIEW_ROWS = 10;

async function writeRecordsToFirestore(
  records: GameRecord[],
  dryRun: boolean,
): Promise<{ imported: number; skippedExisting: number }> {
  const firestore = getAdminFirestore();
  let imported = 0;
  let skippedExisting = 0;

  // Pre-check existing docs to avoid overwriting — same contract as the CLI.
  const existingIds = new Set<string>();
  for (const record of records) {
    const snap = await firestore.collection('games').doc(record.gameId).get();
    if (snap.exists) existingIds.add(snap.id);
  }

  // Write in chunks of 500 (Firestore batch cap).
  for (let i = 0; i < records.length; i += FIRESTORE_BATCH_LIMIT) {
    const chunk = records.slice(i, i + FIRESTORE_BATCH_LIMIT);
    const batch = firestore.batch();
    let batchCount = 0;

    for (const record of chunk) {
      if (existingIds.has(record.gameId)) {
        skippedExisting++;
        continue;
      }
      if (dryRun) {
        imported++;
        continue;
      }
      // Firestore rejects undefined fields — drop them before write.
      const cleanRecord = Object.fromEntries(
        Object.entries(record).filter(([, v]) => v !== undefined),
      );
      batch.set(firestore.collection('games').doc(record.gameId), cleanRecord);
      batchCount++;
      imported++;
    }

    if (!dryRun && batchCount > 0) {
      await batch.commit();
    }
  }

  return { imported, skippedExisting };
}

// ── Public API ──────────────────────────────────────────────────────────────

export interface ImportJsonOptions {
  dryRun: boolean;
  limit?: number;
  jsonData: unknown;
}

export async function importFromJson(opts: ImportJsonOptions): Promise<ImportResult> {
  if (!isFirebaseAdminReady()) {
    throw new Error('Firebase admin SDK is not initialised — set FIREBASE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS');
  }

  const { dryRun, limit, jsonData } = opts;

  if (!Array.isArray(jsonData)) {
    throw new Error('Expected a JSON array at the top level.');
  }

  const sliced = typeof limit === 'number' && Number.isFinite(limit)
    ? jsonData.slice(0, Math.max(0, limit))
    : jsonData;

  const valid: GameRecord[] = [];
  const errors: { row: number; reason: string }[] = [];

  sliced.forEach((item, idx) => {
    const record = jsonRecordToGameRecord(item as SourceRecord);
    if (record) {
      valid.push(record);
    } else {
      errors.push({ row: idx, reason: 'Bad shape — missing required fields or bad timestamps' });
    }
  });

  const { imported, skippedExisting } = await writeRecordsToFirestore(valid, dryRun);

  return {
    sourceTag: 'json',
    preview: valid.slice(0, PREVIEW_ROWS),
    totalCount: sliced.length,
    writtenCount: imported,
    skippedExisting,
    errors,
  };
}

export interface ImportSheetsOptions {
  dryRun: boolean;
  limit?: number;
  sheetId?: string;
}

/**
 * Sheets import — **not wired up** on the HTTP path yet. Admins who need to
 * pull from Google Sheets currently run the CLI form of `scripts/import-games.ts`
 * which has the `googleapis` dep and the Chinese column parser.
 *
 * This stub exists so the route handler has something to call and return
 * a consistent 501 payload, instead of the route throwing.
 */
export async function importFromSheets(_opts: ImportSheetsOptions): Promise<ImportResult> {
  throw new GameImportNotImplementedError(
    'Sheets 來源目前僅支援 CLI — 請聯絡開發者從 scripts/import-games.ts 執行，或改用 JSON 上傳',
  );
}

export class GameImportNotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GameImportNotImplementedError';
  }
}
