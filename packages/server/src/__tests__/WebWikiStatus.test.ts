/**
 * 百科文章的分類與「待完成」狀態（Edward 2026-10-28：只有標題或寫一半的文章放到待完成）。
 * Data: packages/server/wiki_data.json (served by /api/analysis/wiki) and packages/web/src/data/wiki.ts.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { WIKI_ARTICLES, WIKI_CATEGORIES, WIKI_STATUSES, isWikiPending } from '../../../web/src/data/wiki';

interface JsonArticle {
  id: string;
  title: string;
  category: string;
  status?: string;
  source: string;
}

const jsonArticles = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '..', '..', 'wiki_data.json'), 'utf-8'),
) as JsonArticle[];

const categoryIds = new Set(WIKI_CATEGORIES.map((c) => c.id));

/** Stubs, half-written pieces and unreadable PDF extractions (wiki triage §1). */
const PENDING_JSON_IDS = [
  11, 27, 58, 64, 60, 12, 34, 4, 52, 53, 29, 74, 68, 70, 2, 3, 5, 41, 42,
  144, 180, 141, 88, 122, 124, 89, 134, 100, 113, 147, 156, 155,
].map((n) => `wiki-${n}`);

/** The hard-coded 「X數據解析 — 2146 局實戰分析」 pieces: stale numbers, to be replaced by live stats. */
const PENDING_HARDCODED_IDS = WIKI_ARTICLES.filter((a) => /^strategy-[a-z]+-data$/.test(a.id)).map((a) => a.id);

describe('wiki categories and status', () => {
  const all = [...jsonArticles, ...WIKI_ARTICLES];

  it('every article has a known category', () => {
    const unknown = all.filter((a) => !categoryIds.has(a.category)).map((a) => `${a.id}:${a.category}`);
    expect(unknown).toEqual([]);
  });

  it("status is '完成', '待完成' or absent", () => {
    const bad = all.filter((a) => a.status !== undefined && !(WIKI_STATUSES as readonly string[]).includes(a.status));
    expect(bad.map((a) => a.id)).toEqual([]);
  });

  it('the triaged stubs are 待完成', () => {
    const byId = new Map(jsonArticles.map((a) => [a.id, a]));
    const notPending = PENDING_JSON_IDS.filter((id) => {
      const a = byId.get(id);
      return a !== undefined && !isWikiPending(a);
    });
    expect(notPending).toEqual([]);
  });

  it('the hard-coded 數據解析 articles are 待完成', () => {
    expect(PENDING_HARDCODED_IDS).toHaveLength(7);
    for (const id of PENDING_HARDCODED_IDS) {
      expect(isWikiPending(WIKI_ARTICLES.find((a) => a.id === id)!)).toBe(true);
    }
  });

  it('every category that is offered has at least one finished article', () => {
    const finished = new Set(all.filter((a) => !isWikiPending(a)).map((a) => a.category));
    expect(WIKI_CATEGORIES.filter((c) => !finished.has(c.id)).map((c) => c.id)).toEqual([]);
  });

  it('article ids are unique', () => {
    const ids = all.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
