/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 模擬瓦題庫（2026-10-14）：牌譜快照 → `packages/server/sim_bank.json`。
 *
 *   pnpm --filter @avalon/server exec tsx scripts/buildSimBank.ts [--cache PATH] [--out PATH]
 *
 * Edward 2026-10-14：「Line bot/dc bot 有辦法支援模擬瓦嗎? 不是練習局
 * 模擬瓦比較像是練習邏輯思考跟派隊資訊的釋放與解讀」。
 *
 * 離線、可重現：讀 `sheets_cache.json` → `牌譜`，用基準測試同一個嚴格解析器
 * （`rowsFromSheet` + `parseReplayGame`，只有一套解析），留下解析成功、湖順序合理、
 * 分類不是「娛樂」的局，寫成沒有名字、沒有日期的題庫（格式見 src/bots/simulation/bankCodec.ts）。
 * 牌譜快照更新後重跑一次。只印計數，不印任何一局的內容。
 */

import * as fs from 'fs';
import * as path from 'path';
import { rowsFromSheet } from '../src/ai/benchmark/sheetsReplay';
import { buildBankFile } from '../src/bots/simulation/bankCodec';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const root = path.resolve(__dirname, '..');
const cachePath = path.resolve(arg('--cache', path.join(root, 'sheets_cache.json')));
const outPath = path.resolve(arg('--out', path.join(root, 'sim_bank.json')));

const data = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as Record<string, string[][]>;
const rows = rowsFromSheet(data['牌譜'] ?? []);
const { file, counts } = buildBankFile(rows, path.basename(cachePath));

// 一行一局：diff 好讀，檔案也小。
const body = file.games.map((g) => `    ${JSON.stringify(g)}`).join(',\n');
fs.writeFileSync(
  outPath,
  `{\n  "version": ${file.version},\n  "builtFrom": ${JSON.stringify(file.builtFrom)},\n  "games": [\n${body}\n  ]\n}\n`,
  'utf8',
);

console.log(`rows ${counts.rows}, with a record ${counts.recorded}, strict replay ok ${counts.replayable}`);
console.log(`dropped: lake chain ${counts.lakeChainInvalid}, 娛樂 ${counts.entertainment}, duplicate records ${counts.duplicates}`);
console.log(`bank games ${counts.games} (ids longer than 5: ${counts.idCollisions}), ${fs.statSync(outPath).size} bytes`);
