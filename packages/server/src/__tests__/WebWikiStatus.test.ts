/**
 * 百科文章的分類、「待完成」狀態與合併（Edward 2026-10-28：只有標題或寫一半的文章放到待完成；
 * 重複的文章照盤點合併；2026-11-11：「文章值得重整合併的也可以順便一起做調整，不然感覺現在文章數量有點多」，57 → 40 篇）。
 * Data: packages/server/wiki_data.json (served by /api/analysis/wiki) and packages/web/src/data/wiki.ts.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  WIKI_ARTICLES,
  WIKI_ARTICLE_ROLE,
  WIKI_CATEGORIES,
  WIKI_ROLE_NAMES,
  WIKI_STATUSES,
  isWikiPending,
  mergeWikiArticles,
} from '../../../web/src/data/wiki';
import { WIKI_MERGED_INTO_1030N, WIKI_MERGED_INTO_1111, WIKI_REDIRECTS, resolveWikiRedirect } from '../../../web/src/data/wikiRedirects';
import { hasWikiSection, resolveWikiSection, wikiHeadings } from '../../../web/src/utils/wikiSections';

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
  // 2026-11-11 站長：文章數量有點多，值得的就合併（49 → 40 篇；見 MERGES_1111）
  211, 4, 2, 54, 11, 208, 62, 35, 52,
);

/**
 * 2026-10-30 晚：被併入的文章 → 主文（站內連結都改指主文）。2026-11-11 起這張表在 web/src/data/wikiRedirects.ts
 * （WIKI_MERGED_INTO_1030N，網站照它轉址）；當時的主文又被併入別篇的（wiki-62 → 26、wiki-208 → 147、wiki-35／52 → 32），
 * 直接指到最後的主文。這裡留原本的對照，確認轉址表沒有漏掉、也真的指到同一篇或它後來併入的那篇。
 */
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

/**
 * 2026-11-11 站長「文章值得重整合併的也可以順便一起做調整，不然感覺現在文章數量有點多」：被併入的文章 → 主文。
 * 寫死在前端的〈新手常見問題〉與七篇〈角色數據〉也併進 wiki_data.json 的主文（WIKI_ARTICLES 變成空的）。
 */
const MERGED_INTO_1111: Record<string, string> = {
  'faq-basic': 'wiki-217', 'wiki-211': 'wiki-66', 'wiki-4': 'wiki-72', 'wiki-2': 'wiki-205', 'wiki-54': 'wiki-18',
  'wiki-11': 'wiki-148', 'wiki-208': 'wiki-147', 'wiki-62': 'wiki-26', 'wiki-35': 'wiki-32', 'wiki-52': 'wiki-32',
  'strategy-merlin-data': 'wiki-175', 'strategy-percival-data': 'wiki-176', 'strategy-loyal-data': 'wiki-25',
  'strategy-morgana-data': 'wiki-170', 'strategy-mordred-data': 'wiki-166', 'strategy-oberon-data': 'wiki-21',
  'strategy-assassin-data': 'wiki-12',
};
/** Where a 2026-10-30 main article went on 2026-11-11 (itself when it stayed). */
const now = (id: string): string => MERGED_INTO_1111[id] ?? id;

