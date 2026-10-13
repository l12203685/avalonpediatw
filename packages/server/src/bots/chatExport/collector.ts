/**
 * Read one day of Discord history for the daily chat-log export.
 *
 * Sources (default):
 *   - every guild text / announcement channel that @everyone can view and
 *     the bot can read the history of;
 *   - the LINE↔Discord sync channel (LOBBY_MIRROR_DISCORD_CHANNEL_ID, even
 *     when hidden from @everyone; unless excluded), where the bot relays the
 *     LINE group and the website lobby;
 *   - every forum channel that @everyone can view and the bot can read:
 *     the messages of its posts (threads) that fall inside the day — starter
 *     posts and replies, from active and archived threads. Archived threads
 *     are listed newest-archived first and the listing stops at the first
 *     thread archived before the day started (nothing in it can be newer).
 *     In the records forum 「牌譜紀錄與覆盤」 each post's starter message (the
 *     game record: data, not an opinion) is skipped; replies are kept.
 * CHAT_EXPORT_SOURCE_CHANNEL_IDS replaces the default list (text channels
 * or forums; the sync channel is still added); CHAT_EXPORT_EXCLUDE_CHANNEL_IDS,
 * the admin channel 「大劍管理員」 and the /意見 channel are always left out
 * (config.ts) — also when one of them is a forum or a single forum thread.
 *
 * Work is bounded (config.ts): pages per channel / thread, archived-thread
 * pages per forum, threads per day. Every cut is counted in CollectResult,
 * never silent. Messages are reduced to RawChatMessage and handed to the
 * row builder (rows.ts). Nothing here logs text, names or channel names.
 */

import { ChannelType, PermissionFlagsBits, SnowflakeUtil } from 'discord.js';
import type { Channel, Client, Collection, ForumChannel, GuildBasedChannel, Message, NewsChannel, TextChannel } from 'discord.js';
import {
  CHAT_EXPORT_MAX_ARCHIVED_PAGES,
  CHAT_EXPORT_MAX_PAGES_PER_CHANNEL,
  CHAT_EXPORT_MAX_PAGES_PER_THREAD,
  CHAT_EXPORT_MAX_THREADS_PER_DAY,
  RECORDS_FORUM_CHANNEL_ID,
  type ChatExportConfig,
} from './config';
import type { ChatChannel, RawChatMessage } from './rows';
import type { ExportWindow } from './window';

type ReadableChannel = TextChannel | NewsChannel;
type SourceChannel = ReadableChannel | ForumChannel;

/** Minimal surface of channel.messages used for paging (tests inject a fake). */
export interface MessagePager {
  fetch(opts: { limit: number; before?: string; cache?: boolean }): Promise<Collection<string, Message>>;
}

/** The parts of a forum thread (discord.js ThreadChannel) the collector uses; tests inject plain objects. */
export interface ThreadLike {
  id: string;
  /** The post title. */
  name: string;
  parentId: string | null;
  /** Epoch ms of the last archive-status change (archived threads); null for an active one. */
  archiveTimestamp: number | null;
  lastMessageId: string | null;
  messages: MessagePager;
}

export interface FetchedThreadsLike {
  threads: { values(): IterableIterator<ThreadLike> };
  hasMore?: boolean;
}

/** The parts of a forum channel (discord.js ForumChannel) the collector uses. */
export interface ForumLike {
  id: string;
  name: string;
  threads: {
    fetchActive(cache?: boolean): Promise<FetchedThreadsLike>;
    fetchArchived(opts: { type: 'public'; limit?: number; before?: Date }, cache?: boolean): Promise<FetchedThreadsLike>;
  };
}

export interface CollectResult {
  messages: RawChatMessage[];
  /** Text channels and forum threads that were read (threads with isThread). */
  channels: ChatChannel[];
  /** Channels or threads whose history hit the page cap before reaching the day start. */
  truncatedChannels: number;
  /** Channels, forums or threads that could not be read (permissions changed, deleted…). */
  failedChannels: number;
  /**
   * Channels and forums found by the default rule (visible to @everyone,
   * bot can read), or null when CHAT_EXPORT_SOURCE_CHANNEL_IDS sets the
   * list. 0 means only the sync channel is read — e.g. a server that hides
   * everything from @everyone and opens channels to a member role;
   * reported, never silent.
   */
  publicChannelsFound: number | null;
  /** Forums whose thread lists were read. */
  forums: number;
  /** Forum threads whose messages were read. */
  threadsRead: number;
  /** Forum threads that may hold messages of the day but were not read (CHAT_EXPORT_MAX_THREADS_PER_DAY). */
  threadsOverCap: number;
  /** Forums whose archived-thread listing hit CHAT_EXPORT_MAX_ARCHIVED_PAGES before reaching the day start. */
  archivedListsTruncated: number;
  /** Starter messages (game records) skipped in the records forum. */
  starterSkipped: number;
}

