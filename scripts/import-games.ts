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
 * Sheet name: 牌譜  (tab must exist; row 1 = header)
 *
 * Expected column headers (Chinese, 48 columns total):
 *   流水號         string   unique game ID
 *   日期時間       string   ISO 8601 or Excel serial date → createdAt
 *   結果           string   "好人勝" / "壞人勝" / numeric → winner (good|evil)
 *   玩1–玩0        string   10 player name columns → players array + playerCount
 *   第一局成功失敗–第五局成功失敗   string  "成功"/"失敗" → questResults
 *   配置           string   game configuration (stored as metadata)
 *   刺殺           string   assassination result (stored as metadata)
 *   分類           string   game category/type (stored as metadata)
 *   場次           string   session/round
 *   頁碼           string   page reference
 *   note           string   free-form note
 *   文字記錄       string   text log
 *   第一局–第五局  string   quest detail columns (stored as metadata)
 *   組成           string   team composition
 *   強人,戳人,局勢 string   game dynamics
 *   首湖–三湖      string   lake info
 *   首湖玩家–三湖玩家 string lake player info
 *   角1,角4,角5,角0 string  role assignments
 *   1-1,派5,派0,外灑 string mission/dispatch info
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
 *   npx tsx scripts/import-games.ts --source=sheets [--sheet-name 牌譜] [--dry-run] [--limit N]
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
  // Additional fields from Chinese sheet
  configuration?: string;    // 配置
  assassination?: string;    // 刺殺
  category?: string;         // 分類
  session?: string;          // 場次
  pageRef?: string;          // 頁碼
  note?: string;             // note
  textLog?: string;          // 文字記錄
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

// ── Chinese sheet column constants ───────────────────────────────────────────

/** The 10 player columns in the sheet, ordered 玩1 … 玩0. */
const PLAYER_COLS = ['玩1', '玩2', '玩3', '玩4', '玩5', '玩6', '玩7', '玩8', '玩9', '玩0'];

/** The 5 quest success/fail columns. */
const QUEST_RESULT_COLS = [
  '第一局成功失敗',
  '第二局成功失敗',
  '第三局成功失敗',
  '第四局成功失敗',
  '第五局成功失敗',
];

/**
 * Parse the 結果 cell into winner 'good' | 'evil'.
 * Accepts Chinese text ("好人", "藍", "成功") for good and
 * ("壞人", "紅", "刺殺成功", "evil") for evil, plus numeric 0/1.
 */
function parseWinner(raw: string): 'good' | 'evil' | null {
  const v = raw.trim().toLowerCase();
  if (!v) return null;
  if (v === '0' || v === 'good' || v.startsWith('好') || v.startsWith('藍') || v === '成功') {
    return 'good';
  }
  if (v === '1' || v === 'evil' || v.startsWith('壞') || v.startsWith('紅') || v.startsWith('刺殺')) {
    return 'evil';
  }
  return null;
}

/**
 * Parse a single 第N局成功失敗 cell into a QuestResult.
 * Accepts "成功" / "success" for success, "失敗" / "fail" for fail.
 */
function parseQuestCell(raw: string): QuestResult | null {
  const v = raw.trim().toLowerCase();
  if (v === '成功' || v === 'success' || v === 'o' || v === '○') return 'success';
  if (v === '失敗' || v === 'fail' || v === 'x' || v === '×' || v === '✗') return 'fail';
  return null;
}

/**
 * Build the players array from the 10 player name columns (玩1–玩0).
 * Returns both the player list (non-empty cells) and the count.
 */
function parsePlayers(
  row: string[],
  headerIndex: Map<string, number>,
  winner: 'good' | 'evil'
): { players: GamePlayerRecord[]; playerCount: number } {
  const names: string[] = [];
  for (const col of PLAYER_COLS) {
    const idx = headerIndex.get(col);
    const name = idx !== undefined ? (row[idx] ?? '').trim() : '';
    if (name) names.push(name);
  }

  const players: GamePlayerRecord[] = names.map((name) => ({
    playerId: name,
    displayName: name,
    role: null,
    team: null,
    won: false, // team/won unknown without role data
  }));

  return { players, playerCount: names.length };
}

