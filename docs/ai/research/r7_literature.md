# 文獻與方法調查：資訊理論（熵）× 資訊流（事件順序、遞迴解讀）× 隱藏身分遊戲

**日期**：2026-10-14 · **對應 Edward 10/14 指示**：(3) 用熵／資訊量／不確定性評分每個動作；(4) 硬3 只看湖之後、資訊流與事件順序、像 Bellman 方程一樣迭代找均衡（t2 參考 t1 的全部資訊，包含 t1 對 t0 的解讀）；(5) 先做邏輯上絕對正確的第一原理，再談強弱。
**範圍**：10 人局（梅林、派西維爾、忠臣 ×4；刺客、莫甘娜、莫德雷德、奧伯倫），紅方集合共 C(10,4) = 210 種。

**資料取得說明（重要）**：這個環境的對外代理擋掉 arxiv.org、neurips.cc、aclanthology.org、semanticscholar、openreview、github.io 等學術網站，WebFetch 也無法解析 DNS。所以本文的論文內容來自三種來源，可信度依序遞減：
1. **原始碼（已讀過，可信）**：用 `git clone` 讀了三個公開 repo：DeepRole（Serrino 等，NeurIPS 2019 的官方程式碼）、aigamedev/resistance（2012 年 Resistance AI 比賽的框架與參賽機器人）、jonathanmli/Avalon-LLM（AvalonBench 與 Strategist 的程式碼）。下文引用這三者的細節都是直接看程式碼得到的。
2. **搜尋摘要（摘要層級）**：其他論文只看得到摘要和搜尋結果片段，文中寫的是摘要上的主張，沒有核對全文。
3. **未能證實**：任務描述提到的「Taylor 的 Resistance 機器人」查不到可核對的出處（試過 4 種查法），本文改用可核對的 2012 比賽程式碼代替，並標明這個缺口。2026 年的幾篇 arXiv 預印本只有搜尋片段，已標註。

數字都來自 `scripts/entropy_toy.py`（合成座位 0–9，不用任何牌譜資料）和 `scripts/deeprole_human_csv.py`（DeepRole repo 公開的 ProAvalon 對局彙總，只輸出彙總數字）。

---

## 0. 結論先行（給決策用）

1. **文獻支持 Edward 的順序：先邏輯、後強度。** 每個在 Avalon／Resistance 有效的機器人，核心都是同一件事：**把所有可能的紅方集合列出來，刪掉跟硬事實矛盾的**（任務出現 x 張失敗 ⇒ 隊上至少 x 紅）。具體例子：DeepRole 的 `populate_full_reach_probs`（不一致的世界機率直接設 0，論文另有拿掉這步的消融版本 `Deeprole_NoZeroing`）；2012 比賽的 `Simpleton`／`Bounder`；AvalonBench 的規則型忠臣 `NaiveServant`，它當好人的勝率是 38.2%，ChatGPT 只有 22.2%。2012 年 Dagstuhl 研討會的比賽報告也寫，長期來看簡單策略常常贏過複雜策略。LLM 的研究（AvalonBench、Stepputtis 2023、GRAIL 2025、Werewolf 的 Thinker 2024）得到同一個結論：**推理（deduction）是弱點，要交給外部的結構化機率模型去做**。
2. **Edward 要的「Bellman 式迭代」在文獻裡有標準名稱：公共信念狀態（public belief state, PBS）。** 來源依序是 Nayyar–Mahajan–Teneketzis 2013 的共同資訊法、Foerster 2019 的 BAD、Brown 2020 的 ReBeL。β_{t+1}(w) ∝ β_t(w) · π_i(a_t | s_i^t(w), β_t)。關鍵是**似然用的是行動者在 t 當下的資訊集 s_i^t**，所以 t2 的解讀自然包含 t1 對 t0 的解讀。硬3 只看湖後，是這條規則的直接推論：湖前 A 不知道 B 的陣營，「A 帶隊沒帶 B」在「A 好」與「A 紅」兩個假設下機率一樣，概似比 ≈ 1，資訊量 0 bit。湖後好人 A 已確知 B 是藍，不帶 B 是被支配的選擇，概似比約 5–10（2.3–3.3 bits），見 §5.3。
3. **「迭代到均衡」的可計算版本有三層，成本差好幾個數量級。** (a) 固定一個藍圖策略（真人牌譜先驗），做精確信念過濾（SPARTA 2020 的作法），210 個世界幾乎不花成本。(b) level-k／認知層級：第 k 層把別人當作第 k−1 層來解讀；Off-Belief Learning 2021 就是在合作遊戲裡可控的層級版本，ReCon 2023 的「二階視角」也屬於這類。(c) 完整的 CFR／PBS 搜尋（DeepRole、ReBeL），10 人局還做不到（§4）。**建議先做 (a)，再做 (b) 的 level-2，(c) 不做。**
4. **資訊理論的評分在文獻裡有現成工具**：期望資訊增益（EIG = 互資訊，Lindley 1956；MacKay 1992；Rainforth 2024 綜述）；資訊導向抽樣（IDS，Russo–Van Roy 2018），用來權衡「推進任務」和「取得資訊」；以及「決策相關的熵」（價值資訊 VOI，Howard 1966）。有三點要注意：(i) 熵下降不等於有價值，要看是**誰的**熵、**哪個變數**的熵（紅方集合、梅林身分、持湖者陣營）；(ii) 程式碼裡 `GoodLakeInfo` 用的是 Σ 單人二元熵，比聯合熵多算了約 2 bits（均勻時 9.71 vs 7.71 bits，差額是 total correlation），應改用 210 個世界的聯合熵；(iii) 紅方要的是讓藍方的熵**下降得慢**，紅方自己對梅林的熵則要下降得快。
5. **嫁禍（抹黑）的目標選擇在文獻裡屬於「可信度約束下的訊號設計」**：廉價談話（Crawford–Sobel 1982）、貝氏說服（Kamenica–Gentzkow 2011）、說謊成本（Kartik 2009），以及欺騙式規劃裡「隱藏真相（dissimulation）」和「展示假象（simulation）」的區分（Masters–Sardina 2017）。可以算出一條公式：宣告「T 是紅」之後，持湖者 H 是紅的事後勝算 = 事前勝算 × f / p_T，其中 p_T 是公開圖像裡 T 是紅的機率，f 是紅方嫁禍的傾向。當 p_T → 0，H 立刻暴露，H 陣營的熵從 0.97 bits 掉到 0 bit。Edward 說的「讓場上可以直接判斷你是紅方」就是這個情況。p_T 在 0.25–0.6 的灰色地帶時，H 的熵幾乎不變，這就是可否認性（deniability），見 §6.3 的表。Edward 列的三類目標都可以用這條公式解釋：(a) 交集多又可疑的人有「解釋掉（explaining away）」的效果；(b) 灰色地帶的人可否認性最高；(c) 梅林可疑人選造成的傷害最大，同時也是紅方對梅林身分的一次主動實驗。
6. **第一原理規則可以寫成「在 210 個世界上的刪除或排序」，而且能機器驗證**：湖鏈 A→B→C（皆宣藍）⇒ 在任何與「好人持湖說實話」一致的信念下，P(A 好) ≤ P(B 好) ≤ P(C 好)。隨機 2000 組信念，違反 0 次。交換引理：隊上有 A 沒有 B 時，把任一其他人換成 B，P(全隊好) 不會下降。隨機 6000 次，違反 0 次。這就是 Edward 第 (5)(ii) 點「選 A 必選 B 必選 C」的嚴格版本（§8）。另外，因為被湖過的人不能再被湖，湖鏈一定是一條路徑（首位持湖者 → T1 → T2 → T3），湖宣告之間不可能直接矛盾；現有程式碼的循環偵測在標準規則下不會觸發，真正要檢查的是「湖宣告 × 任務」的聯合一致性。

---

## 1. 我們的遊戲用資訊量來看（210 個世界）

`scripts/entropy_toy.py` 的輸出（均勻先驗，只用硬性限制）：

