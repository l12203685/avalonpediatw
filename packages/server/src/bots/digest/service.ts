/**
 * Weekly community digest — orchestration, schedule and status (2026-10-13).
 *
 *   Discord history (collector) → transcript (pseudonymized, in memory)
 *     → Claude API summary → private admin channel + private Google Sheet
 *
 * Raw chat goes Discord → Render memory → Anthropic API only. It is never
 * written to a file, the sheet, GitHub or a log; logs carry counts and codes.
 *
 * Schedule: from Monday 09:00 +08 (until 12:00 for catch-up) for the
 * previous Monday 00:00 → Sunday 24:00. A week's summary is produced at most
 * once per process (cached for delivery retries within the window; transient
 * API errors get one more attempt after DIGEST_RETRY_DELAY_MS). Double posts
 * are avoided by an in-memory "done week" per destination, by resuming a
 * partly sent Discord post from the next chunk (never from the first), and,
 * after a restart, by looking for this week's marker in the admin channel
 * and this week's row in the sheet.
 */

import { describeError } from '../feedback/service';
import {
  DIGEST_MANUAL_COOLDOWN_MS,
  DIGEST_MAX_ATTEMPTS_PER_WEEK,
  DIGEST_RETRY_DELAY_MS,
  defaultDigestLogger,
  readDigestConfig,
  type CommunityDigestConfig,
  type DigestLogger,
} from './config';
import type { CollectResult } from './collector';
import type { DigestAdminResolution, DigestAdminTarget, DigestDiscordPort } from './discordPort';
import {
  buildDiscordPost,
  chunkForDiscord,
  failureNotice,
  noMessagesSummary,
  summaryOutcomeText,
  type DigestPostFacts,
} from './format';
import { createDigestSheetWriter, SheetError, type DigestSheetRow } from './sheets';
import { createAnthropicSummarizer, type Summarizer, type SummaryOutcome } from './summarizer';
import { buildTranscript } from './transcript';
import {
  digestMarker,
  formatPeriod,
  isCommunityDigestRunWindow,
  manualWindow,
  scheduledWindow,
  type DigestWindow,
} from './window';

export type DigestRunOutcome =
  | SummaryOutcome
  | 'no-messages'
  | 'no-destination'
  | 'discord-not-ready'
  | 'disabled'
  | 'busy'
  | 'cooldown';

export interface DestinationResult {
  status: 'posted' | 'written' | 'skipped' | 'failed' | 'already-done' | 'not-attempted';
  /** Fixed, text-free reason shown in the status reply. */
  detail: string;
  chunks?: number;
}

export interface DigestRunReport {
  manual: boolean;
  window: DigestWindow;
  outcome: DigestRunOutcome;
  fetched: number;
  included: number;
  omitted: number;
  skipped: number;
  channelsRead: number;
  channels: number;
  truncatedChannels: number;
  failedChannels: number;
  /** No channel visible to @everyone was found by the default source rule (only the sync channel was read). */
  noPublicChannels: boolean;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  discord: DestinationResult;
  sheet: DestinationResult;
}

/** /api/bots/status → communityDigest.lastRun. Counts, dates and codes only. */
export interface CommunityDigestLastRun {
  week: string;
  at: string;
  manual: boolean;
  messages: number;
  channels: number;
  omitted: number;
  posted: boolean;
  sheetWritten: boolean;
  outcome: DigestRunOutcome;
}

export interface CommunityDigestStatus {
  enabled: boolean;
  anthropicConfigured: boolean;
  adminChannelResolved: boolean;
  sheetConfigured: boolean;
  lastRun: CommunityDigestLastRun | null;
}

export interface DigestSheetPort {
  appendRow(row: DigestSheetRow): Promise<void>;
  hasWeek(week: string): Promise<boolean>;
}

export type SheetFactory = (cfg: CommunityDigestConfig) => { writer: DigestSheetPort | null; reason: string };

export type DigestTickResult =
  | 'disabled'
  | 'outside-window'
  | 'busy'
  | 'discord-not-ready'
  | 'already-done'
  | 'no-destination'
  | 'retry'
  | 'waiting'
  | 'posted'
  | 'partial'
  | 'failed';

