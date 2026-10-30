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
  WIKI_DATA_ARTICLE_ROLE,
  WIKI_ROLE_NAMES,
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
// 2026-10-30 Edward：wiki-11（內黑的用途）、12（刺客）、27（換位思考）、147（湖中女神使用方針）、156（S1 總覽）補完，不再待完成。
// 2026-10-30 Edward 裁定（wiki_decisions.md）：wiki-2 改寫成〈第一局開藍後 - 三加一還是拆車〉、41／42 換成打字還原的牌譜集、
// 100 改成學習地圖，不再待完成；3、5、58、74、88、144 併入或刪除（見 MERGED_JSON_IDS）。
const TRIAGED_PENDING = wiki(
  58, 64, 60, 34, 4, 52, 53, 29, 74, 68, 70, 3, 5,
  144, 180, 141, 88, 122, 124, 89, 134, 113, 155,
);
/** 2026-10-30 Edward 裁定後補完、移出待完成的文章（42、100 之後再併進 41、153）。 */
const FINISHED_1030 = wiki(2, 41, 42, 100);

/** Articles merged into another article or removed (wiki triage §2). They must not come back. */
const MERGED_JSON_IDS = wiki(
  6, 10, 14, 15, 20, 29, 31, 36, 37, 43, 46, 49, 53, 55, 60, 61, 64, 67, 68, 69, 70, 73, 89, 96, 105,
  113, 114, 115, 116, 119, 122, 124, 130, 131, 132, 133, 137, 154, 167, 168, 169, 171, 172, 173, 174, 178,
  // 2026-10-29 整併（讀完全部文章後，同一個觀念只留一篇主文）
  7, 13, 16, 17, 19, 76, 118, 125, 180,
  // 2026-10-30 Edward 裁定（文章總篇數不要過多，講同一件事的合併；空白殘頁刪除）
  3, 5, 9, 47, 58, 59, 74, 88, 101, 144,
  // 2026-10-30 晚 Edward：全站章節重新整併（心智圖、知識關聯與閱讀方向更直觀精簡，不要過多零碎觀念和文章）；100 → 49 篇
  63, 28, 65, 149, 201, 51, 218, 140, 22, 98, 141, 34, 93, 91, 92, 202, 111, 104, 33, 213, 210, 48, 39, 215,
  30, 117, 75, 8, 214, 44, 179, 151, 78, 219, 94, 23, 212, 1, 45, 134, 42, 157, 158, 159, 160, 161, 162, 163,
  155, 100, 164,
);

/** 2026-10-30 晚：被併入的文章 → 主文（站內連結都改指主文）。 */
const MERGED_INTO_1030N: Record<string, string> = {
  'wiki-63': 'wiki-203', 'wiki-28': 'wiki-203', 'wiki-65': 'wiki-204', 'wiki-149': 'wiki-204', 'wiki-201': 'wiki-165',
  'wiki-51': 'wiki-71', 'wiki-218': 'wiki-71', 'wiki-140': 'wiki-106', 'wiki-22': 'wiki-50', 'wiki-98': 'wiki-50',
  'wiki-141': 'wiki-50', 'wiki-34': 'wiki-50', 'wiki-93': 'wiki-90', 'wiki-91': 'wiki-90', 'wiki-92': 'wiki-90',
  'wiki-202': 'wiki-90', 'wiki-111': 'wiki-176', 'wiki-104': 'wiki-176', 'wiki-33': 'wiki-175', 'wiki-213': 'wiki-175',
  'wiki-210': 'wiki-177', 'wiki-48': 'wiki-177', 'wiki-39': 'wiki-177', 'wiki-215': 'wiki-170', 'wiki-30': 'wiki-24',
  'wiki-117': 'wiki-24', 'wiki-75': 'wiki-205', 'wiki-8': 'wiki-205', 'wiki-214': 'wiki-206', 'wiki-44': 'wiki-148',
  'wiki-179': 'wiki-38', 'wiki-151': 'wiki-147', 'wiki-78': 'wiki-208', 'wiki-219': 'wiki-27', 'wiki-94': 'wiki-62',
  'wiki-23': 'wiki-62', 'wiki-212': 'wiki-109', 'wiki-1': 'wiki-32', 'wiki-45': 'wiki-35', 'wiki-134': 'wiki-52',
  'wiki-42': 'wiki-41', 'wiki-157': 'wiki-156', 'wiki-158': 'wiki-156', 'wiki-159': 'wiki-156', 'wiki-160': 'wiki-156',
  'wiki-161': 'wiki-156', 'wiki-162': 'wiki-156', 'wiki-163': 'wiki-156', 'wiki-155': 'wiki-182', 'wiki-100': 'wiki-153',
  'wiki-164': 'wiki-153',
};

