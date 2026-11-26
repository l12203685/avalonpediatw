# 逐篇閱讀／書目核對矩陣

> 狀態定義：
> - `indexed_only` = 僅有來源索引；
> - `metadata_only` = 僅核對原始書目／網址／作者／日期，未讀摘要或全文；
> - `abstract_verified` = 已核對原始出版頁／arXiv／BibTeX 書目與摘要，**未讀完整正文與實驗表格**；
> - `code_readme_verified` = 已核對公開 GitHub 儲存庫中繼資料、授權與 README；
> - `unreachable_403` = 原始連結回傳 HTTP 403 無法存取；
> - `full_text_read` = 已實際下載並逐頁核對原文 PDF 正文、章節與表格，留有頁碼、日期與邊界限制。
>
> 最後核對日期：2026-11-26（台北時間），核對者：Gemini（接手原 ChatGPT 之 Issue #24）。**未讀全文者絕不標記 `full_text_read`。**

## 總覽表（14 筆來源）

| ID | 核對後英文題名／資料來源 | 核對狀態 | 關鍵發現與需補證據 | 核對者／日期 |
|---|---|---|---|---|
| P001 | CSP4SDG: Constraint and Information-Theory Based Role Identification in Social Deduction Games with LLM-Enhanced Inference | `full_text_read` | 已讀 arXiv:2511.06175 全文 15 頁（Table 1–9、Appendix H）；含 AvalonLogs 5–10 人非對話實驗；GitHub `Nortrom1213/CSP4SDG` 無 LICENSE 檔；AAAI 會議頁仍受保護 | Gemini（2026-11-26） |
| P002 | Bayesian Social Deduction with Graph-Informed Language Models | `full_text_read` | 已讀 ACL 2026 長文 26 頁（Table 1–9）；**p.3 明言排除梅林等特殊角色、採 6 人局（4 好 2 壞）含對話**；不可外推至本站 10 人含湖局 | Gemini（2026-11-26） |
| P003 | AVCORP: Identifying and Resisting Deception via Communication Theory and Theory of Mind | `full_text_read` | 已讀 arXiv:2611.10176 全文 37 頁（Table 1–24、Fig 1–17）；**5 人局（3 好 2 壞，無特殊角色／無湖中）合成 LLM 對話語料**，不可外推至本站 10 人非對話局 | Gemini（2026-11-26） |
| P004 | Hidden-Role Games: Equilibrium Concepts and Computation | `full_text_read` | 已讀 ACM EC 2024 全文 39 頁（§1–§8、Table 1–3、Appendix E）；僅解 ≤6 人密談局，Theorem E.1 假設紅方互知（不適用奧伯倫／10 人含湖） | Gemini（2026-11-26） |
| P005 | Finding Friend and Foe in Multi-Agent Games | `full_text_read` | 已讀 NeurIPS 2019 全文 11 頁（Figure 2–4、p.8 ProAvalon 2,189 局人機實測）；僅 5 人局無派西／莫甘娜／莫德雷德／奧伯倫／湖中 | Gemini（2026-11-26） |
| P006 | Long-Horizon Dialogue Understanding for Role Identification in the Game of Avalon with Large Language Models | `full_text_read` | 已讀 Findings of EMNLP 2023 全文 17 頁（Table 2–3, 6–7）；**6 人局 20 場真人對話（2,384 句，無莫德雷德／奧伯倫／湖中）**，與本站 10 人非對話局不同 | Gemini（2026-11-26） |
| P007 | Balancing Epistemic Value and Social Safety: PACR-Pro for False-Consensus Intervention in One Night Ultimate Werewolf | `abstract_verified` | 已核對 EMNLP 2026（DOI `10.18653/2026.emnlp-main.2587`，pp. 58786–58810）；一夜終極狼人殺對話干預，全文待讀 | Gemini（2026-11-26） |
| P008 | Do LLMs Trust the Accuser or the Accusation? Measuring Belief Shifts in Werewolf | `abstract_verified` | 已核對 EMNLP 2026（DOI `10.18653/2026.emnlp-main.1628`，pp. 37032–37043）；狼人殺 1,224 則指控訊息信念位移，全文待讀 | Gemini（2026-11-26） |
| P009 | MARBO: Relational Belief Grounding for LLM Agents in Social Deduction Games | `abstract_verified` | 已核對 EMNLP 2026（DOI `10.18653/2026.emnlp-main.1376`，pp. 31414–31445）；LLM 關係信念錨定，全文待讀 | Gemini（2026-11-26） |
| P010 | Auditing Belief-Conditioned LLM Agents in Hidden-Information Social Deduction Games | `abstract_verified` | 已核對 arXiv:2607.10814（2026-07-12）；9 人狼人殺外部信念稽核與離線改善迴圈，全文待讀 | Gemini（2026-11-26） |
| P011 | MafiaScope: Inspecting Multi-Agent Reasoning in Social Deduction Games | `abstract_verified` | **修正舊索引誤植題名**（原索引副標不符）；已核對 arXiv:2607.10645（2026-07-12），Mafia 非侵入式信念探測，全文待讀 | Gemini（2026-11-26） |
| D001 | AvalonLogs (public game logs) | `code_readme_verified` | 已核對 GitHub `WhoaWhoa/avalonlogs`（最後更新 2026-09-19，**無 LICENSE 檔**）；含 12,228+ 局 `avalongame.online` 紀錄（無湖中／多局數混合） | Gemini（2026-11-26） |
| D002 | Bayesian-Avalon public code & replay data | `code_readme_verified` | 已核對 GitHub `shahabrrad/Bayesian-Avalon`（**MIT 授權**），對應 P002（GRAIL，6 人無特殊角色）程式碼與 HuggingFace 資料集 | Gemini（2026-11-26） |
| R001 | The Resistance: Avalon rulebook | `unreachable_403` | `officialgamerules.org` PDF 連結回傳 HTTP 403 Forbidden，未讀取全文；改列為待替換可公開驗證之官方規則書來源 | Gemini（2026-11-26） |

