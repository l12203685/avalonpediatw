/**
 * 模擬瓦（2026-10-14）— 進行中的題目：記憶體裡的 session、期限、上限與每個指令的狀態轉移。
 *
 * Edward 2026-10-14：「Line bot/dc bot 有辦法支援模擬瓦嗎? 不是練習局
 * 模擬瓦比較像是練習邏輯思考跟派隊資訊的釋放與解讀」。
 *
 *   - 一人一個聊天室一題（key = 平台:聊天室:使用者；LINE 群組事件沒有 userId 時整個聊天室共用一題）。
 *     新的 /模擬 取代舊的，回覆第一行講明。
 *   - 閒置 30 分鐘（SIM_SESSION_TTL_MINUTES）自動結束，不論如何 2 小時結束；最多 500 題（最久沒動的先結束），
 *     同一個聊天室最多 30 題；每人 10 分鐘最多 30 個模擬指令，超過提醒一次後不回。
 *   - 不存檔：部署或重啟就清空（每天約 03:47 +08 快取更新會重新部署）。
 *   - **送出後才算數**：handle() 回 `{ text, commit }`，呼叫端確定回覆送出後才呼叫 commit()，
 *     回覆失敗不會跳過一步。LINE 重送（同一個事件）直接重送上一則回覆，不會走兩步。
 *   - 打的字、答案、區間只在這裡的記憶體；log 只有固定文字（這個檔案沒有 log）。
 */

