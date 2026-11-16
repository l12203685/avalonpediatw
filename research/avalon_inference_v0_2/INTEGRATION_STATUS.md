# AvalonPediaTW 跨對話研究整合狀態（2026-11-16）

## 資料來源與可追溯性

- `avalon_research_v0_1_complete.zip`：使用者於本 Chat 上傳，含 `avalon_core.py`、研究規格、`research_sources.jsonl`、`research_claims.jsonl`、HTML、15 個單元測試與合成研究結果；未宣稱已連接正式網站或真人資料。
- `HANDOFF_PROMPT.md`、`RESULTS_REPORT.md`：另一 Chat 的原始交接與研究報告，均保留。
- 主 repo：`https://github.com/l12203685/avalonpediatw`，本次查看的 main head `4ddd0288c6311ee33544513c12a97a2dc37fac12`；核心 `packages/server/src/ai/*`、`packages/server/src/game/GameEngine.ts`、`docs/ai/optimization_loop.md`。
- 2026-11-16 本次在本地增量開發 `event_replay.py` 與 `tests/test_replay.py`，不覆蓋既有 TypeScript 生產引擎。

## 驗收（不含大規模回測）

- v0.1：15/15 tests pass；5 人 120 個完整角色分配、10 人 151,200；q=1 五人兩人任務 IG 1.295461844 bits（完整失敗張數）、0.881290899 bits（二元成敗）。
- v0.2：35/35 tests pass。新增版本化房規、提案/投票/任務/湖/刺殺回放、候選事件嚴格欄位檢查、不同玩家視角快照與歷史截止序號（不讀未來）、`belief_at()` 串接 v0.1 信念模型。
- `GameEngine.ts` 對照：正式站第五提案跳過投票強制通過；官方第五次否決可選為不同規則；十人預設湖；9 人 Oberon mandatory 的 `quest_sizes=[4,3,4,5,5]` 以及 Option 2 倒置保護規則，均有獨立設定。
- q 仍是假設破壞機率，不是經真人資料擬合的真實機率。策略勝率、AUC、Brier 等尚未量測。

## 未達成／不混淆

- 未將這套 Python 引擎接入正式 `GameEngine.ts`、`HeuristicAgent.ts`，亦未替換任何現有 AI；不可把 v0.2 的 35 tests 說成正式站 3,000+ TS tests。
- 尚未匯入 AvalonLogs、Avalon-NLU、Bayesian-Avalon、AVCORP（先查授權/欄位）；未完成真人 q 校準。
- `belief_at()` 尚未把派票、投票、湖宣告、聊天轉成有校準依據的似然；非標準任務人數明確 raise NotImplementedError。
- `Replay` 是程式內可信研究對象，**不能**直接讓客戶端傳入任意 observer 來取得私有視角；正式產品須登入驗權與防重播存取。
- 資料模型尚不涵蓋時間中斷、公開身份揭露階段、逐張任務牌提交、任務前湖中變體、非標準九人變體的推論等所有情況。

## 下個實際工程任務（按順序）

1. 先對照正式 TypeScript `GameEngine` 的全部房規選項與事件 JSON，做來源欄位對照表並增加固定 fixture；每一步先用離線合成 case 驗證。
2. 建立只讀、匿名化、無隱藏身分穿透的資料轉接；原始牌譜需分 `raw / normalized / derived`，包含 `source_hash / ruleset_id / event_seq`。
3. 現有 TypeScript 的觀察欄位與 Python 的 `view_at` 做 snapshot parity；只能在測試環境讀真角色驗證，不能把真角色作推理特徵。
4. 將 `belief_at()` 的投票/湖事件補成顯式似然（允許拒絕未校準參數）；後做真人資料 Brier、log loss、ECE 與時間外驗證。
5. 提案驗收為 Draft PR，不修改 main／不觸發正式部署；工作流以 data-changed 才跑研究，不每天無條件自我對弈。

## 研究分類（保留使用者裁定）

A：行為心理與語言訊號；B：派票、黑白球、視角與邏輯；C：機率、Bayesian、CSP、Entropy、AI；D：角色專用策略；E：情境博弈。D/E 是前三類的綜合應用層。