---

## 逐篇驗收紀錄（YAML）

### P001
```yaml
id: P001
reading_status: full_text_read
verified_title: "CSP4SDG: Constraint and Information-Theory Based Role Identification in Social Deduction Games with LLM-Enhanced Inference"
authors: "Kaijie Xu, Fandi Meng, Clark Verbrugge, Simon Lucas"
published_at: 2025-11-09
fulltext_url: "https://arxiv.org/pdf/2511.06175.pdf"
read_at_taipei: 2026-11-26
read_by: gemini
pages_or_sections_checked: ["p.1-8 (§1-§6, Table 1-4, Fig 2-3)", "p.9-15 (Appendix, Table 5-9)"]
method: "將事件與對話轉為四類約束（Evidence、Phenomenon、Assertion、Hypothesis，Table 1），先以硬約束剪除非法角色組合，再以資訊增益（HypIG）或手動權重對軟約束加權輸出後驗邊際與 MAP 角色指派。"
dataset_and_protocol: "三組公開資料：Avalon-NLU（21 局 6 人含對話）、Mafia-UCB（44 局 4–10 人）、AvalonLogs（5–10 人非對話，以程式直接萃取約束，見 p.10–11）。"
results_with_table_or_page: "Table 2（p.5）報 Avalon-NLU 邊際／MAP 準確率；Table 3（p.6）與 Table 8（p.14）報 AvalonLogs 5–10 人各人數分層邊際準確率；Table 4（p.7）示梅林視角因硬約束大幅剪枝各模型一致；Table 9（p.15）示手動權重（w_strong, w_weak）在 12 組參數下變異小。"
limits: "GitHub 儲存庫 Nortrom1213/CSP4SDG 無 LICENSE 檔且不含原始資料；AAAI 2026 會議頁（ojs.aaai.org）仍受防護無法獨立核對正式頁碼；實驗主評估角色辨識準確率而非完整對局勝率，且未含湖中女神規則。"
reproduction_status: not_started
avalon_transfer_assumptions: "硬約束剪枝＋非對話程式化約束萃取（AvalonLogs 路徑）可直接對應本站 Certainty.ts／BayesBelief.ts；對話 Assertion 與 LLM 萃取部分不適用現行無發言百科 AI。"
linked_wiki_ids: [wiki-147]
linked_code: [packages/server/src/ai/belief/Certainty.ts, packages/server/src/ai/belief/BayesBelief.ts]
```