import type { Role } from '@avalon/shared';
import { seededRandom } from '../../ai/benchmark/agreement';
import type { SimBank } from './bank';
import { parseSimCommand, type IntervalGroup, type SimCommand } from './commands';
import {
  SIM_CONFIG,
  SIM_MAX_SESSIONS,
  SIM_MAX_SESSIONS_PER_CHAT,
  SIM_RATE_LIMIT_MAX,
  SIM_RATE_LIMIT_WINDOW_MS,
  SIM_SESSION_HARD_CAP_MS,
  simBeliefModelId,
  simSessionTtlMs,
} from './config';
import { humanAggFor, proposalFeatures } from './human';
import { beliefModelFor, type SimBeliefModel } from './logic';
import { emptySimCounts, type SimCounts } from './metrics';
import { evaluateInterval, intervalGroupTrue, logicPanel, readableProposals, releasePanel, type ProposalEvent } from './reading';
import {
  BANK_NOT_READY_TEXT,
  NO_SESSION_TEXT,
  RATE_LIMITED_TEXT,
  endedText,
  formatInterval,
  formatNext,
  formatProposeFeedback,
  formatReveal,
  formatStart,
  noDecisionText,
  noMoreDecisionsText,
  thinPoolText,
  unknownIdText,
  usageText,
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

export interface SimSession {
  key: string;
  /** `平台:聊天室`（同一聊天室的上限用）。 */
  chatKey: string;
  exerciseId: string;
  game: number;
  seat: number;
  role: Role;
  /** 目前（或最後一個）決定：proposals[] 的索引。 */
  decision: number;
  /** 已經顯示的公開事件數。 */
  cursor: number;
  /** 決定 → 你派的隊伍。 */
  answers: Map<number, number[]>;
  interval?: IntervalGroup[];
  /** 最後一次 /區間 留下的世界（公布時對答案）。 */
  intervalWorlds?: number[];
  phase: SimPhase;
  /** 「之後照實際對局進行」已經講過。 */
  notedReplay: boolean;
  /** LINE 重送：同一個事件重送這則，不再走一步。 */
  lastReply?: { eventKey: string; text: string };
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
}

export type SimReplyKind =
  | 'start' | 'propose' | 'interval' | 'next' | 'reveal' | 'end'
  | 'usage' | 'no-session' | 'bank' | 'select' | 'rate-limited' | 'resend' | 'no-more';

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

// ─── 儲存 ─────────────────────────────────────────────────────────────────

export interface SimStoreOptions {
  ttlMs: number;
  hardCapMs: number;
  maxSessions: number;
  maxPerChat: number;
}

/** Map 的順序 = 最近使用的在最後（LRU）。 */
export class SimSessionStore {
  private readonly sessions = new Map<string, SimSession>();

  constructor(private readonly opts: SimStoreOptions, private readonly onExpire: () => void = () => undefined) {}

  private expired(s: SimSession, now: number): boolean {
    return now - s.lastActiveAt > this.opts.ttlMs || now - s.startedAt > this.opts.hardCapMs;
  }

  /** 清掉過期的（每次指令都順便做，最多 500 個，很便宜）。 */
  sweep(now: number): void {
    for (const [key, s] of this.sessions) {
      if (this.expired(s, now)) {
        this.sessions.delete(key);
        this.onExpire();
      }
    }
  }

  get(key: string, now: number): SimSession | null {
    this.sweep(now);
    return this.sessions.get(key) ?? null;
  }

  /** 放進去（放到最後 = 最近使用）；超過上限就結束最久沒動的。 */
  set(session: SimSession): void {
    this.sessions.delete(session.key);
    this.sessions.set(session.key, session);
    const sameChat = [...this.sessions.values()].filter((s) => s.chatKey === session.chatKey);
    for (let i = 0; i < sameChat.length - this.opts.maxPerChat; i++) this.sessions.delete(sameChat[i].key);
    while (this.sessions.size > this.opts.maxSessions) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
  }

  delete(key: string): void {
    this.sessions.delete(key);
  }

  size(): number {
    return this.sessions.size;
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
  rateLimit?: { windowMs: number; max: number };
  model?: SimBeliefModel;
  /** 選題亂數（測試可以固定）。 */
  random?: (seed: string) => () => number;
}

const NOOP = (): void => undefined;

export class SimEngine {
  private readonly store: SimSessionStore;
  private readonly limiter: SimRateLimiter;
  private readonly now: () => number;
  private readonly model: SimBeliefModel;
  private readonly random: (seed: string) => () => number;
  readonly counts: SimCounts = emptySimCounts();

  constructor(private readonly opts: SimEngineOptions) {
    this.now = opts.now ?? Date.now;
    this.store = new SimSessionStore(
      {
        ttlMs: opts.ttlMs ?? simSessionTtlMs(),
        hardCapMs: opts.hardCapMs ?? SIM_SESSION_HARD_CAP_MS,
        maxSessions: opts.maxSessions ?? SIM_MAX_SESSIONS,
        maxPerChat: opts.maxPerChat ?? SIM_MAX_SESSIONS_PER_CHAT,
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

  get beliefModelId(): string {
    return this.model.id;
  }

  /** 狀態頁用：目前的世界模型有沒有算派票行為（v1 false）。 */
  get weighsBehaviour(): boolean {
    return this.model.weighsBehaviour;
  }

  /** LINE：一段文字 → 回覆，或 null（不是模擬指令／不該回）。 */
  async handleText(text: string, req: SimRequest): Promise<SimReply | null> {
    if (!SIM_CONFIG.commandsEnabled) return null;
    const cmd = parseSimCommand(text);
    return cmd ? this.handle(cmd, req) : null;
  }

  async handle(cmd: SimCommand, req: SimRequest): Promise<SimReply | null> {
    if (!SIM_CONFIG.commandsEnabled) return null;
    const now = this.now();
    const key = sessionKeyFor(req);
    const session = this.store.get(key, now);

    // LINE 重送同一個事件：重送上一則，不走第二步。
    if (req.duplicate && req.eventKey && session?.lastReply?.eventKey === req.eventKey) {
      return { text: session.lastReply.text, kind: 'resend', commit: NOOP, sessionOpen: true };
    }

    // 看不懂的 /派、/區間 又沒有題目：當作一般聊天（例如 /派西 2）。
    if (cmd.kind === 'usage' && cmd.command !== 'start' && !session) return null;

    const rate = this.limiter.hit(`${req.platform}:${req.userId ?? req.chatId}`, now);
    if (rate !== 'ok') {
      this.counts.rateLimited += 1;
      return rate === 'notify' ? { text: RATE_LIMITED_TEXT, kind: 'rate-limited', commit: NOOP, sessionOpen: !!session } : null;
    }

    if (cmd.kind === 'start') return this.start(cmd, req, key, session, now);
    if (cmd.kind === 'usage' && cmd.command === 'start') {
      return this.reply(usageText('start', cmd.problem), 'usage', session, req, now, () => { this.counts.usage += 1; });
    }
    if (!session) {
      return { text: NO_SESSION_TEXT, kind: 'no-session', commit: (): void => { this.counts.noSession += 1; }, sessionOpen: false };
    }
    const bank = await this.opts.bank();
    if (!bank || !bank.games[session.game]) {
      return { text: BANK_NOT_READY_TEXT, kind: 'bank', commit: NOOP, sessionOpen: true };
    }
    const game = bank.games[session.game];
    switch (cmd.kind) {
      case 'usage':
        return this.reply(usageText(cmd.command, cmd.problem), 'usage', session, req, now, () => { this.counts.usage += 1; });
      case 'propose':
        return this.propose(cmd.team, bank, game, session, req, now);
      case 'interval':
        return this.interval(cmd.groups, game, session, req, now);
      case 'next':
        return this.next(game, session, req, now);
      case 'reveal':
        return this.reveal(game, session);
      case 'end':
        return {
          text: endedText(session.exerciseId),
          kind: 'end',
          sessionOpen: false,
          commit: (): void => {
            if (this.store.get(key, this.now())?.version !== session.version) return;
            this.store.delete(key);
            this.counts.ended += 1;
          },
        };
    }
  }

  /** 綁在一題上的回覆：commit 時更新 lastActiveAt / lastReply（以及 `update` 的狀態）。 */
  private reply(
    text: string,
    kind: SimReplyKind,
    session: SimSession | null,
    req: SimRequest,
    now: number,
    count: () => void,
    update?: (s: SimSession) => Partial<SimSession>,
  ): SimReply {
    return {
      text,
      kind,
      sessionOpen: !!session,
      commit: (): void => {
        if (!session) { count(); return; }
        const current = this.store.get(session.key, this.now());
        // 這段回覆算出來之後，這一題已經變了（例如連按兩次 /下一步）：不再套用，也不計數。
        if (!current || current.version !== session.version) return;
        count();
        this.store.set({
          ...current,
          ...(update ? update(current) : {}),
          lastActiveAt: now,
          lastReply: req.eventKey ? { eventKey: req.eventKey, text } : undefined,
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
          exerciseId,
          game: picked.game,
          seat: picked.seat,
          role,
          decision: picked.decision,
          cursor,
          answers: new Map(),
          phase: 'answering',
          notedReplay: false,
          lastReply: req.eventKey ? { eventKey: req.eventKey, text } : undefined,
          startedAt: now,
          lastActiveAt: now,
          version: (previous?.version ?? 0) + 1,
        });
        this.counts.started[req.platform] += 1;
        this.counts.byRole[role] = (this.counts.byRole[role] ?? 0) + 1;
      },
    };
  }

  private propose(team: number[], bank: SimBank, game: SimGame, session: SimSession, req: SimRequest, now: number): SimReply {
    if (session.phase === 'no-more-decisions') {
      return this.reply(noMoreDecisionsText(session.exerciseId), 'no-more', session, req, now, NOOP);
    }
    const events = publicEvents(game);
    const decision = events[session.cursor] as ProposalEvent;
    const size = TEAM_SIZES[decision.round - 1];
    if (team.length !== size) {
      return this.reply(wrongSizeText(size, team.length), 'usage', session, req, now, () => { this.counts.usage += 1; });
    }
    const view = viewAt(game, session.seat, session.cursor, events);
    const realQuest = decision.approved
      ? events.find((e): e is Extract<PublicEvent, { kind: 'quest' }> => e.kind === 'quest' && e.round === decision.round)
      : undefined;
    const human = humanAggFor(bank.humans, game, session.decision);
    const mine = proposalFeatures(game, session.decision, team);
    const prevEvent = [...view.events].reverse().find((e): e is ProposalEvent => e.kind === 'proposal');
    const merlinShare = session.role === 'merlin' && human.agg.hitsN > 0 ? (human.agg.hitsN - human.agg.hits[0]) / human.agg.hitsN : undefined;
    const text = formatProposeFeedback(
      {
        exerciseId: session.exerciseId,
        game,
        seat: session.seat,
        decision,
        team,
        realQuest,
        human: { agg: human.agg, mine, prev: prevEvent },
        logic: logicPanel(view, this.model),
        release: releasePanel(view, team),
        platform: req.platform,
      },
      { sight: view.sight, shown: view.events, ownLakes: view.ownLakes, humanMerlinShare: merlinShare },
    );
    const same = maskOf(team) === maskOf(decision.teamSeats);
    return this.reply(text, 'propose', session, req, now, () => {
      this.counts.answers += 1;
      if (same) this.counts.sameAsReal += 1;
    }, (s) => {
      const answers = new Map(s.answers);
      answers.set(s.decision, [...team]);
      return { answers, phase: 'answered' };
    });
  }

  private interval(groups: IntervalGroup[], game: SimGame, session: SimSession, req: SimRequest, now: number): SimReply {
    const view = viewAt(game, session.seat, session.cursor);
    const ev = evaluateInterval(view, groups, this.model);
    const text = formatInterval(session.exerciseId, ev, this.model);
    return this.reply(text, 'interval', session, req, now, () => { this.counts.intervals += 1; }, () => ({
      interval: groups.map((g) => ({ ...g, seats: [...g.seats] })),
      intervalWorlds: ev.jointWorlds,
    }));
  }

  private next(game: SimGame, session: SimSession, req: SimRequest, now: number): SimReply {
    if (session.phase === 'no-more-decisions') {
      return this.reply(noMoreDecisionsText(session.exerciseId), 'no-more', session, req, now, NOOP);
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
    });
    return this.reply(text, 'next', session, req, now, () => { this.counts.steps += 1; }, () => (
      nextIndex === null
        ? { cursor: events.length, phase: 'no-more-decisions', notedReplay: true }
        : { cursor: nextCursor, decision: nextIndex, phase: 'answering', notedReplay: true }
    ));
  }

  private reveal(game: SimGame, session: SimSession): SimReply {
    const events = publicEvents(game);
    const decisionCursor = eventIndexOfProposal(events, session.decision);
    const readable = readableProposals(viewAt(game, session.seat, decisionCursor, events));
    const answers = [...session.answers.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([d, team]) => ({ decision: events[eventIndexOfProposal(events, d)] as ProposalEvent, team }));
    const text = formatReveal({
      exerciseId: session.exerciseId,
      game,
      seat: session.seat,
      answers,
      interval: session.interval,
      intervalWorlds: session.intervalWorlds,
      readable,
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
        for (const g of session.interval ?? []) {
          this.counts.intervalGroupsTotal += 1;
          if (intervalGroupTrue(g, redMask)) this.counts.intervalGroupsRight += 1;
        }
      },
    };
  }
}
