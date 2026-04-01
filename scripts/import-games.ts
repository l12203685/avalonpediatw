/**
 * import-games.ts
 *
 * Imports historical Avalon game records into Firestore (games/{gameId}).
 *
 * Supports two sources:
 *   --source=sheets  Read from Google Sheets (default)
 *   --source=json    Read from ProAvalon JSON export (legacy fallback)
 *
 * ── Google Sheets source ──────────────────────────────────────────────────────
 *
 * Sheet ID:   174L-by-dtP6IY1pRy8nMpG6_3RMBQXmAV4kTfIgmyIU
 * Sheet name: Games  (tab must exist; row 1 = header)
 *
 * Expected column headers (exact, case-sensitive):
 *   gameId          string   unique ID (e.g. game_20240101_001)
 *   roomName        string   e.g. "Room 7"
 *   playerCount     number   5–10
 *   winner          string   "good" | "evil"
 *   winReason       string   free text
 *   questResults    string   comma-separated: "success,fail,success,success,fail"
 *   duration        number   seconds (converted to ms internally)
 *   createdAt       string   ISO 8601 or Excel serial date
 *   endedAt         string   ISO 8601 or Excel serial date
 *   players         string   JSON array of GamePlayerRecord objects (see below)
 *
 * players JSON format (inline in cell):
 *   [{"playerId":"alice","displayName":"Alice","role":"merlin","team":"good","won":true}, ...]
 *   role can be null or omitted.
 *
 * Auth: set GOOGLE_SHEETS_CREDENTIALS env var to the path of the service account
 *       JSON file, or GOOGLE_SHEETS_CREDENTIALS_JSON to the raw JSON string.
 *       Falls back to GOOGLE_APPLICATION_CREDENTIALS (ADC).
 *
 * ── JSON source (ProAvalon legacy) ───────────────────────────────────────────
 *
 *   export GOOGLE_APPLICATION_CREDENTIALS=/path/to/serviceAccount.json
 *   npx tsx scripts/import-games.ts --source=json --file path/to/records.json [--dry-run] [--limit N]
 *
 * ── Sheets usage ─────────────────────────────────────────────────────────────
 *
 *   export GOOGLE_SHEETS_CREDENTIALS=/path/to/gs-creds.json
 *   npx tsx scripts/import-games.ts --source=sheets [--sheet-name Games] [--dry-run] [--limit N]
 *
 * ── Firestore auth (both sources) ────────────────────────────────────────────
 *
 *   export FIREBASE_SERVICE_ACCOUNT_JSON='{"type":"service_account",...}'
 *   # or
 *   export GOOGLE_APPLICATION_CREDENTIALS=/path/to/serviceAccount.json
 */

import * as admin from 'firebase-admin';
import * as fs from 'fs';
import * as path from 'path';
import { google } from 'googleapis';

// ── Shared types ─────────────────────────────────────────────────────────────

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

interface GamePlayerRecord {
  playerId: string;
  displayName: string;
  role: Role | null;
  team: 'good' | 'evil' | null;
  won: boolean;
}

interface GameRecord {
  gameId: string;
  roomName: string;
  playerCount: number;
  winner: 'good' | 'evil';
  winReason: string;
  questResults: QuestResult[];
  duration: number; // milliseconds
  players: GamePlayerRecord[];
  createdAt: number;
  endedAt: number;
  source: 'import';
}

// ── Role mapping (ProAvalon JSON → project schema) ───────────────────────────

const ROLE_MAP: Record<string, Role> = {
  merlin: 'merlin',
  percival: 'percival',
  assassin: 'assassin',
  morgana: 'morgana',
  oberon: 'oberon',
  mordred: 'mordred',
  loyal: 'loyal',
  minion: 'minion',
  Merlin: 'merlin',
  Percival: 'percival',
  Assassin: 'assassin',
  Morgana: 'morgana',
  Oberon: 'oberon',
  Mordred: 'mordred',
  'Loyal Servant of Arthur': 'loyal',
  'Minion of Mordred': 'minion',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseQuestResults(raw: string): QuestResult[] {
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is QuestResult => s === 'success' || s === 'fail');
}

