/**
 * reimport-winreason-from-sheets.ts
 *
 * 2026-04-25 Edward bug 修：原 sheets parser 沒讀「刺殺」欄，導致全 2146 場
 * `winReason` 都被標 `threeBlue_merlinAlive`，三藍死 = 0。修正後此腳本：
 *
 *   1. 重新從 Sheets 讀每一列（含「刺殺」欄）
 *   2. 用修正後的 parser 重算 `finalResult`
 *   3. **只更新 Firestore `games_v2/{gameId}` 的 `finalResult` 欄位**（不動 missions /
 *      ladyChain / playerSeats / 其他欄位）
 *
 * 用法：
 *   --dry-run         只印不寫
 *   --limit N         只處理前 N 列
 *   --start-row N     從第 N 列開始（預設 2）
 *   --sheet-name NAME 工作表 tab（預設 "牌譜"）
 *
 * 範例：
 *   GOOGLE_SHEETS_CREDENTIALS=/path/to/sa.json \
 *   FIREBASE_SERVICE_ACCOUNT_JSON='...' \
 *   pnpm tsx scripts/reimport-winreason-from-sheets.ts --dry-run --limit 10
 */

import * as admin from 'firebase-admin';
import * as fs from 'fs';
import * as path from 'path';
import { google } from 'googleapis';
import type { GameRecordV2 } from '../packages/shared/src/types/game_v2';
import { parseSheetsGameCell } from '../packages/server/src/services/sheetsGameRecordParser';

// ---------------------------------------------------------------------------
// Constants — 與 import-games-v2.ts 對齊
// ---------------------------------------------------------------------------

const SHEET_ID = '174L-by-dtP6IY1pRy8nMpG6_3RMBQXmAV4kTfIgmyIU';
const DEFAULT_TAB = '牌譜';
const PLAYER_COLS = ['玩1', '玩2', '玩3', '玩4', '玩5', '玩6', '玩7', '玩8', '玩9', '玩0'];
const TEXT_LOG_COL_CANDIDATES = ['文字記錄', '文字紀錄', '牌譜', '記錄'];
const ROLE_CODE_COL_CANDIDATES = ['配置', '角色', '角色碼', '角色位', '角'];
const DATE_COL_CANDIDATES = ['日期時間', '日期'];
const GAME_ID_COL_CANDIDATES = ['流水號', 'gameId', 'id'];
const SESSION_COL_CANDIDATES = ['場次', 'session'];
const LOCATION_COL_CANDIDATES = ['分類', 'location', '地點'];
const ASSASSIN_TARGET_COL_CANDIDATES = ['刺殺', '刺殺目標', 'assassin'];

const FIRESTORE_BATCH_LIMIT = 500;

// ---------------------------------------------------------------------------
// Sheets client
// ---------------------------------------------------------------------------

async function buildSheetsClient() {
  const credsPath = process.env.GOOGLE_SHEETS_CREDENTIALS;
  const credsJson = process.env.GOOGLE_SHEETS_CREDENTIALS_JSON;

  let credentials: Record<string, unknown> | undefined;
  if (credsJson) {
    credentials = JSON.parse(credsJson) as Record<string, unknown>;
  } else if (credsPath) {
    const raw = fs.readFileSync(path.resolve(credsPath), 'utf-8');
    credentials = JSON.parse(raw) as Record<string, unknown>;
  } else if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error(
      'No Google Sheets credentials found.\n' +
        'Set GOOGLE_SHEETS_CREDENTIALS (file path) or GOOGLE_SHEETS_CREDENTIALS_JSON (raw JSON).'
    );
  }

  const googleAuth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  return google.sheets({ version: 'v4', auth: googleAuth });
}

// ---------------------------------------------------------------------------
// Cell helpers
// ---------------------------------------------------------------------------

function pickCol(
  headerIndex: Map<string, number>,
  candidates: string[],
): number | undefined {
  for (const c of candidates) {
    const idx = headerIndex.get(c);
    if (idx !== undefined) return idx;
  }
  return undefined;
}

function readCell(row: string[], idx: number | undefined): string {
  if (idx === undefined) return '';
  const v = row[idx];
  return v === undefined || v === null ? '' : String(v).trim();
}

