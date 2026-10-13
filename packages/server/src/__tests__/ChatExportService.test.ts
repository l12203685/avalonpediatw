/**
 * Weekly chat-log export (2026-10-13) — the service with fake Discord and
 * sheet ports (no network):
 *
 *   schedule    — only Monday 09:00–12:00 +08, the previous week, once per
 *                 week; disabled flag; Discord not ready yet → wait; the
 *                 public stats sheet refused (not configured)
 *   idempotency — the export log 「匯出紀錄」: a week with a 完成 row is
 *                 skipped (restart); rows of a week without 完成 (process
 *                 killed mid-write, failed append, failed cleanup) are
 *                 deleted before the week is written again; a 完成 row
 *                 that landed although its request failed is trusted
 *   instances   — two servers (deploy overlap) at the same moment or one
 *                 mid-write: one holder writes, the other waits and then
 *                 finds 完成; a dead holder's claim goes stale after 30
 *                 minutes; a live claim is renewed between attempts
 *   retries     — Sheets errors retried after 10 minutes; some channels
 *                 unreadable → read once more, then exported; no channel
 *                 readable → never settled as empty, retried until 12:00
 *   pruning     — weeks before (week − 7 weeks) deleted from both tabs after
 *                 each export, and the rows of an older unfinished week
 *   status      — /api/bots/status → chatExport: two booleans + lastRun with
 *                 week / at / messages / channels / outcome, no text
 *   wiring      — startChatExport arms the timer only when enabled; the
 *                 /社群週報 slash command is gone; communityDigest is gone
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ChatExportService, __resetChatExportForTests, chatExportStatus, getChatExportService } from '../bots/chatExport/service';
import {
  CHAT_EXPORT_STATE_CLAIM,
  CHAT_EXPORT_STATE_DONE,
  readChatExportConfig,
  type ChatExportConfig,
} from '../bots/chatExport/config';
import type { ChatExportDiscordPort } from '../bots/chatExport/discordPort';
import type { ChatExportSheetPort, ExportLogEntry } from '../bots/chatExport/sheetWriter';
import type { ChatExportRow, RawChatMessage } from '../bots/chatExport/rows';
import type { CollectResult } from '../bots/chatExport/collector';
import { buildBotStatus, startChatExport } from '../bots';
import { buildSlashCommands } from '../bots/discord/client';
import { COMMANDS } from '../bots/discord/config';

const MON_0900 = Date.parse('2026-10-12T01:00:00Z'); // Mon 09:00 +08
const WEEK = '2026-10-05';
const GENERAL = '2000000000000000001';
const MIN = 60_000;

function chat(i: number, over: Partial<RawChatMessage> = {}): RawChatMessage {
  return {
    id: String(5_000_000_000_000_000_000n + BigInt(i)),
    channelId: GENERAL,
    createdAt: Date.parse('2026-10-06T12:00:00Z') + i * MIN,
    authorId: `u${i % 2}`,
    authorIsBot: false,
    authorIsSelf: false,
    webhookId: null,
    system: false,
    content: `秘密內容 ${i}`,
    attachmentCount: 0,
    ...over,
  };
}

function claimRow(week: string, at: number, runId: string): ExportLogEntry {
  return { week, state: CHAT_EXPORT_STATE_CLAIM, rows: 0, channels: 0, at, runId };
}

function doneRow(week: string, at: number, runId: string, rows = 1): ExportLogEntry {
  return { week, state: CHAT_EXPORT_STATE_DONE, rows, channels: 1, at, runId };
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
  async deleteWeeks(match: (week: string) => boolean): Promise<number> {
    if (this.failDelete) throw new Error('delete failed');
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => !match(r[0]));
    return before - this.rows.length;
  }
  async deleteLogWeeks(match: (week: string) => boolean): Promise<number> {
    if (this.failDelete) throw new Error('delete failed');
    const before = this.log.length;
    this.log = this.log.filter((e) => !match(e.week));
    return before - this.log.length;
  }
  states(week = WEEK): string[] {
    return this.log.filter((e) => e.week === week).map((e) => `${e.state}:${e.runId}`);
  }
}

function discordPort(opts: { ready?: boolean; messages?: RawChatMessage[]; failed?: number[]; channels?: number } = {}) {
  let call = 0;
  const port: ChatExportDiscordPort & { calls: number; ready: boolean; channels: number } = {
    calls: 0,
    ready: opts.ready ?? true,
    channels: opts.channels ?? 2,
    isReady(): boolean {
      return this.ready;
    },
    async collect(): Promise<CollectResult> {
      port.calls += 1;
      const failed = opts.failed?.[call] ?? 0;
      call += 1;
      return {
        messages: port.channels === 0 ? [] : (opts.messages ?? [chat(1), chat(2), chat(3, { channelId: '3000000000000000001' })]),
        channels: Array.from({ length: port.channels }, (_, i) =>
          i === 0 ? { id: GENERAL, name: '一般聊天', isMirror: false } : { id: '3000000000000000001', name: '阿瓦隆同步', isMirror: true },
        ),
        truncatedChannels: 0,
        failedChannels: failed,
        publicChannelsFound: 1,
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
  const clock = opts.clock ?? { now: MON_0900 };
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

describe('schedule', () => {
  it('runs only in the Monday 09:00–12:00 +08 window, for the previous week, once', async () => {
    const h = harness();
    expect(await h.service.tick(MON_0900 - MIN)).toBe('outside-window'); // Mon 08:59
    expect(await h.service.tick(MON_0900 + 3 * 60 * MIN)).toBe('outside-window'); // Mon 12:00
    expect(await h.service.tick(MON_0900 + 24 * 60 * MIN)).toBe('outside-window'); // Tuesday
    expect(h.discord.calls).toBe(0);
    expect(await h.at(MON_0900)).toBe('written');
    expect(h.sheet!.rows.map((r) => r[0])).toEqual([WEEK, WEEK, WEEK]);
    expect(h.sheet!.states()).toEqual(['進行中:run-a', '完成:run-a']);
    expect(h.sheet!.log[1]).toMatchObject({ rows: 3, channels: 2 });
    expect(await h.at(MON_0900 + MIN)).toBe('done');
    expect(h.discord.calls).toBe(1);
    // The next Monday is a new week.
    expect(await h.at(MON_0900 + 7 * 24 * 60 * MIN)).toBe('written');
    expect(new Set(h.sheet!.rows.map((r) => r[0]))).toEqual(new Set([WEEK, '2026-10-12']));
  });

  it('CHAT_EXPORT_ENABLED=false → nothing; Discord not ready yet → waits and catches up later', async () => {
    expect(await harness({ config: { enabled: false } }).service.tick(MON_0900)).toBe('disabled');
    const h = harness({ discord: discordPort({ ready: false }) });
    expect(await h.at(MON_0900)).toBe('discord-not-ready');
    expect(h.sheet!.prepared).toBe(0);
    expect(h.sheet!.log).toEqual([]); // no claim while Discord is down
    h.discord.ready = true;
    expect(await h.at(MON_0900 + 47 * MIN)).toBe('written'); // catch-up at 09:47
  });

  it('no sheet configured → settled for the week, counted as not-configured, Discord never read', async () => {
    const h = harness({ sheet: null });
    expect(await h.at(MON_0900)).toBe('not-configured');
    expect(await h.at(MON_0900 + MIN)).toBe('done');
    expect(h.discord.calls).toBe(0);
    expect(h.service.getStatus().lastRun).toMatchObject({ week: WEEK, outcome: 'not-configured', messages: 0 });
    expect(h.logs.join('\n')).toContain('no-sheet-id');
  });

  it('the public stats sheet as CHAT_EXPORT_SHEET_ID is refused: not configured, nothing written', async () => {
    const env = {
      CHAT_EXPORT_SHEET_ID: '174L-by-dtP6IY1pRy8nMpG6_3RMBQXmAV4kTfIgmyIU',
      GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: 'a@b.iam.gserviceaccount.com', private_key: 'k' }),
    };
    const sheet = new FakeSheet();
    const logs: string[] = [];
    const service = new ChatExportService({
      discord: discordPort(),
      // The real factory: no client without a sheet id.
      sheetFactory: (cfg) => (cfg.sheetId ? { sheet, reason: 'ok' } : { sheet: null, reason: 'no-sheet-id' }),
      config: () => readChatExportConfig(env),
      now: () => MON_0900,
      logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
    });
    expect(service.getStatus().sheetConfigured).toBe(false);
    expect(await service.tick(MON_0900)).toBe('not-configured');
    expect(logs.join('\n')).toContain('public-sheet-refused');
    expect(sheet.prepared).toBe(0);
    expect(sheet.rows).toEqual([]);
  });
});

describe('idempotency: the export log', () => {
  it('a week with a 完成 row (restart, or another instance wrote it) is not read or written again', async () => {
    const sheet = new FakeSheet();
    sheet.rows.push([WEEK, '2026-10-06 20:00', '一般聊天', 'Discord', '成員1', 'x']);
    sheet.log.push(claimRow(WEEK, MON_0900, 'old'), doneRow(WEEK, MON_0900 + MIN, 'old'));
    const h = harness({ sheet });
    expect(await h.at(MON_0900 + 20 * MIN)).toBe('already-exported');
    expect(h.discord.calls).toBe(0);
    expect(sheet.appendCalls).toBe(0);
    expect(sheet.rows).toHaveLength(1);
    expect(h.service.getStatus().lastRun).toMatchObject({ outcome: 'already-exported', messages: 0 });
    expect(await h.at(MON_0900 + 21 * MIN)).toBe('done');
  });

  it('process killed after the first batch: the next instance waits for the stale claim, deletes the partial rows, writes the week once', async () => {
    const sheet = new FakeSheet();
    // The dead instance took the week at 09:00 and got 2 of 3 rows in.
    sheet.log.push(claimRow(WEEK, MON_0900, 'dead'));
    sheet.rows.push([WEEK, 'x', 'x', 'Discord', '成員1', 'partial'], [WEEK, 'x', 'x', 'Discord', '成員2', 'partial']);
    const h = harness({ sheet, runId: 'new' });
    expect(await h.at(MON_0900 + 5 * MIN)).toBe('claimed-elsewhere');
    expect(h.service.getStatus().lastRun?.outcome).toBe('claimed-elsewhere');
    expect(h.discord.calls).toBe(0);
    expect(await h.at(MON_0900 + 10 * MIN)).toBe('waiting');
    expect(await h.at(MON_0900 + 16 * MIN)).toBe('claimed-elsewhere'); // still fresh (< 30 min)
    expect(await h.at(MON_0900 + 30 * MIN)).toBe('written'); // stale → taken over
    expect(sheet.rows).toHaveLength(3); // not 5
    expect(sheet.rows.some((r) => r[5] === 'partial')).toBe(false);
    expect(sheet.states()).toEqual(['進行中:dead', '進行中:new', '完成:new']);
    expect(h.logs.join('\n')).toContain('removed 2 row(s) left by an interrupted export');
  });

  it('a failed append removes the half-written week and retries 10 minutes later', async () => {
    const sheet = new FakeSheet();
    sheet.failAfterRows = 2;
    const h = harness({ sheet });
    expect(await h.at(MON_0900)).toBe('retry');
    expect(sheet.rows).toEqual([]); // cleaned up
    expect(sheet.states()).toEqual(['進行中:run-a']); // no 完成
    expect(h.service.getStatus().lastRun?.outcome).toBe('sheet-error');
    expect(await h.at(MON_0900 + 5 * MIN)).toBe('waiting');
    sheet.failAfterRows = null;
    expect(await h.at(MON_0900 + 11 * MIN)).toBe('written');
    expect(sheet.rows).toHaveLength(3);
  });

  it('when the cleanup fails too, the next attempt deletes the week first (no 完成 row) instead of trusting it', async () => {
    const sheet = new FakeSheet();
    sheet.failAfterRows = 2;
    sheet.beforeAppend = async () => {
      sheet.failDelete = true; // the cleanup after the failed append fails too
    };
    const h = harness({ sheet });
    expect(await h.at(MON_0900)).toBe('retry');
    expect(sheet.rows).toHaveLength(2); // half-written, cleanup failed
    expect(h.logs.join('\n')).toContain('cleanup failed too');
    sheet.failAfterRows = null;
    sheet.failDelete = false;
    // Even a brand-new process (restart) does not trust those rows.
    const h2 = harness({ sheet, runId: 'run-b' });
    expect(await h2.at(MON_0900 + 31 * MIN)).toBe('written');
    expect(sheet.rows).toHaveLength(3); // not 5: the 2 partial rows were deleted first
    expect(h2.logs.join('\n')).toContain('interrupted export');
  });

  it('the 完成 request fails but the row landed: the rows are kept and the next attempt finds 完成', async () => {
    const sheet = new FakeSheet();
    sheet.failDone = true;
    sheet.doneLands = true;
    const h = harness({ sheet });
    expect(await h.at(MON_0900)).toBe('retry');
    expect(sheet.rows).toHaveLength(3); // not cleaned up: 完成 may be there
    sheet.failDone = false;
    expect(await h.at(MON_0900 + 10 * MIN)).toBe('already-exported');
    expect(sheet.rows).toHaveLength(3);
  });

  it('the 完成 request fails and did not land: the next attempt deletes the rows and writes the week again', async () => {
    const sheet = new FakeSheet();
    sheet.failDone = true;
    const h = harness({ sheet });
    expect(await h.at(MON_0900)).toBe('retry');
    sheet.failDone = false;
    expect(await h.at(MON_0900 + 10 * MIN)).toBe('written');
    expect(sheet.rows).toHaveLength(3);
    expect(sheet.states()).toEqual(['進行中:run-a', '完成:run-a']);
  });
});

describe('two server instances (deploy overlap)', () => {
  it('both start at the same moment: one writes the week, the other waits and then finds 完成', async () => {
    const sheet = new FakeSheet();
    const clock = { now: MON_0900 };
    const a = harness({ sheet, runId: 'a', clock });
    const b = harness({ sheet, runId: 'b', clock });
    const results = await Promise.all([a.service.tick(MON_0900), b.service.tick(MON_0900)]);
    expect([...results].sort()).toEqual(['claimed-elsewhere', 'written']);
    // Both saw an empty log and both claimed; the first claim in sheet order holds the week.
    expect(sheet.states()).toEqual(['進行中:a', '進行中:b', '完成:a']);
    expect(sheet.rows).toHaveLength(3); // not 6
    expect(sheet.appendCalls).toBe(1);
    expect(a.discord.calls + b.discord.calls).toBe(1);
    const loser = results[0] === 'written' ? b : a;
    expect(await loser.at(MON_0900 + 10 * MIN)).toBe('already-exported');
    expect(sheet.rows).toHaveLength(3);
  });

  it('the second instance comes up while the first is writing: it does not read or write', async () => {
    const sheet = new FakeSheet();
    const clock = { now: MON_0900 };
    const a = harness({ sheet, runId: 'a', clock });
    const b = harness({ sheet, runId: 'b', clock });
    let mid: string | null = null;
    sheet.beforeAppend = async () => {
      mid = await b.service.tick(MON_0900 + MIN);
    };
    expect(await a.service.tick(MON_0900)).toBe('written');
    expect(mid).toBe('claimed-elsewhere');
    expect(b.discord.calls).toBe(0);
    expect(sheet.rows).toHaveLength(3);
  });

  it('a live claim is renewed between attempts, so a second instance keeps waiting', async () => {
    const sheet = new FakeSheet();
    const a = harness({ sheet, runId: 'a', discord: discordPort({ channels: 0 }) });
    for (const m of [0, 10, 20, 30, 40]) expect(await a.at(MON_0900 + m * MIN)).toBe('retry'); // Discord unreadable
    const claims = sheet.log.filter((e) => e.runId === 'a').map((e) => (e.at - MON_0900) / MIN);
    expect(claims).toEqual([0, 20, 40]); // renewed once older than 15 minutes
    const b = harness({ sheet, runId: 'b' });
    expect(await b.at(MON_0900 + 45 * MIN)).toBe('claimed-elsewhere');
    // a recovers and writes; b then finds 完成.
    a.discord.channels = 2;
    expect(await a.at(MON_0900 + 50 * MIN)).toBe('written');
    expect(await b.at(MON_0900 + 55 * MIN)).toBe('already-exported');
    expect(sheet.rows).toHaveLength(3);
  });
});

describe('retries', () => {
  it('a Sheets error before writing → retried in 10 minutes', async () => {
    const sheet = new FakeSheet();
    sheet.failPrepare = true;
    const h = harness({ sheet });
    expect(await h.at(MON_0900)).toBe('retry');
    expect(h.discord.calls).toBe(0);
    sheet.failPrepare = false;
    expect(await h.at(MON_0900 + 10 * MIN)).toBe('written');
  });

  it('some channels unreadable: read again once, then export what was read', async () => {
    const h = harness({ discord: discordPort({ failed: [1, 1] }) });
    expect(await h.at(MON_0900)).toBe('retry');
    expect(h.service.getStatus().lastRun?.outcome).toBe('read-error');
    expect(h.sheet!.appendCalls).toBe(0);
    expect(await h.at(MON_0900 + 10 * MIN)).toBe('written');
    expect(h.discord.calls).toBe(2);
  });

  it('no channel readable at all is never recorded as an empty week: read again every 10 minutes until 12:00', async () => {
    const h = harness({ discord: discordPort({ channels: 0, failed: Array(20).fill(3) }) });
    for (let m = 0; m < 180; m += 10) expect(await h.at(MON_0900 + m * MIN)).toBe('retry');
    expect(h.discord.calls).toBe(18);
    expect(h.service.getStatus().lastRun).toMatchObject({ outcome: 'read-error', messages: 0 });
    expect(h.sheet!.log.some((e) => e.state === CHAT_EXPORT_STATE_DONE)).toBe(false);
    expect(await h.at(MON_0900 + 180 * MIN)).toBe('outside-window');
  });

  it('no channel readable, then Discord recovers before 12:00 → the week is written', async () => {
    const h = harness({ discord: discordPort({ channels: 0 }) });
    expect(await h.at(MON_0900)).toBe('retry');
    expect(await h.at(MON_0900 + 10 * MIN)).toBe('retry');
    h.discord.channels = 2;
    expect(await h.at(MON_0900 + 20 * MIN)).toBe('written');
    expect(h.sheet!.rows).toHaveLength(3);
  });

  it('a quiet week (only bot posts and commands) is settled as empty: nothing appended, 完成 with 0 rows', async () => {
    const h = harness({ discord: discordPort({ messages: [chat(1, { content: '/排行' }), chat(2, { authorIsBot: true })] }) });
    expect(await h.at(MON_0900)).toBe('empty');
    expect(h.sheet!.appendCalls).toBe(0);
    expect(h.sheet!.log.at(-1)).toMatchObject({ state: CHAT_EXPORT_STATE_DONE, rows: 0 });
    expect(await h.at(MON_0900 + MIN)).toBe('done');
    // After a restart it stays settled.
    expect(await harness({ sheet: h.sheet, runId: 'run-b' }).at(MON_0900 + 2 * MIN)).toBe('already-exported');
  });
});

describe('pruning', () => {
  it('keeps the exported week and the 7 before it, in both tabs', async () => {
    const sheet = new FakeSheet();
    for (const wk of ['2026-08-03', '2026-08-10', '2026-08-17', '2026-09-28']) {
      sheet.rows.push([wk, '', '', '', '', '']);
      sheet.log.push(doneRow(wk, Date.parse(`${wk}T01:00:00Z`) + 7 * 86_400_000, 'old'));
    }
    const h = harness({ sheet });
    expect(await h.at(MON_0900)).toBe('written');
    expect([...new Set(sheet.rows.map((r) => r[0]))]).toEqual(['2026-08-17', '2026-09-28', WEEK]);
    expect([...new Set(sheet.log.map((e) => e.week))]).toEqual(['2026-08-17', '2026-09-28', WEEK]);
    expect(h.logs.join('\n')).toMatch(/pruned=2/);
  });

  it('rows of an older week that was taken but never finished are deleted at the next export', async () => {
    const sheet = new FakeSheet();
    sheet.rows.push(['2026-09-28', '', '', '', '', 'partial'], ['2026-09-21', '', '', '', '', 'complete']);
    sheet.log.push(
      doneRow('2026-09-21', MON_0900 - 14 * 86_400_000, 'old'),
      claimRow('2026-09-28', MON_0900 - 7 * 86_400_000, 'old'), // cut off before 12:00 last Monday
    );
    const h = harness({ sheet });
    expect(await h.at(MON_0900)).toBe('written');
    expect(sheet.rows.map((r) => r[0])).toEqual(['2026-09-21', WEEK, WEEK, WEEK]);
  });

  it('a pruning failure only warns; the export still counts', async () => {
    const sheet = new FakeSheet();
    sheet.rows.push(['2026-01-05', '', '', '', '', '']);
    const h = harness({ sheet });
    sheet.beforeAppend = async () => {
      sheet.failDelete = true; // after the pre-write cleanup, before pruning
    };
    expect(await h.at(MON_0900)).toBe('written');
    expect(h.logs.join('\n')).toContain('pruning weeks before 2026-08-17 failed');
  });
});

describe('status and logs carry no chat text', () => {
  it('lastRun = week, at, messages, channels, outcome', async () => {
    const h = harness();
    expect(h.service.getStatus()).toEqual({ enabled: true, sheetConfigured: false, lastRun: null });
    await h.at(MON_0900);
    const status = h.service.getStatus();
    expect(Object.keys(status).sort()).toEqual(['enabled', 'lastRun', 'sheetConfigured']);
    expect(Object.keys(status.lastRun!).sort()).toEqual(['at', 'channels', 'messages', 'outcome', 'week']);
    expect(status.lastRun).toEqual({ week: WEEK, at: new Date(MON_0900).toISOString(), messages: 3, channels: 2, outcome: 'written' });
    const all = JSON.stringify(status) + h.logs.join('\n');
    for (const leaked of ['秘密內容', '一般聊天', '阿瓦隆同步', 'u0', 'u1', '成員']) expect(all).not.toContain(leaked);
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
    // start() ticks once right away: with the sheet off that tick never reaches the network, whatever today is.
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

  it('/api/bots/status has chatExport (booleans + lastRun) and no communityDigest', () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: 'a@b.iam.gserviceaccount.com', private_key: 'k' });
    expect(chatExportStatus()).toEqual({ enabled: true, sheetConfigured: true, lastRun: null });
    const status = buildBotStatus() as unknown as Record<string, unknown>;
    expect(status.chatExport).toEqual({ enabled: true, sheetConfigured: true, lastRun: null });
    expect(status).not.toHaveProperty('communityDigest');
    process.env.CHAT_EXPORT_SHEET_ID = 'off';
    expect(chatExportStatus().sheetConfigured).toBe(false);
  });

  it('the paid /社群週報 slash command is no longer registered (the bulk overwrite removes it from Discord)', () => {
    const names = buildSlashCommands().map((c) => c.toJSON().name);
    expect(names).not.toContain('社群週報');
    expect(Object.values(COMMANDS)).not.toContain('社群週報');
    expect(names).toEqual(expect.arrayContaining(['help', '戰績', '排行', '默契', '意見']));
  });
});
