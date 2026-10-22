/**
 * 模擬瓦（2026-10-14）— 進行中的題目：記憶體裡的 session、期限、上限與每個指令的狀態轉移。
 *
 * Edward 2026-10-14：「Line bot/dc bot 有辦法支援模擬瓦嗎? 不是練習局
 * 模擬瓦比較像是練習邏輯思考跟派隊資訊的釋放與解讀」。
 *
 *   - 一人一個聊天室一題（key = 平台:聊天室:使用者；LINE 群組事件沒有 userId 時整個聊天室共用一題）。
 *     新的 /模擬 取代舊的，回覆第一行講明。同一個人跨聊天室最多同時 2 題（最久沒動的先結束）。
 *   - 閒置 30 分鐘（SIM_SESSION_TTL_MINUTES）自動結束，不論如何 2 小時結束；最多 500 題（最久沒動的先結束），
 *     同一個聊天室最多 30 題；每人 10 分鐘最多 30 個模擬指令，超過提醒一次後不回。
 *     過期或被擠掉的題目，之後打指令會說是哪一題、為什麼結束、怎麼重開（只記在記憶體）。
 *   - 不存檔：部署或重啟就清空（每天約 03:47 +08 快取更新會重新部署）。
 *   - **送出後才算數**：handle() 回 `{ text, commit }`，呼叫端確定回覆送出後才呼叫 commit()，
 *     回覆失敗不會跳過一步。
 *   - **同一個聊天室一次只處理一個指令**：呼叫端用 withLock() 把「算回覆 → 送出 → commit」包起來
 *     （LINE 的 webhook、Discord 的 interaction 都可能同時進來），不會出現「回覆說走了一步、狀態卻沒走」。
 *     2026-10-22 審查修正：以前照「要動的那一題」排隊，排隊時那一題結束了、代答改指到別題，就會在沒排隊的
 *     題目上寫入（其中一個 commit 被版本檢查丟掉，回覆卻說記下了）；現在整個聊天室排一條隊。
 *   - LINE 重送（同一個事件）：上一次的回覆已經送出（commit 過）就不再回；沒送出才重算。送出過的事件記在
 *     store 上（不是題目上），所以 /公布、/結束 把題目結束之後的重送也認得出來，不會改指到別題
 *     （2026-10-22 審查修正）；重送也一律不代答。
 *   - 打的字、答案、區間只在這裡的記憶體；log 只有固定文字（這個檔案沒有 log）。
 *   - **代答**（2026-10-22，第一批真人的問題「要本人回答還是別人也可以答」）：自己在這個聊天室沒有開著的題目
 *     的人，打寫對的 /派 /區間 /下一步 /公布 /結束 會作用在這個聊天室**最新開的那一題**上，回覆第一行標「代答」
 *     （不寫名字）；自己有題目的人還是只動自己的。每人的限流、每題的閒置期限都不變。審查修正：
 *       - 只在大家都看得到回覆的地方（LINE 群組、模擬回覆公開的 Discord 頻道：`shared`）；1 對 1 和只有
 *         本人看得到回覆的 Discord 頻道不代答；
 *       - 看不懂的 /派、/區間 不代答（不回、照舊同步、不延長別人的題目）；LINE 重送不代答；
 *       - 自己的題目剛過期／被擠掉時先講一次是哪一題、怎麼重開；之後在打別的指令之前，/公布 /結束 不代答
 *         （不會一句「我的題目呢」就把別人的題目公布掉）；
 *       - 代答寫的 /區間，題主之後的回覆寫「這題目前的區間」（不是「你寫的」）；/公布 列出的派票裡，
 *         代答派的標「（代答）」。
 */

