# 百科策略 × 學術文獻 × AI 程式：跨來源整理

> 2026-11-16 第一批。已直接檢查 Markdown 原文部分／主要章節：鐵邏輯、條件機率、延伸與修正、梅林；另參照 `wiki-203` 規則與 `wiki_sop_map.md`。其餘文章目前只有目錄索引，**不能宣稱全部讀完**。

## A. 第一原理／經驗法則的嚴格分層

- **百科來源**：[鐵邏輯_正邏輯_反邏輯](https://github.com/l12203685/avalonpediatw/blob/main/docs/avalon-wiki/入門基礎/鐵邏輯_正邏輯_反邏輯.md)；`wiki-203` 正式規則。
- **關鍵**：任務出 x 張失敗 ⇒ 隊內至少 x 紅（硬）；成功任務未必全好（紅可藏牌）。派票、黑白球和發言是受情境條件化的行為證據（軟）。
- **重要假設**：好人持湖不說謊（A0）是這個社群採用的策略公設，非遊戲物理規則；A 湖 B 說好只能推出 A 好 ⇒ B 好，不能獨立推出 B 是好人。
- **研究對照**：P001 CSP4SDG 的硬／軟限制候選思路、P005 DeepRole 的不可行世界過濾。
- **程式與回歸**：`belief/Certainty.ts`、`LogicGates.ts`、`BayesBelief.ts`；L0/L1 混合、A0 不一致時退回 L0、事件時序和角色視角不洩漏。

## B. 湖中鏈 × 梅林 × 莫德雷德

- **百科來源**：`wiki-147` 湖中女神、[梅林](https://github.com/l12203685/avalonpediatw/blob/main/docs/avalon-wiki/角色/梅林.md)、[鐵邏輯](https://github.com/l12203685/avalonpediatw/blob/main/docs/avalon-wiki/入門基礎/鐵邏輯_正邏輯_反邏輯.md)。
- **關鍵條件推理**：如果在梅林合法私有視角下 B 是**梅林看得到**的紅，A 湖 B 宣好，且 A 不在梅林三位可見紅之中；採用 A0 與 10 人標準配置時 A 必是未被梅林看到的紅，即莫德雷德。派西「拇指」與梅林「可見紅」的資訊來源不能互換。
- **程式**：`Certainty.ts`、`LogicGates.ts`、`MerlinLoyalStyle.ts`、`ProvenRed.ts`；[Issue #17](https://github.com/l12203685/avalonpediatw/issues/17) 的 [PR #19](https://github.com/l12203685/avalonpediatw/pull/19) 已合併（2026-11-16），並加入 Edward 同日裁定「任何已經被湖中女神＋任務證明的壞人都不該派」（`goodProvenRedBar`、不變量 INV-PR1），不可再重做。
- **驗收**：A 宣 B 好、B 可見紅／未知／確定好、連鎖 A→B→C、L1 空世界、R1/R2 重用、第五次強制提議，各測 fail-before/pass-after；成功隊重用時，已被湖中＋任務證明的紅要換掉再補人（2026-11-16 裁定取代 11/01 對這種人的重用例外）。

## C. 單人嫌疑 vs 聯合隊伍全好機率

- **百科來源**：[條件機率](https://github.com/l12203685/avalonpediatw/blob/main/docs/avalon-wiki/進階思考/條件機率.md)。
- **關鍵**：決策要最大化隊伍整體的 P(全好 | 資訊)，非每位玩家嫌疑的簡單加總或把邊際機率任意相乘；固定四紅造成世界間高度依賴。
- **研究對照**：P002 GRAIL 概率圖、P005 DeepRole 完整世界分布；合成 IG 提升不等於最終勝率提升。
- **正式 AI 缺口（2026-10-29 盤點）**：`wiki_sop_map.md` A4、B16、B21 指出 `ForwardAgent` 有邊際嫌疑加總排序，需核對最新 `DEFAULT_AGENT_TUNING`。
- **驗收**：找兩組邊際嫌疑相近但聯合 P(clean) 不同的隊伍，測排序、強者真人案例及 paired-seed 最終藍勝。

## D. 延伸／修正與資訊流（INFL）

- **百科來源**：[延伸與修正](https://github.com/l12203685/avalonpediatw/blob/main/docs/avalon-wiki/進階思考/延伸與修正.md)。
- **關鍵**：延伸隊伍資訊不必然代表認同前隊長身分；修正的意思受隊長當時的已知事件、先後次序、比分與候選世界約束。只數隊員重疊不能還原完整意圖。
- **研究**：P002、P006 與 [r7_literature.md](https://github.com/l12203685/avalonpediatw/blob/main/docs/ai/research/r7_literature.md) 的公共信念／level-k；參照 `docs/ai/infl_research.md` 已做的真人票校準。
- **工程**：以 `event_seq` 截斷成各玩家當時觀察，再計算 P(action | actor's legal view, world)，避免用事後真相重複計算同一條證據。

## E. 梅林的雙重效用

- **百科來源**：[角色玩法—梅林](https://github.com/l12203685/avalonpediatw/blob/main/docs/avalon-wiki/角色/梅林.md)。
- **關鍵**：資訊要能由忠臣的公開視角合理解釋，任務成功也要避免梅林過度暴露。藍勝 = 三藍率 ×（三藍後梅林存活率），不能只單看任務勝率。
- **程式**：`MerlinLoyalStyle.ts`、`ForwardAgent.ts`、`assassin/*`。對照 P004 hidden-role equilibrium / P005 終局刺殺效用，採用需持續驗證紅方更新後的強度。

## F. 黑白球、異常票與工程卡死

- **百科來源**：[黑白球投票](https://github.com/l12203685/avalonpediatw/blob/main/docs/avalon-wiki/入門基礎/阿瓦隆名詞介紹%20-%20黑白球投票.md)、[為什麼不該亂開外白](https://github.com/l12203685/avalonpediatw/blob/main/docs/avalon-wiki/湖中與投票/為什麼不該亂開場外白球.md)。
- **重要區分**：R1/R2 正常票是既有機器人裁定；真實玩家異常票仍有策略資訊。程序卡住與模型判斷錯誤須分開；[Issue #16](https://github.com/l12203685/avalonpediatw/issues/16) 已由 Claude [PR #18](https://github.com/l12203685/avalonpediatw/pull/18) 處理並合併，實際根因是 signage 接入在湖宣告上阻塞投票。

## G. 實戰覆盤與研究驗證

- **百科來源**：`docs/avalon-wiki/覆盤`、`QnA` 與站內 `wiki_data.json`；完整目錄見 [CATALOG.md](CATALOG.md)。
- **整合標準**：每條主張必有來源文件／wiki ID、條件、邏輯或經驗標記、具體案例、對應演算法、回歸測試及模型驗收。
- **後續**：QnA 葉目錄內文與正式站 JSON 所有 wiki ID 尚未逐篇 digest；不可把今日索引稱作全量摘要。