/** Convert an ISO string or Excel serial number to Unix ms. */
function parseTimestamp(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Excel serial date: integer like 45292
  const serial = Number(trimmed);
  if (!Number.isNaN(serial) && serial > 1000 && serial < 100000) {
    // Excel epoch is 1899-12-30
    const msFromEpoch = (serial - 25569) * 86400 * 1000;
    return msFromEpoch;
  }

  const ms = new Date(trimmed).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function parsePlayerRecords(raw: string): GamePlayerRecord[] | null {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) return null;
    return parsed.map((p) => {
      const player = p as Record<string, unknown>;
      const rawRole = typeof player.role === 'string' ? player.role : null;
      const role: Role | null =
        rawRole !== null ? (ROLE_MAP[rawRole] ?? null) : null;
      return {
        playerId: String(player.playerId ?? ''),
        displayName: String(player.displayName ?? player.playerId ?? ''),
        role,
        team:
          player.team === 'good' || player.team === 'evil'
            ? player.team
            : null,
        won: Boolean(player.won),
      };
    });
  } catch {
    return null;
  }
}

// ── Google Sheets source ──────────────────────────────────────────────────────

const SHEET_ID = '174L-by-dtP6IY1pRy8nMpG6_3RMBQXmAV4kTfIgmyIU';

async function buildSheetsClient() {
  const credsPath = process.env.GOOGLE_SHEETS_CREDENTIALS;
  const credsJson = process.env.GOOGLE_SHEETS_CREDENTIALS_JSON;

  let auth: ConstructorParameters<typeof google.auth.GoogleAuth>[0]['credentials'];

  if (credsJson) {
    auth = JSON.parse(credsJson);
  } else if (credsPath) {
    const raw = fs.readFileSync(path.resolve(credsPath), 'utf-8');
    auth = JSON.parse(raw);
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    // ADC — let the library handle it
  } else {
    throw new Error(
      'No Google Sheets credentials found.\n' +
        'Set GOOGLE_SHEETS_CREDENTIALS (file path) or GOOGLE_SHEETS_CREDENTIALS_JSON (raw JSON).'
    );
  }

  const googleAuth = new google.auth.GoogleAuth({
    credentials: auth,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });

  return google.sheets({ version: 'v4', auth: googleAuth });
}

/** Validate and parse a single sheets row against the header map. */
function rowToGameRecord(
  row: string[],
  headerIndex: Map<string, number>
): GameRecord | null {
  const get = (col: string): string => row[headerIndex.get(col) ?? -1] ?? '';

  const gameId = get('gameId').trim();
  if (!gameId) return null;

  const winner = get('winner').trim().toLowerCase();
  if (winner !== 'good' && winner !== 'evil') {
    console.warn(`  [skip] gameId="${gameId}" invalid winner="${winner}"`);
    return null;
  }

  const playerCount = parseInt(get('playerCount'), 10);
  if (Number.isNaN(playerCount)) {
    console.warn(`  [skip] gameId="${gameId}" invalid playerCount`);
    return null;
  }

  const durationSec = parseFloat(get('duration'));
  const duration = Number.isNaN(durationSec) ? 0 : Math.round(durationSec * 1000);

  const createdAt = parseTimestamp(get('createdAt'));
  const endedAt = parseTimestamp(get('endedAt'));
  if (createdAt === null || endedAt === null) {
    console.warn(`  [skip] gameId="${gameId}" invalid timestamps`);
    return null;
  }

  const questResults = parseQuestResults(get('questResults'));

  const players = parsePlayerRecords(get('players'));
  if (players === null) {
    console.warn(`  [skip] gameId="${gameId}" invalid players JSON`);
    return null;
  }

  return {
    gameId,
    roomName: get('roomName').trim() || `Imported Game ${gameId.slice(-6)}`,
    playerCount,
    winner,
    winReason: get('winReason').trim() || (winner === 'good' ? 'Good team won' : 'Evil team won'),
    questResults,
    duration,
    players,
    createdAt,
    endedAt,
    source: 'import',
  };
}

