# 統一 AI騎士：進度交接（WIP，2026-11-27）

> 站長 2026-11-26：「玩家自創自建AI騎士 = AI騎士_玩家 = 有該玩家遊戲風格的AI騎士 而且可以被該玩家調整 並學習該玩家的遊戲風格 全部都是一體的」。
> Claude 的額度快用完了，工作中途停下來交給 Gemini。分支 `claude/unified-knights`，從 main `80d7b20` 開出來。

## 已經做好的（這個分支，還沒合併）

**A1. 正式對局也套殘差層**（#222 的每人殘差層，以前只有擂台套）
- 新檔 `packages/server/src/arena/knightAgent.ts`：`KnightAgent extends HeuristicAgent`，`act`／`pickLakeTarget`／`declareLake`
  在引擎決定之後過 `ResidualPolicy`（硬規則照 `residual.ts`：藍方任務一定成功、A1、A0、刺客不刺已知的紅、隊伍與湖中對象合法）。
  殘差層出錯 → 照引擎原本的決定（只記次數）。環境變數 `KNIGHT_RESIDUAL_LIVE=off` 可以關掉（只套開關）。
- `arena/table.ts` 的擂台座位改用同一個 `buildKnightAgent`（同一套程式）。
- `arena/knights.ts` 新增 `createKnightAgent(agentId, knightId, role, team, base)`、`knightResidual(id)`。
- `socket/GameServer.ts`：開局（`applyOpponentProfile`）與伺服器重啟接回（`restoreLiveRoom`）都改用 `createKnightAgent`。
- 測試：新檔 `src/arena/__tests__/knightAgent.test.ts`（和擂台座位同一個決定、硬規則、出錯退回引擎、開關關掉）；
  `KnightAddBot.test.ts` 加檢查騎士是 KnightAgent、百科不是。`vitest run src/arena/__tests__ KnightAddBot` 88 個全過。
- **已完成檢查（Gemini 2026-11-27）**：合併最新 `main`、通過 `@avalon/server` `tsc --noEmit`、`eslint`（0 錯誤）、arena／integration／socket／HardcodedStats 測試全過。20 局 10 人混編（含官方騎士殘差層）擂台指紋比對結果：19/20 局與 `main` 逐字相同；第 4 局差異原因已查明——`main` 的 `ArenaSeat` 將 `residual` 放在 `withSeededRandom` 之外，而 `ResidualPolicy → bayesRedShare` 在無 `seedStr` 時會呼叫 `BayesBelief.ts:658` 的 `Math.random()`；重構後的 `KnightAgent` 連同殘差層都在 `withSeededRandom` 內執行，反而修掉了這處隱藏的亂數外洩（同一分支連跑兩次指紋 100% 相同）。待 CI 綠且過部署閘門即可合併。

## 還沒做的（照原本的計畫）

**A2. [已完成，Gemini 2026-11-27] 補位機器人可以指定 AI騎士**（站長選項 A，#218）
- `services/signagePlayerDispatch.ts`：`SeatFillerRequest` 加 `knights: string[]`（名冊 id，最多 = bots，沒寫 = 百科），
  dispatch 的 inputs 加 `knights`（逗號分隔）；解析錯誤多一種 `knight`。
- `knights.ts` 加 `resolveKnightRef(text)`：id、`AI騎士_ED`、`AI騎士_ED_01`、`ED` 都認（NFKC、不分大小寫）。
- 指令：`bots/seatFiller/commands.ts`（LINE `/補位`）、`discordCommand.ts`（多一個「騎士」選項）、`routes/seatFiller.ts`（網站表單 JSON）、
  網站「叫 AI騎士 補位」表單加選單。
- `.github/workflows/signage-player.yml`：workflow_dispatch 加 `knights` input（目前 5 個，上限 10），傳 `--knights` 給腳本。
- `scripts/signagePlayer.ts`：`--knights a,b` → 第 i 個機器人用哪一位；暱稱 `AI騎士_{名字}_{nickBase+i}`；
  `Seat.start()` 照這一局的角色用 `createKnightAgent(..., PROFILE_OVERRIDES[type])`。每晚自動補位維持百科。

