/**
 * Player-name lookup shared by the /戰績 /默契 bots (LINE + Discord) and the
 * website's player search (2026-10-13 players' report: a player's usual
 * nickname is part of his registered name, and looking him up found nothing).
 *
 * `names` are the analysis-cache spellings (the 牌譜 names — case matters there:
 * Abc / ABC / abc are three records) in priority order, e.g. most games first;
 * candidate lists keep that order.
 *
 *   1. exact — as typed, then cleaned (cleanNameQuery: a leading @, surrounding
 *      quotes / brackets, trailing punctuation and zero-width characters dropped,
 *      spaces collapsed)
 *   2. case- / width-insensitive (NFKC + lower case): one hit wins, several are
 *      ambiguous (the case variants of one name)
 *   3. the same ignoring spaces and separators (compactName: "Quill Fen" = "quillfen")
 *   4. substring of the name (normalized, then compact): one hit wins, several
 *      are ambiguous — at most MAX_NAME_CANDIDATES listed, `total` says how many
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
      /** Other names that differ only by case (the sheet has e.g. Abc / ABC / abc). */
      caseVariants: string[];
    }
  | { kind: 'ambiguous'; query: string; candidates: string[]; total: number }
  | { kind: 'none'; query: string; suggestions?: string[] };

/** NFKC folds full-width letters (ＡＢＣ → ABC); then case-fold. */
export function normalizeName(s: string): string {
  return (s ?? '').normalize('NFKC').trim().toLowerCase();
}

const SEPARATORS_RE = /[\s·・．.\-_'’"＿]+/gu;

/** normalizeName without spaces and separators: "Quill Fen" / "quill_fen" / "Quill·Fen" → "quillfen". */
export function compactName(s: string): string {
  return normalizeName(s).replace(SEPARATORS_RE, '');
}

const ZERO_WIDTH_RE = /[​‌‍⁠﻿]/gu;
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

function pick(hits: string[], query: string): NameMatch | null {
  if (hits.length === 1) return { kind: 'found', name: hits[0], caseVariants: [] };
  if (hits.length > 1) {
    return { kind: 'ambiguous', query, candidates: hits.slice(0, MAX_NAME_CANDIDATES), total: hits.length };
  }
  return null;
}

/** Resolve a typed name against `names` (see the module comment for the order). */
export function matchPlayerName(query: string, names: readonly string[]): NameMatch {
  const typed = (query ?? '').trim();
  const cleaned = cleanNameQuery(typed);
  if (!cleaned) return { kind: 'none', query: typed };

  const sameCase = (name: string): string[] =>
    names.filter((n) => n !== name && normalizeName(n) === normalizeName(name));

  for (const q of typed === cleaned ? [typed] : [typed, cleaned]) {
    if (q && names.includes(q)) return { kind: 'found', name: q, caseVariants: sameCase(q) };
  }

  const nq = normalizeName(cleaned);
  const cq = compactName(cleaned);
  const unique = <T>(xs: T[]): T[] => Array.from(new Set(xs));

  const steps: Array<(n: string) => boolean> = [
    (n) => normalizeName(n) === nq,
    (n) => cq !== '' && compactName(n) === cq,
    (n) => normalizeName(n).includes(nq),
    (n) => cq !== '' && compactName(n).includes(cq),
  ];
  for (const test of steps) {
    const found = pick(unique(names.filter(test)), typed);
    if (found) return found;
  }

  const suggestions =
    Array.from(cq).length >= 2 ? unique(names.filter((n) => isSubsequence(cq, compactName(n)))).slice(0, MAX_NAME_CANDIDATES) : [];
  return suggestions.length > 0 ? { kind: 'none', query: typed, suggestions } : { kind: 'none', query: typed };
}