async function loadFromSheets(sheetName: string, limit: number): Promise<GameRecord[]> {
  const sheets = await buildSheetsClient();

  const range = `${sheetName}!A1:Z`;
  console.log(`Fetching: spreadsheet=${SHEET_ID} range="${range}"`);

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range,
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'FORMATTED_STRING',
  });

  const rows = resp.data.values;
  if (!rows || rows.length < 2) {
    console.log('Sheet is empty or has only a header row.');
    return [];
  }

  // Build column index from header row (row 0)
  const headerRow = rows[0].map(String);
  const headerIndex = new Map<string, number>();
  headerRow.forEach((h, i) => {
    if (h.trim()) headerIndex.set(h.trim(), i);
  });

  const requiredCols = ['gameId', 'winner', 'playerCount', 'createdAt', 'endedAt'];
  const missing = requiredCols.filter((c) => !headerIndex.has(c));
  if (missing.length > 0) {
    throw new Error(
      `Sheet "${sheetName}" is missing required columns: ${missing.join(', ')}\n` +
        `Found columns: ${[...headerIndex.keys()].join(', ')}`
    );
  }

  console.log(`Header columns: ${[...headerIndex.keys()].join(', ')}`);
  console.log(`Data rows: ${rows.length - 1}`);

  const dataRows = rows.slice(1, isFinite(limit) ? limit + 1 : undefined);
  const valid: GameRecord[] = [];
  let parseErrors = 0;

  for (const row of dataRows) {
    const strRow = row.map(String);
    const record = rowToGameRecord(strRow, headerIndex);
    if (record) {
      valid.push(record);
    } else {
      parseErrors++;
    }
  }

  console.log(`Parsed: ${valid.length} valid, ${parseErrors} skipped (bad format)`);
  return valid;
}

// ── ProAvalon JSON source (legacy) ────────────────────────────────────────────

