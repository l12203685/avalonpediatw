/**
 * Threads 每日自動發佈的指令（給 .github/workflows/threads-publish.yml 用；本機也能試）。
 *
 *   tsx scripts/threadsPublish.ts prepare --date 2026-11-18 --state-dir <threads-state 的資料夾> --out <輸出>
 *   tsx scripts/threadsPublish.ts post    --out <輸出> --state-dir <...>          # 要 THREADS_ACCESS_TOKEN；圖的網址放 IMAGE_URL
 *   tsx scripts/threadsPublish.ts record-manual --date 2026-11-17 --state-dir <...> [--post-id <id>]
 *   tsx scripts/threadsPublish.ts token --token-out <檔案> [--force]                 # 權杖快到期就續期
 *   tsx scripts/threadsPublish.ts post-ig --out <輸出> --state-dir <...>       # Instagram 同步：要 INSTAGRAM_ACCESS_TOKEN；JPEG 網址放 IG_IMAGE_URLS（逗號分隔）
 *   tsx scripts/threadsPublish.ts token-ig --token-out <檔案> [--force]              # IG 權杖續期（每週一或 --force）
 *
 * 選項：--picks（預設 packages/server/threads_picks.json）、--comments（預設 docs/threads/comments）、--start（第一篇的日期）。
 * 權杖只從環境變數讀，不印出、不寫進 out；token 指令續期後的新權杖只寫到 --token-out 指定的檔案（CI 用完即刪）。
 */

import fs from 'fs';
import path from 'path';
import { buildSimBank, readSimBankFile } from '../src/bots/simulation/bank';
import { readRecordPosts } from '../src/bots/simulation/recordsIndex';
import { ThreadsGenerator } from '../src/bots/threads/generate';
import * as threadsImage from '../src/bots/threads/image';
import { THREADS_START_DATE, taipeiToday, weekdayOf } from '../src/bots/threads/plan';
import { igCaption, loadPlayerNames, planSummary, postDaily, postInstagram, prepareDaily, readPicks, readState, recordManual, savedFromState, postedFromState, findByExercise, titleOf, type DailyPlan } from '../src/bots/threads/publish/daily';
import { extraRenderers } from '../src/bots/threads/publish/extraImages';
import { gitCheckpoint } from '../src/bots/threads/publish/stateGit';
import { ThreadsApi, tokenProblem } from '../src/bots/threads/publish/threadsApi';
import { InstagramApi } from '../src/bots/threads/publish/instagramApi';

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
    // 昨天真的有貼文（threads-state 有記錄）才引用昨天、附昨天的答案；系列起點用 THREADS_LIVE_FROM（正式發的第一天；workflow 傳閘門算好的值）。
    hasPost: postedFromState(stateDir),
    startDate: arg('--start', process.env.THREADS_LIVE_FROM || process.env.THREADS_START_DATE || THREADS_START_DATE),
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
  // IG 說明含貼文和留言：內容檢查過了才印（Actions 的紀錄是公開的）。
  if (process.env.IG_PREVIEW === '1' && plan.errors.length === 0) {
    say('### Instagram 說明（同步用）');
    say('```');
    say(igCaption(plan));
    say('```');
  }
}

function igFromEnv(userId = process.env.INSTAGRAM_USER_ID || 'me'): InstagramApi {
  const token = process.env.INSTAGRAM_ACCESS_TOKEN ?? '';
  if (!token) throw new Error('沒有 INSTAGRAM_ACCESS_TOKEN（GitHub secrets）');
  return new InstagramApi({ token, userId });
}

