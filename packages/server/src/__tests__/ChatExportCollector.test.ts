/**
 * Daily chat-log export — Discord collection with mock discord.js objects:
 *
 *   selectSourceChannels — public text / announcement channels and public
 *     forums the bot can read; private and unreadable ones skipped; the
 *     LINE↔Discord sync channel always included; exclude list + the admin
 *     channel 大劍管理員 (always, even if public or /意見 goes elsewhere) +
 *     the /意見 channel left out; CHAT_EXPORT_SOURCE_CHANNEL_IDS (or the old
 *     COMMUNITY_DIGEST_ name) overrides the default list; a server with no
 *     @everyone-visible channel is reported (publicChannelsFound 0)
 *   fetchWindow          — pages backwards with `before`, keeps [start, end),
 *     stops at the window start, reports a page-cap truncation
 *   forums               — active + archived threads (archived listed newest
 *     first, stopping once archived before the day; page cap reported),
 *     threads outside the day skipped without reading, starter and replies
 *     of the day kept, the records forum's starter (game record) skipped but
 *     replies — also to the bot's format-check reply — kept, 「論壇／標題」
 *     as the channel, excluded threads, the per-day thread cap, failures
 *     counted
 */
import { describe, expect, it, vi } from 'vitest';
import { ChannelType, Collection, PermissionFlagsBits, SnowflakeUtil } from 'discord.js';
import type { Client, Message } from 'discord.js';

import {
  collectDiscordMessages,
  fetchWindow,
  listForumThreads,
  selectSourceChannels,
  threadMayCoverWindow,
  toRawMessage,
  type ForumLike,
  type MessagePager,
  type ThreadLike,
} from '../bots/chatExport/collector';
import { RECORDS_FORUM_CHANNEL_ID, readChatExportConfig } from '../bots/chatExport/config';
import { buildExportRows } from '../bots/chatExport/rows';
import { dayWindow } from '../bots/chatExport/window';
import { DEFAULT_FEEDBACK_DISCORD_CHANNEL_ID } from '../bots/feedback/config';

const EVERYONE = { id: 'everyone' };
const ME = { id: 'me' };
const MIRROR = '1132901301802504242';

function guild(id = 'g1') {
  return { id, roles: { everyone: EVERYONE }, members: { me: ME }, channels: { cache: new Map<string, unknown>() } };
}

function channel(
  g: ReturnType<typeof guild>,
  id: string,
  opts: { type?: ChannelType; publicView?: boolean; botRead?: boolean } = {},
) {
  const ch = {
    id,
    name: `ch-${id.slice(-2)}`,
    type: opts.type ?? ChannelType.GuildText,
    guild: g,
    permissionsFor: (who: unknown) => ({
      has: (p: bigint | bigint[]) => {
        const flags = Array.isArray(p) ? p : [p];
        if (who === EVERYONE) return (opts.publicView ?? true) && flags.every((f) => f === PermissionFlagsBits.ViewChannel);
        if (who === ME) return opts.botRead ?? true;
        return false;
      },
    }),
    messages: { fetch: vi.fn() },
  };
  g.channels.cache.set(id, ch);
  return ch;
}

function client(guilds: Array<ReturnType<typeof guild>>): Client {
  const all = new Map<string, unknown>();
  for (const g of guilds) for (const [id, ch] of g.channels.cache) all.set(id, ch);
  return {
    user: { id: 'bot-self' },
    guilds: { cache: new Map(guilds.map((g) => [g.id, g])) },
    channels: {
      fetch: async (id: string) => {
        if (!all.has(id)) throw new Error('Unknown Channel');
        return all.get(id);
      },
    },
  } as unknown as Client;
}