import type { Role } from '@avalon/shared';
import { seededRandom } from '../../ai/benchmark/agreement';
import type { SimBank } from './bank';
import { isCoAnswerable, isFollowUpCommand, parseSimCommand, type IntervalGroup, type SimCommand } from './commands';
import {
  SIM_CONFIG,
  SIM_LOCK_WAIT_MS,
  SIM_MAX_SESSIONS,
  SIM_MAX_SESSIONS_PER_CHAT,
  SIM_MAX_SESSIONS_PER_USER,
  SIM_RATE_LIMIT_MAX,
  SIM_RATE_LIMIT_WINDOW_MS,
  SIM_SESSION_HARD_CAP_MS,
  simBeliefModelId,
  simSessionTtlMs,
} from './config';
import { campShares, humanAggFor, proposalFeatures } from './human';
import { beliefModelFor, type SimBeliefModel } from './logic';
import { emptySimCounts, type SimCounts } from './metrics';
import { evaluateInterval, intervalGroupTrue, logicPanel, releasePanel, teamCleanUnder, type ProposalEvent } from './reading';
import {
  BANK_NOT_READY_TEXT,
  NO_SESSION_TEXT,
  RATE_LIMITED_TEXT,
  endedNoticeText,
  endedText,
  formatInterval,
  formatNext,
  formatProposeFeedback,
  formatReveal,
  formatStart,
  noDecisionText,
  noMoreDecisionsText,
  simHelpText,
  thinPoolText,
  unknownIdText,
  usageText,
  withCoAnswerMark,
  wrongSizeText,
  type SimPlatform,
} from './replies';
import {
  TEAM_SIZES,
  eventIndexOfProposal,
  exerciseIdOf,
  isRed,
  nextDecision,
  publicEvents,
  selectExercise,
  viewAt,
  type PublicEvent,
  type SimGame,
} from './scenario';
import { maskOf } from './seats';

export type SimPhase = 'answering' | 'answered' | 'no-more-decisions';

/** 同一個決定點最多記幾次 /派（公布時全部列出）。 */
export const SIM_ANSWERS_PER_DECISION = 5;
/** 記住幾個已經送出回覆的 LINE 事件（重送判斷；LINE 的重送在幾分鐘內）。 */
const ANSWERED_EVENTS_MAX = 5000;

/** 一次 /派：隊伍，以及是不是代答派的（/公布 時標「（代答）」）。 */
export interface SimAnswer {
  team: number[];
  coAnswer: boolean;
}

export interface SimSession {
  key: string;
  /** `平台:聊天室`（同一聊天室的上限用）。 */
  chatKey: string;
  /** `平台:使用者`（同一個人跨聊天室的上限用）；沒有使用者 id 時沒有。 */
  userKey?: string;
  exerciseId: string;
  game: number;
  seat: number;
  role: Role;
  /** 目前（或最後一個）決定：proposals[] 的索引。 */
  decision: number;
  /** 已經顯示的公開事件數。 */
  cursor: number;
  /** 決定 → 這題派過的隊伍（照順序，最後一個是最後的答案）。 */
  answers: Map<number, SimAnswer[]>;
  interval?: IntervalGroup[];
  /** 最後一次 /區間 是代答寫的（題主之後的回覆寫「這題目前的區間」）。 */
  intervalByCoAnswer?: boolean;
  /** 最後一次 /區間 留下的世界（公布時對答案）。 */
  intervalWorlds?: number[];
  /** ③ 邏輯面板已經在這個決定點的 /派 回覆裡完整印過。 */
  logicShownFor?: number;
  phase: SimPhase;
  /** 「之後照實際對局進行」已經講過。 */
  notedReplay: boolean;
  startedAt: number;
  lastActiveAt: number;
  /** 每次 commit 加一；過期的轉移不會蓋掉較新的狀態。 */
  version: number;
}

export interface SimRequest {
  platform: SimPlatform;
  /** LINE：群組 id 或 1 對 1 的使用者 id；Discord：頻道 id。 */
  chatId: string;
  userId?: string;
  /** LINE 事件代號（重送判斷用）。 */
  eventKey?: string;
  /** 這是 LINE 對同一個事件的重送。 */
  duplicate?: boolean;
  /**
   * 這個聊天室裡大家都看得到模擬的回覆（LINE 群組；回覆公開的 Discord 頻道）。只有這種地方可以代答；
   * 沒給 = 不代答（1 對 1、只有本人看得到回覆的 Discord 頻道）。
   */
  shared?: boolean;
  /**
   * 明確的指令（Discord slash）：看不懂的 /派、/區間 沒有題目時也給用法（LINE 打字時當聊天不回）。
   * 一樣受限流管。
   */
  explicit?: boolean;
}

export type SimReplyKind =
  | 'start' | 'propose' | 'interval' | 'next' | 'reveal' | 'end'
  | 'usage' | 'no-session' | 'bank' | 'select' | 'rate-limited' | 'no-more' | 'help';

export interface SimReply {
  text: string;
  kind: SimReplyKind;
  /** 回覆送出後呼叫（之前不會改任何狀態）。 */
  commit: () => void;
  /** 回覆之後這一題還開著（LINE 1 對 1 加快速按鈕用）。 */
  sessionOpen: boolean;
}

export function sessionKeyFor(req: Pick<SimRequest, 'platform' | 'chatId' | 'userId'>): string {
  return `${req.platform}:${req.chatId}:${req.userId ?? '*'}`;
}