/** Validate and parse a single sheets row against the Chinese header map. */
function rowToGameRecord(
  row: string[],
  headerIndex: Map<string, number>
): GameRecord | null {
  const get = (col: string): string => {
    const idx = headerIndex.get(col);
    return idx !== undefined ? (row[idx] ?? '').toString().trim() : '';
  };

  // ── gameId ────────────────────────────────────────────────────────────────
  const gameId = get('流水號');
  if (!gameId) return null;

  // ── winner ────────────────────────────────────────────────────────────────
  const winner = parseWinner(get('結果'));
  if (winner === null) {
    console.warn(`  [skip] gameId="${gameId}" invalid 結果="${get('結果')}"`);
    return null;
  }

  // ── createdAt ─────────────────────────────────────────────────────────────
  const createdAt = parseTimestamp(get('日期時間'));
  if (createdAt === null) {
    console.warn(`  [skip] gameId="${gameId}" invalid 日期時間="${get('日期時間')}"`);
    return null;
  }

  // ── players + playerCount ─────────────────────────────────────────────────
  const { players, playerCount } = parsePlayers(row, headerIndex, winner);
  if (playerCount === 0) {
    console.warn(`  [skip] gameId="${gameId}" no player columns found`);
    return null;
  }

  // ── questResults ──────────────────────────────────────────────────────────
  const questResults: QuestResult[] = [];
  for (const col of QUEST_RESULT_COLS) {
    const cell = get(col);
    if (!cell) break; // stop at first empty — quests are sequential
    const r = parseQuestCell(cell);
    if (r !== null) questResults.push(r);
  }

  // ── optional metadata ─────────────────────────────────────────────────────
  const configuration = get('配置') || undefined;
  const assassination = get('刺殺') || undefined;
  const category = get('分類') || undefined;
  const session = get('場次') || undefined;
  const pageRef = get('頁碼') || undefined;
  const note = get('note') || undefined;
  const textLog = get('文字記錄') || undefined;

  return {
    gameId,
    roomName: session ? `場次 ${session}` : `Imported Game ${gameId.slice(-6)}`,
    playerCount,
    winner,
    winReason: assassination
      ? assassination
      : winner === 'good' ? '好人勝' : '壞人勝',
    questResults,
    duration: 0,
    players,
    createdAt,
    endedAt: createdAt, // sheet has no separate end time
    source: 'import',
    configuration,
    assassination,
    category,
    session,
    pageRef,
    note,
    textLog,
  };
}

async function loadFromSheets(sheetName: string, limit: number): Promise<GameRecord[]> {
  const sheets = await buildSheetsClient();

  // Sheet has 48 columns — use A1:AV to cover all of them
  const range = `${sheetName}!A1:AV`;
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

  // Required Chinese column names
  const requiredCols = ['流水號', '結果', '日期時間'];
  const missing = requiredCols.filter((c) => !headerIndex.has(c));
  if (missing.length > 0) {
    throw new Error(
      `Sheet "${sheetName}" is missing required columns: ${missing.join(', ')}\n` +
        `Found columns: ${[...headerIndex.keys()].join(', ')}`
    );
  }

  // Warn if player columns are absent (soft warning — not fatal)
  const missingPlayers = PLAYER_COLS.filter((c) => !headerIndex.has(c));
  if (missingPlayers.length > 0) {
    console.warn(`  [warn] Missing player columns: ${missingPlayers.join(', ')}`);
  }

  console.log(`Header columns (${headerIndex.size}): ${[...headerIndex.keys()].join(', ')}`);
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
  npx tsx scripts/import-games.ts [--source=sheets] [--sheet-name 牌譜] [--dry-run] [--limit N]

  # From ProAvalon JSON (legacy):
  npx tsx scripts/import-games.ts --source=json --file path/to/records.json [--dry-run] [--limit N]

Environment:
  GOOGLE_SHEETS_CREDENTIALS      Path to Google Sheets service account JSON
  GOOGLE_SHEETS_CREDENTIALS_JSON Raw JSON string of service account
  FIREBASE_SERVICE_ACCOUNT_JSON  Raw JSON string of Firebase service account
  GOOGLE_APPLICATION_CREDENTIALS Path to ADC credentials (covers both APIs)
  FIREBASE_PROJECT_ID            Firebase project ID (when using ADC)

Google Sheet: https://docs.google.com/spreadsheets/d/174L-by-dtP6IY1pRy8nMpG6_3RMBQXmAV4kTfIgmyIU
Sheet tab name: 牌譜 (configurable via --sheet-name)

Required columns (Chinese headers):
  流水號       game ID
  結果         winner: accepts 好人/藍/0 → good; 壞人/紅/刺殺/1 → evil
  日期時間     created timestamp (ISO 8601 or Excel serial)

Player columns (non-empty cells counted as playerCount):
  玩1, 玩2, 玩3, 玩4, 玩5, 玩6, 玩7, 玩8, 玩9, 玩0

Quest result columns (成功 / 失敗):
  第一局成功失敗 through 第五局成功失敗

Optional columns:
  配置  刺殺  分類  場次  頁碼  note  文字記錄
  第一局 through 第五局 (detail)
  組成  強人  戳人  局勢
  首湖  二湖  三湖  首湖玩家  二湖玩家  三湖玩家
  角1  角4  角5  角0  1-1  派5  派0  外灑
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
