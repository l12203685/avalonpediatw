/**
 * 每日小觀念（2026-11-18）— LINE 與 Discord 共用的那一層。
 *
 * 「第一則訊息」：開了小觀念的群組／頻道裡，每天起始時間（預設台北 06:00）以後第一個人講話，bot 就回那一則
 * （LINE 用那則訊息的 reply_token，不用 push 額度；Discord 回覆那一則）。每個群組一天一次：
 *   - 記憶體裡先標「處理中」，同一個群組同時來的第二則不會再發；
 *   - 真的送出去之後才記「今天發過」，並寫回狀態檔（store.ts，private repo 的 JSON），重啟後照樣知道今天發過；
 *     沒送出去就不記，下一則訊息再試。
 * 當天的卡算一次就存起來（plan.ts chooseDay），LINE 和 Discord 一定同一張；起始時間前 30 分鐘先算好（tick），
 * 第一則訊息來的時候卡還沒算好（例如伺服器剛被這則訊息叫醒、題庫還在讀），最多等 waitMs，等不到就這一則不發，
 * 卡在背景繼續算，下一則訊息再發。
 */

import type { SimBank } from '../simulation/bank';
import { STATS_SITE_URL } from '../stats/statsReplies';
import { conceptBank, type Concept } from '../threads/concepts';
import { conceptDailyConfig, conceptDailyEnabledFor, conceptStateRepoConfig, type ConceptDailyConfig, type ConceptPlatform } from './config';
import {
  CONCEPT_FEEDBACK_ACK,
  CONCEPT_FEEDBACK_USAGE,
  FeedbackRateLimiter,
  formatFeedbackForAdmin,
  parseFeedbackKeyword,
} from './feedback';
import { buildRecordIndexAsync, chooseDay, formatConceptMessage, type DayPlan, type RecordIndex } from './plan';
import { dailyKeyAt, prepareKeyAt } from './schedule';
import { ConceptStateStore, GitHubBackend, MemoryBackend, hashChatId, messageKey, sentKey } from './store';
import { fetchThreadsInputs, threadsToday, type ThreadsInputs } from './threadsToday';

export interface IncomingChatMessage {
  platform: ConceptPlatform;
  /** LINE 群組 id／Discord 頻道 id。 */
  chatId: string;
  userId?: string;
  text: string;
  /** 這則引用（回覆）的訊息 id：LINE quotedMessageId、Discord message reference。 */
  quotedMessageId?: string;
}

/** bot 要回的一則。 */
export interface ConceptReply {
  kind: 'daily' | 'feedback';
  text: string;
  /** 送出去了（有 bot 那一則的訊息 id 就給，引用回覆才認得）。 */
  delivered(messageId?: string): void;
  /** 沒送出去。 */
  failed(): void;
}

export interface ConceptDailyDeps {
  store: ConceptStateStore;
  /** 模擬瓦的題庫（讀不到是 null：只用沒寫前提的卡、連文章）。 */
  bank: () => Promise<SimBank | null>;
  threadsInputs?: (date: string) => Promise<ThreadsInputs>;
  concepts?: () => readonly Concept[];
  config?: () => ConceptDailyConfig;
  now?: () => number;
  site?: string;
  /** 回饋貼到管理員頻道；沒送出去回 false。 */
  feedbackSink?: (content: string) => Promise<boolean>;
  logger?: { warn: (m: string) => void };
}

export interface ConceptDailyStatus {
  line: boolean;
  discord: boolean;
  lineGroups: number;
  discordChannels: number;
  backend: string;
  stateLoaded: boolean;
  today: { date: string; cardId: string; source: string; link: string } | null;
  counts: { daily: number; dailyFailed: number; feedback: number; feedbackThrottled: number; feedbackStoreFailed: number };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  if (ms <= 0) return p;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      () => { clearTimeout(timer); resolve(null); },
    );
  });
}

export class ConceptDailyService {
  private readonly plans = new Map<string, Promise<DayPlan | null>>();
  private readonly inflight = new Set<string>();
  private readonly limiter = new FeedbackRateLimiter();
  private indexCache: { bank: SimBank; index: Promise<RecordIndex> } | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  readonly counts = { daily: 0, dailyFailed: 0, feedback: 0, feedbackThrottled: 0, feedbackStoreFailed: 0 };

  constructor(private readonly deps: ConceptDailyDeps) {}

