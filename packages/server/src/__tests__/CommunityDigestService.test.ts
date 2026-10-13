/**
 * Weekly community digest (2026-10-13) — orchestration with fakes:
 *
 *   schedule    — only Monday 09:00–12:00 +08 (start + catch-up);
 *                 previous-week window; once per week per destination;
 *                 after a restart the admin channel marker / the sheet row
 *                 prevent a second post (and a second paid API call); a
 *                 partly sent post resumes from the next chunk
 *   failures    — transient API error: one more attempt after 10 minutes,
 *                 then a failure notice; unreadable channels ≠ quiet week;
 *                 refusal: no digest, no retry; no destination: no API
 *                 call; public admin channel: Discord skipped, sheet kept
 *   port        — real Discord adapter: no pings, marker check counts only
 *                 the bot's own posts, needs Read Message History
 *   wiring      — bots/index.ts: /意見 forwarder has the 管理者信箱 fallback,
 *                 the digest service is created at startup
 *   manual      — /社群週報 report (counts only), cooldown, disabled
 *   status      — /api/bots/status communityDigest: booleans + lastRun counts
 *   slash cmd   — registered for ManageGuild only, server-only, not in /help;
 *                 ephemeral status reply without summary text
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageFlags, PermissionFlagsBits } from 'discord.js';

import {
  CommunityDigestService,
  __resetCommunityDigestForTests,
  initializeCommunityDigest,
  type DigestSheetPort,
} from '../bots/digest/service';
import type { DigestAdminResolution, DigestDiscordPort } from '../bots/digest/discordPort';
import type { Summarizer, SummaryResult, DigestPromptInput } from '../bots/digest/summarizer';
import { readDigestConfig, type CommunityDigestConfig } from '../bots/digest/config';
import type { DigestRawMessage, DigestChannel } from '../bots/digest/transcript';
import type { DigestSheetRow } from '../bots/digest/sheets';
import { formatRunReport, handleCommunityDigestCommand, COMMUNITY_DIGEST_NOT_ALLOWED_TEXT } from '../bots/digest/discordCommand';
import { buildSlashCommands } from '../bots/discord/client';
import { COMMANDS } from '../bots/discord/config';
import { handleHelpCommand } from '../bots/discord/commands';
import { buildBotStatus, buildFeedbackForwarder, startCommunityDigest } from '../bots/index';
import { createDiscordDigestPort } from '../bots/digest/discordPort';
import { getCommunityDigestService } from '../bots/digest/service';
import { NO_PUBLIC_CHANNELS_TEXT } from '../bots/digest/format';
import { ChannelType, Collection } from 'discord.js';
import type { Client } from 'discord.js';

const MON_0900 = Date.parse('2026-10-12T01:00:00Z'); // Monday 09:00 +08
const IN_LAST_WEEK = Date.parse('2026-10-08T12:00:00Z'); // Thu 20:00 +08
const MARKER = '🤖 社群週報 2026-10-05～10-11';
const SUMMARY = '## 本週一句話總結\n- 大家在聊排行榜的門檻';
const SECRET_CHAT = '我覺得小明昨天那局刺殺很扯';

const silent = { info: vi.fn(), warn: vi.fn() };

const channels: DigestChannel[] = [{ id: '1132901301802504242', name: '阿瓦隆同步', isMirror: true }];

function chat(text: string, at = IN_LAST_WEEK, authorId = 'd-1'): DigestRawMessage {
  return {
    id: String(at),
    channelId: channels[0].id,
    createdAt: at,
    authorId,
    authorIsBot: false,
    authorIsSelf: false,
    webhookId: null,
    system: false,
    content: text,
    attachmentCount: 0,
  };
}

interface Harness {
  service: CommunityDigestService;
  posts: string[];
  rows: DigestSheetRow[];
  summarize: ReturnType<typeof vi.fn>;
  collect: ReturnType<typeof vi.fn>;
  port: DigestDiscordPort & {
    ready: boolean;
    admin: DigestAdminResolution['ok'] | 'public';
    history: string[];
    /** Return true to make this send() throw (nothing is posted). */
    failSend: (content: string, attempt: number) => boolean;
    sendAttempts: number;
  };
  sheet: DigestSheetPort & { failNext: boolean };
  now: { t: number };
  logs: string[];
}