/** 沒設 INSTAGRAM_USER_ID 時用權杖查出 IG 帳號 id。 */
async function igWithUser(): Promise<InstagramApi> {
  if (process.env.INSTAGRAM_USER_ID) return igFromEnv();
  const me = await igFromEnv().me();
  if (!me.id) throw new Error('查不到 IG 帳號 id：權杖要有 instagram_business_basic，帳號要是專業帳號');
  return igFromEnv(me.id);
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
            return pv ? threadsImage.renderPuzzlePng(pv, weekdayOf(d)) : null;
          },
      renderExtraImages: flag('--no-image') ? undefined : extraRenderers(gen),
      // 牌譜太長時題目卡只畫前半、寫「往右滑」：續圖（renderExtraImages 的 grid）沒產生就正式發佈這天不發。
      // 牌譜太長時分成幾張續圖（要幾張就幾張）：一張不少地產生了才發；畫圖失敗、少了幾張，正式發佈這天不發。
      imageIncomplete: (d, images): string | null => {
        const pick = gen.pickFor(d);
        const pv = pick ? gen.viewOf(pick) : null;
        const need = pv ? threadsImage.gridPages(pv).length : 0;
        const have = images.filter((n) => /-grid-\d+\.png$/.test(n)).length;
        return have < need ? `牌譜要 ${need} 張續圖，只產生了 ${have} 張` : null;
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
    const imageUrls = (process.env.IMAGE_URLS ?? '')
      .split(',')
      .map((u) => u.trim())
      .filter(Boolean);
    // --checkpoint-push（CI）：每次真的發出東西就把狀態檔推上 threads-state，中斷也不會丟掉紀錄。
    const checkpoint = flag('--checkpoint-push') ? (label: string): Promise<void> => gitCheckpoint(stateDir, `threads: ${plan.date} ${label}`) : undefined;
    const result = await postDaily(plan, { api, stateDir, imageUrls, imageUrl: process.env.IMAGE_URL || undefined, checkpoint });
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
        const found = findByExercise(await (await apiWithUser()).recentPosts(), draft.exerciseId, date, titleOf(draft.post.text));
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

  if (cmd === 'post-ig') {
    const plan = JSON.parse(fs.readFileSync(path.join(outDir, 'plan.json'), 'utf8')) as DailyPlan;
    const imageUrls = (process.env.IG_IMAGE_URLS ?? '')
      .split(',')
      .map((u) => u.trim())
      .filter(Boolean);
    // 先確認 IG 權杖能發文；確認不了就跳過 IG（只警告、這一步不失敗），不影響 Threads。
    let api: InstagramApi;
    try {
      api = await igWithUser();
    } catch (err) {
      say(`- ⚠️ Instagram 跳過：${(err as Error).message}`);
      console.log(`::warning::Instagram 跳過：確認不了 IG 權杖`);
      flushSummary();
      return 0;
    }
    const problem = await api.publishingProblem();
    if (problem) {
      say(`- ⚠️ Instagram 跳過：${problem}`);
      console.log(`::warning::Instagram 跳過：${problem}`);
      flushSummary();
      return 0;
    }
    const checkpoint = flag('--checkpoint-push') ? (label: string): Promise<void> => gitCheckpoint(stateDir, `threads: ${plan.date} ${label}`) : undefined;
    const r = await postInstagram(plan, { api, stateDir, imageUrls, checkpoint });
    say(`- Instagram：${r.status}${r.permalink ? `，${r.permalink}` : r.mediaId ? `，貼文 ${r.mediaId}` : ''}`);
    for (const n of r.notes) say(`- ${n}`);
    flushSummary();
    return 0;
  }

  if (cmd === 'token-ig') {
    const out = arg('--token-out');
    if (out && (flag('--force') || weekdayOf(taipeiToday()) === 1)) {
      const r = await igFromEnv().refresh();
      fs.writeFileSync(out, r.token, { mode: 0o600 });
      say(`- IG 權杖已續期（${Math.floor(r.expiresIn / 86_400)} 天後到期），由下一步寫回 secrets`);
    }
    flushSummary();
    return 0;
  }

  console.error('用法：threadsPublish.ts prepare|post|record-manual|token|post-ig|token-ig …');
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