### P002
```yaml
id: P002
reading_status: full_text_read
verified_title: "Bayesian Social Deduction with Graph-Informed Language Models"
authors: "Shahab Rahimirad, Guven Gergerli, Lucia Romero, Angela Qian, Matthew Lyle Olson, Simon Stepputtis, Joseph Campbell"
published_at: 2026-07-01
fulltext_url: "https://aclanthology.org/2026.acl-long.1497.pdf"
read_at_taipei: 2026-11-26
read_by: gemini
pages_or_sections_checked: ["p.1-10 (§1-§6, Table 1-2, Fig 1-8)", "p.13-26 (Appendices, Table 3-9)"]
method: "提出 GRAIL 混合架構（Fig 1, p.3）：以因子圖（factor graph）維護玩家角色機率分佈，搭配以 AvalonLogs（3,143 局）與 ProAvalon 訓練之神經因子函數與 LLM 先驗。"
dataset_and_protocol: "6 人局 Avalon（4 好 2 壞，含聊天討論），**明確排除梅林等所有特殊角色**（p.3: 'We exclude special roles, e.g., Merlin, to focus on detecting deception rather than producing it'）；另於 p.8 與 p.24–26 進行 30 局人機對戰（15 局 GRAIL vs 15 局 reasoning agent，3 真人＋3 AI，對象為新手玩家）。"
results_with_table_or_page: "Table 1–2（p.5）報同質與混合代理對戰勝率；p.1–2 與 Table 8–9（p.26）報新手真人對戰 67% 勝率；Table 3（p.17）報訓練量於 2.5K 局後 F1 趨穩；Table 6–7（p.23）報幻覺率與每回合推論耗時。"
limits: "僅 6 人且無梅林／派西／莫甘娜／莫德雷德／奧伯倫／刺殺階段／湖中女神；人機實驗為新手樣本且僅 15 局 GRAIL。"
reproduction_status: not_started
avalon_transfer_assumptions: "67% 人機勝率不可外推至本站 10 人含特殊角色與湖中局；僅其因子圖位置偏差校正（p.4）與 MIT 授權程式碼（D002）具架構參考價值。"
linked_wiki_ids: []
linked_code: [packages/server/src/ai/belief/BayesBelief.ts]
```

### P003
```yaml
id: P003
reading_status: full_text_read
verified_title: "AVCORP: Identifying and Resisting Deception via Communication Theory and Theory of Mind"
authors: "Fardin Saad, Zhe Zhang, Sanjana Cheerla, Amanul Haque, Munindar P. Singh"
published_at: 2026-11-06
fulltext_url: "https://arxiv.org/pdf/2611.10176.pdf"
read_at_taipei: 2026-11-26
read_by: gemini
pages_or_sections_checked: ["p.1-10 (§1-§6, Table 1-2, Fig 1-2)", "p.13-36 (Appendices, Table 3-24, Fig 4-17)"]
method: "建立 4×4 行為分類矩陣共 37 種欺騙戰術（Table 1, p.4；Table 5, p.19），以六階段管線生成含一階／二階心智理論（β1/β2）與 ReAct/ReCon 推理軌跡之對話語料，並以 SFT＋GRPO 訓練 Qwen3-8B 偵測紅方（Table 16–17, p.31–32）。"
dataset_and_protocol: "5 人局簡化 Avalon（3 好 2 壞，C(5,2)=10 種組合 × 25 局 = 250 局合成 LLM 對話、1,000 回合，p.5, p.15–18）；另於 25 局保留 AVCORP 局與 20 局 Avalon-NLU（82 回合）測試跨域泛化（Table 2, p.8；Tables 18–24, p.33–36）。"
results_with_table_or_page: "Table 2（p.8）與 Tables 18–24（p.33–36）報 AVCORP 保留集與 Avalon-NLU 之 Exact／Game-ending F1／Round F1；Table 8–11（p.26–29）報 1,000 條黃金軌跡審查通過率與回合推論準確率；Table 13–15（p.30–31）報人工標註者一致性。"
limits: "僅 5 人簡化版（無梅林、派西、莫甘娜、莫德雷德、奧伯倫、刺殺、湖中女神），且主資料集為 LLM 合成對話而非真人對局。"
reproduction_status: not_started
avalon_transfer_assumptions: "不可直接轉移至本站 10 人含湖非對話百科 AI；僅其 37 種欺騙戰術分類與 MIT 授權程式碼（fardinsaad/_AVCORP_）可供未來若開放文字／語音發言分析時參考。"
linked_wiki_ids: []
linked_code: []
```