describe('selectSourceChannels', () => {
  it('public readable text/announcement channels and forums + the sync channel; skips private, unreadable, excluded', async () => {
    const g = guild();
    channel(g, '100000000000000001'); // public text
    channel(g, '100000000000000002', { type: ChannelType.GuildAnnouncement });
    channel(g, '100000000000000003', { publicView: false }); // private
    channel(g, '100000000000000004', { type: ChannelType.GuildForum }); // public forum
    channel(g, '100000000000000008', { type: ChannelType.GuildForum, publicView: false }); // private forum
    channel(g, '100000000000000009', { type: ChannelType.GuildForum, botRead: false });
    channel(g, '100000000000000010', { type: ChannelType.GuildVoice });
    channel(g, '100000000000000005', { botRead: false });
    channel(g, '100000000000000006'); // excluded by env
    channel(g, '100000000000000007'); // excluded by the caller
    channel(g, DEFAULT_FEEDBACK_DISCORD_CHANNEL_ID); // the /意見 admin channel: never exported, even if public
    channel(g, MIRROR, { publicView: false }); // sync channel: always read, even when not public
    const cfg = readChatExportConfig({ LOBBY_MIRROR_DISCORD_CHANNEL_ID: MIRROR, CHAT_EXPORT_EXCLUDE_CHANNEL_IDS: '100000000000000006' });
    expect(cfg.excludeChannelIds).toEqual(['100000000000000006', DEFAULT_FEEDBACK_DISCORD_CHANNEL_ID]);
    const picked = await selectSourceChannels(client([g]), cfg, ['100000000000000007']);
    expect(picked.channels.map((c) => c.id).sort()).toEqual(['100000000000000001', '100000000000000002', MIRROR].sort());
    expect(picked.forums.map((f) => f.id)).toEqual(['100000000000000004']);
    expect(picked.publicChannelsFound).toBe(3);

    // A forum can be excluded like a channel.
    const cfgF = readChatExportConfig({ LOBBY_MIRROR_DISCORD_CHANNEL_ID: MIRROR, CHAT_EXPORT_EXCLUDE_CHANNEL_IDS: '100000000000000004' });
    expect((await selectSourceChannels(client([g]), cfgF)).forums).toEqual([]);

    // A FEEDBACK_DISCORD_CHANNEL_ID override is left out too — and 大劍管理員 still is; the old exclude name still works.
    const cfg2 = readChatExportConfig({
      LOBBY_MIRROR_DISCORD_CHANNEL_ID: MIRROR,
      FEEDBACK_DISCORD_CHANNEL_ID: '100000000000000002',
      COMMUNITY_DIGEST_EXCLUDE_CHANNEL_IDS: '100000000000000006',
    });
    const picked2 = await selectSourceChannels(client([g]), cfg2, ['100000000000000007']);
    expect(picked2.channels.map((c) => c.id).sort()).toEqual(['100000000000000001', MIRROR].sort());

    // /意見 forwarding turned off: 大劍管理員 is still never exported.
    const cfg3 = readChatExportConfig({ LOBBY_MIRROR_DISCORD_CHANNEL_ID: MIRROR, FEEDBACK_DISCORD_CHANNEL_ID: 'off' });
    expect(cfg3.excludeChannelIds).toEqual([DEFAULT_FEEDBACK_DISCORD_CHANNEL_ID]);
    const picked3 = await selectSourceChannels(client([g]), cfg3);
    expect(picked3.channels.map((c) => c.id)).not.toContain(DEFAULT_FEEDBACK_DISCORD_CHANNEL_ID);

    // The sync channel itself can be excluded (then it is not read).
    const cfg4 = readChatExportConfig({ LOBBY_MIRROR_DISCORD_CHANNEL_ID: MIRROR, CHAT_EXPORT_EXCLUDE_CHANNEL_IDS: MIRROR });
    expect((await selectSourceChannels(client([g]), cfg4)).channels.map((c) => c.id)).not.toContain(MIRROR);
  });

  it('no channel visible to @everyone → only the sync channel, reported as publicChannelsFound 0', async () => {
    const g = guild();
    channel(g, '300000000000000001', { publicView: false }); // opened to a member role only
    channel(g, MIRROR, { publicView: false });
    const cfg = readChatExportConfig({ LOBBY_MIRROR_DISCORD_CHANNEL_ID: MIRROR });
    const picked = await selectSourceChannels(client([g]), cfg);
    expect(picked.channels.map((c) => c.id)).toEqual([MIRROR]);
    expect(picked.publicChannelsFound).toBe(0);
  });

  it('CHAT_EXPORT_SOURCE_CHANNEL_IDS replaces the default list (the sync channel is still added); the old name is read too', async () => {
    const g = guild();
    channel(g, '200000000000000001');
    channel(g, '200000000000000002', { publicView: false });
    channel(g, '200000000000000003', { type: ChannelType.GuildForum, publicView: false }); // a forum named explicitly
    channel(g, MIRROR);
    for (const name of ['CHAT_EXPORT_SOURCE_CHANNEL_IDS', 'COMMUNITY_DIGEST_SOURCE_CHANNEL_IDS']) {
      const cfg = readChatExportConfig({
        LOBBY_MIRROR_DISCORD_CHANNEL_ID: MIRROR,
        [name]: '200000000000000002,200000000000000003,999999999999999999',
      });
      const picked = await selectSourceChannels(client([g]), cfg);
      expect(picked.channels.map((c) => c.id).sort()).toEqual(['200000000000000002', MIRROR].sort());
      expect(picked.forums.map((f) => f.id)).toEqual(['200000000000000003']);
      expect(picked.publicChannelsFound).toBeNull();
    }
  });
});