export function chatKeyFor(req: Pick<SimRequest, 'platform' | 'chatId'>): string {
  return `${req.platform}:${req.chatId}`;
}

/** 一個指令要動的題目：自己的，或代答的（這個聊天室最新開的一題）。 */
interface SimTarget {
  key: string;
  session: SimSession | null;
  coAnswer: boolean;
}

type TargetRequest = Pick<SimRequest, 'platform' | 'chatId' | 'userId' | 'shared' | 'duplicate'>;

// ─── 儲存 ─────────────────────────────────────────────────────────────────

export interface SimStoreOptions {
  ttlMs: number;
  hardCapMs: number;
  maxSessions: number;
  maxPerChat: number;
  maxPerUser: number;
}

export type EndedReason = 'expired' | 'evicted';

/** 過期或被擠掉的題目（記住題號，下次打指令時告訴本人）。 */
const ENDED_MEMORY_MAX = 1000;

/** Map 的順序 = 最近使用的在最後（LRU）。 */
export class SimSessionStore {
  private readonly sessions = new Map<string, SimSession>();
  private readonly ended = new Map<string, { exerciseId: string; reason: EndedReason }>();
  /** 已經送出回覆（commit 過）的 LINE 事件；題目結束了也記得（重送不會改指到別題）。 */
  private readonly answeredEvents = new Set<string>();
  /** 剛聽過「你的題目已經結束」的人：打別的指令之前，/公布 /結束 不代答。 */
  private readonly noticed = new Set<string>();

  constructor(private readonly opts: SimStoreOptions, private readonly onExpire: () => void = () => undefined) {}

  private expired(s: SimSession, now: number): boolean {
    return now - s.lastActiveAt > this.opts.ttlMs || now - s.startedAt > this.opts.hardCapMs;
  }

  private remember(s: SimSession, reason: EndedReason): void {
    this.ended.delete(s.key);
    this.ended.set(s.key, { exerciseId: s.exerciseId, reason });
    while (this.ended.size > ENDED_MEMORY_MAX) {
      const oldest = this.ended.keys().next().value;
      if (oldest === undefined) break;
      this.ended.delete(oldest);
    }
  }

  private evict(key: string): void {
    const s = this.sessions.get(key);
    if (!s) return;
    this.sessions.delete(key);
    this.remember(s, 'evicted');
  }

  /** 清掉過期的（每次指令都順便做，最多 500 個，很便宜）。 */
  sweep(now: number): void {
    for (const [key, s] of this.sessions) {
      if (this.expired(s, now)) {
        this.sessions.delete(key);
        this.remember(s, 'expired');
        this.onExpire();
      }
    }
  }

  get(key: string, now: number): SimSession | null {
    this.sweep(now);
    return this.sessions.get(key) ?? null;
  }

  /** 這個 key 上一題怎麼結束的（過期／被擠掉），沒有就是 null。 */
  endedInfo(key: string): { exerciseId: string; reason: EndedReason } | null {
    return this.ended.get(key) ?? null;
  }

  /** 已經告訴本人了（之後的後續指令改成代答；/公布 /結束 要等本人先打別的指令）。 */
  forgetEnded(key: string): void {
    this.ended.delete(key);
    capped(this.noticed, key, ENDED_MEMORY_MAX);
  }

  /** 剛聽過結束的說明、還沒打別的指令。 */
  wasNoticed(key: string): boolean {
    return this.noticed.has(key);
  }

  clearNoticed(key: string): void {
    this.noticed.delete(key);
  }

  /** 這個 LINE 事件的回覆已經送出過。 */
  eventAnswered(eventKey: string): boolean {
    return this.answeredEvents.has(eventKey);
  }

  noteAnsweredEvent(eventKey: string): void {
    capped(this.answeredEvents, eventKey, ANSWERED_EVENTS_MAX);
  }

  /** 這個聊天室裡最新開的一題（代答的對象）；同時開的取最近使用的。沒有就是 null。 */
  newestInChat(chatKey: string, now: number): SimSession | null {
    this.sweep(now);
    let newest: SimSession | null = null;
    for (const s of this.sessions.values()) {
      if (s.chatKey === chatKey && (!newest || s.startedAt >= newest.startedAt)) newest = s;
    }
    return newest;
  }

