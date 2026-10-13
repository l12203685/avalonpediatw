/**
 * Weekly chat-log export (2026-10-13) — the service with fake Discord and
 * sheet ports (no network):
 *
 *   schedule    — only Monday 09:00–12:00 +08, the previous week, once per
 *                 week; disabled flag; Discord not ready yet → wait
 *   idempotency — a week already in the sheet is skipped (restart); a
 *                 half-written week is cleaned up, or deleted first on the
 *                 next attempt when the cleanup failed too
 *   retries     — Sheets errors and unreadable channels retried after 10
 *                 minutes inside the window; an empty week is settled
 *   pruning     — weeks before (week − 7 weeks) deleted after each export
 *   status      — /api/bots/status → chatExport: two booleans + lastRun with
 *                 week / at / messages / channels / outcome, no text
 *   wiring      — startChatExport arms the timer only when enabled; the
 *                 /社群週報 slash command is gone; communityDigest is gone
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ChatExportService, __resetChatExportForTests, chatExportStatus, getChatExportService } from '../bots/chatExport/service';
import { readChatExportConfig, type ChatExportConfig } from '../bots/chatExport/config';
import type { ChatExportDiscordPort } from '../bots/chatExport/discordPort';
import type { ChatExportSheetPort } from '../bots/chatExport/sheetWriter';
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

class FakeSheet implements ChatExportSheetPort {
  rows: ChatExportRow[] = [];
  prepared = 0;
  appendCalls = 0;
  failPrepare = false;
  /** Rows to accept before an append fails (null = never fails). */
  failAfterRows: number | null = null;
  failDelete = false;
  deleteCalls: string[] = [];

  async prepare(): Promise<void> {
    this.prepared += 1;
    if (this.failPrepare) throw new Error('HTTP 503');
  }
  async hasWeek(week: string): Promise<boolean> {
    return this.rows.some((r) => r[0] === week);
  }
  async appendRows(rows: ChatExportRow[]): Promise<number> {
    this.appendCalls += 1;
    if (this.failAfterRows !== null) {
      this.rows.push(...rows.slice(0, this.failAfterRows));
      throw new Error('append failed');
    }
    this.rows.push(...rows);
    return Math.ceil(rows.length / 500);
  }
  async deleteWeeks(match: (week: string) => boolean): Promise<number> {
    this.deleteCalls.push('delete');
    if (this.failDelete) throw new Error('delete failed');
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => !match(r[0]));
    return before - this.rows.length;
  }
}