/** 2026-10-29: main article ← the articles merged into it (each main ends with 「本文整合自」 naming them). */
// 2026-10-30 晚：wiki-23 併進 wiki-62、wiki-39 併進 wiki-177，舊的整合紀錄跟著搬到新的主文。
const MERGES_1029: [string, string[]][] = [
  ['wiki-57', ['五人局視角區間範例', '區間派票法之變體 (點/夾/跳)']],
  ['wiki-18', ['外灑與外灑出任務後的區間解讀']],
  ['wiki-24', ['3 家對 1AB, 2CD 之後的解讀與反饋']],
  ['wiki-62', ['填空型派票分析']],
  ['wiki-50', ['能力者與超前資訊的條件關係']],
  ['wiki-38', ['牌局範例: 異常票(內黑外白)']],
  ['wiki-177', ['壞人的數量']],
];

/**
 * 2026-10-30 Edward 裁定（B10／E15／E6／E11／E16）：main article ← the articles merged into it. wiki-144（邏輯一致性，含〈雙重假設〉）
 * 併進 wiki-26，所以原本 MERGES_1029 的 wiki-144 那一條改由 wiki-26 承接。
 */
const MERGES_1030: [string, string[]][] = [
  ['wiki-26', ['優勢與劣勢策略 - 選在多數情境都成立的派票', '邏輯一致性', '雙重假設']],
  ['wiki-24', ['3 家對 1AB, 2CD 之後的解讀與反饋', '解讀前人派票（二） - 第二層思考', '解讀前人派票（三） - 分類與反饋']],
  ['wiki-25', ['雜談 - 派一個人時要不要參考他的派票']],
  ['wiki-182', ['積分賽計分方式（10 人局）', '戰績報表（外部試算表）']],
  ['wiki-62', ['平衡策略與反邊填空']],
  ['wiki-209', ['牌譜數據報告（2,146 局，資料至 2026-02）']],
];

