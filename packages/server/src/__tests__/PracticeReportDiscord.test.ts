/**
 * 「這步怪怪的」 → also a short post in the Discord admin channel 「大劍管理員」
 * (Edward 2026-10-14：練習回報「要」也貼到管理員頻道).
 *
 *   Format  — room id, round / proposal, the bot's seat / role / decision, reason and the player's
 *             note (clipped, mentions neutralised); never a player name or id.
 *   Send    — the /意見 sender and channel (FEEDBACK_DISCORD_CHANNEL_ID, else 大劍管理員),
 *             allowedMentions none; PRACTICE_REPORT_DISCORD=false turns it off.
 *   Limits  — its own hourly cap; a failed send gives its slot back; failures are counted, never
 *             thrown, and the logs never carry the text.
 *   Wiring  — GameServer posts the copy only after the sheet write worked.
 *
 * Fakes only, no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server as SocketIOServer, Socket } from 'socket.io';

import {
  DEFAULT_FEEDBACK_DISCORD_CHANNEL_ID,
  __resetFeedbackForTests,
  initializeFeedback,
  type FeedbackDiscordForwarder,
  type FeedbackForwardPayload,
} from '../bots/feedback';
import {
  PRACTICE_REPORT_DISCORD_MAX_PER_HOUR,
  PRACTICE_REPORT_DISCORD_NOTE_MAX,
  PracticeReportDiscord,
  __resetPracticeReportDiscordForTests,
  formatPracticeReportForward,
  getPracticeReportDiscord,
  isPracticeReportDiscordEnabled,
  neutralizeMentions,
  type PracticeReportCopy,
  type PracticeReportCopyOutcome,
} from '../practice/PracticeReportDiscord';
import type { PracticeFlagRow, PracticeFlagSink } from '../practice/PracticeReportWriter';
import { GameServer } from '../socket/GameServer';
import type { PracticeFlagResult } from '../practice/types';

const ROW: PracticeFlagRow = {
  at: Date.UTC(2026, 9, 14, 4, 5, 6),
  roomId: 'PRACTICE-ABCDEF1234',
  round: 2,
  attempt: 3,
  botSeat: 10,
  botRole: 'morgana',
  kind: 'team_vote',
  decision: '贊成',
  reason: '贊成：自己在隊上。 規則：莫甘娜在隊上一律贊成（紅方規則）',
  note: '這票怪怪的',
};

interface Sent {
  channelId: string;
  payload: FeedbackForwardPayload;
}

function fakeSender(result: boolean | Error = true): FeedbackDiscordForwarder & { sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    send: vi.fn(async (channelId: string, payload: FeedbackForwardPayload) => {
      if (result instanceof Error) throw result;
      if (result) sent.push({ channelId, payload });
      return result;
    }),
  };
}

function quietLogger(): { warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; lines: () => string } {
  const warn = vi.fn();
  const error = vi.fn();
  return { warn, error, lines: () => [...warn.mock.calls, ...error.mock.calls].flat().join('\n') };
}

const env = { ...process.env };

beforeEach(() => {
  __resetFeedbackForTests();
  __resetPracticeReportDiscordForTests();
  delete process.env.PRACTICE_REPORT_DISCORD;
  delete process.env.FEEDBACK_DISCORD_CHANNEL_ID;
});

afterEach(() => {
  process.env = { ...env };
  vi.restoreAllMocks();
});

describe('the post', () => {
  it('names the room, round, bot and decision, the reason and the note — no player', () => {
    expect(formatPracticeReportForward(ROW)).toBe([
      '🧪 練習回報「這步怪怪的」｜PRACTICE-ABCDEF1234｜第 2 回合・第 3 次派隊',
      '機器人 0家 莫甘娜｜投票：贊成',
      '理由：贊成：自己在隊上。 規則：莫甘娜在隊上一律贊成（紅方規則）',
      '玩家備註：這票怪怪的',
    ].join('\n'));
    expect(formatPracticeReportForward({ ...ROW, note: '', roomId: '' })).toBe([
      '🧪 練習回報「這步怪怪的」｜第 2 回合・第 3 次派隊',
      '機器人 0家 莫甘娜｜投票：贊成',
      '理由：贊成：自己在隊上。 規則：莫甘娜在隊上一律贊成（紅方規則）',
      '玩家備註：（沒寫）',
    ].join('\n'));
  });

  it('clips the note and neutralises mentions (allowedMentions none is the real guard)', () => {
    const long = '怪'.repeat(PRACTICE_REPORT_DISCORD_NOTE_MAX + 50);
    const post = formatPracticeReportForward({ ...ROW, note: long });
    const noteLine = post.split('\n').find((l) => l.startsWith('玩家備註：'))!;
    expect(Array.from(noteLine.slice('玩家備註：'.length))).toHaveLength(PRACTICE_REPORT_DISCORD_NOTE_MAX);
    expect(noteLine.endsWith('…')).toBe(true);

    const pinged = formatPracticeReportForward({ ...ROW, note: '@everyone @here <@123> <@!456> <@&789> 看這步' });
    expect(pinged).not.toMatch(/@everyone|@here|<@!?\d+>|<@&\d+>/);
    expect(pinged).toContain('玩家備註：@​everyone @​here @(某人) @(某人) @(身分組) 看這步');
    expect(neutralizeMentions('a@b.c 正常')).toBe('a@b.c 正常');
    // Whatever the player typed stays one post: the note cannot add lines of its own beyond a blank one.
    expect(formatPracticeReportForward({ ...ROW, note: '一\n\n\n\n二' }).split('\n')).toHaveLength(6);
  });
});

describe('PracticeReportDiscord', () => {
  it('posts to the channel with no mentions allowed and counts it', async () => {
    const sender = fakeSender();
    const copy = new PracticeReportDiscord({ sender: () => sender, channelId: () => 'C-admin', enabled: () => true, logger: quietLogger() });
    await expect(copy.forward(ROW)).resolves.toBe('sent');
    expect(sender.sent).toEqual([{ channelId: 'C-admin', payload: { content: formatPracticeReportForward(ROW), allowedMentions: { parse: [] } } }]);
    expect(copy.snapshot()).toEqual({ enabled: true, sent: 1, skipped: 0, failed: 0, throttled: 0 });
  });

  it('defaults: the /意見 sender and channel (大劍管理員, FEEDBACK_DISCORD_CHANNEL_ID, off)', async () => {
    const sender = fakeSender();
    const copy = new PracticeReportDiscord({ logger: quietLogger() });
    // Before bots/index.ts attaches the Discord sender: saved, not posted.
    await expect(copy.forward(ROW)).resolves.toBe('skipped');
    initializeFeedback({ discord: sender });
    await expect(copy.forward(ROW)).resolves.toBe('sent');
    expect(sender.sent[0].channelId).toBe(DEFAULT_FEEDBACK_DISCORD_CHANNEL_ID);
    process.env.FEEDBACK_DISCORD_CHANNEL_ID = 'C-other';
    await copy.forward(ROW);
    expect(sender.sent[1].channelId).toBe('C-other');
    process.env.FEEDBACK_DISCORD_CHANNEL_ID = 'off';
    await expect(copy.forward(ROW)).resolves.toBe('skipped');
    expect(sender.sent).toHaveLength(2);
    expect(copy.snapshot()).toEqual({ enabled: true, sent: 2, skipped: 2, failed: 0, throttled: 0 });
  });

  it('PRACTICE_REPORT_DISCORD=false (or 0 / off / no) turns the copy off', async () => {
    expect(isPracticeReportDiscordEnabled({})).toBe(true);
    for (const v of ['false', '0', 'off', 'no', ' OFF ']) expect(isPracticeReportDiscordEnabled({ PRACTICE_REPORT_DISCORD: v })).toBe(false);
    expect(isPracticeReportDiscordEnabled({ PRACTICE_REPORT_DISCORD: 'true' })).toBe(true);

    const sender = fakeSender();
    const copy = new PracticeReportDiscord({ sender: () => sender, channelId: () => 'C-admin', logger: quietLogger() });
    process.env.PRACTICE_REPORT_DISCORD = 'false';
    await expect(copy.forward(ROW)).resolves.toBe('disabled');
    expect(sender.send).not.toHaveBeenCalled();
    expect(copy.snapshot()).toEqual({ enabled: false, sent: 0, skipped: 0, failed: 0, throttled: 0 });
    delete process.env.PRACTICE_REPORT_DISCORD; // read on every report
    await expect(copy.forward(ROW)).resolves.toBe('sent');
  });

  it('hourly cap: throttled after the cap, a failed send gives its slot back, the next hour posts again', async () => {
    let now = 1_000_000;
    let ok = true;
    const sent: string[] = [];
    const sender: FeedbackDiscordForwarder = { send: async (_c, p) => (ok ? (sent.push(p.content), true) : false) };
    const copy = new PracticeReportDiscord({ sender: () => sender, channelId: () => 'C', enabled: () => true, maxPerHour: 2, now: () => now, logger: quietLogger() });
    ok = false;
    await expect(copy.forward(ROW)).resolves.toBe('failed'); // channel unavailable: no slot used
    ok = true;
    await expect(copy.forward(ROW)).resolves.toBe('sent');
    await expect(copy.forward(ROW)).resolves.toBe('sent');
    await expect(copy.forward(ROW)).resolves.toBe('throttled');
    now += 60 * 60 * 1000;
    await expect(copy.forward(ROW)).resolves.toBe('sent');
    expect(sent).toHaveLength(3);
    expect(copy.snapshot()).toEqual({ enabled: true, sent: 3, skipped: 0, failed: 1, throttled: 1 });
    expect(PRACTICE_REPORT_DISCORD_MAX_PER_HOUR).toBe(30);
  });

  it('a throwing sender is counted, never rethrown, and the logs never carry the text', async () => {
    // discord.js errors carry the request body (the post) as an own property.
    const err = Object.assign(new Error('Missing Access'), { code: 50001, status: 403, requestBody: { json: { content: ROW.note } } });
    const log = quietLogger();
    const copy = new PracticeReportDiscord({ sender: () => fakeSender(err), channelId: () => 'C', enabled: () => true, logger: log });
    await expect(copy.forward({ ...ROW, note: 'SECRET-NOTE 這票怪怪的' })).resolves.toBe('failed');
    const brokenSettings = new PracticeReportDiscord({
      sender: () => fakeSender(), channelId: () => { throw new Error('boom'); }, enabled: () => true, logger: log,
    });
    await expect(brokenSettings.forward(ROW)).resolves.toBe('failed');
    expect(log.error).toHaveBeenCalledTimes(2);
    expect(log.lines()).toContain('code=50001');
    expect(log.lines()).not.toMatch(/SECRET-NOTE|這票怪怪的|PRACTICE-ABCDEF1234/);
  });

  it('one process-wide copier', () => {
    expect(getPracticeReportDiscord()).toBe(getPracticeReportDiscord());
  });
});

// ─── GameServer wiring ────────────────────────────────────────────────────

interface Internals {
  practice: {
    create(roomId: string, ownerId: string, options: { seat: null; role: null }): unknown;
    record(roomId: string, entry: Record<string, unknown>): { id: number } | null;
    markEnded(roomId: string): boolean;
  };
  handlePracticeFlag(socket: Socket, payload: unknown, ack?: (res: PracticeFlagResult) => void): Promise<void>;
}

describe('GameServer posts the copy only after the sheet write worked', () => {
  const ENTRY = {
    round: 1, attempt: 2, kind: 'team_vote', botSeat: 3, botRole: 'loyal', botTeam: 'good',
    action: '反對', detail: { vote: false }, reason: '隊上有可疑的人', rule: 'R1–R2 只投正常票', source: 'agent',
  };

  function server(sink: PracticeFlagSink, copies: PracticeFlagRow[]): Internals {
    const copy: PracticeReportCopy = {
      forward: async (row): Promise<PracticeReportCopyOutcome> => {
        copies.push(row);
        return 'sent';
      },
    };
    const gs = new GameServer({} as SocketIOServer, { practiceReportSink: sink, practiceReportDiscord: copy });
    const internals = gs as unknown as Internals;
    internals.practice.create('PRACTICE-TEST000001', 'owner-uid', { seat: null, role: null });
    internals.practice.record('PRACTICE-TEST000001', ENTRY);
    internals.practice.markEnded('PRACTICE-TEST000001');
    return internals;
  }

  const socket = { data: { user: { uid: 'owner-uid' } } } as unknown as Socket;

  it('saved → one copy with the same row', async () => {
    const rows: PracticeFlagRow[] = [];
    const copies: PracticeFlagRow[] = [];
    const gs = server({ appendFlag: async (row) => void rows.push(row) }, copies);
    const acks: PracticeFlagResult[] = [];
    await gs.handlePracticeFlag(socket, { roomId: 'PRACTICE-TEST000001', entryId: 1, note: '這票怪怪的' }, (r) => acks.push(r));
    expect(acks).toEqual([{ ok: true, flagsLeft: 29 }]);
    expect(rows).toHaveLength(1);
    expect(copies).toEqual(rows);
    expect(copies[0]).toMatchObject({ roomId: 'PRACTICE-TEST000001', round: 1, attempt: 2, botSeat: 3, kind: 'team_vote', decision: '反對', note: '這票怪怪的' });
    expect(copies[0].reason).toBe('隊上有可疑的人 規則：R1–R2 只投正常票');
  });

  it('sheet write failed → no copy (the player retries; it must not post twice)', async () => {
    const copies: PracticeFlagRow[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const gs = server({ appendFlag: async () => { throw new Error('down'); } }, copies);
    const acks: PracticeFlagResult[] = [];
    await gs.handlePracticeFlag(socket, { roomId: 'PRACTICE-TEST000001', entryId: 1, note: 'n' }, (r) => acks.push(r));
    expect(acks).toEqual([{ ok: false, error: '儲存失敗，請稍後再試' }]);
    expect(copies).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('refused flags (not the owner) → no sheet row, no copy', async () => {
    const rows: PracticeFlagRow[] = [];
    const copies: PracticeFlagRow[] = [];
    const gs = server({ appendFlag: async (row) => void rows.push(row) }, copies);
    const intruder = { data: { user: { uid: 'someone-else' } } } as unknown as Socket;
    const acks: PracticeFlagResult[] = [];
    await gs.handlePracticeFlag(intruder, { roomId: 'PRACTICE-TEST000001', entryId: 1 }, (r) => acks.push(r));
    expect(acks[0].ok).toBe(false);
    expect([rows, copies]).toEqual([[], []]);
  });

  it('an injected sink alone means no Discord copy (tests); the env-built default uses the copier', () => {
    const plain = new GameServer({} as SocketIOServer, { practiceReportSink: { appendFlag: async () => undefined } });
    expect((plain as unknown as { practiceDiscord: unknown }).practiceDiscord).toBeNull();
    const built = new GameServer({} as SocketIOServer);
    expect((built as unknown as { practiceDiscord: unknown }).practiceDiscord).toBe(getPracticeReportDiscord());
  });
});