### P004
```yaml
id: P004
reading_status: full_text_read
verified_title: "Hidden-Role Games: Equilibrium Concepts and Computation"
authors: "Luca Carminati, Brian H. Zhang, Gabriele Farina, Nicola Gatti, Tuomas Sandholm"
published_at: 2024-07-08
fulltext_url: "https://www.mit.edu/~gfarina/2024/hidden_role_games_ec24/hidden_role_games_ec24.pdf"
read_at_taipei: 2026-11-26
read_by: gemini
pages_or_sections_checked: ["p.1-19 (§1-§8, Table 1-2)", "p.23-39 (Appendices A-E, Theorem E.1, Table 3)"]
method: "形式化定義隱藏角色均衡（hidden-role equilibrium，區分無溝通／公開溝通／私下密談），透過協調人格分裂（CSplit）與中介者啟示原則（Theorem 4.1–4.2）將私密溝通均衡化約為有限零和展開式賽局求解。"
dataset_and_protocol: "計算 5 人與 6 人 Avalon 簡化變體（Merlin、Merlin+Mordred、Merlin+2 Mordreds、Merlin+Mordred+Percival+Morgana）之精確均衡值（§7, Appendix E）。"
results_with_table_or_page: "Table 1（p.15）給出各溝通模型複雜度上下界；Table 2（p.17）給出 5–6 人 Avalon 精確均衡值；Table 3（p.38）給出各變體終局狀態數 |Z| 與三藍過關後被刺機率拆解。"
limits: "僅限 ≤6 人局；依賴私密溝通（whispering）假設；Appendix E Theorem E.1（p.32）明確假設無奧伯倫且所有紅方互相知情，亦不含湖中女神與強制第五派表決樹。"
reproduction_status: not_started
avalon_transfer_assumptions: "精確均衡值與密談協議不可直接套用於 10 人無密談含奧伯倫／湖中局；但其「每次任務選擇皆揭露梅林資訊、須將被刺成本計入期望值」（p.36, p.39）之結構結論，直接支持 Issue #149 的梅林暴露懲罰設計。"
linked_wiki_ids: [wiki-175, wiki-12]
linked_code: []
```

### P005
```yaml
id: P005
reading_status: full_text_read
verified_title: "Finding Friend and Foe in Multi-Agent Games"
authors: "Jack Serrino, Max Kleiman-Weiner, David Parkes, Josh Tenenbaum"
published_at: 2019-12-08
fulltext_url: "https://proceedings.neurips.cc/paper_files/paper/2019/file/912d2b1c7b2826caf99687388d2e8f7c-Paper.pdf"
read_at_taipei: 2026-11-26
read_by: gemini
pages_or_sections_checked: ["p.1-11 (§1-§5, Fig 2-4, References)"]
method: "提出 DeepRole：結合向量型公開機會抽樣反事實遺憾最小化（PCS-CFR）、深度受限子樹搜尋與演繹式信念價值網路（Fig 2, p.5），不依賴語言對話即能從派隊與投票紀錄推論隱藏身份。"
dataset_and_protocol: "5 人局 Avalon（Merlin、Assassin、1 Minion、2 Servants；下界 ≥10^56 資訊集，p.3）；與規則／基準代理模擬 >20K 局（p.7），並於 ProAvalon.com 進行 2,189 局人機混合實測（真人可自由聊天、DeepRole 不發言，p.8）。"
results_with_table_or_page: "Fig 4（p.6）示 DeepRole 在各混合席次下整體、紅方、藍方期望勝率均勝過手寫與消融基準；p.8 報 2,189 局 ProAvalon 真人混合局表現優於真人合作者與對手。"
limits: "嚴格限於 5 人基礎局（無派西、莫甘娜、莫德雷德、奧伯倫、湖中女神）；多代理隱藏角色賽局中 CFR 不保證收斂至 Nash 均衡（p.4）。"
reproduction_status: not_started
avalon_transfer_assumptions: "不可直接移植 5 人局 CFR 價值網路至 10 人局；但「不發言僅靠票型與任務演繹信念＋有限深度前瞻」的範式與本站百科 AI 架構一致。"
linked_wiki_ids: []
linked_code: [packages/server/src/ai/belief/BayesBelief.ts]
```