function harness(
  opts: {
    messages?: DigestRawMessage[];
    results?: SummaryResult[];
    cfg?: Partial<CommunityDigestConfig>;
    sheet?: boolean;
    history?: string[];
    rows?: DigestSheetRow[];
    collected?: { failedChannels?: number; publicChannelsFound?: number | null };
  } = {},
): Harness {
  const posts: string[] = [];
  const rows: DigestSheetRow[] = opts.rows ?? [];
  const now = { t: MON_0900 };
  const logs: string[] = [];
  const queue = [...(opts.results ?? [])];
  const summarize = vi.fn(async (_input: DigestPromptInput, model: string): Promise<SummaryResult> =>
    queue.shift() ?? { outcome: 'ok', text: SUMMARY, model, inputTokens: 12_000, outputTokens: 900, retryable: false },
  );
  const collect = vi.fn(async (_cfg: CommunityDigestConfig, w: { start: number; end: number }) => ({
    messages: (opts.messages ?? [chat(SECRET_CHAT)]).filter((m) => m.createdAt >= w.start && m.createdAt < w.end),
    channels,
    truncatedChannels: 0,
    failedChannels: opts.collected?.failedChannels ?? 0,
    publicChannelsFound: opts.collected?.publicChannelsFound ?? null,
  }));
  const port = {
    ready: true,
    admin: true as boolean | 'public',
    history: opts.history ?? [],
    failSend: () => false,
    sendAttempts: 0,
    isReady: () => port.ready,
    resolveAdmin: async (): Promise<DigestAdminResolution> =>
      port.admin === true
        ? {
            ok: true,
            target: {
              id: 'admin-channel',
              send: async (c: string) => {
                port.sendAttempts += 1;
                if (port.failSend(c, port.sendAttempts)) throw new Error('Discord 500');
                posts.push(c);
                port.history.push(c);
              },
              hasRecentMarker: async (marker: string) => port.history.some((p) => p.startsWith(marker)),
            },
          }
        : { ok: false, problem: 'public', detail: '名為「管理者信箱」的頻道所有人都看得到，為了隱私不貼' },
    collect,
  } as Harness['port'];
  const sheet = {
    failNext: false,
    appendRow: vi.fn(async (row: DigestSheetRow) => {
      if (sheet.failNext) {
        sheet.failNext = false;
        throw new Error('boom');
      }
      rows.push(row);
    }),
    hasWeek: vi.fn(async (week: string) => rows.some((r) => r.week === week && !r.period.includes('手動'))),
  } as Harness['sheet'];
  const service = new CommunityDigestService({
    discord: port,
    summarizer: { summarize } as Summarizer,
    sheetFactory: () => (opts.sheet === false ? { writer: null, reason: 'no-credentials' } : { writer: sheet, reason: 'ok' }),
    config: () => ({ ...readDigestConfig({ ANTHROPIC_API_KEY: 'test-key' }), ...opts.cfg }),
    now: () => now.t,
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
  });
  return { service, posts, rows, summarize, collect, port, sheet, now, logs };
}

afterEach(() => {
  __resetCommunityDigestForTests();
  vi.restoreAllMocks();
});

