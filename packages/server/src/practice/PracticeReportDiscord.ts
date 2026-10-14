/**
 * 「這步怪怪的」 → also a short post in the Discord admin channel 「大劍管理員」.
 *
 * (2026-10-14 Edward：練習模式「這步怪怪的」回報「要」也貼到管理員頻道 大劍管理員)
 * Every report that was saved to the private sheet tab 練習回報 (PracticeReportWriter)
 * is also posted to the channel the /意見 feedback goes to, with the same sender and
 * the same channel choice (bots/feedback):
 *   sender  — the FeedbackService's Discord forwarder (bots/index.ts attaches it once
 *             the Discord bot exists; read on every report, so the gateway may come up
 *             after boot);
 *   channel — resolveFeedbackChannelId(): FEEDBACK_DISCORD_CHANNEL_ID when set, else
 *             DEFAULT_FEEDBACK_DISCORD_CHANNEL_ID (大劍管理員); off → not posted.
 *
 * What leaves this process: the practice room id, round / proposal, the bot's seat,
 * role, decision type and action, its reason (clipped) and the player's note (clipped,
 * @everyone / @here / user / role mentions neutralised, and allowedMentions none so
 * nothing can ping) — never the player's name or account id.
 *
 * The sheet stays the record: the copy is posted only after the sheet write worked
 * (a failed write is retried by the player and must not post twice), detached so the
 * player's acknowledgement never waits for Discord. Rate-limited per rolling hour
 * (its own cap, so practice reports and /意見 cannot starve each other); every outcome
 * is counted for /api/bots/status (feedback.practiceReports); failures are logged as
 * fixed reasons — never the text, never a raw error object — and nothing throws.
 *
 * Env: PRACTICE_REPORT_DISCORD=false / 0 / off / no turns the Discord copy off
 * (default on; read on every report). docs/PRACTICE_MODE.md.
 */
import {
  describeError,
  getFeedbackService,
  resolveFeedbackChannelId,
  truncateFeedbackContent,
  type FeedbackDiscordForwarder,
} from '../bots/feedback';
import type { PracticeFlagRow } from './PracticeReportWriter';
import { DECISION_KIND_LABEL_ZH, ROLE_LABEL_ZH, seatLabelZh } from './types';

/** Copies posted per rolling hour at most (the same cap as /意見, counted separately). */
export const PRACTICE_REPORT_DISCORD_MAX_PER_HOUR = 30;

/** Characters kept of the player's note / the bot's reason / the bot's action in the post. */
export const PRACTICE_REPORT_DISCORD_NOTE_MAX = 300;
export const PRACTICE_REPORT_DISCORD_REASON_MAX = 300;
const ACTION_MAX = 120;

export type PracticeReportCopyOutcome = 'sent' | 'disabled' | 'skipped' | 'failed' | 'throttled';

/** /api/bots/status → feedback.practiceReports. Numbers and one flag only. */
export interface PracticeReportDiscordStats {
  /** PRACTICE_REPORT_DISCORD is not off. */
  enabled: boolean;
  /** Posted to the channel. */
  sent: number;
  /** Not posted: no channel (FEEDBACK_DISCORD_CHANNEL_ID=off) or no Discord sender yet. */
  skipped: number;
  /** Not posted: the channel was unavailable or Discord refused / threw. */
  failed: number;
  /** Not posted: the hourly cap was reached. */
  throttled: number;
}

/** What GameServer needs: post a copy of a saved report; resolves, never rejects. */
export interface PracticeReportCopy {
  forward(row: PracticeFlagRow): Promise<PracticeReportCopyOutcome>;
}

const OFF = ['false', '0', 'off', 'no'];

/** PRACTICE_REPORT_DISCORD: default on; false / 0 / off / no turns the Discord copy off. */
export function isPracticeReportDiscordEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !OFF.includes((env.PRACTICE_REPORT_DISCORD ?? '').trim().toLowerCase());
}

/**
 * Make a player's text unable to look like a ping: @everyone / @here get a zero-width
 * space after the @, and raw user / role mentions (<@123>, <@!123>, <@&123>) become
 * plain words. allowedMentions none is the real guard; this keeps the post readable.
 */
export function neutralizeMentions(text: string): string {
  return text
    .replace(/<@&\d+>/g, '@(身分組)')
    .replace(/<@!?\d+>/g, '@(某人)')
    .replace(/@(everyone|here)/gi, '@​$1');
}

function clip(text: string, max: number): string {
  return neutralizeMentions(truncateFeedbackContent(text ?? '', max));
}

/**
 * The post, e.g.
 *   🧪 練習回報「這步怪怪的」｜PRACTICE-AB12CD34EF｜第 2 回合・第 3 次派隊
 *   機器人 4家 梅林｜投票：贊成
 *   理由：……
 *   玩家備註：……
 * No player name or id. The full row is in the sheet tab 練習回報.
 */
