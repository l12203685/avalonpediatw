# 阿瓦隆百科 × 學術文獻統一知識庫

> 版本：2026-11-16（第一期：資料來源盤點 + 實際可連結的百科源檔 + 初步研究摘要）。

## 目的

讓 Claude、ChatGPT、Edward 和後續新 Chat，透過 GitHub **同一套結構**追蹤：阿瓦隆百科原文、中文研究記事、英文學術論文、公開程式碼／資料集、經過驗證的邏輯規則，以及它們如何落地到 AI 決策與測試。這是**研究／索引層**，不是正式遊戲資料來源，也不是直接覆蓋百科網站文章的地方。

## 目錄

- [papers/INDEX.md](papers/INDEX.md)：來自跨 Chat 研究 v0.1 的 14 筆來源（11 篇 paper/preprint、2 個資料／程式來源、1 份規則來源）及原始網址。
- [papers/READING_MATRIX.md](papers/READING_MATRIX.md)：逐篇正式驗收狀態；不把「有摘要」誤認為「已讀全文」。
- [papers/NOTES.md](papers/NOTES.md)：先前 Claude 研究報告及今日研究假設的精華、限制、對 AI 的工程意義。
- [wiki/ALL_ARTICLES.generated.md](wiki/ALL_ARTICLES.generated.md)：已從正式 `wiki_data.json` 建立 **40 筆網站條目 ID／標題／分類／來源預覽**快照，後續有正文修改時需重新生成。
- [wiki/CATALOG.md](wiki/CATALOG.md)：`docs/avalon-wiki` 各個實際 Markdown 文件／QnA 的連結與文類，並指向網站專屬的 `packages/server/wiki_data.json`。
- [wiki/SYNTHESIS.md](wiki/SYNTHESIS.md)：百科策略 × 文獻 × 現行 AI × 具體測試條件的交叉對照。
- [METHOD.md](METHOD.md)：引用格式、硬／軟邏輯、閱讀驗證、跨 AI 領任務及避免資料分裂的規則。

## 唯一事實來源原則

1. **百科正文（玩家可見）**：以 `packages/server/wiki_data.json` 與 `docs/avalon-wiki/**` 的當前版本為準；本站實際引用 `wiki-XXX` ID，研究摘要無權覆寫正文。GitHub 的 `docs/avalon-wiki` 屬部分鏡像，不能以其檔案數當作全站百科篇數。
2. **角色房規**：以 `GameEngine.ts`、`docs/ai/rules_checklist.md` 及站長最新裁定對照；論文以標準房規計算的結論不可直接移植。
3. **學術來源**：以作者原論文及 publisher 頁為準，標明是否真的讀到全文／附錄／程式碼；不得把二手整理當成第一手閱讀。
4. **AI 實作**：以 main 及正式 `DEFAULT_AGENT_TUNING` 為準；未合併的 PR（如研究 #15）只能算候選，不說已部署。
5. **已經確認的結果**：需附 dataset、seed、跑法、測試和 CI，並分開邏輯一致、真人行為一致、預測校準、最終勝率。

## 目前第一期界線

- 已建立來源、百科分類與可追溯整合筆記；**未重新閱讀完全部 11 篇論文的全文**。
- `wiki_data.json` 的每篇原文未在這次 PR 中重新複製；透過原始檔和 `wiki_sop_map.md` 180 條 SOP 對應，避免手動索引無限漂移。
- Claude 後續逐篇查核與更新閱讀矩陣，追蹤 [Issue #24](https://github.com/l12203685/avalonpediatw/issues/24)。

## 後續新增文章／論文的流程

來源→檢查原始 URL／版本→評估可信度→分類 A/B/C/D/E→建立可追溯中文摘要＋英文術語→對照百科 `wiki-XXX` 與程式碼→提出獨立回歸測試→獨立 Draft PR→驗收／合併。
