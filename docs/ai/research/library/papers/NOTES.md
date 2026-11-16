# 論文研究精華 / Evidence-bounded Reading Notes

> 本文是第一版跨研究來源的精華，不代表 11 篇論文全文已被本次重新逐頁閱讀。基於舊版 `r7_literature.md` 及 2026-11-16 的跨 Chat `research_sources.jsonl`。對每篇以官方出處、已知內容與待查證資訊分開記載。

## P001 CSP4SDG — AAAI 2026

- [出版索引](https://ojs.aaai.org/index.php/AAAI/article/view/38453) · [原始碼](https://github.com/Nortrom1213/CSP4SDG)。**閱讀狀態**：新索引，尚未有全文已讀證據。
- **待核對方法**：把任務牌、湖宣告、派隊與投票表示為不同來源的硬／軟限制，在身份世界集合上進行可解釋推論，再研究動作的資訊價值。
- **應用**：對照現有 `Certainty.ts`、`BayesBelief.ts`、`LogicGates.ts`，檢查哪些定理已實作、哪些只是軟概率。禁止單靠低熵認定身份推論正確。
- **驗收**：同一逐時序事件 fixture 的 hard world parity、soft posterior 的 Brier/log loss/ECE、角色私訊隔離，然後再量最終勝率。不能聲稱已復現 CSP4SDG。

## P002 GRAIL / Bayesian Social Deduction — ACL 2026

- [ACL Anthology](https://aclanthology.org/2026.acl-long.1497/) · [程式庫](https://github.com/shahabrrad/Bayesian-Avalon)。**閱讀狀態**：舊 r7 摘要層，待全文／實驗表格核實。
- **關鍵架構**：讓結構化概率圖處理角色信念、語言模型處理可解釋的對話訊號；避免自由文字推論直接覆寫固定角色數與私人視角限制。
- **已知報告**：舊 r7 曾轉述受控人機實驗的 67% 數字，但其對手、角色、局數與比較基線需查原文，不能視為本站十人藍方預期勝率。
- **應用**：`BayesBelief.ts`、`infl/`，先拆語意 feature extraction 與 posterior update，檢查中文語料跨域效應與過度自信。

## P003 AVCORP — 2026 預印本

- [arXiv](https://arxiv.org/abs/2611.10176) · [Repo](https://github.com/fardinsaad/_AVCORP_)。**閱讀狀態**：目前只有來源題名／索引，沒有驗證全文及作者實驗。
- **研究方向**：欺騙語言、交流策略與 Theory of Mind 的訊號工程；屬 A 類行為研究，需分辨梅林保密、派西不確定與紅方誘騙，避免把含糊表述當成鐵紅。
- **下步**：資料授權與標註品質 → 中文對話特徵 → held-out log-loss / calibration → 最終策略效益。

## P004 Hidden-Role Games: Equilibrium Concepts and Computation — EC 2024

- [研究頁](https://www.mit.edu/~gfarina/2024/hidden_role_games_ec24/)。**閱讀狀態**：舊 r7 摘要級研究。
- **方法主題**：團隊與隱藏角色、不對稱溝通、均衡及安全對抗策略；小局均衡不代表已能求 10 人複雜房規的全局均衡。
- **應用**：設計藍→紅→藍輪替 self-play 的有效性證明：藍方改良後，紅方適應策略也應重新衡量藍方最終勝率。

## P005 DeepRole / Finding Friend and Foe — NeurIPS 2019

- [原論文](https://proceedings.neurips.cc/paper/2019/hash/912d2b1c7b2826caf99687388d2e8f7c-Abstract.html) · [Code](https://github.com/Detry322/DeepRole)。**閱讀狀態**：舊 r7 記錄曾讀原始碼，尚未核實全文全部章節。
- **關鍵**：用合法身份世界的聯合分布表示信念；任務出失敗牌可排除不可能世界，紅方是否出失敗屬可變的行動策略，不當成硬約束。刺殺要計入終局收益。
- **舊碼註記**：五人局 60 個角色分配、15 種視角，策略加入 tremble noise 避免軟慣例將真世界概率清成 0。要 pin 實際代碼 commit 才能當可重現證據。
- **十人移植限制**：151,200 種完整角色配置、複雜決策樹，不直接搬 CFR；可先沿用 hard filter + conditional likelihood 設計。

## P006 Avalon-NLU / Long-Horizon Dialogue — EMNLP 2023

- [論文](https://aclanthology.org/2023.findings-emnlp.748/) · [Code](https://github.com/sstepput/Avalon-NLU)。**閱讀狀態**：舊研究摘要層；全文與標註資料限制待重新核對。
- **主題**：將跨輪對話、資訊先後與角色身份信念聯結。樣本量與語言域不同於本站中文 10 人局，不能直接採用模型權重。
- **應用**：逐時序標註、對話情境可見性、模仿與對手識別分開評價。

## P007–P011（狼人殺與其他社交推理）

- 對照 [完整來源清單](INDEX.md)。目前新索引只有可轉移的研究問題：人際信任、指控來源、false consensus、關係信念、逐事件稽核與時間序列信念探針。
- **全部尚未完成全文閱讀及公式/實驗核對**，不能虛構其結論。先將每個概念轉成阿瓦隆合法觀察，再做真人資料校準與消融。

## D001–D002 資料來源與 R001 規則

- AvalonLogs 和 Bayesian-Avalon 先檢查資料授權、去重、事件序列及私人資訊遮蔽，才能作為獨立人類驗證集。
- 官方規則書與本站家庭規則（第五次提案強制通過、十人湖、部分九人變體）不同；所有評比都需記 `ruleset_id`。

## 研究排序

| 優先 | 項目 | 程式接點 | 驗收 |
|---|---|---|---|
| 1 | 事件模型 / 時序視角 parity | GameEngine → Python v0.2 | 合法資訊、同局結果一致 |
| 2 | 世界硬限制與概率軟訊號分層 | Certainty / Bayes | invariant 0 + log loss/ECE |
| 3 | 以對方當時資訊解讀派票／投票 | `infl/` | 真人 held-out likelihood |
| 4 | 梅林資訊傳遞和躲刺成本 | MerlinLoyalStyle / assassin | paired-seed 最終藍勝 |
| 5 | 語言欺騙訊號 | language / ToM 待建 | 合法標註與外推驗證 |

Claude 或 ChatGPT 真正讀完全文後，必須在 [READING_MATRIX](READING_MATRIX.md) 登記來源、頁碼、日期、已讀章節及實驗限制，不得由這份整合摘要推定全文已讀。
