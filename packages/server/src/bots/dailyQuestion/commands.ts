/**
 * /每日一題（2026-11-25）— 今天的「阿瓦隆每日一題」：一句話的問題、你是誰、牌譜連結、怎麼在群裡作答。
 * LINE 文字指令與 Discord 斜線指令共用的解析、讀取與回覆文字。
 *
 *   LINE    /每日一題（也接受 /今日一題、全形 ／）
 *   Discord /每日一題（公開回覆）
 *
 * 題目跟當天 Threads／IG 貼文同一題：用每日小觀念已經在用的 conceptDaily/threadsToday.ts（跟每日草稿同一個
 * ThreadsGenerator.pickFor；題庫是模擬瓦讀好的那一份）。這裡不選題、不改題，只把「今天是哪一題」說出來：
 *   - 問題那一句跟貼文第一行同一句；
 *   - 牌譜連結只到出題的那一刻（#records=…&upto=…&seat=…，網站會藏起後面的派票、結果與角色）；
 *   - 貼文已經發出去、網址知道時附 Threads 連結；
 *   - 題號（圖上也有）可以直接拿去 /模擬 作答。
 * 回覆沒有任何人的名字。讀到的結果在記憶體放 10 分鐘（讀不到的放 1 分鐘），不寫檔、不寫 log。
 */

import type { Role } from '@avalon/shared';
import { taipeiNow } from '../conceptDaily/schedule';
import { fetchThreadsInputs, threadsToday, type ThreadsInputs } from '../conceptDaily/threadsToday';
import type { ThreadsToday } from '../conceptDaily/plan';
import type { SimBank } from '../simulation/bank';
import { ROLE_ZH } from '../simulation/commands';
import { SIM_CONFIG } from '../simulation/config';
import { getSimBankLoader } from '../simulation/index';

export type DailyQuestionPlatform = 'line' | 'discord';

export { DAILY_QUESTION_HELP_TEXT, DAILY_QUESTION_USAGE } from './usage';

export const DAILY_QUESTION_UNAVAILABLE_TEXT = '每日一題暫時讀不到，請稍後再打一次 /每日一題。';
export const DAILY_QUESTION_LOADING_TEXT = '今天的題目還在準備，請過一下再打一次 /每日一題。';

const TEXT_RE = /^\/\s*(?:每日一題|今日一題|每日一题|今日一题)(?:\s|$)/u;

/** "/每日一題"、"／今日一題" → true；後面要是結尾或空白，所以「/每日一題好難」仍是一般聊天。 */
export function parseDailyQuestionText(text: string): boolean {
  return TEXT_RE.test((text ?? '').normalize('NFKC').trim());
}

/** 是不是每日一題指令（意見主題計數要略過）。 */
export function isDailyQuestionCommandText(text: string): boolean {
  return parseDailyQuestionText(text);
}

/** 今天這一題要說出來的部分（沒有名字、沒有答案）。 */
export interface DailyQuestion {
  /** 台北日期 YYYY-MM-DD。 */
  date: string;
  /** 題號，跟模擬瓦、Threads 圖上的同一個（K7Q2M-3-5、K7Q2M-A）。 */
  exerciseId: string;
  /** 一句話的問題（貼文第一行那一句）；舊資料沒有時 null。 */
  question: string | null;
  /** 視角的座位（1–10，10 = 0家）與角色。 */
  seat: number;
  role: Role;
  /** 刺殺題（作答用 /刺）。 */
  assassin: boolean;
  /** 牌譜連結（只到出題那一刻）；網站上沒有這一局就 null。 */
  recordUrl: string | null;
  /** 當天的 Threads 貼文（已經發出去、網址知道時）。 */
  threadsUrl?: string;
}

export type DailyQuestionLoad =
  | { kind: 'found'; question: DailyQuestion }
  /** 今天沒有題目（系列還沒開始、那天沒選到題）。 */
  | { kind: 'none'; date: string }
  /** 題庫讀不到。 */
  | { kind: 'unavailable' }
  /** 等太久（題庫還在讀、GitHub 很慢）：請他再打一次。 */
  | { kind: 'loading' };

