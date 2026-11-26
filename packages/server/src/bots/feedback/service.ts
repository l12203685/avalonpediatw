/**
 * FeedbackService — the one place that (a) counts topics heard in the
 * community and (b) handles the /意見 command: fixed acknowledgement, plus a
 * copy of the opinion text posted to a Discord channel the owner reads.
 *
 * What leaves this process: ONLY the opinion text the person explicitly
 * typed after /意見, posted to Discord as `📮 意見（LINE）：…` without any
 * name or id, in the owner's admin channel (feedback/config.ts). Ordinary chatter never leaves as text — it is reduced to topic
 * counts (TopicCounter) and exposed as numbers on /api/bots/status.
 * Nothing here logs message content — not even inside an error object
 * (see describeError).
 *
 * (2026-10-14 Edward：練習回報「要」也貼到大劍管理員) The same Discord sender
 * also carries the practice mode's 「這步怪怪的」 reports to the same channel
 * (practice/PracticeReportDiscord.ts: own hourly cap and counters, shown as
 * feedback.practiceReports on /api/bots/status; PRACTICE_REPORT_DISCORD=false
 * turns that copy off).
 */

import {
  FEEDBACK_ACK_TEXT,
  FEEDBACK_CONFIG,
  FEEDBACK_MAX_FORWARDS_PER_HOUR,
  FEEDBACK_USAGE_TEXT,
  resolveFeedbackChannelId,
  type FeedbackPlatform,
} from './config';
import { formatFeedbackForward, parseFeedbackCommand } from './commands';
import { OPINION_TOPIC_ID, TopicCounter, type TopicWeekSnapshot } from './topicCounter';
import { parseStatsCommand } from '../stats/textCommands';
import { isSimCommandText } from '../simulation/commands';
import { isSeatFillerCommandText } from '../seatFiller/commands';
import { isPaipuFixCommandText } from '../paipuFix/commands';
import { isCommunityCommandText } from '../reports/commands';
import { isDailyQuestionCommandText } from '../dailyQuestion/commands';
import { formatSimFeedbackForward, type SimFeedbackRecord } from '../simulation/feedback';

/** What the service hands to Discord: content + no pings, ever. */
export interface FeedbackForwardPayload {
  content: string;
  allowedMentions: { parse: [] };
}

/**
 * Minimal Discord sender so tests inject a mock and bots/index.ts injects the
 * real discord.js channel. Resolve false when the channel is unavailable.
 */
export interface FeedbackDiscordForwarder {
  send(channelId: string, payload: FeedbackForwardPayload): Promise<boolean>;
}

export type FeedbackForwardOutcome = 'sent' | 'skipped' | 'failed' | 'throttled' | 'none';

export interface FeedbackSubmitResult {
  /** False when the content was empty (nothing counted, usage hint returned). */
  accepted: boolean;
  /** Text to send back to the person. */
  reply: string;
  /**
   * How the Discord forward ended. It resolves LATER and never rejects: the
   * reply must not wait for Discord REST (a LINE reply_token expires in
   * about a minute and the webhook has to answer 200 promptly, while
   * discord.js can retry a stalled request for ~60 s). Callers that only
   * need the reply ignore it; tests and the deferred Discord slash handler
   * may await it.
   */
  forwarded: Promise<FeedbackForwardOutcome>;
}

/** /api/bots/status → feedback. Numbers only. */
export interface FeedbackSnapshot {
  weeks: TopicWeekSnapshot[];
  opinions: { line: number; discord: number };
  /**
   * 模擬瓦的玩家回饋（2026-11-26，simulation/feedback.ts）轉到管理員頻道的結果：送出幾則、沒送（沒有頻道／Discord 沒連上）、
   * 失敗、超過每小時上限。跟 /意見 共用頻道和每小時上限。
   */
  simFeedback: { sent: number; skipped: number; failed: number; throttled: number };
  /**
   * 網站房間聊天裡對百科AI 玩法的回饋（2026-11-26，src/inGameFeedback）轉到管理員頻道的結果。跟 /意見 共用頻道和每小時上限；
   * 每局自己的上限在 inGameFeedback（那裡的 throttled 另算，在 feedback.inGame）。
   */
  inGameForwards: { sent: number; skipped: number; failed: number; throttled: number };
}

