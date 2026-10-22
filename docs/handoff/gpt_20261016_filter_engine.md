# GPT 複合篩選引擎交接

分支：`gpt/filter-engine`。交付基準：`origin/main` 的 `6a80f20`，2026-10-16 已 fetch 並 rebase。網站介面另於 `gpt/filter-ui` 交付；本分支不改 Claude 的 AI／模擬區域或 Gemini 的題庫、特徵研究與網站測試基礎設施。

## 做了什麼

- 還原 r9 核心、湖與任務工作稿，補完任務、回合、隊長、座位三角順序、座位勝率、默契與投票重算。
- 保留任務結算與最終結算的舊欄位定義；Python 3.11 浮點加總、五成雙、精確 Fraction、名字與別名合併均逐欄驗證。
- 資料集升為版本 2，加入純結構的提案隊伍與贊成座位；不帶牌譜原文、自由 note 或聊天。第 5 次強制提議不算票。
- 玩家條件支援數值／PR、全部／篩選後評估、整局排除／只隱藏名單。角色理論永遠要求各角色視窗打滿，最低場數只能增加門檻。
- 排行的角色王同步最新 main：依公開捨入勝率判斷並列，所有同率第一都得稱號。
- 每日流程同時提交分析快取與每局資料集；資料集守門失敗時照常交付分析快取，篩選停用並讓工作最後報錯。沒有資料集的首次部署仍可啟動。
- 新增 `/api/analysis/games`、ETag、gzip／Brotli；第一次提供資料前比對全部可重算區塊與 L141 樣本數。日誌只印計數。
- 清理本次觸及檔案內原有的具名測試例子：改用十個虛構名字，文件與路由註解也移除真人示例。未改現有資料檔內容。

## 區塊一致性

下表「完全一致」指固定 2,146 局快照與 520 局虛構資料，各 11 組篩選（含不篩選）逐鍵、逐列、逐字串比較，數字沒有容差。

| 區塊 | 結果與範圍 |
|---|---|
| overview | 完全一致；三種結果、三塊條件機率、角色／位置族群率與各理論排行 |
| players、playerDetails | 完全一致；舊任務勝率、最終勝率、角色／座位交叉、理論、別名、投票 |
| missions | 完全一致；每個任務、失敗張數與首隊條件 |
| rounds | 完全一致；回合結果、首隊、任務路徑與局勢 |
| captainAnalysis | 完全一致；隊長陣營與任務成功率 |
| lake | 完全一致；三條湖鏈及其角色／陣營條件 |
| seatOrder、座位勝率 | 完全一致；六種三角順序、相鄰條件與座位結果 |
| leaderboard | 完全一致；設定、基準日、資格、排序、文案與並列角色王 |
| chemistry.outcomePair | 完全一致；共同出賽的三結果，保留原矩陣列／欄名單順序 |
| pairs.sameFaction | 新欄位，Python 獨立配對計數與 TS 完全一致，另有四項手算測試 |
| featureStudies.L141 | 完全一致；條件機率、Wilson 區間、樣本數與文字 |
| 其餘特徵研究、archetype、舊 playstyle、strength | 沿用快取，不宣稱可重算；網站須標示「此區塊不隨篩選變動」 |
| coWin／coLose／winCorr／coWinMinusLose | 試算表既有矩陣，缺少完整公式，不與新配對混為同一指標；改局篩選時不顯示舊值 |

正式 committed 快取的直接比對尚未啟動：main 的分析快取尚無配對 `gamesKey`／版本 2 資料集。依架構，三項 committed 比對暫時略過；**沒有拿較舊的 2,146 局快照覆蓋正式快取**。Claude 首次每日重算後須確認三項開始實際比對及 `/games` 的 `engineCheck=passed`。

## 8 組獨立驗算

`audit_stats_compound_filters.py` 直接在固定快照逐局計數，不使用 TS 引擎或 Python 參考篩選器；只有牌譜解析與名字正規化共用。以下每格都與引擎相同。三種結果的分母是該列保留局數；最終紅勝 = 三紅 + 三藍死。顯示玩家數是剩餘對局裡的具名玩家，扣除只隱藏名單者。

