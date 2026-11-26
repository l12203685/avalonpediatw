/**
 * 遊戲內回饋 — 收集（站長 2026-11-26：「遊戲中的對話你也記得讀取並學習 有可能是玩家對你玩法的反饋」）。
 *
 * 以前網站房間聊天（GameServer.handleChatMessage）只廣播、不留，百科AI 這邊看不到玩家對它玩法的反應。現在：
 *   - 有百科AI 坐的局（練習房除外：練習有自己的「這步怪怪的」，而且練習局一律不記錄），開局起把真人的聊天
 *     留在記憶體（每局最多 300 句、每句最多 500 字），每句帶當時的階段、第幾局任務、第幾次派隊、說話的座位；
 *     系統訊息、百科AI 自己的話不收。局後聊天也收，到房間關掉或結束後 15 分鐘為止。
 *   - 每句用 keywords.ts 判斷是不是對百科AI 玩法的回饋（很保守）。是 → 轉到站長的管理員頻道
 *     （跟 /意見、模擬瓦回饋同一個地方：bots/feedback/service.ts），格式
 *     `📮 遊戲內回饋（房間 ab12cd，第1局任務3・投票，4家→提到 3家百科AI）：…`——沒有名字、沒有 id，只有座位；
 *     每局最多轉 5 則（之後的只算 throttled，照樣寫進試算表）。
 *   - 這一局收完（局後 15 分鐘、房間關了、開了下一局、或開局超過 6 小時）→ 有回饋的話一次寫進私人試算表的
 *     「遊戲內回饋」分頁（sheetWriter.ts；那時角色已公開，才寫被提到的百科AI 的角色），然後記憶體裡的整局丟掉。
 *   - 聊天內容從不寫 log、不進公開 repo；/api/bots/status 只有數字（feedback.inGame）。
 * INGAME_FEEDBACK=off（false／0／no）整個關掉（每局開局時讀）。
 */

import type { GameState } from '@avalon/shared';
import { describeError, type FeedbackForwardOutcome } from '../bots/feedback/service';
import { neutralizeMentions } from '../practice/PracticeReportDiscord';
import { ROLE_LABEL_ZH, seatLabelZh } from '../practice/types';
import { formatTaipeiTime } from '../practice/PracticeReportWriter';
import { classifyInGameFeedback, type InGameFeedbackHit, type InGameFeedbackReason } from './keywords';
import { clipCell, type InGameFeedbackSink, type SheetRow } from './sheetWriter';

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
  hit: InGameFeedbackHit | null;
}

interface GameCapture {
  roomId: string;
  gameNo: number;
  startedAt: number;
  botSeats: number[];
  seatCount: number;
  messages: CapturedMessage[];
  flagged: CapturedMessage[];
  forwards: number;
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

/** 管理員頻道那一則。 */
export function formatInGameForward(roomId: string, gameNo: number, m: CapturedMessage & { hit: InGameFeedbackHit }): string {
  const where = m.phase === 'ended' ? `第${gameNo}局・局後` : `第${gameNo}局任務${m.round}・${PHASE_LABEL_ZH[m.phase]}`;
  const text = neutralizeMentions([...m.text].length > IN_GAME_FORWARD_TEXT_MAX
    ? `${[...m.text].slice(0, IN_GAME_FORWARD_TEXT_MAX - 1).join('')}…`
    : m.text);
  return `📮 遊戲內回饋（房間 ${roomId}，${where}，${seatLabelZh(m.seat)}→提到 ${mentionLabel(m.hit)}）：${text}`;
}

/** 試算表的列（跟 IN_GAME_FEEDBACK_HEADER 同順序）。 */
export function sheetRowsFor(g: GameCapture): SheetRow[] {
  return g.flagged.map((m) => {
    const hit = m.hit as InGameFeedbackHit;
    const roles = hit.botSeats.map((s) => {
      const r = g.botRoles[s];
      return r ? `${seatLabelZh(s)}${ROLE_LABEL_ZH[r] ?? r}` : '';
    }).filter(Boolean);
    return [
      formatTaipeiTime(m.at),
      g.roomId,
      g.gameNo,
      PHASE_LABEL_ZH[m.phase],
      m.phase === 'ended' ? '' : m.round,
      m.phase === 'ended' ? '' : m.proposal,
      seatLabelZh(m.seat),
      mentionLabel(hit),
      roles.join('、'),
      REASON_LABEL_ZH[hit.reason],
      g.botSeats.map(seatLabelZh).join('、'),
      g.flagged.length,
      clipCell(m.text),
    ];
  });
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
      flagged: [],
      forwards: 0,
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
      const hit = classifyInGameFeedback(text, {
        botSeats: g.botSeats,
        postGame: input.phase === 'ended',
        leaderIsBot: input.leaderIsBot,
        seatCount: g.seatCount,
      });
      const msg: CapturedMessage = {
        at: now, seat: input.seat, text, phase: input.phase, round: input.round, proposal: input.proposal, hit,
      };
      g.messages.push(msg);
      if (g.messages.length > IN_GAME_CHAT_MAX_MESSAGES) g.messages.shift();
      this.counts.messages += 1;
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
      const content = formatInGameForward(g.roomId, g.gameNo, { ...msg, hit });
      void this.forward(content).catch((err: unknown) => {
        this.logger.warn(`forward failed: ${describeError(err)}`);
      });
      return hit;
    } catch (err) {
      this.logger.warn(`onChat failed: ${describeError(err)}`);
      return null;
    }
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