export interface FeedbackServiceOptions {
  counter?: TopicCounter;
  discord?: FeedbackDiscordForwarder;
  /** Channel id resolver; defaults to the env lookup in config.ts (read per call). */
  channelId?: () => string;
  maxForwardsPerHour?: number;
  now?: () => number;
  /** Receives fixed reason strings only — never message text, never a raw error object. */
  logger?: { warn: (msg: string) => void; error: (msg: string) => void };
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * Name / code / status / message of an error as one short string — never the
 * object itself. discord.js' DiscordAPIError carries the request body (i.e.
 * the forwarded opinion) as an own enumerable `requestBody` property, so
 * handing the raw error to console.error would print the text into the
 * server log. The message is capped; Discord's own messages name fields
 * ("content[BASE_TYPE_MAX_LENGTH]"), not values.
 */
export function describeError(err: unknown): string {
  if (typeof err !== 'object' || err === null) return typeof err; // a thrown primitive: its type, never its value
  const e = err as { name?: unknown; code?: unknown; status?: unknown; message?: unknown; constructor?: { name?: string } };
  const name = typeof e.name === 'string' && e.name ? e.name : e.constructor?.name || 'object';
  const parts = [
    name,
    e.code !== undefined ? `code=${String(e.code)}` : '',
    e.status !== undefined ? `status=${String(e.status)}` : '',
    typeof e.message === 'string' ? e.message.slice(0, 200) : '',
  ];
  return parts.filter(Boolean).join(' ');
}

export class FeedbackService {
  private readonly counter: TopicCounter;
  private discord?: FeedbackDiscordForwarder;
  private readonly channelId: () => string;
  private readonly maxForwardsPerHour: number;
  private readonly now: () => number;
  private readonly logger: NonNullable<FeedbackServiceOptions['logger']>;
  private readonly opinions = { line: 0, discord: 0 };
  private readonly simFeedback = { sent: 0, skipped: 0, failed: 0, throttled: 0 };
  private readonly inGameForwards = { sent: 0, skipped: 0, failed: 0, throttled: 0 };
  /** Epoch ms of forwards in the last hour (for the global flood cap). */
  private forwardTimes: number[] = [];

  constructor(opts: FeedbackServiceOptions = {}) {
    this.counter = opts.counter ?? new TopicCounter({ now: opts.now });
    this.discord = opts.discord;
    this.channelId = opts.channelId ?? resolveFeedbackChannelId;
    this.maxForwardsPerHour = opts.maxForwardsPerHour ?? FEEDBACK_MAX_FORWARDS_PER_HOUR;
    this.now = opts.now ?? Date.now;
    this.logger = opts.logger ?? {
      warn: (m): void => console.warn(`[feedback] ${m}`),
      error: (m): void => console.error(`[feedback] ${m}`),
    };
  }

  /** Late-bind the Discord sender (bots/index.ts, after the Discord bot exists). */
  setDiscordForwarder(forwarder: FeedbackDiscordForwarder | undefined): void {
    this.discord = forwarder;
  }

  /**
   * The Discord sender attached by bots/index.ts (undefined until then). (2026-10-14 Edward：練習回報
   * 也貼到大劍管理員) practice/PracticeReportDiscord.ts posts 「這步怪怪的」 reports with it, to the
   * same channel, with its own hourly cap and counters.
   */
  getDiscordForwarder(): FeedbackDiscordForwarder | undefined {
    return this.discord;
  }

