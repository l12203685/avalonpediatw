/**
 * Threads 每日出題（2026-11-17）— 把計畫、存下來的草稿和題庫接起來，產生一天的草稿。
 *
 * 已經產生過的日子以存下來的檔案為準（題號和 ChatGPT 填的第一則留言都保留），
 * 所以題庫或牌譜連結之後更新，昨天貼出去的題目和今天公布的答案還是對得上。
 */

import type { SimGame } from '../simulation/scenario';
import type { PoolName } from './plan';
import { buildDraft, pickView, type PickView, type ThreadsDraft } from './draft';
import { THREADS_START_DATE, addDays, aloneFor, dayNumber, buildCandidates, continuationOf, exerciseIdOfPick, pickForDate, themeOf, weekdayOf, type ThreadsBank, type ThreadsPick } from './plan';

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
   * 這一天真的有貼文嗎（自動發佈：threads-state 有這一天的貼文記錄）。給了的話，只有昨天真的有貼文，
   * 今天才引用昨天、附昨天的答案、週四／週六才接昨天那一局；昨天沒有貼文，今天就是獨立的第一篇。不給＝起始日以後都當作有。
   */
  hasPost?: (date: string) => boolean;
  /**
   * 站長自己選的題（日期 → 題號，例如 `Y39DE-1-5`；來源是 commit 進 repo 的 threads_picks.json）。
   * 存下來（已經發出去）的那一天不受影響；選的題不是那天主題能出的就忽略、照計畫，原因寫進 `warnings`。
   */
  pickOverride?: (date: string) => string | null;
  /**
   * 貼文 A 的範本（站長在主控台改的「貼文格式（每天共用）」，同步進 threads_template.json；template.ts）。
   * 不給＝內建格式。這一天套不下 500 字就改用內建格式，原因寫進 `warnings`。
   */
  postTemplate?: string;
}

/** 每個星期幾可以用哪些候選池（週三、週五的池子是兩題一組，取第一題）。 */
const OVERRIDE_POOLS: Record<number, readonly ('assassin' | 'percival' | 'wedThu' | 'wed' | 'thu' | 'friSat' | 'fri' | 'sat' | 'final')[]> = {
  1: ['assassin'],
  2: ['percival'],
  3: ['wedThu', 'wed'],
  4: ['thu'],
  5: ['friSat', 'fri'],
  6: ['sat'],
  0: ['final'],
};

export class ThreadsGenerator {
  private readonly candidates;
  private readonly picks = new Map<string, ThreadsPick | null>();
  /** 選題被忽略的原因（給 CI 的摘要看）。 */
  readonly warnings: string[] = [];

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

  /** 題庫的局（題庫代號 → games[] 的索引）：選局頁的牌譜表一局一列。 */
  gameIndex(): ReadonlyMap<string, number> {
    return this.deps.bank.byId;
  }

  /**
   * 站長選局頁：這一天可以選的題目（跟 pickOverride 同一套池子，同一局只列一次：能連著打的優先）。
   * 列出來的題號交給 pickOverride 一定接受。
   */
  optionsFor(date: string): ThreadsOption[] {
    const out: ThreadsOption[] = [];
    const seen = new Set<string>();
    for (const pool of OVERRIDE_POOLS[weekdayOf(date)] ?? []) {
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

  /** 這一天有沒有一篇真的貼文可以接（起始日以後，而且 hasPost 說有）。 */
  private posted(date: string): boolean {
    if (dayNumber(date) < dayNumber(this.deps.startDate ?? THREADS_START_DATE)) return false;
    return this.deps.hasPost ? this.deps.hasPost(date) : true;
  }

  /** 這一天的題目：存下來的優先；延續的日子跟著前一天實際的那一局（前一天真的有貼文才接）；其他照計畫。 */
  pickFor(date: string): ThreadsPick | null {
    if (this.picks.has(date)) return this.picks.get(date) ?? null;
    let pick: ThreadsPick | null = null;
    const saved = this.deps.readSaved(date);
    if (saved?.pick && this.gameOf(saved.pick.gameId)) pick = saved.pick;
    if (!pick && this.deps.pickOverride) {
      const wanted = this.deps.pickOverride(date);
      if (wanted) {
        pick = this.resolveOverride(date, wanted);
        if (!pick) this.warnings.push(`${date}：選的題 ${wanted} 不是這天主題能出的題，改照計畫`);
      }
    }
    if (!pick) {
      const theme = themeOf(weekdayOf(date));
      let prev: ThreadsPick | null = null;
      const canContinue = !!theme.continues && theme.round !== undefined && this.posted(addDays(date, -1));
      if (canContinue && theme.round !== undefined) {
        prev = this.pickFor(addDays(date, -1));
        const prevGame = prev && prev.kind === 'tail' ? this.gameOf(prev.gameId) : null;
        if (prevGame) pick = continuationOf(prevGame.game, theme.round);
      }
      if (!pick) pick = pickForDate(this.deps.bank, date, this.candidates);
      // 計畫裡延續的是另一局（前一天實際貼的不是計畫那一局），或前一天沒有貼文可接：改出獨立的題目。
      if (pick?.continues && (!canContinue || (prev && pick.gameId !== prev.gameId))) pick = aloneFor(this.deps.bank, date, this.candidates);
    }
    this.picks.set(date, pick);
    return pick;
  }

  /** 題號 → 這一天能出的題；週四、週六先看是不是延續前一天同一局。 */
  private resolveOverride(date: string, exerciseId: string): ThreadsPick | null {
    const wd = weekdayOf(date);
    const theme = themeOf(wd);
    const gameId = exerciseId.split('-')[0];
    const g = this.gameOf(gameId);
    if (!g) return null;
    if (theme.continues && theme.round !== undefined && this.posted(addDays(date, -1))) {
      const prev = this.pickFor(addDays(date, -1));
      if (prev && prev.gameId === gameId) {
        const c = continuationOf(g.game, theme.round);
        if (c && exerciseIdOfPick(c, g.game) === exerciseId) return c;
      }
    }
    for (const pool of OVERRIDE_POOLS[wd] ?? []) {
      for (const cand of this.candidates[pool]) {
        const p = cand.picks[0];
        // 這些池子的第一題都不是延續題（週三、週五的第一題；週四、週六的獨立題）。
        if (p.gameId === gameId && exerciseIdOfPick(p, g.game) === exerciseId) return p;
      }
    }
    return null;
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
    // 第一天（和之前），或昨天沒有真的貼文：A 只有今天的題目（獨立的一篇，不引用、不附昨天的答案）。
    const first = dayNumber(date) <= dayNumber(this.deps.startDate ?? THREADS_START_DATE) || !this.posted(yDate);
    const yPick = first ? null : this.pickFor(yDate);
    const yView = yPick ? this.viewOf(yPick) : null;
    let earlier: PickView | undefined;
    if (yPick?.continues && dayNumber(yDate) > dayNumber(this.deps.startDate ?? THREADS_START_DATE) && this.posted(addDays(date, -2))) {
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
      ...(this.deps.postTemplate !== undefined ? { template: this.deps.postTemplate } : {}),
    });
    if (draft.templateWarning && !this.warnings.includes(`${date}：${draft.templateWarning}`)) this.warnings.push(`${date}：${draft.templateWarning}`);
    // ChatGPT 已經填的第一則留言保留。
    const saved = this.deps.readSaved(date);
    if (saved?.firstComment?.text && saved.pick?.gameId === pick.gameId) draft.firstComment.text = saved.firstComment.text;
    return draft;
  }
}

/** 站長選局頁的一個選項：這一天的題目，週三、週五能連著打時附上隔天的。 */
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