describe('Monday schedule', () => {
  it('outside Monday 09:00–12:00 +08 nothing runs', async () => {
    const h = harness();
    for (const t of ['2026-10-12T00:59:00Z', '2026-10-12T04:00:00Z', '2026-10-13T01:00:00Z', '2026-10-11T01:00:00Z']) {
      expect(await h.service.tick(Date.parse(t))).toBe('outside-window');
    }
    expect(h.summarize).not.toHaveBeenCalled();
    expect(h.posts).toEqual([]);
  });

  it('posts the previous week once to the admin channel and the sheet, with the marker first', async () => {
    const h = harness();
    expect(await h.service.tick(MON_0900)).toBe('posted');
    expect(h.summarize).toHaveBeenCalledTimes(1);
    const input = h.summarize.mock.calls[0][0] as DigestPromptInput;
    expect(input.window.weekKey).toBe('2026-10-05');
    expect(input.transcript.included).toBe(1);
    expect(h.collect.mock.calls[0][2]).toEqual(['admin-channel']); // the admin channel itself is never read
    expect(h.posts[0].split('\n')[0]).toBe(MARKER);
    expect(h.posts.join('\n')).toContain(SUMMARY);
    expect(h.rows).toHaveLength(1);
    expect(h.rows[0]).toMatchObject({ week: '2026-10-05', period: '2026-10-05 00:00～2026-10-11 24:00', messages: 1, channels: 1, omitted: 0, model: 'claude-opus-5-5', summary: SUMMARY });

    expect(await h.service.tick(MON_0900 + 60_000)).toBe('already-done');
    expect(h.summarize).toHaveBeenCalledTimes(1);
    expect(h.posts).toHaveLength(1);
    expect(h.rows).toHaveLength(1);
  });

  it('after a restart, the marker in the admin channel and the sheet row prevent a second post and a second API call', async () => {
    const first = harness();
    await first.service.tick(MON_0900);
    const restarted = harness({ history: [...first.posts], rows: [...first.rows] });
    expect(await restarted.service.tick(MON_0900 + 3 * 60_000)).toBe('already-done');
    expect(restarted.summarize).not.toHaveBeenCalled();
    expect(restarted.posts).toEqual([]);
    expect(restarted.sheet.appendRow).not.toHaveBeenCalled();
  });

  it('a manual digest earlier the same week does not count as the scheduled one', async () => {
    const h = harness({ history: ['🤖 社群週報 2026-10-05～10-12（手動，最近 7 天）\n…'] });
    expect(await h.service.tick(MON_0900)).toBe('posted');
    expect(h.summarize).toHaveBeenCalledTimes(1);
  });

  it('Discord not ready → waits (no API call) and retries on the next tick inside the window', async () => {
    const h = harness();
    h.port.ready = false;
    expect(await h.service.tick(MON_0900)).toBe('discord-not-ready');
    expect(h.summarize).not.toHaveBeenCalled();
    h.port.ready = true;
    expect(await h.service.tick(MON_0900 + 60_000)).toBe('posted');
  });

  it('a failed destination is retried from the cached summary (no second API call)', async () => {
    const h = harness();
    h.sheet.failNext = true;
    expect(await h.service.tick(MON_0900)).toBe('partial');
    expect(h.rows).toHaveLength(0);
    expect(await h.service.tick(MON_0900 + 60_000)).toBe('posted');
    expect(h.rows).toHaveLength(1);
    expect(h.posts).toHaveLength(1);
    expect(h.summarize).toHaveBeenCalledTimes(1);
  });

  it('transient API error: one more attempt 10 minutes later, then a failure notice (not the transcript)', async () => {
    const rate: SummaryResult = { outcome: 'rate-limited', text: null, model: null, inputTokens: 0, outputTokens: 0, status: 429, retryable: true };
    const h = harness({ results: [rate, rate] });
    expect(await h.service.tick(MON_0900)).toBe('retry');
    expect(h.posts).toEqual([]);
    expect(h.service.getStatus().lastRun?.outcome).toBe('rate-limited');
    expect(await h.service.tick(MON_0900 + 60_000)).toBe('waiting');
    expect(await h.service.tick(MON_0900 + 9 * 60_000)).toBe('waiting');
    expect(h.summarize).toHaveBeenCalledTimes(1);
    expect(await h.service.tick(MON_0900 + 10 * 60_000)).toBe('posted');
    expect(h.summarize).toHaveBeenCalledTimes(2);
    expect(h.posts[0]).toBe(`${MARKER}\n這週沒有產生摘要：Anthropic API 暫時限流。可以用 /社群週報 手動再試一次。`);
    expect(h.rows[0].summary).toBe('（沒有產生摘要：Anthropic API 暫時限流）');
    expect(await h.service.tick(MON_0900 + 11 * 60_000)).toBe('already-done');
  });

  it('a slow first attempt that returns after 09:10 still gets its retry (catch-up until 12:00)', async () => {
    const overloaded: SummaryResult = { outcome: 'api-error', text: null, model: null, inputTokens: 0, outputTokens: 0, status: 529, retryable: true };
    const h = harness({ results: [overloaded] });
    h.now.t = MON_0900 + 15 * 60_000; // the call timed out at 09:15
    expect(await h.service.tick(MON_0900)).toBe('retry');
    expect(await h.service.tick(MON_0900 + 20 * 60_000)).toBe('waiting');
    expect(await h.service.tick(MON_0900 + 26 * 60_000)).toBe('posted');
    expect(h.posts.join('\n')).toContain(SUMMARY);
  });

  it('missed 09:00 entirely (deploy / Discord down): the first tick before 12:00 catches up', async () => {
    const h = harness();
    expect(await h.service.tick(MON_0900 + 90 * 60_000)).toBe('posted'); // 10:30
    expect(h.posts[0].split('\n')[0]).toBe(MARKER);
    expect(await h.service.tick(MON_0900 + 3 * 3600_000)).toBe('outside-window'); // 12:00
  });

  it('a partly sent post resumes from the next chunk — never re-sends what is already in the channel', async () => {
    const long = Array.from({ length: 300 }, (_, i) => `- 第 ${i} 點：${'內容'.repeat(10)}`).join('\n');
    const h = harness({ results: [{ outcome: 'ok', text: long, model: 'claude-opus-5-5', inputTokens: 1, outputTokens: 1, retryable: false }] });
    h.port.failSend = (_c, n) => n === 3; // chunk 3 fails once
    expect(await h.service.tick(MON_0900)).toBe('partial');
    expect(h.posts).toHaveLength(2);
    expect(await h.service.tick(MON_0900 + 60_000)).toBe('posted');
    const total = h.posts.length;
    expect(total).toBeGreaterThan(3);
    expect(new Set(h.posts).size).toBe(total); // no duplicates
    expect(h.posts.filter((p) => p.startsWith(MARKER))).toHaveLength(1);
    expect(h.posts.join('\n')).toContain('第 299 點');
    expect(h.summarize).toHaveBeenCalledTimes(1);
  });

  it('a chunk that always fails (e.g. AutoMod) is retried alone — the channel is not flooded', async () => {
    const long = Array.from({ length: 300 }, (_, i) => `- 第 ${i} 點：${'內容'.repeat(10)}`).join('\n');
    const h = harness({ results: [{ outcome: 'ok', text: long, model: 'claude-opus-5-5', inputTokens: 1, outputTokens: 1, retryable: false }] });
    h.port.failSend = (c) => c.includes('第 120 點'); // in the second chunk
    for (let i = 0; i < 10; i += 1) await h.service.tick(MON_0900 + i * 60_000);
    expect(h.posts).toHaveLength(1); // the marker chunk only, never re-sent
    expect(h.posts[0].startsWith(MARKER)).toBe(true);
    expect(h.port.sendAttempts).toBe(1 + 10); // one try per tick at the failing chunk
  });

  it('every channel failed to read and nothing was kept → retried later, not reported as a quiet week', async () => {
    const h = harness({ messages: [], collected: { failedChannels: 3 } });
    expect(await h.service.tick(MON_0900)).toBe('retry');
    expect(h.posts).toEqual([]);
    expect(await h.service.tick(MON_0900 + 10 * 60_000)).toBe('posted');
    expect(h.posts[0]).toContain('另有 3 個頻道讀取失敗');
    expect(h.summarize).not.toHaveBeenCalled();
  });

  it('failed channels and "no public channel" are passed to the model and shown on the post', async () => {
    const h = harness({ collected: { failedChannels: 1, publicChannelsFound: 0 } });
    expect(await h.service.tick(MON_0900)).toBe('posted');
    const input = h.summarize.mock.calls[0][0] as DigestPromptInput;
    expect(input.failedChannels).toBe(1);
    expect(h.posts[0]).toContain('另有 1 個頻道讀取失敗');
    expect(h.posts[0]).toContain(NO_PUBLIC_CHANNELS_TEXT);
    expect(h.logs.join('\n')).toContain('no channel visible to @everyone');
  });

  it('refusal: no digest and no retry', async () => {
    const h = harness({
      results: [{ outcome: 'refused', text: null, model: 'claude-opus-5-5', inputTokens: 5000, outputTokens: 0, refusalCategory: null, retryable: false }],
    });
    expect(await h.service.tick(MON_0900)).toBe('posted');
    expect(h.summarize).toHaveBeenCalledTimes(1);
    expect(h.posts[0]).toContain('模型拒絕處理');
    expect(h.posts.join('\n')).not.toContain(SECRET_CHAT);
    expect(h.service.getStatus().lastRun?.outcome).toBe('refused');
  });

  it('an empty week posts a short note without calling the API', async () => {
    const h = harness({ messages: [] });
    expect(await h.service.tick(MON_0900)).toBe('posted');
    expect(h.summarize).not.toHaveBeenCalled();
    expect(h.posts[0]).toContain('沒有讀到可以彙整的聊天訊息');
    expect(h.service.getStatus().lastRun).toMatchObject({ outcome: 'no-messages', messages: 0 });
  });

  it('public admin channel: Discord is refused, the sheet still gets the row', async () => {
    const h = harness();
    h.port.admin = 'public';
    expect(await h.service.tick(MON_0900)).toBe('posted');
    expect(h.posts).toEqual([]);
    expect(h.rows).toHaveLength(1);
    expect(h.collect.mock.calls[0][2]).toEqual([]);
    expect(h.logs.join('\n')).toContain('admin channel unavailable (public)');
    expect(h.service.getStatus()).toMatchObject({ adminChannelResolved: false, lastRun: { posted: false, sheetWritten: true } });
  });

  it('no destination at all: no API call', async () => {
    const h = harness({ sheet: false });
    h.port.admin = 'public';
    expect(await h.service.tick(MON_0900)).toBe('no-destination');
    expect(h.summarize).not.toHaveBeenCalled();
    expect(h.service.getStatus().lastRun?.outcome).toBe('no-destination');
  });

  it('disabled → nothing', async () => {
    const h = harness({ cfg: { enabled: false } });
    expect(await h.service.tick(MON_0900)).toBe('disabled');
    expect(h.collect).not.toHaveBeenCalled();
  });

  it('logs carry counts only — never chat text or the summary', async () => {
    const h = harness();
    await h.service.tick(MON_0900);
    const log = h.logs.join('\n');
    expect(log).toContain('kept=1');
    expect(log).not.toContain(SECRET_CHAT);
    expect(log).not.toContain('排行榜的門檻');
  });
});