  /**
   * Count the topics a human message touches. The text is read once and
   * dropped. Texts the bot answers as commands are usage, not reactions, so
   * they are skipped:
   *   - a stats command (/戰績 /排行 /默契 /指令), a 模擬瓦 command or a
   *     補位機器人 command (/補位 /機器人補位) or /待修正 — otherwise every LINE
   *     lookup would bump its own topic while Discord's slash commands never
   *     reach here, and the two platforms would not be comparable;
   *   - on LINE, "/意見 …" while the command is on: `submit()` counts it
   *     (keywords + 意見), so a group message and its submission never count
   *     twice. On Discord only the slash command submits, so a typed
   *     "/意見 …" there is ordinary chatter and its keywords count here.
   */
  observe(platform: FeedbackPlatform, text: string): string[] {
    try {
      if (parseStatsCommand(text)) return [];
      // 模擬瓦 (2026-10-14) commands are usage, not reactions.
      if (isSimCommandText(text)) return [];
      // 補位機器人 (2026-11-03): /補位 /機器人補位 are usage too.
      if (isSeatFillerCommandText(text)) return [];
      // 待修正牌譜清單 (2026-11-09): /待修正 /牌譜待修正 are usage too.
      if (isPaipuFixCommandText(text)) return [];
      // 每日一題 (2026-11-25): /每日一題 is a lookup, not a reaction.
      if (isDailyQuestionCommandText(text)) return [];
      // 百科回報／ID 認領 (2026-11-09): /回報 /認領 are submissions, not reactions.
      if (isCommunityCommandText(text)) return [];
      if (platform === 'line' && FEEDBACK_CONFIG.commandEnabled && parseFeedbackCommand(text)) return [];
      return this.counter.observe(platform, text);
    } catch (err) {
      this.logger.error(`observe failed: ${describeError(err)}`);
      return [];
    }
  }

  /**
   * Handle one /意見 submission: count it, acknowledge, forward the text to
   * the owner's Discord channel. Never throws, and the returned reply never
   * waits for Discord — the forward runs detached (see
   * FeedbackSubmitResult.forwarded) so the chat reply goes out promptly even
   * when Discord is down, slow or rate-limited.
   */
  async submit(platform: FeedbackPlatform, rawContent: string): Promise<FeedbackSubmitResult> {
    const content = (rawContent ?? '').trim();
    if (!content) return { accepted: false, reply: FEEDBACK_USAGE_TEXT, forwarded: Promise.resolve('none') };

    this.opinions[platform] += 1;
    this.counter.bump(platform, OPINION_TOPIC_ID);
    this.counter.observe(platform, content);

    // forward() handles its own failures; the catch only guards the
    // synchronous part (channel lookup / formatting) so nothing can reject.
    const forwarded = this.forward(platform, content).catch((err: unknown): FeedbackForwardOutcome => {
      this.logger.error(`forwarding opinion from ${platform} to Discord failed: ${describeError(err)}`);
      return 'failed';
    });
    return { accepted: true, reply: FEEDBACK_ACK_TEXT, forwarded };
  }

  /**
   * 模擬瓦的玩家回饋（站長 2026-11-26「玩家如果反饋是爛局或是吐槽的內容記得記錄下來」，simulation/feedback.ts）：
   * 跟 /意見 同一個地方——管理員頻道「大劍管理員」（FEEDBACK_DISCORD_CHANNEL_ID 可改），格式
   * `🎲 模擬瓦回饋（LINE）｜…`，沒有名字、使用者只有雜湊、不 @ 人；同一則裡帶題號、時間和原文。
   * 不等 Discord、從不丟錯；log 只有固定文字。結果只算數字（snapshot().simFeedback）。
   */
  recordSimFeedback(record: SimFeedbackRecord): Promise<FeedbackForwardOutcome> {
    const content = formatSimFeedbackForward(record);
    return this.send(record.platform, content, 'sim feedback')
      .catch((err: unknown): FeedbackForwardOutcome => {
        this.logger.error(`forwarding sim feedback failed: ${describeError(err)}`);
        return 'failed';
      })
      .then((outcome) => {
        if (outcome !== 'none') this.simFeedback[outcome] += 1;
        return outcome;
      });
  }

  /**
   * 網站遊戲內回饋（站長 2026-11-26「遊戲中的對話你也記得讀取並學習 有可能是玩家對你玩法的反饋」，src/inGameFeedback）：
   * 已經排好格式的一則（`📮 遊戲內回饋（房間…，第N局任務M，K家→提到 …）：…`，只有座位、沒有名字和 id）送到同一個管理員頻道。
   * 不等 Discord、從不丟錯；log 只有固定文字。結果只算數字（snapshot().inGameForwards）。
   */
  recordInGameFeedback(content: string): Promise<FeedbackForwardOutcome> {
    return this.send('site', content, 'in-game feedback')
      .catch((err: unknown): FeedbackForwardOutcome => {
        this.logger.error(`forwarding in-game feedback failed: ${describeError(err)}`);
        return 'failed';
      })
      .then((outcome) => {
        if (outcome !== 'none') this.inGameForwards[outcome] += 1;
        return outcome;
      });
  }

