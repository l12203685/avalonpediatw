/**
 * 觀念卡 ↔ 百科文章的連結（2026-11-18，docs/CONCEPTS.md）：
 *
 *   #concepts            → 公開的觀念卡頁
 *   #concepts=<卡片 id>  → 觀念卡頁，捲到那一張（卡片 id 同 concepts.json：小寫英數字與 -，最長 64 字）
 *
 * 百科文章的「本篇觀念卡」用 articleConceptGroups 依文章的章節順序分組，標題旁的「觀念卡」連結用 conceptsBySection。
 * 純函式，packages/server/src/__tests__/WebConceptLinks.test.ts 測（web 沒有測試執行器）。
 */

import { wikiHeadingText, wikiHeadings } from './wikiSections';

/** 同 server concepts.ts 的 CONCEPT_ID_RE。 */
const CONCEPT_ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

export function isConceptCardId(id: string | null | undefined): boolean {
  return CONCEPT_ID_RE.test(id ?? '');
}

/** 觀念卡頁的 hash：#concepts，有卡片時 #concepts=<id>。 */
export function conceptCardHash(id?: string | null): string {
  return id ? `#concepts=${encodeURIComponent(id)}` : '#concepts';
}

/** #concepts → { id: null }；#concepts=<id> → { id }（id 不像卡片 id 時當成 #concepts）；其他 hash → null。 */
export function parseConceptsHash(hash: string | null | undefined): { id: string | null } | null {
  const raw = (hash ?? '').replace(/^#/, '').trim();
  if (/^concepts\/?$/i.test(raw)) return { id: null };
  const m = /^concepts[=/]([^&]*)/i.exec(raw);
  if (!m) return null;
  let id = m[1];
  try {
    id = decodeURIComponent(id);
  } catch {
    return { id: null };
  }
  id = id.trim().replace(/\/+$/, '');
  return { id: isConceptCardId(id) ? id : null };
}

/** 文章裡「本篇觀念卡」每張卡的元素 id。 */
export function conceptAnchorId(id: string): string {
  return `concept-card-${id}`;
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