### P006
```yaml
id: P006
reading_status: full_text_read
verified_title: "Long-Horizon Dialogue Understanding for Role Identification in the Game of Avalon with Large Language Models"
authors: "Simon Stepputtis, Joseph Campbell, Yaqi Xie, Zhengyang Qi, Wenxin Zhang, Ruiyi Wang, Sanketh Rangreji, Charles Lewis, Katia Sycara"
published_at: 2023-12-01
fulltext_url: "https://aclanthology.org/2023.findings-emnlp.748.pdf"
read_at_taipei: 2026-11-26
read_by: gemini
pages_or_sections_checked: ["p.1-10 (§1-§6, Fig 3, Table 2-3)", "p.13-17 (Appendices, Table 6-7)"]
method: "將遊戲狀態（派隊、投票、任務結果）交錯插入長文本多方對話中，以零樣本／少樣本與微調 LLM（GPT-3.5、GPT-4、Llama-2-13b）預測各玩家隱藏角色與刺客指認梅林（§3–§5, p.4–7）。"
dataset_and_protocol: "公開瀏覽器版 6 人局 Avalon（Merlin、Percival、Morgana、Assassin、2 Servants）之 Avalon-NLU 資料集：20 場真人對局、30 位獨立玩家、2,384 句人工標註說服／欺騙策略對話（p.2）；並與狼人殺對話資料集（Lai et al. 2022）跨遊戲對照（p.9, Table 6–7）。"
results_with_table_or_page: "Table 2（p.7）報含私密視野下各模型角色預測與紅方找梅林 F1（微調 GPT-3.5 與原版 GPT-4 micro-F1 0.37 領先 Llama-2-13b）；Table 3（p.9）與 Table 6–7（p.16）示 Avalon 角色預測難度高於狼人殺。"
limits: "僅 6 人局且僅 20 場真人對話（無莫德雷德、奧伯倫、湖中女神）；核心輸入為長文本聊天紀錄而非純票型推理。"
reproduction_status: not_started
avalon_transfer_assumptions: "MIT 授權語料（sstepput/Avalon-NLU）與長對話交錯狀態格式僅供未來對話分析參考；對現行 10 人無發言百科 AI 無直接轉移實作。"
linked_wiki_ids: []
linked_code: []
```

### P007
```yaml
id: P007
reading_status: abstract_verified
verified_title: "Balancing Epistemic Value and Social Safety: PACR-Pro for False-Consensus Intervention in One Night Ultimate Werewolf"
authors: "Yonghui Wang, Zhiliang Tian, Bo Liu, Jiarui Tang, Wanlong Yu, Shilong Pan"
published_at: 2026-10-01
fulltext_url: "https://aclanthology.org/2026.emnlp-main.2587.pdf"
read_at_taipei: 2026-11-26
read_by: gemini
pages_or_sections_checked: ["ACL Anthology BibTeX & abstract (DOI 10.18653/2026.emnlp-main.2587, pp. 58786-58810)"]
method: "摘要層：於一夜終極狼人殺中明確權衡「修正錯誤共識的認知價值」與「過早暴露／社會風險」，提出 PACR-Pro 干預策略。"
dataset_and_protocol: "未讀全文；領域為一夜終極狼人殺（LLM 對話）。"
results_with_table_or_page: "未讀全文，不記錄數值。"
limits: "跨遊戲（狼人殺）且以發言干預為核心。"
reproduction_status: not_started
avalon_transfer_assumptions: "概念上可類比「梅林糾錯（擋帶紅隊）vs 暴露被刺風險」的權衡，但不可直接套用狼人殺參數或發言機制。"
linked_wiki_ids: []
linked_code: []
```