const WEEKDAY_ZH = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'] as const;

/** "2026-11-25" → "11/25 週三"。 */
export function dateLabel(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  const weekday = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
  return `${Number(m[2])}/${Number(m[3])} ${WEEKDAY_ZH[weekday]}`;
}

/** 座位的寫法：N家，第十個座位寫 0家。 */
export function seatName(seat: number): string {
  return `${seat === 10 ? 0 : seat}家`;
}

/** conceptDaily/threadsToday.ts 的結果 → 這裡要說的部分。 */
export function dailyQuestionOf(date: string, today: ThreadsToday): DailyQuestion {
  return {
    date,
    exerciseId: today.exerciseId,
    question: today.question ?? null,
    seat: today.exercise.seat,
    role: today.exercise.role,
    assassin: today.exercise.round === null,
    recordUrl: today.recordUrl,
    ...(today.threadsUrl ? { threadsUrl: today.threadsUrl } : {}),
  };
}

/** 「在這裡作答」那一行：照平台的指令寫法；模擬瓦沒開時不寫。 */
function answerHint(q: DailyQuestion, platform: DailyQuestionPlatform): string {
  if (platform === 'discord') {
    return q.assassin
      ? `在這裡作答：/模擬 題號:${q.exerciseId} → /刺 座位:幾家 → /公布 對答案`
      : `在這裡作答：/模擬 題號:${q.exerciseId} → /派 隊伍:座位 → /公布 對答案`;
  }
  return q.assassin
    ? `在這裡作答：/模擬 ${q.exerciseId} → /刺 座位 → /公布 對答案`
    : `在這裡作答：/模擬 ${q.exerciseId} → /派 座位（例 /派 469）→ /公布 對答案`;
}

/**
 * 今天這一題的回覆：標題（日期）、問題、你是誰＋題號、牌譜連結、Threads 連結（有才寫）、怎麼在這裡作答。
 * `simEnabled`：模擬瓦開著才寫作答那一行。
 */
export function formatDailyQuestion(q: DailyQuestion, platform: DailyQuestionPlatform, opts: { simEnabled?: boolean } = {}): string {
  const lines = [`📌 阿瓦隆每日一題（${dateLabel(q.date)}）`];
  if (q.question) lines.push(q.question);
  lines.push(`你是 ${seatName(q.seat)} ${ROLE_ZH[q.role]}｜題號 ${q.exerciseId}`);
  lines.push(q.recordUrl ? `牌譜（只到出題那一刻）：${q.recordUrl}` : '牌譜：網站上沒有這一局的牌譜頁');
  if (q.threadsUrl) lines.push(`Threads 貼文：${q.threadsUrl}`);
  if (opts.simEnabled ?? true) lines.push(answerHint(q, platform));
  return lines.join('\n');
}

/** 今天沒有題目時的回覆。 */
export function formatNoDailyQuestion(date: string, opts: { simEnabled?: boolean } = {}): string {
  const tail = (opts.simEnabled ?? true) ? '想練習可以打 /模擬 今天（照每週主題出一題）。' : '';
  return `今天（${dateLabel(date)}）沒有每日一題。${tail}`;
}

/** 讀取結果 → 回覆文字。 */
export function formatDailyQuestionLoad(load: DailyQuestionLoad, platform: DailyQuestionPlatform, opts: { simEnabled?: boolean } = {}): string {
  switch (load.kind) {
    case 'found':
      return formatDailyQuestion(load.question, platform, opts);
    case 'none':
      return formatNoDailyQuestion(load.date, opts);
    case 'loading':
      return DAILY_QUESTION_LOADING_TEXT;
    case 'unavailable':
      return DAILY_QUESTION_UNAVAILABLE_TEXT;
  }
}

