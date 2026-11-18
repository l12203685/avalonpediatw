/**
 * 百科文章的「本篇觀念卡」與觀念卡頁的網址（packages/web/src/utils/conceptLinks.ts；docs/CONCEPTS.md）。web 沒有測試執行器，在這裡測。
 */

import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  articleConceptGroups,
  conceptAnchorId,
  conceptCardHash,
  conceptsBySection,
  isConceptCardId,
  parseConceptsHash,
} from '../../../web/src/utils/conceptLinks';
import { parseWikiHash } from '../../../web/src/utils/wikiHash';
import { CONCEPT_ID_RE, conceptBank } from '../bots/threads/concepts';

const serverRoot = path.resolve(__dirname, '..', '..');
const wiki = new Map(
  (JSON.parse(fs.readFileSync(path.join(serverRoot, 'wiki_data.json'), 'utf8')) as { id: string; content: string }[]).map((a) => [a.id, a]),
);
const bank = conceptBank();

describe('#concepts=<id>', () => {
  it('round-trips card ids and leaves other hashes alone', () => {
    expect(conceptCardHash()).toBe('#concepts');
    expect(conceptCardHash('w205-1-2')).toBe('#concepts=w205-1-2');
    expect(parseConceptsHash('#concepts')).toEqual({ id: null });
    expect(parseConceptsHash('#concepts=w205-1-2')).toEqual({ id: 'w205-1-2' });
    expect(parseConceptsHash('#concepts/w205-1-2/')).toEqual({ id: 'w205-1-2' });
    expect(parseConceptsHash('#concepts=<script>')).toEqual({ id: null });
    expect(parseConceptsHash('#concepts=%E0')).toEqual({ id: null });
    expect(parseConceptsHash('#wiki=wiki-205')).toBeNull();
    expect(parseWikiHash(conceptCardHash('w205-1-2'))).toBeNull();
    for (const c of bank.concepts) expect(parseConceptsHash(conceptCardHash(c.id))).toEqual({ id: c.id });
  });

  it('accepts the same ids as concepts.json', () => {
    for (const id of ['w205-1-2', 'a1', 'Bad', '-x', 'x'.repeat(65)]) expect(isConceptCardId(id)).toBe(CONCEPT_ID_RE.test(id));
    expect(conceptAnchorId('w205-1-2')).toBe('concept-card-w205-1-2');
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
