/**
 * 遊戲內回饋 — 收集（站長 2026-11-26：「遊戲中的對話你也記得讀取並學習 有可能是玩家對你玩法的反饋」）。
 *
 * 以前網站房間聊天（GameServer.handleChatMessage）只廣播、不留，百科AI 這邊看不到玩家對它玩法的反應。現在：
 *   - 有百科AI 坐的局（練習房除外：練習有自己的「這步怪怪的」，而且練習局一律不記錄），開局起把真人的聊天
 *     留在記憶體（每局最多 300 句、每句最多 500 字），每句帶當時的階段、第幾局任務、第幾次派隊、說話的座位；
 *     系統訊息、百科AI 自己的話不收。局後聊天也收，到房間關掉或結束後 15 分鐘為止。
 *   - 每句用 keywords.ts 判斷是不是對百科AI 玩法的回饋（很保守）。是 → 等它後面再有 3 句（或 2 分鐘、或這局收掉），
 *     連同**前後各 3 句當脈絡**轉到站長的管理員頻道（跟 /意見、模擬瓦回饋同一個地方：bots/feedback/service.ts），格式
 *     `📮 遊戲內回饋（房間 ab12cd，第1局任務3・投票，4家→提到 3家百科AI）` 下面一句一行「N家：…」，被挑出的那句前面標 ▶
 *     ——沒有名字、沒有 id，只有座位；每局最多轉 5 則（之後的只算 throttled，照樣寫進試算表）。
 *     （站長 2026-11-26：「百科AI 的問題回饋有時候是一個整體 而不是單一個決策點 所以之後你接受回饋的方式應該是用描述性跟對話性的方式 開放式的」）
 *   - 這一局收完（局後 15 分鐘、房間關了、開了下一局、或開局超過 6 小時）→ 有回饋的話寫**一列**進私人試算表的
 *     「遊戲內回饋」分頁（sheetWriter.ts）：整局被挑出的話連同前後脈絡串成一段對話（▶ 標被挑出的那句），
 *     那時角色已公開，才寫被提到的百科AI 的角色；然後記憶體裡的整局丟掉。
 *   - 聊天內容從不寫 log、不進公開 repo；/api/bots/status 只有數字（feedback.inGame）。
 * INGAME_FEEDBACK=off（false／0／no）整個關掉（每局開局時讀）。
 */

import type { GameState } from '@avalon/shared';
import { describeError, type FeedbackForwardOutcome } from '../bots/feedback/service';
import { neutralizeMentions } from '../practice/PracticeReportDiscord';
import { ROLE_LABEL_ZH, seatLabelZh } from '../practice/types';
import { formatTaipeiTime } from '../practice/PracticeReportWriter';
import { classifyInGameFeedback, type InGameFeedbackHit, type InGameFeedbackReason } from './keywords';
import type { InGameFeedbackSink, SheetRow } from './sheetWriter';

/** 每局最多留幾句。 */
export const IN_GAME_CHAT_MAX_MESSAGES = 300;
/** 每句最多留幾個字。 */
export const IN_GAME_CHAT_MAX_CHARS = 500;
/** 局後聊天收多久。 */
export const IN_GAME_POST_GAME_MS = 15 * 60_000;
/** 每局最多轉幾則到管理員頻道。 */
export const IN_GAME_MAX_FORWARDS_PER_GAME = 5;
/** 開局超過這麼久還沒收完（例如房間卡住）就收掉。 */
export const IN_GAME_STALE_MS = 6 * 60 * 60_000;
/** 同時最多看幾局（超過就先收掉最舊的）。 */
export const IN_GAME_MAX_OPEN_GAMES = 200;
/** 轉到管理員頻道的那一則，原文最多幾個字。 */
export const IN_GAME_FORWARD_TEXT_MAX = 300;
/** 脈絡：被挑出的那句前後各幾句。 */
export const IN_GAME_CONTEXT_LINES = 3;
/** 脈絡句（不是被挑出的那句）在管理員頻道最多幾個字。 */
export const IN_GAME_CONTEXT_TEXT_MAX = 120;
/** 被挑出後最多等多久（等後面的脈絡）就轉貼。 */
export const IN_GAME_FORWARD_WAIT_MS = 2 * 60_000;
/** 試算表那一格（整局對話）最多幾個字。 */
export const IN_GAME_NARRATIVE_MAX = 40_000;

