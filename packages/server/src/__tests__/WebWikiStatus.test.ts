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
  // 2026-10-29 整併（讀完全部文章後，同一個觀念只留一篇主文）
  7, 13, 16, 17, 19, 76, 118, 125, 180,
);

/** 2026-10-29: main article ← the articles merged into it (each main ends with 「本文整合自」 naming them). */
const MERGES_1029: Record<string, string[]> = {
  'wiki-57': ['五人局視角區間範例', '區間派票法之變體 (點/夾/跳)'],
  'wiki-18': ['外灑與外灑出任務後的區間解讀'],
  'wiki-24': ['3 家對 1AB, 2CD 之後的解讀與反饋'],
  'wiki-23': ['填空型派票分析'],
  'wiki-50': ['能力者與超前資訊的條件關係'],
  'wiki-38': ['牌局範例: 異常票(內黑外白)'],
  'wiki-39': ['壞人的數量'],
  'wiki-144': ['雙重假設'],
};

/** 2026-10-29: articles split off a source that bundled two topics. */
const SPLITS_1029 = [
  { source: 'wiki-106', sourceTitle: /入門行動方針/, id: 'wiki-201', title: '藍方基礎原則', heading: '# 藍方基礎原則' },
  { source: 'wiki-92', sourceTitle: /^常見錯誤 - 遊戲觀念$/, id: 'wiki-202', title: '常見錯誤 - 遊戲品格', heading: '# 常見錯誤 - 遊戲品格' },
];

const DOCS = path.resolve(__dirname, '..', '..', '..', '..', 'docs', 'avalon-wiki');
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

  it('覆盤 articles are titled by what they teach; the game code opens the article', () => {
    // 2026-10-30 標題盤點：數字代碼看不出內容，標題改成「覆盤 - 情境＋重點」，代碼（模擬／面瓦 + 角色位置）移到內文第一行。
    const replays = jsonArticles.filter((a) => a.category === 'replays');
    expect(replays.length).toBeGreaterThan(0);
    for (const a of replays) {
      expect(a.title).toMatch(/^覆盤 - \S/);
      expect(a.title).not.toMatch(/\d{6}/);
      const body = a.content.replace(/^(?:\s*---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$))+/, '');
      expect(body, a.id).toMatch(/^> 牌局代碼：(模擬|面瓦) \d{6}/);
    }
  });

  it('titles use 「 - 」 as the separator, without emoji, HTML or lost punctuation (2026-10-30 標題盤點)', () => {
    const bad = [...jsonArticles, ...WIKI_ARTICLES].filter(
      (a) => /[—－]|\p{Extended_Pictographic}|<[a-z]|\s{2}|^\s|\s$|\S-\s|\s-\S|戰積(?!分)/u.test(a.title),
    );
    expect(bad.map((a) => `${a.id}: ${a.title}`)).toEqual([]);
  });

  it('the front matter title matches the article title', () => {
    const wrong: string[] = [];
    for (const a of jsonArticles) {
      const fm = a.content.match(/^(?:\s*---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$))+/);
      if (!fm) continue;
      for (const m of fm[0].matchAll(/^title: (.*)$/gm)) if (m[1] !== a.title) wrong.push(`${a.id}: ${m[1]}`);
    }
    expect(wrong).toEqual([]);
  });

  it('牌譜分析報告 keeps only aggregate numbers (no per-player tables)', () => {
    const report = jsonById.get('wiki-40')!.content;
    expect(report).not.toMatch(/玩家統計|出賽次數|高手/);
    expect(report).toMatch(/年度趨勢/);
  });
});