| 條件（AND） | 保留局／2,146 | 三紅 | 三藍死 | 三藍活 | 最終紅勝 | 顯示玩家 |
|---|---:|---:|---:|---:|---:|---:|
| 線瓦、2024 年 | 571 | 288 | 120 | 163 | 408 | 74 |
| 面瓦、十席具名、三藍 | 215 | 0 | 83 | 132 | 83 | 56 |
| 排除娛樂、至少一湖 | 2,000 | 898 | 485 | 617 | 1,383 | 146 |
| 梅林在 1／10 號、藍方最終勝 | 142 | 0 | 0 | 142 | 0 | 103 |
| 線瓦、首隊至少一紅 | 1,093 | 519 | 257 | 317 | 776 | 116 |
| 週末、當日第 3 場以後 | 609 | 258 | 150 | 201 | 408 | 108 |
| 線瓦、排除場數 PR > 90 者的局 | 61 | 34 | 10 | 17 | 44 | 0 |
| 面瓦、只隱藏場數 PR > 90 者 | 627 | 254 | 161 | 212 | 415 | 52 |

場數 PR 在全部 171 位具名玩家中計算；第七組剩下的 61 局都沒有玩家名字，因此玩家表為空，局數和結果仍有效。若希望連缺名字局一起排除，可設 `dropIncompleteGames`。

此外，11 組完整 parity 包含角色理論 PR > 90、只隱藏同一群人、線瓦＋位置理論 < 45、面瓦／娛樂＋篩選後整體理論 PR ≥ 75（至少 50 場），以及兩個玩家條件疊加。

## 效能與大小

Node 24.19.0，本次容器；同一份完整 2,146 局資料，先暖機一次，再計時十次全部區塊重算。

| 項目 | 實測 |
|---|---:|
| 資料集檔案 raw | 944,245 bytes |
| gzip level 9 | 191,087 bytes |
| 解碼 | 0.03716 秒 |
| 全區塊重算中位數 | 0.25492 秒 |
| 十次最大值 | 0.29980 秒 |

資料量與時間超過原架構尚未實作時的 70 KB gzip／30–80 ms 估計；新增完整提案投票與同陣營配對是主要增量。本表是 Node 實測，不能代稱中階手機數字。網站仍須透過 Worker、去抖與逾時保護，瀏覽器測量隨 UI 分支交付。

## 檢查結果

| 指令／驗證 | 結果 |
|---|---|
| `pnpm install --frozen-lockfile`（pnpm 8.15.4，使用既有離線快取） | 通過 |
| `pnpm --filter @avalon/shared build` | 通過 |
| `pnpm --filter @avalon/server test`，含完整快照 parity | 2,628 通過、31 略過；130 測試檔通過、1 檔略過 |
| 新增端點樣本數檢查後的端點測試 | 7 通過 |
| server type-check | 通過 |
| server lint | 通過；0 errors、161 warnings（含計數日誌一項） |
| web type-check、lint、build | 通過；lint 0 errors、137 warnings；既有大 chunk 提醒仍在 |
| 根目錄 `pnpm type-check` | 3／3 工作通過 |
| Python 3.11 `py_compile` | 所有本次 Python 檔通過 |
| Python `test_generate_cache.py` | 167 項：166 通過、1 略過；隱私示例替換後重跑通過 |
| Python `test_discord_records_import.py` | 102 通過 |
| 8 組獨立複合驗算 | 48／48 個關鍵計數一致 |

曾失敗且已修正：舊角色王只取一人、任務 fixture 仍為版本 1、首次部署測試直接讀不存在的資料集、端點虛構快取缺 L141 樣本數。第一次獨立驗算腳本誤用不存在的湖欄位，也已修正並重跑。以上不隱藏為「一開始就全過」。

## 尚未做與整合事項

- 網站篩選列、分享、Worker、畫面驗收另於 `gpt/filter-ui`，依賴本分支。
- 未用金鑰重新下載正式試算表、未觸發每日 workflow、未推 main、未開 PR；由 Claude 整合後觸發一次每日更新。
- 保留 Gemini 的題庫與特徵研究呼叫點；`--export-raw-sheets` 已在 main，本分支只補與資料集輸出路徑互斥的檢查。其暫存檔清理由消費題庫的流程負責。
- `.github/workflows/test.yml` 加入 `gpt/**`，臨時完整快照答案在 `always()` 步驟刪除，不成為 artifact。每日 workflow 只改資料集交付相關區段與日誌計數。
- 需要 Edward 決定的既有設計點：地點白名單中的「古亭週五」目前併入「古亭」；若要拆開，需同時調整白名單與篩選選項。其餘按已核定架構執行。

