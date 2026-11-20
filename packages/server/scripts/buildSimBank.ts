/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 模擬瓦題庫：牌譜總庫 → `packages/server/sim_bank.json`。
 *
 *   pnpm --filter @avalon/server exec tsx scripts/buildSimBank.ts [--db PATH] [--out PATH] [--previous PATH]
 *        [--picks PATH | --no-pin] [--pin-days N] [--today YYYY-MM-DD]
 *   舊的來源（只給比對用）：--snapshot sheets_cache.json
 *
 * Edward 2026-10-14：「Line bot/dc bot 有辦法支援模擬瓦嗎? 不是練習局
 * 模擬瓦比較像是練習邏輯思考跟派隊資訊的釋放與解讀」。
 * 站長 2026-11-20：「整個系統要完全同步同來源」——來源從凍結的牌譜快照 sheets_cache.json（2026-04）改成每晚
 * game_db.py 寫的牌譜總庫 game_db.json（同一份、套用站長更正、排除錯誤局、不含 ProAvalon、模擬、百科AI；
 * 條件見 src/bots/simulation/bankSource.ts），refresh-analysis-cache.yml 每晚在 game_db.py 之後跑這支。
 *
 * 題號穩定：讀上一版題庫（--previous，預設就是 --out 那個檔），同一局沿用題號（bankCodec.buildBankFile）。
 * Threads：舊題庫照計畫會出、新題庫算出來不一樣的接下來 N 天（--pin-days，預設 8），題號寫進 threads_picks.json
 * （src/bots/threads/planPins.ts），已經寫好的第一則留言還是對得上。
 * 離線、可重現；只印計數，不印任何一局的內容。
 */

import * as fs from 'fs';
import * as path from 'path';
import { rowsFromSheet } from '../src/ai/benchmark/sheetsReplay';
import { buildSimBank } from '../src/bots/simulation/bank';
import { buildBankFile, type SimBankFile } from '../src/bots/simulation/bankCodec';
import { rowsFromGameDb } from '../src/bots/simulation/bankSource';
import { readRecordPosts } from '../src/bots/simulation/recordsIndex';
import { addDays, taipeiToday } from '../src/bots/threads/plan';
import { parsePicks, picksFileBody } from '../src/bots/threads/picksFile';
import { planPins } from '../src/bots/threads/planPins';

const argv = process.argv.slice(2);
function arg(name: string, fallback: string): string {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}
const flag = (name: string): boolean => argv.includes(name);

const root = path.resolve(__dirname, '..');
const outPath = path.resolve(arg('--out', path.join(root, 'sim_bank.json')));
const previousPath = path.resolve(arg('--previous', outPath));
const snapshot = arg('--snapshot', '');
const dbPath = path.resolve(arg('--db', path.join(root, 'game_db.json')));
const picksPath = path.resolve(arg('--picks', path.join(root, 'threads_picks.json')));
const pinDays = Number(arg('--pin-days', '8'));
const today = arg('--today', taipeiToday());

const readJson = (p: string): unknown => JSON.parse(fs.readFileSync(p, 'utf8'));
const previous = fs.existsSync(previousPath) ? (readJson(previousPath) as SimBankFile) : null;

let built;
if (snapshot) {
  const data = readJson(path.resolve(snapshot)) as Record<string, string[][]>;
  built = buildBankFile(rowsFromSheet(data['牌譜'] ?? []), path.basename(snapshot), previous);
} else {
  const source = rowsFromGameDb(readJson(dbPath) as { games?: unknown });
  const c = source.counts;
  console.log(`game_db: ${c.rows} games; left out: 模擬/百科AI ${c.notReal}, ProAvalon ${c.external}, unreadable ${c.unreadable}, rule errors ${c.ruleErrors}, completed ${c.completed}; passed ${c.passed}`);
  built = buildBankFile(source.rows, path.basename(dbPath), previous);
}
const { file, counts } = built;

// 一行一局：diff 好讀，檔案也小。
const body = file.games.map((g) => `    ${JSON.stringify(g)}`).join(',\n');
const text = `{\n  "version": ${file.version},\n  "builtFrom": ${JSON.stringify(file.builtFrom)},\n  "games": [\n${body}\n  ]\n}\n`;
const changed = !fs.existsSync(outPath) || fs.readFileSync(outPath, 'utf8') !== text;

console.log(`rows ${counts.rows}, with a record ${counts.recorded}, strict replay ok ${counts.replayable}`);
console.log(`dropped: lake chain ${counts.lakeChainInvalid}, 娛樂 ${counts.entertainment}, 模擬 ${counts.simulated}, duplicate records ${counts.duplicates}`);
console.log(`bank games ${counts.games} (ids longer than 5: ${counts.idCollisions})`);
console.log(`ids vs previous bank: kept ${counts.keptIds}, new ${counts.newIds}, gone ${counts.droppedIds}`);

// Threads：題庫變了，接下來幾天照舊題庫的計畫釘住（寫題庫之前算，舊題庫還在）。
if (changed && previous && !flag('--no-pin') && pinDays > 0 && fs.existsSync(picksPath)) {
  const posts = readRecordPosts([path.join(root, 'records_cache.json')]);
  const rawPicks = readJson(picksPath) as { _comment?: string };
  const picks = parsePicks(rawPicks);
  const dates = Array.from({ length: pinDays }, (_, i) => addDays(today, i));
  const res = planPins(buildSimBank(previous, posts), buildSimBank(file, posts), picks, dates, process.env.THREADS_LIVE_FROM || undefined);
  console.log(`threads plan ${dates[0]}..${dates[dates.length - 1]}: unchanged ${res.same}, pinned ${res.pins.size}, could not keep ${res.lost.size}`);
  for (const [d, id] of res.lost) console.log(`  could not keep ${d} (${id})`);
  if (res.pins.size > 0) {
    const merged = new Map([...picks, ...res.pins]);
    fs.writeFileSync(picksPath, picksFileBody(merged, typeof rawPicks._comment === 'string' ? rawPicks._comment : undefined), 'utf8');
    for (const [d, id] of res.pins) console.log(`  pinned ${d} → ${id}`);
  }
}

if (changed) fs.writeFileSync(outPath, text, 'utf8');
console.log(`${changed ? 'wrote' : 'unchanged'} ${path.relative(process.cwd(), outPath)} (${Buffer.byteLength(text)} bytes)`);
