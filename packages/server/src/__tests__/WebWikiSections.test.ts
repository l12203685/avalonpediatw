/**
 * 百科文章的章節錨點（packages/web/src/utils/wikiSections.ts，2026-11-11 文章合併：被併入的文章成為主文的一節，
 * 舊連結要直接跳到那一節）。web 沒有測試執行器，純函式在這裡測。
 */
import { describe, expect, it } from 'vitest';
import {
  createSlugger,
  hasWikiSection,
  rehypeWikiHeadingIds,
  resolveWikiSection,
  wikiHeadingSlug,
  wikiHeadings,
  wikiHeadingText,
} from '../../../web/src/utils/wikiSections';

describe('wikiHeadingSlug', () => {
  it('keeps Chinese text and full-width punctuation, drops markup, layer marks and ASCII punctuation', () => {
    expect(wikiHeadingSlug('四、內黑的用途')).toBe('四、內黑的用途');
    expect(wikiHeadingSlug('牌局範例二：派西與雜魚怎麼讀 1 家的外灑')).toBe('牌局範例二：派西與雜魚怎麼讀-1-家的外灑');
    expect(wikiHeadingSlug('覆盤（【經驗】解讀）')).toBe('覆盤（解讀）');
    expect(wikiHeadingSlug('**粗體** 與 [連結](wiki:wiki-1) `code`')).toBe('粗體-與-連結-code');
    expect(wikiHeadingSlug('(1) 資訊過度超前者 ☆☆')).toBe('1-資訊過度超前者-☆☆');
    expect(wikiHeadingSlug('6.2 湖中線（連續的湖中）')).toBe('6.2-湖中線（連續的湖中）');
    expect(wikiHeadingSlug('Game Theory Thinking')).toBe('game-theory-thinking');
    expect(wikiHeadingSlug('【邏輯】')).toBe('section');
    expect(wikiHeadingText('<font color=red>注意</font>')).toBe('注意');
  });
});

describe('wikiHeadings', () => {
  const md = [
    '---', 'title: x', '---', '# 標題', '', '## 結論', '- a', '```', '## 不是標題', '```', '### 結論', '#### 3.3 例外', '',
  ].join('\n');

  it('lists ATX headings outside code fences and front matter, numbering repeated slugs', () => {
    expect(wikiHeadings(md)).toEqual([
      { level: 1, text: '標題', slug: '標題' },
      { level: 2, text: '結論', slug: '結論' },
      { level: 3, text: '結論', slug: '結論-2' },
      { level: 4, text: '3.3 例外', slug: '3.3-例外' },
    ]);
    expect(hasWikiSection(md, '結論-2')).toBe(true);
    expect(hasWikiSection(md, '不是標題')).toBe(false);
  });

  it('resolves 〈章節〉 citations: exact, without the leading number, or by their start', () => {
    const doc = '# A\n## 三、異常票基礎 - 內黑與外白的意義\n### 四、派西維爾視角\n## 梅林可以派拇指嗎 - 順應局勢\n### 3.3 例外\n';
    expect(resolveWikiSection(doc, '三、異常票基礎 - 內黑與外白的意義')).toBe('三、異常票基礎-內黑與外白的意義');
    expect(resolveWikiSection(doc, '異常票基礎 - 內黑與外白的意義')).toBe('三、異常票基礎-內黑與外白的意義');
    expect(resolveWikiSection(doc, '派西維爾視角')).toBe('四、派西維爾視角');
    expect(resolveWikiSection(doc, '梅林可以派拇指嗎')).toBe('梅林可以派拇指嗎-順應局勢');
    expect(resolveWikiSection(doc, '3.3 例外')).toBe('3.3-例外');
    expect(resolveWikiSection(doc, '不存在的章節')).toBeNull();
    expect(resolveWikiSection(doc, '')).toBeNull();
  });

  it('the slugger hands out unique names in order', () => {
    const s = createSlugger();
    expect([s('a'), s('b'), s('a'), s('a')]).toEqual(['a', 'b', 'a-2', 'a-3']);
  });
});

describe('rehypeWikiHeadingIds', () => {
  it('gives rendered headings the same ids wikiHeadings computes from the Markdown', () => {
    const text = (value: string) => ({ type: 'text', value });
    const el = (tagName: string, children: unknown[], properties: Record<string, unknown> = {}) => ({ type: 'element', tagName, properties, children });
    const tree = {
      type: 'root',
      children: [
        el('h2', [text('四、內黑的用途')]),
        el('p', [text('內文')]),
        el('h3', [el('strong', [text('結論')])]),
        el('h3', [el('a', [], { href: 'wiki-tag:exp' }), text('結論')]),
        el('h4', [text('牌局範例二：派西與雜魚怎麼讀 1 家的外灑')]),
      ],
    };
    rehypeWikiHeadingIds()(tree as never);
    const ids = tree.children.filter((c) => /^h\d$/.test(c.tagName)).map((c) => (c.properties as { id?: string }).id);
    const md = '## 四、內黑的用途\n內文\n### **結論**\n### 【經驗】結論\n#### 牌局範例二：派西與雜魚怎麼讀 1 家的外灑';
    expect(ids).toEqual(wikiHeadings(md).map((h) => h.slug));
    expect((tree.children[1].properties as { id?: string }).id).toBeUndefined();
  });
});