export function emptyCollectResult(): CollectResult {
  return {
    messages: [],
    channels: [],
    truncatedChannels: 0,
    failedChannels: 0,
    publicChannelsFound: null,
    forums: 0,
    threadsRead: 0,
    threadsOverCap: 0,
    archivedListsTruncated: 0,
    starterSkipped: 0,
  };
}

export interface SourceSelection {
  channels: ReadableChannel[];
  forums: ForumLike[];
  /** See CollectResult.publicChannelsFound. */
  publicChannelsFound: number | null;
}

function isReadableType(ch: Channel | GuildBasedChannel | null | undefined): ch is ReadableChannel {
  return !!ch && (ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement);
}

function isForumType(ch: Channel | GuildBasedChannel | null | undefined): ch is ForumChannel {
  return !!ch && ch.type === ChannelType.GuildForum;
}

function everyoneCanView(ch: SourceChannel): boolean {
  const perms = ch.permissionsFor(ch.guild.roles.everyone);
  return !!perms && perms.has(PermissionFlagsBits.ViewChannel);
}

function botCanReadHistory(ch: SourceChannel): boolean {
  const me = ch.guild.members.me;
  if (!me) return false;
  const perms = ch.permissionsFor(me);
  return !!perms && perms.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]);
}

async function fetchChannel(client: Client, id: string): Promise<SourceChannel | null> {
  try {
    const ch = await client.channels.fetch(id);
    return isReadableType(ch) || isForumType(ch) ? ch : null;
  } catch {
    return null;
  }
}

function asForum(ch: ForumChannel): ForumLike {
  return ch as unknown as ForumLike;
}