### P008
```yaml
id: P008
reading_status: abstract_verified
verified_title: "Do LLMs Trust the Accuser or the Accusation? Measuring Belief Shifts in Werewolf"
authors: "Yu-Yu Yang, Ti-Rong Wu, Hung Guei, Hsing-Yu Chen, I-Chen Wu"
published_at: 2026-10-01
fulltext_url: "https://aclanthology.org/2026.emnlp-main.1628.pdf"
read_at_taipei: 2026-11-26
read_by: gemini
pages_or_sections_checked: ["ACL Anthology BibTeX & abstract (DOI 10.18653/2026.emnlp-main.1628, pp. 37032-37043)"]
method: "摘要層：建立狼人殺信念位移評測基準，於 1,224 則標註懷疑／指控訊息上量測 40 組開源 LLM 觀察者的逐句信念更新。"
dataset_and_protocol: "未讀全文；狼人殺文字訊息基準。"
results_with_table_or_page: "未讀全文，不記錄數值。"
limits: "跨遊戲且針對 LLM 文本指控解讀，非非對話票型推理。"
reproduction_status: not_started
avalon_transfer_assumptions: "僅其「逐事件量測信念位移（而非只看終局勝率）」的評測思路可呼應本站 Brier／ECE／Q1–Q2 檢驗。"
linked_wiki_ids: []
linked_code: []
```

### P009
```yaml
id: P009
reading_status: abstract_verified
verified_title: "MARBO: Relational Belief Grounding for LLM Agents in Social Deduction Games"
authors: "Yechan Hwang, Sangjun Bae, Jeongmo Kim, Sangwoo Bang, Seungyul Han"
published_at: 2026-10-01
fulltext_url: "https://aclanthology.org/2026.emnlp-main.1376.pdf"
read_at_taipei: 2026-11-26
read_by: gemini
pages_or_sections_checked: ["ACL Anthology BibTeX & abstract (DOI 10.18653/2026.emnlp-main.1376, pp. 31414-31445)"]
method: "摘要層：將行動與發言明確錨定於對隱藏角色、陣營、懷疑度與他人認知的關係信念，減少小型 LLM 代理的策略不一致。"
dataset_and_protocol: "未讀全文。"
results_with_table_or_page: "未讀全文，不記錄數值。"
limits: "針對 LLM 代理一致性問題，非符號化貝氏引擎。"
reproduction_status: not_started
avalon_transfer_assumptions: "僅供概念參考（行動與信念一致性稽核）。"
linked_wiki_ids: []
linked_code: []
```

### P010
```yaml
id: P010
reading_status: abstract_verified
verified_title: "Auditing Belief-Conditioned LLM Agents in Hidden-Information Social Deduction Games"
authors: "Yuan Gao, Jiangyi Yang, Yao Zhao, Yichi Zhang"
published_at: 2026-07-12
fulltext_url: "https://arxiv.org/pdf/2607.10814.pdf"
read_at_taipei: 2026-11-26
read_by: gemini
pages_or_sections_checked: ["arXiv abstract page (2607.10814)"]
method: "摘要層：於嚴格程式碼層資訊隔離的 9 人狼人殺環境中，維護外部信念狀態並記錄「信念更新」與「信念—行動偏差」作為可稽核證據，驅動離線改善迴圈。"
dataset_and_protocol: "未讀全文；9 人狼人殺。"
results_with_table_or_page: "未讀全文，不記錄數值。"
limits: "跨遊戲（狼人殺）且以 LLM 代理為主。"
reproduction_status: not_started
avalon_transfer_assumptions: "其「程式碼層資訊隔離＋信念與行動偏差日誌」方法論與本站真人桌讀盤／忠臣視角原則高度契合，可作為工程稽核參考。"
linked_wiki_ids: []
linked_code: []
```

### P011
```yaml
id: P011
reading_status: abstract_verified
verified_title: "MafiaScope: Inspecting Multi-Agent Reasoning in Social Deduction Games"
authors: "Ilia Karpov, Maksim Grigorenko, Vadim Ayuyev"
published_at: 2026-07-12
fulltext_url: "https://arxiv.org/pdf/2607.10645.pdf"
read_at_taipei: 2026-11-26
read_by: gemini
pages_or_sections_checked: ["arXiv abstract page (2607.10645)"]
method: "摘要層：以 Mafia 測試台在每次公開發言後，於對話副本上非侵入式私下探測存活代理的結構化內部信念，區分「真的推論對」與「猜對」。"
dataset_and_protocol: "未讀全文；Mafia 對話測試台。註：舊 INDEX.md 誤植副標為 'Non-Invasive, Time-Resolved Belief Probing...'，本次已依 arXiv 原題修正。"
results_with_table_or_page: "未讀全文，不記錄數值。"
limits: "跨遊戲且針對對話型 LLM 代理。"
reproduction_status: not_started
avalon_transfer_assumptions: "僅供信念探測評測設計參考，無直接 10 人局 Avalon 轉移實作。"
linked_wiki_ids: []
linked_code: []
```

