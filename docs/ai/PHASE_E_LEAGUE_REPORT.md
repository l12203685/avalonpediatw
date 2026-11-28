# Phase E（第 92 回合）：League／Exploiter 抗剝削評測與舊開關盤點報告

> 建立日期：2026-11-27  
> 對應路線圖：`docs/ai/NEXT_GEN_AI_ROADMAP.md` Phase E（Issue #215）  
> 分支：`gemini/opt-round-92-phase-e`  
> 核心檔案：
> - 剝削者框架：`packages/server/src/ai/league/exploiterProfiles.ts`
> - 評測 CLI：`packages/server/scripts/leagueExploiter.ts`（`pnpm --filter @avalon/server league:exploiter`）
> - 單元測試：`packages/server/src/ai/league/__tests__/exploiterProfiles.test.ts`

---

## 一、League / Exploiter 測試框架設計

為解決過去逐回合手工調參容易過擬單一對手分布（只跟同期機器人互打）的問題，Phase E 建立一套可重現、零硬規則違規的 **League / Exploiter** 對抗評測框架：

1. **雙層設定＋硬規則鎖死**：
   - 每位剝削者皆以合法的 `BotProfile`（通過 `arena/profile.ts` 的 `validateProfile` 白名單與範圍檢查）為基礎，必要時再疊加針對性研究開關（例如第 86 回合的 `r1Ride86`、`assassinTierSoft86`、`splitMix86` 與第 82/50 回合的 `merlinTierCover82`、`redLakeDisguise50`）。
   - `HARD_RULE_PROTECTED_KEYS`（10 個 A0/A1 與 CSP 核心邏輯閘門開關：`goodQuestSuccessGuard`、`mustFailGate`、`teamDominanceGate`、`beliefCertainFacts`、`redPossibleClaimsOnly`、`redMatchPointFail`、`percivalLoyalVote`、`percivalCertainExclusion`、`percivalBlueLake`、`returnLake`）於驗證期禁止修改，且於執行期 `resolveExploiterTuning` 再次鎖死回 `DEFAULT_AGENT_TUNING`。
2. **嚴格陣營隔離＋逐局配對（共同亂數）**：
   - 複用 `SelfPlayEngine` 與 `arena/table.ts` 相同的 `seededRandom(`${gameSeed}|setup`)` 及 `withSeededRandom` 協定。
   - 每個 `gameSeed` 跑兩局：
     - **對照局（control）**：10 座皆為主引擎（`DEFAULT_AGENT_TUNING`）。
     - **剝削局（matchup）**：相同座位洗牌與發角色，`exploiter.targetSide` 陣營套用剝削策略，對立陣營維持主引擎 `DEFAULT_AGENT_TUNING`。
   - 輸出逐局配對勝率差（Δpp 與 95% CI）、三種結局比例（三紅／三藍死／三藍活）、刺殺失分率／命中率、對局軌跡變化率與 **Max-Min 防剝削底線**。

### 註冊的 5 種針對性剝削者

| ID | 名稱 | 剝削陣營 | 主引擎陣營 | 針對弱點與核心策略 |
|---|---|---|---|---|
| `iron-conservative-blue` | 極端保守不跳車藍方 | 藍方 | 紅方 | 攻擊紅方外白混票與釣內黑：`goodBayesGood=0.95`、`goodBayesGoodKey=0.99`、`goodBayesBad/BadKey=0.99`、`goodTailVote=0.95`、`merlinCover77=0.8` |
| `fake-outer-white-red` | 假裝外白搶票紅方 | 紅方 | 藍方 | 攻擊藍方 R1 3+1 照派與外白讀法：`redNormalVote=0.35`、`redCleanWhite=0.85`、`redCleanApprove=0.7`、`redStackRate65=0.15`＋`r1Ride86=1`、`redTailWhite84=1` |
| `merlin-vote-hunter-assassin` | 釣魚梅林投票模式刺客 | 紅方 | 藍方 | 專攻梅林關鍵票、讀湖與躲刺訊號：`assassinMerlinVotes=1.5`、`assassinVoteModel=4`、`assassinVoteEps=0.01`、`assassinLakeRead=1.5`、`assassinTierSoft86=0.27` |
| `tail-chaos-red` | 極端洗尾混亂紅方 | 紅方 | 藍方 | 破壞藍方洗尾與紅湖必湖隊友先驗：`redNormalVote=0`、`redCleanApprove/White=0.9`、`redStackRate65=1`、`oberonR1AlwaysFail64=1`、`redHideHuman=false`＋`redLakeDisguise50=1` |
| `merlin-anti-tier-blue` | 反刺殺藏匿梅林藍方 | 藍方 | 紅方 | 攻擊刺客 `assassinVisibleRedTier` 硬分層與世界線：`merlinCover77=1`＋`merlinTierCover82=1`、`r1Split85=1`、`splitMix86=0.5` |

