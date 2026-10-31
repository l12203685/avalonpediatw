/**
 * 百科文章的舊式 HTML（HackMD 時代留下的 `<font color=…>`、`<br>`）轉成網站自己的樣式（Edward 2026-10-28：
 * 「有幾篇用到 markdown 或 html 語法……應該要重新調整過」）。網站不解析原始 HTML（安全起見），所以這些標籤原本
 * 會被原樣印出來。
 *
 *   - `<font color=X>文字</font>` → `[文字](wiki-color:語意)`，由 WikiContent 的連結元件畫成有顏色的字
 *     （紅 = 強調／警告、藍 = 藍方相關、橘、青）；
 *   - 連續兩行以上「整行都是紅字」（標題或清單，例如點跳夾那篇的「注意！！！」）→ 警告框（`> ⚠️ …`）；
 *   - `<br>` → 換行；
 *   - HackMD 的殘留：開頭的 `---` 資料區塊（標題、標籤、最後編輯者）與 `[TOC]` 行不顯示。
 */

export type WikiColor = 'red' | 'blue' | 'orange' | 'teal';

export const WIKI_COLOR_SCHEME = 'wiki-color:';

/**
 * 論點層級標記（Edward 2026-10-31 定案，取代 10-30 的六種標記）：只剩兩種 —
 *   - 【邏輯】：規則寫明的事，以及由規則加上陣營目標（勝負條件）一定推得出來的事（舊的【規則】併入）；
 *   - 【經驗】：多場遊戲歸納出的傾向與建議，多數情況成立但有例外（舊的【建議】【慣例】【本站立場】【百科建議】併入）。
 * 舊的【時效】不再使用，標記直接拿掉。
 *
 * 顯示方式（Edward：「直接把標籤換掉」「tag 直接讓文字變色」）：標記本身不顯示，帶標記的那一行／那個清單項目整段
 * 變色（WikiContent：邏輯＝琥珀黃、經驗＝薄荷綠；紅、藍代表兩個陣營，不用），文章開頭放一行圖例。
 * 實作：`【邏輯】` → 空連結 `[](wiki-tag:logic)`，WikiContent 看到段落／清單項目／表格儲存格的直接內容裡有這種
 * 連結，就幫那一塊加上顏色。
 */
export const WIKI_TAG_SCHEME = 'wiki-tag:';
export type WikiLayer = 'logic' | 'exp';
export const WIKI_TAGS: Readonly<Record<WikiLayer, { label: string; color: string; hint: string }>> = {
  logic: { label: '邏輯', color: '黃字', hint: '規則寫明，或由規則與陣營目標一定推得出來' },
  exp: { label: '經驗', color: '綠字', hint: '多場遊戲常見的情況與建議，多數成立但有例外' },
};
/** 文章裡可能出現的標記文字 → 層級（舊標記過渡期照樣認得）；null = 拿掉不顯示。 */
const LAYER_OF_LABEL: Readonly<Record<string, WikiLayer | null>> = {
  邏輯: 'logic',
  規則: 'logic',
  經驗: 'exp',
  建議: 'exp',
  慣例: 'exp',
  本站立場: 'exp',
  百科建議: 'exp',
  時效: null,
};
const LAYER_MARK_RE = new RegExp(`【(${Object.keys(LAYER_OF_LABEL).join('|')})】`, 'g');

/** The layer a `wiki-tag:` href names, or null for any other href. */
export function wikiLayerOf(href: string | undefined): WikiLayer | null {
  if (!href?.startsWith(WIKI_TAG_SCHEME)) return null;
  const key = href.slice(WIKI_TAG_SCHEME.length);
  return key === 'logic' || key === 'exp' ? key : null;
}

/** `【邏輯】` → `[](wiki-tag:logic)`，`【時效】` → 拿掉（不在程式碼區塊裡時）。標記前後的空白原樣保留，清單縮排不受影響。 */
function layerTags(line: string): string {
  return line.replace(LAYER_MARK_RE, (_m, label: string) => {
    const layer = LAYER_OF_LABEL[label];
    return layer ? `[](${WIKI_TAG_SCHEME}${layer})` : '';
  });
}

