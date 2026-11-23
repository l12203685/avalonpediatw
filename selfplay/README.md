# 第 71 回合的自我對打（本機跑，沒有用 GitHub Actions）

- `packages/server/scripts/selfplay/sp.ts` 同 `selfplay-runs-r70`，加 `f71=1`（每局 `redR5Red71` 把紅方第 5 局的票改成贊成的次數；0 = 和沒有開關的同一局逐局相同）。
- 這個分支沒有 workflow 檔（Actions 用量接近上限，第 71 回合在本機跑；同一支 `sp.ts`、同一套種子 `種子|局號`，和 Actions 逐局相同）。
- 結果在分支 `selfplay-results` 的 `results/r71-screen/`：`C0_*`（`red.redR5Red71=1`，L0）、`C1_*`（跑的時候的 `red.redR5Red71=1` = 現在的 `redR5Red71=1 redR5Red71Scope=4`，L1*），
  563001 第 0–9,999 局、`detail=1 f71=1`，每段 500 局。對照用 `results/r69-screen` 的 K16 f69 = 0 局＋BASE（現行預設，不重跑）。

```
cd packages/server
USE_FORWARD_REASONING=true npx tsx scripts/selfplay/sp.ts --seed 563001 --from 0 --games 500 --out C0_563001_0.json --flag red.redR5Red71=1 --flag detail=1 --flag f71=1
```
