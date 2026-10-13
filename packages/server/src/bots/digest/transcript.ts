/**
 * Transcript for the weekly community digest — pure functions, no I/O.
 *
 * Input: Discord messages reduced to the fields below (collector.ts). Output:
 * one line per message, grouped by channel,
 *
 *   [10/05 21:33] 成員3: 這週排行怎麼沒更新
 *   [10/05 21:35] 成員7（LINE）: 我也看到了
 *
 * Speakers are replaced by 成員N, numbered per run in order of first
 * appearance; the mapping lives only inside one buildTranscript() call and
 * is never returned, sent or logged.
 *
 * How LINE shows up here: the bot relays LINE group lines (and website
 * lobby lines) into the Discord sync channel as ITS OWN messages, formatted
 * by ChatMirror.formatOutgoingUnified():
 *
 *   [1005 21:35][LINE][小明] 我也看到了      → speaker "line:小明", platform line
 *   [1005 21:36][AP][阿華] 網站上看得到       → speaker "lobby:阿華", platform lobby
 *   [1005 21:37][DC][…] …                    → a Discord line echoed outward; never
 *                                              expected in Discord, skipped as a duplicate
 *   [Avalon] 名字: 內容 (legacy format, CHAT_MIRROR_USE_LEGACY_FORMAT=true) → platform relay
 *
 * Every other message by the bot (stats digest, slash-command replies, this
 * digest) is skipped, as are other bots, webhooks, Discord system messages,
 * typed commands ("/戰績 …", also when relayed from LINE) and messages with
 * no text (attachment-only ones are counted).
 */

import { DIGEST_MESSAGE_MAX_CHARS } from './config';
import { stampMMDDHHmm } from './window';

