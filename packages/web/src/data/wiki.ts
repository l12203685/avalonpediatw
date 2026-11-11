/**
 * Wiki Content Type Definitions
 */

export interface WikiCategory {
  id: string;
  name: string;
  icon: string;
  description: string;
}

export interface WikiArticle {
  id: string;
  title: string;
  category: string;
  content: string;
  excerpt: string;
  tags: string[];
  author: string;
  /** 最後更新日；沒有可靠日期的文章（API 來的舊文）不填、不顯示。 */
  updatedAt?: Date;
  /** Absent means 完成. 待完成 = a stub / half-written article, listed apart (Edward 2026-10-28). */
  status?: WikiStatus;
}

export const WIKI_STATUSES = ['完成', '待完成'] as const;
export type WikiStatus = (typeof WIKI_STATUSES)[number];

export function isWikiPending(article: { status?: string }): boolean {
  return article.status === '待完成';
}

/** Hard-coded first, then API articles whose title isn't already listed. */
export function mergeWikiArticles<T extends { title: string }>(hardcoded: T[], api: T[]): T[] {
  const titles = new Set(hardcoded.map((a) => a.title.toLowerCase()));
  return [...hardcoded, ...api.filter((a) => !titles.has(a.title.toLowerCase()))];
}

/**
 * Role articles that show the role's live stats card (right after their 〈實戰數據怎麼讀〉 section, 2026-11-11) and short
 * video (the merged role articles in wiki_data.json).
 */
export const WIKI_ARTICLE_ROLE: Record<string, string> = {
  'wiki-175': 'merlin',
  'wiki-176': 'percival',
  'wiki-25': 'loyal_servant',
  'wiki-12': 'assassin',
  'wiki-170': 'morgana',
  'wiki-166': 'mordred',
  'wiki-21': 'oberon',
};

// Avalon Game Rules & Strategy Wiki
/**
 * 分類＝學習路徑（Edward 2026-10-30 晚：全站章節重新整併，心智圖、知識關聯與閱讀方向更直觀、精簡；2026-11-11 再併成 40 篇）：
 * 規則與名詞 → 入門與基礎觀念 → 角色 → 任務派票 → 投票與湖中 → 進階思考 → 覆盤與賽事 → 數據，加上關於本站。
 * 每個分類裡的文章照 wiki_data.json 的順序排，由上而下就是一條閱讀線；舊的「名詞解釋」「常見問題」「賽事與戰績」
 * 拆進規則與名詞、任務派票、投票與湖中、覆盤與賽事、數據。
 */
export const WIKI_CATEGORIES: WikiCategory[] = [
  {
    id: 'rules',
    name: '規則與名詞',
    icon: '📋',
    description: '規則說明書、7～9 人局、牌譜記號與常用術語、帶新手開局與新手常見問題',
  },
  {
    id: 'beginner',
    name: '入門與基礎觀念',
    icon: '🎯',
    description: '用派票說話、邏輯與經驗（論點標記與鐵邏輯）、資訊可信度、能力者、常見錯誤與心法語錄',
  },
  {
    id: 'roles',
    name: '角色',
    icon: '👥',
    description: '角色總覽、藍方與紅方基礎原則、各角色玩法與刺殺',
  },
  {
    id: 'strategies',
    name: '任務派票',
    icon: '♟️',
    description: '派票名詞、視角與區間、解讀前人派票、外灑、開局與開藍後三加一、尾家與聽牌',
  },
  {
    id: 'voting',
    name: '投票與湖中',
    icon: '⚖️',
    description: '黑白球的正常票、異常票與內黑、外白、湖中女神（入門與各比分的湖法）',
  },
  {
    id: 'advanced',
    name: '進階思考',
    icon: '🧠',
    description: '思考原理與大局觀、換位思考與層次、機率',
  },
  {
    id: 'replays',
    name: '覆盤與賽事',
    icon: '🔁',
    description: '附牌局代碼的覆盤與第一局模擬題、牌譜集與線上實戰賽',
  },
  {
    id: 'data',
    name: '數據',
    icon: '📊',
    description: '怎麼讀數據、牌譜數據紀錄；各角色的即時數據在各角色文章',
  },
  {
    // Edward 2026-10-30 裁定（E17）：〈關於阿瓦隆百科〉放獨立的「關於本站」。
    id: 'about',
    name: '關於本站',
    icon: 'ℹ️',
    description: '百科介紹、建議閱讀順序、學習地圖與社群連結',
  },
];

/** 角色代號 → 中文角色名（與數據分析快取的角色名相同）。 */
export const WIKI_ROLE_NAMES: Record<string, string> = {
  merlin: '梅林',
  percival: '派西維爾',
  loyal_servant: '忠臣',
  mordred: '莫德雷德',
  morgana: '莫甘娜',
  assassin: '刺客',
  oberon: '奧伯倫',
};

/**
 * Hard-coded articles. Everything comes from packages/server/wiki_data.json (/api/analysis/wiki).
 * The rewrites that duplicated JSON articles were merged into them (wiki triage §2, Edward 2026-10-28); 2026-11-11 the
 * last ones went too: 〈新手常見問題（規則篇）〉 became a section of 〈帶新手開局〉 (wiki-217) and the seven 〈角色數據〉
 * pieces became each role article's 〈重點摘要〉 and 〈實戰數據怎麼讀〉 (the live card now sits after that section). Their old
 * ids still open the right place (data/wikiRedirects.ts). Kept as an empty list so a future hard-coded piece has a home.
 */
export const WIKI_ARTICLES: WikiArticle[] = [];
