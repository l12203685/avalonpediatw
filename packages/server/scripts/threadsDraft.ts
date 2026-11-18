/**
 * Threads 每日出題草稿（2026-11-17）。站長設好權杖與 THREADS_PUBLISH 後由 threads-publish 工作流程自動發（也可以照草稿手動發）；
 * ChatGPT 寫第一則留言（Issue #37）。
 *
 *   pnpm --filter @avalon/server threads:draft                       # 今天（台北日期）
 *   pnpm --filter @avalon/server threads:draft -- --date 2026-11-18
 *   pnpm --filter @avalon/server threads:draft -- --week             # 從 --date（預設今天）起連續 7 天
 *   選項：--out <資料夾>（預設 packages/server/threads_drafts/，不進 git）、--no-image、--days N、
 *         --start YYYY-MM-DD（第一篇貼文的日期：那一天的 A 沒有昨天的答案；預設 THREADS_LIVE_FROM，再沒有就 2026-11-18）、
 *         --picks <檔>（站長選的題目，預設 packages/server/threads_picks.json；每一天都用，存下來的草稿優先）、
 *         --template <檔>（貼文格式，預設 packages/server/threads_template.json；沒有就用內建格式）、
 *         --no-ai（不跑百科AI 的答案）
 *
 * 每天寫三個檔：<日期>.md（複製貼上用）、<日期>.json（題號、ChatGPT 的留言欄位、parts＝貼文每個佔位符這天的內容）、<日期>.png（題目圖）。
 * <日期>.json 另有 aiAnswer：百科AI 在同一個決定點的答案（站長 11/18：先讓百科AI 跑答案給他看、修正它的思考和盲點；
 * src/bots/threads/aiAnswer.ts）。只給站長看：不進貼文、不進 .md，自動發佈（threadsPublish.ts）也不產生它。
 * 已經有 <日期>.json 的日子沿用裡面的題目和第一則留言（重跑不會換題）。
 * 題目只從實戰出（題庫 sim_bank.json 不含模擬的局）；草稿只有座位和牌譜記號，沒有玩家名字。
 */

import fs from 'fs';
import path from 'path';
import { buildSimBank, readSimBankFile } from '../src/bots/simulation/bank';
import { readRecordPosts } from '../src/bots/simulation/recordsIndex';
import { draftMarkdown } from '../src/bots/threads/draft';
import { ThreadsGenerator } from '../src/bots/threads/generate';
import { threadsAiAnswer } from '../src/bots/threads/aiAnswer';
import { gitVersion, readPicksFile, savedDraftReader } from '../src/bots/threads/inputs';
import { pickOverrideOf } from '../src/bots/threads/picksFile';
import { renderAnswerPng, renderGridPngs, renderPuzzlePng } from '../src/bots/threads/image';
import { THREADS_START_DATE, addDays, taipeiToday, weekdayOf } from '../src/bots/threads/plan';
import { readTemplateFile } from '../src/bots/threads/template';

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
const withAi = !flag('--no-ai');
// 系列起點：--start，沒給就用 THREADS_LIVE_FROM（正式發的第一天），再沒有就用預設值。
const startDate = arg('--start', process.env.THREADS_LIVE_FROM || THREADS_START_DATE);
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
const version = gitVersion(root);

// 站長在主控台改的貼文格式（同步進 threads_template.json）；沒有或不合格就用內建格式。
const template = readTemplateFile(path.resolve(arg('--template', path.join(root, 'threads_template.json'))));
for (const w of template.warnings) console.warn(w);
const gen = new ThreadsGenerator({ bank, titles, readSaved, startDate, pickOverride: pickOverrideOf(overrides), template: template.template });
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
  // 題目卡之後：牌譜放不進題目卡時的續圖（後面的列，要幾張就幾張），檔名跟自動發佈一樣 <日期>-grid-<n>.png。
  if (pv && image) {
    try {
      const grids = renderGridPngs(pv, weekdayOf(date)).map((png, i) => {
        const name = `${date}-grid-${i + 1}.png`;
        fs.writeFileSync(path.join(outDir, name), png);
        return name;
      });
      if (grids.length) draft.post.gridImages = grids;
    } catch (err) {
      console.warn(`${date}: grid images skipped (${(err as Error).message})`);
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
  // 百科AI 的答案（只給站長）：寫進 <日期>.json 的 aiAnswer，不進貼文和 .md。
  let aiAnswer: ReturnType<typeof threadsAiAnswer> | undefined;
  if (withAi && pv) {
    try {
      aiAnswer = threadsAiAnswer(pv.game, pv.pick, { exerciseId: pv.exerciseId, gitSha: version.sha, gitDirty: version.dirty });
    } catch (err) {
      console.warn(`${date}: aiAnswer skipped (${(err as Error).message})`);
    }
  }
  fs.writeFileSync(path.join(outDir, `${date}.json`), `${JSON.stringify(aiAnswer ? { ...draft, aiAnswer } : draft, null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, `${date}.md`), draftMarkdown(draft));
  console.log(`${date} ${draft.theme} ${draft.exerciseId} post ${draft.post.chars} chars${draft.answerToYesterday ? `, with ${draft.answerToYesterday.exerciseId} answer` : ''}${draft.recordId ? '' : ' (no records page)'}${aiAnswer ? `; 百科AI ${aiAnswer.pick.text}（真人 ${aiAnswer.real.text}）` : ''}`);
}
for (const w of gen.warnings) console.warn(w);
