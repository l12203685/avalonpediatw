/**
 * Threads 每日一題的「百科AI 答案」（2026-11-18；只給站長看，不進貼文）。
 *
 *   pnpm --filter server threads:ai-answer --date 2026-11-19          # 那一天的題目（跟 threads:draft 同一套選題）
 *   pnpm --filter server threads:ai-answer --exercise SV1Q8-3-5       # 指定題號
 *   pnpm --filter server threads:ai-answer --date 2026-11-19 --exercise SV1Q8-3-5   # 題號優先，日期只當標籤
 *   選項：--days N／--week（從 --date 起連續幾天，輸出 { 日期: 答案 }）、--seed <字串>（不給＝跟模擬瓦 /區間 同一個種子）、
 *         --out <檔>（寫成 JSON 檔；不給就印出來）、--summary（另外在 stderr 印一段好讀的摘要）、
 *         --picks <檔>、--drafts <資料夾>、--start YYYY-MM-DD（跟 threads:draft 一樣：站長選的題目、存下來的草稿、系列起點）。
 *
 * 輸出的欄位見 src/bots/threads/aiAnswer.ts（ThreadsAiAnswer）。同一題、同一個種子結果一樣。
 */

import fs from 'fs';
import path from 'path';
import { buildSimBank, readSimBankFile } from '../src/bots/simulation/bank';
import { readRecordPosts } from '../src/bots/simulation/recordsIndex';
import { aiAnswerSummary, targetOfExercise, threadsAiAnswer, type ThreadsAiAnswer } from '../src/bots/threads/aiAnswer';
import { ThreadsGenerator } from '../src/bots/threads/generate';
import { gitVersion, readPicksFile, savedDraftReader } from '../src/bots/threads/inputs';
import { pickOverrideOf } from '../src/bots/threads/picksFile';
import { THREADS_START_DATE, addDays, taipeiToday } from '../src/bots/threads/plan';

const root = path.resolve(__dirname, '..');
const argv = process.argv.slice(2).filter((a) => a !== '--');
const arg = (name: string, fallback: string): string => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const flag = (name: string): boolean => argv.includes(name);

const exercise = arg('--exercise', '');
const start = arg('--date', exercise ? '' : taipeiToday());
const days = flag('--week') ? 7 : Number(arg('--days', '1'));
const seed = arg('--seed', '') || undefined;
const out = arg('--out', '');

const bankFile = readSimBankFile([path.join(root, 'sim_bank.json')]);
if (!bankFile) {
  console.error('sim_bank.json not found or unreadable');
  process.exit(1);
}
const bank = buildSimBank(bankFile, readRecordPosts([path.join(root, 'records_cache.json')]));
const version = gitVersion(root);

function answerFor(exerciseId: string): ThreadsAiAnswer {
  const t = targetOfExercise(bank, exerciseId);
  if (!t) throw new Error(`題庫裡沒有這一題：${exerciseId}`);
  return threadsAiAnswer(t.game, t.target, { exerciseId, seed, gitSha: version.sha, gitDirty: version.dirty });
}

const results: Record<string, ThreadsAiAnswer> = {};
if (exercise) {
  if (days > 1) {
    console.error('--exercise 只能配一天（--days／--week 請用 --date）');
    process.exit(1);
  }
  results[start || exercise] = answerFor(exercise);
} else {
  const defaultPicks = path.join(root, 'threads_picks.json');
  const picksPath = arg('--picks', fs.existsSync(defaultPicks) ? defaultPicks : '');
  const draftsDir = path.resolve(arg('--drafts', path.join(root, 'threads_drafts')));
  const gen = new ThreadsGenerator({
    bank,
    titles: new Map(),
    readSaved: savedDraftReader(draftsDir),
    startDate: arg('--start', process.env.THREADS_LIVE_FROM || THREADS_START_DATE),
    pickOverride: pickOverrideOf(readPicksFile(picksPath)),
  });
  for (let i = 0; i < days; i++) {
    const date = addDays(start, i);
    const pick = gen.pickFor(date);
    const pv = pick ? gen.viewOf(pick) : null;
    if (!pick || !pv) {
      console.warn(`${date}: 這天沒有題目`);
      continue;
    }
    results[date] = threadsAiAnswer(pv.game, pick, { exerciseId: pv.exerciseId, seed, gitSha: version.sha, gitDirty: version.dirty });
  }
  for (const w of gen.warnings) console.warn(w);
}

const keys = Object.keys(results);
const body = keys.length === 1 && exercise ? results[keys[0]] : results;
const json = `${JSON.stringify(body, null, 2)}\n`;
if (out) {
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(path.resolve(out), json);
  console.error(`wrote ${path.resolve(out)} (${keys.length} answer${keys.length === 1 ? '' : 's'})`);
} else {
  process.stdout.write(json);
}
if (flag('--summary')) for (const k of keys) console.error(`\n[${k}]\n${aiAnswerSummary(results[k])}`);
