/**
 * import-games-v2.ts
 *
 * 讀 Google Sheets 牌譜欄（文字記錄）→ `parseSheetsGameCell` → 寫 `games_v2/{gameId}`.
 *
 * Edward 2026-04-24 Phase 2b：
 *   - Sheet ID: 174L-by-dtP6IY1pRy8nMpG6_3RMBQXmAV4kTfIgmyIU
 *   - 預設 tab: `牌譜`
 *   - 每一列 = 一局；需要 5 個欄位：
 *       * 流水號（gameId fallback）
 *       * 日期時間 (YYYY/MM/DD)
 *       * 文字記錄（`gameText`：多行提議/任務結果/湖行）
 *       * 當天第幾場（`gameNumInDay`）— 從 session / 流水號推
 *       * 玩1..玩0 + 角色碼（`roleCode`：6 碼刺娜德奧派梅座號）
 *   - 用 `sheetsGameRecordParser.parseSheetsGameCell` 解析 → `GameRecordV2`
 *   - 寫進 Firestore `games_v2/{gameId}`
 *
 * 模式：
 *   --dry-run   只印不寫
 *   --limit N   只處理前 N 列（含 header 後）
 *   --page-size N   分頁 batch 寫入（預設 100）
 *   --start-row N  從第 N 列開始（1-indexed）
 *
 * Firebase auth：
 *   FIREBASE_SERVICE_ACCOUNT_JSON 或 GOOGLE_APPLICATION_CREDENTIALS
 *
 * Google Sheets auth：
 *   GOOGLE_SHEETS_CREDENTIALS (file path) 或
 *   GOOGLE_SHEETS_CREDENTIALS_JSON (raw JSON) 或
 *   GOOGLE_APPLICATION_CREDENTIALS (ADC)
 *
 * 用法：
 *   # dry-run
 *   GOOGLE_SHEETS_CREDENTIALS=/path/to/creds.json \
 *   FIREBASE_SERVICE_ACCOUNT_JSON='...' \
 *   pnpm tsx scripts/import-games-v2.ts --dry-run --limit 5
 *
 *   # 正式匯入
 *   pnpm tsx scripts/import-games-v2.ts
 */

import * as admin from 'firebase-admin';
import * as fs from 'fs';
import * as path from 'path';
import { google } from 'googleapis';
import type { GameRecordV2 } from '../packages/shared/src/types/game_v2';
import { parseSheetsGameCell } from '../packages/server/src/services/sheetsGameRecordParser';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SHEET_ID = '174L-by-dtP6IY1pRy8nMpG6_3RMBQXmAV4kTfIgmyIU';
const DEFAULT_TAB = '牌譜';
const PLAYER_COLS = ['玩1', '玩2', '玩3', '玩4', '玩5', '玩6', '玩7', '玩8', '玩9', '玩0'];
const TEXT_LOG_COL_CANDIDATES = ['文字記錄', '文字紀錄', '牌譜', '記錄'];
const ROLE_CODE_COL_CANDIDATES = ['角色', '角色碼', '角色位', '角'];
const DATE_COL_CANDIDATES = ['日期時間', '日期'];
const GAME_ID_COL_CANDIDATES = ['流水號', 'gameId', 'id'];
const SESSION_COL_CANDIDATES = ['場次', 'session'];
const LOCATION_COL_CANDIDATES = ['分類', 'location', '地點'];

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
// Sheet row → parseSheetsGameCell input
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

interface RowBundle {
  rowIndex: number;       // 1-indexed (row 1 = header → data rows start at 2)
  gameIdRaw: string;
  playedAtStr: string;
  gameText: string;
  roleCode: string;
  locationCode: string;
  gameNumInDay: number;
  playerNames: string[];
}

function extractRowBundle(
  rowIndex: number,
  row: string[],
  headerIndex: Map<string, number>,
): RowBundle | null {
  const gameIdIdx = pickCol(headerIndex, GAME_ID_COL_CANDIDATES);
  const dateIdx = pickCol(headerIndex, DATE_COL_CANDIDATES);
  const textIdx = pickCol(headerIndex, TEXT_LOG_COL_CANDIDATES);
  const roleIdx = pickCol(headerIndex, ROLE_CODE_COL_CANDIDATES);
  const locationIdx = pickCol(headerIndex, LOCATION_COL_CANDIDATES);
  const sessionIdx = pickCol(headerIndex, SESSION_COL_CANDIDATES);

  const gameIdRaw = readCell(row, gameIdIdx);
  const playedAtStr = readCell(row, dateIdx);
  const gameText = readCell(row, textIdx);
  const roleCode = readCell(row, roleIdx);
  const locationCode = readCell(row, locationIdx);
  const sessionRaw = readCell(row, sessionIdx);

  if (!gameIdRaw || !playedAtStr || !gameText || !roleCode) {
    return null;
  }

  // gameNumInDay：優先從場次欄取整數；否則用 gameId 尾巴（流水號）當 fallback
  let gameNumInDay = Number.parseInt(sessionRaw, 10);
  if (!Number.isFinite(gameNumInDay) || gameNumInDay <= 0) {
    const tail = gameIdRaw.match(/(\d+)$/);
    gameNumInDay = tail ? Number.parseInt(tail[1], 10) : rowIndex;
  }

  // 10 個玩家名字
  const playerNames: string[] = [];
  for (const col of PLAYER_COLS) {
    const idx = headerIndex.get(col);
    playerNames.push(idx !== undefined ? readCell(row, idx) : '');
  }

  return {
    rowIndex,
    gameIdRaw,
    playedAtStr,
    gameText,
    roleCode,
    locationCode,
    gameNumInDay,
    playerNames,
  };
}

