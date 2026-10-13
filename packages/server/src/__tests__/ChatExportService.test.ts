/**
 * Daily chat-log export — the service with fake Discord and sheet ports (no
 * network):
 *
 *   catch-up    — as soon as Discord is ready after a start (any time of
 *                 day) every one of the last 7 complete days without 完成,
 *                 oldest first; days with 完成 are not read again
 *   schedule    — afterwards the day that just ended waits for 04:30 +08;
 *                 disabled flag; Discord not ready → wait; not configured
 *                 → logged once a day; the public stats sheet refused
 *                 unless CHAT_EXPORT_ALLOW_PUBLIC_SHEET opts in
 *   idempotency — the export log 「匯出紀錄」 per day: a day with a 完成 row
 *                 is skipped (restart); rows of a day without 完成 (process
 *                 killed mid-write, failed append, failed cleanup) are
 *                 deleted before the day is written again; a 完成 row that
 *                 landed although its request failed is trusted
 *   instances   — two servers (deploy overlap) catching up at the same
 *                 moment: every day written exactly once; a dead holder's
 *                 claim goes stale after 30 minutes; a live claim is renewed;
 *                 a long catch-up claims each day at the time it is reached
 *   cleanup     — the fake deletes by row INDEX like Google: two servers
 *                 pruning at once lose no row of a kept day (one holds the
 *                 「清理中」 lock); leftover rows wait while another holds
 *                 it; a dead holder's lock lapses after 10 minutes; a
 *                 retention that found the lock taken runs again 10 minutes
 *                 later; a holder stalled past 3 minutes deletes nothing
 *   retries     — Sheets errors stop the pass for 10 minutes; some channels
 *                 unreadable → read once more, then exported; no channel
 *                 readable → never settled as empty; a quiet day → empty
 *   retention   — exactly the last 7 complete days in both tabs
 *   status      — /api/bots/status → chatExport: enabled / sheetConfigured /
 *                 publicSheet, lastRun (day, counts, outcome), catchUp
 *                 (exported / skipped / failed / pending / expired); no text
 *                 in status or logs
 *   wiring      — startChatExport arms the timer only when enabled
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ChatExportService, __resetChatExportForTests, chatExportStatus, cleanupHolder, getChatExportService } from '../bots/chatExport/service';
import {
  CHAT_EXPORT_STATE_CLAIM,
  CHAT_EXPORT_STATE_CLEANUP,
  CHAT_EXPORT_STATE_CLEANUP_END,
  CHAT_EXPORT_STATE_DONE,
  PUBLIC_STATS_SHEET_ID,
  readChatExportConfig,
  type ChatExportConfig,
} from '../bots/chatExport/config';
import type { ChatExportDiscordPort } from '../bots/chatExport/discordPort';
import type { ChatExportSheetPort, ExportLogEntry } from '../bots/chatExport/sheetWriter';
import type { ChatExportRow, RawChatMessage } from '../bots/chatExport/rows';
import { emptyCollectResult, type CollectResult } from '../bots/chatExport/collector';
import { lastCompleteDays, type ExportWindow } from '../bots/chatExport/window';
import { buildBotStatus, startChatExport } from '../bots';
import { buildSlashCommands } from '../bots/discord/client';
import { COMMANDS } from '../bots/discord/config';

const MIN = 60_000;
const HOUR = 60 * MIN;
const TUE_1000 = Date.parse('2026-10-13T02:00:00Z'); // Tue 10/13 10:00 +08
const DAYS = lastCompleteDays(TUE_1000); // 10/06 … 10/12
const YESTERDAY = '2026-10-12';
const GENERAL = '2000000000000000001';
const MIRROR = '3000000000000000001';
const THREAD = '4000000000000000001';

let seq = 0;
function chat(at: number, over: Partial<RawChatMessage> = {}): RawChatMessage {
  seq += 1;
  return {
    id: String(5_000_000_000_000_000_000n + BigInt(seq)),
    channelId: GENERAL,
    createdAt: at,
    authorId: `u${seq % 2}`,
    authorIsBot: false,
    authorIsSelf: false,
    webhookId: null,
    system: false,
    content: `秘密內容 ${seq}`,
    attachmentCount: 0,
    ...over,
  };
}

function claimRow(day: string, at: number, runId: string): ExportLogEntry {
  return { day, state: CHAT_EXPORT_STATE_CLAIM, rows: 0, channels: 0, at, runId };
}

function doneRow(day: string, at: number, runId: string, rows = 1): ExportLogEntry {
  return { day, state: CHAT_EXPORT_STATE_DONE, rows, channels: 1, at, runId };
}

function lockRow(at: number, runId: string, state: string = CHAT_EXPORT_STATE_CLEANUP): ExportLogEntry {
  return { day: '2026-10-13', state, rows: 0, channels: 0, at, runId };
}

/** In-memory sheet: both tabs, shared by every service of a test (= several server instances). */
class FakeSheet implements ChatExportSheetPort {
  rows: ChatExportRow[] = [];
  log: ExportLogEntry[] = [];
  prepared = 0;
  appendCalls = 0;
  failPrepare = false;
  /** Rows to accept before an append fails (null = never fails). */
  failAfterRows: number | null = null;
  failDelete = false;
  /** The 完成 append fails; with doneLands it reaches the sheet first (response lost). */
  failDone = false;
  doneLands = false;
  /** Runs at the start of appendRows (another instance acting mid-write). */
  beforeAppend: (() => Promise<void>) | null = null;
  /** Runs between reading the row indices and deleting them (a slow round trip). */
  beforeDelete: (() => void) | null = null;