**B. 統一的玩家騎士模型**（命名 `AI騎士_{玩家ID}_{##}`，一位玩家一隻）
- 資料夾 `community-bots/_knights/<id>/`：`profile.json` = 第 1 層（牌譜擬合，擬合程式寫）＋新欄位 `playerId`、
  沒有牌譜時 `"fit": "none"`；新檔 `adjust.json` = 第 2 層（玩家自己的調整：白名單開關 overrides/sides/roles、`note`、`source`、
  可選的 `residualOff: ["vote", …]` 讓玩家在某些動作用自己的開關、不讓殘差層拉回）。套用順序：預設 → 第 1 層 → 第 2 層。
  重新擬合只改 `profile.json`，`adjust.json` 保留（`scripts/styleKnights.ts --write-knights` 現在會整個清掉資料夾，要改）。
- 驗證：`profile.ts` 名字一定等於 `AI騎士_{playerId}_{##}`；`registry.ts` 允許 `adjust.json`；最上層的社群資料夾不再收（訊息請改用 `_knights/<id>/adjust.json`）。
- 搬家：`community-bots/huohuo/` → `_knights/knight-<雜湊>-01/`，名字 `AI騎士_藿藿_01`，只有第 2 層、預設引擎、標「尚無牌譜／待認領」
  （牌譜裡沒有「藿藿」這個 ID；之後他連到真的玩家 ID 再擬合第 1 層、保留他的調整）。`knights.generated.json` 要重產（`knights:generate`）。
- 本人確認：PR 作者的 GitHub 帳號要對到那位玩家（公開對照檔 `community-bots/_owners.json`，玩家在網站上同意才寫），
  否則 `arena-check.yml` 說「待確認是本人」；站長可以手動擔保（PR 加標籤，例如 `vouched`）。
- 網站帳號 ↔ 玩家 ID：現有的「ID 認領」頁不用登入、只是合併別名，**沒有**帳號連到玩家 ID 的機制。要新做：登入的玩家送出「這個 ID 是我」，
  站長核准才生效。注意：正式機沒有 Firestore（`AdminService.isAdmin` 讀 Firestore，正式機會一直回 false），站長身分要用帳號庫的 email
  比對（`githubAuthAccounts.findAccountByUserId` → `primaryEmail`，比對 `AdminService` 的 `SEED_ADMIN_EMAILS`）。
- 私人儲存：跟每日小觀念、模擬瓦同一套（`bots/conceptDaily/store.ts` 的 `GitHubJsonFile`，private repo `bot-state/player-knights.json`，
  用現有的 `GITHUB_ACCOUNTS_*`，不用新的環境變數）：擁有者 uid、認領狀態、第 2 層、改動紀錄（含回饋原文，私人）。
  正式對局即時套用網站上的第 2 層（記憶體），擂台每天從公開的 `GET /api/knights/public`（只有開關，沒有 uid/email/回饋文字）讀進名冊。
- 學習（第 3 層）：每週 GitHub Actions 重新擬合（`styleKnights.ts` → `knightFidelity.ts` → `knightFidelityFit.ts`，資料是 repo 裡公開的
  `packages/server/games_cache.json`），推到分支再開 PR（動到 `packages/server` → 部署閘門）。
- 網站「我的騎士」（`packages/web/src/pages/MyKnightPage.tsx`，現在只是說明）：看自己的騎士、逐動作像不像（`docs/ai/gap/knight_fidelity.json`
  每位騎士都有）、文字調整（主要）＋滑桿（進階）、改動紀錄、「用你自己的 AI 調整」：可複製的提示（預填玩家 ID、他的描述、目前的 profile.json、
  開關表、逐動作差異、可選的公開牌局連結；輸出 = 第 2 層的 JSON ＋白話說明；規則：只能用白名單開關、不寫程式、不放別人的資料）＋貼回 JSON 的框（檢查、預覽、存成第 2 層）。
- 文件：`docs/ai/EXTERNAL_AI_COLLABORATION.md`、`community-bots/README.md` 改寫成統一模型（含提示範本與要給 AI 的資料）、`docs/BOTS.md`。

**C. 重玩測驗**（站長選項 a，#222）：只給站長的私人頁，自己一個月以前的局面（公開紀錄＋他的角色視野，名字換成座位），私人記答案，逐動作報和當初一樣的比例。建議另開 PR。

## 要站長決定的
1. 帳號 ↔ 玩家 ID 的核准：站長逐筆核准（建議），或先信任、事後可撤銷。
2. GitHub 帳號對照：公開對照檔（玩家在網站同意才寫，建議）或只放私人帳號資料。
3. 每週重新擬合要不要讓 Actions 自己開 PR（要開 repo 設定「Allow GitHub Actions to create pull requests」），或只推分支。
