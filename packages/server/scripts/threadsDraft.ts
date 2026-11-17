/**
 * Threads 每日出題草稿（2026-11-17）。Edward 自己發文；ChatGPT 寫第一則留言（Issue #37）。
 *
 *   pnpm --filter @avalon/server threads:draft                       # 今天（台北日期）
 *   pnpm --filter @avalon/server threads:draft -- --date 2026-11-18
 *   pnpm --filter @avalon/server threads:draft -- --week             # 從 --date（預設今天）起連續 7 天
 *   選項：--out <資料夾>（預設 packages/server/threads_drafts/，不進 git）、--no-image、--days N、
 *         --start YYYY-MM-DD（第一篇貼文的日期，預設 2026-11-17：那一天的 A 沒有昨天的答案）、
 *         --picks <檔>（站長選的題目，預設 packages/server/threads_picks.json；每一天都用，存下來的草稿優先）
 *
 * 每天寫三個檔：<日期>.md（複製貼上用）、<日期>.json（題號、ChatGPT 的留言欄位）、<日期>.png（題目圖）。
 * 已經有 <日期>.json 的日子沿用裡面的題目和第一則留言（重跑不會換題）。
 * 題目只從實戰出（題庫 sim_bank.json 不含模擬的局）；草稿只有座位和牌譜記號，沒有玩家名字。
 */

import fs from 'fs';
import path from 'path';
import { buildSimBank, readSimBankFile } from '../src/bots/simulation/bank';
import { readRecordPosts } from '../src/bots/simulation/recordsIndex';
import { draftMarkdown } from '../src/bots/threads/draft';
import { ThreadsGenerator } from '../src/bots/threads/generate';
import { readPicksFile, savedDraftReader } from '../src/bots/threads/inputs';
import { pickOverrideOf } from '../src/bots/threads/picksFile';
import { renderAnswerPng, renderGridPng, renderPuzzlePng } from '../src/bots/threads/image';
import { THREADS_START_DATE, addDays, taipeiToday, weekdayOf } from '../src/bots/threads/plan';

const root = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const arg = (name: string, fallback: string): string => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const flag = (name: string): boolean => argv.includes(name);

const start = arg('--date', taipeiToday());
const days = flag('--week') ? 7 : Number(arg('--days', '1'));
const outDir = path.resolve(arg('--out', path.join(root, 'threads_drafts')));
const withImage = !flag('--no-image');
const startDate = arg('--start', THREADS_START_DATE);
const defaultPicks = path.join(root, 'threads_picks.json');
const picksPath = arg('--picks', fs.existsSync(defaultPicks) ? defaultPicks : '');
// 站長選的每一天都用（前一天選的今天的題目、昨天的答案都要對上）；已經貼出去的以存下來的草稿為準
// （pickFor 存下來的優先：今天的要換，先刪掉今天的草稿檔）。
const overrides = readPicksFile(picksPath);

const bankFile = readSimBankFile([path.join(root, 'sim_bank.json')]);
if (!bankFile) {
  console.error('sim_bank.json not found or unreadable');
  process.exit(1);
}
const bank = buildSimBank(bankFile, readRecordPosts([path.join(root, 'records_cache.json')]));

const wiki = JSON.parse(fs.readFileSync(path.join(root, 'wiki_data.json'), 'utf8')) as { id: string; title: string }[];
const titles = new Map(wiki.map((a) => [a.id, a.title] as [string, string]));

fs.mkdirSync(outDir, { recursive: true });
const readSaved = savedDraftReader(outDir);

const gen = new ThreadsGenerator({ bank, titles, readSaved, startDate, pickOverride: pickOverrideOf(overrides) });
console.log(`bank: ${bank.games.length} games (${bank.records.size} with a records page); out: ${outDir}`);

for (let i = 0; i < days; i++) {
  const date = addDays(start, i);
  const pick = gen.pickFor(date);
  const pv = pick ? gen.viewOf(pick) : null;
  let image: string | undefined;
  if (pv && withImage) {
    try {
      fs.writeFileSync(path.join(outDir, `${date}.png`), renderPuzzlePng(pv, weekdayOf(date)));
      image = `${date}.png`;
    } catch (err) {
      console.warn(`${date}: image skipped (${(err as Error).message})`);
    }
  }
  const draft = gen.draftFor(date, image ? { image } : {});
  if (!draft) {
    console.warn(`${date}: no puzzle for this theme`);
    continue;
  }
  // 輪播第二張：牌譜放不進題目卡時才有的牌譜續圖（後面的列）。
  if (pv && image) {
    try {
      const grid = renderGridPng(pv, weekdayOf(date));
      if (grid) {
        fs.writeFileSync(path.join(outDir, `${date}-grid.png`), grid);
        draft.post.gridImage = `${date}-grid.png`;
      }
    } catch (err) {
      console.warn(`${date}: grid image skipped (${(err as Error).message})`);
    }
  }
  // 公布完整答案的日子（昨天不是同一局接著打）另附答案圖：昨天那一局的角色。
  if (withImage && draft.answerToYesterday && !draft.continuesYesterday) {
    const yPick = gen.pickFor(addDays(date, -1));
    const yPv = yPick ? gen.viewOf(yPick) : null;
    if (yPv) {
      const before = yPick?.continues ? gen.pickFor(addDays(date, -2)) : null;
      const ids = before && before.gameId === yPv.pick.gameId ? [gen.viewOf(before)?.exerciseId, yPv.exerciseId].filter((x): x is string => !!x) : [yPv.exerciseId];
      try {
        fs.writeFileSync(path.join(outDir, `${date}-answer.png`), renderAnswerPng(yPv, ids));
        draft.post.answerImage = `${date}-answer.png`;
      } catch (err) {
        console.warn(`${date}: answer image skipped (${(err as Error).message})`);
      }
    }
  }
  fs.writeFileSync(path.join(outDir, `${date}.json`), `${JSON.stringify(draft, null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, `${date}.md`), draftMarkdown(draft));
  console.log(`${date} ${draft.theme} ${draft.exerciseId} post ${draft.post.chars} chars${draft.answerToYesterday ? `, with ${draft.answerToYesterday.exerciseId} answer` : ''}${draft.recordId ? '' : ' (no records page)'}`);
}
for (const w of gen.warnings) console.warn(w);