/** For plain-text copies (llms.txt): old labels → `【邏輯】`／`【經驗】`, `【時效】` dropped; the marker stays as text. */
export function canonicalLayerMarks(line: string): string {
  return line.replace(LAYER_MARK_RE, (_m, label: string) => {
    const layer = LAYER_OF_LABEL[label];
    return layer ? `【${WIKI_TAGS[layer].label}】` : '';
  });
}

/** One-line summaries (llms.txt): markers removed altogether. */
export function stripLayerMarks(text: string): string {
  return text.replace(LAYER_MARK_RE, '');
}

/** Whether normalized markup carries any layer marker (WikiContent then shows the color legend). */
export function hasWikiLayers(normalized: string): boolean {
  return normalized.includes(`](${WIKI_TAG_SCHEME}`);
}

/** The bits of a hast node (react-markdown's `node` prop) that `wikiBlockLayer` reads. */
export interface WikiHastNode {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: { href?: unknown };
  children?: WikiHastNode[];
}

/**
 * The layer a block (段落、清單項目、表格儲存格) carries: a `wiki-tag:` marker among its own content — for a list
 * item also inside its direct paragraphs (loose lists), never inside its nested lists, which color themselves.
 * `alone` = the block has nothing but the marker (e.g. a table cell that names the marker): WikiContent then shows
 * the label itself in the layer's color instead of an empty block.
 */
export function wikiBlockLayer(node: WikiHastNode | undefined): { layer: WikiLayer; alone: boolean } | null {
  if (!node?.children) return null;
  let layer: WikiLayer | null = null;
  let otherContent = false;
  const scan = (children: WikiHastNode[], descendIntoP: boolean): void => {
    for (const c of children) {
      if (c.type === 'text') {
        if (c.value?.trim()) otherContent = true;
      } else if (c.type === 'element') {
        const markLayer = c.tagName === 'a' ? wikiLayerOf(typeof c.properties?.href === 'string' ? c.properties.href : undefined) : null;
        if (markLayer) layer ??= markLayer;
        else if (descendIntoP && c.tagName === 'p') scan(c.children ?? [], false);
        else if (c.tagName !== 'ul' && c.tagName !== 'ol') otherContent = true;
      }
    }
  };
  scan(node.children, node.tagName === 'li');
  return layer ? { layer, alone: !otherContent } : null;
}

const COLOR_OF: Record<string, WikiColor> = {
  ff0000: 'red', '0000ff': 'blue', ff8000: 'orange', '008080': 'teal',
};