  /** 放進去（放到最後 = 最近使用）；超過上限就結束最久沒動的。 */
  set(session: SimSession): void {
    this.sessions.delete(session.key);
    this.ended.delete(session.key);
    this.noticed.delete(session.key);
    this.sessions.set(session.key, session);
    const sameChat = [...this.sessions.values()].filter((s) => s.chatKey === session.chatKey);
    for (let i = 0; i < sameChat.length - this.opts.maxPerChat; i++) this.evict(sameChat[i].key);
    if (session.userKey) {
      const sameUser = [...this.sessions.values()].filter((s) => s.userKey === session.userKey);
      for (let i = 0; i < sameUser.length - this.opts.maxPerUser; i++) this.evict(sameUser[i].key);
    }
    while (this.sessions.size > this.opts.maxSessions) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.evict(oldest);
    }
  }

  delete(key: string): void {
    this.sessions.delete(key);
  }

  size(): number {
    return this.sessions.size;
  }
}

/** 放進一個有上限的集合（最舊的先丟）。 */
function capped(set: Set<string>, value: string, max: number): void {
  set.delete(value);
  set.add(value);
  while (set.size > max) {
    const oldest = set.values().next().value;
    if (oldest === undefined) break;
    set.delete(oldest);
  }
}

/** 每人 10 分鐘最多 N 個指令；超過只提醒一次。 */
export class SimRateLimiter {
  private readonly hits = new Map<string, { times: number[]; notified: boolean }>();

  constructor(private readonly windowMs: number, private readonly max: number) {}

  /** 'ok' | 'notify'（剛超過，提醒一次）| 'drop'。 */
  hit(key: string, now: number): 'ok' | 'notify' | 'drop' {
    const entry = this.hits.get(key) ?? { times: [], notified: false };
    entry.times = entry.times.filter((t) => now - t < this.windowMs);
    if (entry.times.length === 0) entry.notified = false;
    if (entry.times.length >= this.max) {
      this.hits.set(key, entry);
      if (entry.notified) return 'drop';
      entry.notified = true;
      return 'notify';
    }
    entry.times.push(now);
    this.hits.set(key, entry);
    if (this.hits.size > 5000) {
      for (const [k, e] of this.hits) if (e.times.every((t) => now - t >= this.windowMs)) this.hits.delete(k);
    }
    return 'ok';
  }
}

// ─── 引擎 ─────────────────────────────────────────────────────────────────

export interface SimEngineOptions {
  bank: () => Promise<SimBank | null>;
  now?: () => number;
  ttlMs?: number;
  hardCapMs?: number;
  maxSessions?: number;
  maxPerChat?: number;
  maxPerUser?: number;
  rateLimit?: { windowMs: number; max: number };
  model?: SimBeliefModel;
  /** 選題亂數（測試可以固定）。 */
  random?: (seed: string) => () => number;
  /** withLock 等前一個指令最久多久（毫秒）；之後照樣處理，不會卡死。 */
  lockWaitMs?: number;
}

const NOOP = (): void => undefined;

export class SimEngine {
  private readonly store: SimSessionStore;
  private readonly limiter: SimRateLimiter;
  private readonly now: () => number;
  private readonly model: SimBeliefModel;
  private readonly random: (seed: string) => () => number;
  private readonly locks = new Map<string, Promise<void>>();
  readonly counts: SimCounts = emptySimCounts();

  constructor(private readonly opts: SimEngineOptions) {
    this.now = opts.now ?? Date.now;
    this.store = new SimSessionStore(
      {
        ttlMs: opts.ttlMs ?? simSessionTtlMs(),
        hardCapMs: opts.hardCapMs ?? SIM_SESSION_HARD_CAP_MS,
        maxSessions: opts.maxSessions ?? SIM_MAX_SESSIONS,
        maxPerChat: opts.maxPerChat ?? SIM_MAX_SESSIONS_PER_CHAT,
        maxPerUser: opts.maxPerUser ?? SIM_MAX_SESSIONS_PER_USER,
      },
      () => { this.counts.expired += 1; },
    );
    this.limiter = new SimRateLimiter(opts.rateLimit?.windowMs ?? SIM_RATE_LIMIT_WINDOW_MS, opts.rateLimit?.max ?? SIM_RATE_LIMIT_MAX);
    this.model = opts.model ?? beliefModelFor(simBeliefModelId());
    this.random = opts.random ?? seededRandom;
  }

  activeSessions(): number {
    this.store.sweep(this.now());
    return this.store.size();
  }

  /** 這個人在這個聊天室有沒有開著的題目。 */
  hasSession(req: Pick<SimRequest, 'platform' | 'chatId' | 'userId'>): boolean {
    return this.store.get(sessionKeyFor(req), this.now()) !== null;
  }

