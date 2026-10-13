/**
 * Rows of the weekly chat-log export — pure functions, no I/O.
 *
 * Input: Discord messages reduced to the fields below (collector.ts). Output:
 * one sheet row per conversation message, in time order,
 *
 *   週次        時間（+08）         頻道        來源      發言者代號  內容
 *   2026-10-05  2026-10-05 21:33   阿瓦隆同步   LINE      成員3       排行怎麼沒更新
 *
 * Speakers are replaced by 成員N (owner 2026-10-13: 不點名), numbered per
 * export (one week) in order of first appearance; the mapping lives only
 * inside one buildExportRows() call and is never returned, written or logged.
 * "<@id>" mentions get the same 成員N label as that person's messages.
 *
 * How LINE shows up here: the bot relays LINE group lines (and website
 * lobby lines) into the Discord sync channel as ITS OWN messages, formatted
 * by ChatMirror.formatOutgoingUnified():
 *
 *   [1005 21:35][LINE][小明] 我也看到了      → speaker "line:小明", 來源 LINE
 *   [1005 21:36][AP][阿華] 網站上看得到       → speaker "lobby:阿華", 來源 網站
 *   [1005 21:37][DC][…] …                    → a Discord line echoed outward; never
 *                                              expected in Discord, skipped as a duplicate
 *   [Avalon] 名字: 內容 (legacy format, CHAT_MIRROR_USE_LEGACY_FORMAT=true) → 來源 同步
 *
 * Every other message by the bot (stats digest, slash-command replies, /意見
 * forwards) is skipped, as are other bots, webhooks, Discord system messages,
 * typed commands ("/戰績 …", "/意見 …", also when relayed from LINE) and
 * messages with no text (attachment-only ones are counted, not exported).
 */

import { CHAT_EXPORT_MESSAGE_MAX_CHARS } from './config';
import { taipeiStamp } from './window';

export interface RawChatMessage {
  id: string;
  channelId: string;
  createdAt: number;
  authorId: string;
  authorIsBot: boolean;
  /** Authored by this bot (relays and the bot's own posts). */
  authorIsSelf: boolean;
  webhookId: string | null;
  /** Discord system message (member joined, pin, boost …). */
  system: boolean;
  content: string;
  /** Attachments + stickers on the message. */
  attachmentCount: number;
}

export interface ChatChannel {
  id: string;
  name: string;
  /** The LINE↔Discord sync channel (LOBBY_MIRROR_DISCORD_CHANNEL_ID). */
  isMirror: boolean;
}

export type ChatPlatform = 'discord' | 'line' | 'lobby' | 'relay';

export type ChatSkipReason = 'bot' | 'webhook' | 'system' | 'command' | 'attachment-only' | 'empty' | 'relay-echo';

export const SKIP_REASONS: readonly ChatSkipReason[] = [
  'bot',
  'webhook',
  'system',
  'command',
  'attachment-only',
  'empty',
  'relay-echo',
];

/** The 來源 column. */
export const SOURCE_LABEL: Record<ChatPlatform, string> = {
  discord: 'Discord',
  line: 'LINE',
  lobby: '網站',
  relay: '同步',
};

export interface KeptMessage {
  kind: 'keep';
  id: string;
  channelId: string;
  createdAt: number;
  speakerKey: string;
  platform: ChatPlatform;
  text: string;
  attachments: number;
}

export interface SkippedMessage {
  kind: 'skip';
  reason: ChatSkipReason;
  attachments: number;
}

// ─── Relay parsing ───────────────────────────────────────────────────────

export interface ParsedRelay {
  tag: 'LINE' | 'AP' | 'DC' | 'legacy';
  name: string;
  body: string;
}

/**
 * `[MMDD hh:mm][TAG][name] body` — ChatMirror.formatOutgoingUnified() always
 * writes exactly one space after the name, so the name ends at the first "] "
 * (or at the end of the message when the body is empty). That keeps names
 * that contain "]" — e.g. "[TW]小明" — whole instead of leaking part of the
 * name into the body and merging different people into one pseudonym.
 * Only a name that itself contains "] " is still ambiguous.
 */
const UNIFIED_RELAY_RE = /^\[\d{4} \d{2}:\d{2}\]\[(LINE|AP|DC)\]\[(.*?)\](?: ([\s\S]*))?$/;
/** `[Avalon] name: body` — ChatMirror.formatOutgoingLegacy(). */
const LEGACY_RELAY_RE = /^\[Avalon\] ([^\n:]{1,60}): ([\s\S]*)$/;

export function parseRelayLine(content: string): ParsedRelay | null {
  const text = content ?? '';
  const u = UNIFIED_RELAY_RE.exec(text);
  if (u) return { tag: u[1] as ParsedRelay['tag'], name: u[2].trim(), body: u[3] ?? '' };
  const l = LEGACY_RELAY_RE.exec(text);
  if (l) return { tag: 'legacy', name: l[1].trim(), body: l[2] };
  return null;
}

/** "/戰績 …", "／意見 …", "!avalon …": a command typed as text, not conversation. */
export function isTypedCommand(text: string): boolean {
  const t = text.trim();
  return /^[/／]\S/u.test(t) || /^!avalon\b/i.test(t);
}

