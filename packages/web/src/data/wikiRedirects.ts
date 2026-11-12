/**
 * 被併入別篇的舊文章 id → 主文（與章節錨點）。舊連結（#wiki=<舊 id>、分享網址 /w/<舊 id>/、文章裡沒改到的 wiki: 連結）
 * 都照這張表打開主文、捲到併入的那一節；錨點是主文標題的 slug（utils/wikiSections.ts）。
 *
 *  - WIKI_MERGED_INTO_1111：2026-11-11 站長「文章值得重整合併的也可以順便一起做調整，不然感覺現在文章數量有點多」：
 *    57 篇併成 40 篇（寫死在前端的〈新手常見問題〉與七篇〈角色數據〉也併進 wiki_data.json 的主文）。
 *  - WIKI_MERGED_INTO_1030N：2026-10-30 晚全站整併（100 → 49 篇）被併入的文章。當時的主文這次又被併入別篇的
 *    （wiki-62、wiki-208、wiki-35、wiki-52），一律直接指到最後的主文，不轉兩次。
 * 每個目標都必須是現存文章、錨點必須是那篇的標題（packages/server/src/__tests__/WebWikiStatus.test.ts 測）。
 */

export interface WikiRedirect {
  /** The article that now carries the old article's text. */
  id: string;
  /** Anchor of the section it became (a heading slug of that article); absent = the top of the article. */
  section?: string;
}

export const WIKI_MERGED_INTO_1111: Readonly<Record<string, WikiRedirect>> = {
  'faq-basic': { id: 'wiki-217', section: '新手常見問題（規則篇）' },
  'wiki-211': { id: 'wiki-66' },
  'wiki-4': { id: 'wiki-72', section: '三、社群問答集（進階，初學可先跳過）' },
  'wiki-2': { id: 'wiki-205', section: '四、第一局開藍後：三加一還是拆車' },
  'wiki-54': { id: 'wiki-18', section: '牌局範例二：派西與雜魚怎麼讀-1-家的外灑' },
  'wiki-11': { id: 'wiki-148', section: '四、內黑的用途' },
  'wiki-208': { id: 'wiki-147', section: '下篇：各比分的湖法' },
  'wiki-62': { id: 'wiki-26', section: '乙、大局觀' },
  'wiki-35': { id: 'wiki-32', section: '一、3-家：梅林被前半區的派票夾住、雜魚積極還是保守' },
  'wiki-52': { id: 'wiki-32', section: '三、5-家雜魚怎麼讀前四家的派票：連續能力派、247-被打成壞人' },
  'strategy-merlin-data': { id: 'wiki-175', section: '實戰數據怎麼讀' },
  'strategy-percival-data': { id: 'wiki-176', section: '實戰數據怎麼讀' },
  'strategy-loyal-data': { id: 'wiki-25', section: '實戰數據怎麼讀' },
  'strategy-morgana-data': { id: 'wiki-170', section: '實戰數據怎麼讀' },
  'strategy-mordred-data': { id: 'wiki-166', section: '實戰數據怎麼讀' },
  'strategy-oberon-data': { id: 'wiki-21', section: '實戰數據怎麼讀' },
  'strategy-assassin-data': { id: 'wiki-12', section: '實戰數據怎麼讀' },
};