/** INGAME_FEEDBACK：預設開；off / false / 0 / no 關。 */
export function inGameFeedbackEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.INGAME_FEEDBACK ?? '').trim().toLowerCase();
  return !['off', 'false', '0', 'no', 'none'].includes(raw);
}

export const PHASE_LABEL_ZH: Readonly<Record<GameState, string>> = Object.freeze({
  lobby: '開局前',
  voting: '派隊投票',
  quest: '出任務',
  lady_of_the_lake: '湖中',
  discussion: '刺殺',
  ended: '局後',
});

const REASON_LABEL_ZH: Readonly<Record<InGameFeedbackReason, string>> = Object.freeze({
  'bot-word': '講到百科AI',
  'bot-seat': '講到百科AI 的座位',
  judgement: '評價玩法',
  question: '問為什麼這樣玩',
});

/** 一句聊天當下的局面（GameServer 給）。 */
export interface InGameChatInput {
  /** 說話的座位（1–10）。 */
  seat: number;
  text: string;
  phase: GameState;
  /** 第幾局任務（1–5）。 */
  round: number;
  /** 這局任務第幾次派隊（1–5）。 */
  proposal: number;
  /** 這一輪隊長是百科AI。 */
  leaderIsBot: boolean;
}

interface CapturedMessage extends Omit<InGameChatInput, 'leaderIsBot'> {
  at: number;
  /** 這局第幾句（從 0 起；記憶體只留最近 300 句，用它找前後文）。 */
  seq: number;
  hit: InGameFeedbackHit | null;
}

/** 等後面脈絡的轉貼。 */
interface PendingForward {
  msg: CapturedMessage & { hit: InGameFeedbackHit };
}

interface GameCapture {
  roomId: string;
  gameNo: number;
  startedAt: number;
  botSeats: number[];
  seatCount: number;
  messages: CapturedMessage[];
  /** 這局收過幾句（下一句的 seq）。 */
  nextSeq: number;
  flagged: CapturedMessage[];
  forwards: number;
  pending: PendingForward[];
  closeAt: number | null;
  /** 局後才有：百科AI 座位 → 角色（英文 id）。 */
  botRoles: Record<number, string>;
}

/** /api/bots/status → feedback.inGame。只有數字。 */
export interface InGameFeedbackStats {
  enabled: boolean;
  /** 收過的局（有百科AI、不是練習房）。 */
  capturedGames: number;
  /** 現在還開著的局。 */
  openGames: number;
  /** 收進來的真人聊天句數。 */
  messages: number;
  /** 判斷成對百科AI 玩法的回饋。 */
  flagged: number;
  /** 送去管理員頻道（送出結果在 feedback.inGameForwards）。 */
  forwarded: number;
  /** 超過每局上限沒送的。 */
  throttled: number;
  /** 試算表：寫入狀態、寫了幾列、失敗幾次。 */
  sheet: { status: string; rows: number; failed: number };
}

export interface InGameChatCaptureOptions {
  /** 送一則到管理員頻道（預設：bots/feedback 的 FeedbackService）。 */
  forward?: (content: string) => Promise<FeedbackForwardOutcome>;
  /** 試算表（沒有 → 不寫）；status 給狀態頁。 */
  sink?: InGameFeedbackSink | null;
  sinkStatus?: string;
  now?: () => number;
  enabled?: () => boolean;
  /** 只收固定文字。 */
  logger?: { warn: (msg: string) => void };
}

/** 「3家、7家百科AI」／「百科AI」／「沒指名」。 */
function mentionLabel(hit: InGameFeedbackHit): string {
  if (hit.botSeats.length > 0) return `${hit.botSeats.map(seatLabelZh).join('、')}百科AI`;
  return hit.genericBot ? '百科AI' : '沒指名';
}

function clipChars(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text;
}

function whereLabel(gameNo: number, m: Pick<CapturedMessage, 'phase' | 'round'>): string {
  return m.phase === 'ended' ? `第${gameNo}局・局後` : `第${gameNo}局任務${m.round}・${PHASE_LABEL_ZH[m.phase]}`;
}