/** 2026-10-29: main article ← the articles merged into it (each main ends with 「本文整合自」 naming them). */
// 2026-10-30 晚：wiki-23 併進 wiki-62、wiki-39 併進 wiki-177，舊的整合紀錄跟著搬到新的主文。
// 2026-11-11：wiki-62 併進 wiki-26，它的整合紀錄跟著搬過去。
const MERGES_1029: [string, string[]][] = [
  ['wiki-57', ['五人局視角區間範例', '區間派票法之變體 (點/夾/跳)']],
  ['wiki-18', ['外灑與外灑出任務後的區間解讀']],
  ['wiki-24', ['3 家對 1AB, 2CD 之後的解讀與反饋']],
  ['wiki-26', ['填空型派票分析']],
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
  ['wiki-26', ['平衡策略與反邊填空']],
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
  ['wiki-147', ['第一局開藍、第二局三加一開紅後的湖中']],
  ['wiki-27', ['思考的層次 - 三層是極限']],
  ['wiki-26', ['平滑與極化 - 風險與報酬', '反邊填空 - 平衡打法的極端']],
  ['wiki-109', ['阿瓦隆常用機率速算表 - 10 人局挑人全好與沒拇指的機率']],
  ['wiki-32', ['覆盤 - 5 家奧伯倫在 1-5 要不要炸車']],
  ['wiki-32', ['覆盤 - 積極型 vs 保守型派票（3 家雜魚）']],
  ['wiki-32', ['覆盤 - 為什麼 247 會被打成壞人']],
  ['wiki-41', ['覆盤 - 牌譜集：十人局實戰紀錄（二）']],
  ['wiki-156', ['賽事回顧可以學到的原理 - 從 S1 九場帶走的十條', 'S1 新人挑戰賽 - 第 1 集回顧（2023-08-15）', 'S1 新人挑戰賽 - 決賽回顧（2023-09-28）']],
  ['wiki-182', ['線上實戰賽 S2（無差別亂鬥）總覽（2023）']],
  ['wiki-153', ['成為阿瓦隆專家 - 從入門到放棄全攻略']],
];

/** 2026-11-11：主文 ← 併入的文章（主文最後一行「本文整合自」列出它們）。 */
const MERGES_1111: [string, string[]][] = [
  ['wiki-217', ['新手常見問題（規則篇）']],
  ['wiki-66', ['標記說明 - 邏輯與經驗']],
  ['wiki-72', ['社群問答集（進階）']],
  ['wiki-205', ['第一局開藍後 - 三加一還是拆車（混合策略）']],
  ['wiki-18', ['覆盤 - 派西與雜魚如何解讀 1 家的外灑']],
  ['wiki-148', ['內黑的用途']],
  ['wiki-147', ['湖中進階 - 一藍一紅、依比分湖誰、最後一湖與能力湖']],
  ['wiki-26', ['大局觀 - 平衡、廣泛性、平滑與極化']],
  ['wiki-32', ['覆盤 - 3 家的派票：梅林被前置位夾住、雜魚積極還是保守', '覆盤 - 5 家雜魚怎麼讀前四家的派票（連續能力派、247 被打成壞人）']],
  ['wiki-175', ['角色數據 - 梅林']],
  ['wiki-176', ['角色數據 - 派西維爾']],
  ['wiki-25', ['角色數據 - 忠臣']],
  ['wiki-170', ['角色數據 - 莫甘娜']],
  ['wiki-166', ['角色數據 - 莫德雷德']],
  ['wiki-21', ['角色數據 - 奧伯倫']],
  ['wiki-12', ['角色數據 - 刺客']],
];

/** 2026-11-11：每個分類由上而下的閱讀線（wiki_data.json 的順序；文章結尾的系列導覽照這個順序）。 */
const READING_LINES: Record<string, string[]> = {
  rules: wiki(203, 216, 204, 217),
  beginner: wiki(71, 66, 106, 50, 90, 72),
  roles: wiki(165, 25, 176, 175, 177, 170, 166, 21, 12),
  strategies: wiki(150, 57, 24, 18, 205, 206, 207),
  voting: wiki(148, 38, 147),
  advanced: wiki(26, 27, 109),
  replays: wiki(156, 32, 56, 41, 182),
  data: wiki(209, 40),
  about: wiki(153),
};

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
  // 2026-11-11：最後的寫死文章也併進 wiki_data.json 的主文
  'faq-basic', 'strategy-merlin-data', 'strategy-percival-data', 'strategy-loyal-data', 'strategy-morgana-data',
  'strategy-mordred-data', 'strategy-oberon-data', 'strategy-assassin-data',
];

