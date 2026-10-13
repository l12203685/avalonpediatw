/**
 * Weekly chat-log export (2026-10-13) — Discord collection with fakes:
 *
 *   selectSourceChannels — public text / announcement channels the bot can
 *     read; private, forum and unreadable ones skipped; the LINE↔Discord
 *     sync channel always included; exclude list + the /意見 admin channel
 *     left out (even if it were public); CHAT_EXPORT_SOURCE_CHANNEL_IDS
 *     (or the old COMMUNITY_DIGEST_ name) overrides the default list; a
 *     server with no @everyone-visible channel is reported (publicChannelsFound 0)
 *   fetchWindow          — pages backwards with `before`, keeps [start, end),
 *     stops at the window start, reports a page-cap truncation
 */
import { describe, expect, it, vi } from 'vitest';
import { ChannelType, Collection, PermissionFlagsBits, SnowflakeUtil } from 'discord.js';
import type { Client, Message } from 'discord.js';

import { fetchWindow, selectSourceChannels, toRawMessage, type MessagePager } from '../bots/chatExport/collector';
import { readChatExportConfig } from '../bots/chatExport/config';
import { scheduledWindow } from '../bots/chatExport/window';
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
  it('public readable text/announcement channels + the sync channel; skips private, forum, unreadable, excluded', async () => {
    const g = guild();
    channel(g, '100000000000000001'); // public text
    channel(g, '100000000000000002', { type: ChannelType.GuildAnnouncement });
    channel(g, '100000000000000003', { publicView: false }); // private
    channel(g, '100000000000000004', { type: ChannelType.GuildForum });
    channel(g, '100000000000000005', { botRead: false });
    channel(g, '100000000000000006'); // excluded by env
    channel(g, '100000000000000007'); // excluded by the caller
    channel(g, DEFAULT_FEEDBACK_DISCORD_CHANNEL_ID); // the /意見 admin channel: never exported, even if public
    channel(g, MIRROR, { publicView: false }); // sync channel: always read, even when not public
    const cfg = readChatExportConfig({ LOBBY_MIRROR_DISCORD_CHANNEL_ID: MIRROR, CHAT_EXPORT_EXCLUDE_CHANNEL_IDS: '100000000000000006' });
    expect(cfg.excludeChannelIds).toEqual(['100000000000000006', DEFAULT_FEEDBACK_DISCORD_CHANNEL_ID]);
    const picked = await selectSourceChannels(client([g]), cfg, ['100000000000000007']);
    expect(picked.channels.map((c) => c.id).sort()).toEqual(['100000000000000001', '100000000000000002', MIRROR].sort());
    expect(picked.publicChannelsFound).toBe(2);

    // A FEEDBACK_DISCORD_CHANNEL_ID override is the channel left out instead; the old exclude name still works.
    const cfg2 = readChatExportConfig({
      LOBBY_MIRROR_DISCORD_CHANNEL_ID: MIRROR,
      FEEDBACK_DISCORD_CHANNEL_ID: '100000000000000002',
      COMMUNITY_DIGEST_EXCLUDE_CHANNEL_IDS: '100000000000000006',
    });
    const picked2 = await selectSourceChannels(client([g]), cfg2, ['100000000000000007']);
    expect(picked2.channels.map((c) => c.id).sort()).toEqual(['100000000000000001', DEFAULT_FEEDBACK_DISCORD_CHANNEL_ID, MIRROR].sort());
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
    channel(g, MIRROR);
    for (const name of ['CHAT_EXPORT_SOURCE_CHANNEL_IDS', 'COMMUNITY_DIGEST_SOURCE_CHANNEL_IDS']) {
      const cfg = readChatExportConfig({ LOBBY_MIRROR_DISCORD_CHANNEL_ID: MIRROR, [name]: '200000000000000002,999999999999999999' });
      const picked = await selectSourceChannels(client([g]), cfg);
      expect(picked.channels.map((c) => c.id).sort()).toEqual(['200000000000000002', MIRROR].sort());
      expect(picked.publicChannelsFound).toBeNull();
    }
  });
});

// ─── fetchWindow ───────────────────────────────────────────────────────────

const w = scheduledWindow(Date.parse('2026-10-12T01:00:00Z'));

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
    // 250 messages inside the window, 30 before it, 20 after it.
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
