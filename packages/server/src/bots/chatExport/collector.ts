/**
 * Read one week of Discord history for the weekly chat-log export.
 *
 * Sources (default): every guild text / announcement channel that @everyone
 * can view and the bot can read the history of, plus — always — the LINE↔
 * Discord sync channel (LOBBY_MIRROR_DISCORD_CHANNEL_ID), where the bot
 * relays the LINE group and the website lobby. Forum channels (牌譜紀錄與覆盤) and threads
 * are skipped. CHAT_EXPORT_SOURCE_CHANNEL_IDS replaces the default list
 * (the sync channel is still added); CHAT_EXPORT_EXCLUDE_CHANNEL_IDS and the
 * /意見 admin channel are always left out (config.ts).
 *
 * Messages are reduced to RawChatMessage and handed to the row builder
 * (rows.ts). Nothing here logs text or names.
 */

import { ChannelType, PermissionFlagsBits, SnowflakeUtil } from 'discord.js';
import type { Channel, Client, Collection, GuildBasedChannel, Message, NewsChannel, TextChannel } from 'discord.js';
import type { ChatExportConfig } from './config';
import type { ChatChannel, RawChatMessage } from './rows';
import type { ExportWindow } from './window';

/** Pages of 100 per channel before giving up on the oldest part (reported, never silent). */
export const MAX_PAGES_PER_CHANNEL = 200;

type ReadableChannel = TextChannel | NewsChannel;

export interface CollectResult {
  messages: RawChatMessage[];
  channels: ChatChannel[];
  /** Channels whose history hit MAX_PAGES_PER_CHANNEL before reaching the window start. */
  truncatedChannels: number;
  /** Channels that could not be read (permissions changed, deleted…). */
  failedChannels: number;
  /**
   * Channels found by the default rule (visible to @everyone, bot can read),
   * or null when CHAT_EXPORT_SOURCE_CHANNEL_IDS sets the list. 0 means
   * only the sync channel is read — e.g. a server that hides everything from
   * @everyone and opens channels to a member role; reported, never silent.
   */
  publicChannelsFound: number | null;
}

export interface SourceSelection {
  channels: ReadableChannel[];
  /** See CollectResult.publicChannelsFound. */
  publicChannelsFound: number | null;
}

function isReadableType(ch: Channel | GuildBasedChannel | null | undefined): ch is ReadableChannel {
  return !!ch && (ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement);
}

function everyoneCanView(ch: ReadableChannel): boolean {
  const perms = ch.permissionsFor(ch.guild.roles.everyone);
  return !!perms && perms.has(PermissionFlagsBits.ViewChannel);
}

function botCanReadHistory(ch: ReadableChannel): boolean {
  const me = ch.guild.members.me;
  if (!me) return false;
  const perms = ch.permissionsFor(me);
  return !!perms && perms.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]);
}

async function fetchChannel(client: Client, id: string): Promise<ReadableChannel | null> {
  try {
    const ch = await client.channels.fetch(id);
    return isReadableType(ch) ? ch : null;
  } catch {
    return null;
  }
}

/** Decide which channels to read. */
export async function selectSourceChannels(
  client: Client,
  cfg: ChatExportConfig,
  excludeIds: string[] = [],
): Promise<SourceSelection> {
  const exclude = new Set([...cfg.excludeChannelIds, ...excludeIds].filter(Boolean));
  const picked = new Map<string, ReadableChannel>();
  let publicChannelsFound: number | null = null;

  if (cfg.sourceChannelIds.length > 0) {
    for (const id of cfg.sourceChannelIds) {
      const ch = await fetchChannel(client, id);
      if (ch && botCanReadHistory(ch)) picked.set(ch.id, ch);
    }
  } else {
    const guilds = cfg.guildId
      ? [client.guilds.cache.get(cfg.guildId)].filter((g): g is NonNullable<typeof g> => !!g)
      : [...client.guilds.cache.values()];
    for (const guild of guilds) {
      for (const ch of guild.channels.cache.values()) {
        if (isReadableType(ch) && everyoneCanView(ch) && botCanReadHistory(ch)) picked.set(ch.id, ch);
      }
    }
    publicChannelsFound = [...picked.keys()].filter((id) => !exclude.has(id) && id !== cfg.mirrorChannelId).length;
  }

  if (cfg.mirrorChannelId && !picked.has(cfg.mirrorChannelId)) {
    const mirror = await fetchChannel(client, cfg.mirrorChannelId);
    if (mirror && botCanReadHistory(mirror)) picked.set(mirror.id, mirror);
  }

  return { channels: [...picked.values()].filter((ch) => !exclude.has(ch.id)), publicChannelsFound };
}

export function toRawMessage(m: Message, selfId: string): RawChatMessage {
  return {
    id: m.id,
    channelId: m.channelId,
    createdAt: m.createdTimestamp,
    authorId: m.author.id,
    authorIsBot: m.author.bot,
    authorIsSelf: m.author.id === selfId,
    webhookId: m.webhookId ?? null,
    system: m.system,
    content: m.content ?? '',
    attachmentCount: (m.attachments?.size ?? 0) + (m.stickers?.size ?? 0),
  };
}

/** Minimal surface of channel.messages used for paging (tests inject a fake). */
export interface MessagePager {
  fetch(opts: { limit: number; before?: string; cache?: boolean }): Promise<Collection<string, Message>>;
}

/**
 * Page backwards from the window end until a message older than the window
 * start appears (or the page cap). Returns raw messages inside [start, end).
 */
export async function fetchWindow(
  pager: MessagePager,
  window: ExportWindow,
  selfId: string,
  maxPages: number = MAX_PAGES_PER_CHANNEL,
): Promise<{ messages: RawChatMessage[]; truncated: boolean }> {
  const out: RawChatMessage[] = [];
  let before: string | undefined = SnowflakeUtil.generate({ timestamp: window.end }).toString();
  for (let page = 0; page < maxPages; page += 1) {
    const batch = await pager.fetch({ limit: 100, before, cache: false });
    if (batch.size === 0) return { messages: out, truncated: false };
    let oldestId: string | null = null;
    let reachedStart = false;
    for (const m of batch.values()) {
      if (oldestId === null || BigInt(m.id) < BigInt(oldestId)) oldestId = m.id;
      if (m.createdTimestamp < window.start) {
        reachedStart = true;
        continue;
      }
      if (m.createdTimestamp >= window.end) continue;
      out.push(toRawMessage(m, selfId));
    }
    if (reachedStart || batch.size < 100 || oldestId === null) return { messages: out, truncated: false };
    before = oldestId;
  }
  return { messages: out, truncated: true };
}

export async function collectDiscordMessages(
  client: Client,
  cfg: ChatExportConfig,
  window: ExportWindow,
  opts: { excludeIds?: string[]; maxPages?: number } = {},
): Promise<CollectResult> {
  const selfId = client.user?.id ?? '';
  const { channels: sources, publicChannelsFound } = await selectSourceChannels(client, cfg, opts.excludeIds);
  const result: CollectResult = { messages: [], channels: [], truncatedChannels: 0, failedChannels: 0, publicChannelsFound };
  for (const ch of sources) {
    try {
      const { messages, truncated } = await fetchWindow(ch.messages, window, selfId, opts.maxPages);
      result.messages.push(...messages);
      result.channels.push({ id: ch.id, name: ch.name, isMirror: ch.id === cfg.mirrorChannelId });
      if (truncated) result.truncatedChannels += 1;
    } catch {
      result.failedChannels += 1; // permission change / deleted channel — counted, not logged by name
    }
  }
  return result;
}