/** 2026-10-30 晚：全站章節重新整併。主文 ← 併入的文章（主文最後一行「本文整合自」列出它們）。 */
const MERGES_1030N: [string, string[]][] = [
  ['wiki-203', ['遊戲基本規則與流程', '阿瓦隆的故事背景']],
  ['wiki-204', ['牌譜記錄格式 - 怎麼記錄一場阿瓦隆', '名詞 - 派票與發言的動作用語']],
  ['wiki-165', ['藍方基礎原則']],
  ['wiki-71', ['阿瓦隆與狼人殺等陣營遊戲的比較', '什麼時候該說話、說什麼 - 派票為主、發言為輔']],
  ['wiki-106', ['資訊的來源與驗證']],
  ['wiki-50', ['如何分辨好人能力者與壞人能力者', '自我修正與前後矛盾的差別', '身分光譜', '沒人派你時怎麼辦']],
  ['wiki-90', ['常見錯誤 - 黑白球投票', '常見錯誤 - 湖中女神', '常見錯誤 - 遊戲觀念', '常見錯誤 - 遊戲品格']],
  ['wiki-176', ['派西為什麼不要盲採拇指', '為什麼不建議跳派西']],
  ['wiki-175', ['梅林如何讓內建資訊和雜魚視角同步', '梅林可以派拇指嗎 - 順應局勢，不是為了躲刺']],
  ['wiki-177', ['紅方進任務 - 出失敗還是出成功', '紅方何時要派隊友', '壞人最常露餡的兩件事 - 同區間買票與壞人數算錯']],
  ['wiki-170', ['莫甘娜與莫德雷德的深度玩法 - 騙派西、騙梅林']],
  ['wiki-166', ['莫甘娜與莫德雷德的深度玩法 - 騙派西、騙梅林']],
  ['wiki-24', ['有意識的派票', '覆盤 - 照派與跟派的牌局範例']],
  ['wiki-205', ['1 家（首位隊長）的開局策略', '從 1-1 到 2-5 - 每個派票位置的任務']],
  ['wiki-206', ['尾家的決策 - 控尾、洗尾與保尾']],
  ['wiki-148', ['異常票基礎 - 內黑與外白的意義']],
  ['wiki-38', ['外白進階 - 動機、時機與實戰']],
  ['wiki-147', ['名詞 - 湖中女神（湖上夫人）']],
  ['wiki-208', ['第一局開藍、第二局三加一開紅後的湖中']],
  ['wiki-27', ['思考的層次 - 三層是極限']],
  ['wiki-62', ['平滑與極化 - 風險與報酬', '反邊填空 - 平衡打法的極端']],
  ['wiki-109', ['阿瓦隆常用機率速算表 - 10 人局挑人全好與沒拇指的機率']],
  ['wiki-32', ['覆盤 - 5 家奧伯倫在 1-5 要不要炸車']],
  ['wiki-35', ['覆盤 - 積極型 vs 保守型派票（3 家雜魚）']],
  ['wiki-52', ['覆盤 - 為什麼 247 會被打成壞人']],
  ['wiki-41', ['覆盤 - 牌譜集：十人局實戰紀錄（二）']],
  ['wiki-156', ['賽事回顧可以學到的原理 - 從 S1 九場帶走的十條', 'S1 新人挑戰賽 - 第 1 集回顧（2023-08-15）', 'S1 新人挑戰賽 - 決賽回顧（2023-09-28）']],
  ['wiki-182', ['線上實戰賽 S2（無差別亂鬥）總覽（2023）']],
  ['wiki-153', ['成為阿瓦隆專家 - 從入門到放棄全攻略', '社群金句']],
];

/**
 * 2026-10-29: articles split off a source that bundled two topics. 2026-10-30 晚：分出來的兩篇再併成主文的一節
 * （〈藍方基礎原則〉→〈角色總覽〉、〈常見錯誤 - 遊戲品格〉→〈常見錯誤〉），原來的來源不再帶著它們。
 */
const SPLITS_1029 = [
  { source: 'wiki-106', sourceTitle: /入門行動方針/, id: 'wiki-201', into: 'wiki-165', heading: '## 藍方基礎原則' },
  { source: 'wiki-90', sourceTitle: /^常見錯誤/, id: 'wiki-202', into: 'wiki-90', heading: '## 遊戲品格' },
];

const DOCS = path.resolve(__dirname, '..', '..', '..', '..', 'docs', 'avalon-wiki');
const MERGED_HARDCODED_IDS = [
  'roles-merlin', 'roles-percival', 'roles-loyal', 'roles-oberon', 'roles-assassin', 'strategies-assassination',
  'roles-morgana', 'roles-mordred', 'strategies-red-basic', 'beginner-guide', 'strategies-info-priority',
  'beginner-mistakes', 'glossary-basic', 'glossary-lake', 'glossary-combat', 'rules-voting', 'rules-overview',
  'rules-flow', 'strategies-zone-voting',
];

/**
 * The hard-coded 「X數據解析」 pieces. 2026-10-30: their numbers come from the live stats card (RoleStatsCard,
 * same source and definitions as the analytics page); the old static data/roleStats.ts counted 三藍死 as a good win.
 */
const DATA_ARTICLE_IDS = WIKI_ARTICLES.filter((a) => /^strategy-[a-z]+-data$/.test(a.id)).map((a) => a.id);