  /**
   * 這個後續指令（/派 /區間 /下一步 /公布 /結束，含看不懂的 /派、/區間）會有題目接：自己的，或代答
   * 這個聊天室最新開的一題（只有寫對的指令、只在 `shared` 的聊天室）。鏡像群不同步就看這個。
   */
  answersFollowUp(req: TargetRequest, cmd: SimCommand): boolean {
    return isFollowUpCommand(cmd) && this.targetFor(cmd, req, this.now()).session !== null;
  }

  /**
   * 這個指令要動哪一題：自己的；自己沒有、而這是大家都看得到回覆的聊天室（`shared`）、指令寫對了、
   * 這個聊天室有別人開的題目，就代答最新開的那一題。不代答的情況：
   *   - 自己的題目剛過期／被擠掉、還沒告訴本人（這一次回結束的說明，見 handle()）；
   *   - LINE 重送（`skippedDuplicate`：第一次的回覆可能已經送出，不能改指到別題，什麼都不回）；
   *   - 剛聽過結束的說明、還沒打別的指令時的 /公布 /結束（當成自己沒有題目）。
   */
  private targetFor(cmd: SimCommand | null | undefined, req: TargetRequest, now: number): SimTarget & { endedNotice: boolean; skippedDuplicate: boolean } {
    const key = sessionKeyFor(req);
    const own = this.store.get(key, now);
    const mine = { key, session: own, coAnswer: false, endedNotice: false, skippedDuplicate: false };
    if (own || !cmd || !isCoAnswerable(cmd) || !req.shared) return mine;
    const newest = this.store.newestInChat(chatKeyFor(req), now);
    if (!newest) return mine;
    if (this.store.endedInfo(key)) return { ...mine, endedNotice: true };
    if (req.duplicate) return { ...mine, skippedDuplicate: true };
    if ((cmd.kind === 'reveal' || cmd.kind === 'end') && this.store.wasNoticed(key)) return mine;
    return { key: newest.key, session: newest, coAnswer: true, endedNotice: false, skippedDuplicate: false };
  }

  get beliefModelId(): string {
    return this.model.id;
  }

  /** 狀態頁用：目前的世界模型有沒有算派票行為（v1 false）。 */
  get weighsBehaviour(): boolean {
    return this.model.weighsBehaviour;
  }

  /**
   * 同一個聊天室（platform:chatId）的「算回覆 → 送出 → commit」一次只跑一個。前一個最久等
   * lockWaitMs（送出卡住也不會把這個聊天室永遠卡住）。`fn` 丟出的錯照樣往外丟。
   * 整個聊天室排一條隊（2026-10-22 審查修正）：代答要動哪一題是輪到它時才決定的（handle()），
   * 所以不會在排隊期間改指到另一題、又沒排那一題的隊。
   */
  async withLock<T>(req: Pick<SimRequest, 'platform' | 'chatId'>, fn: () => Promise<T>): Promise<T> {
    const key = chatKeyFor(req);
    const prev = this.locks.get(key) ?? Promise.resolve();
    let release: () => void = NOOP;
    const mine = new Promise<void>((resolve) => { release = resolve; });
    const tail = prev.then(() => mine);
    this.locks.set(key, tail);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waitMs = this.opts.lockWaitMs ?? SIM_LOCK_WAIT_MS;
    await Promise.race([prev, new Promise<void>((resolve) => { timer = setTimeout(resolve, waitMs); timer.unref?.(); })]);
    if (timer) clearTimeout(timer);
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }

  /** LINE：一段文字 → 回覆，或 null（不是模擬指令／不該回）。 */
  async handleText(text: string, req: SimRequest): Promise<SimReply | null> {
    if (!SIM_CONFIG.commandsEnabled) return null;
    const cmd = parseSimCommand(text);
    return cmd ? this.handle(cmd, req) : null;
  }

  /**
   * 一個指令 → 回覆，或 null：不是給模擬的（聊天）、被限流（提醒過之後）、或 LINE 重送一個
   * 已經回過的事件。null 時呼叫端什麼都不送。
   */
  async handle(cmd: SimCommand, req: SimRequest): Promise<SimReply | null> {
    if (!SIM_CONFIG.commandsEnabled) return null;
    // LINE 重送同一個事件，而第一次的回覆已經送出：不再回（也不走第二步）。在決定要動哪一題之前看：
    // 第一次的 /公布、/結束 已經把題目結束掉時，重送不會改指到這個聊天室的別題。
    if (req.duplicate && req.eventKey && this.store.eventAnswered(req.eventKey)) return null;
    const reply = await this.compute(cmd, req);
    if (!reply) return null;
    const ownKey = sessionKeyFor(req);
    const { eventKey } = req;
    const commit = reply.commit;
    return {
      ...reply,
      commit: (): void => {
        // 打了 /公布 /結束 以外的指令：之後的 /公布 /結束 又可以代答（見 targetFor()）。
        if (cmd.kind !== 'reveal' && cmd.kind !== 'end') this.store.clearNoticed(ownKey);
        commit();
        if (eventKey) this.store.noteAnsweredEvent(eventKey);
      },
    };
  }

