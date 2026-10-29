/**
 * 百科舊式 HTML → 網站樣式（packages/web/src/utils/wikiMarkup.ts，Edward 2026-10-28）。
 */
import { describe, expect, it } from 'vitest';
import { normalizeWikiMarkup, wikiArticleId, wikiExcerpt, wikiUrlTransform } from '../../../web/src/utils/wikiMarkup';

describe('normalizeWikiMarkup', () => {
  it('a run of whole-line red text becomes a warning callout (the 點跳夾 notice)', () => {
    const src = [
      '# <font color=#FF0000>注意！！！</font>',
      '',
      '* <font color=#FF0000>此方法不代表唯一玩法</font>',
      '* <font color=#FF0000>Ed: 強烈建議不要過度使用或解讀</font>',
    ].join('\n');
    // The blank line breaks the run: the heading alone is inline-colored, the two list items are one callout.
    const out = normalizeWikiMarkup(src);
    expect(out).not.toMatch(/<font/);
    expect(out).toContain('> ⚠️ 此方法不代表唯一玩法');
    expect(out).toContain('> - Ed: 強烈建議不要過度使用或解讀');
  });

  it('inline colors become pseudo-links with a semantic color; <br> becomes a line break', () => {
    const out = normalizeWikiMarkup('重點是<font color=#FF0000>**平衡**</font>，藍方<font color=#0000ff>好人</font><br>下一行');
    expect(out).toBe('重點是[**平衡**](wiki-color:red)，藍方[好人](wiki-color:blue)  \n下一行');
  });

  it('HackMD front matter and [TOC] are dropped', () => {
    const out = normalizeWikiMarkup('---\ntitle: x\n最後編輯者: someone\n---\n[TOC]\n\n正文');
    expect(out.trim()).toBe('正文');
  });

  it('both front matter blocks of a HackMD export are dropped, a later --- rule stays', () => {
    const src = '---\ntitle: a\ntags: [x]\n\n---\n\n---\ntitle: b\ntags: x\n---\n# 標題\n\n---\n\n下一段';
    expect(normalizeWikiMarkup(src)).toBe('# 標題\n\n---\n\n下一段');
  });

  it('HTML comments (text commented out in HackMD) are not shown', () => {
    const src = '## 亞瑟的忠臣\n<!-- * 可以說是這個遊戲最重要的角色\n* 遊戲一開始…    -->\n* 任務派票就是選你視角中的"好人"\n* 文字 <!-- 註解 --> 後面';
    const out = normalizeWikiMarkup(src);
    expect(out).not.toMatch(/<!--|-->|最重要的角色|註解/);
    expect(out).toContain('* 任務派票就是選你視角中的"好人"');
    expect(out).toContain('* 文字後面');
  });

  it('the url transform keeps only our color scheme and article links', () => {
    const fallback = (u: string) => (u.startsWith('javascript:') ? '' : u);
    expect(wikiUrlTransform('wiki-color:red', fallback)).toBe('wiki-color:red');
    expect(wikiUrlTransform('wiki:wiki-57', fallback)).toBe('wiki:wiki-57');
    expect(wikiUrlTransform('javascript:alert(1)', fallback)).toBe('');
  });

  it('wiki: links name an article id; other hrefs are not article links', () => {
    expect(wikiArticleId('wiki:wiki-57')).toBe('wiki-57');
    expect(wikiArticleId('wiki-color:red')).toBeNull();
    expect(wikiArticleId('https://hackmd.io/x')).toBeNull();
    expect(wikiArticleId('wiki:')).toBeNull();
    expect(wikiArticleId(undefined)).toBeNull();
  });

  it('site-relative image paths get the deploy base; external and empty srcs are left alone', async () => {
    const { wikiImageSrc } = await import('../../../web/src/utils/wikiMarkup');
    expect(wikiImageSrc('/wiki-images/a.png', '/')).toBe('/wiki-images/a.png');
    expect(wikiImageSrc('/wiki-images/a.png', '/avalonpediatw/')).toBe('/avalonpediatw/wiki-images/a.png');
    expect(wikiImageSrc('https://example.com/a.png', '/avalonpediatw/')).toBe('https://example.com/a.png');
    expect(wikiImageSrc('//cdn.example.com/a.png', '/x/')).toBe('//cdn.example.com/a.png');
    expect(wikiImageSrc(undefined, '/x/')).toBeUndefined();
  });

  it('card excerpts drop front-matter lines and tags', () => {
    expect(wikiExcerpt('title: 名詞說明與簡稱\ntags: roles\n名詞的<font color=red>說明</font>')).toBe('名詞的說明');
  });
});

describe('wikiCardExcerpt', () => {
  it('a stored excerpt that is only the HackMD title line falls back to the opening prose', async () => {
    const { wikiCardExcerpt } = await import('../../../web/src/utils/wikiMarkup');
    expect(wikiCardExcerpt('title: 視角', '---\ntitle: 視角\n---\n## 視角\n* 視角通常用以描述該玩家對場上其他玩家陣營的看法')).toContain('視角通常用以描述');
    expect(wikiCardExcerpt('為遊戲新手解答基本問題', '# x')).toBe('為遊戲新手解答基本問題');
  });
});