  async prepare(): Promise<void> {
    this.prepared += 1;
    if (this.failPrepare) throw new Error('HTTP 503');
  }
  async readLog(): Promise<ExportLogEntry[]> {
    return this.log.map((e) => ({ ...e }));
  }
  async appendLog(e: ExportLogEntry): Promise<void> {
    // The sheet keeps whole seconds (taipeiIso).
    const row = { ...e, at: Math.floor(e.at / 1000) * 1000 };
    if (e.state === CHAT_EXPORT_STATE_DONE && this.failDone) {
      if (this.doneLands) this.log.push(row);
      throw new Error('timeout');
    }
    this.log.push(row);
  }
  async appendRows(rows: ChatExportRow[]): Promise<number> {
    this.appendCalls += 1;
    if (this.beforeAppend) {
      const hook = this.beforeAppend;
      this.beforeAppend = null;
      await hook();
    }
    if (this.failAfterRows !== null) {
      this.rows.push(...rows.slice(0, this.failAfterRows));
      throw new Error('append failed');
    }
    this.rows.push(...rows);
    return Math.ceil(rows.length / 500);
  }
  async countDays(match: (day: string) => boolean): Promise<number> {
    return this.rows.filter((r) => match(r[0])).length;
  }
  /**
   * Like Google: the matching row INDICES are read first and deleted one
   * network round trip later (a macrotask), so two instances deleting at the
   * same time remove the wrong rows unless the service keeps them apart.
   */
  private async deleteByIndex<T>(list: () => T[], set: (rows: T[]) => void, day: (r: T) => string, match: (day: string) => boolean, stillHeld?: () => boolean): Promise<number> {
    if (this.failDelete) throw new Error('delete failed');
    const indices = list()
      .map((r, i) => (match(day(r)) ? i : -1))
      .filter((i) => i >= 0);
    if (indices.length === 0) return 0;
    await new Promise((r) => setTimeout(r, 0));
    this.beforeDelete?.();
    if (stillHeld && !stillHeld()) throw new Error('cleanup lock held too long, nothing deleted');
    const doomed = new Set(indices);
    this.deleteRequests += 1;
    set(list().filter((_r, i) => !doomed.has(i)));
    return indices.length;
  }
  deleteRequests = 0;
  async deleteDays(match: (day: string) => boolean, stillHeld?: () => boolean): Promise<number> {
    return this.deleteByIndex(() => this.rows, (r) => (this.rows = r), (r) => r[0], match, stillHeld);
  }
  async deleteLogDays(match: (day: string) => boolean, stillHeld?: () => boolean): Promise<number> {
    return this.deleteByIndex(() => this.log, (r) => (this.log = r), (e) => e.day, match, stillHeld);
  }
  states(day: string): string[] {
    return this.log.filter((e) => e.day === day).map((e) => `${e.state}:${e.runId}`);
  }
  rowsOf(day: string): ChatExportRow[] {
    return this.rows.filter((r) => r[0] === day);
  }
  days(): string[] {
    return [...new Set(this.rows.map((r) => r[0]))].sort();
  }
  doneDays(): string[] {
    return [...new Set(this.log.filter((e) => e.state === CHAT_EXPORT_STATE_DONE).map((e) => e.day))].sort();
  }
}

/** Three conversation messages per day (two channels + a forum thread), unless `messages` says otherwise. */
function discordPort(
  opts: {
    ready?: boolean;
    messages?: (w: ExportWindow) => RawChatMessage[];
    /** failedChannels per call (by call index). */
    failed?: (call: number, w: ExportWindow) => number;
    channels?: number;
    extra?: Partial<CollectResult>;
  } = {},
) {
  const port: ChatExportDiscordPort & { calls: string[]; ready: boolean; channels: number } = {
    calls: [],
    ready: opts.ready ?? true,
    channels: opts.channels ?? 3,
    isReady(): boolean {
      return this.ready;
    },
    async collect(_cfg, w): Promise<CollectResult> {
      const call = port.calls.length;
      port.calls.push(w.dayKey);
      const all = [
        { id: GENERAL, name: '一般聊天', isMirror: false },
        { id: MIRROR, name: '阿瓦隆同步', isMirror: true },
        { id: THREAD, name: '討論區／祕密標題', isMirror: false, isThread: true },
      ];
      const messages = opts.messages
        ? opts.messages(w)
        : [chat(w.start + HOUR), chat(w.start + 2 * HOUR), chat(w.start + 3 * HOUR, { channelId: THREAD })];
      return {
        ...emptyCollectResult(),
        messages: port.channels === 0 ? [] : messages,
        channels: all.slice(0, port.channels),
        failedChannels: opts.failed?.(call, w) ?? 0,
        publicChannelsFound: 2,
        forums: 1,
        threadsRead: 1,
        ...opts.extra,
      };
    },
  };
  return port;
}

function harness(
  opts: {
    sheet?: FakeSheet | null;
    discord?: ReturnType<typeof discordPort>;
    config?: Partial<ChatExportConfig>;
    runId?: string;
    clock?: { now: number };
  } = {},
) {
  const sheet = opts.sheet === undefined ? new FakeSheet() : opts.sheet;
  const discord = opts.discord ?? discordPort();
  const logs: string[] = [];
  const clock = opts.clock ?? { now: TUE_1000 };
  const service = new ChatExportService({
    discord,
    sheetFactory: () => (sheet ? { sheet, reason: 'ok' } : { sheet: null, reason: 'no-sheet-id' }),
    config: () => ({ ...readChatExportConfig({}), ...opts.config }),
    now: () => clock.now,
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
    runId: opts.runId ?? 'run-a',
  });
  /** Tick at `t` with the clock moved there too. */
  const at = (t: number) => {
    clock.now = t;
    return service.tick(t);
  };
  return { service, sheet, discord, logs, clock, at };
}

const outcomes = (r: { days: Array<{ day: string; outcome: string }> }) => r.days.map((d) => `${d.day}:${d.outcome}`);