  snapshot(): FeedbackSnapshot {
    return {
      weeks: this.counter.snapshot(),
      opinions: { ...this.opinions },
      simFeedback: { ...this.simFeedback },
      inGameForwards: { ...this.inGameForwards },
    };
  }

  private forward(platform: FeedbackPlatform, content: string): Promise<FeedbackForwardOutcome> {
    return this.send(platform, formatFeedbackForward(platform, content), 'opinion');
  }

  /** 一則（已經排好格式的）文字送到管理員頻道：頻道、每小時上限、失敗時還回額度，/意見 和模擬瓦回饋共用。 */
  private async send(platform: FeedbackPlatform | 'site', content: string, what: string): Promise<FeedbackForwardOutcome> {
    const channelId = this.channelId();
    if (!channelId || !this.discord) {
      this.logger.warn(`${what} from ${platform} acknowledged but not forwarded (no Discord channel / sender)`);
      return 'skipped';
    }
    const now = this.now();
    this.forwardTimes = this.forwardTimes.filter((t) => now - t < HOUR_MS);
    if (this.forwardTimes.length >= this.maxForwardsPerHour) {
      this.logger.warn(`${what} from ${platform} not forwarded: hourly cap (${this.maxForwardsPerHour}) reached`);
      return 'throttled';
    }
    // Reserve the slot before the send (forwards run concurrently) and give
    // it back when nothing was posted, so a Discord outage — e.g. the gateway
    // not ready yet after a Render cold start — cannot eat the hourly cap and
    // lock out real opinions for the next hour.
    this.forwardTimes.push(now);
    try {
      const ok = await this.discord.send(channelId, {
        content,
        allowedMentions: { parse: [] },
      });
      if (!ok) {
        this.releaseForwardSlot(now);
        this.logger.warn(`${what} from ${platform} not forwarded: Discord channel unavailable`);
        return 'failed';
      }
      return 'sent';
    } catch (err) {
      this.releaseForwardSlot(now);
      this.logger.error(`forwarding ${what} from ${platform} to Discord threw: ${describeError(err)}`);
      return 'failed';
    }
  }

  private releaseForwardSlot(at: number): void {
    const i = this.forwardTimes.lastIndexOf(at);
    if (i >= 0) this.forwardTimes.splice(i, 1);
  }
}

// ─── Text-command entry point (LINE) ─────────────────────────────────────

/**
 * Reply text for a typed `/意見 …` message, or null when `text` is not that
 * command or the flag is off (the caller then keeps its normal behaviour).
 *
 * `redelivery`: LINE re-sent an event this process already handled (our
 * first answer was not a prompt 200). Answer again — the first reply may
 * never have gone out — but count and forward nothing a second time.
 */
export async function answerFeedbackTextCommand(
  text: string,
  platform: FeedbackPlatform = 'line',
  opts: { redelivery?: boolean } = {},
): Promise<string | null> {
  if (!FEEDBACK_CONFIG.commandEnabled) return null;
  const cmd = parseFeedbackCommand(text);
  if (!cmd) return null;
  if (opts.redelivery) return cmd.content ? FEEDBACK_ACK_TEXT : FEEDBACK_USAGE_TEXT;
  const result = await getFeedbackService().submit(platform, cmd.content);
  return result.reply;
}

// ─── Singleton ───────────────────────────────────────────────────────────

let instance: FeedbackService | null = null;

/** Process-wide service; created lazily (without a Discord sender) so callers never see null. */
export function getFeedbackService(): FeedbackService {
  if (!instance) instance = new FeedbackService();
  return instance;
}

/** Attach the real Discord sender once the bot exists (bots/index.ts). Idempotent. */
export function initializeFeedback(opts: { discord?: FeedbackDiscordForwarder } = {}): FeedbackService {
  const svc = getFeedbackService();
  if (opts.discord) svc.setDiscordForwarder(opts.discord);
  return svc;
}

/** Test-only: drop the singleton so each test starts from zero counts. */
export function __resetFeedbackForTests(): void {
  instance = null;
}