describe('manual run (/社群週報)', () => {
  it('summarizes the last 7 days, delivers, and reports counts only', async () => {
    const h = harness({ messages: [chat(SECRET_CHAT, Date.parse('2026-10-13T05:00:00Z'))] });
    h.now.t = Date.parse('2026-10-13T06:05:00Z');
    const r = await h.service.runManual();
    expect(r).toMatchObject({ manual: true, outcome: 'ok', included: 1, noPublicChannels: false, discord: { status: 'posted' }, sheet: { status: 'written' } });
    expect(h.posts[0].split('\n')[0]).toBe('🤖 社群週報 2026-10-06～10-13（手動，最近 7 天）');
    expect(h.rows[0].period).toContain('（手動）');
    const reply = formatRunReport(r);
    expect(reply).toContain('收錄 1 則訊息');
    expect(reply).toContain('約 US$0.07');
    expect(reply).toContain('管理者頻道：已貼出 1 則');
    expect(reply).not.toContain(SECRET_CHAT);
    expect(reply).not.toContain('排行榜的門檻');
    // A second click within 5 minutes is refused (each run is a paid call).
    expect((await h.service.runManual()).outcome).toBe('cooldown');
    expect(h.summarize).toHaveBeenCalledTimes(1);
  });

  it('a failed summary is reported, nothing is posted', async () => {
    const h = harness({ results: [{ outcome: 'auth-error', text: null, model: null, inputTokens: 0, outputTokens: 0, status: 401, retryable: false }] });
    const r = await h.service.runManual();
    expect(r.outcome).toBe('auth-error');
    expect(h.posts).toEqual([]);
    expect(h.rows).toEqual([]);
    expect(formatRunReport(r)).toContain('Anthropic API 金鑰無效');
  });

  it('disabled / no destination', async () => {
    expect((await harness({ cfg: { enabled: false } }).service.runManual()).outcome).toBe('disabled');
    const h = harness({ sheet: false });
    h.port.admin = 'public';
    const r = await h.service.runManual();
    expect(r.outcome).toBe('no-destination');
    expect(h.summarize).not.toHaveBeenCalled();
    expect(formatRunReport(r)).toContain('沒有設定 GOOGLE_SERVICE_ACCOUNT_JSON');
  });

  it('the status reply says when no public channel was found', async () => {
    const h = harness({ collected: { publicChannelsFound: 0 } });
    const r = await h.service.runManual();
    expect(r.noPublicChannels).toBe(true);
    expect(formatRunReport(r)).toContain(NO_PUBLIC_CHANNELS_TEXT);
  });
});

