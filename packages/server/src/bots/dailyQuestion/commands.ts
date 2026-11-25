/**
 * /每日一題（2026-11-25）— 今天的「阿瓦隆每日一題」：一句話的問題、你是誰、牌譜連結、怎麼在群裡作答。
 * LINE 文字指令與 Discord 斜線指令共用的解析、讀取與回覆文字。
 *
 *   LINE    /每日一題（也接受 /今日一題、全形 ／）；/每日一題 昨天 ＝ 昨天的題目和答案（2026-11-25 第二批）
 *   Discord /每日一題（公開回覆）；選項 哪一天:昨天
 *
 * 題目跟當天 Threads／IG 貼文同一題：用每日小觀念已經在用的 conceptDaily/threadsToday.ts（跟每日草稿同一個
 * ThreadsGenerator.pickFor；題庫是模擬瓦讀好的那一份）。這裡不選題、不改題，只把「今天是哪一題」說出來：
 *   - 問題那一句跟貼文第一行同一句；
 *   - 牌譜連結只到出題的那一刻（#records=…&upto=…&seat=…，網站會藏起後面的派票、結果與角色）；
 *   - 貼文已經發出去、網址知道時附 Threads 連結；
 *   - 題號（圖上也有）可以直接拿去 /模擬 作答。
 * 回覆沒有任何人的名字。讀到的結果在記憶體放 10 分鐘（讀不到的放 1 分鐘），不寫檔、不寫 log。
 *
 * /每日一題 昨天：昨天那一題＋答案（真人怎麼做、結果、角色、整局牌譜），讓在群裡作答的人對答案。答案的幾行就是
 * 隔天貼文裡「昨天的答案」那一段（threads/draft.ts answerVariants，這裡只讀不改），所以規則也一樣：
 * 今天的題目接昨天同一局時，只講真人派了什麼和任務結果，幾好幾壞和角色明天才講。今天的題目永遠不附答案。
 */

import type { Role } from '@avalon/shared';
import { taipeiNow } from '../conceptDaily/schedule';
import { fetchThreadsInputs, threadsGenerator, threadsToday, type ThreadsInputs } from '../conceptDaily/threadsToday';
import type { ThreadsToday } from '../conceptDaily/plan';
import type { SimBank } from '../simulation/bank';
import { ROLE_ZH } from '../simulation/commands';
import { SIM_CONFIG } from '../simulation/config';
import { getSimBankLoader } from '../simulation/index';
import { answerVariants, hookQuestion, type PickView } from '../threads/draft';
import { addDays, exerciseIdOfPick } from '../threads/plan';

export type DailyQuestionPlatform = 'line' | 'discord';

import { DAILY_QUESTION_USAGE } from './usage';

export { DAILY_QUESTION_HELP_TEXT, DAILY_QUESTION_USAGE } from './usage';

export const DAILY_QUESTION_UNAVAILABLE_TEXT = '每日一題暫時讀不到，請稍後再打一次 /每日一題。';
export const DAILY_QUESTION_LOADING_TEXT = '今天的題目還在準備，請過一下再打一次 /每日一題。';

export const DAILY_QUESTION_YESTERDAY_UNAVAILABLE_TEXT = '昨天的答案暫時讀不到，請稍後再打一次 /每日一題 昨天。';
export const DAILY_QUESTION_YESTERDAY_LOADING_TEXT = '昨天的答案還在準備，請過一下再打一次 /每日一題 昨天。';
/** 後面接了看不懂的字（例：/每日一題 答案、/每日一題 前天）。固定文字，不回顯打的字。 */
export const DAILY_QUESTION_USAGE_HINT = '用法：/每日一題（今天的題目）、/每日一題 昨天（昨天的題目和答案）。今天的答案明天才看得到。';

export type DailyQuestionDay = 'today' | 'yesterday';
/** 打字的指令讀出來的結果：哪一天，或後面接了看不懂的字（回用法）。 */
export type DailyQuestionCommand = { day: DailyQuestionDay } | { usage: true };

const TEXT_RE = /^\/\s*(?:每日一題|今日一題|每日一题|今日一题)(.*)$/su;
const DAY_WORDS: Readonly<Record<string, DailyQuestionDay>> = { 今天: 'today', 今日: 'today', 昨天: 'yesterday', 昨日: 'yesterday' };