function normalizeDateStr(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const direct = /^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/.exec(trimmed);
  if (direct) {
    const y = direct[1];
    const m = direct[2].padStart(2, '0');
    const d = direct[3].padStart(2, '0');
    return `${y}/${m}/${d}`;
  }
  const serial = Number(trimmed);
  if (!Number.isNaN(serial) && serial > 1000 && serial < 100000) {
    const ms = (serial - 25569) * 86400 * 1000;
    const date = new Date(ms);
    const y = date.getUTCFullYear();
    const mo = String(date.getUTCMonth() + 1).padStart(2, '0');
    const d = String(date.getUTCDate()).padStart(2, '0');
    return `${y}/${mo}/${d}`;
  }
  const ms = new Date(trimmed).getTime();
  if (!Number.isNaN(ms)) {
    const date = new Date(ms);
    const y = date.getUTCFullYear();
    const mo = String(date.getUTCMonth() + 1).padStart(2, '0');
    const d = String(date.getUTCDate()).padStart(2, '0');
    return `${y}/${mo}/${d}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Sheet → records (full parse, but we'll only push finalResult fields)
// ---------------------------------------------------------------------------

interface ParsedRow {
  gameId: string;
  rowIndex: number;
  record: GameRecordV2;
}

async function loadGamesV2FromSheet(
  sheetName: string,
  limit: number,
  startRow: number,
): Promise<ParsedRow[]> {
  const sheets = await buildSheetsClient();
  const range = `${sheetName}!A1:BZ`;
  console.log(`[reimport] Fetching: spreadsheet=${SHEET_ID} range="${range}"`);

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range,
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'FORMATTED_STRING',
  });

  const rows = resp.data.values;
  if (!rows || rows.length < 2) {
    console.log('[reimport] Sheet is empty or has only a header row.');
    return [];
  }

  const headerRow = rows[0].map((v) => String(v).trim());
  const headerIndex = new Map<string, number>();
  headerRow.forEach((h, i) => {
    if (h) headerIndex.set(h, i);
  });

  const gameIdIdx = pickCol(headerIndex, GAME_ID_COL_CANDIDATES);
  const dateIdx = pickCol(headerIndex, DATE_COL_CANDIDATES);
  const textIdx = pickCol(headerIndex, TEXT_LOG_COL_CANDIDATES);
  const roleIdx = pickCol(headerIndex, ROLE_CODE_COL_CANDIDATES);
  const locationIdx = pickCol(headerIndex, LOCATION_COL_CANDIDATES);
  const sessionIdx = pickCol(headerIndex, SESSION_COL_CANDIDATES);
  const assassinIdx = pickCol(headerIndex, ASSASSIN_TARGET_COL_CANDIDATES);

  if (
    gameIdIdx === undefined ||
    dateIdx === undefined ||
    textIdx === undefined ||
    roleIdx === undefined
  ) {
    throw new Error(
      `[reimport] Missing required columns. found: ${[...headerIndex.keys()].join(', ')}`,
    );
  }

  const dataRows = rows.slice(Math.max(1, startRow - 1));
  const effectiveLimit = Number.isFinite(limit) ? limit : dataRows.length;
  const sliced = dataRows.slice(0, effectiveLimit);

  const out: ParsedRow[] = [];
  let parseErrors = 0;
  let skipped = 0;

  for (let i = 0; i < sliced.length; i += 1) {
    const strRow = sliced[i].map((v) => String(v ?? ''));
    const rowIndex = startRow + i;

    const gameIdRaw = readCell(strRow, gameIdIdx);
    const playedAtStr = readCell(strRow, dateIdx);
    const gameText = readCell(strRow, textIdx);
    const roleCode = readCell(strRow, roleIdx);
    const locationCode = readCell(strRow, locationIdx);
    const sessionRaw = readCell(strRow, sessionIdx);
    const assassinTargetRaw = readCell(strRow, assassinIdx);

    if (!gameIdRaw || !playedAtStr || !gameText || !roleCode) {
      skipped += 1;
      continue;
    }
    let gameNumInDay = Number.parseInt(sessionRaw, 10);
    if (!Number.isFinite(gameNumInDay) || gameNumInDay <= 0) {
      const tail = gameIdRaw.match(/(\d+)$/);
      gameNumInDay = tail ? Number.parseInt(tail[1], 10) : rowIndex;
    }
    const playerNames: string[] = [];
    for (const col of PLAYER_COLS) {
      const idx = headerIndex.get(col);
      playerNames.push(idx !== undefined ? readCell(strRow, idx) : '');
    }
    const normalizedDate = normalizeDateStr(playedAtStr);
    if (!normalizedDate) {
      skipped += 1;
      continue;
    }
    try {
      const record = parseSheetsGameCell({
        gameText,
        roleCode,
        locationCode,
        playedAtStr: normalizedDate,
        gameNumInDay,
        playerNames,
        gameId: `sheets-${gameIdRaw}`,
        assassinTargetRaw,
      });
      out.push({ gameId: record.gameId, rowIndex, record });
    } catch (err) {
      parseErrors += 1;
      console.warn(
        `  [parse-error] row=${rowIndex} gameId="${gameIdRaw}" ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  console.log(
    `[reimport] Parsed: ${out.length} valid, ${skipped} skipped, ${parseErrors} parse errors`,
  );
  return out;
}

// ---------------------------------------------------------------------------
// Firestore admin
// ---------------------------------------------------------------------------

function initAdmin(): void {
  if (admin.apps.length > 0) return;
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const credsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (serviceAccountJson) {
    const sa = JSON.parse(serviceAccountJson);
    admin.initializeApp({ credential: admin.credential.cert(sa) });
  } else if (credsPath) {
    const raw = fs.readFileSync(credsPath, 'utf-8');
    const sa = JSON.parse(raw);
    admin.initializeApp({
      credential: admin.credential.cert(sa),
      projectId: projectId || sa.project_id,
    });
  } else {
    throw new Error(
      'No Firebase credentials found.\n' +
        'Set FIREBASE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS.',
    );
  }
  admin.firestore().settings({ ignoreUndefinedProperties: true });
}

// ---------------------------------------------------------------------------
// Update logic — only `finalResult` fields
// ---------------------------------------------------------------------------

interface UpdateSummary {
  totalConsidered: number;
  notFound: number;
  unchanged: number;
  updated: number;
  errors: number;
  // Bucket diffs by old → new winReason
  transitions: Record<string, number>;
  // Final winReason distribution after update (computed on the parsed batch)
  finalDistribution: Record<string, number>;
}

async function applyUpdates(
  firestore: admin.firestore.Firestore,
  parsed: ParsedRow[],
  dryRun: boolean,
): Promise<UpdateSummary> {
  const summary: UpdateSummary = {
    totalConsidered: parsed.length,
    notFound: 0,
    unchanged: 0,
    updated: 0,
    errors: 0,
    transitions: {},
    finalDistribution: {},
  };

  // Tally final distribution from parsed records (what we'd write)
  for (const p of parsed) {
    const r = p.record.finalResult.winReason;
    summary.finalDistribution[r] = (summary.finalDistribution[r] ?? 0) + 1;
  }

  // Process in chunks for batch writes
  const CHUNK = 200;
  for (let i = 0; i < parsed.length; i += CHUNK) {
    const chunk = parsed.slice(i, i + CHUNK);

    // Read existing docs
    const refs = chunk.map((p) =>
      firestore.collection('games_v2').doc(p.gameId),
    );
    let snaps: admin.firestore.DocumentSnapshot[];
    try {
      snaps = await firestore.getAll(...refs);
    } catch (err) {
      summary.errors += chunk.length;
      console.error(
        `  [getAll-error] chunk @${i} ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    const batch = firestore.batch();
    let pendingWrites = 0;

    for (let j = 0; j < chunk.length; j += 1) {
      const p = chunk[j];
      const snap = snaps[j];
      if (!snap.exists) {
        summary.notFound += 1;
        continue;
      }
      const existing = snap.data() as GameRecordV2;
      const oldReason = existing.finalResult?.winReason ?? '<missing>';
      const newReason = p.record.finalResult.winReason;
      const newWinner = p.record.finalResult.winnerCamp;
      const newAssassinTarget = p.record.finalResult.assassinTargetSeat;
      const newAssassinCorrect = p.record.finalResult.assassinCorrect;

      const sameReason = oldReason === newReason;
      const sameWinner = existing.finalResult?.winnerCamp === newWinner;
      const sameTarget =
        existing.finalResult?.assassinTargetSeat === newAssassinTarget;
      const sameCorrect =
        existing.finalResult?.assassinCorrect === newAssassinCorrect;

      if (sameReason && sameWinner && sameTarget && sameCorrect) {
        summary.unchanged += 1;
        continue;
      }

      const transitionKey = `${oldReason} → ${newReason}`;
      summary.transitions[transitionKey] =
        (summary.transitions[transitionKey] ?? 0) + 1;

      if (dryRun) {
        summary.updated += 1;
        if (summary.updated <= 20) {
          console.log(
            `  [dry-run] ${p.gameId}: ${oldReason} → ${newReason}` +
              (newAssassinTarget !== undefined
                ? ` (target=${newAssassinTarget}, correct=${newAssassinCorrect})`
                : ''),
          );
        }
        continue;
      }

      // Build update payload — ONLY finalResult sub-fields.
      const update: Record<string, unknown> = {
        'finalResult.winReason': newReason,
        'finalResult.winnerCamp': newWinner,
      };
      if (newAssassinTarget !== undefined) {
        update['finalResult.assassinTargetSeat'] = newAssassinTarget;
      } else {
        update['finalResult.assassinTargetSeat'] =
          admin.firestore.FieldValue.delete();
      }
      if (newAssassinCorrect !== undefined) {
        update['finalResult.assassinCorrect'] = newAssassinCorrect;
      } else {
        update['finalResult.assassinCorrect'] =
          admin.firestore.FieldValue.delete();
      }

      const ref = firestore.collection('games_v2').doc(p.gameId);
      batch.update(ref, update);
      pendingWrites += 1;
      summary.updated += 1;
    }

    if (!dryRun && pendingWrites > 0) {
      try {
        await batch.commit();
        console.log(`  [batch] committed ${pendingWrites} updates @${i}`);
      } catch (err) {
        summary.errors += pendingWrites;
        summary.updated -= pendingWrites;
        console.error(
          `  [batch-error] @${i} ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  return summary;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function getArg(args: string[], flag: string): string | undefined {
  const entry = args.find((a) => a.startsWith(`${flag}=`));
  return entry?.slice(flag.length + 1);
}

function printUsage(): void {
  console.log(`
reimport-winreason-from-sheets.ts — 從 Sheets 「刺殺」欄重判 finalResult.winReason

Usage:
  pnpm tsx scripts/reimport-winreason-from-sheets.ts [options]

Options:
  --sheet-name=NAME  工作表 tab（預設 "牌譜"）
  --dry-run          只印不寫
  --limit=N          只處理前 N 列（data rows）
  --start-row=N      從第 N 列開始（1-indexed；預設 2）

Env:
  GOOGLE_SHEETS_CREDENTIALS       Sheets 服務帳號 JSON 路徑
  GOOGLE_SHEETS_CREDENTIALS_JSON  Sheets 服務帳號 JSON 字串
  GOOGLE_APPLICATION_CREDENTIALS  ADC（兩者都能用）
  FIREBASE_SERVICE_ACCOUNT_JSON   Firebase 服務帳號 JSON 字串
  FIREBASE_PROJECT_ID             Firebase 專案 ID (ADC 時用)

Sheet:
  https://docs.google.com/spreadsheets/d/${SHEET_ID}
  ${FIRESTORE_BATCH_LIMIT.toString()} max writes per batch (we use 200 chunks).
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  const sheetName = getArg(args, '--sheet-name') ?? DEFAULT_TAB;
  const dryRun = args.includes('--dry-run');
  const limitStr = getArg(args, '--limit');
  const limit = limitStr ? Number.parseInt(limitStr, 10) : Number.POSITIVE_INFINITY;
  const startRowStr = getArg(args, '--start-row');
  const startRow = startRowStr ? Math.max(2, Number.parseInt(startRowStr, 10)) : 2;

  console.log(
    `[reimport] Mode: ${dryRun ? 'DRY-RUN' : 'WRITE'}  sheet=${sheetName}  startRow=${startRow}  limit=${limit}`,
  );

  const parsed = await loadGamesV2FromSheet(sheetName, limit, startRow);
  if (parsed.length === 0) {
    console.log('[reimport] Nothing to update.');
    return;
  }

  initAdmin();
  const firestore = admin.firestore();
  const summary = await applyUpdates(firestore, parsed, dryRun);

  console.log('');
  console.log('============================================================');
  console.log(
    `[reimport] Done. mode=${dryRun ? 'DRY-RUN' : 'WRITE'} considered=${summary.totalConsidered} updated=${summary.updated} unchanged=${summary.unchanged} notFound=${summary.notFound} errors=${summary.errors}`,
  );
  console.log('');
  console.log('Final winReason distribution (in parsed batch):');
  for (const [k, v] of Object.entries(summary.finalDistribution).sort(
    (a, b) => b[1] - a[1],
  )) {
    console.log(`  ${k}: ${v}`);
  }
  console.log('');
  console.log('Transitions (old → new) [count]:');
  for (const [k, v] of Object.entries(summary.transitions).sort(
    (a, b) => b[1] - a[1],
  )) {
    console.log(`  ${k}: ${v}`);
  }
}

main().catch((err: unknown) => {
  console.error('[reimport] Fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
