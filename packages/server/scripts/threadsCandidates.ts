/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * Threads 選局候選（2026-11-17）：未來幾週每天的題目＋照陣容強度 S 排的候選，給站長的選局頁。
 *
 *   pnpm --filter @avalon/server threads:candidates                          # 從第一篇（11/17）起 28 天
 *   選項：--start YYYY-MM-DD（預設 THREADS_START_DATE）、--days N（預設 28）、--top N（預設 15）、
 *         --linked N（另外補 N 個有網站牌譜頁、S 最高的，預設 5）、
 *         --picks <檔>（選局頁匯出的選擇，日期 → 題號）、--today YYYY-MM-DD（預設台北今天）、
 *         --out <檔>（預設 packages/server/threads_drafts/candidates.json，不進 git）
 *
 * S 來自 games_cache.json 每局的 lineup（網站「陣容強度」），用指紋對上題庫那一局；對不上的局 S 是 null。
 */

import fs from 'fs';
import path from 'path';
import { buildSimBank, readSimBankFile } from '../src/bots/simulation/bank';
import { readRecordPosts } from '../src/bots/simulation/recordsIndex';
import { planDays } from '../src/bots/threads/candidates';
import { ThreadsGenerator } from '../src/bots/threads/generate';
import { futurePicks, parsePicks } from '../src/bots/threads/picksFile';
import { THREADS_START_DATE, taipeiToday } from '../src/bots/threads/plan';
import { HIGH_LINEUP_S, lineupIndex } from '../src/bots/threads/strength';

const root = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const arg = (name: string, fallback: string): string => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const start = arg('--start', THREADS_START_DATE);
const days = Number(arg('--days', '28'));
const top = Number(arg('--top', '15'));
const extraLinked = Number(arg('--linked', '5'));
const today = arg('--today', taipeiToday());
const out = path.resolve(arg('--out', path.join(root, 'threads_drafts', 'candidates.json')));
const picksPath = arg('--picks', '');

const bankFile = readSimBankFile([path.join(root, 'sim_bank.json')]);
if (!bankFile) {
  console.error('sim_bank.json not found or unreadable');
  process.exit(1);
}
const bank = buildSimBank(bankFile, readRecordPosts([path.join(root, 'records_cache.json')]));
const lineup = lineupIndex(JSON.parse(fs.readFileSync(path.join(root, 'games_cache.json'), 'utf8')));
const picked = picksPath ? futurePicks(parsePicks(JSON.parse(fs.readFileSync(picksPath, 'utf8'))), today) : new Map<string, string>();

const gen = new ThreadsGenerator({ bank, titles: new Map(), readSaved: (): null => null, startDate: start, overrides: picked });
const plan = planDays({ gen, lineup, today, picked }, start, days, top, extraLinked);
for (const [date, id] of gen.rejectedOverrides) console.warn(`${date}: ${id} 不符合這一天的主題，照計畫`);

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(
  out,
  `${JSON.stringify({ version: 1, generatedFor: today, start, days, highS: HIGH_LINEUP_S, plan }, null, 1)}\n`,
);
const withS = plan.flatMap((d) => d.candidates).filter((c) => c.s !== null).length;
console.log(`${plan.length} days, ${plan.reduce((n, d) => n + d.candidates.length, 0)} candidates (${withS} with S) → ${out}`);
