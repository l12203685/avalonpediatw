/**
 * The owner's private channel (2026-10-13), shared by the weekly community
 * digest and /意見 forwarding:
 *
 *   resolveAdminChannel — configured ids first (in order, a broken one is
 *     reported, never replaced), else the text channel named 「管理者信箱」;
 *     anything @everyone or an ordinary role can view is refused (manager
 *     roles and the bot's integration role are fine); the bot must be able
 *     to post (and, for the digest, read the history).
 *   /意見 — FEEDBACK_DISCORD_CHANNEL_ID set → used as is (the owner's choice,
 *     unchanged from before 2026-10-13); unset → forwarded to 管理者信箱
 *     (private only); still never to the public mirror channel.
 *
 * Fake discord.js objects (only the fields the code reads). No network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import type { Client } from 'discord.js';

import { ADMIN_CHANNEL_NAME, describeAdminChannelProblem, resolveAdminChannel } from '../bots/discord/adminChannel';
import { createFeedbackDiscordForwarder } from '../bots/feedback/discordForwarder';
import { FeedbackService, type FeedbackForwardPayload } from '../bots/feedback';

const ME = { id: 'member-bot' };

interface FakeRole {
  id: string;
  managed: boolean;
  permissions: { has: (p: bigint) => boolean };
}

function role(id: string, opts: { managed?: boolean; manager?: boolean } = {}): FakeRole {
  return {
    id,
    managed: !!opts.managed,
    permissions: {
      has: (p) => !!opts.manager && (p === PermissionFlagsBits.ManageGuild || p === PermissionFlagsBits.Administrator),
    },
  };
}

const EVERYONE = role('role-everyone');
const MEMBER_ROLE = role('role-member');
const MOD_ROLE = role('role-mod', { manager: true });
const BOT_ROLE = role('role-bot', { managed: true });

interface FakeChannel {
  id: string;
  name: string;
  type: ChannelType;
  guild: FakeGuild;
  sent: FeedbackForwardPayload[];
  permissionsFor: (who: unknown) => { has: (p: bigint | bigint[]) => boolean };
  send: (p: FeedbackForwardPayload) => Promise<void>;
}

interface FakeGuild {
  id: string;
  roles: { everyone: FakeRole; cache: Map<string, FakeRole> };
  members: { me: typeof ME | null };
  channels: { cache: Map<string, FakeChannel> };
}

function guild(id = 'g1'): FakeGuild {
  const roles = new Map([EVERYONE, MEMBER_ROLE, MOD_ROLE, BOT_ROLE].map((r) => [r.id, r]));
  return { id, roles: { everyone: EVERYONE, cache: roles }, members: { me: ME }, channels: { cache: new Map() } };
}

function channel(
  g: FakeGuild,
  id: string,
  name: string,
  opts: {
    publicView?: boolean;
    /** Roles (besides @everyone) that can view the channel. */
    rolesView?: FakeRole[];
    botCanPost?: boolean;
    botHistory?: boolean;
    type?: ChannelType;
  } = {},
): FakeChannel {
  const ch: FakeChannel = {
    id,
    name,
    type: opts.type ?? ChannelType.GuildText,
    guild: g,
    sent: [],
    permissionsFor: (who) => ({
      has: (p) => {
        const flags = Array.isArray(p) ? p : [p];
        if (who === EVERYONE) return flags.every((f) => f === PermissionFlagsBits.ViewChannel && !!opts.publicView);
        if (who === ME) {
          if (flags.includes(PermissionFlagsBits.ReadMessageHistory)) return opts.botHistory ?? true;
          return opts.botCanPost ?? true;
        }
        if ((opts.rolesView ?? []).includes(who as FakeRole)) return flags.every((f) => f === PermissionFlagsBits.ViewChannel);
        return false;
      },
    }),
    send: async (payload) => {
      ch.sent.push(payload);
    },
  };
  g.channels.cache.set(id, ch);
  return ch;
}

function client(guilds: FakeGuild[], ready = true): Client {
  const all = new Map<string, FakeChannel>();
  for (const g of guilds) for (const [id, ch] of g.channels.cache) all.set(id, ch);
  return {
    isReady: () => ready,
    user: { id: 'bot-user' },
    guilds: { cache: new Map(guilds.map((g) => [g.id, g])) },
    channels: {
      fetch: async (id: string) => {
        const ch = all.get(id);
        if (!ch) throw new Error('Unknown Channel');
        return ch;
      },
    },
  } as unknown as Client;
}

