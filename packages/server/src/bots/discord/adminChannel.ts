/**
 * The owner's private Discord channel (2026-10-13).
 *
 * Two features post things only the owner should read: the weekly community
 * digest (bots/digest) and forwarded /意見 texts (bots/feedback). Both go to
 * ONE private channel, resolved the same way:
 *
 *   1. the first channel id configured in the given env vars
 *      (digest: COMMUNITY_DIGEST_CHANNEL_ID, then FEEDBACK_DISCORD_CHANNEL_ID;
 *       /意見: FEEDBACK_DISCORD_CHANNEL_ID);
 *   2. otherwise the guild text channel named exactly 「管理者信箱」.
 *
 * Whatever is resolved must be private: the bot refuses to post there when
 * @everyone can view it, or when any ordinary role can (servers that hide
 * everything from @everyone and open channels to a "member" role would
 * otherwise pass). Roles with Manage Server / Administrator, the bot's own
 * integration role and per-member overwrites are fine. A summary of the
 * week's chat or an anonymous opinion must never land in a members-visible
 * channel by accident. A configured id that is broken is reported, never
 * silently replaced by another channel.
 *
 * (/意見 with an explicitly configured FEEDBACK_DISCORD_CHANNEL_ID does not
 * come through here: the owner chose that channel on purpose — see
 * feedback/discordForwarder.ts.)
 */

import { ChannelType, PermissionFlagsBits } from 'discord.js';
import type { Channel, Client, GuildBasedChannel, TextChannel } from 'discord.js';

/** Name of the private channel the owner creates (exact match, no #). */
export const ADMIN_CHANNEL_NAME = '管理者信箱';

/** One env var that may hold the admin channel id. */
export interface AdminChannelEnvId {
  env: string;
  id: string;
}

export type AdminChannelProblem =
  /** No Discord client, or the gateway is not ready yet. */
  | 'discord-not-ready'
  /** The configured id does not resolve, or no channel is named 管理者信箱. */
  | 'not-found'
  /** The configured id is not a plain guild text channel. */
  | 'not-text'
  /** @everyone can view the channel — refused. */
  | 'public'
  /** An ordinary role (no Manage Server / Administrator) can view the channel — refused. */
  | 'members-visible'
  /** The bot cannot view or send messages there. */
  | 'bot-cannot-post'
  /** The bot cannot read the channel's history (needed to avoid double posts after a restart). */
  | 'bot-cannot-read-history';

export type AdminChannelResolution =
  | { ok: true; channel: TextChannel; via: 'env' | 'name'; source: string }
  | { ok: false; problem: AdminChannelProblem; via: 'env' | 'name'; source: string };

/** Fixed, text-free description of a failed resolution (safe for logs and replies). */
export function describeAdminChannelProblem(res: Extract<AdminChannelResolution, { ok: false }>): string {
  const where = res.via === 'env' ? `${res.source} 指定的頻道` : `名為「${ADMIN_CHANNEL_NAME}」的頻道`;
  switch (res.problem) {
    case 'discord-not-ready':
      return 'Discord 還沒連上';
    case 'not-found':
      return `找不到${where}`;
    case 'not-text':
      return `${where}不是一般文字頻道`;
    case 'public':
      return `${where}所有人都看得到，為了隱私不貼`;
    case 'members-visible':
      return `${where}有一般身分組看得到（不只管理者），為了隱私不貼`;
    case 'bot-cannot-post':
      return `機器人沒有${where}的檢視或發言權限`;
    case 'bot-cannot-read-history':
      return `機器人沒有${where}的「讀取訊息歷史」權限`;
  }
}

/** True when @everyone can view the channel. Unknown permissions count as visible (refuse when unsure). */
export function isVisibleToEveryone(channel: GuildBasedChannel): boolean {
  const perms = channel.permissionsFor(channel.guild.roles.everyone);
  return !perms || perms.has(PermissionFlagsBits.ViewChannel);
}

/**
 * True when a role other than @everyone that is not a manager role can view
 * the channel. Skipped: the bot's integration role (managed) and roles with
 * Administrator or Manage Server (they can see every channel anyway).
 * permissionsFor(role) applies the role's own permissions plus the
 * @everyone and role overwrites, so a "member" role that is granted View
 * Channel server-wide or by an overwrite is caught.
 */