describe('/api/bots/status → communityDigest', () => {
  it('booleans and the last run’s counts only', async () => {
    const before = buildBotStatus().communityDigest;
    expect(Object.keys(before).sort()).toEqual(['adminChannelResolved', 'anthropicConfigured', 'enabled', 'lastRun', 'sheetConfigured']);
    expect(before.lastRun).toBeNull();

    const h = harness();
    initializeCommunityDigest({
      discord: h.port,
      summarizer: { summarize: h.summarize } as Summarizer,
      sheetFactory: () => ({ writer: h.sheet, reason: 'ok' }),
      config: () =>
        readDigestConfig({
          ANTHROPIC_API_KEY: 'test-key',
          GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: 'sa@x.iam.gserviceaccount.com', private_key: 'k' }),
        }),
      now: () => MON_0900,
      logger: silent,
    }).tick(MON_0900);
    await vi.waitFor(() => expect(buildBotStatus().communityDigest.lastRun).not.toBeNull());

    const status = buildBotStatus().communityDigest;
    expect(status).toMatchObject({ enabled: true, anthropicConfigured: true, adminChannelResolved: true, sheetConfigured: true });
    for (const k of ['enabled', 'anthropicConfigured', 'adminChannelResolved', 'sheetConfigured'] as const) expect(typeof status[k]).toBe('boolean');
    expect(Object.keys(status.lastRun ?? {}).sort()).toEqual(['at', 'channels', 'manual', 'messages', 'omitted', 'outcome', 'posted', 'sheetWritten', 'week']);
    expect(status.lastRun).toMatchObject({ week: '2026-10-05', messages: 1, channels: 1, omitted: 0, posted: true, sheetWritten: true, outcome: 'ok', manual: false });
    const json = JSON.stringify(status);
    expect(json).not.toContain(SECRET_CHAT);
    expect(json).not.toContain('排行榜');
    expect(json).not.toContain('阿瓦隆同步');
    expect(json).not.toContain('admin-channel');
  });

  it('sheetConfigured is false when the service-account JSON does not parse', () => {
    const h = harness();
    const svc = new CommunityDigestService({
      discord: h.port,
      summarizer: { summarize: h.summarize } as Summarizer,
      config: () => readDigestConfig({ ANTHROPIC_API_KEY: 'k', GOOGLE_SERVICE_ACCOUNT_JSON: 'not-json-at-all' }),
      logger: silent,
    });
    expect(svc.getStatus().sheetConfigured).toBe(false);
  });

  it('adminChannelResolved is checked as soon as Discord is ready (not only every 10 minutes)', async () => {
    const h = harness();
    h.port.ready = false;
    await h.service.refreshAdminState();
    expect(h.service.getStatus().adminChannelResolved).toBe(false);
    h.port.ready = true;
    await h.service.refreshAdminState(); // first successful check is not throttled
    expect(h.service.getStatus().adminChannelResolved).toBe(true);
    h.port.admin = 'public';
    await h.service.refreshAdminState(); // afterwards throttled
    expect(h.service.getStatus().adminChannelResolved).toBe(true);
  });
});