describe('catch-up after a start', () => {
  it('as soon as Discord is ready: every one of the last 7 complete days without 完成, oldest first', async () => {
    const sheet = new FakeSheet();
    for (const d of ['2026-10-08', '2026-10-10']) {
      sheet.rows.push([d, `${d} 12:00`, '一般聊天', 'Discord', '成員1', 'x']);
      sheet.log.push(claimRow(d, TUE_1000 - 3 * 86_400_000, 'old'), doneRow(d, TUE_1000 - 3 * 86_400_000, 'old'));
    }
    const h = harness({ sheet });
    const r = await h.at(TUE_1000);
    expect(r.state).toBe('ran');
    expect(outcomes(r)).toEqual([
      '2026-10-06:written',
      '2026-10-07:written',
      '2026-10-08:already-exported',
      '2026-10-09:written',
      '2026-10-10:already-exported',
      '2026-10-11:written',
      '2026-10-12:written',
    ]);
    expect(h.discord.calls).toEqual(['2026-10-06', '2026-10-07', '2026-10-09', '2026-10-11', '2026-10-12']); // done days not read
    expect(sheet.days()).toEqual(DAYS);
    for (const d of ['2026-10-06', '2026-10-07', '2026-10-09', '2026-10-11', '2026-10-12']) {
      expect(sheet.rowsOf(d)).toHaveLength(3);
      expect(sheet.states(d)).toEqual(['進行中:run-a', '完成:run-a']);
    }
    expect(sheet.rowsOf('2026-10-08')).toHaveLength(1); // untouched
    expect(h.service.getStatus().catchUp).toEqual({
      startedAt: new Date(TUE_1000).toISOString(),
      from: '2026-10-06',
      to: YESTERDAY,
      exported: 5,
      skipped: 2,
      failed: 0,
      pending: 0,
      expired: 0,
    });
    expect(h.service.getStatus().lastRun).toMatchObject({ day: YESTERDAY, outcome: 'written', messages: 3, channels: 2, threads: 1 });
    // Nothing more to do today.
    expect((await h.at(TUE_1000 + MIN)).state).toBe('idle');
    expect((await h.at(TUE_1000 + 10 * HOUR)).state).toBe('idle');
    expect(h.discord.calls).toHaveLength(5);
  });

  it('a start at 01:00 exports yesterday right away; a running server waits for 04:30 for the day that just ended', async () => {
    const wed0100 = Date.parse('2026-10-13T17:00:00Z'); // Wed 10/14 01:00 +08
    const h = harness();
    const r = await h.at(wed0100);
    expect(r.days.map((d) => d.day)).toEqual(lastCompleteDays(wed0100)); // 10/07 … 10/13
    expect(r.days.every((d) => d.outcome === 'written')).toBe(true);
    // The next night: 10/14 is complete at 00:00, exported from 04:30.
    const thu = Date.parse('2026-10-14T16:00:00Z'); // Thu 10/15 00:00 +08
    expect((await h.at(thu + 10 * MIN)).state).toBe('idle');
    expect((await h.at(thu + 4 * HOUR + 29 * MIN)).state).toBe('idle'); // 04:29
    const run = await h.at(thu + 4 * HOUR + 30 * MIN); // 04:30
    expect(outcomes(run)).toEqual(['2026-10-14:written']);
    expect(h.discord.calls.at(-1)).toBe('2026-10-14');
    // Retention: the window is now 10/08 … 10/14, so 10/07 was dropped from both tabs.
    expect(h.sheet!.days()).toEqual(lastCompleteDays(thu + 5 * HOUR));
    expect(h.sheet!.days()[0]).toBe('2026-10-08');
    expect(h.sheet!.log.some((e) => e.day === '2026-10-07')).toBe(false);
    expect((await h.at(thu + 5 * HOUR)).state).toBe('idle');
  });

  it('a long catch-up: each day is claimed at the time it is reached, not at the pass start (one 進行中 per day)', async () => {
    const clock = { now: TUE_1000 };
    const discord = discordPort();
    const collect = discord.collect;
    discord.collect = async (cfg, w) => {
      clock.now += 12 * MIN; // reading one day takes 12 minutes
      return collect(cfg, w);
    };
    const h = harness({ discord, clock });
    const r = await h.service.tick(TUE_1000);
    expect(r.days.every((d) => d.outcome === 'written')).toBe(true);
    const claims = h.sheet!.log.filter((e) => e.state === CHAT_EXPORT_STATE_CLAIM);
    expect(claims.map((e) => e.day)).toEqual(DAYS); // no extra renewal row
    expect(claims.map((e) => (e.at - TUE_1000) / MIN)).toEqual([0, 12, 24, 36, 48, 60, 72]); // never backdated
  });

  it('catchUp: a day that left the 7-day window unsettled counts as expired, not failed or pending', async () => {
    const h = harness({ discord: discordPort({ channels: 0 }) }); // nothing readable: 10/06 fails, the pass stops
    await h.at(TUE_1000);
    expect(h.service.getStatus().catchUp).toMatchObject({ exported: 0, skipped: 0, failed: 1, pending: 6, expired: 0 });
    h.clock.now = TUE_1000 + 48 * HOUR; // Thu 10/15: the window is 10/08 … 10/14
    expect(h.service.getStatus().catchUp).toMatchObject({ exported: 0, skipped: 0, failed: 0, pending: 5, expired: 2 });
  });

  it('Discord not ready → no claim and nothing read; the catch-up starts the minute it is', async () => {
    const h = harness({ discord: discordPort({ ready: false }) });
    expect((await h.at(TUE_1000)).state).toBe('discord-not-ready');
    expect(h.sheet!.prepared).toBe(0);
    expect(h.sheet!.log).toEqual([]);
    expect(h.service.getStatus().catchUp).toBeNull();
    h.discord.ready = true;
    const r = await h.at(TUE_1000 + 3 * MIN);
    expect(r.days).toHaveLength(7);
    expect(h.sheet!.doneDays()).toEqual(DAYS);
  });

  it('CHAT_EXPORT_ENABLED=false → nothing', async () => {
    const h = harness({ config: { enabled: false } });
    expect((await h.at(TUE_1000)).state).toBe('disabled');
    expect(h.discord.calls).toEqual([]);
  });

  it('no sheet configured → not-configured (logged once a day), Discord never read', async () => {
    const h = harness({ sheet: null });
    expect((await h.at(TUE_1000)).state).toBe('not-configured');
    expect((await h.at(TUE_1000 + MIN)).state).toBe('not-configured');
    expect(h.discord.calls).toEqual([]);
    expect(h.service.getStatus().lastRun).toMatchObject({ day: YESTERDAY, outcome: 'not-configured', messages: 0 });
    expect(h.logs.filter((l) => l.includes('no-sheet-id'))).toHaveLength(1);
    await h.at(TUE_1000 + 24 * HOUR);
    expect(h.logs.filter((l) => l.includes('no-sheet-id'))).toHaveLength(2);
  });
});