export interface DigestRawMessage {
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

export interface DigestChannel {
  id: string;
  name: string;
  /** The LINE↔Discord sync channel (LOBBY_MIRROR_DISCORD_CHANNEL_ID). */
  isMirror: boolean;
}

export type DigestPlatform = 'discord' | 'line' | 'lobby' | 'relay';

export type DigestSkipReason =
  | 'bot'
  | 'webhook'
  | 'system'
  | 'command'
  | 'attachment-only'
  | 'empty'
  | 'relay-echo';

export const SKIP_REASONS: readonly DigestSkipReason[] = [
  'bot',
  'webhook',
  'system',
  'command',
  'attachment-only',
  'empty',
  'relay-echo',
];

export interface KeptMessage {
  kind: 'keep';
  id: string;
  channelId: string;
  createdAt: number;
  speakerKey: string;
  platform: DigestPlatform;
  text: string;
  attachments: number;
}

export interface SkippedMessage {
  kind: 'skip';
  reason: DigestSkipReason;
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

const RELAY_PLATFORM: Record<Exclude<ParsedRelay['tag'], 'DC'>, DigestPlatform> = {
  LINE: 'line',
  AP: 'lobby',
  legacy: 'relay',
};

export function classifyMessage(m: DigestRawMessage): KeptMessage | SkippedMessage {
  const attachments = Math.max(0, m.attachmentCount | 0);
  const skip = (reason: DigestSkipReason): SkippedMessage => ({ kind: 'skip', reason, attachments });
  if (m.system) return skip('system');
  if (m.webhookId) return skip('webhook');

  let platform: DigestPlatform = 'discord';
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

const PLATFORM_SUFFIX: Record<DigestPlatform, string> = {
  discord: '',
  line: '（LINE）',
  lobby: '（網站）',
  relay: '（同步）',
};

/** Replace Discord mention markup so no raw user id reaches the model. */
export function rewriteMentions(text: string, pseudo: Pseudonymizer, channelNames: Map<string, string>): string {
  return text
    .replace(/<@!?(\d+)>/g, (_m, id: string) => `@${pseudo.label(`discord:${id}`)}`)
    .replace(/<@&\d+>/g, '@某身分組')
    .replace(/<#(\d+)>/g, (_m, id: string) => `#${channelNames.get(id) ?? '某頻道'}`)
    .replace(/<a?:([A-Za-z0-9_~]+):\d+>/g, ':$1:');
}

/**
 * "<" and ">" → full-width "＜" "＞" so chat text can never open or close the
 * <chat_log> frame (or fake any other tag) in the prompt. Applied after
 * rewriteMentions(), which needs the "<@id>" markup.
 */
export function neutralizeTags(text: string): string {
  return text.replace(/</g, '＜').replace(/>/g, '＞');
}

/** Newlines → " ⏎ " (one line per message), then cut to `max` code points. */
export function clipMessageText(text: string, max: number = DIGEST_MESSAGE_MAX_CHARS): string {
  const oneLine = text.replace(/\s*\r?\n\s*/g, ' ⏎ ').trim();
  const chars = Array.from(oneLine);
  if (chars.length <= max) return oneLine;
  return chars.slice(0, max).join('') + '…（後略）';
}

// ─── Transcript ──────────────────────────────────────────────────────────

export interface DigestTranscript {
  /** Channel sections with one line per message; '' when nothing was kept. */
  text: string;
  /** Messages in `text`. */
  included: number;
  /** Conversation messages left out by the size cap (always the oldest ones). */
  omitted: number;
  /** createdAt of the newest omitted message, or null. */
  omittedThrough: number | null;
  /** Channels with at least one included message. */
  channels: number;
  /** Distinct speakers among kept messages. */
  speakers: number;
  skipped: Record<DigestSkipReason, number>;
  /** Attachments on kept messages plus attachment-only messages. */
  attachments: number;
  byPlatform: Record<DigestPlatform, number>;
}

function channelHeader(ch: DigestChannel | undefined): string {
  if (!ch) return '## #某頻道';
  return `## #${neutralizeTags(ch.name)}${ch.isMirror ? '（LINE↔Discord 同步頻道：也包含 LINE 群與網站大廳轉貼過來的發言）' : ''}`;
}

export function buildTranscript(
  messages: DigestRawMessage[],
  channels: DigestChannel[],
  opts: { maxChars: number },
): DigestTranscript {
  const skipped = Object.fromEntries(SKIP_REASONS.map((r) => [r, 0])) as Record<DigestSkipReason, number>;
  const byPlatform: Record<DigestPlatform, number> = { discord: 0, line: 0, lobby: 0, relay: 0 };
  let attachments = 0;
  const kept: KeptMessage[] = [];
  for (const m of messages) {
    const c = classifyMessage(m);
    attachments += c.attachments;
    if (c.kind === 'skip') skipped[c.reason] += 1;
    else kept.push(c);
  }
  kept.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const channelById = new Map(channels.map((ch) => [ch.id, ch]));
  const channelNames = new Map(channels.map((ch) => [ch.id, ch.name]));
  const pseudo = new Pseudonymizer();
  const speakers = new Set<string>();
  const lines = kept.map((k) => {
    speakers.add(k.speakerKey);
    byPlatform[k.platform] += 1;
    const label = `${pseudo.label(k.speakerKey)}${PLATFORM_SUFFIX[k.platform]}`;
    const body = clipMessageText(neutralizeTags(rewriteMentions(k.text, pseudo, channelNames)));
    const extra = k.attachments > 0 ? `〔附件 ${k.attachments}〕` : '';
    return `[${stampMMDDHHmm(k.createdAt)}] ${label}: ${body}${extra}`;
  });

  // Keep the newest messages that fit; headers count toward the cap too.
  const headerCounted = new Set<string>();
  let used = 0;
  let firstIncluded = kept.length;
  for (let i = kept.length - 1; i >= 0; i -= 1) {
    const chId = kept[i].channelId;
    const headerCost = headerCounted.has(chId) ? 0 : channelHeader(channelById.get(chId)).length + 2;
    const cost = lines[i].length + 1 + headerCost;
    if (used + cost > opts.maxChars) break;
    used += cost;
    headerCounted.add(chId);
    firstIncluded = i;
  }

  const order: string[] = [];
  const grouped = new Map<string, string[]>();
  for (let i = firstIncluded; i < kept.length; i += 1) {
    const chId = kept[i].channelId;
    if (!grouped.has(chId)) {
      grouped.set(chId, []);
      order.push(chId);
    }
    (grouped.get(chId) as string[]).push(lines[i]);
  }
  const text = order
    .map((chId) => `${channelHeader(channelById.get(chId))}\n${(grouped.get(chId) as string[]).join('\n')}`)
    .join('\n\n');

  return {
    text,
    included: kept.length - firstIncluded,
    omitted: firstIncluded,
    omittedThrough: firstIncluded > 0 ? kept[firstIncluded - 1].createdAt : null,
    channels: order.length,
    speakers: speakers.size,
    skipped,
    attachments,
    byPlatform,
  };
}