/** 被挑出的那句前後各 N 句（記憶體裡還有的）。 */
export function contextAround(
  messages: readonly CapturedMessage[],
  msg: CapturedMessage,
  n: number = IN_GAME_CONTEXT_LINES,
): { before: CapturedMessage[]; after: CapturedMessage[] } {
  const i = messages.indexOf(msg);
  if (i < 0) return { before: [], after: [] };
  return { before: messages.slice(Math.max(0, i - n), i), after: messages.slice(i + 1, i + 1 + n) };
}

/**
 * 管理員頻道那一則：標題一行，下面一句一行「N家：…」，被挑出的那句前面標 ▶。沒有名字、沒有 id。
 * `context` 不給 → 只有那一句。
 */
export function formatInGameForward(
  roomId: string,
  gameNo: number,
  m: CapturedMessage & { hit: InGameFeedbackHit },
  context: { before: CapturedMessage[]; after: CapturedMessage[] } = { before: [], after: [] },
): string {
  const line = (x: CapturedMessage, flagged: boolean): string =>
    `${flagged ? '▶ ' : '\u3000 '}${seatLabelZh(x.seat)}：${neutralizeMentions(clipChars(x.text, flagged ? IN_GAME_FORWARD_TEXT_MAX : IN_GAME_CONTEXT_TEXT_MAX))}`;
  return [
    `📮 遊戲內回饋（房間 ${roomId}，${whereLabel(gameNo, m)}，${seatLabelZh(m.seat)}→提到 ${mentionLabel(m.hit)}）`,
    ...context.before.map((x) => line(x, false)),
    line(m, true),
    ...context.after.map((x) => line(x, false)),
  ].join('\n');
}

/**
 * 整局對話：被挑出的每一句前後各 3 句，重疊的併成一段；段落之間「……」；局面（第幾局任務、階段）換了就加一行【…】。
 * 被挑出的那句「▶ N家：…（提到 …・類型）」，脈絡句前面是一個全形空白（\u3000）再接「N家：…」。
 */
export function narrativeFor(g: Pick<GameCapture, 'gameNo' | 'messages' | 'flagged'>): string {
  const flaggedSet = new Set(g.flagged);
  const windows: Array<[number, number]> = [];
  const orphans: CapturedMessage[] = [];
  for (const m of g.flagged) {
    const i = g.messages.indexOf(m);
    if (i < 0) { orphans.push(m); continue; }
    const lo = Math.max(0, i - IN_GAME_CONTEXT_LINES);
    const hi = Math.min(g.messages.length - 1, i + IN_GAME_CONTEXT_LINES);
    const last = windows[windows.length - 1];
    if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
    else windows.push([lo, hi]);
  }
  const segments: CapturedMessage[][] = [
    ...orphans.map((m) => [m]),
    ...windows.map(([lo, hi]) => g.messages.slice(lo, hi + 1)),
  ];
  const out: string[] = [];
  let lastWhere = '';
  for (const seg of segments) {
    if (out.length > 0) out.push('……');
    lastWhere = '';
    for (const m of seg) {
      const where = whereLabel(g.gameNo, m);
      if (where !== lastWhere) { out.push(`【${where}】`); lastWhere = where; }
      if (flaggedSet.has(m) && m.hit) {
        out.push(`▶ ${seatLabelZh(m.seat)}：${m.text}（提到 ${mentionLabel(m.hit)}・${REASON_LABEL_ZH[m.hit.reason]}）`);
      } else {
        out.push(`\u3000 ${seatLabelZh(m.seat)}：${m.text}`);
      }
    }
  }
  return clipChars(out.join('\n'), IN_GAME_NARRATIVE_MAX);
}

function uniq(items: string[]): string[] {
  return [...new Set(items.filter(Boolean))];
}

/** 試算表的列：一局一列（跟 IN_GAME_FEEDBACK_HEADER 同順序）。 */
export function sheetRowsFor(g: GameCapture): SheetRow[] {
  if (g.flagged.length === 0) return [];
  const hits = g.flagged.map((m) => m.hit as InGameFeedbackHit);
  const roles = uniq(hits.flatMap((hit) => hit.botSeats.map((s) => {
    const r = g.botRoles[s];
    return r ? `${seatLabelZh(s)}${ROLE_LABEL_ZH[r] ?? r}` : '';
  })));
  return [[
    formatTaipeiTime(g.flagged[0].at),
    g.roomId,
    g.gameNo,
    g.botSeats.map(seatLabelZh).join('、'),
    g.flagged.length,
    uniq(g.flagged.map((m) => PHASE_LABEL_ZH[m.phase])).join('、'),
    uniq(hits.map(mentionLabel)).join('、'),
    roles.join('、'),
    uniq(hits.map((h) => REASON_LABEL_ZH[h.reason])).join('、'),
    narrativeFor(g),
  ]];
}