/**
 * 將標準化日期：Excel serial 或 ISO 都轉成 `YYYY/MM/DD`（parser 吃這格式）。
 */
function normalizeDateStr(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // 已經是 YYYY/MM/DD / YYYY-MM-DD → 正規化成 `YYYY/MM/DD`
  const direct = /^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/.exec(trimmed);
  if (direct) {
    const y = direct[1];
    const m = direct[2].padStart(2, '0');
    const d = direct[3].padStart(2, '0');
    return `${y}/${m}/${d}`;
  }

  // Excel serial
  const serial = Number(trimmed);
  if (!Number.isNaN(serial) && serial > 1000 && serial < 100000) {
    const ms = (serial - 25569) * 86400 * 1000;
    const date = new Date(ms);
    const y = date.getUTCFullYear();
    const mo = String(date.getUTCMonth() + 1).padStart(2, '0');
    const d = String(date.getUTCDate()).padStart(2, '0');
    return `${y}/${mo}/${d}`;
  }

  // ISO
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
// Sheets → GameRecordV2[]
// ---------------------------------------------------------------------------

async function loadGamesV2FromSheet(
  sheetName: string,
  limit: number,
  startRow: number,
): Promise<GameRecordV2[]> {
  const sheets = await buildSheetsClient();
  const range = `${sheetName}!A1:BZ`;
  console.log(`[v2] Fetching: spreadsheet=${SHEET_ID} range="${range}"`);

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range,
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'FORMATTED_STRING',
  });

  const rows = resp.data.values;
  if (!rows || rows.length < 2) {
    console.log('[v2] Sheet is empty or has only a header row.');
    return [];
  }

  const headerRow = rows[0].map((v) => String(v).trim());
  const headerIndex = new Map<string, number>();
  headerRow.forEach((h, i) => {
    if (h) headerIndex.set(h, i);
  });

  // 必要欄位存在性檢查（但 candidate list 允許多種寫法）
  const needCandidates = {
    gameId: GAME_ID_COL_CANDIDATES,
    date: DATE_COL_CANDIDATES,
    text: TEXT_LOG_COL_CANDIDATES,
    role: ROLE_CODE_COL_CANDIDATES,
  };
  for (const [k, cands] of Object.entries(needCandidates)) {
    const has = cands.some((c) => headerIndex.has(c));
    if (!has) {
      throw new Error(
        `[v2] Sheet "${sheetName}" missing required column (${k}). Candidates: ${cands.join(', ')}\n` +
          `Found columns: ${[...headerIndex.keys()].join(', ')}`
      );
    }
  }

  const dataRows = rows.slice(Math.max(1, startRow - 1));
  const effectiveLimit = Number.isFinite(limit) ? limit : dataRows.length;
  const sliced = dataRows.slice(0, effectiveLimit);

  const records: GameRecordV2[] = [];
  let parseErrors = 0;
  let skippedRows = 0;

  for (let i = 0; i < sliced.length; i += 1) {
    const strRow = sliced[i].map((v) => String(v ?? ''));
    const rowIndex = startRow + i;  // 1-indexed
    const bundle = extractRowBundle(rowIndex, strRow, headerIndex);
    if (!bundle) {
      skippedRows += 1;
      continue;
    }

    const normalizedDate = normalizeDateStr(bundle.playedAtStr);
    if (!normalizedDate) {
      console.warn(`  [skip] row=${rowIndex} gameId="${bundle.gameIdRaw}" invalid date="${bundle.playedAtStr}"`);
      skippedRows += 1;
      continue;
    }

    try {
      const record = parseSheetsGameCell({
        gameText: bundle.gameText,
        roleCode: bundle.roleCode,
        locationCode: bundle.locationCode,
        playedAtStr: normalizedDate,
        gameNumInDay: bundle.gameNumInDay,
        playerNames: bundle.playerNames,
        gameId: `sheets-${bundle.gameIdRaw}`,
        // Phase 2b 無 UUID 查表：全部走 sheets:<名字> fallback
        // 未來可接 AccountService 查表
      });
      records.push(record);
    } catch (err) {
      parseErrors += 1;
      console.warn(
        `  [parse-error] row=${rowIndex} gameId="${bundle.gameIdRaw}" ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  console.log(
    `[v2] Parsed: ${records.length} valid, ${skippedRows} skipped (missing fields), ${parseErrors} parse errors`
  );
  return records;
}

// ---------------------------------------------------------------------------
// Firestore write
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
        'Set FIREBASE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS.'
    );
  }
}

async function writeBatch(
  firestore: admin.firestore.Firestore,
  records: GameRecordV2[],
  dryRun: boolean,
  pageSize: number,
): Promise<{ imported: number; skipped: number; errors: number }> {
  let imported = 0;
  let skipped = 0;
  let errors = 0;

  // 先掃 existing ids（讓腳本冪等）
  const existing = new Set<string>();
  for (const rec of records) {
    try {
      const snap = await firestore.collection('games_v2').doc(rec.gameId).get();
      if (snap.exists) existing.add(rec.gameId);
    } catch (err) {
      errors += 1;
      console.error(
        `  [check-error] gameId=${rec.gameId} ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // 分頁寫
  const pages: GameRecordV2[][] = [];
  const batchCap = Math.min(pageSize, FIRESTORE_BATCH_LIMIT);
  for (let i = 0; i < records.length; i += batchCap) {
    pages.push(records.slice(i, i + batchCap));
  }

  for (const page of pages) {
    const batch = firestore.batch();
    let inBatch = 0;
    for (const rec of page) {
      if (existing.has(rec.gameId)) {
        skipped += 1;
        continue;
      }
      if (dryRun) {
        console.log(
          `  [dry-run] would write games_v2/${rec.gameId} (${
            rec.playerSeats.filter((s) => s).length
          }p, winner=${rec.finalResult.winnerCamp}, reason=${rec.finalResult.winReason})`
        );
        imported += 1;
        continue;
      }
      const ref = firestore.collection('games_v2').doc(rec.gameId);
      batch.set(ref, rec);
      inBatch += 1;
      imported += 1;
    }
    if (!dryRun && inBatch > 0) {
      try {
        await batch.commit();
        console.log(`  [batch] committed ${inBatch} records.`);
      } catch (err) {
        errors += inBatch;
        imported -= inBatch;
        console.error(
          `  [batch-error] ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  return { imported, skipped, errors };
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
import-games-v2.ts — 匯入瓦站 V2 戰績（games_v2/）

Usage:
  pnpm tsx scripts/import-games-v2.ts [options]

Options:
  --sheet-name=NAME  工作表 tab（預設 "牌譜"）
  --dry-run          只印不寫
  --limit=N          只處理前 N 列（data rows，不含 header）
  --page-size=N      批次寫入分頁大小（預設 100，上限 500）
  --start-row=N      從第 N 列開始（1-indexed；預設 2）

Env:
  GOOGLE_SHEETS_CREDENTIALS       Sheets 服務帳號 JSON 路徑
  GOOGLE_SHEETS_CREDENTIALS_JSON  Sheets 服務帳號 JSON 字串
  GOOGLE_APPLICATION_CREDENTIALS  ADC（兩者都能用）
  FIREBASE_SERVICE_ACCOUNT_JSON   Firebase 服務帳號 JSON 字串
  FIREBASE_PROJECT_ID             Firebase 專案 ID (ADC 時用)

Sheet:
  https://docs.google.com/spreadsheets/d/${SHEET_ID}
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
  const pageSizeStr = getArg(args, '--page-size');
  const pageSize = pageSizeStr ? Number.parseInt(pageSizeStr, 10) : 100;
  const startRowStr = getArg(args, '--start-row');
  const startRow = startRowStr ? Math.max(2, Number.parseInt(startRowStr, 10)) : 2;

  console.log(`[v2] Mode: ${dryRun ? 'DRY-RUN' : 'WRITE'}  sheet=${sheetName}  startRow=${startRow}  limit=${limit}  pageSize=${pageSize}`);

  const records = await loadGamesV2FromSheet(sheetName, limit, startRow);
  if (records.length === 0) {
    console.log('[v2] Nothing to import.');
    return;
  }

  if (!dryRun) initAdmin();
  const firestore = dryRun
    ? (null as unknown as admin.firestore.Firestore)
    : admin.firestore();

  if (dryRun) {
    // Dry-run 只印（不用初始化 firebase）
    const summary = await writeBatch(
      { collection: () => ({ doc: () => ({ get: async () => ({ exists: false }) }) }) } as unknown as admin.firestore.Firestore,
      records,
      true,
      pageSize,
    );
    console.log(
      `[v2] DRY-RUN summary: ${summary.imported} would write, ${summary.skipped} skip, ${summary.errors} errors`
    );
    return;
  }

  const summary = await writeBatch(firestore, records, dryRun, pageSize);
  console.log(
    `[v2] Done. imported=${summary.imported}, skipped=${summary.skipped}, errors=${summary.errors}`
  );
}

main().catch((err: unknown) => {
  console.error('[v2] Fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
