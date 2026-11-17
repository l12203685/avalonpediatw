/**
 * Threads 每日出題（2026-11-17）— 把計畫、存下來的草稿和題庫接起來，產生一天的草稿。
 *
 * 已經產生過的日子以存下來的檔案為準（題號和 ChatGPT 填的第一則留言都保留），
 * 所以題庫或牌譜連結之後更新，昨天貼出去的題目和今天公布的答案還是對得上。
 */

import type { SimGame } from '../simulation/scenario';
import { buildDraft, pickView, type PickView, type ThreadsDraft } from './draft';
import {
  THREADS_POSTED,
  THREADS_START_DATE,
  addDays,
  aloneFor,
  buildCandidates,
  continuationOf,
  dayNumber,
  exerciseIdOfPick,
  pickForDate,
  poolsForWeekday,
  themeOf,
  weekdayOf,
  type PoolName,
  type ThreadsBank,
  type ThreadsPick,
} from './plan';

export interface GenerateBank extends ThreadsBank {
  byId: ReadonlyMap<string, number>;
}

export interface GenerateDeps {
  bank: GenerateBank;
  /** 百科文章 id → 標題。 */
  titles: ReadonlyMap<string, string>;
  /** 存下來的草稿（沒有就 null）。 */
  readSaved: (date: string) => ThreadsDraft | null;
  /** 第一篇貼文的日期（預設 THREADS_START_DATE）：這一天沒有昨天的答案，之前的日子不產生。 */
  startDate?: string;
  /**
   * 站長在選局頁選的題目（日期 → 題號）。比存下來的草稿優先（還沒貼出去的日子可以改），
   * 但 THREADS_POSTED 裡已經貼出去的日子不能改。呼叫端只傳還沒貼出去的日子。
   */
  overrides?: ReadonlyMap<string, string>;
}

/** 站長可以選的一個選項：這一天的題目，週三、週五能連著打時附上隔天的。 */
export interface ThreadsOption {
  exerciseId: string;
  pick: ThreadsPick;
  pool: PoolName;
  /** 選了這一局，隔天（週四 3-5、週六 4-5）自動接同一局。 */
  chained: boolean;
  /** 隔天接著的題號（chained 才有）。 */
  nextExerciseId?: string;
  /** 有網站牌譜頁。 */
  linked: boolean;
  /** 視角：0 忠臣／派西、1 梅林、2 紅方（刺殺題一律 0）。 */
  tier: number;
}

export class ThreadsGenerator {
  private readonly candidates;
  private readonly picks = new Map<string, ThreadsPick | null>();

  constructor(private readonly deps: GenerateDeps) {
    this.candidates = buildCandidates(deps.bank);
  }

  gameOf(gameId: string): { game: SimGame; index: number } | null {
    const index = this.deps.bank.byId.get(gameId);
    return index === undefined ? null : { game: this.deps.bank.games[index], index };
  }

  recordIdOf(gameId: string): string | undefined {
    const g = this.gameOf(gameId);
    return g ? this.deps.bank.records?.get(g.index) : undefined;
  }

  /** 這一天可以選的題目（照主題的池子，同一局只列一次：能連著打的優先）。 */
  optionsFor(date: string): ThreadsOption[] {
    const out: ThreadsOption[] = [];
    const seen = new Set<string>();
    for (const pool of poolsForWeekday(weekdayOf(date))) {
      for (const c of this.candidates[pool]) {
        const first = c.picks[0];
        const g = this.gameOf(first.gameId);
        if (!g || seen.has(first.gameId)) continue;
        seen.add(first.gameId);
        const next = c.picks[1];
        out.push({
          exerciseId: exerciseIdOfPick(first, g.game),
          pick: first,
          pool,
          chained: !!next,
          ...(next ? { nextExerciseId: exerciseIdOfPick(next, g.game) } : {}),
          linked: c.linked,
          tier: c.tier,
        });
      }
    }
    return out;
  }

  /** 題號 → 這一天的選項；不在這一天的池子裡（主題不合）就 null。 */
  optionFor(date: string, exerciseId: string): ThreadsOption | null {
    return this.optionsFor(date).find((o) => o.exerciseId === exerciseId) ?? null;
  }

