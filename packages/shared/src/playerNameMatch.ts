/**
 * Player-name lookup shared by the /戰績 /默契 bots (LINE + Discord), the
 * website's player search and the stats API (/api/analysis/players/:name,
 * /api/analysis/profile/:name/*) (2026-10-13 players' reports: a player's usual
 * nickname is part of his registered name and looking him up found nothing;
 * one player was split into Abc / ABC / abc).
 *
 * Who a player is — playerNameKey — is the rule generate_cache.py merges players
 * by (player_name_key): NFKC (full-width ＡＢＣ / １２３ → half-width), zero-width
 * characters dropped, whitespace trimmed and collapsed, lower-cased. Names with one
 * key are ONE player: the cache has one row for them (its most-used spelling),
 * an older cache may still list Abc / ABC / abc separately — then the first of
 * them in `names` stands for the player and the others are its `caseVariants`.
 *
 * `names` are the analysis-cache spellings in priority order, e.g. most games
 * first; candidate lists keep that order.
 *
 *   1. exact — as typed, then cleaned (cleanNameQuery: a leading @, surrounding
 *      quotes / brackets, trailing punctuation and zero-width characters dropped,
 *      spaces collapsed)
 *   2. the same player: same playerNameKey (case, full/half width, zero-width,
 *      spacing ignored) — the first such name (findSamePlayerName)
 *   3. the same ignoring spaces and separators too (compactName: "Quill Fen" = "quillfen")
 *   4. substring of the name (key, then compact)
 *   At 3 and 4 one player wins and several are ambiguous: one candidate per
 *   player, at most MAX_NAME_CANDIDATES listed, `total` says how many players.
 *   5. none — with up to MAX_NAME_CANDIDATES `suggestions` whose name holds
 *      every character of the query in order (e.g. a nickname that skips a
 *      character); never picked automatically
 *
 * Pure, no dependencies.
 */

/** Max candidates / suggestions listed when a name matches several players. */
export const MAX_NAME_CANDIDATES = 5;

export type NameMatch =
  | {
      kind: 'found';
      name: string;
      /**
       * Other names of the same player (same playerNameKey: Abc / ABC / abc). Only a cache
       * written before generate_cache.py merged such names has them.
       */
      caseVariants: string[];
    }
  | { kind: 'ambiguous'; query: string; candidates: string[]; total: number }
  | { kind: 'none'; query: string; suggestions?: string[] };

// Alternations / escapes, not literal characters in a class (U+200D in a class trips
// eslint no-misleading-character-class).
const ZERO_WIDTH_RE = /\u200b|\u200c|\u200d|\u2060|\ufeff/gu;
// Python's str.split() whitespace (generate_cache.py): JS \s plus U+001C..U+001F and U+0085.
// eslint-disable-next-line no-control-regex
const WHITESPACE_RE = /[\s\u001c-\u001f\u0085]+/u;

/**
 * Who a player is (generate_cache.py player_name_key, the same rule): NFKC, zero-width
 * characters dropped, whitespace trimmed and collapsed to single spaces, lower-cased.
 * "Nova", "NOVA", " nova " and "ｎｏｖａ" → "nova".
 */