  private async compute(cmd: SimCommand, req: SimRequest): Promise<SimReply | null> {
    const now = this.now();
    const ownKey = sessionKeyFor(req);
    const t = this.targetFor(cmd, req, now);
    const { session, coAnswer } = t;

    // LINE 重送、第一次沒送出，而這個人自己沒有題目：不代答（第一次可能是代答，也可能不是；不能改指到別題）。
    if (t.skippedDuplicate) return null;

    // 看不懂的 /派、/區間 又沒有自己的題目：LINE 打字當作一般聊天（例如 /派西 2）；Discord slash 給用法。
    // 看不懂的指令不代答（targetFor），所以聊天室裡有別人的題目也一樣。
    if (cmd.kind === 'usage' && cmd.command !== 'start' && !session && !req.explicit) return null;

    const rate = this.limiter.hit(`${req.platform}:${req.userId ?? req.chatId}`, now);
    if (rate !== 'ok') {
      this.counts.rateLimited += 1;
      return rate === 'notify' ? { text: RATE_LIMITED_TEXT, kind: 'rate-limited', commit: NOOP, sessionOpen: !!session } : null;
    }

    if (cmd.kind === 'help') {
      return { text: simHelpText(req.platform), kind: 'help', commit: (): void => { this.counts.help += 1; }, sessionOpen: !!session };
    }
    // 開題和 /模擬 的用法只看自己的題目（targetFor 對非後續指令回的就是自己的）。
    if (cmd.kind === 'start') return this.start(cmd, req, ownKey, session, now);
    if (cmd.kind === 'usage' && (cmd.command === 'start' || !session)) {
      return this.reply(usageText(cmd.command, cmd.problem), 'usage', t, now, () => { this.counts.usage += 1; });
    }
    if (!session) {
      const ended = this.store.endedInfo(ownKey);
      return {
        text: ended ? endedNoticeText(ended.exerciseId, ended.reason) : NO_SESSION_TEXT,
        kind: 'no-session',
        commit: (): void => {
          this.counts.noSession += 1;
          // 講過一次自己的題目怎麼結束的；聊天室裡有別人的題目時，下一個指令起代答。
          if (t.endedNotice) this.store.forgetEnded(ownKey);
        },
        sessionOpen: false,
      };
    }
    const bank = await this.opts.bank();
    if (!bank || !bank.games[session.game]) {
      return { text: BANK_NOT_READY_TEXT, kind: 'bank', commit: NOOP, sessionOpen: true };
    }
    const game = bank.games[session.game];
    const target: SimTarget & { session: SimSession } = { key: session.key, session, coAnswer };
    switch (cmd.kind) {
      case 'usage':
        return this.reply(usageText(cmd.command, cmd.problem), 'usage', target, now, () => { this.counts.usage += 1; });
      case 'propose':
        return this.propose(cmd.team, bank, game, target, req, now);
      case 'interval':
        return this.interval(cmd.groups, game, target, now);
      case 'next':
        return this.next(game, target, req, now);
      case 'reveal':
        return this.reveal(game, target);
      case 'end':
        return {
          text: withCoAnswerMark(endedText(session.exerciseId), coAnswer),
          kind: 'end',
          sessionOpen: false,
          commit: (): void => {
            if (this.store.get(session.key, this.now())?.version !== session.version) return;
            this.store.delete(session.key);
            this.counts.ended += 1;
            if (coAnswer) this.counts.coAnswers += 1;
          },
        };
    }
  }

  /**
   * 綁在一題上的回覆：commit 時更新 lastActiveAt（以及 `update` 的狀態）；送出過的事件由 handle() 記。
   * 代答的文字由呼叫端標好（算在長度裡）；這裡只計數。
   */
  private reply(
    text: string,
    kind: SimReplyKind,
    t: SimTarget,
    now: number,
    count: () => void,
    update?: (s: SimSession) => Partial<SimSession>,
  ): SimReply {
    const { session, coAnswer } = t;
    return {
      text: kind === 'usage' || kind === 'no-more' ? withCoAnswerMark(text, coAnswer) : text,
      kind,
      sessionOpen: !!session,
      commit: (): void => {
        if (!session) { count(); return; }
        const current = this.store.get(session.key, this.now());
        // 這段回覆算出來之後，這一題已經變了（呼叫端沒有用 withLock 時才可能）：不再套用，也不計數。
        if (!current || current.version !== session.version) return;
        count();
        if (coAnswer) this.counts.coAnswers += 1;
        this.store.set({
          ...current,
          ...(update ? update(current) : {}),
          lastActiveAt: now,
          version: current.version + 1,
        });
      },
    };
  }