  /** 站長選的題號沒有用上的日子（主題不合或題庫裡沒有）：呼叫端拿來警告。 */
  readonly rejectedOverrides = new Map<string, string>();

  private chosenFor(date: string): ThreadsPick | null {
    const id = THREADS_POSTED[date] ?? this.deps.overrides?.get(date);
    if (!id) return null;
    const opt = this.optionFor(date, id);
    if (opt) return opt.pick;
    // 已經貼出去的題目也可能是照計畫選的（池子規則之後改了）：從當天的計畫找。
    const planned = pickForDate(this.deps.bank, date, this.candidates);
    const pg = planned ? this.gameOf(planned.gameId) : null;
    if (planned && pg && exerciseIdOfPick(planned, pg.game) === id) return planned;
    this.rejectedOverrides.set(date, id);
    return null;
  }

  /** 這一天的題目：已經貼出去的、站長選的、存下來的依序優先；延續的日子跟著前一天實際的那一局；其他照計畫。 */
  pickFor(date: string): ThreadsPick | null {
    if (this.picks.has(date)) return this.picks.get(date) ?? null;
    let pick: ThreadsPick | null = this.chosenFor(date);
    const saved = pick ? null : this.deps.readSaved(date);
    if (saved?.pick && this.gameOf(saved.pick.gameId)) pick = saved.pick;
    if (!pick) {
      const theme = themeOf(weekdayOf(date));
      let prev: ThreadsPick | null = null;
      if (theme.continues && theme.round !== undefined) {
        prev = this.pickFor(addDays(date, -1));
        const prevGame = prev && prev.kind === 'tail' ? this.gameOf(prev.gameId) : null;
        if (prevGame) pick = continuationOf(prevGame.game, theme.round);
      }
      if (!pick) pick = pickForDate(this.deps.bank, date, this.candidates);
      // 計畫裡延續的是另一局（前一天實際貼的不是計畫那一局）：改出獨立的題目。
      if (pick?.continues && prev && pick.gameId !== prev.gameId) pick = aloneFor(this.deps.bank, date, this.candidates);
    }
    this.picks.set(date, pick);
    return pick;
  }

  viewOf(pick: ThreadsPick): PickView | null {
    const g = this.gameOf(pick.gameId);
    return g ? pickView(g.game, pick) : null;
  }

  /** 一天的草稿；選不到題目回 null。`image` = 圖檔名（呼叫端寫檔）。 */
  draftFor(date: string, opts: { image?: string } = {}): ThreadsDraft | null {
    const pick = this.pickFor(date);
    const today = pick ? this.viewOf(pick) : null;
    if (!pick || !today) return null;

    const yDate = addDays(date, -1);
    // 第一天（和之前）沒有昨天的貼文：A 只有今天的題目。
    const first = dayNumber(date) <= dayNumber(this.deps.startDate ?? THREADS_START_DATE);
    const yPick = first ? null : this.pickFor(yDate);
    const yView = yPick ? this.viewOf(yPick) : null;
    let earlier: PickView | undefined;
    if (yPick?.continues && dayNumber(yDate) > dayNumber(this.deps.startDate ?? THREADS_START_DATE)) {
      const ePick = this.pickFor(addDays(date, -2));
      if (ePick && ePick.gameId === yPick.gameId) earlier = this.viewOf(ePick) ?? undefined;
    }
    const draft = buildDraft({
      date,
      today,
      todayRecordId: this.recordIdOf(pick.gameId),
      yesterday: yPick && yView ? { date: yDate, pv: yView, earlier, recordId: this.recordIdOf(yPick.gameId) } : null,
      titles: this.deps.titles,
      ...(opts.image ? { image: opts.image } : {}),
    });
    // ChatGPT 已經填的第一則留言保留。
    const saved = this.deps.readSaved(date);
    if (saved?.firstComment?.text && saved.pick?.gameId === pick.gameId) draft.firstComment.text = saved.firstComment.text;
    return draft;
  }
}