| 視角 | 一致的紅方集合數 | 熵（bits） |
|---|---:|---:|
| 公開（全桌，沒有私人資訊） | 210 | 7.714 |
| 忠臣（自己是好人） | 126 | 6.977 |
| 派西維爾（自己好＋兩個拇指恰好一紅） | 70 | 6.129（**拇指資訊值 0.848 bits**） |
| 梅林（看到 4 紅中的 3 個，莫德雷德隱藏） | 6 | 2.585 |
| 刺客／莫甘娜／莫德雷德（看到 2 個隊友，奧伯倫隱藏） | 7 | 2.807 |
| 奧伯倫（只知道自己） | 84 | 6.392 |

- **派西維爾 = 帶內建資訊的忠臣**（Edward 第 (1) 點）：數學上就是忠臣的 126 個世界，加上一條限制「拇指 {X, Y} 恰好一紅」，剩 70 個世界，等於比忠臣多 0.85 bits。所以派西的湖從頭到尾都是「藍方湖」，只是持湖者的信念多這一條限制。`GoodLakeInfo.ts` 的「持湖者信念」已經這樣寫了。
- **硬規則 (i) 本身的資訊量**：

| 隊伍人數 | 0 敗 | 1 敗 | 2 敗 | 3 敗 |
|---|---|---|---|---|
| 3 | 0 bit | 0.263 | 1.585 | 4.907 |
| 4 | 0 | 0.107 | 0.869 | 3.070 |
| 5 | 0 | 0.035 | 0.438 | 1.933 |

  任務成功時硬資訊是 0：紅方可以出成功，所以「任務過了 ⇒ 全員好」**不是**硬規則，只有在「支配策略」下才近乎硬，見 §8 的 H5。
- **加上真人的出牌似然後，一次任務的期望資訊** I(R; 失敗張數)（用 `GoodLakeInfo.ts` 的 `MISSION_FAIL_COUNTS`，1970 局牌譜的彙總）：R1 0.399、R2 0.405、R3 0.702、R4 0.849、R5 0.959 bits。這是「派這隊出任務」當作一次實驗的資訊價值上限（均勻先驗、隊伍沒有重疊時）。
- **湖宣告**（好人持湖者說實話）：「A 說 B 藍」刪掉 56 個世界，剩 154 個，0.447 bits；「A 說 B 紅」剩 140 個，0.585 bits；「A 說 B 藍」加「B 說 C 藍」剩 98 個，1.100 bits。

---

## 2. 隱藏身分遊戲的機器人（非 LLM）