  private async start(cmd: Extract<SimCommand, { kind: 'start' }>, req: SimRequest, key: string, previous: SimSession | null, now: number): Promise<SimReply> {
    const bank = await this.opts.bank();
    if (!bank || bank.games.length === 0) return { text: BANK_NOT_READY_TEXT, kind: 'bank', commit: NOOP, sessionOpen: !!previous };
    const picked = selectExercise(bank, cmd, this.random(`${key}:${now}`));
    if (!picked.ok) {
      let text: string;
      if (picked.reason === 'thin') text = thinPoolText(picked.role, picked.seat, picked.n, picked.available);
      else if (picked.reason === 'no-decision') text = noDecisionText(picked.seat);
      else if (picked.reason === 'unknown-id') text = unknownIdText();
      else text = BANK_NOT_READY_TEXT;
      return { text, kind: 'select', commit: NOOP, sessionOpen: !!previous };
    }
    const game = bank.games[picked.game];
    const events = publicEvents(game);
    const cursor = eventIndexOfProposal(events, picked.decision);
    const view = viewAt(game, picked.seat, cursor, events);
    const exerciseId = exerciseIdOf(game.id, picked.seat);
    const text = formatStart({
      exerciseId,
      game,
      seat: picked.seat,
      sight: view.sight,
      shown: view.events,
      decision: events[cursor] as ProposalEvent,
      platform: req.platform,
      replacedId: previous?.exerciseId,
      shared: !!req.shared,
    });
    const role = game.seatRoles[picked.seat - 1];
    return {
      text,
      kind: 'start',
      sessionOpen: true,
      commit: (): void => {
        this.store.set({
          key,
          chatKey: `${req.platform}:${req.chatId}`,
          ...(req.userId ? { userKey: `${req.platform}:${req.userId}` } : {}),
          exerciseId,
          game: picked.game,
          seat: picked.seat,
          role,
          decision: picked.decision,
          cursor,
          answers: new Map(),
          phase: 'answering',
          notedReplay: false,
          startedAt: now,
          lastActiveAt: now,
          version: (previous?.version ?? 0) + 1,
        });
        this.counts.started[req.platform] += 1;
        this.counts.byRole[role] = (this.counts.byRole[role] ?? 0) + 1;
      },
    };
  }

  private propose(team: number[], bank: SimBank, game: SimGame, t: SimTarget & { session: SimSession }, req: SimRequest, now: number): SimReply {
    const { session } = t;
    if (session.phase === 'no-more-decisions') {
      return this.reply(noMoreDecisionsText(session.exerciseId), 'no-more', t, now, NOOP);
    }
    const events = publicEvents(game);
    const decision = events[session.cursor] as ProposalEvent;
    const size = TEAM_SIZES[decision.round - 1];
    if (team.length !== size) {
      return this.reply(wrongSizeText(size, team.length), 'usage', t, now, () => { this.counts.usage += 1; });
    }
    const view = viewAt(game, session.seat, session.cursor, events);
    const realQuest = decision.approved
      ? events.find((e): e is Extract<PublicEvent, { kind: 'quest' }> => e.kind === 'quest' && e.round === decision.round)
      : undefined;
    const human = humanAggFor(bank.humans, game, session.decision);
    const mine = proposalFeatures(game, session.decision, team);
    const camps = campShares(bank.humans, game, session.decision, mine.shape);
    const prevEvent = [...view.events].reverse().find((e): e is ProposalEvent => e.kind === 'proposal');
    const logic = logicPanel(view, this.model);
    // 派票完的最後檢查：你寫過 /區間 的話，照你的區間（用現在看得到的資訊重算）你的隊伍全好有幾種。
    const own = session.interval && session.interval.length > 0 ? evaluateInterval(view, session.interval, this.model) : undefined;
    const text = formatProposeFeedback(
      {
        exerciseId: session.exerciseId,
        game,
        seat: session.seat,
        decision,
        team,
        realQuest,
        human: { agg: human.agg, mine, prev: prevEvent, camps },
        logic,
        release: releasePanel(view, team, logic.analysis),
        platform: req.platform,
        showLogic: session.logicShownFor !== session.decision,
        ...(own ? {
          ownInterval: {
            worlds: own.jointWorlds.length,
            clean: teamCleanUnder(own.jointWorlds, team),
            // 你自己寫的才說「你寫的」：代答寫的、或這次是代答，都說「這題目前的區間」。
            yours: !t.coAnswer && !session.intervalByCoAnswer,
          },
        } : {}),
        coAnswer: t.coAnswer,
        shared: !!req.shared,
      },
      { sight: view.sight, shown: view.events, ownLakes: view.ownLakes },
    );
    const same = maskOf(team) === maskOf(decision.teamSeats);
    return this.reply(text, 'propose', t, now, () => {
      this.counts.answers += 1;
      if (same) this.counts.sameAsReal += 1;
    }, (s) => {
      const answers = new Map(s.answers);
      answers.set(s.decision, [...(answers.get(s.decision) ?? []), { team: [...team], coAnswer: t.coAnswer }].slice(-SIM_ANSWERS_PER_DECISION));
      return { answers, phase: 'answered', logicShownFor: s.decision };
    });
  }

