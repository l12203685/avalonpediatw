/**
 * 百科文章的分類、「待完成」狀態與合併（Edward 2026-10-28：只有標題或寫一半的文章放到待完成；
 * 重複的文章照盤點合併）。
 * Data: packages/server/wiki_data.json (served by /api/analysis/wiki) and packages/web/src/data/wiki.ts.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  WIKI_ARTICLES,
  WIKI_ARTICLE_ROLE,
  WIKI_CATEGORIES,
  WIKI_STATUSES,
  isWikiPending,
  mergeWikiArticles,
} from '../../../web/src/data/wiki';

interface JsonArticle {
  id: string;
  title: string;
  category: string;
  content: string;
  status?: string;
  source: string;
}

const jsonArticles = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '..', '..', 'wiki_data.json'), 'utf-8'),
) as JsonArticle[];
const jsonById = new Map(jsonArticles.map((a) => [a.id, a]));

const categoryIds = new Set(WIKI_CATEGORIES.map((c) => c.id));
const wiki = (...ns: number[]): string[] => ns.map((n) => `wiki-${n}`);

/** Stubs, half-written pieces and unreadable PDF extractions (wiki triage §1). */
const TRIAGED_PENDING = wiki(
  11, 27, 58, 64, 60, 12, 34, 4, 52, 53, 29, 74, 68, 70, 2, 3, 5, 41, 42,
  144, 180, 141, 88, 122, 124, 89, 134, 100, 113, 147, 156, 155,
);

/** Articles merged into another article or removed (wiki triage §2). They must not come back. */
const MERGED_JSON_IDS = wiki(
  6, 10, 14, 15, 20, 29, 31, 36, 37, 43, 46, 49, 53, 55, 60, 61, 64, 67, 68, 69, 70, 73, 89, 96, 105,
  113, 114, 115, 116, 119, 122, 124, 130, 131, 132, 133, 137, 154, 167, 168, 169, 171, 172, 173, 174, 178,
);
const MERGED_HARDCODED_IDS = [
  'roles-merlin', 'roles-percival', 'roles-loyal', 'roles-oberon', 'roles-assassin', 'strategies-assassination',
  'roles-morgana', 'roles-mordred', 'strategies-red-basic', 'beginner-guide', 'strategies-info-priority',
  'beginner-mistakes', 'glossary-basic', 'glossary-lake', 'glossary-combat', 'rules-voting', 'rules-overview',
  'rules-flow', 'strategies-zone-voting',
];

/** The hard-coded 「X數據解析 — 2146 局實戰分析」 pieces: stale numbers, to be replaced by live stats. */
const DATA_ARTICLE_IDS = WIKI_ARTICLES.filter((a) => /^strategy-[a-z]+-data$/.test(a.id)).map((a) => a.id);

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

  it('every triaged stub is still 待完成, unless it was merged into another article', () => {
    const wrong = TRIAGED_PENDING.filter((id) => {
      const a = jsonById.get(id);
      return a ? !isWikiPending(a) : !MERGED_JSON_IDS.includes(id);
    });
    expect(wrong).toEqual([]);
    // 資訊的來源與驗證 took in the empty 資訊來源 half
    expect(isWikiPending(jsonById.get('wiki-140')!)).toBe(true);
  });

  it('the hard-coded 數據解析 articles are 待完成', () => {
    expect(DATA_ARTICLE_IDS).toHaveLength(7);
    for (const id of DATA_ARTICLE_IDS) {
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

describe('wiki merges', () => {
  const displayed = mergeWikiArticles<{ id: string; title: string }>(WIKI_ARTICLES, jsonArticles);

  it('no two displayed articles share a title', () => {
    const seen = new Map<string, string>();
    const clashes: string[] = [];
    for (const a of displayed) {
      const key = a.title.toLowerCase();
      if (seen.has(key)) clashes.push(`${seen.get(key)} / ${a.id}: ${a.title}`);
      seen.set(key, a.id);
    }
    expect(clashes).toEqual([]);
  });

  it('every JSON article is displayed (the title rule hides nothing)', () => {
    const shown = new Set(displayed.map((a) => a.id));
    expect(jsonArticles.filter((a) => !shown.has(a.id)).map((a) => a.id)).toEqual([]);
  });

  it('merged articles are gone from the site data', () => {
    expect(MERGED_JSON_IDS.filter((id) => jsonById.has(id))).toEqual([]);
    const hardcoded = new Set(WIKI_ARTICLES.map((a) => a.id));
    expect(MERGED_HARDCODED_IDS.filter((id) => hardcoded.has(id))).toEqual([]);
  });

  it('each role article exists and opens with the 角色能力 section from 角色介紹', () => {
    for (const [id, role] of Object.entries(WIKI_ARTICLE_ROLE)) {
      const a = jsonById.get(id);
      expect(a, `${id} (${role})`).toBeDefined();
      expect(a!.category).toBe('roles');
    }
    for (const id of wiki(175, 176, 25, 21, 12)) {
      expect(jsonById.get(id)!.content).toMatch(/^# 角色能力$/m);
    }
  });

  it('莫甘娜 does not carry the 「演好假梅林」 advice', () => {
    expect(jsonById.get('wiki-170')!.content).not.toMatch(/假梅林|讓派西維爾 ?誤認你是梅林/);
  });

  it('覆盤 articles are titled by game, one article per title', () => {
    const replays = jsonArticles.filter((a) => a.category === 'replays');
    expect(replays.length).toBeGreaterThan(0);
    for (const a of replays) expect(a.title).toMatch(/^覆盤 (模擬|面瓦) \d{6}/);
  });

  it('牌譜分析報告 keeps only aggregate numbers (no per-player tables)', () => {
    const report = jsonById.get('wiki-40')!.content;
    expect(report).not.toMatch(/玩家統計|出賽次數|高手/);
    expect(report).toMatch(/年度趨勢/);
  });
});