describe('the public 阿瓦隆百科 sheet', () => {
  const creds = JSON.stringify({ client_email: 'a@b.iam.gserviceaccount.com', private_key: 'k' });

  function withEnv(env: NodeJS.ProcessEnv) {
    const sheet = new FakeSheet();
    const logs: string[] = [];
    const service = new ChatExportService({
      discord: discordPort(),
      // Like the real factory: no client without a sheet id.
      sheetFactory: (cfg) => (cfg.sheetId ? { sheet, reason: 'ok' } : { sheet: null, reason: 'no-sheet-id' }),
      config: () => readChatExportConfig(env),
      now: () => TUE_1000,
      logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
    });
    return { sheet, logs, service };
  }

  it('is refused by default: not configured, nothing written', async () => {
    const { sheet, logs, service } = withEnv({ CHAT_EXPORT_SHEET_ID: PUBLIC_STATS_SHEET_ID, GOOGLE_SERVICE_ACCOUNT_JSON: creds });
    expect(service.getStatus()).toMatchObject({ sheetConfigured: false, publicSheet: false });
    expect((await service.tick(TUE_1000)).state).toBe('not-configured');
    expect(logs.join('\n')).toContain('public-sheet-refused');
    expect(sheet.prepared).toBe(0);
    expect(sheet.rows).toEqual([]);
  });

  it('with CHAT_EXPORT_ALLOW_PUBLIC_SHEET=1 the days are written there and the status says publicSheet: true', async () => {
    const { sheet, service } = withEnv({
      CHAT_EXPORT_SHEET_ID: PUBLIC_STATS_SHEET_ID,
      CHAT_EXPORT_ALLOW_PUBLIC_SHEET: '1',
      GOOGLE_SERVICE_ACCOUNT_JSON: creds,
    });
    expect(service.getStatus()).toMatchObject({ enabled: true, sheetConfigured: true, publicSheet: true });
    expect((await service.tick(TUE_1000)).days).toHaveLength(7);
    expect(sheet.doneDays()).toEqual(DAYS);
  });
});

describe('idempotency: the export log, per day', () => {
  it('a restart finds every day 完成: nothing read or written again', async () => {
    const h = harness();
    await h.at(TUE_1000);
    const appends = h.sheet!.appendCalls;
    const h2 = harness({ sheet: h.sheet, runId: 'run-b', clock: { now: TUE_1000 + 30 * MIN } });
    const r = await h2.at(TUE_1000 + 30 * MIN);
    expect(r.days.map((d) => d.outcome)).toEqual(Array(7).fill('already-exported'));
    expect(h2.discord.calls).toEqual([]);
    expect(h.sheet!.appendCalls).toBe(appends);
    expect(h.sheet!.rows).toHaveLength(21);
    expect(h2.service.getStatus().catchUp).toMatchObject({ exported: 0, skipped: 7, failed: 0 });
  });

  it('process killed mid-write: the next instance waits for the stale claim, deletes the partial rows, writes the day once', async () => {
    const sheet = new FakeSheet();
    // Every day but yesterday is done; the dead instance took yesterday at 10:00 and got 2 of 3 rows in.
    for (const d of DAYS.slice(0, 6)) sheet.log.push(doneRow(d, TUE_1000 - HOUR, 'old', 3));
    sheet.log.push(claimRow(YESTERDAY, TUE_1000, 'dead'));
    sheet.rows.push([YESTERDAY, 'x', 'x', 'Discord', '成員1', 'partial'], [YESTERDAY, 'x', 'x', 'Discord', '成員2', 'partial']);
    const h = harness({ sheet, runId: 'new' });
    expect(outcomes(await h.at(TUE_1000 + 5 * MIN)).at(-1)).toBe(`${YESTERDAY}:claimed-elsewhere`);
    expect(h.service.getStatus().lastRun?.outcome).toBe('claimed-elsewhere');
    expect(h.discord.calls).toEqual([]);
    expect((await h.at(TUE_1000 + 10 * MIN)).state).toBe('waiting');
    expect(outcomes(await h.at(TUE_1000 + 16 * MIN))).toEqual([`${YESTERDAY}:claimed-elsewhere`]); // still fresh (< 30 min)
    expect(outcomes(await h.at(TUE_1000 + 30 * MIN))).toEqual([`${YESTERDAY}:written`]); // stale → taken over
    expect(sheet.rowsOf(YESTERDAY)).toHaveLength(3); // not 5
    expect(sheet.rows.some((r) => r[5] === 'partial')).toBe(false);
    expect(sheet.states(YESTERDAY)).toEqual(['進行中:dead', '進行中:new', '完成:new']);
    expect(h.logs.join('\n')).toContain('removed 2 row(s) left by an interrupted export');
  });

  it('a failed append removes the half-written day; the pass stops and retries 10 minutes later', async () => {
    const sheet = new FakeSheet();
    sheet.failAfterRows = 2;
    const h = harness({ sheet });
    const r = await h.at(TUE_1000);
    expect(outcomes(r)).toEqual(['2026-10-06:sheet-error']); // the other days are not tried against a failing sheet
    expect(sheet.rows).toEqual([]); // cleaned up
    expect(sheet.states('2026-10-06')).toEqual(['進行中:run-a']); // no 完成
    expect(h.service.getStatus().lastRun?.outcome).toBe('sheet-error');
    expect(h.service.getStatus().catchUp).toMatchObject({ exported: 0, failed: 1, pending: 6 });
    expect((await h.at(TUE_1000 + 5 * MIN)).state).toBe('waiting');
    sheet.failAfterRows = null;
    const again = await h.at(TUE_1000 + 11 * MIN);
    expect(again.days.map((d) => d.outcome)).toEqual(Array(7).fill('written'));
    expect(sheet.rows).toHaveLength(21);
    expect(h.service.getStatus().catchUp).toMatchObject({ exported: 7, failed: 0, pending: 0 });
  });

  it('when the cleanup fails too, the next attempt deletes the day first (no 完成 row) instead of trusting it', async () => {
    const sheet = new FakeSheet();
    sheet.failAfterRows = 2;
    sheet.beforeAppend = async () => {
      sheet.failDelete = true; // the cleanup after the failed append fails too
    };
    const h = harness({ sheet });
    await h.at(TUE_1000);
    expect(sheet.rows).toHaveLength(2); // half-written, cleanup failed
    expect(h.logs.join('\n')).toContain('cleanup failed too');
    sheet.failAfterRows = null;
    sheet.failDelete = false;
    // Even a brand-new process (restart) does not trust those rows.
    const h2 = harness({ sheet, runId: 'run-b' });
    await h2.at(TUE_1000 + 31 * MIN);
    expect(sheet.rowsOf('2026-10-06')).toHaveLength(3); // not 5: the 2 partial rows were deleted first
    expect(sheet.doneDays()).toEqual(DAYS);
    expect(h2.logs.join('\n')).toContain('interrupted export');
  });

  it('the 完成 request fails but the row landed: the rows are kept and the next attempt finds 完成', async () => {
    const sheet = new FakeSheet();
    sheet.failDone = true;
    sheet.doneLands = true;
    const h = harness({ sheet });
    expect(outcomes(await h.at(TUE_1000))).toEqual(['2026-10-06:sheet-error']);
    expect(sheet.rowsOf('2026-10-06')).toHaveLength(3); // not cleaned up: 完成 may be there
    sheet.failDone = false;
    const r = await h.at(TUE_1000 + 10 * MIN);
    expect(r.days[0]).toEqual({ day: '2026-10-06', outcome: 'already-exported' });
    expect(sheet.rowsOf('2026-10-06')).toHaveLength(3);
  });

  it('the 完成 request fails and did not land: the next attempt deletes the rows and writes the day again', async () => {
    const sheet = new FakeSheet();
    sheet.failDone = true;
    const h = harness({ sheet });
    await h.at(TUE_1000);
    sheet.failDone = false;
    const r = await h.at(TUE_1000 + 10 * MIN);
    expect(r.days[0]).toEqual({ day: '2026-10-06', outcome: 'written' });
    expect(sheet.rowsOf('2026-10-06')).toHaveLength(3);
    expect(sheet.states('2026-10-06')).toEqual(['進行中:run-a', '完成:run-a']);
  });
});