  private interval(groups: IntervalGroup[], game: SimGame, t: SimTarget & { session: SimSession }, now: number): SimReply {
    const { session } = t;
    const view = viewAt(game, session.seat, session.cursor);
    const ev = evaluateInterval(view, groups, this.model);
    const text = formatInterval(session.exerciseId, ev, this.model, view.seat, t.coAnswer);
    return this.reply(text, 'interval', t, now, () => { this.counts.intervals += 1; }, () => ({
      interval: groups.map((g) => ({ ...g, seats: [...g.seats] })),
      intervalWorlds: ev.jointWorlds,
      intervalByCoAnswer: t.coAnswer,
    }));
  }

  private next(game: SimGame, t: SimTarget & { session: SimSession }, req: SimRequest, now: number): SimReply {
    const { session } = t;
    if (session.phase === 'no-more-decisions') {
      return this.reply(noMoreDecisionsText(session.exerciseId), 'no-more', t, now, NOOP);
    }
    const events = publicEvents(game);
    const nextIndex = nextDecision(game, session.seat, session.decision);
    const nextCursor = nextIndex === null ? events.length : eventIndexOfProposal(events, nextIndex);
    const text = formatNext({
      exerciseId: session.exerciseId,
      game,
      seat: session.seat,
      events: events.slice(session.cursor, nextCursor),
      next: nextIndex === null ? null : (events[nextCursor] as ProposalEvent),
      shownAll: events.slice(0, nextCursor),
      showNote: !session.notedReplay,
      platform: req.platform,
      coAnswer: t.coAnswer,
    });
    return this.reply(text, 'next', t, now, () => { this.counts.steps += 1; }, () => (
      nextIndex === null
        ? { cursor: events.length, phase: 'no-more-decisions', notedReplay: true }
        : { cursor: nextCursor, decision: nextIndex, phase: 'answering', notedReplay: true }
    ));
  }

  private reveal(game: SimGame, t: SimTarget & { session: SimSession }): SimReply {
    const { session } = t;
    const events = publicEvents(game);
    const decisionCursor = eventIndexOfProposal(events, session.decision);
    // 從題目開頭看過的每一次派票，到最後一個決定點為止（沒有下一次了就是整局）。
    const end = session.phase === 'no-more-decisions' ? events.length : decisionCursor;
    const seen = events.slice(0, end).filter((e): e is ProposalEvent => e.kind === 'proposal');
    const answers = [...session.answers.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([d, teams]) => ({ decision: events[eventIndexOfProposal(events, d)] as ProposalEvent, teams }));
    const text = formatReveal({
      exerciseId: session.exerciseId,
      game,
      seat: session.seat,
      answers,
      interval: session.interval,
      intervalWorlds: session.intervalWorlds,
      intervalYours: !t.coAnswer && !session.intervalByCoAnswer,
      proposals: seen,
      coAnswer: t.coAnswer,
    });
    const redMask = maskOf(game.seatRoles.map((r, i) => (isRed(r) ? i + 1 : 0)).filter(Boolean));
    return {
      text,
      kind: 'reveal',
      sessionOpen: false,
      commit: (): void => {
        const current = this.store.get(session.key, this.now());
        if (!current || current.version !== session.version) return;
        this.store.delete(session.key);
        this.counts.reveals += 1;
        if (t.coAnswer) this.counts.coAnswers += 1;
        for (const g of session.interval ?? []) {
          this.counts.intervalGroupsTotal += 1;
          if (intervalGroupTrue(g, redMask)) this.counts.intervalGroupsRight += 1;
        }
      },
    };
  }
}