// ─── The real Discord adapter (discordPort.ts) ─────────────────────────────

describe('createDiscordDigestPort', () => {
  const SELF = 'bot-self';
  function fakeClient(opts: { history?: Array<{ author: string; content: string }>; botHistory?: boolean } = {}) {
    const sent: unknown[] = [];
    const fetchCalls: unknown[] = [];
    const everyone = { id: 'everyone', managed: false, permissions: { has: () => false } };
    const g = {
      id: 'g1',
      roles: { everyone, cache: new Map([[everyone.id, everyone]]) },
      members: { me: { id: 'me' } },
      channels: { cache: new Map<string, unknown>() },
    };
    const admin = {
      id: '900000000000000001',
      name: '管理者信箱',
      type: ChannelType.GuildText,
      guild: g,
      permissionsFor: (who: unknown) => ({
        has: (p: bigint | bigint[]) => {
          if (who !== g.members.me) return false;
          const flags = Array.isArray(p) ? p : [p];
          return flags.includes(PermissionFlagsBits.ReadMessageHistory) ? opts.botHistory ?? true : true;
        },
      }),
      send: async (payload: unknown) => {
        sent.push(payload);
      },
      messages: {
        fetch: async (o: unknown) => {
          fetchCalls.push(o);
          return new Collection((opts.history ?? []).map((m, i) => [String(i), { author: { id: m.author }, content: m.content }]));
        },
      },
    };
    g.channels.cache.set(admin.id, admin);
    const client = {
      isReady: () => true,
      user: { id: SELF },
      guilds: { cache: new Map([[g.id, g]]) },
      channels: { fetch: async () => admin },
    } as unknown as Client;
    return { client, sent, fetchCalls };
  }

  it('posts with no pings; the marker check counts only the bot’s own posts', async () => {
    const { client, sent, fetchCalls } = fakeClient({
      history: [
        { author: 'someone-else', content: `${MARKER}（有人貼了同樣的開頭）` },
        { author: SELF, content: '📮 意見（LINE）：…' },
      ],
    });
    const port = createDiscordDigestPort(() => client);
    const res = await port.resolveAdmin(readDigestConfig({ ANTHROPIC_API_KEY: 'k' }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    await res.target.send('@everyone 測試');
    expect(sent).toEqual([{ content: '@everyone 測試', allowedMentions: { parse: [] } }]);
    expect(await res.target.hasRecentMarker(MARKER)).toBe(false);
    expect(fetchCalls[0]).toEqual({ limit: 50, cache: false });

    const again = fakeClient({ history: [{ author: SELF, content: `${MARKER}\n期間…` }] });
    const res2 = await createDiscordDigestPort(() => again.client).resolveAdmin(readDigestConfig({ ANTHROPIC_API_KEY: 'k' }));
    expect(res2.ok && (await res2.target.hasRecentMarker(MARKER))).toBe(true);
  });

  it('refuses an admin channel whose history the bot cannot read (the restart check would be blind)', async () => {
    const { client } = fakeClient({ botHistory: false });
    const res = await createDiscordDigestPort(() => client).resolveAdmin(readDigestConfig({ ANTHROPIC_API_KEY: 'k' }));
    expect(res).toMatchObject({ ok: false, problem: 'bot-cannot-read-history' });
  });

  it('no client yet → not ready, nothing collected', async () => {
    const port = createDiscordDigestPort(() => null);
    expect(port.isReady()).toBe(false);
    const res = await port.collect(readDigestConfig({}), { start: 0, end: 1, weekKey: 'x', manual: false }, []);
    expect(res).toEqual({ messages: [], channels: [], truncatedChannels: 0, failedChannels: 0, publicChannelsFound: null });
  });
});

// ─── bots/index.ts wiring ──────────────────────────────────────────────────

describe('bots/index.ts wiring', () => {
  it('the /意見 forwarder has the 管理者信箱 fallback (and answers "" without Discord)', async () => {
    const forwarder = buildFeedbackForwarder();
    expect(typeof forwarder.resolveFallbackChannelId).toBe('function');
    expect(await forwarder.resolveFallbackChannelId!()).toBe('');
    expect(await forwarder.send('1', { content: 'x', allowedMentions: { parse: [] } })).toBe(false);
  });

  it('startCommunityDigest creates the service (so /社群週報 can answer) and arms it only when enabled', () => {
    const saved = { ...process.env };
    try {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.COMMUNITY_DIGEST_ENABLED;
      startCommunityDigest();
      const svc = getCommunityDigestService();
      expect(svc).not.toBeNull();
      expect(svc!.isRunning()).toBe(false);
      __resetCommunityDigestForTests();
      process.env.ANTHROPIC_API_KEY = 'test-key';
      startCommunityDigest();
      expect(getCommunityDigestService()!.isRunning()).toBe(true);
    } finally {
      __resetCommunityDigestForTests();
      process.env = saved;
    }
  });
});

describe('slash command /社群週報', () => {
  it('is registered for Manage Server only, in servers only', () => {
    const cmd = buildSlashCommands()
      .map((c) => c.toJSON())
      .find((c) => c.name === COMMANDS.COMMUNITY_DIGEST);
    expect(cmd).toBeDefined();
    expect(cmd!.name).toBe('社群週報');
    expect(cmd!.default_member_permissions).toBe(PermissionFlagsBits.ManageGuild.toString());
    expect(cmd!.contexts).toEqual([0]);
    expect(cmd!.description.length).toBeLessThanOrEqual(100);
  });

  it('is not listed in /help', async () => {
    const it1 = { deferReply: vi.fn(async () => {}), editReply: vi.fn(async (_p: unknown) => {}) };
    await handleHelpCommand(it1 as never);
    const payload = it1.editReply.mock.calls[0][0] as { embeds: Array<{ toJSON: () => unknown }> };
    expect(JSON.stringify(payload.embeds.map((e) => e.toJSON()))).not.toContain('社群週報');
  });

  function interaction(admin: boolean) {
    return {
      inGuild: () => true,
      memberPermissions: { has: (p: bigint) => admin && p === PermissionFlagsBits.ManageGuild },
      reply: vi.fn(async (_p: unknown) => {}),
      deferReply: vi.fn(async (_p: unknown) => {}),
      editReply: vi.fn(async (_p: unknown) => {}),
    };
  }

  it('non-admins get a refusal; admins get an ephemeral status reply without the summary', async () => {
    const h = harness();
    initializeCommunityDigest({
      discord: h.port,
      summarizer: { summarize: h.summarize } as Summarizer,
      sheetFactory: () => ({ writer: h.sheet, reason: 'ok' }),
      config: () => readDigestConfig({ ANTHROPIC_API_KEY: 'test-key' }),
      now: () => Date.parse('2026-10-09T00:00:00Z'),
      logger: silent,
    });
    const member = interaction(false);
    await handleCommunityDigestCommand(member as never);
    expect(member.reply).toHaveBeenCalledWith({ content: COMMUNITY_DIGEST_NOT_ALLOWED_TEXT, flags: MessageFlags.Ephemeral });
    expect(h.summarize).not.toHaveBeenCalled();

    const owner = interaction(true);
    await handleCommunityDigestCommand(owner as never);
    expect(owner.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    const { content, allowedMentions } = owner.editReply.mock.calls[0][0] as { content: string; allowedMentions: unknown };
    expect(allowedMentions).toEqual({ parse: [] });
    expect(content).toContain('社群週報（手動，最近 7 天');
    expect(content).toContain('管理者頻道：已貼出');
    expect(content).not.toContain(SECRET_CHAT);
    expect(content).not.toContain('排行榜的門檻');
  });
});
