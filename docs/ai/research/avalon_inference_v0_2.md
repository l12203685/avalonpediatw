# 跨對話研究整合：Avalon Inference v0.2（2026-11-16）

此版本將另一個 Chat 的獨立 Python 資訊理論研究，連同本輪 Chat 的 v0.2 事件回放與視角隔離，放在 **`research/avalon_inference_v0_2/`**；不覆寫正式的 TypeScript AI 引擎。

## 入口

- [README](../../../research/avalon_inference_v0_2/README.md)：執行與 demo。
- [INTEGRATION_STATUS](../../../research/avalon_inference_v0_2/INTEGRATION_STATUS.md)：來源、測試、主專案映射、下一步。
- [RESEARCH_SPEC](../../../research/avalon_inference_v0_2/RESEARCH_SPEC.md)：M0–M4 科研與驗收規格。
- [RESULTS_REPORT](../../../research/avalon_inference_v0_2/RESULTS_REPORT.md)：數值屬合成模型，不是實戰勝率。
- [research_sources](../../../research/avalon_inference_v0_2/research_sources.jsonl) 與 [research_claims](../../../research/avalon_inference_v0_2/research_claims.jsonl)：另一 Chat 文獻及命題索引。
- 研究核心 `avalon_core.py`、事件回放 `event_replay.py`、35 個測試在同一資料夾。

## 正式系統整合界線

`packages/server/src/game/GameEngine.ts` 與 `packages/server/src/ai/*` 是正式線上運作邏輯，本版**只讀對照**；歷史資料及 AI 自我對弈仍在原路徑，未作新訓練／資料庫改動。v0.2 有自己的獨立 CI，PR 驗收只執行 Python stdlib tests。

**不要把 v0.2 模型裡的 q=0.8 當成真人校準值，也不要把「熵降低」寫成「實戰勝率提升」。** 目前僅按歷史事件可見範圍重播，再用公開任務失敗張數及當前座位合法視角計算後驗。

## 下一個工程目標

先建正式牌譜資料到事件 schema 的只讀匿名化映射、`source_hash / ruleset_id / event_seq`，並用合成 fixture 與現行 TS 引擎逐事件對齊；通過 parity 後才做真人 q 校準、投票/湖中似然與樣本外研究。不可讓 Python 研究 API 直接影響正式玩家資料或部署。
