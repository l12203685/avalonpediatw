/**
 * Threads 每日自動發佈的指令（給 .github/workflows/threads-publish.yml 用；本機也能試）。
 *
 *   tsx scripts/threadsPublish.ts prepare --date 2026-11-18 --state-dir <threads-state 的資料夾> --out <輸出>
 *   tsx scripts/threadsPublish.ts post    --out <輸出> --state-dir <...>          # 要 THREADS_ACCESS_TOKEN；圖的網址放 IMAGE_URL
 *   tsx scripts/threadsPublish.ts record-manual --date 2026-11-17 --state-dir <...> [--post-id <id>]
 *   tsx scripts/threadsPublish.ts token --token-out <檔案> [--force]                 # 權杖快到期就續期
 *
 * 選項：--picks（預設 packages/server/threads_picks.json）、--comments（預設 docs/threads/comments）、--start（第一篇的日期）。
 * 權杖只從環境變數讀，不印出、不寫進 out；token 指令續期後的新權杖只寫到 --token-out 指定的檔案（CI 用完即刪）。
 */

import fs from 'fs';
import path from 'path';
import { buildSimBank, readSimBankFile } from '../src/bots/simulation/bank';
import { readRecordPosts } from '../src/bots/simulation/recordsIndex';
import { ThreadsGenerator } from '../src/bots/threads/generate';
import { gridOverflowStart, renderPuzzlePng } from '../src/bots/threads/image';
import { THREADS_START_DATE, taipeiToday, weekdayOf } from '../src/bots/threads/plan';
import { loadPlayerNames, planSummary, postDaily, prepareDaily, readPicks, readState, recordManual, savedFromState, findByExercise, type DailyPlan } from '../src/bots/threads/publish/daily';
import { gitCheckpoint } from '../src/bots/threads/publish/stateGit';
import { ThreadsApi, tokenProblem } from '../src/bots/threads/publish/threadsApi';

const serverRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(serverRoot, '..', '..');
const [cmd, ...argv] = process.argv.slice(2);
const arg = (name: string, fallback = ''): string => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const flag = (name: string): boolean => argv.includes(name);

const summaryLines: string[] = [];
function say(line = ''): void {
  console.log(line);
  summaryLines.push(line);
}
function flushSummary(): void {
  const f = process.env.GITHUB_STEP_SUMMARY;
  if (f) fs.appendFileSync(f, `${summaryLines.join('\n')}\n`);
}

function makeGenerator(stateDir: string, warnings: string[]): ThreadsGenerator {
  const bankFile = readSimBankFile([path.join(serverRoot, 'sim_bank.json')]);
  if (!bankFile) throw new Error('sim_bank.json not found or unreadable');
  const bank = buildSimBank(bankFile, readRecordPosts([path.join(serverRoot, 'records_cache.json')]));
  const wiki = JSON.parse(fs.readFileSync(path.join(serverRoot, 'wiki_data.json'), 'utf8')) as { id: string; title: string }[];
  const titles = new Map(wiki.map((a) => [a.id, a.title] as [string, string]));
  const picks = readPicks(path.resolve(arg('--picks', path.join(serverRoot, 'threads_picks.json'))), warnings);
  return new ThreadsGenerator({
    bank,
    titles,
    readSaved: savedFromState(stateDir),
    startDate: arg('--start', process.env.THREADS_START_DATE || THREADS_START_DATE),
    pickOverride: (date) => picks.get(date) ?? null,
  });
}

function apiFromEnv(userId = process.env.THREADS_USER_ID || 'me'): ThreadsApi {
  const token = process.env.THREADS_ACCESS_TOKEN ?? '';
  if (!token) throw new Error('沒有 THREADS_ACCESS_TOKEN（GitHub secrets）');
  return new ThreadsApi({ token, userId });
}

/** 沒設 THREADS_USER_ID 時用權杖查出帳號 id（發文的網址要用數字 id）。 */
async function apiWithUser(): Promise<ThreadsApi> {
  if (process.env.THREADS_USER_ID) return apiFromEnv();
  const me = await apiFromEnv().me();
  return apiFromEnv(me.id);
}

/** 發文前確認權杖：有效、權限夠、是同一個帳號。查不到權限也不發（fail closed）；只有正式發佈會呼叫。 */
async function checkToken(api: ThreadsApi): Promise<void> {
  const info = await api.tokenInfo();
  const problem = tokenProblem(info);
  if (problem) throw new Error(problem);
  if (info && info.expiresAt > 0) say(`- 權杖還有 ${Math.floor((info.expiresAt * 1000 - Date.now()) / 86_400_000)} 天到期`);
  const me = await api.me();
  const want = process.env.THREADS_USER_ID;
  if (want && me.id !== want) throw new Error('THREADS_USER_ID 和權杖的帳號不一樣');
}

function printPlan(plan: DailyPlan, mode: string): void {
  for (const line of planSummary(plan, mode)) say(line);
}