  private cfg(): ConceptDailyConfig {
    return (this.deps.config ?? conceptDailyConfig)();
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private concepts(): readonly Concept[] {
    return (this.deps.concepts ?? ((): readonly Concept[] => conceptBank().concepts))();
  }

  private site(): string {
    return this.deps.site ?? STATS_SITE_URL;
  }

  private warn(m: string): void {
    (this.deps.logger ?? { warn: (x: string): void => console.warn(`[concept-daily] ${x}`) }).warn(m);
  }

  private card(id: string): Concept | undefined {
    return this.concepts().find((c) => c.id === id);
  }

  /** 卡片 → 對得上的牌譜（輪替才要；分段算、不擋 webhook，同一份題庫只算一次）。 */
  private indexFor(bank: SimBank): Promise<RecordIndex> {
    if (this.indexCache?.bank !== bank) this.indexCache = { bank, index: buildRecordIndexAsync(bank, this.concepts()) };
    return this.indexCache.index;
  }

  /** 這一天的小觀念：存過的優先；沒有就算一次（同時只算一次）並存起來。 */
  plan(date: string): Promise<DayPlan | null> {
    let p = this.plans.get(date);
    if (!p) {
      p = this.compute(date).catch((err: unknown) => {
        this.warn(`planning ${date} failed (${err instanceof Error ? err.message.slice(0, 80) : typeof err})`);
        this.plans.delete(date);
        return null;
      });
      this.plans.set(date, p);
      if (this.plans.size > 8) this.plans.delete(this.plans.keys().next().value as string);
    }
    return p;
  }

  private async compute(date: string): Promise<DayPlan | null> {
    await this.deps.store.ready();
    const saved = this.deps.store.get().days[date];
    if (saved && this.card(saved.cardId)) return saved;
    const concepts = this.concepts();
    const bank = await this.deps.bank();
    let threads = null;
    if (bank) {
      try {
        const inputs = await (this.deps.threadsInputs ?? ((d: string): Promise<ThreadsInputs> => fetchThreadsInputs(d)))(date);
        threads = threadsToday(bank, date, inputs);
      } catch (err) {
        this.warn(`today's Threads question unavailable, rotating (${err instanceof Error ? err.message.slice(0, 80) : typeof err})`);
      }
    }
    const history = Object.values(this.deps.store.get().days).filter((d) => d.date < date).map((d) => ({ date: d.date, cardId: d.cardId }));
    // 當天的 Threads 題目配得到卡就不用輪替的牌譜索引；配不到才算索引、輪替。
    let plan = threads ? chooseDay({ date, concepts, history, threads, index: new Map() }) : null;
    if (plan?.source !== 'threads') {
      const index: RecordIndex = bank ? await this.indexFor(bank) : new Map();
      plan = chooseDay({ date, concepts, history, threads: null, index });
    }
    if (!plan) return null;
    // 先到先贏：重讀合併時別人（重啟前的自己）已經寫了這一天，就用那一份。
    void this.deps.store.update((s) => {
      s.days[date] ??= plan;
    });
    return this.deps.store.get().days[date] ?? plan;
  }

  /** 每分鐘：快到起始時間就先算好今天的卡（不擋任何訊息）。 */
  start(intervalMs = 60_000): void {
    if (this.timer) return;
    const tick = (): void => {
      const cfg = this.cfg();
      if (!(cfg.lineEnabled && cfg.lineGroupIds.size) && !(cfg.discordEnabled && cfg.discordChannelIds.size)) return;
      const date = prepareKeyAt(this.now(), cfg.startMinute);
      if (date) void this.plan(date);
    };
    this.timer = setInterval(tick, intervalMs);
    this.timer.unref?.();
    tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 群組裡有人講話：要回的（回饋的確認、今天的小觀念），照順序。沒開的群組一律空的。不會丟錯。 */
  async handle(msg: IncomingChatMessage, opts: { waitMs?: number } = {}): Promise<ConceptReply[]> {
    try {
      const cfg = this.cfg();
      if (!conceptDailyEnabledFor(msg.platform, msg.chatId, cfg)) return [];
      const waitMs = opts.waitMs ?? 3000;
      if (!this.deps.store.isLoaded()) await withTimeout(this.deps.store.ready(), waitMs);
      const out: ConceptReply[] = [];
      if (cfg.feedbackEnabled) {
        const fb = this.feedbackReply(msg);
        if (fb) out.push(fb);
      }
      const daily = await this.dailyReply(msg, cfg, waitMs);
      if (daily) out.push(daily);
      return out;
    } catch (err) {
      this.warn(`handling a message failed (${err instanceof Error ? err.name : typeof err})`);
      return [];
    }
  }

  private async dailyReply(msg: IncomingChatMessage, cfg: ConceptDailyConfig, waitMs: number): Promise<ConceptReply | null> {
    const date = dailyKeyAt(this.now(), cfg.startMinute);
    if (!date) return null;
    const sk = sentKey(msg.platform, msg.chatId);
    if (this.deps.store.get().sent[sk] === date || this.inflight.has(sk)) return null;
    this.inflight.add(sk);
    let handedOut = false;
    try {
      const plan = await withTimeout(this.plan(date), waitMs);
      const card = plan ? this.card(plan.cardId) : undefined;
      // 等的時候另一則已經發了（例如重讀狀態檔發現重啟前發過）。
      if (!plan || !card || this.deps.store.get().sent[sk] === date) return null;
      const chat = hashChatId(msg.chatId);
      let settled = false;
      handedOut = true;
      return {
        kind: 'daily',
        text: formatConceptMessage(plan, card, this.site(), { feedbackHint: cfg.feedbackEnabled }),
        delivered: (messageId?: string): void => {
          if (settled) return;
          settled = true;
          this.inflight.delete(sk);
          this.counts.daily += 1;
          void this.deps.store.update((s) => {
            s.sent[sk] = date;
            if (messageId) s.messages[messageKey(msg.platform, messageId)] = { cardId: card.id, date, platform: msg.platform, chat };
          });
        },
        failed: (): void => {
          if (settled) return;
          settled = true;
          this.inflight.delete(sk);
          this.counts.dailyFailed += 1;
        },
      };
    } finally {
      if (!handedOut) this.inflight.delete(sk);
    }
  }

  /** 這則是不是對某張卡的回饋；是就存（貼到管理員頻道）並回確認。 */
  private feedbackReply(msg: IncomingChatMessage): ConceptReply | null {
    const state = this.deps.store.get();
    const quoted = msg.quotedMessageId ? state.messages[messageKey(msg.platform, msg.quotedMessageId)] : undefined;
    const keyword = parseFeedbackKeyword(msg.text);
    let target: { cardId: string; date: string } | null = quoted ? { cardId: quoted.cardId, date: quoted.date } : null;
    if (!target && keyword !== null) {
      const date = state.sent[sentKey(msg.platform, msg.chatId)];
      const day = date ? state.days[date] : undefined;
      if (day) target = { cardId: day.cardId, date };
    }
    if (!target) return null;
    // 引用那一則但沒有文字（貼圖、圖片）不算。
    if (keyword === null && !msg.text.trim()) return null;
    const content = keyword ?? msg.text.trim();
    const noop = (): void => undefined;
    if (!content) return { kind: 'feedback', text: CONCEPT_FEEDBACK_USAGE, delivered: noop, failed: noop };
    const userHash = hashChatId(msg.userId || `anon:${msg.chatId}`);
    const now = this.now();
    if (!this.limiter.allow(userHash, now)) {
      this.counts.feedbackThrottled += 1;
      return null;
    }
    this.counts.feedback += 1;
    const record = formatFeedbackForAdmin({
      cardId: target.cardId,
      date: target.date,
      platform: msg.platform,
      groupHash: hashChatId(msg.chatId),
      userHash,
      text: content,
      createdAt: new Date(now).toISOString(),
    });
    // 不等 Discord：LINE 的 reply_token 很快就過期。
    const sink = this.deps.feedbackSink;
    void (sink ? sink(record) : Promise.resolve(false)).then(
      (ok) => { if (!ok) this.counts.feedbackStoreFailed += 1; },
      () => { this.counts.feedbackStoreFailed += 1; },
    );
    return { kind: 'feedback', text: CONCEPT_FEEDBACK_ACK, delivered: noop, failed: noop };
  }

  status(): ConceptDailyStatus {
    const cfg = this.cfg();
    const date = dailyKeyAt(this.now(), cfg.startMinute) ?? '';
    const today = date ? this.deps.store.get().days[date] : undefined;
    return {
      line: cfg.lineEnabled,
      discord: cfg.discordEnabled,
      lineGroups: cfg.lineGroupIds.size,
      discordChannels: cfg.discordChannelIds.size,
      backend: this.deps.store.backend.name,
      stateLoaded: this.deps.store.isLoaded(),
      today: today ? { date: today.date, cardId: today.cardId, source: today.source, link: today.link.kind } : null,
      counts: { ...this.counts },
    };
  }
}

// ─── 單例 ─────────────────────────────────────────────────────────────────

let instance: ConceptDailyService | null = null;

/** bots/index.ts 開機時呼叫一次（綁題庫與回饋的去處）。 */
export function initConceptDaily(deps: Omit<ConceptDailyDeps, 'store'> & { store?: ConceptStateStore }): ConceptDailyService {
  const repo = conceptStateRepoConfig();
  const store = deps.store ?? new ConceptStateStore(repo ? new GitHubBackend(repo) : new MemoryBackend());
  if (!repo) {
    const cfg = conceptDailyConfig();
    if (cfg.lineEnabled || cfg.discordEnabled) console.warn('[concept-daily] no state repo configured: "sent today" lives in memory only (a restart may send twice that day)');
  }
  instance = new ConceptDailyService({ ...deps, store });
  return instance;
}

export function getConceptDaily(): ConceptDailyService | null {
  return instance;
}

/** 測試用。 */
export function __setConceptDailyForTests(next: ConceptDailyService | null): void {
  instance = next;
}
