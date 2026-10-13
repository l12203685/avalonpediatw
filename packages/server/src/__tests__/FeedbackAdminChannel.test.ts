/**
 * /意見 forwarding to the owner's admin channel (2026-10-13):
 *
 *   /意見 — FEEDBACK_DISCORD_CHANNEL_ID unset → the admin channel
 *     「大劍管理員」 (1145513360545296574), used as is (the owner chose it; no
 *     visibility refusal); set → that channel; off → acknowledged and
 *     counted, not forwarded; a channel named 「管理者信箱」 is no longer
 *     looked up; never the public mirror channel; text / announcement
 *     channels and threads work, a forum or an unknown id does not.
 *
 * Fake discord.js objects (only the fields the code reads). No network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import type { Client } from 'discord.js';

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
    const oldName = channel(g, '500000000000000003', '管理者信箱');
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