---

## 二、主引擎抗剝削實測數據（每剝削者 80 局配對，合計 800 局）

執行指令：
```bash
pnpm --filter @avalon/server league:exploiter --games 80 --workers 4 --seed phase-e-r92
```

| 剝削者 | 主引擎陣營 | 主引擎勝率 | 對照勝率 | 配對差 Δpp [95% CI] | 三結局（剝削桌：三紅／三藍死／三藍活） | 刺殺率（剝削 vs 對照） | 軌跡變化率 | 硬規則違規 |
|---|---|---:|---:|---:|---|---:|---:|---:|
| `iron-conservative-blue` | 紅方 | **81.3%** | 61.3% | **+20.0pp** [+8.8, +31.2] | 57.5%／23.8%／18.8% | 55.9% (19/34) vs 35.4% (17/48) | 98.8% | 0 |
| `fake-outer-white-red` | 藍方 | **47.5%** | 28.7% | **+18.8pp** [+7.7, +29.8] | 15.0%／37.5%／47.5% | 44.1% (30/68) vs 52.1% (25/48) | 86.3% | 0 |
| `merlin-vote-hunter-assassin` | 藍方 | **26.3%** | 25.0% | **+1.3pp** [-1.2, +3.7] | 46.3%／27.5%／26.3% | 51.2% (22/43) vs 52.4% (22/42) | 13.8% | 0 |
| `tail-chaos-red` | 藍方 | **43.8%** | 30.0% | **+13.8pp** [+1.8, +25.7] | 23.8%／32.5%／43.8% | 42.6% (26/61) vs 46.7% (21/45) | 90.0% | 0 |
| `merlin-anti-tier-blue` | 紅方 | **67.5%** | 58.8% | **+8.8pp** [-3.9, +21.4] | 40.0%／27.5%／32.5% | 45.8% (22/48) vs 36.5% (19/52) | 98.8% | 0 |

### 關鍵發現與 Max-Min 診斷

- **硬規則零違規**：5 組剝削者共 400 組配對（800 局 10 人局），`hardRuleViolations = 0`。
- **Max-Min 防剝削底線**：
  - 主引擎最差防剝削勝率：**26.3%**（對手：`merlin-vote-hunter-assassin`）；
  - 主引擎最大負向配對差：**+1.3pp**（沒有任何單一極端剝削者能把主引擎打到顯著低於對照基準）。
- **對極端風格的反制能力強**：
  - `iron-conservative-blue`（過度保守、拒不跳車）把局勢推給尾家，主引擎紅方勝率大漲 +20.0pp、刺殺命中率升至 55.9%。
  - `fake-outer-white-red`（R1 搭車＋高頻假外白）與 `tail-chaos-red`（滿疊＋亂湖＋零偽裝票）皆被主引擎藍方貝氏後驗有效懲罰，三紅率從 40%–43.8% 壓低至 15.0%–23.8%，藍方勝率分別提升 +18.8pp 與 +13.8pp。
  - `merlin-anti-tier-blue`（`merlinTierCover82`＋`r1Split85` 混拆）未能壓低現行世界線刺客（`assassinWorldLine75`）的命中率（反升至 45.8%），反而損失任務穩定度。
- **真正結構性瓶頸不在單一極端剝削，而在基準內戰的梅林暴露率**：
  - 在 `merlin-vote-hunter-assassin` 與其對照局中，主引擎藍方勝率僅 25.0%–26.3%，三藍局刺殺失分率高達 **51.2%–52.4%**（強真人基準為 40.0%）。後續若結合 Phase D 受限前瞻或更強的紅方適應性剝削，應優先壓低藍方三紅率與梅林被刺率。

---

## 三、`AgentTuning.ts` 舊開關盤點與安全收斂建議

經靜態掃描 `packages/server/src/ai/AgentTuning.ts`、`humanProfile.ts` 與 `arena/knobs.ts`，現行共有 **363 個**開關欄位。本回合**不改動任何現有欄位與預設值**，僅建立盤點分類與安全退場路徑：

