/**
 * 觀念卡庫（packages/server/src/bots/threads/concepts.json）在網站這邊的載入（2026-11-18，站長：「全部的觀念卡應該要放主控台啊
 * 並且跟百科網站的文章完全連動」）。和 Threads 知識卡、主控台用的是同一份檔案；說明見 docs/CONCEPTS.md。
 *
 * 卡庫打包成獨立的 chunk（vite.config.ts 的 '@concepts-bundle'，型別見 src/conceptsBundle.d.ts），第一次需要時才下載，
 * 之後共用同一份。百科文章的「本篇觀念卡」（components/WikiConceptCards.tsx）與公開的觀念卡頁（#concepts=<id>）都從這裡拿。
 */

/** 卡片欄位（同 server concepts.ts 的 Concept；網站只讀不寫）。 */
export interface ConceptCard {
  id: string;
  article: {
    /** 百科文章 id（wiki_data.json）。 */
    slug: string;
    title: string;
    /** 章節錨點（標題的 slug，utils/wikiSections.ts）；沒有就是整篇。 */
    section?: string;
    /** 網站深連結 #wiki=<id>&sec=<章節>。 */
    url: string;
    /** 分享頁 /w/<id>/。 */
    shareUrl: string;
    /** 來源那一節的雜湊（utils/conceptSource.ts）。 */
    sectionHash?: string;
    /** 來源那一節裡卡片依據的一句。 */
    sourceQuote?: string;
  };
  情境: string;
  觀念: string;
  應用: string;
  tags: Record<string, unknown>;
  /** 邏輯／經驗／判斷／待驗證；文章沒標就是 null。 */
  evidence: string | null;
}

export interface ConceptCardBank {
  version: number;
  site: string;
  concepts: ConceptCard[];
  retired?: string[];
}

let pending: Promise<ConceptCard[]> | null = null;

/** 全部的觀念卡（chunk 下載失敗時是空陣列，下次再試）。 */
export function loadConceptCards(): Promise<ConceptCard[]> {
  pending ??= import('@concepts-bundle')
    .then((m) => m.default.concepts)
    .catch(() => {
      pending = null;
      return [];
    });
  return pending;
}
