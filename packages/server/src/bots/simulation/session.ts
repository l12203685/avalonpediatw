/**
 * 模擬瓦（2026-10-14）— 進行中的題目：記憶體裡的 session、期限、上限與每個指令的狀態轉移。
 *
 * Edward 2026-10-14：「Line bot/dc bot 有辦法支援模擬瓦嗎? 不是練習局
 * 模擬瓦比較像是練習邏輯思考跟派隊資訊的釋放與解讀」。
 *
 *   - 一人一個聊天室一題（key = 平台:聊天室:使用者；LINE 群組事件沒有 userId 時整個聊天室共用一題）。
 *     新的 /模擬 取代舊的，回覆第一行講明。同一個人跨聊天室最多同時 2 題（最久沒動的先結束）。
 *   - 2026-11-19 起不會因為閒置或時間結束（Edward「除非有人 /公布 否則不會結束」；SIM_SESSION_TTL_MINUTES 可另設閒置期限）；最多 500 題（最久沒動的先結束），
 *     同一個聊天室最多 30 題；每人 10 分鐘最多 30 個模擬指令，超過提醒一次後不回。
 *     過期或被擠掉的題目，之後打指令會說是哪一題、為什麼結束、怎麼重開。
 *   - **重啟後題目還在**（2026-11-25，Edward「有些人送出後發現正在進行的未公布的結束了」：一天裡每合併一次後端的
 *     修改伺服器就重啟一次，題目全清）：進行中的題目和「你的題目怎麼結束的」會存到 private repo 的一個 JSON 檔
 *     （persist.ts；跟每日小觀念同一個 repo），開機先讀回來才回答模擬指令。沒設定那個 repo 時照舊只在記憶體
 *     （重啟就清空；開機 log 會寫）。限流、狀態頁的計數不存（重啟歸零）。
 *   - **這裡的 id 都是雜湊過的**（persist.ts simIdHash）：題目的 key、聊天室、使用者、作答的人、LINE 事件代號，
 *     在記憶體裡和存檔裡都只有雜湊；沒有名字。查的時候把進來的 id 雜湊後比對。
 *   - 題目記的是題庫代號（gameId）；games[] 的索引（game）只在這一次開機有效，重啟後第一次用到時照代號重新對
 *     （題庫每晚重建，索引會變）。對不到（那一局從題庫拿掉了）就講明這一題沒能接回來。
 *   - **送出後才算數**：handle() 回 `{ text, commit }`，呼叫端確定回覆送出後才呼叫 commit()，
 *     回覆失敗不會跳過一步。
 *   - **同一個聊天室一次只處理一個指令**：呼叫端用 withLock() 把「算回覆 → 送出 → commit」包起來
 *     （LINE 的 webhook、Discord 的 interaction 都可能同時進來），不會出現「回覆說走了一步、狀態卻沒走」。
 *     2026-10-22 審查修正：以前照「要動的那一題」排隊，排隊時那一題結束了、代答改指到別題，就會在沒排隊的
 *     題目上寫入（其中一個 commit 被版本檢查丟掉，回覆卻說記下了）；現在整個聊天室排一條隊。
 *   - LINE 重送（同一個事件）：上一次的回覆已經送出（commit 過）就不再回；沒送出才重算。送出過的事件記在
 *     store 上（不是題目上），所以 /公布、/結束 把題目結束之後的重送也認得出來，不會改指到別題
 *     （2026-10-22 審查修正）；重送也一律不代答。
 *   - 打的字不留；答案、區間只在這裡的記憶體和上面那個 private repo 的存檔；log 只有固定文字（這個檔案沒有 log）。
 *   - **代答**（2026-10-22，第一批真人的問題「要本人回答還是別人也可以答」）：自己在這個聊天室沒有開著的題目
 *     的人，打寫對的 /派 /區間 /公布 /結束 會作用在這個聊天室**最新開的那一題**上，回覆第一行標「代答」
 *     （不寫名字）；自己有題目的人還是只動自己的。每人的限流、每題的閒置期限都不變。審查修正：
 *       - 只在大家都看得到回覆的地方（LINE 群組、模擬回覆公開的 Discord 頻道：`shared`）；1 對 1 和只有
 *         本人看得到回覆的 Discord 頻道不代答；
 *       - 看不懂的 /派、/區間 不代答（不回、照舊同步、不延長別人的題目）；LINE 重送不代答；
 *       - 自己的題目剛過期／被擠掉時先講一次是哪一題、怎麼重開；之後在打別的指令之前，/公布 /結束 不代答
 *         （不會一句「我的題目呢」就把別人的題目公布掉）；
 *       - 代答寫的 /區間，題主之後的回覆寫「這題目前的區間」（不是「你寫的」）；/公布 列出的派票裡，
 *         代答派的標「（代答）」。
 *   - 2026-11-16（Edward）：/派 只回「幾好幾壞」，完整解讀改成 /分析（這個決定點最後一次 /派）；/公布 附網站上
 *     這一局牌譜的連結（recordsIndex.ts，沒有就附文字牌譜）；可以從 2-5、3-5 開始（scenario.ts）。
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
  SIM_RESTORE_WAIT_MS,
  SIM_SESSION_HARD_CAP_MS,
  simBeliefModelId,
  simSessionTtlMs,
} from './config';
import { campShares, humanAggFor, proposalFeatures } from './human';
import { beliefModelFor, type SimBeliefModel } from './logic';
import { emptySimCounts, type SimCounts } from './metrics';
import { simIdHash, type SimPersistence } from './persist';
import { evaluateInterval, intervalGroupTrue, logicPanel, releasePanel, teamCleanUnder, type ProposalEvent } from './reading';
import {
  BANK_NOT_READY_TEXT,
  NO_SESSION_KEPT_TEXT,
  NO_SESSION_TEXT,
  RATE_LIMITED_TEXT,
  RESTORING_TEXT,
  restartLostText,
  endedNoticeText,
  endedText,
  analysisHiddenText,
  assassinOnlyText,
  formatAnswerAck,
  type EveryoneAnswer,
  formatAnalysis,
  formatAssassinStart,
  formatKillAnswer,
  killTeammateText,
  noAssassinText,
  notAssassinText,
  formatInterval,
  formatAiRead,
  removedCommandText,
  formatProposeResult,
  formatReveal,
  formatStart,
  noAnalysisText,
  noDecisionText,
  noMidText,
  noMoreDecisionsText,
  noStageText,
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
  publicEvents,
  taipeiWeekday,
  viewAt,
  type PublicEvent,
  type SimGame,
} from './scenario';
import { recordUrl } from './recordsIndex';
import { aiReading, type AiPickPoint, type AiPicks } from './aiRead';
import {
  SIM_FEEDBACK_ACK,
  SIM_FEEDBACK_FLAG_AT,
  SIM_FEEDBACK_WINDOW_MS,
  classifySimFeedback,
  clipFeedbackText,
  type SimFeedbackRecord,
} from './feedback';
import { maskOf } from './seats';
import { selectStart } from './spotValue';

export type SimPhase = 'answering' | 'answered' | 'no-more-decisions';

/** 同一個決定點每個人最多記幾次 /派（公布時全部列出）。 */
export const SIM_ANSWERS_PER_DECISION = 5;
/** 同一個決定點全部人加起來最多記幾次 /派（群組大家一起答，2026-11-21）。 */
export const SIM_ANSWERS_PER_DECISION_TOTAL = 100;
/** 記住幾個已經送出回覆的 LINE 事件（重送判斷；LINE 的重送在幾分鐘內）。 */
const ANSWERED_EVENTS_MAX = 5000;

