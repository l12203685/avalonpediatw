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
 * 論點層級標記（Edward 2026-10-30：文章要恆久正確 — 每個論點標明是規則事實／邏輯必然／經驗法則／社群慣例／時效資料）。
 * 文章裡寫 `【規則】` 等，渲染成小標籤（WikiContent 的 a 元件看 `wiki-tag:` 開頭）。
 */
export const WIKI_TAG_SCHEME = 'wiki-tag:';
export const WIKI_TAGS: Readonly<Record<string, { label: string; hint: string }>> = {
  rule: { label: '規則', hint: '規則事實：遊戲規則直接規定的事' },
  logic: { label: '邏輯', hint: '邏輯必然：從規則與已知資訊一定推得出來' },
  exp: { label: '經驗', hint: '經驗法則：多數情況成立，但有例外' },
  conv: { label: '慣例', hint: '社群慣例：本站／社群約定的做法' },
  time: { label: '時效', hint: '時效資料：特定時間點的紀錄或數據' },
  stance: { label: '本站立場', hint: '本站立場：站方的裁定' },
};
const TAG_BY_LABEL: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(WIKI_TAGS).map(([k, v]) => [v.label, k]));

/** `【規則】` → `[規則](wiki-tag:rule)`（不在行內程式碼或程式碼區塊裡時）。 */
function layerTags(line: string): string {
  return line.replace(/【(規則|邏輯|經驗|慣例|時效|本站立場)】/g, (_m, label: string) => ` [${label}](${WIKI_TAG_SCHEME}${TAG_BY_LABEL[label]})`);
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
function stripHackmdArtifacts(content: string): string {
  return content
    .replace(/^(?:\s*---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$))+/, '')
    .replace(/^[ \t]*\[TOC\][ \t]*\r?\n?/gim, '');
}

/**
 * `<!-- … -->`: text the authors commented out in HackMD (old drafts, sign-up lists). HackMD hides it; the site
 * doesn't parse HTML, so without this it was printed as text (Edward 2026-10-29 百科整併時看到).
 */
function stripHtmlComments(content: string): string {
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