### 1. 全量分類統計（363 個開關）

| 分類 | 數量 | 現行預設值 | 保留／收斂建議 |
|---|---:|---|---|
| **A. 核心硬規則與邏輯閘門**（`HARD_RULE_PROTECTED_KEYS`） | 10 | 全部開啟 | **永久保留，嚴禁關閉**（A0/A1/CSP 基礎） |
| **B. 現行基準線啟用中（不含 A）** | 108 | 開啟（非 0/false） | 現行主引擎核心；其中 **10 個**在正式路徑已被後續回合覆蓋（見下表），可於未來消融確認後收斂為常數或移除冗餘分支 |
| **C. 真人桌讀法專用（`humanProfile.ts`）** | 21 | 基準線關閉 | **保留**（供 `HUMAN_READING` 三種真人桌設定使用） |
| **D. 擂台／AI 騎士白名單專用（`arena/knobs.ts`）** | 4 | 基準線關閉 | **保留**（`redCleanApprove`、`redCleanWhite`、`oberonR1AlwaysFail64`、`merlinCover77`） |
| **E. 純實驗性未採用開關**（基準線關、且未在 `humanProfile.ts` 與 `arena/knobs.ts` 使用） | 220 | 全部關閉 | **可分批安全退場之技術債候選清單** |
| **合計** | **363** | 開啟 118／關閉 245 | — |

### 2. 預設開啟但正式路徑已被覆蓋（Superseded）的歷史開關（10 個）

| 開關名稱 | 現行預設 | 覆蓋現況與收斂說明 |
|---|---|---|
| `goodLakeTargetMostSuspicious` | `true` | 已被 `goodLakeInfoMax=true` 優先覆蓋，僅在無一致世界 fallback 時觸發 |
| `assassinHeuristicVisibility` | `true` | 僅在 `assassinModel=false`（舊啟發式刺殺）時生效 |
| `mordredHideR1` | `true` | 第 27 回合起由 `redHideHuman=true` 取代，僅 `redHideHuman=false` 時生效 |
| `redHideR1` / `redHideR1Who` / `redHideR4Solo` | `1` / `1` / `1` | 同上，早期分角色藏牌開關，正式路徑已由 `redHideHuman=true` 統一取代 |
| `goodCleanVote` / `goodKeyVote` / `goodTailVote` | `0.3` / `0.3` / `0.7` | 第 33 回合起 R3+ 多數票由 `goodBayesVote=3` 與 `goodBayes*` 主導；因目前仍列於 `arena/knobs.ts`，須等社群 profile 遷移後再退場 |
| `merlinDoomedRed` | `true` | 第 1 回合早期躲刺規則，後續由 `merlinLoyalStyle`／`merlinGatedThumb83` 主導 |

### 3. 純實驗性未採用開關分佈（220 個，退場候選）

- **R1–R38 早期無後綴實驗開關**：119 個（最高優先清理；多數僅供早期基準腳本與單一回合回歸測試引用）。
- **R40 動態查表投票門檻（`vote40*`）**：21 個（於 `BlueRound40.ts` 以字串動態索引 `vote40${cell}${role}` 存取，預設全 0，未採用）。
- **R39–R59 回合後綴未採用開關**：30 個。
- **R60–R79 回合後綴未採用開關**：20 個。
- **R80–R90 近期路線圖／研究開關**：30 個（包含第 86 回合剝削開關 `r1Ride86`、`assassinTierSoft86`、`splitMix86` 與第 87–90 回合 Phase A/B/C 實驗開關，建議**暫緩清理**，保留供 League 剝削者與路線圖驗收使用）。

### 4. 安全退場作業程序（不破壞既有測試）

1. **第一批（低風險）**：針對 R1–R38（119 個）與 `vote40*`（21 個），確認無任何線上服務、`humanProfile.ts`、`arena/knobs.ts` 與 `EXPLOITER_PROFILES` 依賴後，先將對應分支自 `ForwardAgent.ts` 抽離並移除過期回合測試，再自 `AgentTuning.ts` 移除欄位。
2. **第二批（中風險）**：針對 R39–R79（50 個）未採用開關，比對 `scripts/` 中的歷史研究腳本，歸檔不再執行的舊腳本後同步收斂。
3. **長期門檻**：每次移除批次前，必須通過 `league:exploiter`（配對結果與基準 100% 相同）、`type-check`、`type-check:scripts`、`lint` 與完整 `vitest run`。