export const WIKI_MERGED_INTO_1030N: Readonly<Record<string, WikiRedirect>> = {
  'wiki-63': { id: 'wiki-203' },
  'wiki-28': { id: 'wiki-203', section: '故事背景' },
  'wiki-65': { id: 'wiki-204', section: '一、怎麼記錄一場阿瓦隆' },
  'wiki-149': { id: 'wiki-204', section: '六、派票與發言的動作用語' },
  'wiki-201': { id: 'wiki-165', section: '藍方基礎原則' },
  'wiki-51': { id: 'wiki-71', section: '阿瓦隆與狼人殺等陣營遊戲的比較' },
  'wiki-218': { id: 'wiki-71', section: '什麼時候該說話、說什麼-派票為主、發言為輔' },
  'wiki-140': { id: 'wiki-106', section: '資訊的來源與驗證' },
  'wiki-22': { id: 'wiki-50', section: '如何分辨好人能力者與壞人能力者' },
  'wiki-98': { id: 'wiki-50', section: '自我修正與前後矛盾的差別' },
  'wiki-141': { id: 'wiki-50', section: '身分光譜' },
  'wiki-34': { id: 'wiki-50', section: '沒人派你時怎麼辦' },
  'wiki-93': { id: 'wiki-90', section: '黑白球投票' },
  'wiki-91': { id: 'wiki-90', section: '湖中女神' },
  'wiki-92': { id: 'wiki-90', section: '遊戲觀念' },
  'wiki-202': { id: 'wiki-90', section: '遊戲品格' },
  'wiki-111': { id: 'wiki-176', section: '派西為什麼不要盲採拇指' },
  'wiki-104': { id: 'wiki-176', section: '為什麼不建議跳派西' },
  'wiki-33': { id: 'wiki-175', section: '梅林如何讓內建資訊和雜魚視角同步' },
  'wiki-213': { id: 'wiki-175', section: '梅林可以派拇指嗎-順應局勢，不是為了躲刺' },
  'wiki-210': { id: 'wiki-177', section: '紅方進任務-出失敗還是出成功' },
  'wiki-48': { id: 'wiki-177', section: '紅方何時要派隊友' },
  'wiki-39': { id: 'wiki-177', section: '壞人最常露餡的兩件事-同區間買票與壞人數算錯' },
  'wiki-215': { id: 'wiki-170' },
  'wiki-30': { id: 'wiki-24', section: '四、有意識的派票' },
  'wiki-117': { id: 'wiki-24', section: '五、照派與跟派（牌局範例）' },
  'wiki-75': { id: 'wiki-205', section: '二、1-家（首位隊長）的開局策略' },
  'wiki-8': { id: 'wiki-205', section: '三、從-1-1-到-2-5-每個派票位置的任務' },
  'wiki-214': { id: 'wiki-206', section: '尾家的決策-控尾、洗尾與保尾' },
  'wiki-44': { id: 'wiki-148', section: '三、異常票基礎-內黑與外白的意義' },
  'wiki-179': { id: 'wiki-38', section: '外白進階-動機、時機與實戰' },
  'wiki-151': { id: 'wiki-147' },
  'wiki-78': { id: 'wiki-147', section: '十、一藍一紅：第一次湖中與下一湖' },
  'wiki-219': { id: 'wiki-27', section: '思考的層次-三層是極限' },
  'wiki-94': { id: 'wiki-26', section: '平滑與極化-風險與報酬' },
  'wiki-23': { id: 'wiki-26', section: '反邊填空-平衡打法的極端' },
  'wiki-212': { id: 'wiki-109', section: '常用機率速算表-10-人局挑人全好、沒拇指與派到可見紅方的機率' },
  'wiki-1': { id: 'wiki-32', section: '派票五：5-家奧伯倫在-1-5-要不要炸車（4-家梅林派-240）' },
  'wiki-45': { id: 'wiki-32', section: '第二場：積極型-vs-保守型派票（3-家雜魚）' },
  'wiki-134': { id: 'wiki-32', section: '第二場：為什麼-247-會被打成壞人' },
  'wiki-42': { id: 'wiki-41', section: '第二組（10-場）' },
  'wiki-157': { id: 'wiki-156', section: '第-1-集（2023-08-15）' },
  'wiki-158': { id: 'wiki-156', section: '第-2-集（2023-08-23）' },
  'wiki-159': { id: 'wiki-156', section: '第-3-集（2023-09-01）' },
  'wiki-160': { id: 'wiki-156', section: '第-4-集（2023-09-07）' },
  'wiki-161': { id: 'wiki-156', section: '第-5-集（2023-09-14）' },
  'wiki-162': { id: 'wiki-156', section: '第-6-集（2023-09-21）' },
  'wiki-163': { id: 'wiki-156', section: '第-7-集：決賽（2023-09-28）' },
  'wiki-155': { id: 'wiki-182', section: 's2（無差別亂鬥）戰況（整理中）' },
  'wiki-100': { id: 'wiki-153' },
  'wiki-164': { id: 'wiki-153' },
};

/** Every old id that still works, newest consolidation first. */
export const WIKI_REDIRECTS: Readonly<Record<string, WikiRedirect>> = { ...WIKI_MERGED_INTO_1030N, ...WIKI_MERGED_INTO_1111 };

/** Where an old (merged-away) id lives now; null for an id that is not a redirect. */
export function resolveWikiRedirect(id: string | null | undefined): WikiRedirect | null {
  if (!id || !Object.prototype.hasOwnProperty.call(WIKI_REDIRECTS, id)) return null;
  return WIKI_REDIRECTS[id];
}

/**
 * 標題改了字的章節：文章 id → { 舊錨點: 新錨點 }。分享出去的 #wiki=<id>&sec=<舊錨點> 照樣捲到那一節（wikiLink.ts）。
 * 新錨點必須是那篇現有的標題、舊錨點不能再是標題（packages/server/src/__tests__/WebWikiStatus.test.ts 測）。
 *
 *  - 2026-11-12 站長：「前置位」改成「前半區（1–5）」，「後置位」跟著改成「後半區（6–10）」。
 */
export const WIKI_SECTION_ALIASES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'wiki-32': {
    '一、3-家：梅林被前置位夾住、雜魚積極還是保守': '一、3-家：梅林被前半區的派票夾住、雜魚積極還是保守',
    '第一場：3-家梅林被前置位夾住時怎麼派': '第一場：3-家梅林被前半區的派票夾住時怎麼派',
    '先盤盤看前置位的派票': '先盤盤看前半區-1～4-家的派票',
  },
  'wiki-175': {
    '後置位梅林：給資訊，還是派雜魚認得下的組合？': '後半區梅林：給資訊，還是派雜魚認得下的組合？',
  },
};

/** The current anchor for a section of an article (an old anchor of a renamed heading → the new one; others unchanged). */
export function resolveWikiSectionAlias(id: string, section: string | undefined): string | undefined {
  if (!section || !Object.prototype.hasOwnProperty.call(WIKI_SECTION_ALIASES, id)) return section;
  const aliases = WIKI_SECTION_ALIASES[id];
  return Object.prototype.hasOwnProperty.call(aliases, section) ? aliases[section] : section;
}
