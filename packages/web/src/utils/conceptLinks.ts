/**
 * 百科文章 → 觀念卡（2026-11-18，docs/CONCEPTS.md）。公開觀念卡頁的網址（#concepts、#concepts=<id>）與頁面上的錨點
 * （concept-<id>）在 utils/concepts.ts（conceptsHash、parseConceptsHash、conceptAnchorId），這裡不重複。
 *
 * 百科文章的「本篇觀念卡」用 articleConceptGroups 依文章的章節順序分組，標題旁的「觀念卡」連結用 conceptsBySection。
 * 純函式，packages/server/src/__tests__/WebConceptLinks.test.ts 測（web 沒有測試執行器）。
 */

import { wikiHeadingText, wikiHeadings } from './wikiSections';

/**
 * 「本篇觀念卡」裡每張卡的元素 id（文章 modal 裡）。故意跟公開觀念卡頁的 `concept-<id>`（utils/concepts.ts 的 conceptAnchorId）
 * 不同：從觀念卡檢視打開文章時，那一頁還在 modal 底下，同一個 id 出現兩次會捲錯地方。
 */
export function articleConceptAnchorId(id: string): string {
  return `wiki-concept-${id}`;
}

interface CardLike {
  id: string;
  article: { slug: string; section?: string };
}

export interface ArticleConceptGroup<C extends CardLike> {
  /** 章節錨點；整篇的卡是 null。 */
  section: string | null;
  /** 章節標題（讀者看到的字）；整篇或找不到那一節時 null。 */
  heading: string | null;
  cards: C[];
}

/**
 * 這篇文章的卡，依章節在文章裡的順序分組（同一節裡照卡庫順序）；整篇的卡排最前面，文章裡找不到的章節排最後
 * （heading 為 null，concepts:check 會把它列為待複查）。
 */
export function articleConceptGroups<C extends CardLike>(cards: readonly C[], articleId: string, content: string): ArticleConceptGroup<C>[] {
  const mine = cards.filter((c) => c.article.slug === articleId);
  if (!mine.length) return [];
  const heads = wikiHeadings(content);
  const order = new Map(heads.map((h, i) => [h.slug, i]));
  const groups = new Map<string, ArticleConceptGroup<C>>();
  for (const c of mine) {
    const key = c.article.section ?? '';
    let g = groups.get(key);
    if (!g) {
      const h = c.article.section ? heads.find((x) => x.slug === c.article.section) : undefined;
      g = { section: c.article.section ?? null, heading: h ? wikiHeadingText(h.text) : null, cards: [] };
      groups.set(key, g);
    }
    g.cards.push(c);
  }
  const rank = (g: ArticleConceptGroup<C>): number => (g.section === null ? -1 : order.get(g.section) ?? Number.MAX_SAFE_INTEGER);
  return [...groups.values()].sort((a, b) => rank(a) - rank(b));
}

/** 章節錨點 → 這一節的卡（標題旁的「觀念卡」連結用）。 */
export function conceptsBySection<C extends CardLike>(cards: readonly C[], articleId: string): Map<string, C[]> {
  const out = new Map<string, C[]>();
  for (const c of cards) {
    if (c.article.slug !== articleId || !c.article.section) continue;
    const list = out.get(c.article.section) ?? [];
    list.push(c);
    out.set(c.article.section, list);
  }
  return out;
}
