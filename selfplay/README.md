# 平行自我對打（GitHub Actions）

推到分支 `selfplay-runs-r68` 就會跑 `.github/workflows/selfplay.yml`：
- `selfplay/jobs.txt` 每行一段：`標籤|開關（空白分隔 k=v）|種子|起始局號|局數`。藍方座位 = 預設 + 開關，紅方 = 預設；`red.k=v` 改紅方座位。
- `selfplay/config.json`：`runId`（結果目錄）、`shards`（同時開幾台，最多約 18）、`parallel`（每台同時幾段，runner 4 核）。
- 每一段的結果（只有每局的勝負、三藍、刺中梅林、第 1 局失敗、失敗任務數和對局雜湊；`detail=1` 另有整局紀錄，只有座位與動作，沒有玩家資料）推到分支 `selfplay-results` 的 `results/<runId>/`。
- 已經有結果的段落會跳過，重跑同一個 runId 只補缺的。
- 和本機跑同一段逐局相同（同一套種子：`種子|局號`）。
- 第 68 回合：`sp.ts` 同 selfplay-runs-r67；候選只改藍方座位（`lakeChain68`）。