describe('two server instances (deploy overlap)', () => {
  it('both catch up at the same moment: every day is written exactly once', async () => {
    const sheet = new FakeSheet();
    const clock = { now: TUE_1000 };
    const a = harness({ sheet, runId: 'a', clock });
    const b = harness({ sheet, runId: 'b', clock });
    await Promise.all([a.service.tick(TUE_1000), b.service.tick(TUE_1000)]);
    // Ten minutes later each looks again at what the other held.
    await Promise.all([a.at(TUE_1000 + 10 * MIN), b.at(TUE_1000 + 10 * MIN)]);
    expect(sheet.doneDays()).toEqual(DAYS);
    for (const d of DAYS) {
      expect(sheet.rowsOf(d)).toHaveLength(3); // not 6
      expect(sheet.log.filter((e) => e.day === d && e.state === CHAT_EXPORT_STATE_DONE)).toHaveLength(1);
    }
    expect(a.discord.calls.length + b.discord.calls.length).toBe(7); // each day read once in total
    // They split the days between them (each skips the day the other holds).
    expect(a.discord.calls.length).toBeGreaterThan(0);
    expect(b.discord.calls.length).toBeGreaterThan(0);
    expect((await a.at(TUE_1000 + 20 * MIN)).state).toBe('idle');
    expect((await b.at(TUE_1000 + 20 * MIN)).state).toBe('idle');
  });

  it('both prune at the same moment: rows are deleted by index, yet no kept day loses a row (one instance holds the cleanup)', async () => {
    const sheet = new FakeSheet();
    for (const d of ['2026-10-05', ...DAYS]) {
      for (let i = 0; i < 3; i += 1) sheet.rows.push([d, `${d} 12:0${i}`, 'c', 'Discord', `成員${i + 1}`, `x${i}`]);
      sheet.log.push(doneRow(d, TUE_1000 - HOUR, 'old', 3));
    }
    const clock = { now: TUE_1000 };
    const a = harness({ sheet, runId: 'a', clock });
    const b = harness({ sheet, runId: 'b', clock });
    const [ra, rb] = await Promise.all([a.service.tick(TUE_1000), b.service.tick(TUE_1000)]);
    expect(ra.days.map((d) => d.outcome)).toEqual(Array(7).fill('already-exported'));
    expect(rb.days.map((d) => d.outcome)).toEqual(Array(7).fill('already-exported'));
    expect(sheet.days()).toEqual(DAYS);
    for (const d of DAYS) {
      expect(sheet.rowsOf(d)).toHaveLength(3);
      expect(sheet.states(d)).toEqual(['完成:old']);
    }
    expect(sheet.log.some((e) => e.day === '2026-10-05')).toBe(false);
    expect(sheet.deleteRequests).toBe(2); // one instance pruned (both tabs), the other skipped
    expect([...a.logs, ...b.logs].join('\n')).toContain('another server instance is deleting rows');
  });

  it('the second instance comes up while the first is writing a day: it does not read or write that day', async () => {
    const sheet = new FakeSheet();
    for (const d of DAYS.slice(0, 6)) sheet.log.push(doneRow(d, TUE_1000 - HOUR, 'old', 3));
    const clock = { now: TUE_1000 };
    const a = harness({ sheet, runId: 'a', clock });
    const b = harness({ sheet, runId: 'b', clock });
    let mid: string[] = [];
    sheet.beforeAppend = async () => {
      mid = outcomes(await b.service.tick(TUE_1000 + MIN));
    };
    expect(outcomes(await a.service.tick(TUE_1000))).toEqual(
      [...DAYS.slice(0, 6).map((d) => `${d}:already-exported`), `${YESTERDAY}:written`],
    );
    expect(mid.at(-1)).toBe(`${YESTERDAY}:claimed-elsewhere`);
    expect(b.discord.calls).toEqual([]);
    expect(sheet.rowsOf(YESTERDAY)).toHaveLength(3);
  });

  it('a live claim is renewed between attempts; another instance takes the other days meanwhile', async () => {
    const sheet = new FakeSheet();
    const a = harness({ sheet, runId: 'a', discord: discordPort({ channels: 0 }) });
    for (const m of [0, 10, 20, 30, 40]) expect(outcomes(await a.at(TUE_1000 + m * MIN))).toEqual(['2026-10-06:read-error']);
    const claims = sheet.log.filter((e) => e.runId === 'a').map((e) => (e.at - TUE_1000) / MIN);
    expect(claims).toEqual([0, 20, 40]); // renewed once older than 15 minutes
    expect(sheet.doneDays()).toEqual([]); // an unreadable day is never recorded as empty
    const b = harness({ sheet, runId: 'b' });
    const rb = await b.at(TUE_1000 + 45 * MIN);
    expect(rb.days[0]).toEqual({ day: '2026-10-06', outcome: 'claimed-elsewhere' });
    expect(rb.days.slice(1).every((d) => d.outcome === 'written')).toBe(true);
    // a recovers and writes its day; b then finds 完成.
    a.discord.channels = 3;
    const ra = await a.at(TUE_1000 + 50 * MIN);
    expect(ra.days[0]).toEqual({ day: '2026-10-06', outcome: 'written' });
    expect(ra.days.slice(1).every((d) => d.outcome === 'already-exported')).toBe(true);
    expect((await b.at(TUE_1000 + 56 * MIN)).days).toEqual([{ day: '2026-10-06', outcome: 'already-exported' }]);
    for (const d of DAYS) expect(sheet.rowsOf(d)).toHaveLength(3);
    expect(b.service.getStatus().catchUp).toMatchObject({ exported: 6, skipped: 1, failed: 0, pending: 0 });
  });
});