/** The `## <heading>` section of an article (up to the next heading of the same or a higher level). */
function sectionOf(content: string, heading: string): string {
  const lines = content.split('\n');
  const i = lines.findIndex((l) => new RegExp(`^(#{1,6}) ${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`).test(l));
  if (i < 0) return '';
  const level = /^#+/.exec(lines[i])![0].length;
  let j = i + 1;
  while (j < lines.length && !(/^#{1,6} /.test(lines[j]) && /^#+/.exec(lines[j])![0].length <= level)) j++;
  return lines.slice(i, j).join('\n');
}

/** `[x](wiki:<id>#<section>)〈cite〉` links of an article. */
const LINK_RE = /\]\(wiki:([^)\s#]+)(?:#([^)\s]*))?\)(?:〈([^〉]*)〉)?/g;


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
    for (const id of FINISHED_1030) expect(isWikiPending(jsonById.get(resolveWikiRedirect(id)?.id ?? id)!), id).toBe(false);
    const wrong = TRIAGED_PENDING.filter((id) => {
      const a = jsonById.get(id);
      return a ? !isWikiPending(a) : !MERGED_JSON_IDS.includes(id);
    });
    expect(wrong).toEqual([]);
    // 資訊的來源與驗證 took in the empty 資訊來源 half; 2026-10-30 晚 it became a section of 入門行動方針
    expect(jsonById.has('wiki-140')).toBe(false);
    expect(jsonById.get('wiki-106')!.content).toMatch(/^## 資訊的來源與驗證$/m);
  });

  it('each role article reads its live stats card in 〈實戰數據怎麼讀〉 and hard-codes no numbers there', () => {
    // 2026-10-30：數字來自即時數據卡（RoleStatsCard，口徑同數據分析頁；舊的 data/roleStats.ts 把三藍死算成好人贏）。
    // 2026-11-11：七篇寫死的〈角色數據〉併進各角色文章：玩法原則成為開頭的〈重點摘要〉，讀法成為〈實戰數據怎麼讀〉，數據卡緊接在它後面。
    expect(WIKI_ARTICLES).toEqual([]);
    expect(Object.keys(WIKI_ARTICLE_ROLE)).toHaveLength(7);
    for (const [id, role] of Object.entries(WIKI_ARTICLE_ROLE)) {
      const a = jsonById.get(id)!;
      expect(isWikiPending(a), id).toBe(false);
      expect(WIKI_ROLE_NAMES[role], id).toBeDefined();
      const stats = sectionOf(a.content, '實戰數據怎麼讀');
      expect(stats, id).toMatch(/^## 實戰數據怎麼讀\n/);
      expect(stats, id).toContain(`「${WIKI_ROLE_NAMES[role]}實戰數據（即時）」`);
      // no stale sample sizes or win rates (the old static numbers: 2146 局、62.3%…)
      expect(stats, id).not.toMatch(/2,?146|\d+\.\d+ ?%/);
      // the outcome definition the site uses: 好人勝＝三藍活；三藍死算紅方贏
      expect(stats, id).toMatch(/三藍死算紅方贏/);
      expect(stats, id).toMatch(/好人勝＝三藍活/);
      expect(stats, id).toContain('wiki:wiki-209#');
      // something follows the section (the card sits between it and 延伸閱讀／系列)
      expect(a.content.indexOf(stats) + stats.length, id).toBeLessThan(a.content.trimEnd().length);
      // 重點摘要 opens the article, before 角色能力 and the body
      const heads = wikiHeadings(a.content).map((h) => h.text);
      expect(heads[1], id).toBe('重點摘要');
      expect(sectionOf(a.content, '重點摘要'), id).toMatch(/\(wiki:wiki-\d+#/);
    }
    // the loyal-only seat note (n counts player-games, about 4 per game) stays with the loyal servant
    expect(sectionOf(jsonById.get('wiki-25')!.content, '實戰數據怎麼讀')).toMatch(/十分之四/);
    // the shared reading notes moved to 〈如何正確解讀阿瓦隆數據〉
    const guide = jsonById.get('wiki-209')!.content;
    for (const s of ['「0 家」＝10 號', '本站說的前置位是 1–4 號', '比率在 30%～70% 之間時', '全部對局、1–10 號位，每日更新']) expect(guide).toContain(s);
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
    for (const [id, sources] of [...MERGES_1029, ...MERGES_1030, ...MERGES_1030N, ...MERGES_1111]) {
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
      // 2026-10-30 晚：〈反邊填空〉併進 wiki-62；2026-11-11 wiki-62 併進 wiki-26
      'wiki-26#23': ['直接派反邊是沒有經過思考的表現', '不能是尾派'],
      // 2026-10-30 Edward 裁定（E16）：〈平衡策略與反邊填空〉拆開，平衡策略併進 wiki-62〈大局觀 - 平衡與廣泛性〉（現在是 wiki-26〈乙〉）
      'wiki-26#62': ['讓梅林有機會拔掉被疊票的拇指', '萬一派西把雙拇指認錯？'],
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
      'wiki-147#208': ['若結果是兩張任務失敗，絕對不能湖原組合'],
      'wiki-27': ['不要每次都想到大氣層，也不要認為場上的人可以想到積雲層'],
      'wiki-26#94': ['資訊越偏向模糊、粗糙，就屬於「**平滑**」，容錯率越高'],
      'wiki-109': ['從 6 個沒拇指的人挑 k 人，全好 = (6 − k) ÷ 6'],
      'wiki-32': ['最差的做法是用嘴巴直接喊炸車'],
      'wiki-32#35': ['錯了沒有關係，只要你的想法被認下，就會有人把你撿起來'],
      'wiki-32#52': ['為什麼 247 不好：沒有展現視角'],
      'wiki-41': ['第 10 場（未完，可當練習題）'],
      'wiki-156': ['3 家刺客看著 2 家奧伯倫派出自己視野中的全好', '本場最佳玩家：豬羊（9 - 派西維爾）'],
      'wiki-153': ['加入社群', '依角色找文章'],
      // 2026-11-11 站長：文章數量有點多，值得的就合併（每篇被併入的文章抽幾句，原句見 git 歷史）
      'wiki-217#faq': ['例外：被湖中女神問到陣營時，必須說真話', '因此同一局最多只會有 4 次投票被否決', '通常不到一小時'],
      'wiki-66#211': ['推論的可信度 = 最弱的那一步', '本站不寫沒有來源的百分比', '「第四局開藍 => 組合最多一壞」'],
      'wiki-72#4': ['死亡率高低，和透露出「他是壞人」的資訊量成正比', '每 6 場就有 1 場是 50 雙壞', '平常就要練習精準定義其他玩家的身分'],
      'wiki-205#2': ['實際上無法用電腦暴力算出阿瓦隆的納許均衡解', 'a2 >> a1 > a3', '好人雜魚躺分三加一'],
      'wiki-18#54': ['即使 1 是莫甘娜，460 也很難有兩個壞人', '派 469 比 468 好，因為 468 會變成跟 279 打對邊', '刺 7、娜 5、莫 3、奧 9、派 2、梅 1'],
      'wiki-148#11': ['需要的內黑數 ＝ 隊伍人數 ＋ 場外開白的壞人數 − 5', '紅方在車上內黑，就是放棄了一次出失敗的機會', '太沉迷於神操作'],
      'wiki-147#208b': ['第二次湖中一定是有一方聽牌', '能力湖：用內建資訊、而不是公開資訊決定湖誰的湖中', '湖到莫甘娜：湖中交到紅方手上'],
      'wiki-26#62b': ['不論 7 是哪個角色，4 家都不適合再派 7', '9 家做了一個很好的示範', '如果兩隻以上 ⇒ 678 挑兩個以上（可以考慮外灑）'],
      'wiki-32#35b': ['不會派 340：怕外置位以為我認 1 拇指偏好', '如果是 560，可以順便強調 180 閃了 79 這件事'],
      'wiki-32#52b': ['先把 2368 打成兩壞以上', '234 比 238、248 好，因為對 3、4 比較沒有敵意'],
      'wiki-175#data': ['任務第一，躲刺第二', '梅林的整體數字就是藍方的整體數字', '數據分析頁「刺殺」分頁另有梅林各號位被刺中的比例與 p 值'],
      'wiki-176#data': ['不能從角色勝率推論「派西有沒有保梅林效果」', '分不出來時不要賭'],
      'wiki-25#data': ['n 是人次', '幫梅林擋刀'],
      'wiki-170#data': ['不能用三藍死（刺中）的比例推論「派西分不分得出莫甘娜」', '你在派西眼中和梅林一樣'],
      'wiki-166#data': ['紅方的最終勝率比藍方高是結構造成的', '湖中女神的風險'],
      'wiki-21#data': ['不能從角色勝率推論「奧伯倫不相認所以比較弱」', '你終究是紅方'],
      'wiki-12#data': ['刺殺結果那一格就是刺中率', '刺殺階段集合全隊的視角'],
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
    const merged = new Set([...MERGED_JSON_IDS, ...MERGED_HARDCODED_IDS]);
    const bad: string[] = [];
    for (const a of [...jsonArticles, ...WIKI_ARTICLES]) {
      for (const m of a.content.matchAll(LINK_RE)) if (merged.has(m[1])) bad.push(`${a.id} → ${m[1]}`);
    }
    expect(bad).toEqual([]);
    for (const [from, to] of Object.entries(MERGED_INTO_1030N)) {
      expect(jsonById.has(from), from).toBe(false);
      expect(jsonById.has(now(to)), to).toBe(true);
    }
  });

  it('every [標題](wiki:id) link points at an article on the site', () => {
    const ids = new Set([...jsonArticles.map((a) => a.id), ...WIKI_ARTICLES.map((a) => a.id)]);
    const broken: string[] = [];
    for (const a of jsonArticles) {
      for (const m of a.content.matchAll(LINK_RE)) if (!ids.has(m[1])) broken.push(`${a.id} → ${m[1]}`);
    }
    expect(broken).toEqual([]);
  });

  it('every #section anchor is a heading of its target, and every 〈章節〉 citation resolves to one (2026-11-11)', () => {
    const anchors: string[] = [];
    const cites: string[] = [];
    let anchored = 0;
    for (const a of jsonArticles) {
      for (const m of a.content.matchAll(LINK_RE)) {
        const target = jsonById.get(m[1]);
        if (!target) continue;
        if (m[2]) {
          anchored++;
          if (!hasWikiSection(target.content, m[2])) anchors.push(`${a.id} → ${m[1]}#${m[2]}`);
        }
        if (m[3] && resolveWikiSection(target.content, m[3]) === null) cites.push(`${a.id} → ${m[1]}〈${m[3]}〉`);
      }
    }
    expect(anchors).toEqual([]);
    expect(cites).toEqual([]);
    expect(anchored).toBeGreaterThan(100);
  });

  it('every bare 本文／本篇〈章節〉 self-citation (not a link) resolves to a heading of the same article (2026-11-11)', () => {
    // 2026-10-30 以前就有、本次沒動的：wiki-109 的〈條件機率〉指前半篇（原〈條件機率〉一文），那裡沒有同名標題。
    const KNOWN_UNRESOLVED = new Set(['wiki-109 → 本文〈條件機率〉']);
    const unresolved: string[] = [];
    let checked = 0;
    for (const a of jsonArticles) {
      for (const m of a.content.matchAll(/(?<!\[)(本文|本篇)〈([^〉]+)〉/g)) {
        checked++;
        const key = `${a.id} → ${m[1]}〈${m[2]}〉`;
        if (resolveWikiSection(a.content, m[2]) === null && !KNOWN_UNRESOLVED.has(key)) unresolved.push(key);
      }
    }
    expect(unresolved).toEqual([]);
    expect(checked).toBeGreaterThan(10);
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
      '入門基礎/能力者.md': 'wiki-50',
      '湖中與投票/為什麼不該亂開場外白球.md': 'wiki-38',
      // 2026-11-11：合併後的主文
      '入門基礎/鐵邏輯_正邏輯_反邏輯.md': 'wiki-66',
      '入門基礎/阿瓦隆快速指南.md': 'wiki-72',
      '進階思考/思考原理.md': 'wiki-26',
      '覆盤/覆盤_模擬_873164_309864_819054_921654_916524.md': 'wiki-32',
      '角色/紅方基礎原則.md': 'wiki-177',
      '入門基礎/入門行動方針.md': 'wiki-106',
      '入門基礎/常見錯誤 - 任務派票.md': 'wiki-90',
      '入門基礎/阿瓦隆名詞介紹 - 黑白球投票.md': 'wiki-148',
      '入門基礎/阿瓦隆名詞介紹 - 任務牌指派.md': 'wiki-150',
      '入門基礎/阿瓦隆入門前言.md': 'wiki-71',
      '角色/派西維爾.md': 'wiki-176',
      '角色/梅林.md': 'wiki-175',
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
      // 2026-11-11：併入別篇的文章，副本一起移除
      '進階思考/遊戲分支與廣泛性.md', '湖中與投票/內黑的使用.md', '進階思考/Avalon.md', 'QnA/阿瓦隆_Q&A_社群問答集錦.md',
      '覆盤/覆盤_模擬_753921.md', '覆盤/覆盤_模擬_816543.md', '覆盤/覆盤_模擬_823609.md',
    ];
    expect(gone.filter((f) => fs.existsSync(path.join(DOCS, f)))).toEqual([]);
  });
});

describe('wiki consolidation (2026-11-11 站長: 文章數量有點多，值得的就合併)', () => {
  it('every merged-away id redirects straight to a live article, to a heading that exists', () => {
    const expected = { ...Object.fromEntries(Object.entries(MERGED_INTO_1030N).map(([k, v]) => [k, now(v)])), ...MERGED_INTO_1111 };
    expect(Object.fromEntries(Object.entries(WIKI_REDIRECTS).map(([k, v]) => [k, v.id]))).toEqual(expected);
    expect(Object.keys(WIKI_MERGED_INTO_1111).sort()).toEqual(Object.keys(MERGED_INTO_1111).sort());
    expect(Object.keys(WIKI_MERGED_INTO_1030N).sort()).toEqual(Object.keys(MERGED_INTO_1030N).sort());
    for (const [old, to] of Object.entries(WIKI_REDIRECTS)) {
      expect(jsonById.has(old), old).toBe(false);
      expect(jsonById.has(to.id), `${old} → ${to.id}`).toBe(true);
      // no two-hop redirects
      expect(WIKI_REDIRECTS[to.id], `${old} → ${to.id}`).toBeUndefined();
      if (to.section) expect(hasWikiSection(jsonById.get(to.id)!.content, to.section), `${old} → ${to.id}#${to.section}`).toBe(true);
    }
    // the merged sections of this round are all anchored
    for (const old of Object.keys(MERGED_INTO_1111).filter((k) => k !== 'wiki-211')) expect(WIKI_MERGED_INTO_1111[old].section, old).toBeTruthy();
  });

  it('57 articles became 40; each category keeps its reading line, and every 系列 footer follows it', () => {
    expect(jsonArticles).toHaveLength(40);
    for (const c of WIKI_CATEGORIES) {
      expect(jsonArticles.filter((a) => a.category === c.id).map((a) => a.id), c.id).toEqual(READING_LINES[c.id]);
    }
    for (const [cat, ids] of Object.entries(READING_LINES)) {
      const name = WIKI_CATEGORIES.find((c) => c.id === cat)!.name;
      ids.forEach((id, i) => {
        const c = jsonById.get(id)!.content;
        const footer = c.match(/^## 系列：(.*)（第 (\d+)／(\d+) 篇）$/m);
        if (!['rules', 'beginner', 'roles', 'strategies', 'voting', 'advanced'].includes(cat)) {
          expect(footer, id).toBeNull();
          return;
        }
        expect(footer?.slice(1), id).toEqual([name, String(i + 1), String(ids.length)]);
        const list = [...sectionOf(c, `系列：${name}（第 ${i + 1}／${ids.length} 篇）`).matchAll(/^\d+\. (?:\[[^\]]*\]\(wiki:([^)]+)\)|\*\*.*\*\*（本篇）)$/gm)];
        expect(list.map((m) => m[1] ?? id), id).toEqual(ids);
      });
    }
  });

  it('merged main articles have real one-sentence excerpts and titles readers still recognise', () => {
    for (const id of new Set(Object.values(MERGED_INTO_1111))) {
      const a = jsonById.get(id) as JsonArticle & { excerpt: string };
      expect(Array.from(a.excerpt).length, id).toBeGreaterThanOrEqual(25);
      expect(a.excerpt, id).not.toMatch(/【|\]\(|^title:/);
    }
    // the old titles people search for are still in the new titles
    expect(jsonById.get('wiki-217')!.title).toContain('新手常見問題（規則篇）');
    expect(jsonById.get('wiki-72')!.title).toContain('心法語錄（各角色重點）');
    expect(jsonById.get('wiki-66')!.title).toMatch(/鐵邏輯、正邏輯與反邏輯/);
  });

  it('the unfinished parts of merged articles stay tracked with an inline 待補 marker (their articles are published)', () => {
    // wiki-4（社群問答集）與 wiki-52 原本是待完成；併進已完成的主文後，未完成的那一題／那一段用「待補」標出來
    expect(isWikiPending(jsonById.get('wiki-72')!)).toBe(false);
    expect(isWikiPending(jsonById.get('wiki-32')!)).toBe(false);
    expect(sectionOf(jsonById.get('wiki-72')!.content, 'Q：3 家好人位置最好的派票是什麼？')).toContain('（本題原稿未完成，待補）');
    expect(sectionOf(jsonById.get('wiki-32')!.content, '視角分析 2')).toContain('（原稿未完成，待補）');
  });

  it('the merged sections keep their headings, so old 〈〉 citations and anchors still resolve', () => {
    const has = (id: string, h: string) => expect(wikiHeadings(jsonById.get(id)!.content).map((x) => x.text), `${id}: ${h}`).toContain(h);
    for (const h of ['一、名詞與規則', '3.3 例外', '6.4 讀「湖誰」本身', '下篇：各比分的湖法', '十、一藍一紅：第一次湖中與下一湖', '十六、能力湖']) has('wiki-147', h);
    for (const h of ['三、異常票基礎 - 內黑與外白的意義', '四、內黑的用途', '4.3 內黑的四種用途']) has('wiki-148', h);
    for (const h of ['四、第一局開藍後：三加一還是拆車', '賽局思維（Game Theory Thinking）', '簡化策略']) has('wiki-205', h);
    for (const h of ['乙、大局觀', '平滑與極化 - 風險與報酬', '反邊填空 - 平衡打法的極端']) has('wiki-26', h);
    for (const h of ['湖中的鐵邏輯：身分高低', '五、反邏輯', '七、常見的標錯']) has('wiki-66', h);
    has('wiki-217', '新手常見問題（規則篇）');
    has('wiki-18', '牌局範例二：派西與雜魚怎麼讀 1 家的外灑');
    has('wiki-72', '三、社群問答集（進階，初學可先跳過）');
    has('wiki-32', '派票五：5 家奧伯倫在 1-5 要不要炸車（4 家梅林派 240）');
    // 〈關於阿瓦隆百科〉的學習地圖指到合併後的章節
    const about = jsonById.get('wiki-153')!.content;
    for (const link of ['wiki:wiki-217#新手常見問題（規則篇）', 'wiki:wiki-72#三、社群問答集（進階，初學可先跳過）', 'wiki:wiki-205#四、第一局開藍後：三加一還是拆車', 'wiki:wiki-175#實戰數據怎麼讀']) {
      expect(about, link).toContain(link);
    }
  });
});