/** Decide which channels and forums to read. */
export async function selectSourceChannels(
  client: Client,
  cfg: ChatExportConfig,
  excludeIds: string[] = [],
): Promise<SourceSelection> {
  const exclude = new Set([...cfg.excludeChannelIds, ...excludeIds].filter(Boolean));
  const picked = new Map<string, ReadableChannel>();
  const forums = new Map<string, ForumChannel>();
  let publicChannelsFound: number | null = null;

  const take = (ch: SourceChannel): void => {
    if (isForumType(ch)) forums.set(ch.id, ch);
    else picked.set(ch.id, ch);
  };

  if (cfg.sourceChannelIds.length > 0) {
    for (const id of cfg.sourceChannelIds) {
      const ch = await fetchChannel(client, id);
      if (ch && botCanReadHistory(ch)) take(ch);
    }
  } else {
    const guilds = cfg.guildId
      ? [client.guilds.cache.get(cfg.guildId)].filter((g): g is NonNullable<typeof g> => !!g)
      : [...client.guilds.cache.values()];
    for (const guild of guilds) {
      for (const ch of guild.channels.cache.values()) {
        if ((isReadableType(ch) || isForumType(ch)) && everyoneCanView(ch) && botCanReadHistory(ch)) take(ch);
      }
    }
    publicChannelsFound = [...picked.keys(), ...forums.keys()].filter((id) => !exclude.has(id) && id !== cfg.mirrorChannelId).length;
  }

  if (cfg.mirrorChannelId && !picked.has(cfg.mirrorChannelId)) {
    const mirror = await fetchChannel(client, cfg.mirrorChannelId);
    if (mirror && isReadableType(mirror) && botCanReadHistory(mirror)) picked.set(mirror.id, mirror);
  }

  return {
    channels: [...picked.values()].filter((ch) => !exclude.has(ch.id)),
    forums: [...forums.values()].filter((ch) => !exclude.has(ch.id)).map(asForum),
    publicChannelsFound,
  };
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

/**
 * Page backwards from the window end until a message older than the window
 * start appears (or the page cap). Returns raw messages inside [start, end).
 */
export async function fetchWindow(
  pager: MessagePager,
  window: ExportWindow,
  selfId: string,
  maxPages: number = CHAT_EXPORT_MAX_PAGES_PER_CHANNEL,
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

/** Epoch ms encoded in a Discord id; NaN when it is not one. */
function snowflakeTime(id: string | null | undefined): number {
  if (!id || !/^\d{5,25}$/.test(id)) return NaN;
  try {
    return Number(SnowflakeUtil.timestampFrom(id));
  } catch {
    return NaN;
  }
}

/**
 * Could `t` hold a message of the day? Not when it was created after the
 * day, nor when its last message is older than the day start.
 */
export function threadMayCoverWindow(t: ThreadLike, window: ExportWindow): boolean {
  const created = snowflakeTime(t.id);
  if (Number.isFinite(created) && created >= window.end) return false;
  const last = snowflakeTime(t.lastMessageId);
  if (Number.isFinite(last) && last < window.start) return false;
  return true;
}

/**
 * The forum's threads that may hold messages of the day: every active one,
 * then archived ones newest-archived first, stopping at the first page that
 * reaches a thread archived before the day start (or at the page cap →
 * truncated).
 */
export async function listForumThreads(
  forum: ForumLike,
  window: ExportWindow,
  maxArchivedPages: number = CHAT_EXPORT_MAX_ARCHIVED_PAGES,
): Promise<{ threads: ThreadLike[]; archivedTruncated: boolean }> {
  const found = new Map<string, ThreadLike>();
  const consider = (t: ThreadLike): void => {
    if (t.parentId === forum.id && threadMayCoverWindow(t, window)) found.set(t.id, t);
  };
  const active = await forum.threads.fetchActive(false);
  for (const t of active.threads.values()) consider(t);

  let before: number | undefined;
  for (let page = 0; page < maxArchivedPages; page += 1) {
    const res = await forum.threads.fetchArchived(
      before === undefined ? { type: 'public', limit: 100 } : { type: 'public', limit: 100, before: new Date(before) },
      false,
    );
    let oldest = Infinity;
    let size = 0;
    for (const t of res.threads.values()) {
      size += 1;
      const archivedAt = t.archiveTimestamp ?? NaN;
      if (Number.isFinite(archivedAt)) oldest = Math.min(oldest, archivedAt);
      if (Number.isFinite(archivedAt) && archivedAt < window.start) continue; // archived before the day: nothing in it
      consider(t);
    }
    if (!res.hasMore || size === 0 || !Number.isFinite(oldest) || oldest < window.start) {
      return { threads: [...found.values()], archivedTruncated: false };
    }
    before = oldest;
  }
  return { threads: [...found.values()], archivedTruncated: true };
}

export interface CollectOptions {
  excludeIds?: string[];
  maxPages?: number;
  maxThreadPages?: number;
  maxArchivedPages?: number;
  maxThreads?: number;
  /** The records forum (starter messages skipped); default RECORDS_FORUM_CHANNEL_ID. */
  recordsForumId?: string;
}

export async function collectDiscordMessages(
  client: Client,
  cfg: ChatExportConfig,
  window: ExportWindow,
  opts: CollectOptions = {},
): Promise<CollectResult> {
  const selfId = client.user?.id ?? '';
  const exclude = new Set([...cfg.excludeChannelIds, ...(opts.excludeIds ?? [])].filter(Boolean));
  const { channels: sources, forums, publicChannelsFound } = await selectSourceChannels(client, cfg, opts.excludeIds);
  const result: CollectResult = { ...emptyCollectResult(), publicChannelsFound };

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

  // Forum posts: list every forum first, then read threads up to the per-day cap.
  const recordsForumId = opts.recordsForumId ?? RECORDS_FORUM_CHANNEL_ID;
  const queue: Array<{ forum: ForumLike; thread: ThreadLike }> = [];
  for (const forum of forums) {
    try {
      const { threads, archivedTruncated } = await listForumThreads(forum, window, opts.maxArchivedPages);
      result.forums += 1;
      if (archivedTruncated) result.archivedListsTruncated += 1;
      for (const thread of threads) if (!exclude.has(thread.id)) queue.push({ forum, thread });
    } catch {
      result.failedChannels += 1;
    }
  }
  const maxThreads = Math.max(0, opts.maxThreads ?? CHAT_EXPORT_MAX_THREADS_PER_DAY);
  result.threadsOverCap = Math.max(0, queue.length - maxThreads);
  for (const { forum, thread } of queue.slice(0, maxThreads)) {
    try {
      const { messages, truncated } = await fetchWindow(thread.messages, window, selfId, opts.maxThreadPages ?? CHAT_EXPORT_MAX_PAGES_PER_THREAD);
      // A forum post's starter message has the thread's id.
      const kept = forum.id === recordsForumId ? messages.filter((m) => m.id !== thread.id) : messages;
      result.starterSkipped += messages.length - kept.length;
      result.messages.push(...kept);
      result.channels.push({ id: thread.id, name: `${forum.name}／${thread.name}`, isMirror: false, isThread: true });
      result.threadsRead += 1;
      if (truncated) result.truncatedChannels += 1;
    } catch {
      result.failedChannels += 1;
    }
  }
  return result;
}