describe('wiki restructure (Edward 2026-10-29: 讀完全部文章後整併、分拆)', () => {
  it('each merged main article ends with 「本文整合自」 naming its sources', () => {
    for (const [id, sources] of Object.entries(MERGES_1029)) {
      const lines = jsonById.get(id)!.content.trimEnd().split('\n');
      const note = lines[lines.length - 1];
      expect(note, id).toMatch(/^> 本文整合自/);
      for (const s of sources) expect(note, id).toContain(`〈${s}〉`);
    }
  });

  it('a merge keeps the merged text (a sample line from each source is in the main article)', () => {
    const samples: Record<string, string[]> = {
      'wiki-57': ['僅有 5 家好人時, 有 {1} 鐵好的視角', '379 => 夾8 給 [0, 1, 2], [4, 5, 6] 兩個區間'],
      'wiki-18': ['白話就是常聽到的: 場內至少一壞, 場外白區間, 場外黑球區間', '外撒 = 至少作對洗壞人尾派這件事'],
      'wiki-24': ['尊重 = 參考', '修正"通常"認為 AC 至少有一壞'],
      'wiki-23': ['直接派反邊是沒有經過思考的表現', '不能是尾派'],
      'wiki-50': ['結論: 只有 1, 2, 4, 8 這幾條描述 (推論) 是正確的', '刻意本身就是能力的展現'],
      'wiki-38': ['8外白: 可以考慮兩種狀況', '換個角度思考: 若 8 為梅林會做這個動作嗎?'],
      'wiki-39': ['那等同 8 家自己告訴大家壞人是 8 家', '0肯定是會派自己'],
      'wiki-144': ['什麼是雙重假設: 當兩件事情敘述彼此不相關的時候就稱為雙重假設'],
    };
    for (const [id, lines] of Object.entries(samples)) {
      for (const l of lines) expect(jsonById.get(id)!.content, id).toContain(l);
    }
  });

  it('split-off articles stand alone and the source no longer carries them', () => {
    for (const s of SPLITS_1029) {
      const src = jsonById.get(s.source)!;
      const part = jsonById.get(s.id)!;
      expect(src.title).toMatch(s.sourceTitle);
      expect(src.content).not.toContain(`\n${s.heading}\n`);
      expect(part.title).toBe(s.title);
      expect(part.content).toContain(`\n${s.heading}\n`);
      expect(isWikiPending(part)).toBe(false);
    }
    expect(jsonById.get('wiki-201')!.category).toBe('roles');
  });

  it('every [標題](wiki:id) link points at an article on the site', () => {
    const ids = new Set([...jsonArticles.map((a) => a.id), ...WIKI_ARTICLES.map((a) => a.id)]);
    const broken: string[] = [];
    for (const a of jsonArticles) {
      for (const m of a.content.matchAll(/\]\(wiki:([^)\s]+)\)/g)) if (!ids.has(m[1])) broken.push(`${a.id} → ${m[1]}`);
    }
    expect(broken).toEqual([]);
  });

  it('articles do not depend on HackMD: no hackmd.io links, every /wiki-images/ picture is in the web public folder', () => {
    // 2026-10-29：網站是百科唯一的家，不再用 HackMD；圖片放 packages/web/public/wiki-images/。
    const publicDir = path.resolve(__dirname, '..', '..', '..', 'web', 'public');
    const hackmd = jsonArticles.filter((a) => a.content.includes('hackmd.io')).map((a) => a.id);
    expect(hackmd).toEqual([]);
    const missing: string[] = [];
    let images = 0;
    for (const a of jsonArticles) {
      for (const m of a.content.matchAll(/\]\((\/wiki-images\/[^)\s]+)\)/g)) {
        images++;
        if (!fs.existsSync(path.join(publicDir, m[1]))) missing.push(`${a.id} → ${m[1]}`);
      }
    }
    expect(images).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });

  it('docs/avalon-wiki holds one article per file, matching the site text', () => {
    const files: Record<string, string> = {
      '派票策略/視角與區間派票法.md': 'wiki-57',
      '派票策略/外灑相關討論.md': 'wiki-18',
      '進階思考/延伸與修正.md': 'wiki-24',
      '派票策略/平衡策略.md': 'wiki-23',
      '入門基礎/能力者.md': 'wiki-50',
      '湖中與投票/為什麼不該亂開場外白球.md': 'wiki-38',
      '派票策略/為什麼知道你是壞人.md': 'wiki-39',
      '進階思考/邏輯一致性.md': 'wiki-144',
      '入門基礎/入門行動方針.md': 'wiki-106',
      '角色/藍方基礎原則.md': 'wiki-201',
      '入門基礎/常見錯誤 - 任務派票.md': 'wiki-90',
      '入門基礎/常見錯誤 - 湖中女神.md': 'wiki-91',
      '入門基礎/常見錯誤 - 遊戲觀念.md': 'wiki-92',
      '入門基礎/常見錯誤 - 遊戲品格.md': 'wiki-202',
      '入門基礎/常見錯誤 - 黑白球投票.md': 'wiki-93',
      '入門基礎/阿瓦隆名詞介紹 - 黑白球投票.md': 'wiki-148',
      '入門基礎/阿瓦隆名詞介紹 - 動作相關.md': 'wiki-149',
      '入門基礎/阿瓦隆名詞介紹 - 任務牌指派.md': 'wiki-150',
      '入門基礎/阿瓦隆名詞介紹 - 湖中女神.md': 'wiki-151',
    };
    for (const [file, id] of Object.entries(files)) {
      expect(fs.readFileSync(path.join(DOCS, file), 'utf-8').trim(), file).toBe(jsonById.get(id)!.content.trim());
    }
    const gone = [
      '入門基礎/新手常見錯誤.md', '入門基礎/名詞說明與簡稱.md', '派票策略/五人局視角區間範例.md',
      '派票策略/區間派票法之變體 (點_夾_跳).md', '派票策略/外灑與外灑出任務後的區間解讀.md', '派票策略/填空型派票分析.md',
      '派票策略/壞人的數量.md', '進階思考/雙重假設.md',
    ];
    expect(gone.filter((f) => fs.existsSync(path.join(DOCS, f)))).toEqual([]);
  });
});
