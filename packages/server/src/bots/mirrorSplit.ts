/**
 * Long messages between LINE and Discord (2026-10-13, player report: a
 * ~400-character multi-line Discord message reached the LINE group cut off).
 *
 * The relay now carries the WHOLE text. A message is split only when a
 * platform limit requires it:
 *
 *   LINE text message      ≤ 5000 characters (LINE_TEXT_MAX_CHARS)
 *   Discord message        ≤ 2000 characters (DISCORD_MESSAGE_MAX_CHARS)
 *
 * Lengths are counted in UTF-16 code units (JS `string.length`), which is
 * never less than the character count either platform uses, so a part that
 * fits here fits there. The first part keeps the speaker prefix
 * (`[MMDD hh:mm][LINE][名字] `); every later part starts with
 * MIRROR_CONTINUATION_MARKER instead. Splits fall on a line break where one
 * exists in the second half of the room, else on a space, else after
 * sentence punctuation, else at the limit (never inside a surrogate pair).
 * The line break or space a split falls on starts the next part, right after
 * the marker (「（續）」 then a new line), so the parts lose nothing: the
 * bodies concatenated are exactly the text (review fix 2026-10-13 — the
 * chat-log export joins them back that way).
 *
 * Pure functions, no I/O — chatExport/rows.ts reads the marker too (it joins
 * the parts back into one row).
 */

/** LINE Messaging API: a text message holds at most 5000 characters. */
export const LINE_TEXT_MAX_CHARS = 5000;

/** Discord: message content holds at most 2000 characters. */
export const DISCORD_MESSAGE_MAX_CHARS = 2000;

/** Start of the 2nd, 3rd… part of a split message (in place of the speaker prefix). */
export const MIRROR_CONTINUATION_MARKER = '（續）';

/**
 * Backstop for one relayed text. Discord sends at most 4000 (Nitro); a LINE
 * user's message may be longer than the 5000 a bot can send (the app allows
 * more), and is then simply more Discord parts. Nothing realistic reaches
 * this cap.
 */
export const MIRROR_TEXT_MAX_CHARS = 20_000;

/** Characters after which a split may fall when a text has no line break or space. */
const BREAK_AFTER = new Set(['。', '！', '？', '!', '?', '；', ';', '，', ',', '、', '…']);

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** First `max` UTF-16 units of `text`, one less when that would split a surrogate pair. */
export function cutUnits(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = Math.max(0, max);
  if (end > 0 && isHighSurrogate(text.charCodeAt(end - 1))) end -= 1;
  return text.slice(0, end);
}

/**
 * Length (≥ 1, ≤ `room`) of the first piece when `text` is split so that
 * piece holds at most `room` units. The rest starts right there — with the
 * line break or space the split falls on — so nothing is dropped.
 */
function splitPoint(text: string, room: number): number {
  const min = Math.max(1, Math.floor(room / 2));
  const nl = text.lastIndexOf('\n', room);
  if (nl >= min) {
    const end = text[nl - 1] === '\r' ? nl - 1 : nl;
    if (end >= 1) return end;
  }
  for (let i = Math.min(room, text.length - 1); i >= min; i -= 1) {
    if (/\s/.test(text[i])) return i;
  }
  for (let i = Math.min(room, text.length) - 1; i >= min - 1; i -= 1) {
    if (BREAK_AFTER.has(text[i])) return i + 1;
  }
  return Math.max(1, cutUnits(text, room).length);
}

/**
 * `prefix + body` as one or more messages of at most `maxChars` units each:
 * the first starts with `prefix`, the others with `marker`. Returns exactly
 * `[prefix + body]` when that fits (today's single message, unchanged).
 * Order is the reading order; nothing of `body` is lost — the parts without
 * their prefix / marker, concatenated, are exactly `body`.
 */
export function splitMirrorText(
  prefix: string,
  body: string,
  maxChars: number,
  marker: string = MIRROR_CONTINUATION_MARKER,
): string[] {
  if (prefix.length + body.length <= maxChars) return [prefix + body];
  // A prefix can never take more than half a message (display names are short;
  // this only guards against a pathological one).
  const half = Math.floor(maxChars / 2);
  let lead = prefix.length > half ? cutUnits(prefix, half) : prefix;
  const parts: string[] = [];
  let rest = body;
  while (rest.length > 0) {
    const room = Math.max(1, maxChars - lead.length);
    if (rest.length <= room) {
      parts.push(lead + rest);
      break;
    }
    const end = splitPoint(rest, room);
    parts.push(lead + rest.slice(0, end));
    rest = rest.slice(end);
    lead = marker;
  }
  return parts.length > 0 ? parts : [lead];
}

/**
 * Last-resort guard for one LINE text message object: a text over
 * LINE_TEXT_MAX_CHARS would make LINE refuse the WHOLE reply, and the
 * re-queue rule would then send the same batch forever. Everything queued is
 * already split, so this only ever fires on a bug.
 */
export function clampLineText(text: string): string {
  if (text.length <= LINE_TEXT_MAX_CHARS) return text;
  return `${cutUnits(text, LINE_TEXT_MAX_CHARS - 1)}…`;
}