export class InGameChatCapture {
  private readonly games = new Map<string, GameCapture>();
  /** 每個房間開過幾局（第N局）。 */
  private readonly gamesPerRoom = new Map<string, number>();
  private readonly forward: (content: string) => Promise<FeedbackForwardOutcome>;
  private readonly sink: InGameFeedbackSink | null;
  private readonly sinkStatus: string;
  private readonly now: () => number;
  private readonly enabled: () => boolean;
  private readonly logger: { warn: (msg: string) => void };
  private readonly counts = { capturedGames: 0, messages: 0, flagged: 0, forwarded: 0, throttled: 0 };
  private readonly sheetCounts = { rows: 0, failed: 0 };

  constructor(opts: InGameChatCaptureOptions = {}) {
    this.forward = opts.forward ?? ((): Promise<FeedbackForwardOutcome> => Promise.resolve('skipped'));
    this.sink = opts.sink ?? null;
    this.sinkStatus = opts.sinkStatus ?? (this.sink ? 'ok' : 'none');
    this.now = opts.now ?? Date.now;
    this.enabled = opts.enabled ?? ((): boolean => inGameFeedbackEnabled());
    // eslint-disable-next-line no-console
    this.logger = opts.logger ?? { warn: (m): void => console.warn(`[in-game-feedback] ${m}`) };
  }

  /** 開局：有百科AI 才開始收（先收掉這個房間上一局）。 */
  startGame(roomId: string, info: { botSeats: number[]; seatCount: number }): void {
    this.closeGame(roomId);
    const gameNo = (this.gamesPerRoom.get(roomId) ?? 0) + 1;
    this.gamesPerRoom.set(roomId, gameNo);
    if (info.botSeats.length === 0 || !this.enabled()) return;
    if (this.games.size >= IN_GAME_MAX_OPEN_GAMES) {
      const oldest = [...this.games.values()].sort((a, b) => a.startedAt - b.startedAt)[0];
      if (oldest) this.closeGame(oldest.roomId);
    }
    this.games.set(roomId, {
      roomId,
      gameNo,
      startedAt: this.now(),
      botSeats: [...info.botSeats].sort((a, b) => a - b),
      seatCount: info.seatCount,
      messages: [],
      nextSeq: 0,
      flagged: [],
      forwards: 0,
      pending: [],
      closeAt: null,
      botRoles: {},
    });
    this.counts.capturedGames += 1;
  }

  /** 這個房間現在有沒有在收。 */
  isCapturing(roomId: string): boolean {
    const g = this.games.get(roomId);
    return !!g && (g.closeAt === null || this.now() < g.closeAt);
  }

  /** 這一局記憶體裡留著幾句（測試用）。 */
  heldMessages(roomId: string): number {
    return this.games.get(roomId)?.messages.length ?? 0;
  }