### 2.1 DeepRole — Serrino, Kleiman-Weiner, Parkes, Tenenbaum, *Finding Friend and Foe in Multi-Agent Games*, NeurIPS 2019
- 連結：[arXiv 1906.02330](https://arxiv.org/abs/1906.02330) · [NeurIPS 2019](https://papers.nips.cc/paper_files/paper/2019/hash/912d2b1c7b2826caf99687388d2e8f7c-Abstract.html) · [程式碼](https://github.com/Detry322/DeepRole)（已讀）
- **是什麼**：5 人 Avalon（梅林、刺客、2 個抵抗者、1 個爪牙），CFR+ 搭配深度價值網路，靠自我對打訓練。
- **具體技術（從程式碼核對）**：
  - **信念 = 所有角色分配上的分布**：5 人局 `NUM_ASSIGNMENTS = 60`（2 紅的組合 10 × 誰是刺客 2 × 梅林在 3 好人中 3），`NUM_VIEWPOINTS = 15`（每個玩家的私人資訊種類）。機器人維護一個 60 維的「第三人稱信念」`new_belief`，也就是公共信念。
  - **演繹（deduction）融進 CFR 的方式**：`populate_full_reach_probs` 對每個分配 i，先檢查每一次歷史任務 `popcount(team & evil) < fails` 是否成立，成立就設成 0；其餘的機率 = Π_玩家 reach_prob[玩家][該分配下他的視角]。也就是說，**後驗 ∝ 先驗 × [硬限制成立] × Π_i π_i(歷史行動 | 視角_i)**，正好是 §5 的 PBS 更新式。
  - **匿名任務牌**：同一隊的兩個紅方誰出失敗看不到，程式碼用 `add_middle_cfvs` 對隊友組合展開來處理。
  - **顫抖（tremble）**：`TREMBLE_VALUE = 0.01`，每個策略混入 1% 的均勻行動，避免「這個人照模型不會這樣做」直接讓世界機率歸 0。這是區分「規則上的硬限制」和「行為慣例」的關鍵工程細節（§8）。
  - **刺殺**：終局節點 `TERMINAL_MERLIN` 讓刺客在 CFR 裡學一個依視角決定的刺殺分布，收益 = 該世界的 reach 機率 × 對錯。
  - 收益設定：紅方 ±1.5、藍方 ±1（3 藍 2 紅的零和）。機器人預設 CFR 跑 100 次迭代，前 50 次不計入（`ITERATIONS = 100, WAIT_ITERATIONS = 50`），搜尋深度 1，葉節點用神經網路估值。
- **真人資料**：repo 附了 ProAvalon 對局，彙總如下：人機混合 4024 局，機器人當紅方的座位勝率 67.1%（真人紅方 58.4%），當藍方 34.8%（真人藍方 35.7%）；純真人 335 局，藍方勝率 40.3%。這是逐座位的粗彙總，論文自己有控制機器人數量的分析，以論文為準。
- **成本**：5 人局每個節點是 60 維向量 × 15 視角。10 人局完整的角色分配有 210 × 4!（紅方角色）× 6（梅林）× 5（派西）= 151,200 種，是 5 人局的 2,520 倍；提名選項從 C(5,2..3) = 10 種變成 C(10,3..5)，最多 252 種；而且要重新訓練價值網路。**短期內 10 人局不可行。**
- **對應到我們的決策**：
  - 演繹那一層（列舉、硬限制設 0、似然相乘）**可以直接搬過來**，是 Edward 第 (5) 點的實作模板，而且我們的 `GoodLakeInfo.ts` 已經有 210 個世界加任務似然。
  - CFR 那一層（求均衡策略）不搬，改用 §5 的 level-k。
  - 刺殺：對應 `assassin/AssassinModel.ts`。DeepRole 的作法是「刺殺 = 在信念下對梅林身分取 argmax」，信念要含紅方私人資訊（知道哪些人是藍，只有奧伯倫不確定）。

### 2.2 2012 年 Resistance AI 比賽（Game/AI Conference Vienna、Dagstuhl 研討會 12191）
- 連結：[aigamedev/resistance](https://github.com/aigamedev/resistance)（已讀；`bots/1/` 是 Vienna 2012 的參賽作品，`bots/0/` 是 Dagstuhl 2012 年 4 月 jam 的作品）
- **具體技術（從程式碼核對）**：
  - `intermediates.Simpleton`：列出所有間諜組合，`onMissionComplete` 只保留「隊上間諜數 ≥ 破壞數」的組合，也就是 Edward 的規則 (i)。投票規則：沒有任何一致的組合能讓這隊全好，就反對。
  - `intermediates.Bounder`（Peter Cowling 的設計）：同時維護兩個集合，**悲觀集合**只用「間諜數 ≥ 破壞數」（硬），**樂觀集合**用「間諜數 = 破壞數」（假設間諜一定破壞，屬於軟假設）。先用樂觀集合，樂觀集合空了才退回悲觀集合。這是「硬規則 vs 行為慣例」分層的最早範例，跟我們金字塔的分層同一個想法。
  - `learners.py`：逐人統計加貝氏定理，例如「P(投贊成 | 是間諜)」。
  - 比賽報告的結論（搜尋摘要）：長期來看簡單策略常常贏過複雜策略。
- **「Taylor 的機器人」**：查不到可核對的出處。找得到的相關材料是 UWA CITS3001 課程的 Resistance AI 專題（[範例報告](https://teaching.csse.uwa.edu.au/units/CITS3001/project/sampleReport.pdf)），裡面同樣主張「對每個可能世界 w 算 P(a|w)，再用貝氏更新」。
- **成本**：5 人局 10 種組合，可以忽略。
- **對應**：投票和派隊的「可接受性」檢查（`checkHardRulesForLeader`／`findTeamHardRuleViolations`）應該改成在 210 個世界上做存在性檢查。另外，Bounder 的雙層作法可以直接拿來用：先用軟假設，軟假設下找不到一致的世界就退回只用硬規則。目前 `GoodLakeInfo` 的作法是「一致的世界為空就丟掉湖宣告」，那是退回的一個特例。

### 2.3 AvalonBench 的規則型機器人（見 §3.2）
- `NaiveServant`（[程式碼](https://github.com/jonathanmli/Avalon-LLM/blob/main/src/server/tasks/avalon/agents/baseline_agents.py)，已讀）：列舉所有可能的陣營分配 `possible_player_sides`，任務結果出來就把「隊上紅方數 < 失敗數」的分配機率設 0 再正規化，選「全隊是好人的機率」最大的隊伍。**這個純演繹的機器人當好人勝率 38.2%，ChatGPT 是 22.2%。**

### 2.4 其他
- **DeepBayes**（Xu 等，*Optimizing strategy selection in hidden role games*，Engineering Applications of AI vol. 162, 112464, 2025-12）：CFR+ 加上「貝氏身分辨識（BIR）」線上輸出對手身分的事後機率，再加一個由歷史預測角色分配的網路。只做 5 人局。[連結](https://www.sciencedirect.com/science/article/abs/pii/S0952197625024959)（僅摘要）。
- **Chuchro 等 2022，*Training an Assassin AI for The Resistance: Avalon***（[arXiv 2209.09331](https://arxiv.org/abs/2209.09331)）：把刺殺當成分類問題，用公開線上對局資料訓練，線性 SVC 就達到高於平均真人的水準。我們的 `AssassinModel` 是同一條路線（測試集刺中率 14.8% → 29.7%，見 `strength_benchmark.md`）。
- **Cowling, Whitehouse, Powley 2015，*Emergent Bluffing and Inference with Monte Carlo Tree Search***（IEEE CIG 2015，DOI 10.1109/CIG.2015.7317927）：在 ISMCTS 上加「推論」（從觀察到的行動推回對手行動的機率）和「自我決定化（self-determinization）」，也就是從對手視角抽樣可能狀態，虛張聲勢由此自然產生。這是「用搜尋讓欺騙行為自己出現」的路線（僅摘要）。
- **Carminati, Zhang, Farina, Gatti, Sandholm，*Hidden-Role Games: Equilibrium Concepts and Computation*，EC 2024**（[arXiv 2308.16017](https://arxiv.org/abs/2308.16017)，[DOI](https://doi.org/10.1145/3670865.3673616)）：第一個嚴格的隱藏身分遊戲均衡定義，稱為 hidden-role equilibrium，是 split-personality 形式下的團隊 max-min 均衡。結果跟溝通管道（能否私下溝通）有關；對 5、6 人 Avalon 算出精確均衡，資訊集數超過 10^56。對我們的用處是理論上限：5 人以上的均衡是算得出來的，但只限小局，而且要專門演算法（僅摘要）。

---

## 3. LLM 的 Avalon／隱藏身分代理人（2023–2026）：推理 vs 說服

| 研究 | 技術 | 關於推理與說服的發現 |
|---|---|---|
| **ReCon**（Wang 等，[arXiv 2310.01320](https://arxiv.org/abs/2310.01320)，2023；ACL Findings 2024） | 兩階段：先形成想法與發言，再修正；加入一階視角（推測別人在想什麼）和二階視角（別人怎麼看我） | 不加訓練就能讓 LLM 比較能識破欺騙。**二階視角 = level-2**，直接對應 Edward 說的「t2 解讀 t1 對 t0 的解讀」 |
| **AvalonBench**（Light 等，[arXiv 2310.05036](https://arxiv.org/abs/2310.05036)，NeurIPS 2023 workshop；[code](https://github.com/jonathanmli/Avalon-LLM)） | 遊戲環境＋規則型機器人＋角色提示的 LLM | ChatGPT 當好人 22.2% vs 規則機器人 38.2%。作者的結論：LLM 在推理、說服、談判、欺騙上都還不夠 |
| **Stepputtis 等**，*Long-Horizon Dialogue Understanding for Role Identification in Avalon*（[EMNLP Findings 2023](https://aclanthology.org/2023.findings-emnlp.748)） | 20 局真人標註資料；每輪延續一個「對每個玩家身分的信念狀態」 | 最強的 LLM 也到不了真人的身分辨識水準 |
| **Lan 等**，*LLM-Based Agent Society…Avalon*（[arXiv 2310.14985](https://arxiv.org/abs/2310.14985)，EMNLP 2024） | 多代理人框架、系統提示 | 主要觀察社交行為（合作、對抗），不是推理能力 |
| **Strategist**（Light 等，[arXiv 2408.10635](https://arxiv.org/abs/2408.10635)，ICLR 2025） | 雙層：LLM 寫文字策略和價值啟發函數，底層用 MCTS 執行，自我對打改進 | 價值啟發加樹搜尋才有接近真人的表現 |
| **GRAIL**（Rahimirad 等，*Bayesian Social Deduction with Graph-Informed Language Models*，[arXiv 2506.17788](https://arxiv.org/abs/2506.17788)，ACL 2026） | **因子圖做角色信念**（max-product 置信傳播），LLM 只負責「這段對話讓某人的先驗上調、下調或不變」，派隊和投票用啟發規則（全隊都比較可能是好人才贊成） | 大模型要大量推理時間，蒸餾成小模型後就大幅退化。把推理交給結構化模型後，對新手真人勝率 67%（推理模型基線 27%）。**這是目前最直接支持「推理交給外部機率模型」的證據** |
| **Thinker**（Wu 等，*Enhance Reasoning for LLMs in the Game Werewolf*，[arXiv 2402.02330](https://arxiv.org/abs/2402.02330)，ICML 2024） | System-1（LLM 處理語言）／System-2（外部 Thinker 做推理），用 18,800 局真人資料加 RL 訓練 | 推理交給外部模組後，6B 模型就能超過 GPT-4 |
| **ONUW**（Jin 等，*Learning to Discuss Strategically*，[arXiv 2405.19946](https://arxiv.org/abs/2405.19946)，NeurIPS 2024） | 先證明有無討論兩種情況下的完美貝氏均衡（PBE），再用 RL 選討論策略 | **討論透過改變信念來改變收益**，所以說服是一種訊號設計問題（對應 §6） |
| **CICERO**（Meta FAIR，Science 2022，DOI 10.1126/science.ade9097） | 規劃模組先產生「意圖」，對話以意圖為條件生成，再過濾跟意圖不一致的訊息 | 言行一致（訊息受意圖約束）是設計上的選擇，但不完美 |
| 2026 預印本（**只有搜尋片段，未核對**）：Avalon-ToM-Bench（arXiv 2608.09638）、Trust, Lies, and Long Memories（2604.20582）、Auditing Belief-Conditioned LLM Agents（2607.10814，狼人殺：外接信念狀態，好人勝率 0.205 → 0.390）、MafiaScope（2607.10645） | 外接信念狀態、逐句信念探測、跨局聲譽 | 同一個方向：**顯式的信念狀態**比讓 LLM 內部隱式推理更好 |

**對我們的意義**：ForwardAgent 不用 LLM，所以這一節的價值在於它的反面證據：推理那一層一定要是顯式、可驗證的機率模型（210 個世界）。「解讀、說服」那一層可以用 level-k 的似然來建模，不需要語言模型。

---

## 4. 不完全資訊遊戲的搜尋與 CFR：公共信念狀態

### 4.1 共同資訊法與 PBS（理論基礎）
- **Nayyar, Mahajan, Teneketzis 2013**，*Decentralized Stochastic Control with Partial History Sharing: A Common Information Approach*，IEEE TAC 58(7)（[arXiv 1209.1695](https://arxiv.org/abs/1209.1695)）：把分散決策改寫成一個「協調者」的 POMDP。協調者只看共同（公開）資訊，它的「行動」是一組**部分策略**（從私人資訊到行動的映射）。這樣就得到所有控制者的動態規劃（Bellman 方程）。
- **POMDP 的信念 MDP**（Kaelbling, Littman, Cassandra 1998，*Artificial Intelligence* 101）：V(b) = max_a [ r(b,a) + Σ_o P(o|b,a) V(τ(b,a,o)) ]。**Edward 說的「Bellman 方程」在多人版本就是 PBS 上的 Bellman。**
- **BAD**（Foerster 等，*Bayesian Action Decoder*，[ICML 2019](https://proceedings.mlr.press/v97/foerster19a.html)）：所有人共享一個公共信念，按全部人的行動做貝氏更新。行動空間是「確定性的部分策略」，所以只看公共信念的代理人也能用到自己的私人資訊。作者明確把這個更新連到人類的心智理論（theory of mind）。Hanabi 是資訊不對稱的**合作**遊戲，正好是 Edward 說的「資訊不對稱合作遊戲」。
- **ReBeL**（Brown, Bakhtin, Lerer, Gong，[NeurIPS 2020](https://arxiv.org/abs/2007.13544)）：PBS 的定義是「由公開觀察**和所有人的策略**決定的共同知識信念」。自我對打 RL 加上在 PBS 上做 CFR 子局搜尋，在二人零和遊戲中可證明收斂到納許均衡。
- **對應（這段是 §0 第 2、3 點的根據）**：
  - 公共信念 β_t(w)，w 是 210 個紅方集合，或含角色的 151,200 種分配。
  - 更新式：**β_{t+1}(w) ∝ β_t(w) · π_i(a_t | s_i^t(w), β_t)**。這條式子的三個要素：
    1. s_i^t(w) 是玩家 i **在 t 當下**的私人資訊（例如湖前不含湖結果、湖後含）。這就是「資訊流、事件順序」。
    2. π_i 依賴 β_t，而 β_t 是由 β_{t−1} 和 π_{t−1} 算出來的，所以 t2 的解讀遞迴地包含 t1 對 t0 的解讀。
    3. 「均衡」= 不動點：每個 π_i 都是對「由 π 本身誘導出的信念動態」的最佳回應。這就是完美貝氏均衡／序列均衡的一致性（Kreps & Wilson 1982，*Econometrica* 50(4)）。
  - 程式碼上已經有積木：`benchmark/replayObservation.ts` 會把觀察截斷到某個時間點（`votesUntil`／`questsBefore`／`lakesUntil`），也就是重建「當下的資訊集」的工具。`ToMReverseEngine.ts` 目前用的是**現在的完整觀察**去反推別人，沒有截斷到行動當時，這跟 Edward 第 (4) 點不一致。

### 4.2 搜尋家族（依成本排序）
| 方法 | 是什麼 | 成本 | 能不能用在 10 人 Avalon |
|---|---|---|---|
| **精確信念過濾＋藍圖策略**：SPARTA（Lerer, Hu, Foerster, Brown，[AAAI 2020](https://ojs.aaai.org/index.php/AAAI/article/view/6208)） | 大家同意一個藍圖策略；搜尋者用「與他人在藍圖下的行動一致」來精確過濾信念，再對候選行動做 rollout。保證不會比藍圖差（誤差有界）。Hanabi 24.61/25 | 精確信念要對每條可能軌跡評估藍圖；後續的 Learned Belief Search 指出這只適合小的信念空間 | **可以**。我們的信念空間只有 210 或 151,200，藍圖就是現有的 HeuristicAgent／真人先驗。候選數 × rollout 數 × 一局模擬時間，例如 20 × 200 × 1ms ≈ 4s/決策，適合離線評估，線上偏慢 |
| **PIMC／ISMCTS**（Long 等 AAAI 2010；Cowling, Powley, Whitehouse，IEEE TCIAIG 2012；[Whitehouse 論文](https://etheses.whiterose.ac.uk/id/eprint/8117/)） | 抽樣確定化的世界，各自搜尋後合併 | 便宜，但有「策略融合（strategy fusion）」問題：在不同世界各自選最佳，合起來的行動可能在任何一個世界都不是最佳 | 只能當作 rollout 的工具，**不能**用來推理身分 |
| **Libratus／Pluribus**（Brown & Sandholm，Science 2018／2019，DOI 10.1126/science.aay2400） | 藍圖策略＋即時的深度受限子局求解；Pluribus 是 6 人局 | 叢集等級算力；多人局沒有收斂保證 | 不適用（撲克的公開狀態結構不同） |
| **DeepStack／ReBeL／Student of Games**（Moravčík 2017 Science；Brown 2020；Schmid 等 2023 [Sci. Adv.](https://arxiv.org/abs/2112.03178)，GT-CFR） | PBS 價值網路加局部 CFR | 要訓練 PBS 價值網路；PBS 維度 = 世界數 × 玩家視角 | 10 人局不可行（同 §2.1） |

### 4.3 CFR 本身
- CFR（Zinkevich 等，[NeurIPS 2007](https://papers.nips.cc/paper/3306-regret-minimization-in-games-with-incomplete-information)），CFR+（Tammelin 2014，arXiv 1407.5042），MCCFR（Lanctot 等，NeurIPS 2009），Deep CFR（Brown 等，ICML 2019）。
- 在隱藏身分遊戲的用法：DeepRole 的 vector-form CFR（§2.1）、Carminati 2024 的團隊 max-min 版本（§2.4）。
- **對應**：對我們最有用的不是 CFR 求出的策略，而是兩件事：(a) **後悔值（regret）作為診斷工具**：在自我對打中，對某個決策點算「如果換成另一個行動，反事實收益是多少」，可以找出明顯被支配的規則；(b) **顫抖機制**（§2.1）。

---

## 5. 資訊理論的行動選擇

### 5.1 工具
- **熵與互資訊**（Shannon 1948）。用語釐清：Edward 說「資訊量 = 亂度 = 不確定性」，嚴格說，**熵 H 是不確定性；資訊量是熵的下降**；「期望資訊量」就是互資訊 I(世界; 觀察)。
- **期望資訊增益（EIG）／最佳實驗設計**：Lindley 1956（*Ann. Math. Stat.* 27(4)，「一個實驗提供多少資訊」）；MacKay 1992（*Neural Computation* 4(4)，主動學習的資訊目標）；BALD（Houlsby 等 2011，arXiv 1112.5745，只有在「模型之間意見分歧」的地方才有資訊）；Rainforth, Foster, Ivanova, Bickford Smith，*Modern Bayesian Experimental Design*（[Statistical Science 39(1), 2024](https://arxiv.org/abs/2302.14545)）。
- **資訊導向抽樣（IDS）**：Russo & Van Roy，*Learning to Optimize via Information-Directed Sampling*（[Operations Research 66(1), 2018](https://arxiv.org/abs/1403.5556)）。每一步選 **(期望單步遺憾)² / 資訊增益** 最小的行動，資訊增益是「最佳行動」與下一個觀察的互資訊。這是「推進任務 vs 取得資訊」權衡的標準答案：資訊只在能改變最佳行動時才算數。
- **價值資訊（VOI）**：Howard 1966（*IEEE Trans. SSC* 2(1)），資訊值 = 決策改善的期望收益。熵下降是 VOI 的代理指標，兩者不相等。
- **猜碼遊戲**：Knuth 1977（Mastermind 的 minimax 策略）；Kooi 2005（ICGA Journal 28(1)，以最大化期望資訊的策略）。都是「每一步選讓剩餘可能數的熵最大下降的猜測」，跟 Wordle 解法同一招。

### 5.2 三個要先講清楚的地方
1. **誰的熵？** 有三種：(a) 公開 PBS（全桌）；(b) 藍方的共同圖像（公開資訊加上「我信任的持湖者是好人」，`GoodLakeInfo` 的 common picture）；(c) 每個人的私人信念。Edward 說「其他都要從藍方視角去思考」，所以藍方的決策評分用 (b)/(c)，紅方的決策評分用「紅方模擬的 (b)」，也就是紅方想讓藍方看到什麼。
2. **哪個變數的熵？** 至少有三個：紅方集合 R（7.71 bits）、梅林身分 M（從看得到隊友的紅方視角：奧伯倫位置未知時，梅林均勻分布在 7 個未知座位上，log2 7 = 2.81 bits；奧伯倫已知時 log2 6 = 2.58 bits）、某個持湖者的陣營（1 bit）。藍方要降低 H(R)、維持 H(M | 紅方視角)；紅方相反。所以每個動作都應該有一個**雙邊**評分：例如梅林的動作 = 降低藍方的 H(R) − κ × 降低紅方的 H(M)。這就是「梅林的兩難」，屬於隱私與效用的權衡（類似欺騙式規劃中的「隱藏真相」，§6）。
3. **聯合熵 vs 邊際熵之和**：`GoodLakeInfo.ts` 用 U = Σ_j h(q_j)。在均勻先驗下，U = 9.71 bits，而真正的 H(R) = 7.71 bits，差 1.995 bits，就是 total correlation（因為紅方總數固定是 4，單人邊際彼此相關）。用 Σ h 當排序指標大致可以，但會高估「把一個人搞清楚」的價值，低估「把一對人的關係搞清楚」的價值，而湖鏈和任務交集提供的正好是關係資訊。程式碼已經有 210 個世界的權重，改成聯合熵 −Σ_w β(w) log β(w) 幾乎不花成本。

### 5.3 對應到每一種決策
| 決策 | 資訊理論的形式 | 現有程式碼 | 建議 |
|---|---|---|---|
| **派隊**（藍方隊長） | 目標 = P(全隊好) + λ · I(R; 失敗張數 \| 這隊)；或 IDS：min 遺憾² / I | `ForwardAgent` 依懷疑度總和列舉隊伍 | 改用 210 個世界算 P(全隊好)（精確，取代懷疑度相加）。I(R; F) 用 `missionLikelihood` 算，每隊 210 × (k+1) 次運算，便宜。λ 在前面的輪次大、後面小（R4/R5 只管能不能過） |
| **投票** | 我的一票本身是訊號，資訊 = I(R; 我的票)；但對藍方來說主要是決策：贊成 ⇔ P(全隊好 \| 我的信念) 夠高 | `voteOnTeam` 加硬規則 | 硬規則改成「在 210 個世界上，這隊全好的機率是否 > 0」（Simpleton 的作法）；軟規則用機率門檻 |
| **任務牌**（紅方） | 出失敗 = 推進 + 洩漏 I(R; F)。例如 3 人隊 2 敗洩漏 1.585 bits，1 敗只洩漏 0.263 bits | `humanQuestCardRules` | 可以定量回答「兩紅同隊時出幾張失敗」：1 張失敗推進相同（R4 例外，10 人局 R4 要 2 張），洩漏少很多 |
| **湖目標**（藍方，含派西） | ΔH(c) = U(common) − Σ_x P_holder(c = x) · U(common \| c = x) | `GoodLakeInfo.pickGoodLakeTargetInfoMax`（已是 EIG） | 改用聯合熵；派西用帶拇指限制的信念（已做）；若要湖拇指，加雙邊評分（見下面） |
| **湖宣告**（紅方） | 訊號設計，見 §6 | `LakePolicy` 的 chaos 模式（frame／humanRate） | §6.3 的可否認性評分 |
| **刺殺** | argmax_j P(M = j \| 歷史, 紅方私人資訊)；資訊來源 = Σ_t log [π_梅林(a_t^j) / π_忠臣(a_t^j)] | `AssassinModel`（真人資料訓練） | 可以加一個 level-1 的似然比特徵：「j 的行動在梅林視角下（避開已知紅）vs 忠臣視角下的機率比」 |
| **派西湖拇指**（Edward 第 (1) 點延伸） | 私人增益：知道誰是梅林，1 bit。公開成本：宣「X 藍」會讓 X 在紅方眼中變成高梅林嫌疑，H(M \| 紅) 下降 | 目前規則是派西跳過兩個拇指 | 用雙邊評分取代硬規則，可以量化 |

---

## 6. 欺騙理論：抹黑／嫁禍的目標要「可信」

### 6.1 文獻
- **廉價談話（cheap talk）**：Crawford & Sobel 1982（*Econometrica* 50(6)）。說話不花成本、可以說謊時，均衡只能傳達「粗略」的資訊，偏好差距越大，可信的資訊越少。湖宣告就是廉價談話：說什麼都不花成本，可信度全看聽的人怎麼建模說話者的策略。
- **貝氏說服**：Kamenica & Gentzkow 2011（*AER* 101(6)）。發訊者事先承諾一個訊號結構；在二元狀態下，最優解由收益函數在事後信念上的凹包絡決定，只需要兩個事後信念。啟示：**紅方真正能控制的是「讓藍方產生什麼事後信念」，而事後信念受到貝氏一致性的約束**，平均起來必須等於事前信念。這就是「說謊必須可信」的數學版本。
- **說謊成本**：Kartik 2009（*Review of Economic Studies* 76(4)）。有說謊成本時，訊息會普遍「膨脹」，而且高端訊息會混同（pooling）。對應：紅方在湖上宣藍（洗白）比宣紅（嫁禍）常見，真人資料也是這樣（`HUMAN_FRAME_RATE` 在 0.13–0.36 之間）。
- **訊號與序列均衡**：Spence 1973（QJE）、Kreps & Wilson 1982。事後信念必須用貝氏規則從策略推出來。
- **欺騙式規劃**：Masters & Sardina 2017，*Deceptive Path-Planning*（[IJCAI 2017](https://www.ijcai.org/proceedings/2017/610)）。把欺騙分成**展示假象（simulation）**和**隱藏真相（dissimulation）**，並定義「最後欺騙點」。Savas 等，*Deceptive Decision-Making Under Uncertainty*（AAAI 2022，arXiv 2109.06740）。欺騙的量化方式是「觀察者後驗的模糊程度（熵）」。
- **解釋掉（explaining away）**：Pearl 1988。一個結果有兩個可能原因，確認其中一個，另一個的機率就下降。

### 6.2 把 Edward 的三類嫁禍目標對應到理論
設 H 是持湖者（紅），T 是目標（真實為藍），H 公開宣告「T 是紅」。藍方的推論：

**P(H 紅 | 宣 T 紅) 的事後勝算 = 事前勝算 × [f · P(T 藍 | H 紅) + s · P(T 紅 | H 紅)] / P(T 紅 | H 藍)**

其中 f 是紅方對藍方目標的嫁禍傾向，s 是紅方宣告隊友是紅的傾向（很小）。分母 p_T := P(T 紅 | H 藍, 公開資訊) 就是「如果 H 是好人在說實話，這句話有多合理」。

- **(a) 任務交集多又已有嫌疑的好人**：p_T 本來就高，所以可信。還有額外效果：如果 H 跟 T 出過同一個失敗任務，宣 T 紅會**解釋掉**那張失敗，H 和同隊其他人的嫌疑一起下降。`LakePolicy` 的 `chaos: 'frame'`（同一個失敗任務、紅方只差一勝）就是這一類。
- **(b) 灰色地帶的好人**：p_T 在中間（約 0.25–0.6），這時「H 說真話」和「H 在嫁禍」兩個解釋都說得通，H 陣營的熵幾乎不變，也就是可否認性最高（見 §6.3 的表）。
- **(c) 梅林可疑人選**：傷害最大。藍方不再跟隨 T，等於梅林提供的資訊被打折。而且這是一次實驗：真的梅林知道 H 在說謊（除非 H 是莫德雷德），梅林之後要選擇「替 T 辯護」（洩漏自己）或「放棄一個好人」。所以嫁禍梅林可疑人選，同時提高紅方對梅林身分的期望資訊增益。
- **反例：讓場上熵大幅下降的目標**：p_T ≈ 0。被湖過的人不能再被湖（H6），所以這種目標不會來自湖鏈本身，而是來自任務：例如 T 在紅方二勝時通過的任務隊上（H5「鐵四好」），或任務失敗數已經把 4 個紅方的位置限定在 T 以外（H1）。這時事後勝算 → ∞，H 直接被判定為紅，H 陣營的熵掉到 0。**這正是 Edward 說的「這個湖中會讓場上可以直接判斷你是紅方」。**
- **少被注意的一點：湖會傳給 T。** 被湖的 T 拿到下一次湖。嫁禍一個真藍的 T，等於讓 T 下一次（誠實的）湖在藍方眼中打折：可信度 = 1 − P(T 紅 | 宣告)。也就是說，嫁禍同時降低了下一次湖的資訊價值。這可以直接接到 `GoodLakeInfo` 的信任鏈項 T(c)。

### 6.3 數字（`entropy_toy.py` 第 6 節；事前 P(H 紅) = 0.4，s = 0.05）
| f | p_T | P(H 紅 \| 宣告) | H 陣營的熵（bits） | P(T 紅 \| 宣告) |
|---|---:|---:|---:|---:|
| 0.3 | 0.00 | 0.40 → **1.00** | 0.97 → **0.00** | 0.08 |
| 0.3 | 0.02 | 0.40 → 0.88 | 0.97 → 0.53 | 0.19 |
| 0.3 | 0.10 | 0.40 → 0.59 | 0.97 → 0.98 | 0.45 |
| 0.3 | 0.25 | 0.40 → 0.37 | 0.97 → 0.95 | 0.66 |
| 0.3 | 0.40 | 0.40 → 0.27 | 0.97 → 0.83 | 0.76 |
| 0.6 | 0.25 | 0.40 → 0.53 | 0.97 → 1.00 | 0.49 |
| 0.6 | 0.40 | 0.40 → 0.41 | 0.97 → 0.98 | 0.61 |

**均衡的含意（level-2）**：藍方模型中的 f 越大，同一句「T 是紅」的殺傷力越小（f = 0.6 時 P(T 紅 | 宣告) 比 f = 0.3 低 0.15–0.17）。所以紅方的最佳嫁禍頻率是一個**混合策略**，不能每次都嫁禍。這也解釋了牌譜中真人的嫁禍頻率為什麼在 0.13–0.36 之間：太常嫁禍，宣告就不值錢。

**建議的嫁禍評分**：分數(T) = 傷害(T) × 可信度(T)，同時扣掉暴露成本。
- 傷害(T) = 藍方共同圖像中 T 的價值（是不是信任鏈的下一任持湖者、是不是梅林可疑人選、是不是常被派上隊）。
- 可信度(T) = p_T，在 [0.2, 0.6] 附近最好，p_T < 0.05 直接排除。
- 暴露成本 = λ · [H_b(π_H) − H_b(事後的 π_H)]⁺，其中 H_b 是二元熵。

所有量都可以用 `GoodLakeInfo` 已有的世界列舉，從「紅方模擬的藍方共同圖像」算出來。

---

## 7. 遞迴心智理論：level-k、I-POMDP、「t2 解讀 t1 對 t0 的解讀」

### 7.1 文獻
- **Level-k**：Stahl & Wilson 1995（*Games and Economic Behavior* 10(1)）；Nagel 1995（*AER* 85(5)，選美比賽實驗，眾數大約在 level-2）。**認知層級（CH）**：Camerer, Ho, Chong 2004（*QJE* 119(3)）。第 k 層對「0 到 k−1 層的 Poisson 混合」做最佳回應，平均約 1.5 層就能擬合大量實驗資料。
- **多階段不完全資訊遊戲的動態 CH**：Lin（與 Palfrey 共同發展的 DCH），*Cognitive Hierarchies in Multi-Stage Games of Incomplete Information*（[arXiv 2208.11190](https://arxiv.org/abs/2208.11190)）。在多階段遊戲中，玩家隨著歷史推進，同時學到對手的類型和對手的思考層級；低層級玩家比高層級更晚才推出自己的類型。重點是「信念隨時間演化，而且演化方式依層級不同」，正好對應 Edward 第 (4) 點。
- **I-POMDP**：Gmytrasiewicz & Doshi 2005（*JAIR* 24，[arXiv 1109.2135](https://arxiv.org/abs/1109.2135)）。狀態空間包含其他代理人的模型（含他們的信念），信念可以無限巢狀；可計算的版本是「有限巢狀」，最底層用不推論的模型（例如有限狀態機）。
- **貝氏心智理論**：Baker, Jara-Ettinger, Saxe, Tenenbaum 2017（*Nature Human Behaviour* 1:0064）。人推論別人的信念和目的，是在反推一個近似理性的規劃者。
- **理性言語行為（RSA）**：Goodman & Frank 2016（*Trends in Cognitive Sciences* 20(11)）。L0 只看字面，S1 對 L0 說話，L1 反推 S1，以此遞迴。湖宣告和派隊都是「言語行為」，可以用 RSA 的層級來解讀：level-0 只看字面（「他宣藍，所以是藍」）；level-1 會問「他如果是紅，會不會也這樣說」。
- **Off-Belief Learning**（Hu 等，[ICML 2021](https://proceedings.mlr.press/v139/hu21c.html)）：學習 π1 時，假設**過去**的行動來自固定的 π0，**未來**的行動來自 π1；然後把 π1 當成下一層的 π0，層層往上。π0 用均勻隨機時，得到不依賴任意慣例的「有根據（grounded）」策略。這是在合作遊戲中「可控的多層推理」最乾淨的作法。
- **ReCon 的二階視角**（§3）：LLM 版本的 level-2。

### 7.2 對應：把 Edward 的 (4) 寫成演算法
- **Level-0**（第一原理）：β⁰_t = 只用硬規則過濾的 210 個世界（§8 的 H1–H4）。
- **Level-1**：β¹_{t+1}(w) ∝ β¹_t(w) · π^{真人}_i(a_t | s_i^t(w))。π^{真人} 是牌譜先驗（`priors/top10_behavior_priors_*.json`、`MISSION_FAIL_COUNTS`、`HUMAN_FRAME_RATE`），在世界 w 下用 i **在 t 當時**的資訊算。
- **Level-2**：π_i 本身依賴 i 在 t 當時的 level-1 信念，也就是 β¹ 從 i 的視角、截斷到 t。例如：一個紅方知道全桌在用 level-1 解讀，就會避開在 level-1 下看起來很紅的行動，所以他做出「看起來很紅的行動」的機率比 level-1 模型預測的還低，看到這種行動時，紅的證據反而更強。
- **成本**：每個玩家的視角種類很少：忠臣 1 種、派西 36 種拇指組合、梅林 84 種、紅方依看到的隊友組合而定。所以每一步只要對每個（玩家, 視角）算一次 level-1 信念，大約 10 × 200 × 210 ≈ 4 × 10⁵ 次運算，在 TypeScript 裡是毫秒級。Level-3 以上的收益很小（Nagel、Camerer 的實驗資料：真人約 1.5–2 層），**建議停在 level-2**。
- **找不動點（Edward 說的「均衡」）**：把 level-k 迭代到 π^{k+1} ≈ π^k 就是不動點，類似虛擬對局（fictitious play）。但 OBL 和 CH 的經驗都顯示：**刻意停在有限層級，比追求精確均衡更穩，也更像真人。**

### 7.3 硬3 的時間性，量化（`entropy_toy.py` 第 5 節）
- 湖前，A 帶 4 人隊沒帶 B：好人 A 和紅人 A 都是在 9 個人裡挑 3 個，P(不帶 B) = 2/3，概似比 1.00，**0 bit**。
- 湖後：P(不帶 B | 好 A) = ε（被支配，見 §8 的交換引理）。P(不帶 B | 紅 A) ≈ 0.3–0.5。
  - ε = 0.05、紅方 0.5 → LR 10（3.32 bits）
  - ε = 0.10、紅方 0.5 → LR 5（2.32 bits）
  - ε = 0.05、紅方 0.3 → LR 6（2.58 bits）
- 事前 P(A 紅) = 0.4 時，LR 6 → 0.80，LR 10 → 0.87。也就是說，**現在的 ≥0.85 下限在湖後大致合理，在湖前是錯的（應該是 0.40 不變）。**
- **重要的細節**：所謂「湖前的行動不算」，指的是**對「替 B 背書」這個假設不算**。湖前的行動在一般 PBS 更新裡仍然是證據，因為紅人 A 從 t=0 就知道 B 的陣營（除非 B 是奧伯倫）。正確作法不是把湖前的歷史丟掉，而是**用當時的資訊集去算似然**；硬3 只是這個原則的一個特例。
- 現行程式碼 `findRule3Violators` 的另外兩個問題（main 分支）：
  - (a) 只要 `rec.team.length >= 1` 而且沒帶 B 就判違規，沒有檢查「A 有沒有在隊上」和「A 換掉 B 改帶的人，在 A 的私人視角下是不是不確定的」。例如 A 是梅林時，其他人在 A 眼中可能也是確定的好人，這時不帶 B 並沒有被支配。
  - (b)「帶過失敗隊伍 +0.5」跟背書無關，應該交給一般的任務似然處理，不該算在硬3 裡。
  - 程式碼已經有 `postLakeOnly` 診斷開關（只在 benchmark 使用），把它設為預設就是 Edward 指示的最小修改。

---

## 8. 第一原理規則清單（硬／近硬／軟），每一條都寫成對 210 個世界的操作

| # | 規則 | 類型 | 在世界上的操作 | 文獻／來源 |
|---|---|---|---|---|
| H1 | 任務 x 張失敗 ⇒ 該隊至少 x 紅 | **硬**（遊戲規則：好人不能出失敗） | 刪除 \|w ∩ 隊\| < x 的世界 | DeepRole `populate_full_reach_probs`、Simpleton、NaiveServant |
| H2 | 自己的視角：忠臣排除自己；派西的拇指恰好一紅；梅林看到的 3 個 ⊆ w；紅方看到的隊友 ⊆ w | **硬** | 依視角過濾（§1 的表） | DeepRole 的 viewpoints |
| H3 | 自己持湖看到的結果 | **硬**（私人） | 過濾 | — |
| H4 | 好人持湖者說實話：A 宣 B 藍 ⇒ ¬(A 好 ∧ B 紅)；A 宣 B 紅 ⇒ ¬(A 好 ∧ B 好) | **近硬**（慣例；用顫抖 ε，ε 從牌譜的好人說謊率估） | 刪除，或乘上 ε | `lakeDeclareLiePrior`（好人說謊權重 0） |
| L1 | **湖鏈排序**：A 宣 B 藍、B 宣 C 藍 ⇒ 在任何滿足 H4 的信念下 P(A 好) ≤ P(B 好) ≤ P(C 好) | **定理**（由 H4 推出） | 不用另外實作，從 H4 自動成立 | 本文證明：{A 好} ⊆ {B 好} 這個集合包含關係；隨機 2000 組信念驗證 0 違反 |
| L2 | **交換引理**：隊上有 A 沒有 B，把任一其他人 X 換成 B，P(全隊好) 不下降 | **定理** | 派隊：「選 A 必選 B 必選 C」（Edward (5)(ii)） | 證明：P(S 全好) = P(S ∪ {B} 全好) ≤ P(S ∪ {B} \ {X} 全好)；隨機 6000 次驗證 0 違反 |
| L3 | **硬3 的正確版本**：湖後，好人 A 帶隊而有空位時，不帶 B 是被支配的 | 由 L2 推出的**行為**推論 | 似然 ε（不是固定 0.85） | §7.3 |
| H5 | **支配策略**：紅方再一勝就贏、而且該輪需要的失敗數 ≤ 隊上紅方數時，紅方一定出失敗 ⇒ 這種任務成功 ⇒ 全隊好 | **近硬**（只有失誤才會違反） | 刪除 \|w ∩ 隊\| ≥ 所需失敗數的世界（10 人局 R4 要 2 張失敗） | 重複刪除被支配策略；`GoodLakeInfo` 註解的「鐵四好」 |
| H6 | **湖鏈是一條路徑**：當過持湖者或被湖過的人不能再被湖（`deriveValidLakeTargets`），所以每人最多被湖一次，宣告鏈是 首位持湖者 → T1 → T2 → T3（最多 3 次）。湖宣告**彼此之間不可能直接矛盾**，矛盾只會出現在「湖宣告 × 任務（H1）」或「湖宣告 × 私人資訊（H2/H3）」之間 | **遊戲規則** | 在 210 個世界上做 H1 + H4 的聯合過濾，就自動涵蓋所有矛盾 | `analyzeLakeChain` 的兩兩／三角循環偵測（「A 湖 B 宣藍、B 湖 A 宣紅」）在標準規則下不會觸發；腳本中的假想雙向循環只是驗證 H4 的推論：若真的發生，結論會是 **A 必為紅**，而不是「兩人都可疑」 |
| S1… | 投票傾向、派隊習慣、嫁禍率 | 軟 | 乘上似然（level-1/2） | 牌譜先驗 |

**實作原則（來自 DeepRole 與 Bounder）**：
1. 硬規則刪除世界；近硬規則乘上 ε（例如 0.01–0.05），避免一次真人失誤讓推理崩潰。`GoodLakeInfo` 在湖宣告與任務矛盾時整批丟掉早先的湖宣告，就是把近硬規則（H4）當成硬規則之後的補救；改成乘上 ε，就只會讓矛盾的世界變得不太可能，不需要整批丟掉。
2. 驗證方式要先做**不變式單元測試**：L1/L2 的排序在任何信念下成立、刪除後的世界都滿足 H1、湖前的行動不改變硬3 的分數。這些是邏輯正確性的測試，應該先於強度基準。

---

## 9. 總對照表：方法 × 成本 × 決策

| 方法 | 成本（10 人局） | 派隊 | 投票 | 任務牌 | 湖目標 | 湖宣告 | 刺殺 |
|---|---|---|---|---|---|---|---|
| 精確世界過濾（H1–H6） | 210 個世界 × 事件數；微秒級 | P(全隊好) 精確值；L2 | 可接受性檢查 | — | 共同圖像 | 可信度 p_T | 排除不可能的梅林 |
| Level-1 似然（真人先驗） | 210 × 行動數；毫秒級 | 用 I(R;F) 加權 | 票的似然 | 洩漏量 | EIG | 嫁禍似然 | 梅林 vs 忠臣似然比 |
| Level-2（每個玩家視角、截斷到 t） | 約 4 × 10⁵ 次運算/步；毫秒級 | 預測別人會怎麼投 | 「他知道我們怎麼看他」 | — | — | 均衡嫁禍頻率 f | 梅林的偽裝 |
| 含角色的分配（151,200） | 10⁵ × 事件數；約 10–50 ms | — | — | — | 派西拇指 | — | **需要** |
| EIG／IDS 評分 | 每個候選 × 世界 × 結果數 | IDS | — | 雙邊評分 | 已有，改聯合熵 | 暴露成本 | — |
| SPARTA 式 rollout | 秒級/決策 | 離線評估 | — | — | — | — | — |
| CFR／ReBeL／DeepRole 全套 | 不可行（要訓練網路，維度 × 2520） | — | — | — | — | — | — |

---

## 10. 建議的實作順序（依 Edward 第 (5) 點：先邏輯正確，再談強弱）

1. **第一原理層**：把 H1–H6 做成一個 210 世界的過濾器（`GoodLakeInfo` 的世界列舉抽出來共用），配上不變式測試。L1/L2 用屬性測試驗證（本文的腳本是原型）。
2. **硬3 改成湖後、依當時資訊集計算**：把 `postLakeOnly` 改成預設；把 0.85 改成似然比，並加上「A 在隊上，而且換掉 B 改帶的人在 A 的私人視角下不確定」的條件。
3. **資訊流**：`ToMReverseEngine`／`InterpretationModule` 對每個歷史行動，用截斷到當時的觀察去評估（重用 `replayObservation` 的截斷邏輯）。
4. **熵的評分**：`GoodLakeInfo` 改用聯合熵；派隊加 I(R; F)；紅方任務牌加洩漏量。
5. **紅方嫁禍**：§6.3 的分數（傷害 × 可信度 − 暴露成本），可信度 p_T 從紅方模擬的藍方共同圖像來；嫁禍頻率依 level-2 混合。
6. **最後才看**一致性基準（像不像真人）和自我對打強度，用來調參數，不再用來否決邏輯上正確的修改。

---

## 參考文獻（依主題；★ = 有讀原始碼或核對過）

**隱藏身分遊戲機器人**
- ★ Serrino, Kleiman-Weiner, Parkes, Tenenbaum (2019). *Finding Friend and Foe in Multi-Agent Games*. NeurIPS 2019. https://arxiv.org/abs/1906.02330 · code https://github.com/Detry322/DeepRole
- ★ Champandard et al. (2012). *THE RESISTANCE AI* framework and bots (Dagstuhl Seminar 12191; Game/AI Conference Vienna 2012). https://github.com/aigamedev/resistance
- Chuchro et al. (2022). *Training an Assassin AI for The Resistance: Avalon*. https://arxiv.org/abs/2209.09331
- Cowling, Whitehouse, Powley (2015). *Emergent Bluffing and Inference with Monte Carlo Tree Search*. IEEE CIG 2015. DOI 10.1109/CIG.2015.7317927
- Cowling, Powley, Whitehouse (2012). *Information Set Monte Carlo Tree Search*. IEEE TCIAIG 4(2). Whitehouse PhD thesis (2014): https://etheses.whiterose.ac.uk/id/eprint/8117/
- Carminati, Zhang, Farina, Gatti, Sandholm (2024). *Hidden-Role Games: Equilibrium Concepts and Computation*. EC 2024. https://arxiv.org/abs/2308.16017 · https://doi.org/10.1145/3670865.3673616
- Xu et al. (2025). *Optimizing strategy selection in hidden role games* (DeepBayes). Eng. Appl. of AI 162:112464. https://www.sciencedirect.com/science/article/abs/pii/S0952197625024959
- Braverman, Etesami, Mossel (2008). *Mafia: A theoretical study of players and coalitions in a partial information environment*. Ann. Appl. Probab. 18(3). https://arxiv.org/abs/math/0609534
- UWA CITS3001 Resistance AI project, sample literature review. https://teaching.csse.uwa.edu.au/units/CITS3001/project/sampleReport.pdf

**LLM 代理人**
- ★ Light, Cai, Shen, Hu (2023). *AvalonBench: Evaluating LLMs Playing the Game of Avalon*. NeurIPS 2023 FMDM workshop. https://arxiv.org/abs/2310.05036 · code https://github.com/jonathanmli/Avalon-LLM
- Wang et al. (2023). *Avalon's Game of Thoughts: Battle Against Deception through Recursive Contemplation* (ReCon). https://arxiv.org/abs/2310.01320
- Stepputtis et al. (2023). *Long-Horizon Dialogue Understanding for Role Identification in the Game of Avalon with LLMs*. Findings of EMNLP 2023. https://aclanthology.org/2023.findings-emnlp.748
- Lan et al. (2024). *LLM-Based Agent Society Investigation: Collaboration and Confrontation in Avalon Gameplay*. EMNLP 2024. https://arxiv.org/abs/2310.14985
- Light et al. (2025). *Strategist: Self-improvement of LLM Decision Making via Bi-Level Tree Search*. ICLR 2025. https://arxiv.org/abs/2408.10635
- Rahimirad et al. (2025/2026). *Bayesian Social Deduction with Graph-Informed Language Models* (GRAIL). ACL 2026. https://arxiv.org/abs/2506.17788
- Wu et al. (2024). *Enhance Reasoning for Large Language Models in the Game Werewolf* (Thinker). ICML 2024. https://arxiv.org/abs/2402.02330
- Jin et al. (2024). *Learning to Discuss Strategically: A Case Study on One Night Ultimate Werewolf*. NeurIPS 2024. https://arxiv.org/abs/2405.19946
- Meta FAIR Diplomacy Team (2022). *Human-level play in the game of Diplomacy by combining language models with strategic reasoning* (CICERO). Science. DOI 10.1126/science.ade9097
- 預印本（只有搜尋片段）：arXiv 2608.09638（Avalon-ToM-Bench）、2604.20582、2607.10814、2607.10645

**PBS、搜尋、CFR**
- Nayyar, Mahajan, Teneketzis (2013). *Decentralized Stochastic Control with Partial History Sharing: A Common Information Approach*. IEEE TAC 58(7). https://arxiv.org/abs/1209.1695
- Kaelbling, Littman, Cassandra (1998). *Planning and acting in partially observable stochastic domains*. Artificial Intelligence 101.
- Foerster et al. (2019). *Bayesian Action Decoder for Deep Multi-Agent Reinforcement Learning*. ICML 2019. https://proceedings.mlr.press/v97/foerster19a.html
- Lerer, Hu, Foerster, Brown (2020). *Improving Policies via Search in Cooperative Partially Observable Games* (SPARTA). AAAI 2020. https://ojs.aaai.org/index.php/AAAI/article/view/6208
- Hu et al. (2021). *Off-Belief Learning*. ICML 2021. https://proceedings.mlr.press/v139/hu21c.html
- Brown, Bakhtin, Lerer, Gong (2020). *Combining Deep Reinforcement Learning and Search for Imperfect-Information Games* (ReBeL). NeurIPS 2020. https://arxiv.org/abs/2007.13544
- Moravčík et al. (2017). *DeepStack*. Science. DOI 10.1126/science.aam6960
- Brown & Sandholm (2018). *Superhuman AI for heads-up no-limit poker: Libratus*. Science. DOI 10.1126/science.aao1733
- Brown & Sandholm (2019). *Superhuman AI for multiplayer poker* (Pluribus). Science. DOI 10.1126/science.aay2400
- Schmid et al. (2023). *Student of Games*. Science Advances. https://arxiv.org/abs/2112.03178
- Long, Sturtevant, Buro, Furtak (2010). *Understanding the Success of Perfect Information Monte Carlo Sampling in Game Tree Search*. AAAI 2010.
- Zinkevich, Johanson, Bowling, Piccione (2007). *Regret Minimization in Games with Incomplete Information*. NeurIPS 2007. https://papers.nips.cc/paper/3306-regret-minimization-in-games-with-incomplete-information
- Tammelin (2014). *Solving Large Imperfect Information Games Using CFR+*. arXiv 1407.5042.
- Lanctot et al. (2009). *Monte Carlo Sampling for Regret Minimization in Extensive Games*. NeurIPS 2009.
- Brown, Lerer, Gross, Sandholm (2019). *Deep Counterfactual Regret Minimization*. ICML 2019.

**資訊理論、實驗設計**
- Shannon (1948). *A Mathematical Theory of Communication*. Bell System Technical Journal.
- Lindley (1956). *On a Measure of the Information Provided by an Experiment*. Ann. Math. Statist. 27(4).
- Howard (1966). *Information Value Theory*. IEEE Trans. Systems Science and Cybernetics 2(1).
- MacKay (1992). *Information-Based Objective Functions for Active Data Selection*. Neural Computation 4(4).
- Houlsby, Huszár, Ghahramani, Lengyel (2011). *Bayesian Active Learning for Classification and Preference Learning* (BALD). arXiv 1112.5745.
- Rainforth, Foster, Ivanova, Bickford Smith (2024). *Modern Bayesian Experimental Design*. Statistical Science 39(1). https://arxiv.org/abs/2302.14545
- Russo & Van Roy (2018). *Learning to Optimize via Information-Directed Sampling*. Operations Research 66(1). https://arxiv.org/abs/1403.5556
- Knuth (1977). *The Computer as Master Mind*. J. Recreational Mathematics 9(1). · Kooi (2005). *Yet Another Mastermind Strategy*. ICGA Journal 28(1).

**欺騙、訊號、說服**
- Crawford & Sobel (1982). *Strategic Information Transmission*. Econometrica 50(6).
- Kamenica & Gentzkow (2011). *Bayesian Persuasion*. American Economic Review 101(6).
- Kartik (2009). *Strategic Communication with Lying Costs*. Review of Economic Studies 76(4).
- Spence (1973). *Job Market Signaling*. QJE 87(3). · Kreps & Wilson (1982). *Sequential Equilibria*. Econometrica 50(4).
- Masters & Sardina (2017). *Deceptive Path-Planning*. IJCAI 2017. https://www.ijcai.org/proceedings/2017/610
- Savas et al. (2022). *Deceptive Decision-Making Under Uncertainty*. AAAI 2022. https://arxiv.org/abs/2109.06740
- Pearl (1988). *Probabilistic Reasoning in Intelligent Systems* (explaining away).

**遞迴心智理論**
- Stahl & Wilson (1995). *On Players' Models of Other Players*. GEB 10(1). · Nagel (1995). *Unraveling in Guessing Games*. AER 85(5).
- Camerer, Ho, Chong (2004). *A Cognitive Hierarchy Model of Games*. QJE 119(3).
- Lin (2022–2025). *Cognitive Hierarchies in Multi-Stage Games of Incomplete Information* (dynamic CH, with Palfrey's DCH framework). https://arxiv.org/abs/2208.11190
- Gmytrasiewicz & Doshi (2005). *A Framework for Sequential Planning in Multi-Agent Settings* (I-POMDP). JAIR 24. https://arxiv.org/abs/1109.2135
- Baker, Jara-Ettinger, Saxe, Tenenbaum (2017). *Rational quantitative attribution of beliefs, desires and percepts in human mentalizing*. Nature Human Behaviour 1:0064.
- Goodman & Frank (2016). *Pragmatic Language Interpretation as Probabilistic Inference* (RSA). Trends in Cognitive Sciences 20(11).

---

*腳本*：`scripts/entropy_toy.py`（§1、§5.3、§6.3、§7.3、§8 的數字）、`scripts/deeprole_human_csv.py`（§2.1 的 ProAvalon 彙總）。兩個腳本都只輸出彙總數字，不讀牌譜、不含玩家名字。