/** 一次 /派：隊伍，以及是不是代答派的（/公布 時標「（代答）」）、誰派的（`平台:使用者`，只用來數第幾位，不存名字）。 */
export interface SimAnswer {
  team: number[];
  coAnswer: boolean;
  by?: string;
}

/** 刺殺題的一次 /刺（群組裡每個人各自記，/公布 一起列；2026-11-21）。 */
export interface SimKill {
  target: number;
  coAnswer: boolean;
  by?: string;
}

export interface SimSession {
  key: string;
  /** `平台:聊天室`（同一聊天室的上限用）。 */
  chatKey: string;
  /** `平台:使用者`（同一個人跨聊天室的上限用）；沒有使用者 id 時沒有。 */
  userKey?: string;
  exerciseId: string;
  /** 題庫代號（重啟後照這個重新對到 games[] 的索引）。 */
  gameId: string;
  /** 題庫 games[] 的索引；剛從存檔讀回來、還沒對過題庫時是 -1。 */
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
  phase: SimPhase;
  /** 刺殺題（2026-11-16）：沒有派票，/刺 座位 作答。 */
  assassin?: boolean;
  /** 刺殺題最後一次 /刺 的座位、是不是代答刺的。 */
  kill?: { target: number; coAnswer: boolean };
  /** 刺殺題每一次 /刺（照順序；群組的 /公布 列每個人最後一次）。 */
  kills?: SimKill[];
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
   * 回覆只有打指令的人看得到（Discord 的 ephemeral 回覆，2026-11-21）。`shared` 的聊天室裡：有這個 → /派 /刺 /分析
   * 照樣回完整結果（只有本人看得到）；沒有（LINE 群組）→ 只回「收到（第 N 位作答）」，結果等 /公布 一起列。
   */
  privateReply?: boolean;
  /**
   * 明確的指令（Discord slash）：看不懂的 /派、/區間 沒有題目時也給用法（LINE 打字時當聊天不回）。
   * 一樣受限流管。
   */
  explicit?: boolean;
}

export type SimReplyKind =
  | 'start' | 'propose' | 'analyze' | 'assassinate' | 'interval' | 'read' | 'removed' | 'reveal' | 'end'
  | 'usage' | 'no-session' | 'bank' | 'select' | 'rate-limited' | 'no-more' | 'help' | 'restoring' | 'feedback';

export interface SimReply {
  text: string;
  kind: SimReplyKind;
  /** 回覆送出後呼叫（之前不會改任何狀態）。 */
  commit: () => void;
  /** 回覆之後這一題還開著（LINE 1 對 1 加快速按鈕用）。 */
  sessionOpen: boolean;
  /**
   * /公布（Edward 2026-11-17）：附整局牌譜圖（recordImage.ts）。平台各自決定怎麼附：Discord 直接附檔；
   * LINE 要公開網址，借用同步的圖片中繼（ChatMirror.relayReplyPngUrl），沒有就只送文字。
   * `names`：1～0 家的名字（跟文字那一行同一份，seatNames.ts；站長 2026-11-26「公布時的圖上沒有玩家id」）。
   */
  image?: { game: SimGame; title: string; names?: readonly string[] };
}

/** 題目的 key：`平台:聊天室:使用者`，聊天室和使用者都是雜湊（存檔裡也是這個）。 */
export function sessionKeyFor(req: Pick<SimRequest, 'platform' | 'chatId' | 'userId'>): string {
  return `${req.platform}:${simIdHash(req.chatId)}:${req.userId ? simIdHash(req.userId) : '*'}`;
}

/** `平台:聊天室`（雜湊）。 */
export function chatKeyFor(req: Pick<SimRequest, 'platform' | 'chatId'>): string {
  return `${req.platform}:${simIdHash(req.chatId)}`;
}