  /** 一句真人聊天；是回饋 → 回判斷結果（也已經送出／排進試算表），不是 → null。從不丟錯。 */
  onChat(roomId: string, input: InGameChatInput): InGameFeedbackHit | null {
    try {
      const g = this.games.get(roomId);
      if (!g) return null;
      const now = this.now();
      if (g.closeAt !== null && now >= g.closeAt) {
        this.closeGame(roomId);
        return null;
      }
      const chars = [...(input.text ?? '').trim()];
      if (chars.length === 0) return null;
      const text = chars.length > IN_GAME_CHAT_MAX_CHARS ? chars.slice(0, IN_GAME_CHAT_MAX_CHARS).join('') : chars.join('');
      // 局後（房間回到開局前也算局後，直到收完）。
      const postGame = input.phase === 'ended' || g.closeAt !== null;
      const phase: GameState = postGame ? 'ended' : input.phase;
      const hit = classifyInGameFeedback(text, {
        botSeats: g.botSeats,
        postGame,
        leaderIsBot: input.leaderIsBot,
        seatCount: g.seatCount,
      });
      const msg: CapturedMessage = {
        at: now, seq: g.nextSeq, text, phase, seat: input.seat, round: input.round, proposal: input.proposal, hit,
      };
      g.nextSeq += 1;
      g.messages.push(msg);
      if (g.messages.length > IN_GAME_CHAT_MAX_MESSAGES) g.messages.shift();
      this.counts.messages += 1;
      // 之前被挑出、在等後面脈絡的：後面已經有 3 句 → 轉貼。
      this.flushPending(g, (p) => msg.seq - p.msg.seq >= IN_GAME_CONTEXT_LINES);
      if (!hit) return null;
      if (g.flagged.length >= IN_GAME_CHAT_MAX_MESSAGES) return hit;
      g.flagged.push(msg);
      this.counts.flagged += 1;
      if (g.forwards >= IN_GAME_MAX_FORWARDS_PER_GAME) {
        this.counts.throttled += 1;
        return hit;
      }
      g.forwards += 1;
      this.counts.forwarded += 1;
      // 等後面的脈絡（再 3 句、2 分鐘、或這局收掉）才轉貼。
      g.pending.push({ msg: msg as CapturedMessage & { hit: InGameFeedbackHit } });
      return hit;
    } catch (err) {
      this.logger.warn(`onChat failed: ${describeError(err)}`);
      return null;
    }
  }

  /** 送出符合條件的等待中轉貼（連同前後脈絡）。 */
  private flushPending(g: GameCapture, ready: (p: PendingForward) => boolean): void {
    if (g.pending.length === 0) return;
    const keep: PendingForward[] = [];
    for (const p of g.pending) {
      if (!ready(p)) { keep.push(p); continue; }
      const content = formatInGameForward(g.roomId, g.gameNo, p.msg, contextAround(g.messages, p.msg));
      void this.forward(content).catch((err: unknown) => {
        this.logger.warn(`forward failed: ${describeError(err)}`);
      });
    }
    g.pending = keep;
  }

  /** 遊戲結束：記下百科AI 的角色，局後聊天再收 15 分鐘。 */
  endGame(roomId: string, botRoles: Record<number, string>): void {
    const g = this.games.get(roomId);
    if (!g || g.closeAt !== null) return;
    g.botRoles = { ...botRoles };
    g.closeAt = this.now() + IN_GAME_POST_GAME_MS;
  }

  /** 定期叫：收掉過了局後時間、房間已經沒了、或開太久的局；忘掉已經沒了的房間。 */
  sweep(roomAlive: (roomId: string) => boolean): void {
    const now = this.now();
    for (const g of [...this.games.values()]) {
      this.flushPending(g, (p) => now - p.msg.at >= IN_GAME_FORWARD_WAIT_MS);
      const done = (g.closeAt !== null && now >= g.closeAt) || !roomAlive(g.roomId) || now - g.startedAt > IN_GAME_STALE_MS;
      if (done) this.closeGame(g.roomId);
    }
    for (const roomId of [...this.gamesPerRoom.keys()]) {
      if (!this.games.has(roomId) && !roomAlive(roomId)) this.gamesPerRoom.delete(roomId);
    }
  }

  /** 收掉一局：有回饋就寫進試算表，然後整局從記憶體丟掉。 */
  closeGame(roomId: string): Promise<void> {
    const g = this.games.get(roomId);
    if (!g) return Promise.resolve();
    this.games.delete(roomId);
    this.flushPending(g, () => true);
    if (g.flagged.length === 0 || !this.sink) return Promise.resolve();
    const rows = sheetRowsFor(g);
    return this.sink.appendRows(rows).then(
      () => { this.sheetCounts.rows += rows.length; },
      (err: unknown) => {
        this.sheetCounts.failed += 1;
        this.logger.warn(`sheet append failed: ${describeError(err)}`);
      },
    );
  }

  snapshot(): InGameFeedbackStats {
    return {
      enabled: this.enabled(),
      ...this.counts,
      openGames: this.games.size,
      sheet: { status: this.sinkStatus, ...this.sheetCounts },
    };
  }
}