export function formatPracticeReportForward(row: PracticeFlagRow): string {
  const room = (row.roomId ?? '').trim();
  const kind = DECISION_KIND_LABEL_ZH[row.kind] ?? row.kind;
  const role = ROLE_LABEL_ZH[row.botRole] ?? row.botRole;
  const note = clip(row.note ?? '', PRACTICE_REPORT_DISCORD_NOTE_MAX);
  const reason = clip(row.reason ?? '', PRACTICE_REPORT_DISCORD_REASON_MAX);
  return [
    `🧪 練習回報「這步怪怪的」${room ? `｜${clip(room, 40)}` : ''}｜第 ${row.round} 回合・第 ${row.attempt} 次派隊`,
    `機器人 ${seatLabelZh(row.botSeat)} ${role}｜${kind}：${clip(row.decision ?? '', ACTION_MAX) || '—'}`,
    `理由：${reason || '—'}`,
    `玩家備註：${note || '（沒寫）'}`,
  ].join('\n');
}

export interface PracticeReportDiscordOptions {
  /** The Discord sender; default: the /意見 one (FeedbackService), read on every report. */
  sender?: () => FeedbackDiscordForwarder | undefined;
  /** Channel id; default resolveFeedbackChannelId() (read on every report). */
  channelId?: () => string;
  /** On / off; default isPracticeReportDiscordEnabled() (read on every report). */
  enabled?: () => boolean;
  maxPerHour?: number;
  now?: () => number;
  /** Receives fixed reason strings only — never the post, never a raw error object. */
  logger?: { warn: (msg: string) => void; error: (msg: string) => void };
}

const HOUR_MS = 60 * 60 * 1000;

export class PracticeReportDiscord implements PracticeReportCopy {
  private readonly sender: () => FeedbackDiscordForwarder | undefined;
  private readonly channelId: () => string;
  private readonly enabled: () => boolean;
  private readonly maxPerHour: number;
  private readonly now: () => number;
  private readonly logger: NonNullable<PracticeReportDiscordOptions['logger']>;
  private readonly counts = { sent: 0, skipped: 0, failed: 0, throttled: 0 };
  /** Epoch ms of the posts of the last hour (slots are reserved before the send). */
  private sendTimes: number[] = [];

  constructor(opts: PracticeReportDiscordOptions = {}) {
    this.sender = opts.sender ?? ((): FeedbackDiscordForwarder | undefined => getFeedbackService().getDiscordForwarder());
    this.channelId = opts.channelId ?? ((): string => resolveFeedbackChannelId());
    this.enabled = opts.enabled ?? ((): boolean => isPracticeReportDiscordEnabled());
    this.maxPerHour = opts.maxPerHour ?? PRACTICE_REPORT_DISCORD_MAX_PER_HOUR;
    this.now = opts.now ?? Date.now;
    this.logger = opts.logger ?? {
      warn: (m): void => console.warn(`[practice] ${m}`),
      error: (m): void => console.error(`[practice] ${m}`),
    };
  }

  /** Post a copy of one saved report. Resolves with the outcome; never rejects. */
  async forward(row: PracticeFlagRow): Promise<PracticeReportCopyOutcome> {
    try {
      return await this.post(row);
    } catch (err) {
      // Only the synchronous part (settings, formatting) can get here; post() handles the send.
      this.counts.failed += 1;
      this.logger.error(`practice report copy to Discord failed: ${describeError(err)}`);
      return 'failed';
    }
  }

  snapshot(): PracticeReportDiscordStats {
    let enabled = false;
    try {
      enabled = this.enabled();
    } catch {
      enabled = false;
    }
    return { enabled, ...this.counts };
  }

  private async post(row: PracticeFlagRow): Promise<PracticeReportCopyOutcome> {
    if (!this.enabled()) return 'disabled';
    const channelId = this.channelId();
    const sender = this.sender();
    if (!channelId || !sender) {
      this.counts.skipped += 1;
      this.logger.warn('practice report saved but not posted to Discord (no channel / sender)');
      return 'skipped';
    }
    const now = this.now();
    this.sendTimes = this.sendTimes.filter((t) => now - t < HOUR_MS);
    if (this.sendTimes.length >= this.maxPerHour) {
      this.counts.throttled += 1;
      this.logger.warn(`practice report saved but not posted to Discord: hourly cap (${this.maxPerHour}) reached`);
      return 'throttled';
    }
    const content = formatPracticeReportForward(row);
    // Reserve the slot before the send (reports can overlap) and give it back when nothing was
    // posted, so a Discord outage cannot eat the hourly cap (same as /意見).
    this.sendTimes.push(now);
    try {
      const ok = await sender.send(channelId, { content, allowedMentions: { parse: [] } });
      if (!ok) {
        this.releaseSlot(now);
        this.counts.failed += 1;
        this.logger.warn('practice report saved but not posted to Discord: channel unavailable');
        return 'failed';
      }
      this.counts.sent += 1;
      return 'sent';
    } catch (err) {
      this.releaseSlot(now);
      this.counts.failed += 1;
      this.logger.error(`practice report copy to Discord threw: ${describeError(err)}`);
      return 'failed';
    }
  }

  private releaseSlot(at: number): void {
    const i = this.sendTimes.lastIndexOf(at);
    if (i >= 0) this.sendTimes.splice(i, 1);
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────

let instance: PracticeReportDiscord | null = null;

/** Process-wide copier (GameServer posts with it, /api/bots/status reads its counts). */
export function getPracticeReportDiscord(): PracticeReportDiscord {
  if (!instance) instance = new PracticeReportDiscord();
  return instance;
}

/** Test-only: drop the singleton so each test starts from zero counts. */
export function __resetPracticeReportDiscordForTests(): void {
  instance = null;
}