/** `平台:使用者`（雜湊）；沒有使用者 id 時是 `平台:*`。 */
export function userKeyFor(req: Pick<SimRequest, 'platform' | 'userId'>): string {
  return `${req.platform}:${req.userId ? simIdHash(req.userId) : '*'}`;
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

/** 'lost'：重啟後沒能接回來（那一局已經不在題庫裡，或存檔放不下）。 */
export type EndedReason = 'expired' | 'evicted' | 'lost';

export interface EndedInfo {
  exerciseId: string;
  reason: EndedReason;
  /** 什麼時候結束的（兩份存檔合併時比新舊用）。 */
  at: number;
}

/** 過期或被擠掉的題目（記住題號，下次打指令時告訴本人）。 */
const ENDED_MEMORY_MAX = 1000;
/** 「這個 key 的題目在什麼時候結束／講過了」記多久、最多幾筆（只在兩份存檔合併時用，見 persist.ts mergeSnapshots）。 */
const CLOSED_KEEP_MS = 60 * 60 * 1000;
const CLOSED_MAX = 1000;

/** 整個 store 的內容（存檔、讀回來、合併用）。sessions 的順序 = 最久沒用的在前。 */
export interface SimStoreSnapshot {
  sessions: SimSession[];
  ended: [string, EndedInfo][];
  /** key → 什麼時候 /公布、/結束，或講過結束的說明。 */
  closed: [string, number][];
  noticed: string[];
  events: string[];
}

export function emptySnapshot(): SimStoreSnapshot {
  return { sessions: [], ended: [], closed: [], noticed: [], events: [] };
}

export interface SimStoreHooks {
  now?: () => number;
  /**
   * 內容變了。`hard` = 重啟後接不回來就會錯的變動（開題、作答、結束…）；false = 只有「最後一次動是什麼時候」
   * 和 LINE 重送紀錄（不值得為它單獨寫一次檔，下一次寫或關機時一起寫）。
   */
  onChange?: (hard: boolean) => void;
}

/** Map 的順序 = 最近使用的在最後（LRU）。 */
export class SimSessionStore {
  private readonly sessions = new Map<string, SimSession>();
  private readonly ended = new Map<string, EndedInfo>();
  private readonly closed = new Map<string, number>();
  /** 已經送出回覆（commit 過）的 LINE 事件；題目結束了也記得（重送不會改指到別題）。 */
  private readonly answeredEvents = new Set<string>();
  /** 剛聽過「你的題目已經結束」的人：打別的指令之前，/公布 /結束 不代答。 */
  private readonly noticed = new Set<string>();
  private readonly now: () => number;
  private readonly changed: (hard: boolean) => void;

  constructor(private readonly opts: SimStoreOptions, private readonly onExpire: () => void = () => undefined, hooks: SimStoreHooks = {}) {
    this.now = hooks.now ?? Date.now;
    this.changed = hooks.onChange ?? ((): void => undefined);
  }

  private expired(s: SimSession, now: number): boolean {
    return now - s.lastActiveAt > this.opts.ttlMs || now - s.startedAt > this.opts.hardCapMs;
  }

  private remember(s: SimSession, reason: EndedReason): void {
    this.ended.delete(s.key);
    this.ended.set(s.key, { exerciseId: s.exerciseId, reason, at: this.now() });
    while (this.ended.size > ENDED_MEMORY_MAX) {
      const oldest = this.ended.keys().next().value;
      if (oldest === undefined) break;
      this.ended.delete(oldest);
    }
  }

  private close(key: string): void {
    this.closed.delete(key);
    this.closed.set(key, this.now());
    while (this.closed.size > CLOSED_MAX) {
      const oldest = this.closed.keys().next().value;
      if (oldest === undefined) break;
      this.closed.delete(oldest);
    }
  }

  private evict(key: string, reason: EndedReason = 'evicted'): void {
    const s = this.sessions.get(key);
    if (!s) return;
    this.sessions.delete(key);
    this.remember(s, reason);
  }

  /** 清掉過期的（每次指令都順便做，最多 500 個，很便宜）。 */
  sweep(now: number): void {
    for (const [key, s] of this.sessions) {
      if (this.expired(s, now)) {
        this.sessions.delete(key);
        this.remember(s, 'expired');
        this.onExpire();
        this.changed(true);
      }
    }
  }

  get(key: string, now: number): SimSession | null {
    this.sweep(now);
    return this.sessions.get(key) ?? null;
  }

  /** 這個 key 上一題怎麼結束的（過期／被擠掉／沒能接回來），沒有就是 null。 */
  endedInfo(key: string): EndedInfo | null {
    return this.ended.get(key) ?? null;
  }

  /** 已經告訴本人了（之後的後續指令改成代答；/公布 /結束 要等本人先打別的指令）。 */
  forgetEnded(key: string): void {
    this.ended.delete(key);
    this.close(key);
    capped(this.noticed, key, ENDED_MEMORY_MAX);
    this.changed(true);
  }

  /** 剛聽過結束的說明、還沒打別的指令。 */
  wasNoticed(key: string): boolean {
    return this.noticed.has(key);
  }

  clearNoticed(key: string): void {
    if (this.noticed.delete(key)) this.changed(true);
  }

  /** 這個 LINE 事件的回覆已經送出過。 */
  eventAnswered(eventKey: string): boolean {
    return this.answeredEvents.has(eventKey);
  }

  noteAnsweredEvent(eventKey: string): void {
    capped(this.answeredEvents, eventKey, ANSWERED_EVENTS_MAX);
    this.changed(false);
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

  /** 超過上限就結束最久沒動的（同一個聊天室、同一個人、全部）。 */
  private enforceCaps(session: SimSession): void {
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

  /**
   * 放進去（放到最後 = 最近使用）；超過上限就結束最久沒動的。`soft` = 這次只更新了「最後一次動是什麼時候」
   * （不值得單獨寫一次檔）。
   */
  set(session: SimSession, soft = false): void {
    this.sessions.delete(session.key);
    this.ended.delete(session.key);
    this.closed.delete(session.key);
    this.noticed.delete(session.key);
    this.sessions.set(session.key, session);
    this.enforceCaps(session);
    this.changed(!soft);
  }

  /** /公布、/結束，或重啟後接不回來：這一題沒了（記下時間，合併存檔時不會被舊的一份救回來）。 */
  delete(key: string): void {
    if (!this.sessions.delete(key)) return;
    this.close(key);
    this.changed(true);
  }

  size(): number {
    return this.sessions.size;
  }

  /** 整份內容（存檔用；不會改到 store）。 */
  snapshot(): SimStoreSnapshot {
    const cutoff = this.now() - CLOSED_KEEP_MS;
    for (const [key, at] of this.closed) if (at < cutoff) this.closed.delete(key);
    return {
      sessions: [...this.sessions.values()],
      ended: [...this.ended.entries()],
      closed: [...this.closed.entries()],
      noticed: [...this.noticed],
      events: [...this.answeredEvents],
    };
  }

  /**
   * 換成這一份（開機讀回來、或跟存檔合併之後）。不會觸發 onChange。題目照最後一次動的時間排（最久沒動的在前），
   * 超過上限的照舊結束最久沒動的。
   */
  replace(snap: SimStoreSnapshot): void {
    this.sessions.clear();
    this.ended.clear();
    this.closed.clear();
    this.noticed.clear();
    this.answeredEvents.clear();
    for (const [key, info] of snap.ended.slice(-ENDED_MEMORY_MAX)) this.ended.set(key, info);
    for (const [key, at] of snap.closed.slice(-CLOSED_MAX)) this.closed.set(key, at);
    for (const key of snap.noticed.slice(-ENDED_MEMORY_MAX)) this.noticed.add(key);
    for (const key of snap.events.slice(-ANSWERED_EVENTS_MAX)) this.answeredEvents.add(key);
    const ordered = [...snap.sessions].sort((a, b) => a.lastActiveAt - b.lastActiveAt);
    for (const s of ordered) this.sessions.set(s.key, s);
    for (const s of ordered) if (this.sessions.get(s.key) === s) this.enforceCaps(s);
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
  /** 進行中的題目存檔（persist.ts）；沒給 = 只在記憶體。 */
  persistence?: SimPersistence;
  /** 重啟後題目還在讀回來時，一個指令最久等多久（毫秒）；還沒好就回「請再打一次」。 */
  restoreWaitMs?: number;
  /**
   * /公布 的「百科AI 會派」那一行（站長 2026-11-26；aiRead.aiPicks：正式機器人在題目那一刻重派很多次）。
   * 正式機（index.ts）給；沒給 = 不印那一行（測試的全題庫掃描不用每題都重派）。丟錯 = 不印，/公布 照常。
   */
  aiPicks?: (game: SimGame, seat: number, point: AiPickPoint) => Promise<AiPicks | null>;
  /**
   * 玩家對題目的回饋（feedback.ts，站長 2026-11-26）記到哪裡：正式機（index.ts）交給 /意見 同一個地方（feedback/service.ts，
   * 管理員頻道）。沒給 = 照樣認得、回覆、計數，只是不轉出去。從不等它（不擋回覆），丟錯也不影響回覆。
   */
  feedbackSink?: (record: SimFeedbackRecord) => void;
}

/** 記得幾個聊天室最近的 /公布、幾組「已經回過這題的回饋」（只在記憶體，重啟就忘）。 */
const RECENT_REVEALS_MAX = 500;
const FEEDBACK_ACKED_MAX = 5000;
const BAD_REPORT_GAMES_MAX = 2000;

const NOOP = (): void => undefined;

export class SimEngine {
  private readonly store: SimSessionStore;
  private readonly limiter: SimRateLimiter;
  private readonly now: () => number;
  private readonly model: SimBeliefModel;
  private readonly random: (seed: string) => () => number;
  private readonly locks = new Map<string, Promise<void>>();
  readonly counts: SimCounts = emptySimCounts();
  /** `平台:聊天室` → 最近一次 /公布 的題目（玩家回饋用；只在記憶體）。 */
  private readonly recentReveals = new Map<string, { exerciseId: string; gameId: string; at: number }>();
  /** `題號|平台:使用者`：已經回過「收到」的。 */
  private readonly feedbackAcked = new Set<string>();
  /** 局號 → 說爛局的人（`平台:使用者`，雜湊）。 */
  private readonly badReporters = new Map<string, Set<string>>();

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
      { now: this.now, onChange: (hard): void => { opts.persistence?.touch(hard); } },
    );
    opts.persistence?.attach(this.store);
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
   * 這個後續指令（/派 /區間 /公布 /結束，含看不懂的 /派、/區間）會有題目接：自己的，或代答
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

  /** 這個引擎的存檔（狀態頁用）；沒有 = 只在記憶體。 */
  get persistence(): SimPersistence | undefined {
    return this.opts.persistence;
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
    return cmd ? this.handle(cmd, req) : this.feedbackFor(text, req);
  }

  /**
   * 不是指令的一句話：是不是對這個聊天室剛 /公布（或開著、剛被動過）的題目的回饋（feedback.ts）。是 → 記下來，
   * 同一個人同一題第一次回「收到，已記下這題的回饋」（之後照樣記、回 null）；不是 → null（照一般聊天）。
   * LINE 重送的事件不再記一次。原文只交給 feedbackSink，不寫 log。
   */
  feedbackFor(text: string, req: SimRequest): SimReply | null {
    if (!SIM_CONFIG.commandsEnabled || req.duplicate) return null;
    const kind = classifySimFeedback(text);
    if (!kind) return null;
    const now = this.now();
    const chatKey = chatKeyFor(req);
    const revealed = this.recentReveals.get(chatKey);
    const open = this.store.newestInChat(chatKey, now);
    const candidates = [
      revealed && now - revealed.at <= SIM_FEEDBACK_WINDOW_MS ? { exerciseId: revealed.exerciseId, gameId: revealed.gameId, at: revealed.at } : null,
      open && now - open.lastActiveAt <= SIM_FEEDBACK_WINDOW_MS ? { exerciseId: open.exerciseId, gameId: open.gameId, at: open.lastActiveAt } : null,
    ].filter((c): c is { exerciseId: string; gameId: string; at: number } => c !== null);
    if (candidates.length === 0) return null;
    const target = candidates.sort((a, b) => b.at - a.at)[0];
    const user = userKeyFor(req);
    let flagged = false;
    let reporters = this.badReporters.get(target.gameId)?.size ?? 0;
    if (kind === 'bad' && req.userId) {
      // 沒有使用者 id（LINE 群組沒給）時不算「不同的人」：只記錄，不算進要人看。
      let set = this.badReporters.get(target.gameId);
      if (!set) {
        set = new Set();
        this.badReporters.set(target.gameId, set);
        trimOldest(this.badReporters, BAD_REPORT_GAMES_MAX);
      }
      const before = set.size;
      set.add(user);
      reporters = set.size;
      flagged = before < SIM_FEEDBACK_FLAG_AT && reporters >= SIM_FEEDBACK_FLAG_AT;
    }
    this.counts.feedback.recorded += 1;
    if (kind === 'bad') this.counts.feedback.bad += 1;
    if (flagged) this.counts.feedback.flaggedGames += 1;
    const record: SimFeedbackRecord = {
      exerciseId: target.exerciseId,
      gameId: target.gameId,
      platform: req.platform,
      user: req.userId ? simIdHash(req.userId) : '*',
      at: now,
      kind,
      text: clipFeedbackText(text),
      badReporters: reporters,
      flagged,
    };
    try {
      this.opts.feedbackSink?.(record);
    } catch (err) {
      console.warn(`[sim] feedback sink failed (${err instanceof Error ? err.name : typeof err})`);
    }
    const ackKey = `${target.exerciseId}|${user}`;
    if (this.feedbackAcked.has(ackKey)) return null;
    return {
      text: SIM_FEEDBACK_ACK,
      kind: 'feedback',
      sessionOpen: false,
      commit: (): void => {
        this.feedbackAcked.add(ackKey);
        while (this.feedbackAcked.size > FEEDBACK_ACKED_MAX) {
          const oldest = this.feedbackAcked.values().next().value;
          if (oldest === undefined) break;
          this.feedbackAcked.delete(oldest);
        }
      },
    };
  }

  /**
   * 一個指令 → 回覆，或 null：不是給模擬的（聊天）、被限流（提醒過之後）、或 LINE 重送一個
   * 已經回過的事件。null 時呼叫端什麼都不送。
   */
  async handle(cmd: SimCommand, req: SimRequest): Promise<SimReply | null> {
    if (!SIM_CONFIG.commandsEnabled) return null;
    // 剛重啟、進行中的題目還在讀回來：先等一下；還沒好就請他再打一次（不能回「你沒有題目」——題目可能正要讀回來）。
    const persistence = this.opts.persistence;
    if (persistence && cmd.kind !== 'help') {
      const waitMs = this.opts.restoreWaitMs ?? SIM_RESTORE_WAIT_MS;
      if (!persistence.isReady()) {
        await atMost(persistence.restore(), waitMs);
        if (!persistence.isReady()) {
          // 看不懂的 /派、/區間（LINE 打字，可能只是聊天）照舊不回。
          if (cmd.kind === 'usage' && cmd.command !== 'start' && !req.explicit) return null;
          return { text: RESTORING_TEXT, kind: 'restoring', commit: NOOP, sessionOpen: false };
        }
      } else if (persistence.inHandover()) {
        // 剛開機的幾分鐘，舊的那台伺服器可能還在收指令：先看一眼存檔有沒有被它改過（沒改過就沒事）。
        // 最久等 2.5 秒（LINE 的 webhook 等太久會重送）；等不到就照手上的回答。
        await atMost(persistence.catchUp(), Math.min(waitMs, 2_500));
      }
    }
    // LINE 重送同一個事件，而第一次的回覆已經送出：不再回（也不走第二步）。在決定要動哪一題之前看：
    // 第一次的 /公布、/結束 已經把題目結束掉時，重送不會改指到這個聊天室的別題。
    const eventKey = req.eventKey ? simIdHash(req.eventKey) : undefined;
    if (req.duplicate && eventKey && this.store.eventAnswered(eventKey)) return null;
    const reply = await this.compute(cmd, req);
    if (!reply) return null;
    const ownKey = sessionKeyFor(req);
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
    if (cmd.kind === 'removed') {
      return this.reply(removedCommandText(cmd.command), 'removed', t, now, () => { this.counts.usage += 1; });
    }
    if (cmd.kind === 'usage' && (cmd.command === 'start' || !session)) {
      return this.reply(usageText(cmd.command, cmd.problem), 'usage', t, now, () => { this.counts.usage += 1; });
    }
    if (!session) {
      const ended = this.store.endedInfo(ownKey);
      return {
        text: ended ? endedNoticeText(ended.exerciseId, ended.reason) : this.noSessionText(),
        kind: 'no-session',
        commit: (): void => {
          this.counts.noSession += 1;
          // 講過一次自己的題目怎麼結束的；聊天室裡有別人的題目時，下一個指令起代答。
          // 沒能接回來的（'lost'）講過就忘掉：不然每一個指令都再講一次。
          if (t.endedNotice || ended?.reason === 'lost') this.store.forgetEnded(ownKey);
        },
        sessionOpen: false,
      };
    }
    const bank = await this.opts.bank();
    if (!bank) return { text: BANK_NOT_READY_TEXT, kind: 'bank', commit: NOOP, sessionOpen: true };
    const game = this.gameOf(bank, session);
    if (!game) {
      // 這一次開機開的題目對不到對局（不該發生）：照舊當成題庫還沒好，題目留著。
      if (session.game >= 0) return { text: BANK_NOT_READY_TEXT, kind: 'bank', commit: NOOP, sessionOpen: true };
      // 重啟後讀回來的題目，這一局已經不在題庫裡（題庫每晚重建）：講明沒能接回來，這一題結束。
      return {
        text: withCoAnswerMark(endedNoticeText(session.exerciseId, 'lost'), coAnswer),
        kind: 'no-session',
        sessionOpen: false,
        commit: (): void => {
          if (this.store.get(session.key, this.now())?.version !== session.version) return;
          this.store.delete(session.key);
          this.counts.noSession += 1;
        },
      };
    }
    const target: SimTarget & { session: SimSession } = { key: session.key, session, coAnswer };
    // 刺殺題只收 /刺 /公布 /結束（2026-11-16）；派票題不收 /刺。
    const pickOnly = ['propose', 'analyze', 'interval', 'read'].includes(cmd.kind) || (cmd.kind === 'usage' && cmd.command !== 'assassinate');
    if (session.assassin && pickOnly) {
      return this.reply(assassinOnlyText(session.exerciseId), 'usage', target, now, () => { this.counts.usage += 1; });
    }
    if (!session.assassin && (cmd.kind === 'assassinate' || (cmd.kind === 'usage' && cmd.command === 'assassinate'))) {
      return this.reply(notAssassinText(session.exerciseId), 'usage', target, now, () => { this.counts.usage += 1; });
    }
    switch (cmd.kind) {
      case 'usage':
        return this.reply(usageText(cmd.command, cmd.problem), 'usage', target, now, () => { this.counts.usage += 1; });
      case 'propose':
        return this.propose(cmd.team, game, target, now, req);
      case 'analyze':
        if (hidesResults(req)) return this.reply(withCoAnswerMark(analysisHiddenText(session.exerciseId), coAnswer), 'analyze', target, now, NOOP);
        return this.analyze(bank, game, target, req, now);
      case 'assassinate':
        return this.assassinate(cmd.seat, game, target, now, req);
      case 'interval':
        return this.interval(cmd.groups, game, target, now);
      case 'read':
        return this.read(game, target, now);
      case 'reveal':
        return this.reveal(game, target, bank.records.get(session.game), req, bank.names?.get(session.game));
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

  /** 沒有進行中的題目時怎麼說：有存檔 → 不提重啟；重啟前的題目沒能讀回來 → 講明伺服器更新過、怎麼重開。 */
  private noSessionText(): string {
    const p = this.opts.persistence;
    if (!p || !p.keeps()) return NO_SESSION_TEXT;
    const lostAt = p.lostAt();
    return lostAt === null ? NO_SESSION_KEPT_TEXT : restartLostText(lostAt);
  }

  /**
   * 這一題的對局。剛從存檔讀回來的題目（game = -1）照題庫代號重新對到索引，並確認存下來的位置在這一局裡還成立；
   * 對不到或對不上 → null（呼叫端講明這一題沒能接回來）。
   */
  private gameOf(bank: SimBank, session: SimSession): SimGame | null {
    if (session.game >= 0) return bank.games[session.game] ?? null;
    const index = bank.byId.get(session.gameId);
    const game = index === undefined ? undefined : bank.games[index];
    if (index === undefined || !game) return null;
    const events = publicEvents(game);
    const fits = game.seatRoles[session.seat - 1] === session.role
      && session.decision >= 0 && session.decision < game.proposals.length
      && [...session.answers.keys()].every((d) => d >= 0 && d < game.proposals.length)
      && (session.assassin ? session.cursor === events.length : events[session.cursor]?.kind === 'proposal');
    if (!fits) return null;
    // 同一個物件就地補上索引（不算一次變動，version 不動）。
    session.game = index;
    return game;
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
        }, !update);
      },
    };
  }

  private async start(cmd: Extract<SimCommand, { kind: 'start' }>, req: SimRequest, key: string, previous: SimSession | null, now: number): Promise<SimReply> {
    const bank = await this.opts.bank();
    if (!bank || bank.games.length === 0) return { text: BANK_NOT_READY_TEXT, kind: 'bank', commit: NOOP, sessionOpen: !!previous };
    // 選題的亂數種子用原本的 id（不存，只在這裡用一次）：跟雜湊前選到的題目一樣。
    const picked = selectStart(bank, { ...cmd, weekday: taipeiWeekday(now) }, this.random(`${req.platform}:${req.chatId}:${req.userId ?? '*'}:${now}`));
    if (!picked.ok) {
      let text: string;
      if (picked.reason === 'thin') text = thinPoolText(picked.role, picked.seat, picked.n, picked.available);
      else if (picked.reason === 'no-decision') text = noDecisionText(picked.seat);
      else if (picked.reason === 'no-stage') text = noStageText(picked.stage.round, picked.stage.attempt);
      else if (picked.reason === 'no-mid') text = noMidText(picked.round, picked.anyAttempt);
      else if (picked.reason === 'no-assassin') text = noAssassinText();
      else if (picked.reason === 'unknown-id') text = unknownIdText();
      else text = BANK_NOT_READY_TEXT;
      return { text, kind: 'select', commit: NOOP, sessionOpen: !!previous };
    }
    const game = bank.games[picked.game];
    const events = publicEvents(game);
    // 刺殺題：整局都看得到（游標在最後）。
    const cursor = picked.assassin ? events.length : eventIndexOfProposal(events, picked.decision);
    const view = viewAt(game, picked.seat, cursor, events);
    const exerciseId = exerciseIdOf(game.id, picked.seat, picked.stage, picked.assassin);
    const common = {
      exerciseId,
      game,
      seat: picked.seat,
      sight: view.sight,
      shown: view.events,
      platform: req.platform,
      replacedId: previous?.exerciseId,
      shared: !!req.shared,
      // Discord 公開頻道的 /派 /刺 /分析 只回給本人（discordCommand.simAnswerIsPrivate）；LINE 群組只回收到。
      ...(req.shared ? { resultsPrivate: req.platform === 'discord' } : {}),
      ...(picked.theme ? { theme: picked.theme } : {}),
      ...(picked.alsoWorth?.length ? { alsoWorth: picked.alsoWorth } : {}),
    };
    const text = picked.assassin ? formatAssassinStart(common) : formatStart({ ...common, decision: events[cursor] as ProposalEvent });
    const role = game.seatRoles[picked.seat - 1];
    return {
      text,
      kind: 'start',
      sessionOpen: true,
      commit: (): void => {
        this.store.set({
          key,
          chatKey: chatKeyFor(req),
          ...(req.userId ? { userKey: userKeyFor(req) } : {}),
          exerciseId,
          gameId: game.id,
          game: picked.game,
          seat: picked.seat,
          role,
          decision: picked.decision,
          cursor,
          answers: new Map(),
          phase: 'answering',
          ...(picked.assassin ? { assassin: true } : {}),
          startedAt: now,
          lastActiveAt: now,
          version: (previous?.version ?? 0) + 1,
        });
        this.counts.started[req.platform] += 1;
        this.counts.byRole[role] = (this.counts.byRole[role] ?? 0) + 1;
        if (picked.stage) this.counts.midStarts += 1;
        if (picked.assassin) this.counts.assassinStarts += 1;
        if (picked.theme) this.counts.todayStarts += 1;
      },
    };
  }

  /** /刺 座位：刺殺題的答案（最後一次算數），結果在 /公布。 */
  private assassinate(seat: number, game: SimGame, t: SimTarget & { session: SimSession }, now: number, req: SimRequest): SimReply {
    const { session } = t;
    const mates = viewAt(game, session.seat, session.cursor).sight;
    const teammates = mates.kind === 'evil' ? mates.mates : [];
    if (seat === session.seat || teammates.includes(seat)) {
      return this.reply(killTeammateText(seat, seat === session.seat), 'usage', t, now, () => { this.counts.usage += 1; });
    }
    const by = answererKey(req);
    const kills = session.kills ?? [];
    // 群組（LINE）：只回收到第幾位，刺誰也不回顯（題目公布前不讓後面的人看到別人的答案，2026-11-21）。
    const text = hidesResults(req)
      ? formatAnswerAck(session.exerciseId, ordinalOf(kills.map((k) => k.by), by), kills.filter((k) => k.by === by).length + 1, t.coAnswer)
      : formatKillAnswer(session.exerciseId, seat, t.coAnswer, privateNote(req));
    return this.reply(text, 'assassinate', t, now, () => { this.counts.kills += 1; }, (s) => ({
      kill: { target: seat, coAnswer: t.coAnswer },
      kills: [...(s.kills ?? []), { target: seat, coAnswer: t.coAnswer, by }].slice(-SIM_ANSWERS_PER_DECISION_TOTAL),
      phase: 'answered',
    }));
  }

  /**
   * /派：記下答案，只回「你派 469：2 好 1 壞」（Edward 2026-11-16）；完整解讀用 /分析。
   * 群組（2026-11-21，玩家回饋：第一個人一作答，答案就被大家看到）：LINE 群組只回「收到（第 N 位作答）」，
   * 幾好幾壞等 /公布 一起列；Discord 公開頻道的回覆改成只有本人看得到（privateReply），內容照舊。
   */
  private propose(team: number[], game: SimGame, t: SimTarget & { session: SimSession }, now: number, req: SimRequest): SimReply {
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
    const reds = team.filter((s) => isRed(game.seatRoles[s - 1])).length;
    const by = answererKey(req);
    const before = session.answers.get(session.decision) ?? [];
    const text = hidesResults(req)
      ? formatAnswerAck(session.exerciseId, ordinalOf(before.map((a) => a.by), by), before.filter((a) => a.by === by).length + 1, t.coAnswer)
      : formatProposeResult({ exerciseId: session.exerciseId, team, goods: team.length - reds, reds, coAnswer: t.coAnswer, privateNote: privateNote(req) });
    const same = maskOf(team) === maskOf(decision.teamSeats);
    return this.reply(text, 'propose', t, now, () => {
      this.counts.answers += 1;
      if (same) this.counts.sameAsReal += 1;
    }, (s) => {
      const answers = new Map(s.answers);
      answers.set(s.decision, keepRecentAnswers([...(answers.get(s.decision) ?? []), { team: [...team], coAnswer: t.coAnswer, by }]));
      return { answers, phase: 'answered' };
    });
  }

  /** /分析：這個決定點最後一次 /派 的完整解讀（①④③②；2026-11-16 以前是 /派 的回覆）。 */
  private analyze(bank: SimBank, game: SimGame, t: SimTarget & { session: SimSession }, req: SimRequest, now: number): SimReply {
    const { session } = t;
    const last = session.answers.get(session.decision)?.slice(-1)[0];
    if (!last) return this.reply(withCoAnswerMark(noAnalysisText(session.exerciseId), t.coAnswer), 'analyze', t, now, NOOP);
    const team = last.team;
    const events = publicEvents(game);
    const cursor = eventIndexOfProposal(events, session.decision);
    const decision = events[cursor] as ProposalEvent;
    const view = viewAt(game, session.seat, cursor, events);
    const realQuest = decision.approved
      ? events.find((e): e is Extract<PublicEvent, { kind: 'quest' }> => e.kind === 'quest' && e.round === decision.round)
      : undefined;
    const human = humanAggFor(bank.humans, game, session.decision);
    const mine = proposalFeatures(game, session.decision, team);
    const camps = campShares(bank.humans, game, session.decision, mine.shape);
    const prevEvent = [...view.events].reverse().find((e): e is ProposalEvent => e.kind === 'proposal');
    const logic = logicPanel(view, this.model);
    // 你寫過 /區間 的話，照你的區間（用現在看得到的資訊重算）你的隊伍全好有幾種。
    const own = session.interval && session.interval.length > 0 ? evaluateInterval(view, session.interval, this.model) : undefined;
    const text = formatAnalysis(
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
        ...(own ? {
          ownInterval: {
            worlds: own.jointWorlds.length,
            clean: teamCleanUnder(own.jointWorlds, team),
            // 你自己寫的才說「你寫的」：代答寫的、或這次是代答，都說「這題目前的區間」。
            yours: !t.coAnswer && !session.intervalByCoAnswer,
          },
        } : {}),
        coAnswer: t.coAnswer,
      },
      { sight: view.sight, shown: view.events, ownLakes: view.ownLakes },
    );
    return this.reply(text, 'analyze', t, now, () => { this.counts.analyses += 1; });
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

  private read(game: SimGame, t: SimTarget & { session: SimSession }, now: number): SimReply {
    const { session } = t;
    const text = formatAiRead(session.exerciseId, session.seat, aiReading(game, session.seat, session.decision), t.coAnswer);
    return this.reply(text, 'read', t, now, () => { this.counts.aiReads += 1; });
  }

  /** 百科AI 在這題那一刻會派（刺）的前幾種；沒設定、算不出來或丟錯 → null（/公布 照常，只是少那一行）。 */
  private async revealAiPicks(game: SimGame, session: SimSession): Promise<AiPicks | null> {
    const fn = this.opts.aiPicks;
    if (!fn) return null;
    try {
      const point: AiPickPoint = session.assassin ? { kind: 'assassination' } : { kind: 'team_select', proposal: session.decision };
      return await fn(game, session.seat, point);
    } catch (err) {
      console.warn(`[sim] /公布 AI picks failed (${err instanceof Error ? err.name : typeof err})`);
      return null;
    }
  }

  private async reveal(game: SimGame, t: SimTarget & { session: SimSession }, postId: string | undefined, req: SimRequest, seatNames?: readonly string[]): Promise<SimReply> {
    const { session } = t;
    const ai = await this.revealAiPicks(game, session);
    const events = publicEvents(game);
    const answers = [...session.answers.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([d, teams]) => ({ decision: events[eventIndexOfProposal(events, d)] as ProposalEvent, teams }));
    const everyone = req.shared ? everyoneAnswers(game, session, events) : [];
    const text = formatReveal({
      exerciseId: session.exerciseId,
      game,
      seat: session.seat,
      answers,
      interval: session.interval,
      intervalWorlds: session.intervalWorlds,
      // 標「（代答）」看誰寫的；「你的／這題目前的」看誰在看（代答者看到的一律是「這題目前的」）。
      intervalYours: !t.coAnswer && !session.intervalByCoAnswer,
      intervalByCoAnswer: !!session.intervalByCoAnswer,
      ...(postId ? { recordUrl: recordUrl(postId) } : {}),
      ...(seatNames ? { seatNames } : {}),
      ...(session.assassin ? { kill: { target: session.kill?.target ?? null, coAnswer: !!session.kill?.coAnswer } } : {}),
      // 大家都看得到的聊天室（2026-11-21）：作答時沒有公開結果，公布時列出每一位的答案和結果。
      ...(everyone.length > 0 ? { everyone } : {}),
      ...(ai ? { aiPicks: ai } : {}),
      platform: req.platform,
      coAnswer: t.coAnswer,
    });
    const redMask = maskOf(game.seatRoles.map((r, i) => (isRed(r) ? i + 1 : 0)).filter(Boolean));
    return {
      text,
      kind: 'reveal',
      sessionOpen: false,
      image: { game, title: session.exerciseId, ...(seatNames ? { names: seatNames } : {}) },
      commit: (): void => {
        const current = this.store.get(session.key, this.now());
        if (!current || current.version !== session.version) return;
        this.store.delete(session.key);
        this.counts.reveals += 1;
        // 玩家回饋（feedback.ts）：記得這個聊天室剛公布了哪一題。
        const chatKey = chatKeyFor(req);
        this.recentReveals.delete(chatKey);
        this.recentReveals.set(chatKey, { exerciseId: session.exerciseId, gameId: session.gameId, at: this.now() });
        trimOldest(this.recentReveals, RECENT_REVEALS_MAX);
        if (t.coAnswer) this.counts.coAnswers += 1;
        for (const g of session.interval ?? []) {
          this.counts.intervalGroupsTotal += 1;
          if (intervalGroupTrue(g, redMask)) this.counts.intervalGroupsRight += 1;
        }
      },
    };
  }
}

/** Map 超過 `max` 筆就丟掉最早放進去的。 */
function trimOldest<K, V>(map: Map<K, V>, max: number): void {
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest as K);
  }
}