export interface CommunityDigestServiceOptions {
  discord: DigestDiscordPort;
  summarizer?: Summarizer;
  sheetFactory?: SheetFactory;
  config?: () => CommunityDigestConfig;
  now?: () => number;
  logger?: DigestLogger;
}

const SHEET_REASON_TEXT: Record<string, string> = {
  'no-sheet-id': '試算表目的地已關閉（COMMUNITY_DIGEST_SHEET_ID=off）',
  'no-credentials': '沒有設定 GOOGLE_SERVICE_ACCOUNT_JSON',
  'bad-credentials': 'GOOGLE_SERVICE_ACCOUNT_JSON 格式不對',
};

export const defaultSheetFactory: SheetFactory = (cfg) => {
  const { writer, reason } = createDigestSheetWriter(cfg.sheetId, process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  return { writer, reason };
};

/** How often the admin-channel state on the status page is refreshed outside runs. */
const ADMIN_REFRESH_MS = 10 * 60_000;

/** After start(), poll this often until the first admin-channel check succeeds (Discord connects after boot). */
const ADMIN_WARMUP_POLL_MS = 5_000;
const ADMIN_WARMUP_MAX_POLLS = 60;

interface Produced {
  outcome: DigestRunOutcome;
  /** True when trying again later could help (rate limit, overload, network). */
  retryable: boolean;
  /** Text to post (summary, "no messages" note, or a failure notice). */
  post: string;
  /** False for a failure notice: manual runs do not post those. */
  hasDigest: boolean;
  row: DigestSheetRow;
  report: Omit<DigestRunReport, 'discord' | 'sheet' | 'manual'>;
}

export class CommunityDigestService {
  private readonly discord: DigestDiscordPort;
  private readonly summarizer: Summarizer;
  private readonly sheetFactory: SheetFactory;
  private readonly config: () => CommunityDigestConfig;
  private readonly now: () => number;
  private readonly logger: DigestLogger;

  private readonly doneWeek: { discord: string; sheet: string } = { discord: '', sheet: '' };
  private restartCheckedWeek = '';
  private readonly attempts = new Map<string, number>();
  /** No new attempt for `week` before `at` (set after a transient failure). */
  private retryNotBefore: { week: string; at: number } = { week: '', at: 0 };
  /** Chunks of `week`'s scheduled post already sent; a retry resumes after them. */
  private discordProgress: { week: string; sent: number } = { week: '', sent: 0 };
  private cache: (Produced & { week: string }) | null = null;
  private inFlight = false;
  private lastManualAt = 0;
  private lastRun: CommunityDigestLastRun | null = null;
  private adminChannelResolved = false;
  private adminCheckedAt = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private warmupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: CommunityDigestServiceOptions) {
    this.discord = opts.discord;
    this.logger = opts.logger ?? defaultDigestLogger;
    this.summarizer = opts.summarizer ?? createAnthropicSummarizer({ logger: this.logger });
    this.sheetFactory = opts.sheetFactory ?? defaultSheetFactory;
    this.config = opts.config ?? ((): CommunityDigestConfig => readDigestConfig());
    this.now = opts.now ?? Date.now;
  }

  // ─── Status ─────────────────────────────────────────────────────────

  getStatus(): CommunityDigestStatus {
    const cfg = this.config();
    return {
      enabled: cfg.enabled,
      anthropicConfigured: cfg.anthropicConfigured,
      adminChannelResolved: this.adminChannelResolved,
      sheetConfigured: !!cfg.sheetId && cfg.sheetCredentialsUsable,
      lastRun: this.lastRun ? { ...this.lastRun } : null,
    };
  }

  private noteAdmin(res: DigestAdminResolution): void {
    if (!res.ok && res.problem === 'discord-not-ready') return; // unknown, keep the last answer
    this.adminChannelResolved = res.ok;
    this.adminCheckedAt = this.now();
  }

  /**
   * Keep `adminChannelResolved` fresh for the status page (cheap: cached
   * channel lookup). Until the first successful check (adminCheckedAt = 0)
   * every call checks; afterwards at most every ADMIN_REFRESH_MS.
   */
  async refreshAdminState(cfg: CommunityDigestConfig = this.config()): Promise<void> {
    if (!this.discord.isReady()) return;
    if (this.adminCheckedAt > 0 && this.now() - this.adminCheckedAt < ADMIN_REFRESH_MS) return;
    try {
      this.noteAdmin(await this.discord.resolveAdmin(cfg));
    } catch (err) {
      this.logger.warn(`admin channel check failed: ${describeError(err)}`);
    }
  }

  // ─── Pipeline ───────────────────────────────────────────────────────

  private async produce(w: DigestWindow, cfg: CommunityDigestConfig, excludeIds: string[]): Promise<Produced> {
    const collected: CollectResult = await this.discord.collect(cfg, w, excludeIds);
    const t = buildTranscript(collected.messages, collected.channels, { maxChars: cfg.maxChars });
    const skipped = Object.values(t.skipped).reduce((a, b) => a + b, 0);
    const noPublicChannels = collected.publicChannelsFound === 0;
    if (noPublicChannels) {
      this.logger.warn(
        'no channel visible to @everyone was found — only the sync channel is read (set COMMUNITY_DIGEST_SOURCE_CHANNEL_IDS)',
      );
    }
    const base = {
      window: w,
      fetched: collected.messages.length,
      included: t.included,
      omitted: t.omitted,
      skipped,
      channelsRead: collected.channels.length,
      channels: t.channels,
      truncatedChannels: collected.truncatedChannels,
      failedChannels: collected.failedChannels,
      noPublicChannels,
    };
    const facts = (model: string | null): DigestPostFacts => ({
      included: t.included,
      channels: t.channels,
      omitted: t.omitted,
      channelsRead: collected.channels.length,
      truncatedChannels: collected.truncatedChannels,
      failedChannels: collected.failedChannels,
      noPublicChannels,
      model,
    });
    const row = (summary: string, model: string): DigestSheetRow => ({
      week: w.weekKey,
      period: formatPeriod(w),
      messages: t.included,
      channels: t.channels,
      omitted: t.omitted,
      model,
      generatedAt: new Date(this.now()).toISOString(),
      summary,
    });

    if (t.included === 0) {
      const text = noMessagesSummary(collected.channels.length, collected.failedChannels);
      return {
        outcome: 'no-messages',
        // Nothing kept because channels could not be read (Discord hiccup) ≠ a quiet week: try again later.
        retryable: collected.failedChannels > 0,
        post: buildDiscordPost(w, facts(null), text),
        hasDigest: true,
        row: row(text, '-'),
        report: { ...base, outcome: 'no-messages', model: null, inputTokens: 0, outputTokens: 0 },
      };
    }

    const res = await this.summarizer.summarize(
      {
        window: w,
        transcript: t,
        channelsRead: collected.channels.length,
        truncatedChannels: collected.truncatedChannels,
        failedChannels: collected.failedChannels,
      },
      cfg.model,
    );
    const report = { ...base, outcome: res.outcome, model: res.model, inputTokens: res.inputTokens, outputTokens: res.outputTokens };
    if (res.text) {
      return {
        outcome: res.outcome,
        retryable: false,
        post: buildDiscordPost(w, facts(res.model), res.text),
        hasDigest: true,
        row: row(res.text, res.model ?? cfg.model),
        report,
      };
    }
    return {
      outcome: res.outcome,
      retryable: res.retryable,
      post: failureNotice(w, res.outcome),
      hasDigest: false,
      row: row(`（沒有產生摘要：${summaryOutcomeText(res.outcome)}）`, res.model ?? cfg.model),
      report,
    };
  }

  /**
   * Send `post` in ≤ 2000-character chunks, starting after the first
   * `alreadySent` chunks (a retry resumes, it never re-sends what is already
   * in the channel). `chunks` in the result is the total sent so far.
   */
  private async postDiscord(target: DigestAdminTarget, post: string, alreadySent = 0): Promise<DestinationResult> {
    const chunks = chunkForDiscord(post);
    let sent = Math.min(Math.max(0, alreadySent), chunks.length);
    try {
      for (const chunk of chunks.slice(sent)) {
        await target.send(chunk);
        sent += 1;
      }
      return { status: 'posted', detail: `已貼出 ${sent} 則`, chunks: sent };
    } catch (err) {
      this.logger.warn(`posting to the admin channel failed after ${sent}/${chunks.length} chunk(s): ${describeError(err)}`);
      return { status: 'failed', detail: sent > 0 ? `只貼出 ${sent}/${chunks.length} 則` : 'Discord 發送失敗', chunks: sent };
    }
  }

  private async writeSheet(sheet: DigestSheetPort, row: DigestSheetRow): Promise<DestinationResult> {
    try {
      await sheet.appendRow(row);
      return { status: 'written', detail: '已寫入' };
    } catch (err) {
      const status = err instanceof SheetError ? err.status : null;
      this.logger.warn(`writing the sheet failed: ${err instanceof SheetError ? err.message : describeError(err)}`);
      return { status: 'failed', detail: status ? `寫入失敗（HTTP ${status}）` : '寫入失敗' };
    }
  }

  private record(report: DigestRunReport): void {
    this.lastRun = {
      week: report.window.weekKey,
      at: new Date(this.now()).toISOString(),
      manual: report.manual,
      messages: report.included,
      channels: report.channels,
      omitted: report.omitted,
      posted: report.discord.status === 'posted',
      sheetWritten: report.sheet.status === 'written',
      outcome: report.outcome,
    };
    this.logger.info(
      `${report.manual ? 'manual' : 'scheduled'} run week=${report.window.weekKey}: fetched=${report.fetched} kept=${report.included} ` +
        `omitted=${report.omitted} skipped=${report.skipped} channels=${report.channels}/${report.channelsRead} ` +
        `truncatedChannels=${report.truncatedChannels} failedChannels=${report.failedChannels} outcome=${report.outcome} ` +
        `input_tokens=${report.inputTokens} output_tokens=${report.outputTokens} discord=${report.discord.status} sheet=${report.sheet.status}`,
    );
  }

  private emptyReport(manual: boolean, w: DigestWindow, outcome: DigestRunOutcome, discord: DestinationResult, sheet: DestinationResult): DigestRunReport {
    return {
      manual,
      window: w,
      outcome,
      fetched: 0,
      included: 0,
      omitted: 0,
      skipped: 0,
      channelsRead: 0,
      channels: 0,
      truncatedChannels: 0,
      failedChannels: 0,
      noPublicChannels: false,
      model: null,
      inputTokens: 0,
      outputTokens: 0,
      discord,
      sheet,
    };
  }

  // ─── Scheduled run ──────────────────────────────────────────────────

  /** One scheduler step; call every minute (start()) or directly in tests. */
  async tick(now: number = this.now()): Promise<DigestTickResult> {
    const cfg = this.config();
    if (!cfg.enabled) return 'disabled';
    if (!isCommunityDigestRunWindow(now)) {
      await this.refreshAdminState(cfg);
      return 'outside-window';
    }
    if (this.inFlight) return 'busy';
    this.inFlight = true;
    try {
      return await this.runScheduled(scheduledWindow(now), cfg, now);
    } catch (err) {
      this.logger.warn(`scheduled run threw: ${describeError(err)}`);
      return 'failed';
    } finally {
      this.inFlight = false;
    }
  }

  private async runScheduled(w: DigestWindow, cfg: CommunityDigestConfig, now: number): Promise<DigestTickResult> {
    const week = w.weekKey;
    if (this.doneWeek.discord === week && this.doneWeek.sheet === week) return 'already-done';
    const cached = this.cache && this.cache.week === week;
    if (!cached && this.retryNotBefore.week === week && now < this.retryNotBefore.at) return 'waiting';
    if (!this.discord.isReady()) return 'discord-not-ready';

    const admin = await this.discord.resolveAdmin(cfg);
    this.noteAdmin(admin);
    if (!admin.ok && admin.problem === 'discord-not-ready') return 'discord-not-ready';
    const { writer: sheet, reason: sheetReason } = this.sheetFactory(cfg);

    let discordResult: DestinationResult = { status: 'already-done', detail: '本週已貼過' };
    let sheetResult: DestinationResult = { status: 'already-done', detail: '本週已寫過' };

    // Destinations that cannot work this week are settled now (no API spend for them).
    if (this.doneWeek.discord !== week && !admin.ok) {
      this.doneWeek.discord = week;
      discordResult = { status: 'skipped', detail: admin.detail };
      this.logger.warn(`admin channel unavailable (${admin.problem}) — the digest is not posted to Discord`);
    }
    if (this.doneWeek.sheet !== week && !sheet) {
      this.doneWeek.sheet = week;
      sheetResult = { status: 'skipped', detail: SHEET_REASON_TEXT[sheetReason] ?? sheetReason };
    }

    // After a restart: was this week already delivered?
    if (this.restartCheckedWeek !== week) {
      this.restartCheckedWeek = week;
      const marker = digestMarker(w);
      if (this.doneWeek.discord !== week && admin.ok) {
        const found = await admin.target.hasRecentMarker(marker).catch((err: unknown) => {
          this.logger.warn(`marker check failed: ${describeError(err)}`);
          return false;
        });
        if (found) this.doneWeek.discord = week;
      }
      if (this.doneWeek.sheet !== week && sheet) {
        const found = await sheet.hasWeek(week).catch((err: unknown) => {
          this.logger.warn(`sheet week check failed: ${err instanceof SheetError ? err.message : describeError(err)}`);
          return false;
        });
        if (found) this.doneWeek.sheet = week;
      }
    }

    const wantDiscord = this.doneWeek.discord !== week;
    const wantSheet = this.doneWeek.sheet !== week;
    if (!wantDiscord && !wantSheet) {
      if (discordResult.status === 'skipped' && sheetResult.status === 'skipped') {
        this.record(this.emptyReport(false, w, 'no-destination', discordResult, sheetResult));
        return 'no-destination';
      }
      return 'already-done';
    }

    let produced = this.cache && this.cache.week === week ? this.cache : null;
    if (!produced) {
      const attempt = (this.attempts.get(week) ?? 0) + 1;
      this.attempts.set(week, attempt);
      const fresh = await this.produce(w, cfg, admin.ok ? [admin.target.id] : []);
      if (fresh.retryable && attempt < DIGEST_MAX_ATTEMPTS_PER_WEEK) {
        // Measured from when the attempt returned (a timed-out call can take minutes).
        this.retryNotBefore = { week, at: Math.max(now, this.now()) + DIGEST_RETRY_DELAY_MS };
        this.record({ ...fresh.report, manual: false, discord: { status: 'not-attempted', detail: '稍後重試' }, sheet: { status: 'not-attempted', detail: '稍後重試' } });
        return 'retry';
      }
      produced = { ...fresh, week };
      this.cache = produced;
    }

    if (wantDiscord && admin.ok) {
      const already = this.discordProgress.week === week ? this.discordProgress.sent : 0;
      discordResult = await this.postDiscord(admin.target, produced.post, already);
      this.discordProgress = { week, sent: discordResult.chunks ?? already };
      if (discordResult.status === 'posted') this.doneWeek.discord = week;
    }
    if (wantSheet && sheet) {
      sheetResult = await this.writeSheet(sheet, produced.row);
      if (sheetResult.status === 'written') this.doneWeek.sheet = week;
    }
    this.record({ ...produced.report, manual: false, discord: discordResult, sheet: sheetResult });
    const done = this.doneWeek.discord === week && this.doneWeek.sheet === week;
    if (done) return 'posted';
    return discordResult.status === 'posted' || sheetResult.status === 'written' ? 'partial' : 'failed';
  }

  // ─── Manual run (/社群週報) ─────────────────────────────────────────

  /** Summarize the last 7 days now and deliver it. Never throws; the report carries counts only. */
  async runManual(): Promise<DigestRunReport> {
    const now = this.now();
    const w = manualWindow(now);
    const cfg = this.config();
    const none: DestinationResult = { status: 'not-attempted', detail: '沒有執行' };
    if (!cfg.enabled) return this.emptyReport(true, w, 'disabled', none, none);
    if (this.inFlight) return this.emptyReport(true, w, 'busy', none, none);
    if (now - this.lastManualAt < DIGEST_MANUAL_COOLDOWN_MS) return this.emptyReport(true, w, 'cooldown', none, none);
    if (!this.discord.isReady()) return this.emptyReport(true, w, 'discord-not-ready', none, none);

    this.inFlight = true;
    this.lastManualAt = now;
    try {
      const admin = await this.discord.resolveAdmin(cfg);
      this.noteAdmin(admin);
      const { writer: sheet, reason: sheetReason } = this.sheetFactory(cfg);
      let discordResult: DestinationResult = admin.ok ? none : { status: 'skipped', detail: admin.detail };
      let sheetResult: DestinationResult = sheet ? none : { status: 'skipped', detail: SHEET_REASON_TEXT[sheetReason] ?? sheetReason };
      if (!admin.ok && !sheet) {
        this.lastManualAt = 0; // nothing was spent
        const report = this.emptyReport(true, w, 'no-destination', discordResult, sheetResult);
        this.record(report);
        return report;
      }

      const produced = await this.produce(w, cfg, admin.ok ? [admin.target.id] : []);
      if (produced.hasDigest) {
        if (admin.ok) discordResult = await this.postDiscord(admin.target, produced.post);
        if (sheet) sheetResult = await this.writeSheet(sheet, produced.row);
      }
      const report: DigestRunReport = { ...produced.report, manual: true, discord: discordResult, sheet: sheetResult };
      this.record(report);
      return report;
    } catch (err) {
      this.logger.warn(`manual run threw: ${describeError(err)}`);
      const report = this.emptyReport(true, w, 'error', none, none);
      this.record(report);
      return report;
    } finally {
      this.inFlight = false;
    }
  }

  // ─── Timer ──────────────────────────────────────────────────────────

  start(intervalMs: number = 60_000): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
    // The gateway usually connects a few seconds after boot: check the admin
    // channel every few seconds until the first answer, so the status page
    // (adminChannelResolved) is right soon after a deploy, not a minute later.
    let polls = 0;
    this.warmupTimer = setInterval(() => {
      polls += 1;
      if (this.adminCheckedAt > 0 || polls > ADMIN_WARMUP_MAX_POLLS) {
        if (this.warmupTimer) clearInterval(this.warmupTimer);
        this.warmupTimer = null;
        return;
      }
      void this.refreshAdminState();
    }, ADMIN_WARMUP_POLL_MS);
    this.warmupTimer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.warmupTimer) clearInterval(this.warmupTimer);
    this.timer = null;
    this.warmupTimer = null;
  }

  isRunning(): boolean {
    return this.timer !== null;
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────

let instance: CommunityDigestService | null = null;

export function initializeCommunityDigest(opts: CommunityDigestServiceOptions): CommunityDigestService {
  if (!instance) instance = new CommunityDigestService(opts);
  return instance;
}

export function getCommunityDigestService(): CommunityDigestService | null {
  return instance;
}

/** Status block for /api/bots/status, also before (or without) initialisation. */
export function communityDigestStatus(): CommunityDigestStatus {
  if (instance) return instance.getStatus();
  const cfg = readDigestConfig();
  return {
    enabled: cfg.enabled,
    anthropicConfigured: cfg.anthropicConfigured,
    adminChannelResolved: false,
    sheetConfigured: !!cfg.sheetId && cfg.sheetCredentialsUsable,
    lastRun: null,
  };
}

/** Test-only. */
export function __resetCommunityDigestForTests(): void {
  instance?.stop();
  instance = null;
}