describe('the cleanup lock (row deletions are by index)', () => {
  it('cleanupHolder: the first live 清理中 in sheet order; 清理結束 releases that run; stale after 10 minutes', () => {
    const t = TUE_1000;
    expect(cleanupHolder([], t)).toBeNull();
    expect(cleanupHolder([lockRow(t, 'a'), lockRow(t, 'b')], t)).toBe('a');
    expect(cleanupHolder([lockRow(t, 'a'), lockRow(t, 'b'), lockRow(t, 'a', CHAT_EXPORT_STATE_CLEANUP_END)], t)).toBe('b');
    // A release only covers that run's earlier rows: a's new lock after its release is live again.
    expect(cleanupHolder([lockRow(t, 'a'), lockRow(t, 'a', CHAT_EXPORT_STATE_CLEANUP_END), lockRow(t, 'b'), lockRow(t, 'a')], t)).toBe('b');
    expect(cleanupHolder([lockRow(t - 10 * MIN, 'dead'), lockRow(t, 'b')], t)).toBe('b');
    expect(cleanupHolder([lockRow(t - 9 * MIN, 'slow'), lockRow(t, 'b')], t)).toBe('slow');
    // Day claims are not the lock and the lock is not a day claim.
    expect(cleanupHolder([claimRow(YESTERDAY, t, 'x')], t)).toBeNull();
  });

  it('leftover rows of a day while another instance holds the lock: nothing deleted, the day waits 10 minutes, then is written once', async () => {
    const sheet = new FakeSheet();
    for (const d of DAYS.slice(0, 6)) sheet.log.push(doneRow(d, TUE_1000 - HOUR, 'old', 3));
    sheet.log.push(lockRow(TUE_1000, 'other')); // the other instance is deleting rows right now
    sheet.rows.push([YESTERDAY, 'x', 'x', 'Discord', '成員1', 'partial'], [YESTERDAY, 'x', 'x', 'Discord', '成員2', 'partial']);
    const h = harness({ sheet, runId: 'new' });
    expect(outcomes(await h.at(TUE_1000 + MIN)).at(-1)).toBe(`${YESTERDAY}:claimed-elsewhere`);
    expect(sheet.rowsOf(YESTERDAY)).toHaveLength(2); // untouched
    expect(sheet.deleteRequests).toBe(0);
    expect(h.logs.join('\n')).toContain(`day ${YESTERDAY}: another server instance is deleting rows`);
    expect((await h.at(TUE_1000 + 5 * MIN)).state).toBe('waiting');
    // 10 minutes on: the other lock lapsed (its instance never released it) → taken, leftovers removed, day written.
    expect(outcomes(await h.at(TUE_1000 + 11 * MIN))).toEqual([`${YESTERDAY}:written`]);
    expect(sheet.rowsOf(YESTERDAY)).toHaveLength(3);
    expect(sheet.rows.some((r) => r[5] === 'partial')).toBe(false);
    expect(sheet.states('2026-10-13')).toEqual(['清理中:other', '清理中:new', '清理結束:new', '清理中:new', '清理結束:new']);
  });

  it('a retention that found the lock taken runs again 10 minutes later, even with no day due', async () => {
    const sheet = new FakeSheet();
    for (const d of ['2026-10-05', ...DAYS]) {
      sheet.rows.push([d, `${d} 12:00`, '', '', '', '']);
      sheet.log.push(doneRow(d, TUE_1000 - HOUR, 'old'));
    }
    sheet.log.push(lockRow(TUE_1000, 'other'), lockRow(TUE_1000, 'other', CHAT_EXPORT_STATE_CLEANUP_END)); // released: no obstacle
    sheet.log.push(lockRow(TUE_1000 + 30_000, 'other2')); // live
    const h = harness({ sheet });
    const r = await h.at(TUE_1000 + MIN);
    expect(r.days.map((d) => d.outcome)).toEqual(Array(7).fill('already-exported'));
    expect(sheet.days()[0]).toBe('2026-10-05'); // kept for now
    expect(h.logs.join('\n')).toContain('pruning days before 2026-10-06: another server instance is deleting rows');
    const prepared = sheet.prepared;
    expect((await h.at(TUE_1000 + 6 * MIN)).state).toBe('idle');
    expect(sheet.prepared).toBe(prepared); // nothing due: no Sheets call
    const again = await h.at(TUE_1000 + 11 * MIN); // the retention alone (other2's lock lapsed)
    expect(again).toEqual({ state: 'ran', days: [] });
    expect(sheet.days()).toEqual(DAYS);
    expect(sheet.log.some((e) => e.day === '2026-10-05')).toBe(false);
    expect((await h.at(TUE_1000 + 30 * MIN)).state).toBe('idle');
    expect(sheet.prepared).toBe(prepared + 1);
  });

  it('a holder that would delete after holding the lock too long (3 minutes) deletes nothing and tries again', async () => {
    const sheet = new FakeSheet();
    for (const d of ['2026-10-05', ...DAYS]) {
      sheet.rows.push([d, `${d} 12:00`, '', '', '', '']);
      sheet.log.push(doneRow(d, TUE_1000 - HOUR, 'old'));
    }
    const h = harness({ sheet });
    sheet.beforeDelete = () => {
      sheet.beforeDelete = null;
      h.clock.now += 4 * MIN; // a stalled round trip
    };
    await h.at(TUE_1000);
    expect(sheet.days()[0]).toBe('2026-10-05');
    expect(sheet.deleteRequests).toBe(0);
    expect(h.logs.join('\n')).toContain('pruning days before 2026-10-06 failed');
    expect(sheet.states('2026-10-13')).toEqual(['清理中:run-a', '清理結束:run-a']); // released all the same
    await h.at(TUE_1000 + 15 * MIN);
    expect(sheet.days()).toEqual(DAYS);
  });
});