function discordPort(opts: { ready?: boolean; messages?: RawChatMessage[]; failed?: number[]; channels?: number } = {}) {
  let call = 0;
  const port: ChatExportDiscordPort & { calls: number; ready: boolean } = {
    calls: 0,
    ready: opts.ready ?? true,
    isReady(): boolean {
      return this.ready;
    },
    async collect(): Promise<CollectResult> {
      port.calls += 1;
      const failed = opts.failed?.[call] ?? 0;
      call += 1;
      return {
        messages: opts.messages ?? [chat(1), chat(2), chat(3, { channelId: '3000000000000000001' })],
        channels: Array.from({ length: opts.channels ?? 2 }, (_, i) =>
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
  } = {},
) {
  const sheet = opts.sheet === undefined ? new FakeSheet() : opts.sheet;
  const discord = opts.discord ?? discordPort();
  const logs: string[] = [];
  const clock = { now: MON_0900 };
  const service = new ChatExportService({
    discord,
    sheetFactory: () => (sheet ? { sheet, reason: 'ok' } : { sheet: null, reason: 'no-credentials' }),
    config: () => ({ ...readChatExportConfig({}), ...opts.config }),
    now: () => clock.now,
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
  });
  return { service, sheet, discord, logs, clock };
}

describe('schedule', () => {
  it('runs only in the Monday 09:00–12:00 +08 window, for the previous week, once', async () => {
    const h = harness();
    expect(await h.service.tick(MON_0900 - MIN)).toBe('outside-window'); // Mon 08:59
    expect(await h.service.tick(MON_0900 + 3 * 60 * MIN)).toBe('outside-window'); // Mon 12:00
    expect(await h.service.tick(MON_0900 + 24 * 60 * MIN)).toBe('outside-window'); // Tuesday
    expect(h.discord.calls).toBe(0);
    expect(await h.service.tick(MON_0900)).toBe('written');
    expect(h.sheet!.rows.map((r) => r[0])).toEqual([WEEK, WEEK, WEEK]);
    expect(await h.service.tick(MON_0900 + MIN)).toBe('done');
    expect(h.discord.calls).toBe(1);
    // The next Monday is a new week.
    h.clock.now = MON_0900 + 7 * 24 * 60 * MIN;
    expect(await h.service.tick(h.clock.now)).toBe('written');
    expect(new Set(h.sheet!.rows.map((r) => r[0]))).toEqual(new Set([WEEK, '2026-10-12']));
  });

  it('CHAT_EXPORT_ENABLED=false → nothing; Discord not ready yet → waits and catches up later', async () => {
    expect(await harness({ config: { enabled: false } }).service.tick(MON_0900)).toBe('disabled');
    const h = harness({ discord: discordPort({ ready: false }) });
    expect(await h.service.tick(MON_0900)).toBe('discord-not-ready');
    expect(h.sheet!.prepared).toBe(0);
    h.discord.ready = true;
    expect(await h.service.tick(MON_0900 + 47 * MIN)).toBe('written'); // catch-up at 09:47
  });

  it('no sheet configured → settled for the week, counted as not-configured, Discord never read', async () => {
    const h = harness({ sheet: null });
    expect(await h.service.tick(MON_0900)).toBe('not-configured');
    expect(await h.service.tick(MON_0900 + MIN)).toBe('done');
    expect(h.discord.calls).toBe(0);
    expect(h.service.getStatus().lastRun).toMatchObject({ week: WEEK, outcome: 'not-configured', messages: 0 });
    expect(h.logs.join('\n')).toContain('no-credentials');
  });
});

describe('idempotency and retries', () => {
  it('a week already in the sheet (restart) is not read or written again', async () => {
    const sheet = new FakeSheet();
    sheet.rows.push([WEEK, '2026-10-06 20:00', '一般聊天', 'Discord', '成員1', 'x']);
    const h = harness({ sheet });
    expect(await h.service.tick(MON_0900 + 20 * MIN)).toBe('already-exported');
    expect(h.discord.calls).toBe(0);
    expect(sheet.appendCalls).toBe(0);
    expect(sheet.rows).toHaveLength(1);
  });

  it('a failed append removes the half-written week and retries 10 minutes later', async () => {
    const sheet = new FakeSheet();
    sheet.failAfterRows = 2;
    const h = harness({ sheet });
    expect(await h.service.tick(MON_0900)).toBe('retry');
    expect(sheet.rows).toEqual([]); // cleaned up
    expect(h.service.getStatus().lastRun?.outcome).toBe('sheet-error');
    h.clock.now = MON_0900 + 5 * MIN;
    expect(await h.service.tick(h.clock.now)).toBe('waiting');
    sheet.failAfterRows = null;
    h.clock.now = MON_0900 + 11 * MIN;
    expect(await h.service.tick(h.clock.now)).toBe('written');
    expect(sheet.rows).toHaveLength(3);
  });

  it('when the cleanup fails too, the next attempt deletes the week first instead of trusting it', async () => {
    const sheet = new FakeSheet();
    sheet.failAfterRows = 2;
    sheet.failDelete = true;
    const h = harness({ sheet });
    expect(await h.service.tick(MON_0900)).toBe('retry');
    expect(sheet.rows).toHaveLength(2); // half-written, cleanup failed
    sheet.failAfterRows = null;
    sheet.failDelete = false;
    h.clock.now = MON_0900 + 11 * MIN;
    expect(await h.service.tick(h.clock.now)).toBe('written');
    expect(sheet.rows).toHaveLength(3); // not 5: the 2 partial rows were deleted first
    expect(h.logs.join('\n')).toContain('interrupted export');
  });

  it('a Sheets error before writing → retried in 10 minutes', async () => {
    const sheet = new FakeSheet();
    sheet.failPrepare = true;
    const h = harness({ sheet });
    expect(await h.service.tick(MON_0900)).toBe('retry');
    expect(h.discord.calls).toBe(0);
    sheet.failPrepare = false;
    expect(await h.service.tick(MON_0900 + 10 * MIN)).toBe('written');
  });

  it('unreadable channels: read again once, then export what was read', async () => {
    const h = harness({ discord: discordPort({ failed: [1, 1] }) });
    expect(await h.service.tick(MON_0900)).toBe('retry');
    expect(h.service.getStatus().lastRun?.outcome).toBe('read-error');
    expect(h.sheet!.appendCalls).toBe(0);
    expect(await h.service.tick(MON_0900 + 10 * MIN)).toBe('written');
    expect(h.discord.calls).toBe(2);
  });

  it('no channel could be read at all is not mistaken for a quiet week on the first try', async () => {
    const h = harness({ discord: discordPort({ messages: [], channels: 0 }) });
    expect(await h.service.tick(MON_0900)).toBe('retry');
    expect(await h.service.tick(MON_0900 + 10 * MIN)).toBe('empty');
    expect(h.service.getStatus().lastRun).toMatchObject({ outcome: 'empty', messages: 0, channels: 0 });
  });

  it('a quiet week (only bot posts and commands) is settled as empty, nothing appended', async () => {
    const h = harness({ discord: discordPort({ messages: [chat(1, { content: '/排行' }), chat(2, { authorIsBot: true })] }) });
    expect(await h.service.tick(MON_0900)).toBe('empty');
    expect(h.sheet!.appendCalls).toBe(0);
    expect(await h.service.tick(MON_0900 + MIN)).toBe('done');
  });
});

describe('pruning', () => {
  it('keeps the exported week and the 7 before it', async () => {
    const sheet = new FakeSheet();
    for (const wk of ['2026-08-03', '2026-08-10', '2026-08-17', '2026-09-28']) sheet.rows.push([wk, '', '', '', '', '']);
    const h = harness({ sheet });
    expect(await h.service.tick(MON_0900)).toBe('written');
    expect([...new Set(sheet.rows.map((r) => r[0]))]).toEqual(['2026-08-17', '2026-09-28', WEEK]);
    expect(h.logs.join('\n')).toMatch(/pruned=2/);
  });

  it('a pruning failure only warns; the export still counts', async () => {
    const sheet = new FakeSheet();
    sheet.rows.push(['2026-01-05', '', '', '', '', '']);
    const h = harness({ sheet });
    sheet.failDelete = true;
    expect(await h.service.tick(MON_0900)).toBe('written');
    expect(h.logs.join('\n')).toContain('pruning weeks before 2026-08-17 failed');
  });
});

describe('status and logs carry no chat text', () => {
  it('lastRun = week, at, messages, channels, outcome', async () => {
    const h = harness();
    expect(h.service.getStatus()).toEqual({ enabled: true, sheetConfigured: false, lastRun: null });
    await h.service.tick(MON_0900);
    const status = h.service.getStatus();
    expect(Object.keys(status).sort()).toEqual(['enabled', 'lastRun', 'sheetConfigured']);
    expect(Object.keys(status.lastRun!).sort()).toEqual(['at', 'channels', 'messages', 'outcome', 'week']);
    expect(status.lastRun).toEqual({ week: WEEK, at: new Date(MON_0900).toISOString(), messages: 3, channels: 2, outcome: 'written' });
    const all = JSON.stringify(status) + h.logs.join('\n');
    for (const leaked of ['秘密內容', '一般聊天', '阿瓦隆同步', 'u0', 'u1', '成員']) expect(all).not.toContain(leaked);
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