// ─── fetchWindow ───────────────────────────────────────────────────────────

const w = dayWindow('2026-10-11');

function fakeMessage(at: number, n: number): Message {
  return {
    id: SnowflakeUtil.generate({ timestamp: at, increment: BigInt(n % 4096) }).toString(),
    channelId: MIRROR,
    createdTimestamp: at,
    author: { id: n % 2 ? 'bot-self' : `u${n}`, bot: n % 2 === 1 },
    webhookId: null,
    system: false,
    content: `m${n}`,
    attachments: new Collection(),
    stickers: new Collection(),
  } as unknown as Message;
}

/** History newest-first, served 100 at a time below `before`, like Discord. */
function pagerOver(history: Message[]): MessagePager & { calls: Array<{ before?: string }> } {
  const sorted = [...history].sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1));
  const calls: Array<{ before?: string }> = [];
  return {
    calls,
    fetch: async (opts) => {
      calls.push({ before: opts.before });
      const below = sorted.filter((m) => !opts.before || BigInt(m.id) < BigInt(opts.before));
      return new Collection(below.slice(0, opts.limit).map((m) => [m.id, m] as [string, Message]));
    },
  };
}

describe('fetchWindow', () => {
  it('pages backwards from the window end and keeps only [start, end)', async () => {
    const history: Message[] = [];
    // 250 messages inside the day, 30 before it, 20 after it.
    for (let i = 0; i < 250; i += 1) history.push(fakeMessage(w.start + 1000 + i * 60_000, i));
    for (let i = 0; i < 30; i += 1) history.push(fakeMessage(w.start - 1000 - i * 60_000, 1000 + i));
    for (let i = 0; i < 20; i += 1) history.push(fakeMessage(w.end + 1000 + i * 60_000, 2000 + i));
    const pager = pagerOver(history);
    const res = await fetchWindow(pager, w, 'bot-self');
    expect(res.truncated).toBe(false);
    expect(res.messages).toHaveLength(250);
    expect(res.messages.every((m) => m.createdAt >= w.start && m.createdAt < w.end)).toBe(true);
    expect(pager.calls).toHaveLength(3); // 100 + 100 + (50 inside + older) → stop at the start
    expect(SnowflakeUtil.timestampFrom(pager.calls[0].before ?? '0')).toBe(w.end); // starts at the window end
    expect(res.messages.find((m) => m.authorIsSelf)).toMatchObject({ authorIsBot: true });
  });

  it('a page cap is reported as truncated, never silently', async () => {
    const history: Message[] = [];
    for (let i = 0; i < 350; i += 1) history.push(fakeMessage(w.start + 1000 + i * 1000, i));
    const res = await fetchWindow(pagerOver(history), w, 'bot-self', 2);
    expect(res.truncated).toBe(true);
    expect(res.messages).toHaveLength(200);
  });

  it('toRawMessage counts attachments and stickers and flags our own messages', () => {
    const m = {
      ...fakeMessage(w.start + 5, 1),
      attachments: new Collection([['a', {}]]),
      stickers: new Collection([['s', {}], ['t', {}]]),
    } as unknown as Message;
    expect(toRawMessage(m, 'bot-self')).toMatchObject({ authorIsSelf: true, authorIsBot: true, attachmentCount: 3, content: 'm1' });
  });
});