export function playerNameKey(s: string): string {
  return (s ?? '')
    .normalize('NFKC')
    .replace(ZERO_WIDTH_RE, '')
    .split(WHITESPACE_RE)
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/** The name as the matcher compares it: playerNameKey. */
export function normalizeName(s: string): string {
  return playerNameKey(s);
}

const SEPARATORS_RE = /[\s·・．.\-_'’"＿]+/gu;

/** normalizeName without spaces and separators: "Quill Fen" / "quill_fen" / "Quill·Fen" → "quillfen". */
export function compactName(s: string): string {
  return normalizeName(s).replace(SEPARATORS_RE, '');
}

const BRACKETS: ReadonlyArray<readonly [string, string]> = [
  ['「', '」'], ['『', '』'], ['“', '”'], ['"', '"'], ["'", "'"], ['‘', '’'],
  ['(', ')'], ['（', '）'], ['<', '>'], ['〈', '〉'], ['《', '》'], ['[', ']'], ['【', '】'],
];
const TRAILING_PUNCT_RE = /[?？!！。.,，、~～:：;；]+$/u;

/**
 * What the user most likely meant as the name: zero-width characters, a leading
 * @ / ＠ (a LINE / Discord mention typed by hand), surrounding quotes or brackets
 * and trailing punctuation removed; inner spaces collapsed.
 */
export function cleanNameQuery(raw: string): string {
  let s = (raw ?? '').replace(ZERO_WIDTH_RE, '').replace(/\s+/gu, ' ').trim();
  for (let changed = true; changed && s; ) {
    changed = false;
    const before = s;
    s = s.replace(/^[@＠]+/u, '').trim();
    s = s.replace(TRAILING_PUNCT_RE, '').trim();
    for (const [open, close] of BRACKETS) {
      if (s.length >= 2 && s.startsWith(open) && s.endsWith(close)) {
        s = s.slice(open.length, s.length - close.length).trim();
      }
    }
    changed = s !== before;
  }
  return s;
}

function isSubsequence(needle: string, haystack: string): boolean {
  const h = Array.from(haystack);
  let i = 0;
  for (const ch of needle) {
    while (i < h.length && h[i] !== ch) i += 1;
    if (i >= h.length) return false;
    i += 1;
  }
  return true;
}

/** `names` reduced to one name per player (playerNameKey), the first of each kept, in order. */
function onePerPlayer(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of names) {
    const key = playerNameKey(n);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out;
}

/** The other names of `name`'s player in `names` (same playerNameKey), in order. */
function otherSpellings(name: string, names: readonly string[]): string[] {
  const key = playerNameKey(name);
  return names.filter((n) => n !== name && playerNameKey(n) === key);
}

/** The typed query, then its cleaned form when that differs (both trimmed; no empties). */
function queryForms(query: string): string[] {
  const typed = (query ?? '').trim();
  const cleaned = cleanNameQuery(typed);
  return [typed, cleaned].filter((q, i, all) => q !== '' && all.indexOf(q) === i);
}

/**
 * The name in `names` that IS this player — stages 1–2 of matchPlayerName, never a partial
 * name: `name` itself (as typed, then cleaned) when listed, else a name with the same
 * playerNameKey. Several of those (an older cache's Nova / NOVA / nova): the highest `rank`
 * (e.g. games played), else the first in `names`. The stats API looks players up with this.
 */
export function findSamePlayerName(
  name: string,
  names: readonly string[],
  rank?: (name: string) => number,
): string | undefined {
  if (typeof name !== 'string') return undefined;
  const forms = queryForms(name);
  for (const q of forms) {
    if (names.includes(q)) return q;
  }
  for (const q of forms) {
    const key = playerNameKey(q);
    if (!key) continue;
    const same = names.filter((n) => playerNameKey(n) === key);
    if (same.length === 0) continue;
    if (!rank || same.length === 1) return same[0];
    return same.reduce((best, n) => (rank(n) > rank(best) ? n : best));
  }
  return undefined;
}

/** Resolve a typed name against `names` (see the module comment for the order). */
export function matchPlayerName(query: string, names: readonly string[]): NameMatch {
  const typed = (query ?? '').trim();
  const cleaned = cleanNameQuery(typed);
  if (!cleaned) return { kind: 'none', query: typed };

  // 1–2: this very player (one player even when an older cache spells him several ways).
  const same = findSamePlayerName(typed, names);
  if (same !== undefined) return { kind: 'found', name: same, caseVariants: otherSpellings(same, names) };

  // 3–4: ignoring separators, then part of the name; one candidate per player.
  const nq = normalizeName(cleaned);
  const cq = compactName(cleaned);
  const steps: Array<(n: string) => boolean> = [
    (n): boolean => cq !== '' && compactName(n) === cq,
    (n): boolean => normalizeName(n).includes(nq),
    (n): boolean => cq !== '' && compactName(n).includes(cq),
  ];
  for (const test of steps) {
    const players = onePerPlayer(names.filter(test));
    if (players.length === 1) {
      return { kind: 'found', name: players[0], caseVariants: otherSpellings(players[0], names) };
    }
    if (players.length > 1) {
      return { kind: 'ambiguous', query: typed, candidates: players.slice(0, MAX_NAME_CANDIDATES), total: players.length };
    }
  }

  const suggestions =
    Array.from(cq).length >= 2
      ? onePerPlayer(names.filter((n) => isSubsequence(cq, compactName(n)))).slice(0, MAX_NAME_CANDIDATES)
      : [];
  return suggestions.length > 0 ? { kind: 'none', query: typed, suggestions } : { kind: 'none', query: typed };
}
