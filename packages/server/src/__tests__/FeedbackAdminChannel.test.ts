/**
 * /意見 forwarding to the owner's admin channel (2026-10-13), and the
 * private-channel resolver kept from the earlier design:
 *
 *   /意見 — FEEDBACK_DISCORD_CHANNEL_ID unset → the admin channel
 *     「大劍管理員」 (1145513360545296574), used as is (the owner chose it; no
 *     visibility refusal); set → that channel; off → acknowledged and
 *     counted, not forwarded; a channel named 「管理者信箱」 is no longer
 *     looked up; never the public mirror channel; text / announcement
 *     channels and threads work, a forum or an unknown id does not.
 *   resolveAdminChannel (discord/adminChannel.ts) — has no caller since the
 *     paid digest and the 管理者信箱 fallback were removed (2026-10-13); its
 *     behaviour stays tested until the module is deleted.
 *
 * Fake discord.js objects (only the fields the code reads). No network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import type { Client } from 'discord.js';

import { ADMIN_CHANNEL_NAME, describeAdminChannelProblem, resolveAdminChannel } from '../bots/discord/adminChannel';
import { createFeedbackDiscordForwarder } from '../bots/feedback/discordForwarder';
import { DEFAULT_FEEDBACK_DISCORD_CHANNEL_ID, FEEDBACK_ACK_TEXT, FeedbackService, type FeedbackForwardPayload } from '../bots/feedback';

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
  isDMBased: () => boolean;
  isSendable: () => boolean;
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
    isDMBased: () => false,
    // discord.js: 'send' in channel — a forum (or a category) has no send().
    isSendable: () => ch.type !== ChannelType.GuildForum && ch.type !== ChannelType.GuildCategory,
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

describe('/意見 forwarding to the admin channel 大劍管理員', () => {
  const saved = { ...process.env };
  const MIRROR_ID = '500000000000000099';
  beforeEach(() => {
    delete process.env.FEEDBACK_DISCORD_CHANNEL_ID;
    process.env.LOBBY_MIRROR_DISCORD_CHANNEL_ID = MIRROR_ID;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  const quiet = { warn: vi.fn(), error: vi.fn() };

  function setup(opts: { adminPublic?: boolean; adminType?: ChannelType } = {}) {
    const g = guild();
    const mirror = channel(g, MIRROR_ID, '阿瓦隆同步', { publicView: true });
    const chosen = channel(g, '500000000000000002', 'feedback', { publicView: true });
    const oldName = channel(g, '500000000000000003', ADMIN_CHANNEL_NAME);
    const admin = channel(g, DEFAULT_FEEDBACK_DISCORD_CHANNEL_ID, '大劍管理員', {
      publicView: !!opts.adminPublic,
      type: opts.adminType,
    });
    const c = client([g]);
    const forwarder = createFeedbackDiscordForwarder(() => c);
    const service = new FeedbackService({ discord: forwarder, logger: quiet });
    return { g, c, mirror, chosen, oldName, admin, service };
  }

  it('FEEDBACK_DISCORD_CHANNEL_ID unset → posted to 大劍管理員 (1145513360545296574), no name, no pings', async () => {
    expect(DEFAULT_FEEDBACK_DISCORD_CHANNEL_ID).toBe('1145513360545296574');
    const { mirror, oldName, admin, service } = setup();
    const res = await service.submit('line', '排行希望加場次');
    expect(res.reply).toBe(FEEDBACK_ACK_TEXT);
    expect(await res.forwarded).toBe('sent');
    expect(admin.sent).toEqual([{ content: '📮 意見（LINE）：排行希望加場次', allowedMentions: { parse: [] } }]);
    expect(mirror.sent).toEqual([]);
    expect(oldName.sent).toEqual([]); // the 管理者信箱 name is no longer looked up
  });

  it('the configured or default channel is used as is — no visibility refusal', async () => {
    const { admin, service } = setup({ adminPublic: true });
    const res = await service.submit('discord', '匿名文字');
    expect(await res.forwarded).toBe('sent');
    expect(admin.sent).toHaveLength(1);
  });

  it('FEEDBACK_DISCORD_CHANNEL_ID overrides the default; off → acknowledged and counted, not forwarded', async () => {
    const { mirror, chosen, admin, service } = setup();
    process.env.FEEDBACK_DISCORD_CHANNEL_ID = chosen.id;
    expect(await (await service.submit('line', '明確指定')).forwarded).toBe('sent');
    expect(chosen.sent).toEqual([{ content: '📮 意見（LINE）：明確指定', allowedMentions: { parse: [] } }]);
    expect(admin.sent).toEqual([]);

    process.env.FEEDBACK_DISCORD_CHANNEL_ID = 'off';
    const off = await service.submit('line', '關掉了');
    expect(off.reply).toBe(FEEDBACK_ACK_TEXT);
    expect(await off.forwarded).toBe('skipped');
    expect(service.snapshot().opinions).toEqual({ line: 2, discord: 0 });
    expect(mirror.sent).toEqual([]);
  });

  it('announcement channels and threads work; a forum, an unknown id or no Discord → not forwarded', async () => {
    for (const type of [ChannelType.GuildAnnouncement, ChannelType.PublicThread, ChannelType.PrivateThread]) {
      const { admin, service } = setup({ adminType: type });
      expect(await (await service.submit('line', 'x')).forwarded).toBe('sent');
      expect(admin.sent).toHaveLength(1);
    }
    const forum = setup({ adminType: ChannelType.GuildForum });
    expect(await (await forum.service.submit('line', 'x')).forwarded).toBe('failed');
    expect(forum.admin.sent).toEqual([]);

    const { service } = setup();
    process.env.FEEDBACK_DISCORD_CHANNEL_ID = '999999999999999999';
    expect(await (await service.submit('line', 'x')).forwarded).toBe('failed');

    const offline = new FeedbackService({ discord: createFeedbackDiscordForwarder(() => null), logger: quiet });
    delete process.env.FEEDBACK_DISCORD_CHANNEL_ID;
    expect(await (await offline.submit('line', 'x')).forwarded).toBe('failed');
  });
});
