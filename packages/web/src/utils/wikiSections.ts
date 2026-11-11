/**
 * 百科文章的章節錨點（2026-11-11 站長：文章太多，值得的就合併；被併入的文章成為主文的一節，舊連結要直接跳到那一節）。
 *
 *  - 每個標題（# ～ ######）都有一個錨點 = 標題文字的 slug（wikiHeadingSlug）：拿掉論點標記、連結與強調記號、
 *    ASCII 標點，空白換成「-」，中文與全形標點照留（例如「四、內黑的用途」→ `四、內黑的用途`）。同一篇裡重複的標題
 *    依序加 -2、-3。
 *  - 站內連結可以帶章節：`[標題](wiki:wiki-148#四、內黑的用途)`；網址列是 `#wiki=wiki-148&sec=<slug>`（utils/wikiHash.ts）。
 *  - WikiContent 用 rehypeWikiHeadingIds 把同一個 slug 寫進渲染出來的標題 id，打開文章時捲到那一節。
 *  - 文章裡「[標題](wiki:id)〈章節〉」的〈章節〉用 resolveWikiSection 對到標題（可以只寫開頭、可以省略「一、」「3.1」這類編號）。
 * 純函式，packages/server/src/__tests__/WebWikiSections.test.ts 測（web 沒有測試執行器）。
 */

const LAYER_MARK = /【(?:邏輯|規則|經驗|建議|慣例|本站立場|百科建議|時效)】/g;
const FRONT_MATTER = /^(?:\s*---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$))+/;
/** ASCII punctuation dropped from slugs ("-", "_" and "." stay). */
const SLUG_PUNCT = /[!"#$%&'()*+,/:;<=>?@[\\\]^`{|}~]/g;
/** Leading section numbers a citation may leave out: 「一、」「甲、」「3.1 」「4. 」. */
const SECTION_NUMBER = /^(?:[一二三四五六七八九十零甲乙丙丁]+、|\d+(?:\.\d+)*[.、]?\s*)/;

/** A heading's Markdown → its plain text (what the reader sees). */
export function wikiHeadingText(markdown: string): string {
  return markdown
    .replace(LAYER_MARK, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[*`]|~~/g, '')
    .trim();
}

/** Plain text → slug (shared by the Markdown side and the rendered side). */
export function wikiSlugify(text: string): string {
  return text
    .replace(SLUG_PUNCT, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

/** A heading's Markdown → its anchor slug (before de-duplication). */
export function wikiHeadingSlug(markdown: string): string {
  return wikiSlugify(wikiHeadingText(markdown)) || 'section';
}

export interface WikiHeading {
  level: number;
  /** The heading as written (Markdown). */
  text: string;
  /** Anchor, unique within the article. */
  slug: string;
}

/** Hands out unique slugs in document order: the second 「結論」 becomes 結論-2. */
export function createSlugger(): (base: string) => string {
  const seen = new Map<string, number>();
  return (base: string): string => {
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}-${n}`;
  };
}

/** Every ATX heading of an article (front matter and fenced code skipped), with its anchor. */
export function wikiHeadings(content: string, unique: (base: string) => string = createSlugger()): WikiHeading[] {
  const out: WikiHeading[] = [];
  let fence = false;
  for (const line of content.replace(FRONT_MATTER, '').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (m) out.push({ level: m[1].length, text: m[2], slug: unique(wikiHeadingSlug(m[2])) });
  }
  return out;
}

const squash = (s: string): string => wikiHeadingText(s).replace(/\s/g, '');
const unnumbered = (s: string): string => squash(wikiHeadingText(s).replace(SECTION_NUMBER, ''));

/**
 * The anchor a 〈章節〉 citation points at: an exact heading first, then one that only differs by its leading number,
 * then one the citation is the start of. null when nothing matches.
 */
export function resolveWikiSection(content: string, citation: string): string | null {
  const c = squash(citation);
  if (!c) return null;
  const heads = wikiHeadings(content);
  const tests: ((h: WikiHeading) => boolean)[] = [
    (h) => squash(h.text) === c,
    (h) => unnumbered(h.text) === c,
    (h) => squash(h.text).startsWith(c),
    (h) => unnumbered(h.text).startsWith(c),
  ];
  for (const test of tests) {
    const hit = heads.find(test);
    if (hit) return hit.slug;
  }
  return null;
}

/** Whether an article has a heading with this anchor. */
export function hasWikiSection(content: string, slug: string): boolean {
  return wikiHeadings(content).some((h) => h.slug === slug);
}

/** The bits of a hast tree the heading-id plugin touches. */
interface HastNode {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

function hastText(node: HastNode): string {
  if (node.type === 'text') return node.value ?? '';
  return (node.children ?? []).map(hastText).join('');
}

export interface WikiHeadingIdOptions {
  /**
   * Markdown rendered earlier in the same article as a separate tree (the role articles are split around the live
   * stats card): its headings count as already used, so a repeated heading after the split still gets the
   * -2 / -3 anchor wikiHeadings gives it for the whole article.
   */
  after?: string;
}

/**
 * rehype plugin: gives every rendered h1–h6 the same id wikiHeadings computes from the Markdown, so
 * `#wiki=<id>&sec=<slug>` can scroll to it.
 */
export function rehypeWikiHeadingIds(options?: WikiHeadingIdOptions): (tree: HastNode) => void {
  const after = options?.after ?? '';
  return (tree: HastNode): void => {
    const unique = createSlugger();
    if (after) wikiHeadings(after, unique);
    const walk = (node: HastNode): void => {
      if (node.type === 'element' && /^h[1-6]$/.test(node.tagName ?? '')) {
        node.properties = { ...(node.properties ?? {}), id: unique(wikiSlugify(hastText(node).trim()) || 'section') };
      }
      for (const c of node.children ?? []) walk(c);
    };
    walk(tree);
  };
}
