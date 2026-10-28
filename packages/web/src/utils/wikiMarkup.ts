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

/** Leading HackMD front matter (`---` … `---`) and `[TOC]` lines. */
function stripHackmdArtifacts(content: string): string {
  return content
    .replace(/^\s*---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/, '')
    .replace(/^[ \t]*\[TOC\][ \t]*\r?\n?/gim, '');
}

export function normalizeWikiMarkup(content: string): string {
  const lines = stripHackmdArtifacts(content).replace(/<br\s*\/?>/gi, '  \n').split('\n');
  const out: string[] = [];
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
    out.push(inlineColors(lines[i]));
  }
  return out.join('\n');
}

/** react-markdown `urlTransform`: keep our color pseudo-links, sanitize everything else the default way. */
export function wikiUrlTransform(url: string, fallback: (u: string) => string): string {
  return url.startsWith(WIKI_COLOR_SCHEME) ? url : fallback(url);
}

/** A card excerpt in plain text: no front matter (`title: …` lines), no `[TOC]`, no HTML tags. */
export function wikiExcerpt(text: string): string {
  return stripHackmdArtifacts(text)
    .replace(/^\s*-{3,}\s*/, '')
    .replace(/^(?:\s*(?:title|tags|description|最後編輯日|最後編輯者)\s*[:：][^\n]*\n?)+/i, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\[TOC\]/gi, '')
    .trim();
}