/** 2026-10-30 全站重寫（內容維持、標點統一全形、論點加層級標記）：比對原文時忽略空白、標點與層級標記。 */
const loose = (t: string): string =>
  t.replace(/【[^】]*】/g, '').replace(/[\s,，、。.:：;；!！?？"'「」『』()（）\[\]*`/／＝=＞>]/g, '');

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
    // 2026-10-30 Edward 裁定：補完的那幾篇不再待完成（之後被併入的，看主文）
    for (const id of FINISHED_1030) expect(isWikiPending(jsonById.get(MERGED_INTO_1030N[id] ?? id)!), id).toBe(false);
    const wrong = TRIAGED_PENDING.filter((id) => {
      const a = jsonById.get(id);
      return a ? !isWikiPending(a) : !MERGED_JSON_IDS.includes(id);
    });
    expect(wrong).toEqual([]);
    // 資訊的來源與驗證 took in the empty 資訊來源 half; 2026-10-30 晚 it became a section of 入門行動方針
    expect(jsonById.has('wiki-140')).toBe(false);
    expect(jsonById.get('wiki-106')!.content).toMatch(/^## 資訊的來源與驗證$/m);
  });

  it('the 數據解析 articles read the live stats and hard-code no numbers', () => {
    expect(DATA_ARTICLE_IDS).toHaveLength(7);
    for (const id of DATA_ARTICLE_IDS) {
      const a = WIKI_ARTICLES.find((x) => x.id === id)!;
      expect(isWikiPending(a), id).toBe(false);
      // the live card is shown for every one of them, for a role the card knows
      expect(WIKI_ROLE_NAMES[WIKI_DATA_ARTICLE_ROLE[id]], id).toBeDefined();
      for (const text of [a.title, a.excerpt, a.content]) {
        // no stale sample sizes or win rates (the old static numbers: 2146 局、62.3%…)
        expect(text, id).not.toMatch(/2,?146|\d+\.\d+ ?%/);
      }
      // the outcome definition the site uses: 好人勝＝三藍活；三藍死算紅方贏
      expect(a.content, id).toMatch(/三藍死算紅方贏/);
      expect(a.content, id).toMatch(/好人勝＝三藍活/);
    }
    expect(Object.keys(WIKI_DATA_ARTICLE_ROLE).sort()).toEqual([...DATA_ARTICLE_IDS].sort());
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
      expect(jsonById.get(id)!.content, id).toMatch(/^#{1,2} 角色能力$/m);
    }
  });

  it('莫甘娜 does not carry the 「演好假梅林」 advice', () => {
    expect(jsonById.get('wiki-170')!.content).not.toMatch(/假梅林|讓派西維爾 ?誤認你是梅林/);
  });

  it('覆盤 articles are titled by what they teach; the game code opens the article', () => {
    // 2026-10-30 標題盤點：數字代碼看不出內容，標題改成「覆盤 - 情境＋重點」，代碼（模擬／面瓦 + 角色位置）移到內文第一行。
    // 2026-10-30 Edward 裁定（E1／E17）：手寫牌譜集（wiki-41／42）與多場片段的範例（wiki-117）也放覆盤，沒有六碼代碼時第一行寫來源；
    // 〈牌譜記錄格式〉（wiki-65）原本是覆盤分類的導言，2026-10-30 晚併進〈牌譜記錄格式與常用術語〉（wiki-204，規則與名詞）。
    // 同一天「覆盤」改成「覆盤與賽事」：賽事的兩篇（S1 回顧、積分賽）不是單場覆盤，不套這條。
    const EVENTS = ['wiki-156', 'wiki-182'];
    const replays = jsonArticles.filter((a) => a.category === 'replays' && !EVENTS.includes(a.id));
    expect(replays.length).toBeGreaterThan(0);
    for (const id of EVENTS) expect(jsonById.get(id)!.category).toBe('replays');
    for (const a of replays) {
      expect(a.title).toMatch(/^覆盤 - \S/);
      expect(a.title).not.toMatch(/\d{6}/);
      const body = a.content.replace(/^(?:\s*---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$))+/, '');
      expect(body, a.id).toMatch(/^> 牌局代碼：(?:(模擬|面瓦) \d{6}|牌譜集（手寫原稿還原）|牌局片段（[^）\n]+）)/);
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
    for (const [id, sources] of [...MERGES_1029, ...MERGES_1030, ...MERGES_1030N]) {
      const lines = jsonById.get(id)!.content.trimEnd().split('\n');
      const note = lines[lines.length - 1];
      expect(note, id).toMatch(/^> 本文整合自/);
      for (const s of sources) expect(loose(note), id).toContain(loose(`〈${s}〉`));
    }
  });

  it('a merge keeps the merged text (a sample line from each source is in the main article)', () => {
    // 2026-10-30 全站重寫後的寫法（意思不變；原句見 git 歷史）
    const samples: Record<string, string[]> = {
      'wiki-57': ['只有 5 家是好人時，才有「1 鐵好」的視角', '379 ⇒ 夾 8，給出 [0, 1, 2]、[4, 5, 6] 兩個區間'],
      'wiki-18': ['白話就是常聽到的: 場內至少一壞, 場外白區間, 場外黑球區間', '外灑至少做到「洗掉壞人尾派」這件事'],
      'wiki-24': ['尊重 = 參考', '修正「通常」代表認為 A、C 至少有一壞'],
      // 2026-10-30 晚：〈反邊填空〉併進 wiki-62
      'wiki-62#23': ['直接派反邊是沒有經過思考的表現', '不能是尾派'],
      // 2026-10-30 Edward 裁定（E16）：〈平衡策略與反邊填空〉拆開，平衡策略併進 wiki-62〈大局觀 - 平衡與廣泛性〉
      'wiki-62': ['讓梅林有機會拔掉被疊票的拇指', '萬一派西把雙拇指認錯？'],
      'wiki-50': ['結論: 只有 1, 2, 4, 8 這幾條描述 (推論) 是正確的', '刻意本身就是能力的展現'],
      'wiki-38': ['8外白: 可以考慮兩種狀況', '換個角度：若 8 是梅林，會做這個動作嗎？'],
      // 2026-10-30 晚：〈壞人最常露餡的兩件事〉併進 wiki-177
      'wiki-177#39': ['就等於 8 家自己告訴大家：壞人是 8 家', '0 一定會派自己'],
      // 〈邏輯一致性〉（含〈雙重假設〉）2026-10-30 併進 wiki-26
      'wiki-26': ['定義：當兩件事情的敘述彼此不相關時，就稱為雙重假設', '嚴格優勢策略'],
      'wiki-24': ['因此可能出現「非延伸也非修正」的派票', '79 幾乎不能派，34 應該會有最後一隻', '隊伍外資訊：沒被選的區間、被閃躲的人選、被看到的人選'],
      'wiki-25': ['紅方派票不會每次都疊隊友'],
      'wiki-182': ['刺客指認梅林錯誤：梅林 +5 分', '本站目前不計分', '三紅：53.3%（16 場）'],
      // 2026-10-30 晚：全站章節重新整併
      'wiki-203': ['邪惡能看清自己，梅林卻關照未來', '雜魚多嘗試不同組合，以分散風險', '以「永恆之王」為故事劇本'],
      'wiki-204': ['光是角色 × 位置的排列，就有 15 萬種組合', '鐵咬是視角的呈現'],
      'wiki-165': ['在有足夠資訊（`派票`）之前，不要直接選（`採`）你的雙拇指'],
      'wiki-71': ['阿瓦隆中發言好但派錯票的人是壞人', '有用的話只有一種'],
      'wiki-106': ['區間是否「錯誤」可以被驗證；但區間假設是否「正確」不能被驗證'],
      'wiki-50': ['好的壞人不會給正確的區間資訊', '如何區分自我修正和前後矛盾', '注意場上的好壞人總數', '如果場上風向要你當場外第六好，適時開白'],
      'wiki-90': ['黑白球機器人', '鐵好拿到湖中，湖另一個鐵壞', '花時間研究、覆盤資訊不足的牌譜', '嫌不想跟他玩的人太少'],
      'wiki-176': ['盲採的那根拇指是可見紅方（莫甘娜）的機率 1/2 = 50%', '你有理由跳派，我也有理由不信你'],
      'wiki-175': ['3 混雜了 1、2 的派票', '派之前先問：**這根拇指在組合裡有什麼作用？出任務了怎麼辦？之後怎麼引導出來？**'],
      'wiki-177': ['位階法本來就包含「出者恆出、藏者恆藏、後進者出」', '大家都說他是壞人，沒必要特別保住他'],
      'wiki-170': ['莫甘娜可以把一位忠臣做成梅林眼中的莫德雷德', '不用每一場都刻意演梅林，順勢而為就好'],
      'wiki-166': ['表好的尺度：一個坐在你位置的忠臣，用公開資訊也派得出來'],
      'wiki-24#30': ['不存在純隨機的派票', '照派的幾乎都是能力者'],
      'wiki-205': ['1 家外灑三人：三人全好的機率約 12%（10/84）', '整場遊戲最難的位置'],
      'wiki-206': ['洗尾：讓前面的組合先過，尾家沒機會派'],
      'wiki-148': ['外白過多不具任何意義，只會被紅方利用'],
      'wiki-38#179': ['尾家魔術師？', '成功不必在自己，場外的第六好往往才是能不能三藍的關鍵'],
      'wiki-147': ['藍卡：金色徽章，中間有龍紋，代表正義方，也就是好人'],
      'wiki-208': ['若結果是兩張任務失敗，絕對不能湖原組合'],
      'wiki-27': ['不要每次都想到大氣層，也不要認為場上的人可以想到積雲層'],
      'wiki-62#94': ['資訊越偏向模糊、粗糙，就屬於「**平滑**」，容錯率越高'],
      'wiki-109': ['從 6 個沒拇指的人挑 k 人，全好 = (6 − k) ÷ 6'],
      'wiki-32': ['最差的做法是用嘴巴直接喊炸車'],
      'wiki-35': ['錯了沒有關係，只要你的想法被認下，就會有人把你撿起來'],
      'wiki-52': ['為什麼 247 不好：沒有展現視角'],
      'wiki-41': ['第 10 場（未完，可當練習題）'],
      'wiki-156': ['3 家刺客看著 2 家奧伯倫派出自己視野中的全好', '本場最佳玩家：豬羊（9 - 派西維爾）'],
      'wiki-153': ['看一個人的強度，是看他玩好人', '依角色找文章'],
    };
    for (const [key, lines] of Object.entries(samples)) {
      const id = key.split('#')[0];
      for (const l of lines) expect(loose(jsonById.get(id)!.content), `${key}: ${l}`).toContain(loose(l));
    }
  });

  it('split-off articles are one section of their new main article, and the old source no longer carries them', () => {
    for (const s of SPLITS_1029) {
      const src = jsonById.get(s.source)!;
      const main = jsonById.get(s.into)!;
      expect(src.title).toMatch(s.sourceTitle);
      expect(jsonById.has(s.id)).toBe(false);
      expect(main.content.split(`\n${s.heading}\n`)).toHaveLength(2);
      expect(isWikiPending(main)).toBe(false);
    }
    expect(jsonById.get('wiki-106')!.content).not.toContain('\n## 藍方基礎原則\n');
    expect(jsonById.get('wiki-165')!.category).toBe('roles');
  });

  it('links never point at a merged article (2026-10-30 晚 every link was moved to the main article)', () => {
    const merged = new Set(MERGED_JSON_IDS);
    const bad: string[] = [];
    for (const a of [...jsonArticles, ...WIKI_ARTICLES]) {
      for (const m of a.content.matchAll(/\]\(wiki:([^)\s]+)\)/g)) if (merged.has(m[1])) bad.push(`${a.id} → ${m[1]}`);
    }
    expect(bad).toEqual([]);
    for (const [from, to] of Object.entries(MERGED_INTO_1030N)) {
      expect(jsonById.has(from), from).toBe(false);
      expect(jsonById.has(to), to).toBe(true);
    }
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
    // 2026-10-30 晚：併入別篇的文章，副本一起移除；主文的副本換成整併後的內容。
    const files: Record<string, string> = {
      '派票策略/視角與區間派票法.md': 'wiki-57',
      '派票策略/外灑相關討論.md': 'wiki-18',
      '進階思考/延伸與修正.md': 'wiki-24',
      '進階思考/遊戲分支與廣泛性.md': 'wiki-62',
      '入門基礎/能力者.md': 'wiki-50',
      '湖中與投票/為什麼不該亂開場外白球.md': 'wiki-38',
      '角色/紅方基礎原則.md': 'wiki-177',
      '入門基礎/入門行動方針.md': 'wiki-106',
      '入門基礎/常見錯誤 - 任務派票.md': 'wiki-90',
      '入門基礎/阿瓦隆名詞介紹 - 黑白球投票.md': 'wiki-148',
      '入門基礎/阿瓦隆名詞介紹 - 任務牌指派.md': 'wiki-150',
      '入門基礎/阿瓦隆入門前言.md': 'wiki-71',
      '角色/派西維爾.md': 'wiki-176',
      '角色/梅林.md': 'wiki-175',
      '湖中與投票/內黑的使用.md': 'wiki-11',
    };
    for (const [file, id] of Object.entries(files)) {
      expect(fs.readFileSync(path.join(DOCS, file), 'utf-8').trim(), file).toBe(jsonById.get(id)!.content.trim());
    }
    const gone = [
      '入門基礎/新手常見錯誤.md', '入門基礎/名詞說明與簡稱.md', '派票策略/五人局視角區間範例.md',
      '派票策略/區間派票法之變體 (點_夾_跳).md', '派票策略/外灑與外灑出任務後的區間解讀.md', '派票策略/填空型派票分析.md',
      '派票策略/壞人的數量.md', '進階思考/雙重假設.md',
      // 2026-10-30 Edward 裁定：併入或刪除的文章，副本一起移除
      '進階思考/邏輯一致性.md', '進階思考/優勢策略.md', '進階思考/第二層思考-派票的延伸與拓展.md', '進階思考/雜談.md',
      '進階思考/觀念1.md', '入門基礎/計分機制.md',
      // 2026-10-30 晚：全站章節重新整併
      '派票策略/平衡策略.md', '派票策略/為什麼知道你是壞人.md', '角色/藍方基礎原則.md', '入門基礎/常見錯誤 - 湖中女神.md',
      '入門基礎/常見錯誤 - 遊戲觀念.md', '入門基礎/常見錯誤 - 遊戲品格.md', '入門基礎/常見錯誤 - 黑白球投票.md',
      '入門基礎/阿瓦隆名詞介紹 - 動作相關.md', '入門基礎/阿瓦隆名詞介紹 - 湖中女神.md', '入門基礎/遊戲基本規則與流程.md',
      '入門基礎/故事背景.md', '入門基礎/遊戲紀錄.md', '入門基礎/與其他陣營遊戲的比較.md',
      '入門基礎/為什麼不建議宣稱自己是派西維爾 (跳派).md', '派票策略/為什麼派西維爾不要賭博盲採拇指.md',
      '派票策略/有意識的派票.md', '派票策略/沒票的邊緣人.md', '湖中與投票/外白.md', '湖中與投票/異常票基礎篇.md',
      '湖中與投票/三加一後的湖中女神使用.md', '角色/紅方何時要派隊友.md', '進階思考/位置的思考要點和遊戲的起承轉合.md',
      '進階思考/如何分辨好壞能力者.md', '進階思考/梅林資訊與雜魚視角的同步.md', '進階思考/資訊的來源與驗證.md',
      '進階思考/忠臣_平民_雜魚的自我修正.md', '進階思考/身份光譜(拖稿中).md', '覆盤/覆盤_模擬_916524.md',
      '覆盤/覆盤_模擬_810964.md', '覆盤/覆盤_模擬_927306.md',
    ];
    expect(gone.filter((f) => fs.existsSync(path.join(DOCS, f)))).toEqual([]);
  });
});