/** 「今天」「昨天」（Discord 的選項值、LINE 指令後面的字）→ 哪一天；空的 = 今天；看不懂 = null。 */
export function dailyQuestionDayOf(word: string | null | undefined): DailyQuestionDay | null {
  const w = (word ?? '').normalize('NFKC').trim();
  return w === '' ? 'today' : DAY_WORDS[w] ?? null;
}

/**
 * "/每日一題"、"／今日一題"、"/每日一題 今天" → 今天；"/每日一題 昨天"（"昨日"、不空格的 "/每日一題昨天" 也可以）→ 昨天；
 * 空白後面接了別的字 → { usage }。指令字後面直接接別的字（「/每日一題好難」）是一般聊天 → null。
 */
export function parseDailyQuestionCommand(text: string): DailyQuestionCommand | null {
  const m = TEXT_RE.exec((text ?? '').normalize('NFKC').trim());
  if (!m) return null;
  const day = dailyQuestionDayOf(m[1]);
  if (day) return { day };
  return /^\s/u.test(m[1]) ? { usage: true } : null;
}

/** 是不是每日一題指令（含後面接了看不懂的字、會回用法的）。 */
export function parseDailyQuestionText(text: string): boolean {
  return parseDailyQuestionCommand(text) !== null;
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

// ─── 昨天的題目和答案 ────────────────────────────────────────────────────────

/** 昨天那一題要說出來的部分（沒有名字）。 */
export interface YesterdayAnswer {
  /** 昨天的台北日期 YYYY-MM-DD。 */
  date: string;
  exerciseId: string;
  /** 一句話的問題（昨天貼文第一行那一句）。 */
  question: string;
  seat: number;
  role: Role;
  /**
   * 答案的幾行：真人怎麼做和結果、三個選項各幾好幾壞、角色與整局結果、整局牌譜連結。
   * 今天接昨天同一局時只有真人派了什麼和任務結果，加一行「幾好幾壞和角色明天公布」。
   */
  lines: string[];
  /** 今天接昨天同一局（答案只講了一半）。 */
  held: boolean;
}

export type YesterdayLoad =
  | { kind: 'found'; answer: YesterdayAnswer }
  /** 昨天沒有題目。 */
  | { kind: 'none'; date: string }
  | { kind: 'unavailable' }
  | { kind: 'loading' };

/** 隔天貼文那一段答案裡，群裡不放的行：開頭的「[昨天 … 的答案]」（這裡有自己的標題）、純邏輯的理由（太長）。 */
const ANSWER_LINE_SKIP = /^(?:\[昨天 .* 的答案\]|理由（純邏輯）)/u;

/**
 * 昨天（`date` 的前一天）那一題和它的答案；昨天沒有題目 → null。
 * 選題跟 /每日一題 同一套（threadsGenerator）；答案的幾行來自隔天貼文的「昨天的答案」（answerVariants 最完整的那一版）。
 * 今天的題目跟昨天同一局 → 不公布幾好幾壞和角色（跟貼文同一條規則，免得把今天的題目說破）。
 */
export function yesterdayAnswerOf(
  bank: Pick<SimBank, 'games' | 'byId' | 'records'>,
  date: string,
  inputs: ThreadsInputs,
): YesterdayAnswer | null {
  const gen = threadsGenerator(bank, inputs);
  const yDate = addDays(date, -1);
  const yPick = gen.pickFor(yDate);
  const yView = yPick ? gen.viewOf(yPick) : null;
  if (!yPick || !yView) return null;
  const today = gen.pickFor(date);
  const held = !!today && today.gameId === yPick.gameId;
  let earlier: PickView | undefined;
  if (yPick.continues) {
    const before = gen.pickFor(addDays(yDate, -1));
    if (before && before.gameId === yPick.gameId) earlier = gen.viewOf(before) ?? undefined;
  }
  const full = answerVariants({ yesterday: yView, earlier, todayContinues: held, recordId: gen.recordIdOf(yPick.gameId) })[0];
  return {
    date: yDate,
    exerciseId: exerciseIdOfPick(yPick, yView.game),
    question: hookQuestion(yPick),
    seat: yPick.seat,
    role: yView.game.seatRoles[yPick.seat - 1],
    lines: full.filter((line) => !ANSWER_LINE_SKIP.test(line)),
    held,
  };
}

/** 昨天的題目和答案的回覆：標題（昨天的日期）、問題、你是誰＋題號、答案的幾行、今天的題目怎麼看。 */
export function formatYesterdayAnswer(a: YesterdayAnswer): string {
  return [
    `📌 阿瓦隆每日一題・昨天（${dateLabel(a.date)}）的答案`,
    a.question,
    `你是 ${seatName(a.seat)} ${ROLE_ZH[a.role]}｜題號 ${a.exerciseId}`,
    ...a.lines,
    `今天的題目：${DAILY_QUESTION_USAGE}`,
  ].join('\n');
}

/** 昨天沒有題目時的回覆。 */
export function formatNoYesterdayQuestion(date: string): string {
  return `昨天（${dateLabel(date)}）沒有每日一題。今天的題目：${DAILY_QUESTION_USAGE}`;
}

/** 讀取結果 → 回覆文字。 */
export function formatYesterdayLoad(load: YesterdayLoad): string {
  switch (load.kind) {
    case 'found':
      return formatYesterdayAnswer(load.answer);
    case 'none':
      return formatNoYesterdayQuestion(load.date);
    case 'loading':
      return DAILY_QUESTION_YESTERDAY_LOADING_TEXT;
    case 'unavailable':
      return DAILY_QUESTION_YESTERDAY_UNAVAILABLE_TEXT;
  }
}

// ─── 讀取（題庫＋當天的輸入），結果放記憶體 ─────────────────────────────────────

export interface DailyQuestionDeps {
  bank?: () => Promise<Pick<SimBank, 'games' | 'byId' | 'records'> | null>;
  /** `days`：狀態檔往回讀幾天（昨天的答案要 4 天，見 YESTERDAY_STATE_DAYS）。 */
  inputs?: (date: string, days?: number) => Promise<ThreadsInputs>;
  now?: () => number;
}

/** 昨天的答案要讀幾天的狀態檔：今天、昨天，加上昨天自己選題時看的前兩天。 */
export const YESTERDAY_STATE_DAYS = 4;

/** 讀到題目（或確定今天沒有）放多久；讀不到放多久。 */
export const DAILY_QUESTION_TTL_MS = 10 * 60_000;
export const DAILY_QUESTION_RETRY_MS = 60_000;
/** 一次回覆最多等多久：LINE 要很快回 200，Discord 已經 defer 可以等久一點。 */
export const DAILY_QUESTION_WAIT_MS: Record<DailyQuestionPlatform, number> = { line: 4000, discord: 12_000 };

/** 一種查詢（今天的題目／昨天的答案）在記憶體裡的結果：同一天同時只讀一次。 */
interface Slot<T> {
  cache: { date: string; at: number; value: T } | null;
  inflight: { date: string; promise: Promise<T> } | null;
}

type SettledToday = Exclude<DailyQuestionLoad, { kind: 'loading' }>;
type SettledYesterday = Exclude<YesterdayLoad, { kind: 'loading' }>;

const todaySlot: Slot<SettledToday> = { cache: null, inflight: null };
const yesterdaySlot: Slot<SettledYesterday> = { cache: null, inflight: null };

/** 測試用：清掉記憶體裡的結果。 */
export function __resetDailyQuestionForTests(): void {
  for (const slot of [todaySlot, yesterdaySlot] as Slot<unknown>[]) {
    slot.cache = null;
    slot.inflight = null;
  }
}

const defaultBank = (): Promise<SimBank | null> => getSimBankLoader().get();
const defaultInputs = (date: string, days?: number): Promise<ThreadsInputs> => fetchThreadsInputs(date, days ? { days } : {});

/** 只寫錯誤種類（不寫內容）。 */
function warnFailed(err: unknown): void {
  console.warn(`[daily-question] loading failed (${err instanceof Error ? err.name : typeof err})`);
}

async function compute(date: string, deps: DailyQuestionDeps): Promise<SettledToday> {
  try {
    const bank = await (deps.bank ?? defaultBank)();
    if (!bank) return { kind: 'unavailable' };
    const inputs = await (deps.inputs ?? defaultInputs)(date);
    const today = threadsToday(bank, date, inputs);
    return today ? { kind: 'found', question: dailyQuestionOf(date, today) } : { kind: 'none', date };
  } catch (err) {
    warnFailed(err);
    return { kind: 'unavailable' };
  }
}

async function computeYesterday(date: string, deps: DailyQuestionDeps): Promise<SettledYesterday> {
  try {
    const bank = await (deps.bank ?? defaultBank)();
    if (!bank) return { kind: 'unavailable' };
    const inputs = await (deps.inputs ?? defaultInputs)(date, YESTERDAY_STATE_DAYS);
    const yDate = addDays(date, -1);
    // 今天或昨天的狀態檔這次沒讀到（不是確定沒有）：今天是不是接昨天同一局不可信，先不公布，請他再打一次。
    if (inputs.unread?.has(date) || inputs.unread?.has(yDate)) return { kind: 'unavailable' };
    const answer = yesterdayAnswerOf(bank, date, inputs);
    return answer ? { kind: 'found', answer } : { kind: 'none', date: yDate };
  } catch (err) {
    warnFailed(err);
    return { kind: 'unavailable' };
  }
}

/** 同一天的結果放記憶體（讀不到的放短一點）；`waitMs` 內沒讀完回 loading，背景繼續讀，下一次打就有。 */
async function loadSlot<T extends { kind: string }>(
  slot: Slot<T>,
  run: (date: string, deps: DailyQuestionDeps) => Promise<T>,
  deps: DailyQuestionDeps,
  waitMs: number,
): Promise<T | { kind: 'loading' }> {
  const now = (deps.now ?? Date.now)();
  const date = taipeiNow(now).date;
  if (slot.cache && slot.cache.date === date) {
    const ttl = slot.cache.value.kind === 'unavailable' ? DAILY_QUESTION_RETRY_MS : DAILY_QUESTION_TTL_MS;
    if (now - slot.cache.at < ttl) return slot.cache.value;
  }
  if (!slot.inflight || slot.inflight.date !== date) {
    const promise = run(date, deps).then((value) => {
      slot.cache = { date, at: (deps.now ?? Date.now)(), value };
      if (slot.inflight?.promise === promise) slot.inflight = null;
      return value;
    });
    slot.inflight = { date, promise };
  }
  const pending = slot.inflight.promise;
  if (waitMs <= 0) return pending;
  return new Promise<T | { kind: 'loading' }>((resolve) => {
    const timer = setTimeout(() => resolve({ kind: 'loading' }), waitMs);
    void pending.then((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

/**
 * 今天（台北日期）的每日一題。不丟錯。同一天同時只讀一次；`waitMs` 內沒讀完回 loading，背景繼續讀，下一次打就有。
 */
export async function loadDailyQuestion(deps: DailyQuestionDeps = {}, waitMs = 0): Promise<DailyQuestionLoad> {
  return loadSlot(todaySlot, compute, deps, waitMs);
}

/** 昨天（台北日期的前一天）的題目和答案。不丟錯；記憶體的放法跟今天的題目一樣。 */
export async function loadYesterdayAnswer(deps: DailyQuestionDeps = {}, waitMs = 0): Promise<YesterdayLoad> {
  return loadSlot(yesterdaySlot, computeYesterday, deps, waitMs);
}

/** /每日一題（今天）與 /每日一題 昨天 的回覆文字。不丟錯。 */
export async function answerDailyQuestion(
  platform: DailyQuestionPlatform,
  deps: DailyQuestionDeps = {},
  day: DailyQuestionDay = 'today',
): Promise<string> {
  if (day === 'yesterday') return formatYesterdayLoad(await loadYesterdayAnswer(deps, DAILY_QUESTION_WAIT_MS[platform]));
  const load = await loadDailyQuestion(deps, DAILY_QUESTION_WAIT_MS[platform]);
  return formatDailyQuestionLoad(load, platform, { simEnabled: SIM_CONFIG.commandsEnabled });
}

/** 打字的每日一題指令 → 回覆文字（後面接了看不懂的字 → 用法）；不是這個指令時 null。 */
export async function answerDailyQuestionTextCommand(
  text: string,
  platform: DailyQuestionPlatform = 'line',
  deps: DailyQuestionDeps = {},
): Promise<string | null> {
  const cmd = parseDailyQuestionCommand(text);
  if (!cmd) return null;
  if ('usage' in cmd) return DAILY_QUESTION_USAGE_HINT;
  return answerDailyQuestion(platform, deps, cmd.day);
}