// ─── Forums ────────────────────────────────────────────────────────────────

const DAY = dayWindow('2026-10-11'); // Sun 10/11 00:00 → 24:00 +08
const H = 3_600_000;
let snow = 0;
function sf(timestamp: number): string {
  snow += 1;
  return SnowflakeUtil.generate({ timestamp, increment: BigInt(snow % 4096) }).toString();
}

interface FakeThreadMessage {
  at: number;
  author?: string;
  bot?: boolean;
  content?: string;
  /** The post's starter message (id = thread id). */
  starter?: boolean;
}

type FakeThread = ThreadLike & { pager: ReturnType<typeof pagerOver> };

function fakeThread(opts: { createdAt: number; name: string; parentId: string; archivedAt?: number | null; messages: FakeThreadMessage[]; failFetch?: boolean }): FakeThread {
  const id = sf(opts.createdAt);
  const history = opts.messages.map(
    (m) =>
      ({
        id: m.starter ? id : sf(m.at),
        channelId: id,
        createdTimestamp: m.at,
        author: { id: m.author ?? 'u-1', bot: m.bot ?? false },
        webhookId: null,
        system: false,
        content: m.content ?? '',
        attachments: new Collection(),
        stickers: new Collection(),
      }) as unknown as Message,
  );
  const pager = pagerOver(history);
  const lastMessageId = history.length ? history.reduce((a, b) => (BigInt(a.id) > BigInt(b.id) ? a : b)).id : null;
  return {
    id,
    name: opts.name,
    parentId: opts.parentId,
    archiveTimestamp: opts.archivedAt ?? null,
    lastMessageId,
    pager,
    messages: opts.failFetch
      ? {
          fetch: async () => {
            throw new Error('Missing Access');
          },
        }
      : pager,
  };
}

/** A forum mock: fetchActive returns `active`; fetchArchived pages `archived` newest-archived first, like Discord. */
function fakeForum(id: string, name: string, active: FakeThread[], archived: FakeThread[], opts: { failArchived?: boolean } = {}) {
  const archivedCalls: Array<{ before?: Date; limit?: number }> = [];
  const sorted = [...archived].sort((a, b) => (b.archiveTimestamp ?? 0) - (a.archiveTimestamp ?? 0));
  const forum: ForumLike & { archivedCalls: typeof archivedCalls } = {
    id,
    name,
    archivedCalls,
    threads: {
      fetchActive: async () => ({ threads: new Collection(active.map((t) => [t.id, t] as [string, ThreadLike])) }),
      fetchArchived: async (o) => {
        archivedCalls.push({ before: o.before, limit: o.limit });
        if (opts.failArchived) throw new Error('Missing Access');
        const below = o.before ? sorted.filter((t) => (t.archiveTimestamp ?? 0) < (o.before as Date).getTime()) : sorted;
        const limit = o.limit ?? 50;
        return { threads: new Collection(below.slice(0, limit).map((t) => [t.id, t] as [string, ThreadLike])), hasMore: below.length > limit };
      },
    },
  };
  return forum;
}

