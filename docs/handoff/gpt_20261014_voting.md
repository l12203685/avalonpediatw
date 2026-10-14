# GPT 交接：牌譜投票指標（B）

分支：`gpt/voting`。基底：`origin/main` 的 `d7164ff`。供 Claude 審查、整合、觸發每日重算；本分支不部署、不合併 main。

## 完成內容

- 每日從牌譜重算 `players[].voting`（同步出現在 `playerDetails`）；純函式位於 `packages/server/voting_stats.py`。第 5 次強制提議沒有票，所有指標排除；損壞回合整回合略過，避免提議序號錯位。
- 忠臣／紅方的 R3–R5 反對率、全回合／R3–R5 的有紅隊反對率及全藍隊贊成率；分子、有效票數、滿 10 票門檻與 PR 母體。完整口徑在 `docs/stats/two_stage_outcome.md`。
- `/戰績` 改讀新欄位，附分子／分母及 PR 母體；個人頁展示全部六個指標。舊快取顯示「下次每日更新後提供」。舊 `playstyle` 的投票數值保留，網站不再解讀為強硬度。
- `/profile/:name/playstyle` 帶出新 `voting`；即使沒有舊 `playstyle` 區塊，只要有玩家資料仍可回應。既有刺座／隊長指標保留。
- 共用型別 `packages/shared/src/derived/playerVoting.ts`；修改 server/web API 型別、`PlaystyleSnapshot.tsx`、`statsReplies.ts`、舊 Panel C 腳本的相容說明。
- `test_generate_cache.py` 新增 5 個手算測試；機器人測試新增顯示契約、舊版提示。既有快取屬性測試失敗訊息改用列索引，避免輸出名字。

## 驗證

| 檢查 | 結果 |
|---|---|
| `pnpm install --frozen-lockfile` | 通過，使用專案指定 pnpm 8.15.4；環境預設 11.25.0 首次失敗，未改 lockfile |
| `pnpm --filter @avalon/shared build` | 通過 |
| `pnpm --filter @avalon/server test` | 122 檔通過、1 檔略過；2487 測試通過、28 略過 |
| server `type-check` / `lint` | 通過；lint 0 errors、160 warnings |
| web `type-check` / `lint` / `build` | 通過；lint 0 errors、138 warnings；既有大 bundle 警告 |
| 根目錄 `pnpm type-check` | 三個套件通過；初次 turbo 抓到環境 pnpm 11 失敗，PATH 固定 pnpm 8 後重跑通過 |
| Python 3.11 `py_compile` | 四個改動的 Python 檔通過 |
| `python3.11 test_generate_cache.py` | 144 項執行，其中 143 通過、1 個既有快照案例略過 |
| `python3.11 test_discord_records_import.py` | 102 通過 |
| `git diff --check` | 通過 |

手算：三局各四次 R3 有效提議，忠臣反對 3／12 = 25.0%、PR 62.5（4 人）；紅方反對 6／12 = 50.0%、PR 12.5（4 人）。條件分母：忠臣 R3 有紅隊 3／6 反對、全藍隊 6／6 贊成；全部回合有紅隊 3／9、全藍隊 9／9。上述條件機率未滿 10 票，只顯示票數，不展示百分率。

唯讀核對 repo 的 `sheets_cache.json` 快照：2146 局均有可解析投票回合；32504 次解析提議，其中 5007 次為強制提議，全部排除。滿 10 票的忠臣指標 118 人、紅方指標 122 人。這是快照範圍，**不是即時 Google 試算表的局數**。

## 尚未執行與限制

- 未更新任何真人資料檔；整合 main 後由 Claude 觸發每日重算。未讀取或移動聊天、金鑰。
- 缺漏整行提議的原始牌譜無法自動識別；因此只稱「有效票數」，不宣稱完整歷史投票。錯誤回合／未完成回合不補值。
- A 的資料集與 TypeScript 引擎仍需加入 `voting_proposals` 及同口徑重算；此分支提供純函式與共用輸出型別。
- PR 高低只是相對反對傾向，不是玩家強弱。隊伍條件使用事後身分，亦不代表當下資訊。
- 本工作包沒有待決策項目。條件機率目前涵蓋玩家所有角色，忠臣／紅方視角只用於 R3 反對率，畫面與文件均明示。
