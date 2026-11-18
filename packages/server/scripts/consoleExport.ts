/**
 * 主控台匯出（2026-11-18，站長：「你主控台目前也沒跟百科網站作完整連動吧? (唯一來源 牌譜 資料庫同步 文章同步 等等的)」）。
 * repo main 是唯一來源；主控台（私人 artifact，讀不到網站和 GitHub）只讀跟它一起發佈的檔案。這支程式從目前的 checkout
 * 寫出主控台要顯示的全部檔案，主控台照抄、不再手工拼。系統圖、每天的流程與編輯回流（console:apply）見 docs/CONSOLE.md。
 *
 *   pnpm --filter @avalon/server console:export -- --out <資料夾>
 *   選項：--date YYYY-MM-DD（一週草稿的第一天，預設今天，台北）、--days N（預設 7）、
 *         --state-dir <threads-state 分支的 clone>（已經發出去的日子以那裡的草稿為準、標 frozen；沒給就沒有 frozen）、
 *         --start YYYY-MM-DD（系列起點；預設 THREADS_LIVE_FROM → threads_live.json 的 liveFrom → 內建值）、
 *         --no-image（不畫 PNG）、--skip-games（不跑牌譜這一半）、--names（問題牌譜附座位暱稱，只給私人主控台）、
 *         --with-proavalon（總庫用 game_db.py --with-proavalon 建的時候）、
 *         --now <ISO 時間>、--sha <commit>（測試用：固定輸出）、--python <python 執行檔>（預設 python3）
 *
 * 輸出（--out 要在 repo 外面；問題牌譜的原文只給私人主控台）：
 *   problem_games.json、game_counts.json   console_export.py（牌譜總庫）
 *   name_collisions.json                   console_export.py → name_collisions.py：同名不同人候選（含名字）與 nameSplits 建議文件
 *   concepts.json                          觀念卡庫（這個分支沒有就 available: false）
 *   wiki_index.json                        百科文章：id、標題、章節、網址、最後修改的 commit／日期
 *   week_drafts.json + week_drafts/*.png   從 --date 起 7 天的 Threads 草稿（貼文、第一則留言、圖、parts）與貼文／留言範本
 *   manifest.json                          來源 commit、產生時間、每個檔的數量、注意事項
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { buildSimBank, readSimBankFile } from '../src/bots/simulation/bank';
import { readRecordPosts } from '../src/bots/simulation/recordsIndex';
import { ThreadsGenerator } from '../src/bots/threads/generate';
import { renderPuzzlePng } from '../src/bots/threads/image';
import { THREADS_START_DATE, addDays, taipeiToday, weekdayOf } from '../src/bots/threads/plan';
import { commentText, fallbackComment, postedFromState, readComment, readPicks, savedFromState } from '../src/bots/threads/publish/daily';
import { COMMENT_PLACEHOLDERS, PLACEHOLDER_HELP, POST_PLACEHOLDERS, commentBody, readTemplateFile } from '../src/bots/threads/template';
import { extraRenderers } from '../src/bots/threads/publish/extraImages';
import { articleHistory, checkoutState, conceptsExport, manifest, weekDay, wikiIndex, writeJson, type WeekDay, type WikiArticle } from './console/exportLib';

const serverRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(serverRoot, '..', '..');
const argv = process.argv.slice(2).filter((a) => a !== '--');
const arg = (name: string, fallback = ''): string => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const flag = (name: string): boolean => argv.includes(name);

const outArg = arg('--out');
if (!outArg) {
  console.error('usage: console:export --out <dir> [--date YYYY-MM-DD] [--days N] [--state-dir <dir>] [--no-image] [--skip-games] [--names]');
  process.exit(1);
}
const outDir = path.resolve(outArg);
if (outDir === repoRoot || outDir.startsWith(repoRoot + path.sep)) {
  console.error(`--out 要在 repo 外面（${outDir}）：問題牌譜的原文只給私人主控台，不能進 git`);
  process.exit(1);
}
const checkout = checkoutState(repoRoot);
const sha = arg('--sha', checkout.sha);
// 產生時間一律 UTC（ISO，秒為單位、結尾 Z）；--now 可以給任何時區，換成 UTC。主控台右上角的時間戳記讀 manifest 的 generatedAt。
const nowArg = arg('--now');
const nowDate = nowArg ? new Date(nowArg) : new Date();
if (Number.isNaN(nowDate.getTime())) {
  console.error(`--now 不是合法的時間：${nowArg}`);
  process.exit(1);
}
const now = nowDate.toISOString().replace(/\.\d{3}Z$/, 'Z');
const notes: string[] = [];
const files: Record<string, Record<string, number | boolean | string>> = {};
if (checkout.dirty) notes.push('checkout 有還沒 commit 的改動：輸出不完全等於 sourceSha');

fs.mkdirSync(outDir, { recursive: true });

// ─── 1. 牌譜（Python：總庫在 game_db.py） ───────────────────────────────────
if (!flag('--skip-games')) {
  const py = arg('--python', 'python3');
  const pyArgs = [path.join(serverRoot, 'console_export.py'), '--out', outDir, '--srv', serverRoot, '--sha', sha, '--now', now];
  if (flag('--names')) pyArgs.push('--names');
  if (flag('--with-proavalon')) pyArgs.push('--with-proavalon');
  const summary = JSON.parse(execFileSync(py, pyArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim().split('\n').pop() as string) as Record<
    string,
    Record<string, number | boolean>
  >;
  Object.assign(files, summary);
  if (summary['game_counts.json']?.gameDbInSync === false) notes.push('game_db.json 跟這份 checkout 的來源重建出來的不一樣（來源改了、總庫還沒重建）：問題清單照 game_db.json');
  if (flag('--names')) notes.push('problem_games.json 含座位暱稱（--names）：只給私人主控台');
  notes.push('name_collisions.json（同名不同人候選）一律含玩家名字：只給私人主控台');
} else {
  notes.push('--skip-games：沒有產生 problem_games.json、game_counts.json、name_collisions.json');
}

// ─── 2. 觀念卡 ─────────────────────────────────────────────────────────────
const conceptsRel = 'packages/server/src/bots/threads/concepts.json';
const concepts = conceptsExport(path.join(repoRoot, conceptsRel), conceptsRel);
writeJson(path.join(outDir, 'concepts.json'), concepts);
files['concepts.json'] = { available: concepts.available, concepts: concepts.count };
if (!concepts.available) notes.push(concepts.note as string);
else notes.push('觀念卡沒有 stale 旗標：觀念卡檢查（concepts check）還不在這個分支');

// ─── 3. 百科文章 ───────────────────────────────────────────────────────────
const wikiRel = 'packages/server/wiki_data.json';
const articles = JSON.parse(fs.readFileSync(path.join(repoRoot, wikiRel), 'utf8')) as WikiArticle[];
const history = articleHistory(repoRoot, wikiRel, articles.map((a) => a.id));
const wiki = wikiIndex(articles, history);
writeJson(path.join(outDir, 'wiki_index.json'), { source: wikiRel, articles: wiki });
const inexact = wiki.filter((a) => !a.lastChanged || !a.lastChanged.exact).length;
files['wiki_index.json'] = { articles: wiki.length, sections: wiki.reduce((n, a) => n + a.sections.length, 0), lastChangedInexact: inexact };
if (inexact) notes.push(`wiki_index.json：${inexact} 篇的最後修改日期不精確（git 歷史是淺 clone，實際可能更早）`);

// ─── 4. 一週草稿 ───────────────────────────────────────────────────────────
const start = arg('--date', taipeiToday());
const days = Number(arg('--days', '7'));
const withImage = !flag('--no-image');
const stateArg = arg('--state-dir');
const stateDir = stateArg ? path.resolve(stateArg) : '';
const liveFile = path.join(serverRoot, 'threads_live.json');
const liveFrom = fs.existsSync(liveFile) ? ((JSON.parse(fs.readFileSync(liveFile, 'utf8')) as { liveFrom?: string | null }).liveFrom ?? '') : '';
const seriesStart = arg('--start', process.env.THREADS_LIVE_FROM || liveFrom || THREADS_START_DATE);
const warnings: string[] = [];
const bankFile = readSimBankFile([path.join(serverRoot, 'sim_bank.json')]);
if (!bankFile) throw new Error('sim_bank.json not found or unreadable');
const bank = buildSimBank(bankFile, readRecordPosts([path.join(serverRoot, 'records_cache.json')]));
const picks = readPicks(path.join(serverRoot, 'threads_picks.json'), warnings);
// 站長在主控台改的貼文／留言格式（threads_template.json，跟自動發佈同一份）；沒有就用內建格式。
const loaded = readTemplateFile(path.join(serverRoot, 'threads_template.json'));
const gen = new ThreadsGenerator({
  bank,
  titles: new Map(articles.map((a) => [a.id, a.title] as [string, string])),
  readSaved: stateDir ? savedFromState(stateDir) : (): null => null,
  ...(stateDir ? { hasPost: postedFromState(stateDir) } : {}),
  startDate: seriesStart,
  pickOverride: (date): string | null => picks.get(date) ?? null,
  postTemplate: loaded.template.post,
});
const posted = stateDir ? postedFromState(stateDir) : (): boolean => false;
const commentsDir = path.join(repoRoot, 'docs', 'threads', 'comments');
const imgDir = path.join(outDir, 'week_drafts');
fs.rmSync(imgDir, { recursive: true, force: true });
fs.mkdirSync(imgDir, { recursive: true });
const extras = extraRenderers(gen);
const weekDays: WeekDay[] = [];
const missing: string[] = [];
let pngs = 0;
for (let i = 0; i < days; i++) {
  const date = addDays(start, i);
  const pick = gen.pickFor(date);
  const pv = pick ? gen.viewOf(pick) : null;
  const images: string[] = [];
  if (pv && withImage) {
    try {
      fs.writeFileSync(path.join(imgDir, `${date}.png`), renderPuzzlePng(pv, weekdayOf(date)));
      images.push(`${date}.png`);
    } catch (err) {
      warnings.push(`${date}: 題目卡沒有產生（${(err as Error).message}）`);
    }
  }
  const draft = gen.draftFor(date, images.length ? { image: images[0] } : {});
  if (!draft) {
    missing.push(date);
    continue;
  }
  if (images.length) {
    try {
      for (const extra of extras(date, draft)) {
        if (!extra.png) continue;
        const name = `${date}-${extra.suffix}.png`;
        fs.writeFileSync(path.join(imgDir, name), extra.png);
        images.push(name);
      }
    } catch (err) {
      warnings.push(`${date}: 其他的圖沒有全部產生（${(err as Error).message}）`);
    }
  }
  pngs += images.length;
  const fromFile = readComment(commentsDir, date);
  const formatted = fromFile ? commentText(fromFile, draft, loaded.template.comment) : null;
  if (formatted?.warning) warnings.push(`${date}: ${formatted.warning}`);
  weekDays.push(
    weekDay({
      date,
      weekday: weekdayOf(date),
      draft: draft.parts ? { ...draft, parts: { ...draft.parts, ...(fromFile ? { 小觀念: commentBody(fromFile) } : {}) } } : draft,
      comment: formatted?.text ?? fallbackComment(draft),
      commentSource: fromFile ? 'file' : 'fallback',
      images,
      frozen: posted(date),
    }),
  );
}
const templateSupport = weekDays.some((d) => d.parts);
writeJson(path.join(outDir, 'week_drafts.json'), {
  generatedAt: now,
  start,
  seriesStart,
  // 實際套用的範本（threads_template.json 合格的欄位，否則內建格式）與佔位符說明：主控台的範本編輯照這份顯示。
  template: loaded.template,
  templateSource: loaded.source,
  placeholders: { post: POST_PLACEHOLDERS, comment: COMMENT_PLACEHOLDERS, help: PLACEHOLDER_HELP },
  days: weekDays,
  templateSupport,
  missing,
  warnings: [...loaded.warnings, ...warnings, ...gen.warnings],
});
files['week_drafts.json'] = {
  days: weekDays.length,
  png: pngs,
  frozen: weekDays.filter((d) => d.frozen).length,
  commentFromFile: weekDays.filter((d) => d.commentSource === 'file').length,
  templateSupport,
};
if (!templateSupport) notes.push('week_drafts.json 的草稿沒有 parts（貼文範本沒有產生佔位符內容）');
if (loaded.source.post === 'default' && loaded.source.comment === 'default') notes.push('沒有 threads_template.json：貼文與留言用內建格式');
if (!stateDir) notes.push('沒有 --state-dir：不知道哪幾天已經發出去（沒有 frozen），起始日之後每天都當作有貼文');
if (missing.length) notes.push(`week_drafts.json：${missing.join('、')} 這幾天的主題選不到題目`);

// ─── 5. manifest ───────────────────────────────────────────────────────────
writeJson(path.join(outDir, 'manifest.json'), manifest({ sha, dirty: checkout.dirty, generatedAt: now, files, notes }));
console.log(`console:export ${sha.slice(0, 7)} → ${outDir}`);
for (const [name, c] of Object.entries(files)) console.log(`  ${name} ${JSON.stringify(c)}`);
for (const n of notes) console.log(`  - ${n}`);