export function isVisibleToMemberRoles(channel: GuildBasedChannel): boolean {
  const everyoneId = channel.guild.roles.everyone.id;
  for (const role of channel.guild.roles.cache.values()) {
    if (role.id === everyoneId || role.managed) continue;
    if (role.permissions.has(PermissionFlagsBits.Administrator) || role.permissions.has(PermissionFlagsBits.ManageGuild)) continue;
    const perms = channel.permissionsFor(role);
    if (perms && perms.has(PermissionFlagsBits.ViewChannel)) return true;
  }
  return false;
}

/** 'public' / 'members-visible' when the channel is not private enough, else null. */
export function privacyProblem(channel: GuildBasedChannel): 'public' | 'members-visible' | null {
  if (isVisibleToEveryone(channel)) return 'public';
  if (isVisibleToMemberRoles(channel)) return 'members-visible';
  return null;
}

/** True when the bot can view and send messages in the channel (unknown member → let the send decide). */
export function botCanPost(channel: GuildBasedChannel): boolean {
  const me = channel.guild.members.me;
  if (!me) return true;
  const perms = channel.permissionsFor(me);
  return !!perms && perms.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]);
}

/** True when the bot can read the channel's history (unknown member → assume yes, like botCanPost). */
export function botCanReadHistory(channel: GuildBasedChannel): boolean {
  const me = channel.guild.members.me;
  if (!me) return true;
  const perms = channel.permissionsFor(me);
  return !!perms && perms.has(PermissionFlagsBits.ReadMessageHistory);
}

export interface ResolveAdminChannelOptions {
  /** DISCORD_GUILD_ID — limits the name lookup to one server. */
  guildId?: string;
  /** Also require Read Message History (the digest's restart check reads the channel). */
  needHistory?: boolean;
}

/** Older snowflake first (= created earlier). */
function bySnowflake(a: { id: string }, b: { id: string }): number {
  if (a.id.length !== b.id.length) return a.id.length - b.id.length;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function check(ch: Channel | null, via: 'env' | 'name', source: string, needHistory: boolean): AdminChannelResolution {
  if (!ch) return { ok: false, problem: 'not-found', via, source };
  if (ch.type !== ChannelType.GuildText) return { ok: false, problem: 'not-text', via, source };
  const text = ch as TextChannel;
  const privacy = privacyProblem(text);
  if (privacy) return { ok: false, problem: privacy, via, source };
  if (!botCanPost(text)) return { ok: false, problem: 'bot-cannot-post', via, source };
  if (needHistory && !botCanReadHistory(text)) return { ok: false, problem: 'bot-cannot-read-history', via, source };
  return { ok: true, channel: text, via, source };
}

/**
 * Resolve the owner's private channel (see the module comment for the order).
 * Never throws. `guildId` (DISCORD_GUILD_ID) limits the name lookup to one
 * server; when several private channels share the name, the oldest wins.
 */
export async function resolveAdminChannel(
  client: Client | null,
  envIds: AdminChannelEnvId[],
  opts: ResolveAdminChannelOptions = {},
): Promise<AdminChannelResolution> {
  const needHistory = !!opts.needHistory;
  const configured = envIds.find((e) => (e.id || '').trim());
  const via: 'env' | 'name' = configured ? 'env' : 'name';
  const source = configured ? configured.env : ADMIN_CHANNEL_NAME;
  if (!client || !client.isReady()) return { ok: false, problem: 'discord-not-ready', via, source };

  if (configured) {
    let ch: Channel | null = null;
    try {
      ch = await client.channels.fetch(configured.id.trim());
    } catch {
      ch = null; // unknown id / no access — reported as not-found
    }
    return check(ch, 'env', configured.env, needHistory);
  }

  const guildId = (opts.guildId || '').trim();
  const guilds = guildId
    ? [client.guilds.cache.get(guildId)].filter((g): g is NonNullable<typeof g> => !!g)
    : [...client.guilds.cache.values()];
  const named = guilds
    .flatMap((g) => [...g.channels.cache.values()])
    .filter((c) => c.type === ChannelType.GuildText && c.name === ADMIN_CHANNEL_NAME)
    .sort(bySnowflake);
  if (named.length === 0) return { ok: false, problem: 'not-found', via: 'name', source };
  const privateOnes = named.filter((c) => privacyProblem(c) === null);
  if (privateOnes.length === 0) {
    // Report the oldest namesake's reason ('public' or 'members-visible').
    return { ok: false, problem: privacyProblem(named[0]) ?? 'public', via: 'name', source };
  }
  return check(privateOnes[0], 'name', source, needHistory);
}