const RELAY_PLATFORM: Record<Exclude<ParsedRelay['tag'], 'DC'>, ChatPlatform> = {
  LINE: 'line',
  AP: 'lobby',
  legacy: 'relay',
};

export function classifyMessage(m: RawChatMessage): KeptMessage | SkippedMessage {
  const attachments = Math.max(0, m.attachmentCount | 0);
  const skip = (reason: ChatSkipReason): SkippedMessage => ({ kind: 'skip', reason, attachments });
  if (m.system) return skip('system');
  if (m.webhookId) return skip('webhook');

  let platform: ChatPlatform = 'discord';
  let speakerKey = `discord:${m.authorId}`;
  let body = m.content ?? '';

  if (m.authorIsBot) {
    if (!m.authorIsSelf) return skip('bot');
    const relay = parseRelayLine(body);
    if (!relay) return skip('bot'); // the bot's own posts: digests, command replies, notices
    if (relay.tag === 'DC') return skip('relay-echo');
    if (relay.tag === 'AP' && relay.name === 'system') return skip('system');
    platform = RELAY_PLATFORM[relay.tag];
    speakerKey = `${platform}:${relay.name || '?'}`;
    body = relay.body;
  }

  const text = body.trim();
  if (!text) return skip(attachments > 0 ? 'attachment-only' : 'empty');
  if (isTypedCommand(text)) return skip('command');
  return { kind: 'keep', id: m.id, channelId: m.channelId, createdAt: m.createdAt, speakerKey, platform, text, attachments };
}

// ─── Pseudonyms ──────────────────────────────────────────────────────────

/** 成員1, 成員2, … in order of first appearance. Keys never leave the instance. */
export class Pseudonymizer {
  private readonly ids = new Map<string, number>();

  label(key: string): string {
    let n = this.ids.get(key);
    if (n === undefined) {
      n = this.ids.size + 1;
      this.ids.set(key, n);
    }
    return `成員${n}`;
  }

  get size(): number {
    return this.ids.size;
  }
}

/** Replace Discord mention markup so no raw user id reaches the sheet. */
export function rewriteMentions(text: string, pseudo: Pseudonymizer, channelNames: Map<string, string>): string {
  return text
    .replace(/<@!?(\d+)>/g, (_m, id: string) => `@${pseudo.label(`discord:${id}`)}`)
    .replace(/<@&\d+>/g, '@某身分組')
    .replace(/<#(\d+)>/g, (_m, id: string) => `#${channelNames.get(id) ?? '某頻道'}`)
    .replace(/<a?:([A-Za-z0-9_~]+):\d+>/g, ':$1:');
}

/** Newlines → " ⏎ " (one line per row, easy to read as CSV), then cut to `max` code points. */
export function clipMessageText(text: string, max: number = CHAT_EXPORT_MESSAGE_MAX_CHARS): string {
  const oneLine = text.replace(/\s*\r?\n\s*/g, ' ⏎ ').trim();
  const chars = Array.from(oneLine);
  if (chars.length <= max) return oneLine;
  return chars.slice(0, max).join('') + '…（後略）';
}

// ─── Rows ────────────────────────────────────────────────────────────────

export type ChatExportRow = [week: string, time: string, channel: string, source: string, speaker: string, content: string];

export interface ChatExportRows {
  /** One row per kept message, oldest first. */
  rows: ChatExportRow[];
  /** Channels with at least one row. */
  channels: number;
  /** Distinct speakers among the rows. */
  speakers: number;
  skipped: Record<ChatSkipReason, number>;
  byPlatform: Record<ChatPlatform, number>;
}

export function buildExportRows(messages: RawChatMessage[], channels: ChatChannel[], weekKey: string): ChatExportRows {
  const skipped = Object.fromEntries(SKIP_REASONS.map((r) => [r, 0])) as Record<ChatSkipReason, number>;
  const byPlatform: Record<ChatPlatform, number> = { discord: 0, line: 0, lobby: 0, relay: 0 };
  const kept: KeptMessage[] = [];
  const seen = new Set<string>();
  for (const m of messages) {
    if (seen.has(m.id)) continue; // the same message read twice (defensive)
    seen.add(m.id);
    const c = classifyMessage(m);
    if (c.kind === 'skip') skipped[c.reason] += 1;
    else kept.push(c);
  }
  kept.sort((a, b) => a.createdAt - b.createdAt || (a.id.length - b.id.length) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const channelNames = new Map(channels.map((ch) => [ch.id, ch.name]));
  const pseudo = new Pseudonymizer();
  const speakers = new Set<string>();
  const usedChannels = new Set<string>();
  const rows = kept.map((k): ChatExportRow => {
    speakers.add(k.speakerKey);
    usedChannels.add(k.channelId);
    byPlatform[k.platform] += 1;
    const speaker = pseudo.label(k.speakerKey);
    const body = clipMessageText(rewriteMentions(k.text, pseudo, channelNames));
    const extra = k.attachments > 0 ? `〔附件 ${k.attachments}〕` : '';
    return [weekKey, taipeiStamp(k.createdAt), channelNames.get(k.channelId) ?? '某頻道', SOURCE_LABEL[k.platform], speaker, `${body}${extra}`];
  });

  return { rows, channels: usedChannels.size, speakers: speakers.size, skipped, byPlatform };
}