describe('retries', () => {
  it('a Sheets error at the sheet check → the whole pass waits 10 minutes', async () => {
    const sheet = new FakeSheet();
    sheet.failPrepare = true;
    const h = harness({ sheet });
    expect(outcomes(await h.at(TUE_1000))).toEqual(['2026-10-06:sheet-error']);
    expect(h.discord.calls).toEqual([]);
    expect((await h.at(TUE_1000 + 9 * MIN)).state).toBe('waiting');
    sheet.failPrepare = false;
    expect((await h.at(TUE_1000 + 10 * MIN)).days).toHaveLength(7);
    expect(sheet.doneDays()).toEqual(DAYS);
  });

  it('some channels unreadable: each day is read again once, then what was read is exported', async () => {
    const seen = new Set<string>();
    const discord = discordPort({
      failed: (_call, w) => {
        if (seen.has(w.dayKey)) return 1; // still failing the second time
        seen.add(w.dayKey);
        return 1;
      },
    });
    const h = harness({ discord });
    const first = await h.at(TUE_1000);
    expect(first.days.map((d) => d.outcome)).toEqual(Array(7).fill('read-error'));
    expect(h.sheet!.appendCalls).toBe(0);
    expect(h.service.getStatus().catchUp).toMatchObject({ failed: 7 });
    const second = await h.at(TUE_1000 + 10 * MIN);
    expect(second.days.map((d) => d.outcome)).toEqual(Array(7).fill('written'));
    expect(h.discord.calls).toHaveLength(14);
  });

  it('a day that keeps failing stays in the window and is retried after midnight too', async () => {
    const sheet = new FakeSheet();
    for (const d of DAYS.slice(0, 6)) sheet.log.push(doneRow(d, TUE_1000 - HOUR, 'old', 3));
    const h = harness({ sheet, discord: discordPort({ channels: 0 }) });
    expect(outcomes(await h.at(TUE_1000)).at(-1)).toBe(`${YESTERDAY}:read-error`);
    const after = Date.parse('2026-10-13T16:20:00Z'); // Wed 10/14 00:20 +08 (before 04:30)
    h.discord.channels = 3;
    const r = await h.at(after);
    expect(outcomes(r)).toEqual([`${YESTERDAY}:written`]); // 10/13 itself waits for 04:30
  });

  it('a quiet day (only bot posts and commands) is settled as empty: nothing appended, 完成 with 0 rows', async () => {
    const h = harness({
      discord: discordPort({ messages: (w) => [chat(w.start + HOUR, { content: '/排行' }), chat(w.start + 2 * HOUR, { authorIsBot: true })] }),
    });
    const r = await h.at(TUE_1000);
    expect(r.days.map((d) => d.outcome)).toEqual(Array(7).fill('empty'));
    expect(h.sheet!.appendCalls).toBe(0);
    expect(h.sheet!.log.filter((e) => e.state === CHAT_EXPORT_STATE_DONE).every((e) => e.rows === 0)).toBe(true);
    // After a restart it stays settled.
    const r2 = await harness({ sheet: h.sheet, runId: 'run-b' }).at(TUE_1000 + 2 * MIN);
    expect(r2.days.map((d) => d.outcome)).toEqual(Array(7).fill('already-exported'));
  });
});

describe('retention', () => {
  it('keeps exactly the last 7 complete days in both tabs (notes and the header stay)', async () => {
    const sheet = new FakeSheet();
    const old = ['2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05'];
    for (const d of [...old, ...DAYS]) {
      sheet.rows.push([d, `${d} 12:00`, '', '', '', '']);
      sheet.log.push(doneRow(d, TUE_1000 - HOUR, 'old'));
    }
    const h = harness({ sheet });
    const r = await h.at(TUE_1000);
    expect(r.days.map((d) => d.outcome)).toEqual(Array(7).fill('already-exported'));
    expect(sheet.days()).toEqual(DAYS);
    expect(sheet.days()).toHaveLength(7);
    const dayRows = sheet.log.filter((e) => e.state === CHAT_EXPORT_STATE_CLAIM || e.state === CHAT_EXPORT_STATE_DONE);
    expect([...new Set(dayRows.map((e) => e.day))].sort()).toEqual(DAYS);
    // The cleanup lock around the deletion, dated today (pruned with the days a week later).
    expect(sheet.log.filter((e) => !dayRows.includes(e)).map((e) => `${e.day} ${e.state}:${e.runId}`)).toEqual([
      '2026-10-13 清理中:run-a',
      '2026-10-13 清理結束:run-a',
    ]);
    expect(h.logs.join('\n')).toMatch(/pruned 6 row\(s\) of days before 2026-10-06 \(export log: 6\)/);
  });

  it('a pruning failure only warns; the export still counts', async () => {
    const sheet = new FakeSheet();
    sheet.rows.push(['2026-01-05', '', '', '', '', '']);
    const h = harness({ sheet });
    let n = 0;
    sheet.beforeAppend = async () => {
      n += 1;
    };
    const orig = sheet.deleteLogDays.bind(sheet);
    sheet.deleteLogDays = async (m) => {
      if (n > 0) throw new Error('boom');
      return orig(m);
    };
    const r = await h.at(TUE_1000);
    expect(r.days.map((d) => d.outcome)).toEqual(Array(7).fill('written'));
    expect(h.logs.join('\n')).toContain('pruning days before 2026-10-06 failed');
  });
});