// ─── 讀取（題庫＋當天的輸入），結果放記憶體 ─────────────────────────────────────

export interface DailyQuestionDeps {
  bank?: () => Promise<Pick<SimBank, 'games' | 'byId' | 'records'> | null>;
  inputs?: (date: string) => Promise<ThreadsInputs>;
  now?: () => number;
}

/** 讀到題目（或確定今天沒有）放多久；讀不到放多久。 */
export const DAILY_QUESTION_TTL_MS = 10 * 60_000;
export const DAILY_QUESTION_RETRY_MS = 60_000;
/** 一次回覆最多等多久：LINE 要很快回 200，Discord 已經 defer 可以等久一點。 */
export const DAILY_QUESTION_WAIT_MS: Record<DailyQuestionPlatform, number> = { line: 4000, discord: 12_000 };

type Settled = Exclude<DailyQuestionLoad, { kind: 'loading' }>;

let cache: { date: string; at: number; value: Settled } | null = null;
let inflight: { date: string; promise: Promise<Settled> } | null = null;

/** 測試用：清掉記憶體裡的結果。 */
export function __resetDailyQuestionForTests(): void {
  cache = null;
  inflight = null;
}

async function compute(date: string, deps: DailyQuestionDeps): Promise<Settled> {
  try {
    const bank = await (deps.bank ?? ((): Promise<SimBank | null> => getSimBankLoader().get()))();
    if (!bank) return { kind: 'unavailable' };
    const inputs = await (deps.inputs ?? ((d: string): Promise<ThreadsInputs> => fetchThreadsInputs(d)))(date);
    const today = threadsToday(bank, date, inputs);
    return today ? { kind: 'found', question: dailyQuestionOf(date, today) } : { kind: 'none', date };
  } catch (err) {
    // 只寫錯誤種類（不寫內容）。
    console.warn(`[daily-question] loading failed (${err instanceof Error ? err.name : typeof err})`);
    return { kind: 'unavailable' };
  }
}

/**
 * 今天（台北日期）的每日一題。不丟錯。同一天同時只讀一次；`waitMs` 內沒讀完回 loading，背景繼續讀，下一次打就有。
 */
export async function loadDailyQuestion(deps: DailyQuestionDeps = {}, waitMs = 0): Promise<DailyQuestionLoad> {
  const now = (deps.now ?? Date.now)();
  const date = taipeiNow(now).date;
  if (cache && cache.date === date) {
    const ttl = cache.value.kind === 'unavailable' ? DAILY_QUESTION_RETRY_MS : DAILY_QUESTION_TTL_MS;
    if (now - cache.at < ttl) return cache.value;
  }
  if (!inflight || inflight.date !== date) {
    const promise = compute(date, deps).then((value) => {
      cache = { date, at: (deps.now ?? Date.now)(), value };
      if (inflight?.promise === promise) inflight = null;
      return value;
    });
    inflight = { date, promise };
  }
  const pending = inflight.promise;
  if (waitMs <= 0) return pending;
  return new Promise<DailyQuestionLoad>((resolve) => {
    const timer = setTimeout(() => resolve({ kind: 'loading' }), waitMs);
    void pending.then((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

/** /每日一題 的回覆文字。不丟錯。 */
export async function answerDailyQuestion(platform: DailyQuestionPlatform, deps: DailyQuestionDeps = {}): Promise<string> {
  const load = await loadDailyQuestion(deps, DAILY_QUESTION_WAIT_MS[platform]);
  return formatDailyQuestionLoad(load, platform, { simEnabled: SIM_CONFIG.commandsEnabled });
}

/** 打字的每日一題指令 → 回覆文字；不是這個指令時 null。 */
export async function answerDailyQuestionTextCommand(
  text: string,
  platform: DailyQuestionPlatform = 'line',
  deps: DailyQuestionDeps = {},
): Promise<string | null> {
  if (!parseDailyQuestionText(text)) return null;
  return answerDailyQuestion(platform, deps);
}
