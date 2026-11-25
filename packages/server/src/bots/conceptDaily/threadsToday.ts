/**
 * 每日小觀念 — 當天 Threads／IG 的題目（站長 11/18：「牌局: 優先以當日 threads/IG 發文的題目」）。
 *
 * 跟每日草稿（scripts/threadsPublish.ts prepare）用同一個 ThreadsGenerator.pickFor，輸入也一樣：
 *   - 站長選的題 threads_picks.json（選局頁每天由例行作業同步進 main）；
 *   - 存下來的草稿與「那天有沒有真的貼文」：threads-state 分支的 state/<日期>.json；
 *   - 系列起點：THREADS_LIVE_FROM（伺服器的環境變數，選用）＞ threads_live.json 的 liveFrom ＞ 預設值。
 * 小觀念早上就發，比 12:07 的貼文早，所以這些都在發之前從公開 repo 讀最新的（raw.githubusercontent.com，
 * 讀不到就用映像檔裡的那份、當作沒有存下來的草稿）。題庫是模擬瓦讀好的那一份（同一個 sim_bank.json＋牌譜對照）。
 */

import fs from 'fs';
import path from 'path';
import type { SimBank } from '../simulation/bank';
import { exerciseOfPick } from '../threads/concepts';
import { ThreadsGenerator } from '../threads/generate';
import { hookQuestion, type ThreadsDraft } from '../threads/draft';
import { parsePicks } from '../threads/picksFile';
import { THREADS_START_DATE, addDays, exerciseIdOfPick } from '../threads/plan';
import { cutoffRecordUrl, type ThreadsToday } from './plan';

/** threads-state 分支 state/<日期>.json 裡用得到的欄位。 */
export interface ThreadsStateLike {
  draft?: ThreadsDraft;
  source?: string;
  postId?: string | null;
  permalink?: string;
}

export interface ThreadsInputs {
  picks: Map<string, string>;
  liveFrom: string | null;
  /** 日期 → 狀態檔（沒有 = null）。 */
  states: Map<string, ThreadsStateLike | null>;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

type Fetch = typeof fetch;

export interface FetchThreadsOptions {
  fetchImpl?: Fetch;
  /** "owner/repo"（公開）；預設 THREADS_STATE_REPO 或 l12203685/avalonpediatw。 */
  repo?: string;
  timeoutMs?: number;
  /** 讀不到時用的本機檔（映像檔裡的 packages/server/）。 */
  localDir?: string;
}

async function getJson(f: Fetch, url: string, timeoutMs: number): Promise<{ status: number; body: unknown }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await f(url, { signal: ctrl.signal, headers: { 'User-Agent': 'avalonpediatw-bot' } });
    if (!res.ok) return { status: res.status, body: null };
    return { status: res.status, body: await res.json() };
  } finally {
    clearTimeout(timer);
  }
}

function readLocal(file: string): unknown {
  try {
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  } catch {
    return null;
  }
}

function liveFromOf(raw: unknown): string | null {
  const v = (raw as { liveFrom?: unknown } | null)?.liveFrom;
  return typeof v === 'string' && DATE_RE.test(v) ? v : null;
}

/** 讀當天（與前兩天）要用的輸入。不會丟錯：讀不到的部分用本機檔或空的。 */
export async function fetchThreadsInputs(date: string, opts: FetchThreadsOptions = {}): Promise<ThreadsInputs> {
  const f = opts.fetchImpl ?? fetch;
  const repo = opts.repo ?? (process.env.THREADS_STATE_REPO || 'l12203685/avalonpediatw');
  const timeoutMs = opts.timeoutMs ?? 5000;
  const localDir = opts.localDir ?? path.resolve(__dirname, '..', '..', '..');
  const raw = (branch: string, file: string): string => `https://raw.githubusercontent.com/${repo}/${branch}/${file}`;
  const safe = async (url: string): Promise<{ status: number; body: unknown }> => {
    try {
      return await getJson(f, url, timeoutMs);
    } catch {
      return { status: 0, body: null };
    }
  };
  const dates = [date, addDays(date, -1), addDays(date, -2)];
  const [picksRes, liveRes, ...stateRes] = await Promise.all([
    safe(raw('main', 'packages/server/threads_picks.json')),
    safe(raw('main', 'packages/server/threads_live.json')),
    ...dates.map((d) => safe(raw('threads-state', `state/${d}.json`))),
  ]);
  const picksRaw = picksRes.body ?? readLocal(path.join(localDir, 'threads_picks.json'));
  const liveRaw = liveRes.body ?? readLocal(path.join(localDir, 'threads_live.json'));
  const states = new Map<string, ThreadsStateLike | null>();
  dates.forEach((d, i) => {
    const b = stateRes[i].body;
    states.set(d, b && typeof b === 'object' ? (b as ThreadsStateLike) : null);
  });
  return { picks: parsePicks(picksRaw), liveFrom: liveFromOf(liveRaw), states };
}

/** 當天的 Threads 題目（跟草稿同一個 pickFor）；那天沒有題目或題庫沒有那一局就 null。 */
export function threadsToday(bank: Pick<SimBank, 'games' | 'byId' | 'records'>, date: string, inputs: ThreadsInputs): ThreadsToday | null {
  const state = (d: string): ThreadsStateLike | null => inputs.states.get(d) ?? null;
  const gen = new ThreadsGenerator({
    bank,
    titles: new Map(),
    readSaved: (d): ThreadsDraft | null => state(d)?.draft ?? null,
    hasPost: (d): boolean => {
      const rec = state(d);
      return !!rec && (!!rec.postId || rec.source === 'manual');
    },
    startDate: process.env.THREADS_LIVE_FROM || inputs.liveFrom || process.env.THREADS_START_DATE || THREADS_START_DATE,
    pickOverride: (d): string | null => inputs.picks.get(d) ?? null,
  });
  const pick = gen.pickFor(date);
  if (!pick) return null;
  const g = gen.gameOf(pick.gameId);
  if (!g) return null;
  const postId = bank.records.get(g.index);
  const permalink = state(date)?.permalink;
  return {
    exerciseId: exerciseIdOfPick(pick, g.game),
    exercise: exerciseOfPick(g.game, pick),
    recordUrl: postId ? cutoffRecordUrl(postId, pick.proposal, pick.seat) : null,
    question: hookQuestion(pick),
    ...(typeof permalink === 'string' && /^https:\/\/(www\.)?threads\.(net|com)\//.test(permalink) ? { threadsUrl: permalink } : {}),
  };
}