describe('status and logs carry no chat text', () => {
  it('chatExport = enabled / sheetConfigured / publicSheet + lastRun (day, counts, outcome) + catchUp (day counts)', async () => {
    const h = harness({ discord: discordPort({ extra: { truncatedChannels: 1, threadsOverCap: 2, archivedListsTruncated: 1, sourceIdsIgnored: 2 } }) });
    expect(h.service.getStatus()).toEqual({ enabled: true, sheetConfigured: false, publicSheet: false, lastRun: null, catchUp: null });
    await h.at(TUE_1000);
    const status = h.service.getStatus();
    expect(Object.keys(status).sort()).toEqual(['catchUp', 'enabled', 'lastRun', 'publicSheet', 'sheetConfigured']);
    expect(status.lastRun).toEqual({
      day: YESTERDAY,
      at: new Date(TUE_1000).toISOString(),
      messages: 3,
      channels: 2, // 一般聊天 + the thread (the sync channel had nothing)
      threads: 1,
      truncated: 4,
      outcome: 'written',
    });
    expect(Object.keys(status.catchUp!).sort()).toEqual(['expired', 'exported', 'failed', 'from', 'pending', 'skipped', 'startedAt', 'to']);
    const all = JSON.stringify(status) + h.logs.join('\n');
    for (const leaked of ['秘密內容', '一般聊天', '阿瓦隆同步', '討論區', '祕密標題', 'u0', 'u1', '成員', GENERAL, THREAD]) {
      expect(all).not.toContain(leaked);
    }
    expect(h.logs.join('\n')).toMatch(/threadsOverCap=2 archivedListsTruncated=1 failedChannels=0 sourceIdsIgnored=2/);
    // Unusable ids in the source lists: warned once (a count), not once per day.
    expect(h.logs.filter((l) => l.includes('id(s) in CHAT_EXPORT_SOURCE_CHANNEL_IDS / CHAT_EXPORT_EXTRA_SOURCE_IDS ignored'))).toHaveLength(1);
  });

  it('logs on failure paths carry no text either', async () => {
    const sheet = new FakeSheet();
    sheet.failAfterRows = 1;
    const h = harness({ sheet, discord: discordPort({ failed: (call) => (call === 0 ? 1 : 0) }) });
    await h.at(TUE_1000);
    await h.at(TUE_1000 + 10 * MIN);
    const logs = h.logs.join('\n');
    expect(logs).toMatch(/read-error|failed|writing failed/);
    for (const leaked of ['秘密內容', '一般聊天', '阿瓦隆同步', '討論區', '祕密標題', '成員']) expect(logs).not.toContain(leaked);
  });

  it('the random run id is 8 hex characters, different per process', () => {
    const one = new ChatExportService({ discord: discordPort() });
    const two = new ChatExportService({ discord: discordPort() });
    expect(one.runId).toMatch(/^[0-9a-f]{8}$/);
    expect(one.runId).not.toBe(two.runId);
  });
});

describe('wiring', () => {
  const env = { ...process.env };
  beforeEach(() => __resetChatExportForTests());
  afterEach(() => {
    __resetChatExportForTests();
    process.env = { ...env };
  });

  it('startChatExport creates the service and arms it only when enabled', () => {
    // start() ticks once right away: with the sheet off that tick never reaches the network.
    process.env.CHAT_EXPORT_SHEET_ID = 'off';
    process.env.CHAT_EXPORT_ENABLED = 'false';
    startChatExport();
    expect(getChatExportService()?.isRunning()).toBe(false);
    __resetChatExportForTests();
    delete process.env.CHAT_EXPORT_ENABLED;
    startChatExport();
    expect(getChatExportService()?.isRunning()).toBe(true);
    startChatExport(); // idempotent
    expect(getChatExportService()?.isRunning()).toBe(true);
  });

  it('/api/bots/status has chatExport (three booleans, lastRun, catchUp) and no communityDigest', () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: 'a@b.iam.gserviceaccount.com', private_key: 'k' });
    delete process.env.CHAT_EXPORT_SHEET_ID;
    delete process.env.CHAT_EXPORT_ALLOW_PUBLIC_SHEET;
    const expected = { enabled: true, sheetConfigured: true, publicSheet: false, lastRun: null, catchUp: null };
    expect(chatExportStatus()).toEqual(expected);
    const status = buildBotStatus() as unknown as Record<string, unknown>;
    expect(status.chatExport).toEqual(expected);
    expect(status).not.toHaveProperty('communityDigest');
    process.env.CHAT_EXPORT_SHEET_ID = 'off';
    expect(chatExportStatus().sheetConfigured).toBe(false);
    process.env.CHAT_EXPORT_SHEET_ID = PUBLIC_STATS_SHEET_ID;
    expect(chatExportStatus()).toMatchObject({ sheetConfigured: false, publicSheet: false });
    process.env.CHAT_EXPORT_ALLOW_PUBLIC_SHEET = '1';
    expect(chatExportStatus()).toMatchObject({ sheetConfigured: true, publicSheet: true });
  });

  it('the paid /社群週報 slash command is no longer registered (the bulk overwrite removes it from Discord)', () => {
    const names = buildSlashCommands().map((c) => c.toJSON().name);
    expect(names).not.toContain('社群週報');
    expect(Object.values(COMMANDS)).not.toContain('社群週報');
    expect(names).toEqual(expect.arrayContaining(['help', '戰績', '排行', '默契', '意見']));
  });
});