describe('resolveAdminChannel', () => {
  it('uses the first configured id; a public one is refused, not replaced', async () => {
    const g = guild();
    const priv = channel(g, '100000000000000001', 'secret');
    const pub = channel(g, '100000000000000002', 'general', { publicView: true });
    channel(g, '100000000000000003', ADMIN_CHANNEL_NAME);
    const c = client([g]);

    const viaFirst = await resolveAdminChannel(c, [
      { env: 'COMMUNITY_DIGEST_CHANNEL_ID', id: priv.id },
      { env: 'FEEDBACK_DISCORD_CHANNEL_ID', id: pub.id },
    ]);
    expect(viaFirst).toMatchObject({ ok: true, via: 'env', source: 'COMMUNITY_DIGEST_CHANNEL_ID' });
    expect(viaFirst.ok && viaFirst.channel.id).toBe(priv.id);

    const viaSecond = await resolveAdminChannel(c, [
      { env: 'COMMUNITY_DIGEST_CHANNEL_ID', id: '' },
      { env: 'FEEDBACK_DISCORD_CHANNEL_ID', id: pub.id },
    ]);
    expect(viaSecond).toMatchObject({ ok: false, problem: 'public', via: 'env', source: 'FEEDBACK_DISCORD_CHANNEL_ID' });

    const broken = await resolveAdminChannel(c, [{ env: 'COMMUNITY_DIGEST_CHANNEL_ID', id: '999' }]);
    expect(broken).toMatchObject({ ok: false, problem: 'not-found', via: 'env' });
  });

  it('falls back to the private channel named 管理者信箱 (oldest first; public namesakes ignored)', async () => {
    const g = guild();
    channel(g, '200000000000000009', ADMIN_CHANNEL_NAME, { publicView: true });
    channel(g, '200000000000000005', ADMIN_CHANNEL_NAME);
    channel(g, '200000000000000007', ADMIN_CHANNEL_NAME);
    channel(g, '200000000000000001', '管理者信箱2');
    const res = await resolveAdminChannel(client([g]), [{ env: 'X', id: '' }]);
    expect(res).toMatchObject({ ok: true, via: 'name', source: ADMIN_CHANNEL_NAME });
    expect(res.ok && res.channel.id).toBe('200000000000000005');
  });

  it('refuses a 管理者信箱 that everyone can see; reports missing channel, no bot access, non-text, not ready', async () => {
    const g = guild();
    channel(g, '300000000000000001', ADMIN_CHANNEL_NAME, { publicView: true });
    const pub = await resolveAdminChannel(client([g]), []);
    expect(pub).toMatchObject({ ok: false, problem: 'public' });
    expect(describeAdminChannelProblem(pub as never)).toBe('名為「管理者信箱」的頻道所有人都看得到，為了隱私不貼');

    expect(await resolveAdminChannel(client([guild('g2')]), [])).toMatchObject({ ok: false, problem: 'not-found', via: 'name' });

    const g3 = guild('g3');
    channel(g3, '300000000000000003', ADMIN_CHANNEL_NAME, { botCanPost: false });
    expect(await resolveAdminChannel(client([g3]), [])).toMatchObject({ ok: false, problem: 'bot-cannot-post' });

    const g4 = guild('g4');
    const forum = channel(g4, '300000000000000004', 'forum', { type: ChannelType.GuildForum });
    expect(await resolveAdminChannel(client([g4]), [{ env: 'X', id: forum.id }])).toMatchObject({ ok: false, problem: 'not-text' });

    expect(await resolveAdminChannel(client([g], false), [])).toMatchObject({ ok: false, problem: 'discord-not-ready' });
    expect(await resolveAdminChannel(null, [])).toMatchObject({ ok: false, problem: 'discord-not-ready' });
  });

  it('refuses a channel an ordinary member role can view; manager roles and the bot role are fine', async () => {
    const g = guild();
    // Server that hides everything from @everyone and opens channels to a "member" role.
    channel(g, '600000000000000001', ADMIN_CHANNEL_NAME, { rolesView: [MEMBER_ROLE, MOD_ROLE] });
    const res = await resolveAdminChannel(client([g]), []);
    expect(res).toMatchObject({ ok: false, problem: 'members-visible', via: 'name' });
    expect(describeAdminChannelProblem(res as never)).toBe('名為「管理者信箱」的頻道有一般身分組看得到（不只管理者），為了隱私不貼');

    const g2 = guild('g2');
    const ok = channel(g2, '600000000000000002', ADMIN_CHANNEL_NAME, { rolesView: [MOD_ROLE, BOT_ROLE] });
    const res2 = await resolveAdminChannel(client([g2]), []);
    expect(res2).toMatchObject({ ok: true });
    expect(res2.ok && res2.channel.id).toBe(ok.id);

    // A configured id is checked the same way.
    const g3 = guild('g3');
    const shared = channel(g3, '600000000000000003', 'mods', { rolesView: [MEMBER_ROLE] });
    expect(await resolveAdminChannel(client([g3]), [{ env: 'COMMUNITY_DIGEST_CHANNEL_ID', id: shared.id }])).toMatchObject({
      ok: false,
      problem: 'members-visible',
      via: 'env',
    });
  });

  it('needHistory: the digest also needs Read Message History (restart check), /意見 does not', async () => {
    const g = guild();
    channel(g, '700000000000000001', ADMIN_CHANNEL_NAME, { botHistory: false });
    const c = client([g]);
    const digest = await resolveAdminChannel(c, [], { needHistory: true });
    expect(digest).toMatchObject({ ok: false, problem: 'bot-cannot-read-history' });
    expect(describeAdminChannelProblem(digest as never)).toBe('機器人沒有名為「管理者信箱」的頻道的「讀取訊息歷史」權限');
    expect(await resolveAdminChannel(c, [])).toMatchObject({ ok: true });
  });

  it('DISCORD_GUILD_ID limits the name lookup to one server', async () => {
    const a = guild('ga');
    const b = guild('gb');
    channel(b, '400000000000000001', ADMIN_CHANNEL_NAME);
    expect(await resolveAdminChannel(client([a, b]), [], { guildId: 'ga' })).toMatchObject({ ok: false, problem: 'not-found' });
    expect(await resolveAdminChannel(client([a, b]), [], { guildId: 'gb' })).toMatchObject({ ok: true });
  });
});

