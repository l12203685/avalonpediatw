/**
 * 百科舊式 HTML → 網站樣式（packages/web/src/utils/wikiMarkup.ts，Edward 2026-10-28）。
 */
import { describe, expect, it } from 'vitest';
import { normalizeWikiMarkup, wikiExcerpt, wikiUrlTransform } from '../../../web/src/utils/wikiMarkup';

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

  it('the url transform keeps only our color scheme', () => {
    const fallback = (u: string) => (u.startsWith('javascript:') ? '' : u);
    expect(wikiUrlTransform('wiki-color:red', fallback)).toBe('wiki-color:red');
    expect(wikiUrlTransform('javascript:alert(1)', fallback)).toBe('');
  });

  it('card excerpts drop front-matter lines and tags', () => {
    expect(wikiExcerpt('title: 名詞說明與簡稱\ntags: roles\n名詞的<font color=red>說明</font>')).toBe('名詞的說明');
  });
});