/** 等 `p`，最久 `ms` 毫秒（到時間就不等了，`p` 照樣繼續）。 */
async function atMost(p: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([p, new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); timer.unref?.(); })]);
  if (timer) clearTimeout(timer);
}

/** 作答的人（`平台:使用者`，雜湊；LINE 群組事件沒有使用者 id 時大家共用 `*`）。只用來數第幾位，不寫進任何回覆。 */
function answererKey(req: Pick<SimRequest, 'platform' | 'userId'>): string {
  return userKeyFor(req);
}

/** 這個聊天室大家都看得到回覆、又不能只回給本人（LINE 群組）：作答只回收到，結果等 /公布（2026-11-21）。 */
export function hidesResults(req: Pick<SimRequest, 'shared' | 'privateReply'>): boolean {
  return !!req.shared && !req.privateReply;
}

/** 公開頻道裡只有本人看得到的回覆（Discord）：回覆多一句說明。 */
function privateNote(req: Pick<SimRequest, 'shared' | 'privateReply'>): boolean {
  return !!req.shared && !!req.privateReply;
}

/** `by` 是第幾位作答的人（照第一次作答的順序，1 起算；還沒答過 = 下一位）。 */
function ordinalOf(previous: readonly (string | undefined)[], by: string): number {
  const order: string[] = [];
  for (const b of previous) if (b !== undefined && !order.includes(b)) order.push(b);
  const i = order.indexOf(by);
  return i < 0 ? order.length + 1 : i + 1;
}

