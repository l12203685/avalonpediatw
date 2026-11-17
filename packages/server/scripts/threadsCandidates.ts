/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * Threads 選局候選（2026-11-17）：未來幾週每天的題目＋照陣容強度 S 排的候選，給站長的選局頁。
 *
 *   pnpm --filter @avalon/server threads:candidates                          # 從系列起點（THREADS_LIVE_FROM，預設 11/18）起 28 天
 *   選項：--start YYYY-MM-DD（預設 THREADS_START_DATE）、--days N（預設 28）、--top N（預設 15）、
 *         --linked N（另外補 N 個有網站牌譜頁、S 最高的，預設 5）、
 *         --picks <檔>（站長選的題目，預設 packages/server/threads_picks.json；也接受選局頁資料庫匯出）、--today YYYY-MM-DD（預設台北今天）、
 *         --drafts <資料夾>（存下來的草稿，跟 threads:draft 的 --out 同一個，預設 packages/server/threads_drafts/）、
 *         --out <檔>（預設 packages/server/threads_drafts/candidates.json，不進 git）、
 *         --games-out <檔>（一局一列的牌譜表，預設跟 --out 同一個資料夾的 games.json）
 *
 * S 來自 games_cache.json 每局的 lineup（網站「陣容強度」），用指紋對上題庫那一局；對不上的局 S 是 null。
 */

import fs from 'fs';
import path from 'path';
import { buildSimBank, readSimBankFile } from '../src/bots/simulation/bank';
import { readRecordPosts } from '../src/bots/simulation/recordsIndex';
import { planDays } from '../src/bots/threads/candidates';
import { gamesTable } from '../src/bots/threads/gamesTable';
import { ThreadsGenerator } from '../src/bots/threads/generate';
import { readPicksFile, savedDraftReader } from '../src/bots/threads/inputs';
import { pickOverrideOf } from '../src/bots/threads/picksFile';
import { THREADS_START_DATE, taipeiToday } from '../src/bots/threads/plan';
import { HIGH_LINEUP_S, lineupIndex } from '../src/bots/threads/strength';

const root = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const arg = (name: string, fallback: string): string => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const start = arg('--start', process.env.THREADS_LIVE_FROM || THREADS_START_DATE);
const days = Number(arg('--days', '28'));
const top = Number(arg('--top', '15'));
const extraLinked = Number(arg('--linked', '5'));
const today = arg('--today', taipeiToday());
const out = path.resolve(arg('--out', path.join(root, 'threads_drafts', 'candidates.json')));
const defaultPicks = path.join(root, 'threads_picks.json');
const picksPath = arg('--picks', fs.existsSync(defaultPicks) ? defaultPicks : '');
const gamesOut = path.resolve(arg('--games-out', path.join(path.dirname(out), 'games.json')));
const draftsDir = path.resolve(arg('--drafts', path.join(root, 'threads_drafts')));

const bankFile = readSimBankFile([path.join(root, 'sim_bank.json')]);
if (!bankFile) {
  console.error('sim_bank.json not found or unreadable');
  process.exit(1);
}
const bank = buildSimBank(bankFile, readRecordPosts([path.join(root, 'records_cache.json')]));
const lineup = lineupIndex(JSON.parse(fs.readFileSync(path.join(root, 'games_cache.json'), 'utf8')));
// 跟 threads:draft 同一份輸入：選的每一天都用、存下來（已經發出去）的草稿優先，
// 所以今天和過去的日子顯示實際的題目，週四／週六接的也是實際貼出去的那一局。
const picked = readPicksFile(picksPath);

const gen = new ThreadsGenerator({ bank, titles: new Map(), readSaved: savedDraftReader(draftsDir), startDate: start, pickOverride: pickOverrideOf(picked) });
const plan = planDays({ gen, lineup, today, picked }, start, days, top, extraLinked);
for (const w of gen.warnings) console.warn(w);

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(
  out,
  `${JSON.stringify({ version: 1, generatedFor: today, start, days, highS: HIGH_LINEUP_S, plan }, null, 1)}\n`,
);
const withS = plan.flatMap((d) => d.candidates).filter((c) => c.s !== null).length;
console.log(`${plan.length} days, ${plan.reduce((n, d) => n + d.candidates.length, 0)} candidates (${withS} with S) → ${out}`);

const games = gamesTable(gen, lineup, start);
fs.writeFileSync(gamesOut, `${JSON.stringify({ version: 1, generatedFor: today, highS: HIGH_LINEUP_S, games })}\n`);
console.log(`${games.length} games (${games.filter((g) => g.url).length} with a records page, ${games.filter((g) => g.types.length).length} usable) → ${gamesOut}`);