async function main(): Promise<number> {
  const stateDir = path.resolve(arg('--state-dir', path.join(serverRoot, 'threads_state')));
  const outDir = path.resolve(arg('--out', path.join(serverRoot, 'threads_publish_out')));
  const date = arg('--date', process.env.THREADS_DATE || taipeiToday());

  if (cmd === 'prepare') {
    const warnings: string[] = [];
    const gen = makeGenerator(stateDir, warnings);
    const plan = prepareDaily(date, {
      gen,
      stateDir,
      outDir,
      commentsDir: path.resolve(arg('--comments', path.join(repoRoot, 'docs', 'threads', 'comments'))),
      names: loadPlayerNames(serverRoot),
      warnings,
      renderImage: flag('--no-image')
        ? undefined
        : (d): Buffer | null => {
            const pick = gen.pickFor(d);
            const pv = pick ? gen.viewOf(pick) : null;
            return pv ? renderPuzzlePng(pv, weekdayOf(d)) : null;
          },
      // 牌譜太長時題目卡只畫前半、寫「往右滑」：這條管線只發一張圖，正式發佈這天不發（試跑只警告）。
      imageIncomplete: (d): string | null => {
        const pick = gen.pickFor(d);
        const pv = pick ? gen.viewOf(pick) : null;
        return pv && gridOverflowStart(pv) !== null ? '牌譜太長，題目卡要第二張續圖，但這條管線只發一張圖' : null;
      },
    });
    if (!plan) {
      say(`## Threads ${date}：這天的主題選不到題目`);
      flushSummary();
      return 2;
    }
    printPlan(plan, process.env.THREADS_MODE || 'prepare');
    flushSummary();
    return plan.errors.length > 0 ? 2 : 0;
  }

  if (cmd === 'post') {
    const plan = JSON.parse(fs.readFileSync(path.join(outDir, 'plan.json'), 'utf8')) as DailyPlan;
    if (plan.alreadyPublished && !plan.resumeComment) {
      say(`- ${plan.date} 已經發過，跳過`);
      flushSummary();
      return 0;
    }
    const api = await apiWithUser();
    await checkToken(api);
    // --checkpoint-push（CI）：每次真的發出東西就把狀態檔推上 threads-state，中斷也不會丟掉紀錄。
    const checkpoint = flag('--checkpoint-push') ? (label: string): Promise<void> => gitCheckpoint(stateDir, `threads: ${plan.date} ${label}`) : undefined;
    const result = await postDaily(plan, { api, stateDir, imageUrl: process.env.IMAGE_URL || undefined, checkpoint });
    fs.writeFileSync(path.join(outDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
    say(`- 結果：${result.status}，貼文 ${result.permalink ?? result.postId}${result.commentId ? '，第一則留言已發' : ''}`);
    for (const n of result.notes) say(`- ${n}`);
    flushSummary();
    return 0;
  }

  if (cmd === 'record-manual') {
    const warnings: string[] = [];
    const gen = makeGenerator(stateDir, warnings);
    let postId: string | null = arg('--post-id') || null;
    let permalink: string | undefined;
    if (!postId && process.env.THREADS_ACCESS_TOKEN) {
      const draft = readState(stateDir, date)?.draft ?? gen.draftFor(date);
      if (draft) {
        const found = findByExercise(await (await apiWithUser()).recentPosts(), draft.exerciseId, date);
        if (found) {
          postId = found.id;
          permalink = found.permalink;
        }
      }
    }
    const rec = recordManual(date, postId, { gen, stateDir, permalink });
    if (!rec) {
      say(`- ${date}：選不到題目，沒有補記`);
      flushSummary();
      return 2;
    }
    say(`- 補記 ${date}：題號 ${rec.exerciseId}，貼文 id ${rec.postId ?? '（沒有：隔天那篇會去最近的貼文找，找不到就不引用）'}`);
    flushSummary();
    return 0;
  }

  if (cmd === 'token') {
    const api = apiFromEnv();
    const info = await api.tokenInfo();
    const daysLeft = info && info.expiresAt > 0 ? Math.floor((info.expiresAt * 1000 - Date.now()) / 86_400_000) : null;
    say(`- 權杖：${daysLeft === null ? '查不到到期日' : `還有 ${daysLeft} 天`}`);
    const due = flag('--force') || (daysLeft !== null && daysLeft < 20) || (daysLeft === null && weekdayOf(taipeiToday()) === 1);
    const out = arg('--token-out');
    if (due && out) {
      const r = await api.refresh();
      fs.writeFileSync(out, r.token, { mode: 0o600 });
      say(`- 已續期（新的權杖 ${Math.floor(r.expiresIn / 86_400)} 天後到期），由下一步寫回 secrets`);
    }
    flushSummary();
    return 0;
  }

  console.error('用法：threadsPublish.ts prepare|post|record-manual|token …');
  return 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    say(`- ❌ ${(err as Error).message}`);
    flushSummary();
    process.exit(1);
  },
);