/** Put a forum mock into a guild (public, readable) so selectSourceChannels finds it. */
function addForum(g: ReturnType<typeof guild>, forum: ReturnType<typeof fakeForum>, opts: { publicView?: boolean } = {}) {
  const ch = channel(g, forum.id, { type: ChannelType.GuildForum, publicView: opts.publicView });
  Object.assign(ch, { name: forum.name, threads: forum.threads });
  return ch;
}

describe('forum threads', () => {
  it('threadMayCoverWindow: created after the day, or last message before it → not read', () => {
    const inside = fakeThread({ createdAt: DAY.start - 5 * H, name: 'a', parentId: 'f', messages: [{ at: DAY.start + H }] });
    const stale = fakeThread({ createdAt: DAY.start - 50 * H, name: 'b', parentId: 'f', messages: [{ at: DAY.start - H }] });
    const later = fakeThread({ createdAt: DAY.end + H, name: 'c', parentId: 'f', messages: [{ at: DAY.end + H, starter: true }] });
    const noLast = { ...inside, lastMessageId: null };
    expect(threadMayCoverWindow(inside, DAY)).toBe(true);
    expect(threadMayCoverWindow(stale, DAY)).toBe(false);
    expect(threadMayCoverWindow(later, DAY)).toBe(false);
    expect(threadMayCoverWindow(noLast, DAY)).toBe(true); // unknown → read
  });

  it('lists active threads and archived ones newest first, stopping at the first page that reaches a thread archived before the day', async () => {
    const F = '700000000000000001';
    const activeIn = fakeThread({ createdAt: DAY.start + H, name: 'active', parentId: F, messages: [{ at: DAY.start + H, starter: true }] });
    const activeOld = fakeThread({ createdAt: DAY.start - 90 * H, name: 'old', parentId: F, messages: [{ at: DAY.start - 80 * H }] });
    const otherParent = fakeThread({ createdAt: DAY.start + H, name: 'x', parentId: '799', messages: [{ at: DAY.start + 2 * H }] });
    // 150 archived threads: archived 1 hour apart going back from 2 days after the day; their last message
    // is 1 hour before they were archived. The listing must stop on the page that crosses the day start.
    const archived: FakeThread[] = [];
    for (let i = 0; i < 150; i += 1) {
      const archivedAt = DAY.end + 48 * H - i * H;
      archived.push(fakeThread({ createdAt: archivedAt - 30 * H, name: `p${i}`, parentId: F, archivedAt, messages: [{ at: archivedAt - H }] }));
    }
    const forum = fakeForum(F, '討論區', [activeIn, activeOld, otherParent], archived);
    const res = await listForumThreads(forum, DAY);
    expect(res.archivedTruncated).toBe(false);
    expect(forum.archivedCalls).toHaveLength(1); // page 1 (100 threads) already reaches before the day start
    expect(forum.archivedCalls[0]).toEqual({ before: undefined, limit: 100 });
    const ids = new Set(res.threads.map((t) => t.id));
    expect(ids.has(activeIn.id)).toBe(true);
    expect(ids.has(activeOld.id)).toBe(false); // last message before the day
    expect(ids.has(otherParent.id)).toBe(false);
    // Archived threads whose last message falls on or after the day start and that were created before its end.
    const expected = archived.filter((t) => threadMayCoverWindow(t, DAY) && (t.archiveTimestamp ?? 0) >= DAY.start);
    expect(expected.length).toBeGreaterThan(0);
    for (const t of expected) expect(ids.has(t.id)).toBe(true);
    expect(res.threads).toHaveLength(1 + expected.length);

    // A window far in the past: page 2 is fetched with `before` = the oldest archive time of page 1.
    const older = dayWindow('2026-10-05');
    const forum2 = fakeForum(F, '討論區', [], archived);
    const res2 = await listForumThreads(forum2, older);
    expect(forum2.archivedCalls).toHaveLength(2);
    expect(forum2.archivedCalls[1].before?.getTime()).toBe(Math.min(...archived.slice(0, 100).map((t) => t.archiveTimestamp ?? 0)));
    expect(res2.archivedTruncated).toBe(false);
  });

  it('an archived listing that hits the page cap is reported as truncated', async () => {
    const F = '700000000000000002';
    const archived = Array.from({ length: 30 }, (_, i) =>
      fakeThread({ createdAt: DAY.start + H, name: `t${i}`, parentId: F, archivedAt: DAY.end + 100 * H - i * H, messages: [{ at: DAY.start + 2 * H }] }),
    );
    const forum = fakeForum(F, '討論區', [], archived);
    const origFetch = forum.threads.fetchArchived;
    forum.threads.fetchArchived = (o, c) => origFetch({ ...o, limit: 10 }, c); // 10 per page
    const res = await listForumThreads(forum, DAY, 2);
    expect(res.archivedTruncated).toBe(true);
    expect(forum.archivedCalls).toHaveLength(2);
  });

  function forumServer() {
    const DISCUSS = '700000000000000010';
    // Records forum: post A posted that day — starter (the game record), the bot's format-check reply,
    // a human reply to it, and a reply the next day.
    const postA = fakeThread({
      createdAt: DAY.start + 10 * H,
      name: '1011一般場1',
      parentId: RECORDS_FORUM_CHANNEL_ID,
      messages: [
        { at: DAY.start + 10 * H, author: 'u-rec', content: '牌譜本文', starter: true },
        { at: DAY.start + 10 * H + 60_000, author: 'bot-self', bot: true, content: '⚠️ 這篇牌譜的格式看不懂' },
        { at: DAY.start + 11 * H, author: 'u-rec', content: '已修正格式' },
        { at: DAY.end + H, author: 'u-2', content: '隔天的回覆' },
      ],
    });
    // Records forum: post B posted the day before, one reply that day (archived later).
    const postB = fakeThread({
      createdAt: DAY.start - 20 * H,
      name: '1010一般場3',
      parentId: RECORDS_FORUM_CHANNEL_ID,
      archivedAt: DAY.end + 30 * H,
      messages: [
        { at: DAY.start - 20 * H, author: 'u-3', content: '前一天的牌譜', starter: true },
        { at: DAY.start + 15 * H, author: 'u-4', content: '這局湖驗錯了' },
      ],
    });
    // Discussion forum: post C (starter + reply kept), post D excluded by id, post E from last week.
    const postC = fakeThread({
      createdAt: DAY.start + 20 * H,
      name: '湖中規則',
      parentId: DISCUSS,
      messages: [
        { at: DAY.start + 20 * H, author: 'u-5', content: '想問湖中可以驗自己嗎', starter: true },
        { at: DAY.start + 21 * H, author: 'u-6', content: '不行' },
      ],
    });
    const postD = fakeThread({ createdAt: DAY.start + H, name: '私事', parentId: DISCUSS, messages: [{ at: DAY.start + H, content: '不該讀', starter: true }] });
    const postE = fakeThread({
      createdAt: DAY.start - 200 * H,
      name: '舊文',
      parentId: DISCUSS,
      archivedAt: DAY.start - 100 * H,
      messages: [{ at: DAY.start - 200 * H, content: '上週', starter: true }],
    });
    const records = fakeForum(RECORDS_FORUM_CHANNEL_ID, '牌譜紀錄與覆盤', [postA], [postB]);
    const discuss = fakeForum(DISCUSS, '討論區', [postC, postD], [postE]);
    const g = guild();
    addForum(g, records);
    addForum(g, discuss);
    return { g, records, discuss, postA, postB, postC, postD, postE, DISCUSS };
  }

  it('reads the day of every public forum: records starter skipped, replies (also to the bot’s format reply) kept, 「論壇／標題」 as the channel', async () => {
    const s = forumServer();
    const cfg = readChatExportConfig({ CHAT_EXPORT_EXCLUDE_CHANNEL_IDS: s.postD.id });
    const res = await collectDiscordMessages(client([s.g]), cfg, DAY);
    expect(res.forums).toBe(2);
    expect(res.threadsRead).toBe(3); // A, B, C — D excluded, E archived before the day
    expect(res.starterSkipped).toBe(1); // A's record; B's starter is from the day before
    expect(res.failedChannels).toBe(0);
    expect(res.threadsOverCap).toBe(0);
    expect(s.postD.pager.calls).toHaveLength(0);
    expect(s.postE.pager.calls).toHaveLength(0);
    expect(res.messages.map((m) => m.content).sort()).toEqual(
      ['⚠️ 這篇牌譜的格式看不懂', '已修正格式', '這局湖驗錯了', '想問湖中可以驗自己嗎', '不行'].sort(),
    );
    expect(res.channels.map((c) => c.name).sort()).toEqual(['牌譜紀錄與覆盤／1010一般場3', '牌譜紀錄與覆盤／1011一般場1', '討論區／湖中規則'].sort());
    expect(res.channels.every((c) => c.isThread)).toBe(true);

    // Through the row builder: the bot's own format reply follows the usual rule (skipped), the human reply stays.
    const rows = buildExportRows(res.messages, res.channels, DAY.dayKey);
    expect(rows.rows.map((r) => [r[2], r[5]])).toEqual([
      ['牌譜紀錄與覆盤／1011一般場1', '已修正格式'],
      ['牌譜紀錄與覆盤／1010一般場3', '這局湖驗錯了'],
      ['討論區／湖中規則', '想問湖中可以驗自己嗎'],
      ['討論區／湖中規則', '不行'],
    ]);
    expect(rows.skipped.bot).toBe(1);
    expect(rows.threads).toBe(3);
    expect(JSON.stringify(rows.rows)).not.toContain('牌譜本文');
  });

  it('caps the threads read per day (counted), and counts unreadable forums / threads as failed', async () => {
    const s = forumServer();
    const capped = await collectDiscordMessages(client([s.g]), readChatExportConfig({}), DAY, { maxThreads: 2 });
    expect(capped.threadsRead).toBe(2);
    expect(capped.threadsOverCap).toBe(2); // A, B, C, D were candidates

    const g = guild();
    const F1 = '700000000000000020';
    const F2 = '700000000000000021';
    const broken = fakeThread({ createdAt: DAY.start + H, name: 'x', parentId: F1, messages: [{ at: DAY.start + H, starter: true }], failFetch: true });
    const fine = fakeThread({ createdAt: DAY.start + H, name: 'y', parentId: F1, messages: [{ at: DAY.start + H, content: 'ok', starter: true }] });
    addForum(g, fakeForum(F1, 'A', [broken, fine], []));
    addForum(g, fakeForum(F2, 'B', [], [], { failArchived: true }));
    const res = await collectDiscordMessages(client([g]), readChatExportConfig({}), DAY);
    expect(res.failedChannels).toBe(2); // the forum whose archive listing failed + the thread that failed
    expect(res.forums).toBe(1);
    expect(res.threadsRead).toBe(1);
    expect(res.messages.map((m) => m.content)).toEqual(['ok']);
  });

  it('a private forum is not read by default', async () => {
    const g = guild();
    const F = '700000000000000030';
    const t = fakeThread({ createdAt: DAY.start + H, name: 'z', parentId: F, messages: [{ at: DAY.start + H, starter: true }] });
    addForum(g, fakeForum(F, '幹部', [t], []), { publicView: false });
    const res = await collectDiscordMessages(client([g]), readChatExportConfig({}), DAY);
    expect(res.forums).toBe(0);
    expect(t.pager.calls).toHaveLength(0);
  });
});
