/**
 * 百科文章的「本篇觀念卡」（packages/web/src/utils/conceptLinks.ts；docs/CONCEPTS.md）連到公開觀念卡頁（utils/concepts.ts，#86）。
 * web 沒有測試執行器，在這裡測。
 */

import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { articleConceptAnchorId, articleConceptGroups, conceptsBySection } from '../../../web/src/utils/conceptLinks';
import { conceptAnchorId, conceptsHash, parseConceptsHash } from '../../../web/src/utils/concepts';
import { parseWikiHash } from '../../../web/src/utils/wikiHash';
import { conceptBank } from '../bots/threads/concepts';

const serverRoot = path.resolve(__dirname, '..', '..');
const wiki = new Map(
  (JSON.parse(fs.readFileSync(path.join(serverRoot, 'wiki_data.json'), 'utf8')) as { id: string; content: string }[]).map((a) => [a.id, a]),
);
const bank = conceptBank();

describe('links from an article to the concept page', () => {
  it('every card’s #concepts=<id> link opens that card on the page (anchor concept-<id>)', () => {
    for (const c of bank.concepts) {
      const target = parseConceptsHash(conceptsHash(c.id));
      expect(target).toEqual({ id: c.id });
      expect(conceptAnchorId(target?.id ?? '')).toBe(`concept-${c.id}`);
      expect(parseWikiHash(conceptsHash(c.id))).toBeNull();
    }
    expect(conceptsHash()).toBe('#concepts');
  });

  it('gives the in-article cards their own anchors, so they never clash with the page underneath the modal', () => {
    expect(articleConceptAnchorId('w205-1-2')).toBe('wiki-concept-w205-1-2');
    for (const c of bank.concepts) expect(articleConceptAnchorId(c.id)).not.toBe(conceptAnchorId(c.id));
  });
});

describe('本篇觀念卡', () => {
  it('groups an article’s cards by section in article order, whole-article cards first and unknown sections last', () => {
    const content = '# T\n## 甲\n### 乙\n## 丙';
    const cards = [
      { id: 'c-1', article: { slug: 'a', section: '丙' } },
      { id: 'c-2', article: { slug: 'a', section: '甲' } },
      { id: 'c-3', article: { slug: 'a', section: '不見了' } },
      { id: 'c-4', article: { slug: 'a' } },
      { id: 'c-5', article: { slug: 'a', section: '甲' } },
      { id: 'c-6', article: { slug: 'b', section: '甲' } },
    ];
    const groups = articleConceptGroups(cards, 'a', content);
    expect(groups.map((g) => [g.section, g.heading, g.cards.map((c) => c.id)])).toEqual([
      [null, null, ['c-4']],
      ['甲', '甲', ['c-2', 'c-5']],
      ['丙', '丙', ['c-1']],
      ['不見了', null, ['c-3']],
    ]);
    expect(articleConceptGroups(cards, 'z', content)).toEqual([]);
    expect([...conceptsBySection(cards, 'a').keys()]).toEqual(['丙', '甲', '不見了']);
  });

  it('finds a heading for every real card', () => {
    const missing: string[] = [];
    for (const slug of new Set(bank.concepts.map((c) => c.article.slug))) {
      const a = wiki.get(slug);
      if (!a) continue;
      const groups = articleConceptGroups(bank.concepts, slug, a.content);
      for (const g of groups) if (g.section && !g.heading) missing.push(`${slug}#${g.section}`);
      expect(groups.reduce((n, g) => n + g.cards.length, 0)).toBe(bank.concepts.filter((c) => c.article.slug === slug).length);
    }
    expect(missing).toEqual([]);
  });

  it('ships the same concepts.json the server uses (vite alias)', () => {
    const vite = fs.readFileSync(path.join(serverRoot, '..', 'web', 'vite.config.ts'), 'utf8');
    expect(vite).toMatch(/'@concepts-bundle': path\.resolve\(__dirname, '\.\.\/server\/src\/bots\/threads\/concepts\.json'\)/);
  });
});