/** 每個人最多留最近 SIM_ANSWERS_PER_DECISION 次，全部最多 SIM_ANSWERS_PER_DECISION_TOTAL 次。 */
function keepRecentAnswers(list: readonly SimAnswer[]): SimAnswer[] {
  const kept: SimAnswer[] = [];
  const perPerson = new Map<string, number>();
  for (let i = list.length - 1; i >= 0 && kept.length < SIM_ANSWERS_PER_DECISION_TOTAL; i--) {
    const k = list[i].by ?? '';
    const n = perPerson.get(k) ?? 0;
    if (n >= SIM_ANSWERS_PER_DECISION) continue;
    perPerson.set(k, n + 1);
    kept.push(list[i]);
  }
  return kept.reverse();
}

/** /公布 要列的每一位的答案（照第一次作答的順序）：派票題每一次 /派 的幾好幾壞，刺殺題最後一次 /刺。 */
function everyoneAnswers(game: SimGame, session: SimSession, events: readonly PublicEvent[]): EveryoneAnswer[] {
  const order: string[] = [];
  const add = (by: string | undefined): string => {
    const k = by ?? '';
    if (!order.includes(k)) order.push(k);
    return k;
  };
  if (session.assassin) {
    const last = new Map<string, number>();
    for (const k of session.kills ?? []) last.set(add(k.by), k.target);
    const merlin = game.seatRoles.indexOf('merlin') + 1;
    return order.map((k) => ({ kill: { target: last.get(k) as number, hit: last.get(k) === merlin } }));
  }
  const decision = events[eventIndexOfProposal(events, session.decision)] as ProposalEvent;
  const teams = new Map<string, EveryoneAnswer['teams']>();
  for (const a of session.answers.get(session.decision) ?? []) {
    const k = add(a.by);
    const reds = a.team.filter((s) => isRed(game.seatRoles[s - 1])).length;
    teams.set(k, [...(teams.get(k) ?? []), { team: a.team, goods: a.team.length - reds, reds, sameAsReal: maskOf(a.team) === maskOf(decision.teamSeats) }]);
  }
  return order.map((k) => ({ teams: teams.get(k) ?? [] }));
}