interface SourceRecord {
  _id: string;
  timeGameStarted: string;
  timeGameFinished: string;
  winningTeam: string;
  spyTeam: string[];
  resistanceTeam: string[];
  gameMode: string;
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

function loadFromJson(filePath: string, limit: number): GameRecord[] {
  console.log(`Reading: ${filePath}`);
  const raw: unknown = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

  if (!Array.isArray(raw)) {
    throw new Error('Expected a JSON array at the top level.');
  }

  const valid: GameRecord[] = [];
  let parseErrors = 0;

  for (const item of raw.slice(0, isFinite(limit) ? limit : raw.length)) {
    const record = jsonRecordToGameRecord(item as SourceRecord);
    if (record) {
      valid.push(record);
    } else {
      parseErrors++;
    }
  }

  console.log(`Parsed: ${valid.length} valid, ${parseErrors} skipped (bad format)`);
  return valid;
}

// ── Firebase init ─────────────────────────────────────────────────────────────

function initAdmin(): void {
  if (admin.apps.length > 0) return;

  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if (serviceAccountJson) {
    const serviceAccount = JSON.parse(serviceAccountJson);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    admin.initializeApp(
      process.env.FIREBASE_PROJECT_ID
        ? { projectId: process.env.FIREBASE_PROJECT_ID }
        : {}
    );
  } else {
    throw new Error(
      'No Firebase credentials found.\n' +
        'Set FIREBASE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS.'
    );
  }
}

// ── Batch import to Firestore ─────────────────────────────────────────────────

const FIRESTORE_BATCH_LIMIT = 500;

async function importBatch(
  firestore: admin.firestore.Firestore,
  records: GameRecord[],
  dryRun: boolean
): Promise<{ imported: number; skipped: number }> {
  let imported = 0;
  let skipped = 0;

  const chunks: GameRecord[][] = [];
  for (let i = 0; i < records.length; i += FIRESTORE_BATCH_LIMIT) {
    chunks.push(records.slice(i, i + FIRESTORE_BATCH_LIMIT));
  }

  // Check which IDs already exist
  const existingIds = new Set<string>();
  for (const chunk of chunks) {
    const refs = chunk.map((r) => firestore.collection('games').doc(r.gameId));
    const snaps = await firestore.getAll(...refs);
    for (const snap of snaps) {
      if (snap.exists) existingIds.add(snap.id);
    }
  }

  // Write in batches
  for (const chunk of chunks) {
    const batch = firestore.batch();
    let batchCount = 0;

    for (const record of chunk) {
      if (existingIds.has(record.gameId)) {
        skipped++;
        continue;
      }

      if (dryRun) {
        console.log(
          `[dry-run] Would import: ${record.gameId} (${record.playerCount}p, winner=${record.winner})`
        );
        imported++;
        continue;
      }

      batch.set(firestore.collection('games').doc(record.gameId), record);
      batchCount++;
      imported++;
    }

    if (!dryRun && batchCount > 0) {
      await batch.commit();
      console.log(`  Committed batch of ${batchCount} records.`);
    }
  }

  return { imported, skipped };
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function printUsage(): void {
  console.log(`
Usage:
  # From Google Sheets (default):
  npx tsx scripts/import-games.ts [--source=sheets] [--sheet-name Games] [--dry-run] [--limit N]

  # From ProAvalon JSON (legacy):
  npx tsx scripts/import-games.ts --source=json --file path/to/records.json [--dry-run] [--limit N]

Environment:
  GOOGLE_SHEETS_CREDENTIALS      Path to Google Sheets service account JSON
  GOOGLE_SHEETS_CREDENTIALS_JSON Raw JSON string of service account
  FIREBASE_SERVICE_ACCOUNT_JSON  Raw JSON string of Firebase service account
  GOOGLE_APPLICATION_CREDENTIALS Path to ADC credentials (covers both APIs)
  FIREBASE_PROJECT_ID            Firebase project ID (when using ADC)

Google Sheet: https://docs.google.com/spreadsheets/d/174L-by-dtP6IY1pRy8nMpG6_3RMBQXmAV4kTfIgmyIU
Sheet tab name: Games (configurable via --sheet-name)

Required columns in "Games" tab:
  gameId, winner, playerCount, createdAt, endedAt

Optional columns:
  roomName, winReason, questResults (comma-separated), duration (seconds), players (JSON array)
`);
}

function getArg(args: string[], flag: string): string | undefined {
  const entry = args.find((a) => a.startsWith(`${flag}=`));
  return entry?.slice(flag.length + 1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  const source = getArg(args, '--source') ?? 'sheets';
  const dryRun = args.includes('--dry-run');
  const limitStr = getArg(args, '--limit');
  const limit = limitStr ? parseInt(limitStr, 10) : Infinity;

  if (!['sheets', 'json'].includes(source)) {
    console.error(`Unknown --source="${source}". Use "sheets" or "json".`);
    process.exit(1);
  }

  let records: GameRecord[];

  if (source === 'json') {
    const fileIdx = args.indexOf('--file');
    if (fileIdx === -1 || !args[fileIdx + 1]) {
      console.error('--source=json requires --file <path>');
      printUsage();
      process.exit(1);
    }
    const filePath = path.resolve(args[fileIdx + 1]);
    if (!fs.existsSync(filePath)) {
      console.error(`File not found: ${filePath}`);
      process.exit(1);
    }
    records = loadFromJson(filePath, limit);
  } else {
    const sheetName = getArg(args, '--sheet-name') ?? '牌譜';
    records = await loadFromSheets(sheetName, limit);
  }

  if (records.length === 0) {
    console.log('Nothing to import.');
    return;
  }

  if (dryRun) {
    console.log('[dry-run] No changes will be written to Firestore.');
  }

  initAdmin();
  const firestore = admin.firestore();

  const { imported, skipped } = await importBatch(firestore, records, dryRun);

  console.log(
    `Done. imported=${imported}, skipped_existing=${skipped}`
  );
}

main().catch((err: unknown) => {
  console.error('Fatal error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