### D001
```yaml
id: D001
reading_status: code_readme_verified
verified_title: "Avalon: The Resistance Logs (WhoaWhoa/avalonlogs)"
authors: "WhoaWhoa (GitHub)"
published_at: 2026-09-19
fulltext_url: "https://github.com/WhoaWhoa/avalonlogs"
read_at_taipei: 2026-11-26
read_by: gemini
pages_or_sections_checked: ["GitHub repo metadata", "README.md"]
method: "公開 JSON 對局紀錄，來自 avalongame.online 親友面殺／視訊局。"
dataset_and_protocol: "README 記載 12,228+ 局混合人數紀錄（紅方勝率約 55%、6,835/12,228；紅勝中 41% 為刺殺梅林，刺殺成功率 2,801/8,194 ≈ 34%）。"
results_with_table_or_page: "僅為 README 概覽統計，未對 10 人含湖子集重跑驗證。"
limits: "儲存庫無 LICENSE 檔（法律再利用權限未明）；規則與本站 10 人固定含湖／1-1~1-4 強制正常票慣例不同。"
reproduction_status: not_started
avalon_transfer_assumptions: "不可與本站真人牌譜混算勝率或直接當作本站 10 人含湖分布；僅可作為跨社群對照參考。"
linked_wiki_ids: []
linked_code: []
```

### D002
```yaml
id: D002
reading_status: code_readme_verified
verified_title: "Bayesian-Avalon (shahabrrad/Bayesian-Avalon)"
authors: "Shahab Rahimirad et al."
published_at: 2025-07-17
fulltext_url: "https://github.com/shahabrrad/Bayesian-Avalon"
read_at_taipei: 2026-11-26
read_by: gemini
pages_or_sections_checked: ["GitHub repo metadata (MIT license)", "README.md"]
method: "對應 P002（GRAIL，arXiv:2506.17788／ACL 2026）之官方程式碼與 HuggingFace 資料集連結。"
dataset_and_protocol: "含遊戲引擎、GRAIL 代理實作與人機實驗紀錄；資料集另託管於 HuggingFace（shahabrahimirad/bayesian-social-deduction）。"
results_with_table_or_page: "同 P002，僅涵蓋 6 人無特殊角色變體。"
limits: "無梅林／派西／莫甘娜／莫德雷德／奧伯倫／湖中女神。"
reproduction_status: not_started
avalon_transfer_assumptions: "MIT 授權可安全參考其因子圖程式結構，但不可直接沿用其訓練權重或 6 人局遊戲引擎。"
linked_wiki_ids: []
linked_code: []
```

### R001
```yaml
id: R001
reading_status: unreachable_403
verified_title: "The Resistance: Avalon rulebook (Don Eskridge, Indie Boards & Cards, 2012)"
authors: "Don Eskridge"
published_at: 2012-01-01
fulltext_url: "https://officialgamerules.org/wp-content/uploads/2025/04/resistance-avalon-rulebook.pdf"
read_at_taipei: 2026-11-26
read_by: gemini
pages_or_sections_checked: ["HTTP probe only (403 Forbidden)"]
method: "官方桌遊規則書原始連結查核。"
dataset_and_protocol: "無（規則文件）。"
results_with_table_or_page: "原始連結回傳 HTTP 403 Forbidden，無法下載核對；P001 p.10 註腳另列 cdn.1j1ju.com 備援 PDF 與 indieboardsandcards.com 官方頁，尚未讀取。"
limits: "無法直接驗證此 PDF 檔案內容；本站實作仍以 docs/ai/wiki_sop_map.md §0 與站長已確認之 10 人含湖房規為準。"
reproduction_status: not_started
avalon_transfer_assumptions: "規則書為基礎規則參考，實際對局規則差異（例如本站 10 人含湖與固定配置）一律以本站現行規則文件為準。"
linked_wiki_ids: [wiki-1]
linked_code: []
```

---

**禁止**用 GitHub PR 的 commit 存在就認定論文已閱讀，或用中文二手摘要補上不存在的正文頁碼。程式碼閱讀、摘要閱讀、論文全文、成果重現是四種不同證據。