function colorOf(raw: string): WikiColor {
  return COLOR_OF[raw.replace(/^#/, '').toLowerCase()] ?? 'red';
}

const FONT_RE = /<font\s+color\s*=\s*["']?([#0-9a-zA-Z]+)["']?\s*>([\s\S]*?)<\/font>/gi;
const LIST_OR_HEADING = /^(\s*(?:[*\-+]|\d+\.|#{1,6})\s+)(.*)$/;

/** A line whose whole body (after a list marker or heading hashes) is one red `<font>`. */
function wholeLineRed(line: string): { prefix: string; body: string } | null {
  const m = LIST_OR_HEADING.exec(line) ?? /^(\s*)(.*)$/.exec(line);
  if (!m) return null;
  const body = m[2].trim();
  const f = /^<font\s+color\s*=\s*["']?([#0-9a-zA-Z]+)["']?\s*>([\s\S]*)<\/font>$/i.exec(body);
  if (!f || colorOf(f[1]) !== 'red' || /<font/i.test(f[2])) return null;
  return { prefix: m[1], body: f[2] };
}

function inlineColors(text: string): string {
  return text.replace(FONT_RE, (_all, color: string, inner: string) => {
    const t = inner.trim();
    return t ? `[${t}](${WIKI_COLOR_SCHEME}${colorOf(color)})` : '';
  });
}

/** Leading HackMD front matter (`---` … `---`; the HackMD exports often carry two blocks) and `[TOC]` lines. */
export function stripHackmdArtifacts(content: string): string {
  return content
    .replace(/^(?:\s*---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$))+/, '')
    .replace(/^[ \t]*\[TOC\][ \t]*\r?\n?/gim, '');
}

/**
 * `<!-- … -->`: text the authors commented out in HackMD (old drafts, sign-up lists). HackMD hides it; the site
 * doesn't parse HTML, so without this it was printed as text (Edward 2026-10-29 百科整併時看到).
 */
export function stripHtmlComments(content: string): string {
  return content.replace(/[ \t]*<!--[\s\S]*?-->[ \t]*/g, '');
}

export function normalizeWikiMarkup(content: string): string {
  const lines = stripHtmlComments(stripHackmdArtifacts(content)).replace(/<br\s*\/?>/gi, '  \n').split('\n');
  const out: string[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    // A run of two or more whole-line red lines → one warning callout.
    let j = i;
    while (j < lines.length && wholeLineRed(lines[j])) j++;
    if (j - i >= 2) {
      lines.slice(i, j).forEach((l, k) => {
        const w = wholeLineRed(l)!;
        const text = w.body.replace(/\*\*/g, '').trim();
        if (k === 0 && /^\s*#/.test(w.prefix)) out.push(`> ⚠️ **${text}**`);
        else if (k === 0) out.push(`> ⚠️ ${text}`);
        else out.push(`> - ${text}`);
      });
      out.push('');
      i = j - 1;
      continue;
    }
    out.push(inFence ? lines[i] : layerTags(inlineColors(lines[i])));
    if (/^\s*(```|~~~)/.test(lines[i])) inFence = !inFence;
  }
  return out.join('\n');
}

/**
 * `[標題](wiki:wiki-57)`：連到另一篇百科文章（「延伸閱讀」、文中的「參閱」；Edward 2026-10-29 百科整併）。
 * WikiContent 在同一個文章視窗裡換成那篇，不開新分頁。
 */
export const WIKI_ARTICLE_SCHEME = 'wiki:';

/** The article id of a `wiki:` link, or null for any other href. */
export function wikiArticleId(href: string | undefined): string | null {
  if (!href?.startsWith(WIKI_ARTICLE_SCHEME)) return null;
  const id = href.slice(WIKI_ARTICLE_SCHEME.length).trim();
  return id || null;
}

/** react-markdown `urlTransform`: keep our color pseudo-links and article links, sanitize everything else the default way. */
export function wikiUrlTransform(url: string, fallback: (u: string) => string): string {
  return url.startsWith(WIKI_COLOR_SCHEME) || url.startsWith(WIKI_ARTICLE_SCHEME) || url.startsWith(WIKI_TAG_SCHEME) ? url : fallback(url);
}

/**
 * 文章裡的圖片放在網站自己的 public/wiki-images/（不再連 HackMD），內文寫成 `/wiki-images/<檔名>`。
 * 網站部署在子路徑（VITE_BASE，例如 /avalonpediatw/）時補上前綴；外部網址原樣不動。
 */
export function wikiImageSrc(src: string | undefined, base: string): string | undefined {
  if (!src || !src.startsWith('/') || src.startsWith('//')) return src;
  return base.replace(/\/+$/, '') + src;
}

/** A card excerpt in plain text: no front matter (`title: …` lines), no `[TOC]`, no HTML tags. */
/**
 * The card excerpt: the stored excerpt when it says something, else the opening prose of the article (most stored
 * excerpts are only the HackMD `title:` line, so the cards showed nothing).
 */
export function wikiCardExcerpt(excerpt: string, content: string): string {
  const stored = wikiExcerpt(excerpt);
  if (stored) return stored;
  const body = normalizeWikiMarkup(content)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^(#|```|>|\||-{3,}|\[TOC\])/i.test(l))
    .map((l) => l.replace(/^[*\-+]\s+|^\d+\.\s+/, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, ''))
    .join(' ');
  return body.length > 120 ? `${body.slice(0, 120)}…` : body;
}

export function wikiExcerpt(text: string): string {
  return stripHackmdArtifacts(text)
    .replace(/^\s*-{3,}\s*/, '')
    .replace(/^(?:\s*(?:title|tags|description|最後編輯日|最後編輯者)\s*[:：][^\n]*\n?)+/i, '')
    .replace(/<[^>]+>/g, '')
    .replace(/^\s*```[^\n]*$/gm, '') // code-fence lines (e.g. 「``` json」)
    .replace(/\[TOC\]/gi, '')
    .trim();
}