完整技術定義及重現指令見 [filter_engine.md](../stats/filter_engine.md)。

## 修改檔案

共 61 個檔案：

- `.github/workflows/refresh-analysis-cache.yml`
- `.github/workflows/test.yml`
- `Dockerfile`
- `docs/handoff/gpt_20261016_filter_engine.md`
- `docs/stats/filter_engine.md`
- `docs/stats/two_stage_outcome.md`
- `packages/server/generate_cache.py`
- `packages/server/scripts/audit_stats_compound_filters.py`
- `packages/server/scripts/build_lake_parity_fixture.py`
- `packages/server/scripts/build_mission_parity_fixture.py`
- `packages/server/scripts/build_pyround_fixture.py`
- `packages/server/scripts/build_stats_parity_fixtures.py`
- `packages/server/scripts/statsBenchmark.ts`
- `packages/server/scripts/stats_filter_reference.py`
- `packages/server/src/__tests__/AnalysisGamesEndpoint.test.ts`
- `packages/server/src/__tests__/StatsEngineParity.test.ts`
- `packages/server/src/__tests__/StatsLakeParity.test.ts`
- `packages/server/src/__tests__/fixtures/stats_parity/invented/context.json`
- `packages/server/src/__tests__/fixtures/stats_parity/invented/games.json`
- `packages/server/src/__tests__/fixtures/stats_parity/invented/lake_refs.json.gz`
- `packages/server/src/__tests__/fixtures/stats_parity/invented/mission_refs.json.gz`
- `packages/server/src/__tests__/fixtures/stats_parity/invented/refs.json.gz`
- `packages/server/src/__tests__/fixtures/stats_parity/presets.json`
- `packages/server/src/__tests__/fixtures/stats_parity/pyround_cases.json`
- `packages/server/src/__tests__/stats/StatsFilter.test.ts`
- `packages/server/src/__tests__/stats/StatsLake.test.ts`
- `packages/server/src/__tests__/stats/StatsMissions.test.ts`
- `packages/server/src/__tests__/stats/StatsPairs.test.ts`
- `packages/server/src/__tests__/stats/StatsPyround.test.ts`
- `packages/server/src/__tests__/stats/datasetBuilder.ts`
- `packages/server/src/routes/analysis.ts`
- `packages/server/src/services/gamesDataset.ts`
- `packages/server/src/services/sheetsAnalysis.ts`
- `packages/server/test_generate_cache.py`
- `packages/shared/package.json`
- `packages/shared/src/stats/build.ts`
- `packages/shared/src/stats/captain.ts`
- `packages/shared/src/stats/constants.ts`
- `packages/shared/src/stats/dataset.ts`
- `packages/shared/src/stats/details.ts`
- `packages/shared/src/stats/featureL141.ts`
- `packages/shared/src/stats/filter/apply.ts`
- `packages/shared/src/stats/filter/metrics.ts`
- `packages/shared/src/stats/filter/predicates.ts`
- `packages/shared/src/stats/filter/presets.ts`
- `packages/shared/src/stats/filter/types.ts`
- `packages/shared/src/stats/filter/url.ts`
- `packages/shared/src/stats/fraction.ts`
- `packages/shared/src/stats/index.ts`
- `packages/shared/src/stats/lake.ts`
- `packages/shared/src/stats/leaderboard.ts`
- `packages/shared/src/stats/missions.ts`
- `packages/shared/src/stats/overview.ts`
- `packages/shared/src/stats/pairs.ts`
- `packages/shared/src/stats/parity.ts`
- `packages/shared/src/stats/players.ts`
- `packages/shared/src/stats/pyround.ts`
- `packages/shared/src/stats/rounds.ts`
- `packages/shared/src/stats/seatOrder.ts`
- `packages/shared/src/stats/theory.ts`
- `packages/shared/src/stats/voting.ts`