describe('/意見 forwarding to 管理者信箱', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.FEEDBACK_DISCORD_CHANNEL_ID;
    process.env.LOBBY_MIRROR_DISCORD_CHANNEL_ID = '500000000000000099';
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  const warn = vi.fn();
  const quiet = { warn, error: vi.fn() };

  function setup(opts: { adminPublic?: boolean; adminRoles?: FakeRole[]; withAdmin?: boolean } = {}) {
    const g = guild();
    const mirror = channel(g, '500000000000000099', '阿瓦隆同步', { publicView: true });
    const chosen = channel(g, '500000000000000002', 'feedback', { publicView: true });
    const admin =
      opts.withAdmin === false
        ? null
        : channel(g, '500000000000000001', ADMIN_CHANNEL_NAME, { publicView: !!opts.adminPublic, rolesView: opts.adminRoles });
    const c = client([g]);
    const forwarder = createFeedbackDiscordForwarder(() => c, { logger: { warn } });
    const service = new FeedbackService({ discord: forwarder, logger: quiet });
    return { mirror, chosen, admin, service };
  }

  it('FEEDBACK_DISCORD_CHANNEL_ID unset → posted to the private 管理者信箱, no name, no pings', async () => {
    const { mirror, admin, service } = setup();
    const res = await service.submit('line', '排行希望加場次');
    expect(await res.forwarded).toBe('sent');
    expect(admin!.sent).toEqual([{ content: '📮 意見（LINE）：排行希望加場次', allowedMentions: { parse: [] } }]);
    expect(mirror.sent).toEqual([]);
  });

  it('a 管理者信箱 that everyone can see is refused; nothing goes to the mirror channel either', async () => {
    const { mirror, admin, service } = setup({ adminPublic: true });
    const res = await service.submit('discord', '匿名文字');
    expect(await res.forwarded).toBe('skipped');
    expect(admin!.sent).toEqual([]);
    expect(mirror.sent).toEqual([]);
    expect(res.reply).toBe('已收到，謝謝。管理者每週彙整後調整。');
  });

  it('a 管理者信箱 an ordinary member role can see is refused too', async () => {
    const { mirror, admin, service } = setup({ adminRoles: [MEMBER_ROLE] });
    const res = await service.submit('line', '匿名文字');
    expect(await res.forwarded).toBe('skipped');
    expect(admin!.sent).toEqual([]);
    expect(mirror.sent).toEqual([]);
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain('members-visible');
  });

  it('no 管理者信箱 → acknowledged and counted, not forwarded', async () => {
    const { mirror, service } = setup({ withAdmin: false });
    const res = await service.submit('line', '沒有頻道');
    expect(await res.forwarded).toBe('skipped');
    expect(mirror.sent).toEqual([]);
    expect(service.snapshot().opinions).toEqual({ line: 1, discord: 0 });
  });

  it('FEEDBACK_DISCORD_CHANNEL_ID wins over the name and is used as is (the owner chose it; unchanged behaviour)', async () => {
    const { mirror, chosen, admin, service } = setup();
    process.env.FEEDBACK_DISCORD_CHANNEL_ID = chosen.id;
    const res = await service.submit('line', '明確指定');
    expect(await res.forwarded).toBe('sent');
    expect(chosen.sent).toEqual([{ content: '📮 意見（LINE）：明確指定', allowedMentions: { parse: [] } }]);
    expect(admin!.sent).toEqual([]);
    expect(mirror.sent).toEqual([]);
  });

  it('a mock forwarder without the fallback hook keeps the old behaviour (no channel → not forwarded)', async () => {
    const sent: string[] = [];
    const service = new FeedbackService({ discord: { send: async (_id, p) => (sent.push(p.content), true) }, logger: quiet });
    expect(await (await service.submit('line', 'x')).forwarded).toBe('skipped');
    expect(sent).toEqual([]);
  });
});
