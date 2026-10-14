# 兩段結算與超額勝率：資料契約

[20261012] 依 Edward 裁定：「遊戲分成任務結算跟刺殺結算／任務結算不是三紅就是三藍／刺殺結算只有三藍時需要結算是否刺殺成功／但最終就是考慮 藍方要獲勝就是必須三藍且梅林活」。

[20261013] 依 Edward 裁定改用「角色理論勝率／位置理論勝率」與「各人最近 N 場」（見下方〈理論勝率〉與〈排行〉）；超額勝率保留在資料裡，但排行、機器人、網站主畫面都不再使用。

[20261014] 依 Edward 回饋（schemaVersion 4）：結果相關的數字一律用**條件機率**、分三塊看（見〈三塊結果〉）；角色理論改成「每個角色看自己的最近場次」（特殊角色各近 10 場、忠臣近 40 場），位置理論看近 100 場，另加整體理論（生涯全部場次，排行要生涯 250 場以上）；拿掉近 50 場（場數太少）。

本文件是 `generate_cache.py`（資料層）、`services/sheetsAnalysis.ts` 與 `routes/analysis.ts`（後端）、`packages/web`（網站）、`bots/stats`（機器人）共同遵守的欄位契約。舊欄位一律保留。

## 定義

| 名稱 | 定義 |
|---|---|
| 任務結算（missionStage） | 三紅 = 紅方；三藍（死或活）= 藍方 |
| 刺殺結算（assassinationStage） | 只在三藍局：三藍死 = 刺中；三藍活 = 沒刺中 |
| 最終（final） | 紅勝 = 三紅 + 三藍死；藍勝 = 三藍活 |

玩家是誰（2026-10-13 起）：牌譜「玩1～玩0」的名字只差大小寫、全形半形、前後或重複空白、零寬字元時算**同一位玩家**（`generate_cache.py` 的 `player_name_key`；機器人、網站搜尋與 API 共用的 `@avalon/shared` `playerNameKey` 同一規則）。所有以玩家為單位的數字（`players`、`playerDetails`、排行榜與門檻、座位／角色統計、位置三結果 `seatOutcomes`、兩人三結果配對 `outcomePair`、理論勝率）都先合併再算，顯示最常用的寫法（同樣多時取最早出現的）；默契矩陣的標籤改成同一個寫法。查詢（機器人、`/api/analysis/players/:name`、`/profile/:name/*`）不分大小寫。

玩家層：

| 欄位 | 定義 |
|---|---|
| `finalWinRate` | （紅方場的三紅 + 紅方場的三藍死 + 藍方場的三藍活）/ 總場數 |
| `finalRedWinRate` | （三紅 + 三藍死）/ 紅方場數 |
| `finalBlueWinRate` | 三藍活 / 藍方場數 |
| `missionWinRate` | （紅方場的三紅 + 藍方場的三藍死 + 藍方場的三藍活）/ 總場數 |
| `merlinSurvivalRate` | 藍方場且到達三藍時，三藍活 / （三藍活 + 三藍死）；分母 0 時為 0.0，並附 `rawBlueThreeBlue` |
| `roleFinalWinRates` | 各角色的最終勝率（紅角 = 三紅 + 三藍死；藍角 = 三藍活） |
| `expectedFinalWinRate` | Σ_角色 本人該角色出現比例 × 全體該角色最終勝率 |
| `excessWinRate` | `finalWinRate` − `expectedFinalWinRate`（可為負）。保留給舊讀者；2026-10-13 起排行、機器人、網站主畫面都不用 |
| `firstPlayed` / `lastPlayed` | 解析得到的最早 / 最晚出賽日 `YYYY-MM-DD`，沒有則 `""` |
| `roleOutcomes` | schemaVersion 4：各角色生涯的 `{"三紅": n, "三藍死": n, "三藍活": n}`（七個角色都有，沒打過是 0）；各角色的三塊結果從這裡算（見〈三塊結果〉） |
| `theory` | 理論勝率：schemaVersion 4 = `roleWindows`（角色理論）、`last100`（位置理論）、`career`（整體理論）；schemaVersion 3 = `last100`、`last50`、`career`（見〈理論勝率〉） |

舊欄位語意（保留不改）：`winRate`、`redWin`、`blueWin`、`roleWinRates`、`seat*WinRates` 都是任務結算口徑（三藍死算藍勝）。`roleTheory` ≈ 本人任務結算勝率（用本人自己的角色分配加權，所以幾乎等於本人勝率），`positionTheory` 恆為 0：兩個都**不是** Edward 定義的理論勝率，網站與機器人不顯示；數值不改，因為網站精算榜的 ELO 加分（`FirestoreLeaderboard.ts`）還在讀 `roleTheory`。正確的理論勝率在 `theory`。

超額勝率是什麼（回答 Edward 10/13 的問題）：超額勝率 = 期間最終勝率 − Σ（本人該角色出現比例 × 全體該角色最終勝率）。意思是「你實際的勝率，比『一個抽到跟你一樣多紅角、藍角的普通玩家』高或低多少」。它用的是本人實際抽到的角色比例，不是抽到各角色的機率，所以和下面的角色理論勝率不同。

## 快取新增欄位

`overview`：

```json
"schemaVersion": 2,
"missionStage": {"games": 2228, "threeRed": 1000, "threeBlue": 1228, "redPct": 44.9, "bluePct": 55.1},
"assassinationStage": {"games": 1228, "merlinKilled": 540, "merlinSurvived": 688, "killPct": 44.0, "survivePct": 56.0},
"final": {"games": 2228, "redWins": 1540, "blueWins": 688, "redPct": 69.1, "bluePct": 30.9},
"roleFinalWinRates": {"刺客": 70.1, "莫甘娜": 70.2, "莫德雷德": 70.0, "奧伯倫": 70.0, "派西維爾": 30.0, "梅林": 30.0, "忠臣": 30.0},
"topPlayersByExcess": [{"name": "HAO", "excessWinRate": 7.9, "finalWinRate": 38.5, "games": 600}]
```

`topPlayersByExcess` 門檻同 `topPlayersByTheory`（`MIN_GAMES_THRESHOLD` = 30），依全期縮減後超額勝率排序（`EXCESS_SHRINK_K` = 20）；保留給舊讀者，網站與機器人不再顯示。

schemaVersion 3（2026-10-13）另加：

```json
"schemaVersion": 3,
"seatFinalWinRates": {"1": 46.0, "2": 43.1, "3": 43.4, "4": 46.0, "5": 52.0, "6": 46.4, "7": 42.7, "8": 46.3, "9": 46.8, "10": 48.6},
"topPlayersByRoleTheory": [{"name": "…", "roleTheory": 55.2, "positionTheory": 55.2, "finalWinRate": 56.0, "games": 100, "careerGames": 1014}],
"theoryConfig": {"theoryMinCellGames": 3, "theoryWindows": [100, 50], "mainGames": 100, "activeDays": 90}
```

- `seatFinalWinRates`：全體各位置（鍵 `1`～`10`，10 號位）的最終勝率，算法同 `roleFinalWinRates`（有名字的座位、結果是三紅／三藍死／三藍活的局）。位置理論補值用。
- `topPlayersByRoleTheory`：生涯至少 `mainGames`（100）場的玩家，**不限近期出賽**，依各人最近 `mainGames` 場的角色理論勝率排序（同分看生涯場數多的、再看名字），前 `topN`（10）名；網站總覽用。（schemaVersion 4 改成角色視窗、要每個角色都打滿，見〈三塊結果〉之後的 overview 說明。）
- `theoryConfig`：產生器當下的設定（補值門檻、近 N 場的 N、主榜場數、近期天數），和 `leaderboard.config` 同值。網站的說明文字（總覽、各角色最終勝率表、玩家雷達）照這裡組字，不寫死「100 場」「補到 3 場」。

`players.players[]` 與 `playerDetails[name].player`：上表玩家層欄位全部加入。

`playerDetails[name].radar`（由 `routes/analysis.ts` 組）：

```json
{"winRate": finalWinRate, "redWinRate": finalRedWinRate,
 "blueMerlinProtect": rawBlueMerlinAlive / (rawBlueMerlinDead + rawBlueMerlinAlive) (2026-10-14 前是 blueMerlinAlive),
 "missionWinRate": missionWinRate, "excessWinRate": excessWinRate,
 "redMerlinKillRate": rawRedMerlinDead / (rawRedMerlinDead + rawRedMerlinAlive) (2026-10-14 前是 redMerlinDead),
 "experience": min(totalGames/10, 100),
 "roleTheory": theory.career.roleTheory, "positionTheory": theory.career.positionTheory,
 "outcomeBlocks": {"red": 三塊, "blue": 三塊, "roles": {角色: 三塊} 或 null}}
```

`roleTheory` / `positionTheory` 是生涯的理論勝率（2026-10-13 起）；快取沒有 `theory` 時為 `null`，不拿舊的 `roleTheory` 充數。網站雷達只讀 `player.theory`（舊後端送的 radar 這兩鍵是舊口徑），`excessWinRate` 不再畫；算不出來的軸（例如重算前的舊快取沒有理論勝率）不畫，不會畫成 0%。

快取缺新欄位時（重算前的舊快取），後端用原始計數現場算：`finalWinRate = (rawRedThreeRed + rawRedMerlinDead + rawBlueMerlinAlive) / totalGames` 等；`excessWinRate` 算不出來時為 `null`，網站與機器人顯示「—」。

2026-10-14 起 radar 另有（後端用原始計數算，schemaVersion 3 的快取也有）：

- `redMerlinKillRate` 改成**條件機率**：紅方場、到達三藍的局裡刺中梅林的比例 = 三藍死 /（三藍死 + 三藍活），從沒當紅方到過三藍時為 `null`。之前是 `redMerlinDead`（三藍死 / 全部紅方場，Edward 指出的「三藍死(紅方) 25.6%」）。
- `blueMerlinProtect` 同理（「其它數據也雷同」）：藍方場、到達三藍的局裡梅林活下來的比例 = 三藍活 /（三藍死 + 三藍活）= `merlinSurvivalRate`，從沒當藍方到過三藍時為 `null`。之前是 `blueMerlinAlive`（三藍活 / 全部藍方場，數字上等於藍方的遊戲結果 `finalBlueWinRate`，網站卻標成「藍方三藍活率」）。藍方遊戲結果仍在 `outcomeBlocks.blue.final` 與 `player.finalBlueWinRate`。
- 兩個刺殺結果都由 `services/sheetsAnalysis.ts` 的 `assassinationWinRates(player)` 算：有原始計數時就是 `outcomeBlocks.red / blue.assassination.win`；沒有原始計數的舊列改用兩個同分母的百分比相除（`redMerlinDead /（redMerlinDead + redMerlinAlive）`，同機器人的 `redKillRate`），**不會**退回沒有條件的 `redMerlinDead` / `blueMerlinAlive`。
- `outcomeBlocks`：`{"red": 三塊, "blue": 三塊, "roles": {角色: 三塊} | null}`，`roles` 要 schemaVersion 4 的 `roleOutcomes`。格式見下一節。

## 三塊結果（2026-10-14）

Edward 10/14 原話（摘要）：「角色勝率那邊應該分三塊：任務結果（三藍 = 藍勝，三紅 = 紅勝）、刺殺結果（三藍活 = 藍勝，三藍死 = 紅勝）、遊戲結果（三藍活 = 藍勝，其餘 = 紅勝）。幾個結果相關的應該用條件機率下去算，不然以整體比例來看都會很低。例：我的三藍死(紅方) 25.6% ⇒ 應該是 我參與的局、我是紅方且刺殺成功 / 我是紅方且任務結果三藍 的場數。其它數據也雷同。」

任何一組場次（某位玩家的紅方場、藍方場、某角色、某位置）都分三塊，每塊附分母 n：

| 塊 | n（分母） | 紅方勝 | 藍方勝 |
|---|---|---|---|
| 任務結果 `mission` | 這組全部場數 | 三紅 / n | （三藍死 + 三藍活）/ n |
| 刺殺結果 `assassination` | 這組裡到達三藍的場數（三藍死 + 三藍活；三紅沒有刺殺） | 三藍死 / n | 三藍活 / n |
| 遊戲結果 `final` | 這組全部場數 | （三紅 + 三藍死）/ n | 三藍活 / n |

- 這組場次自己的「勝」看陣營：紅方角色（刺客、莫甘娜、莫德雷德、奧伯倫）取紅方勝，藍方角色（派西維爾、梅林、忠臣）取藍方勝。位置不分陣營，呼叫端自己選要看哪一方。
- 例：紅方場 三紅 30、三藍死 20、三藍活 50 → 任務結果 30.0%（n = 100）、刺殺結果 28.6%（n = 70，舊算法是 20 / 100 = 20.0%）、遊戲結果 50.0%（n = 100）。
- n = 0 時勝率是 `null`（顯示「—」），不是 0%。一位小數、剛好 .x5 取偶數，和快取裡其他數字一樣。
- 實作：`@avalon/shared` 的 `outcomeBlocks(counts, 'red' | 'blue')`（`packages/shared/src/derived/outcomeBlocks.ts`），回傳 `{faction, mission, assassination, final}`，每塊 `{win, wins, n}`；`playerOutcomeBlocks(player)` 一次算紅方場、藍方場（原始計數 `raw*`）與各角色（`roleOutcomes`）。後端 radar、機器人 `/戰績`、網站（`services/api.ts` 轉出口）都用這一組函式，測試在 `packages/server/src/__tests__/OutcomeBlocks.test.ts`。
- 資料來源：紅方／藍方 = `rawRedThreeRed / rawRedMerlinDead / rawRedMerlinAlive`、`rawBlue*`（每版快取都有）；各角色 = `players[].roleOutcomes`（schemaVersion 4）；各位置 = `players[].seatOutcomes`（自己的局，`seatOutcomesSource = "games"`，鍵是 `threeRed / threeBlueDead / threeBlueAlive`，函式兩種鍵都收）。

schemaVersion 4 的 `overview` 另加：

```json
"schemaVersion": 4,
"topPlayersByGames": [{"name": "…", "games": 1084.0, "winRate": 54.1, "outcomes": {"三紅": 515, "三藍死": 255, "三藍活": 314}, "redGames": 447, "blueGames": 637}],
"topPlayersByRoleTheory": [{"name": "…", "roleTheory": 56.0, "positionTheory": 55.2, "overallTheory": 54.2, "finalWinRate": 56.0, "games": 100, "careerGames": 1018}],
"topPlayersByPositionTheory": [{"name": "…", "positionTheory": 55.2, "finalWinRate": 56.0, "games": 100, "careerGames": 1018}],
"topPlayersByOverallTheory": [{"name": "…", "overallTheory": 54.2, "positionTheory": 53.0, "finalWinRate": 54.9, "games": 1018, "careerGames": 1018}],
"theoryConfig": {"theoryMinCellGames": 3, "theoryWindows": [100], "mainGames": 100, "activeDays": 90,
                 "roleWindowGames": {"刺客": 10, "莫甘娜": 10, "莫德雷德": 10, "奧伯倫": 10, "派西維爾": 10, "梅林": 10, "忠臣": 40},
                 "positionGames": 100, "overallMinGames": 250}
```

- `topPlayersByGames[].outcomes`：該玩家全部場次（不分陣營）的三種結果局數，`redGames` / `blueGames` 是紅方 / 藍方場數 —— 總覽「三種結果 + 場次排行」的大圓餅、小圓餅用。
- 三個總覽排行都**不限近期出賽**、各前 `topN`（10）名，同分看生涯場數多的、再看名字：
  - `topPlayersByRoleTheory`：每個角色都打滿（`theory.roleWindows.fullWindows`）的人，依 `roleWindows.roleTheory`；`positionTheory` / `finalWinRate` 是最近 100 場的，`overallTheory` 是生涯的角色理論，`games` 是角色視窗的場數（打滿就是 100）。
  - `topPlayersByPositionTheory`：生涯 ≥ `positionGames`（100）場，依最近 100 場的位置理論。
  - `topPlayersByOverallTheory`：生涯 ≥ `overallMinGames`（250）場，依整體理論（生涯角色理論）；`positionTheory` / `finalWinRate` 也是生涯的。
- `theoryConfig.roleWindowGames` 是 `{角色: 場數}`；`leaderboard.config` 是 `LEADERBOARD_CONFIG` 的複本，同名的 `roleWindowGames` 在那裡是一個數字（特殊角色 10），忠臣另有 `loyalWindowGames`（40）。網站的 `theorySettings()` 兩種都收，舊快取缺的鍵用預設值（10 / 40、`positionGames` = `mainGames`、250）。

## 理論勝率（2026-10-13）

Edward 10/13 原話：

> 超額勝率的定義是什麼? 我們腳色理論勝率的定義是 SUM(每個腳色勝率 * 抽到該腳色的機率)
> 位置理論勝率 = SUM(每個位置勝率 * 抽到該位置的機率(1/10))
> 最完整的理論勝率其實應該是 SUM(每個腳色在每個位置的勝率 * 抽到該腳色的機率 * 抽到該位子的機率)
> 但這樣至少需要 幾百場 才比較有意義
> 所以才會分腳色跟位置去分別做統計
> 另外我覺得應該要列出的是 該玩家近 50 or 100 場的資料
> 條件篩選可以是近期 但資料篩選不能少場

白話說明：

- **角色理論勝率** = Σ（本人該角色的最終勝率 × 抽到該角色的機率）。10 人局的牌是 6 張特殊角色（刺客、莫甘娜、莫德雷德、奧伯倫、派西維爾、梅林）各 1 張、忠臣 4 張，所以抽到忠臣的機率是 4/10，其他每個角色各 1/10。它回答的是：「如果發牌完全照機率，你的勝率會是多少？」——不會因為你這陣子剛好常抽到紅角（紅方最終勝率約 70%）就變高。
- **位置理論勝率** = Σ（本人該位置的最終勝率 × 1/10），10 個位置各 1/10。
- 勝率一律是**最終勝率**（藍方要三藍且梅林活才算贏；三紅、三藍死都是紅方贏）。
- 全體基準：如果每個角色都打出全體平均，角色理論勝率 ≈ 46%（4/10 × 忠臣約 30% + 1/10 × 四個紅角約 70% × 4 + 1/10 × 派西、梅林約 30% × 2）。位置理論的全體基準也約 46%。高於 46% 就是比平均好。

Edward 10/14 補充：「角色理論 50 場太少了，因為每 10 場除了忠臣以外平均也只會出現 1 場；如果可以抓每個角色至少近 10 場的平均勝率再加總（忠臣當然要 40 場）會合理一點」「角色理論勝率旁邊再呈現位置理論勝率（也是要 100 場）& 整體理論勝率（可以看生涯，要求 250 場以上）」。

**看哪些場（視窗，schemaVersion 4）**：每位玩家各算三段，寫在 `players[].theory`：

```json
"theory": {
  "roleWindows": {"roleTheory": 56.0, "fullWindows": true, "games": 100, "sparseRoles": 0,
                  "from": "2025-07-29", "to": "2026-02-27",
                  "roles": {"刺客": {"games": 10, "wins": 7, "window": 10, "rate": 70.0}, "...": "...",
                            "忠臣": {"games": 40, "wins": 14, "window": 40, "rate": 35.0}}},
  "last100": {"window": 100, "games": 100, "roleTheory": 44.3, "positionTheory": 44.6, "finalWinRate": 45.0,
              "from": "2025-08-12", "to": "2026-02-27", "sparseRoles": 0, "sparseSeats": 0},
  "career":  {"window": 0,   "games": 1081, "roleTheory": 46.4, "positionTheory": 47.0, "finalWinRate": 47.1, "...": "..."}
}
```

- **角色理論** = `roleWindows.roleTheory`：每個角色看本人**當該角色**的最近 K 場（`role_window_theory`）—— 六個特殊角色 K = `roleWindowGames`（10），忠臣 K = `loyalWindowGames`（40；發到忠臣的機會是 4 倍）。當該角色的場數不到 K 就用全部，不到 3 場照下面的補值。`roles` 每格：`games`（用到的場數）、`wins`（其中最終贏的）、`window`（K）、`rate`（進到總和的這格勝率，補值後的；沒打過是全體勝率）。`games` = 用到的總場數（打滿時 6 × 10 + 40 = 100），`fullWindows` = 每個角色都打滿 K 場 —— **任何角色理論的排行都要 `fullWindows`**（資料篩選不能少場；2146 局的快照裡是 35 人，以 2026-03-01 為準近 90 天有出賽的 22 人）。打滿時角色理論剛好等於這 100 場的最終勝率（每個角色的場數比例就是發牌機率）。
- **位置理論** = `last100.positionTheory`：本人最近 `mainGames`（100）場；場數不夠時就是全部場次，`games` 寫實際場數。`last100.roleTheory` 仍在（同舊格式），但角色理論不再看它。
- **整體理論** = `career.roleTheory`：生涯全部場次算的角色理論（每個角色用全部場次，同樣的補值）；`career.positionTheory`、`career.finalWinRate` 是生涯的位置理論與最終勝率，`career.games` = `totalGames`。
- schemaVersion 3 另有 `last50`（近 50 場），2026-10-14 拿掉（場數太少）；舊快取的讀者照舊用 `theoryLastWindows()` 讀鍵，`last50` 缺也沒關係。
- 近 N 場的 N 不是另外一個設定，固定等於 `mainGames`（`theory_windows()` = [`mainGames`]），所以玩家卡、雷達、位置理論榜、總覽排行一定看同樣的場數。設定改了，鍵名跟著改（例如 `mainGames` 改成 80 就是 `last80`）；機器人、網站、測試都依鍵名或 `leaderboard.config.theoryWindows` 讀，不假設一定是 100。角色視窗的 K 也是讀快取（`theoryConfig.roleWindowGames`、`roles[].window`）。
- `from` / `to`：這段場次裡最早 / 最晚有日期的局（`roleWindows` 是所有角色用到的局）。
- 「最近」的順序：先看日期時間，同一天再看在牌譜（接著是 Discord匯入）裡的列序。沒有日期的局跟著它上面最近一筆有日期的局排；牌譜最上面那批沒有日期的舊局排在最前面（最舊）。
- 只算結果是三紅／三藍死／三藍活的局，和玩家層其他欄位一致。

**少場補值（可以拿掉）**：某個角色或位置在這段場次裡不到 3 場，就用「全體在這個角色／位置的最終勝率」補到 3 場再算。例如最近 100 場只當過 2 次梅林、贏 1 次，梅林那格就算成（贏的 1 場 + 補上的 1 場 × 全體梅林勝率）÷ 3 場；全體梅林勝率 30% 時是 (1 + 0.3) ÷ 3 ≈ 43.3%，不會因為只有 2 場就直接算 50%（或 0%、100%）。完全沒當過的角色就直接用全體勝率。全體勝率用快取裡公開的 `overview.roleFinalWinRates` / `seatFinalWinRates`（一位小數），所以每格怎麼補都查得到。`sparseRoles` / `sparseSeats` 記錄補了幾格（角色共 7 格、位置共 10 格）。這個門檻是 `LEADERBOARD_CONFIG["theoryMinCellGames"]`（3）；**Edward 若不要補值，改成 0 即可，其他地方不用動**（改成 0 後，有打過的格子用本人自己的勝率，沒打過的格子仍用全體勝率，因為不能留空）。機器人的註腳、榜的說明、網站的說明文字都讀快取裡的設定（`leaderboard.config`、`overview.theoryConfig`），改成 0 後就不再提補值；產生器的測試用自己固定的設定（`test_generate_cache.py` 的 `TEST_LEADERBOARD_CONFIG`），所以每日重算前跑的測試不會因為改設定而失敗，`LeaderboardConfigTest` 另外檢查真正的設定能產生合格的快取。在 2146 局的快照裡，生涯 ≥ 100 場的 40 人，最近 100 場平均補了 0 格；（已拿掉的）最近 50 場平均補了 0.65 個角色格、1.1 個位置格；角色視窗（各角色近 10 場、忠臣 40）平均補了 0 格。

**為什麼還不算「最完整理論勝率」（角色 × 位置）**：那要把 7 個角色 × 10 個位置 = 70 格各自算勝率。特殊角色在某一個位置的機率只有 1/10 × 1/10 = 1/100，要平均每格 3 場就要約 300 場，5 場就要約 500 場。2146 局快照實測：生涯 ≥ 100 場的人，最近 100 場裡 70 格中平均只有 12 格有 3 場以上（最多 16 格），其他格子幾乎全靠補值，算出來就只是全體平均；只有生涯 700 場以上的少數老玩家才把 70 格大致填滿。所以照 Edward 說的，先分角色、分位置各算一個。

計算細節（`generate_cache.py` 的 `player_timelines`、`theory_window`、`role_window_theory`）：分數用精確分數相加、最後四捨五入到一位（同 rnd1，剛好 .x5 時取偶數）；`ROLE_DEAL_TENTHS` 是發牌機率（以 1/10 為單位），`SEAT_DEAL_TENTHS` 每個位置 1。

## 排行（`leaderboard` 段，2026-10-14 版，schemaVersion 4）

原則：**條件篩選可以是近期，但資料篩選不能少場**。誰能上榜看近期（近 `activeDays` = 90 天內有出賽，含 asOf 當天），榜上的數字一律是**各人自己的場次**（角色理論：每個角色自己的最近場次；位置理論：最近 100 場；整體理論：生涯），不再用 90 天、7 天、上個月這種短日期區間。唯一例外是新人榜（新人本來就場數少，用他的全部場次，榜上標「例外」）。常數集中在 `generate_cache.py` 的 `LEADERBOARD_CONFIG` 一處；TS 只讀快取，不重算。總覽（分析 > 總覽）的三個排行（`overview.topPlayersBy*Theory`）不限近期出賽，排行分頁的榜限近 90 天。

```json
"leaderboard": {
  "asOf": "2026-10-14",
  "dates": {"parsed": 2165, "unparsed": 63, "earliest": "2017-02-13", "latest": "2026-10-10"},
  "config": {"theoryWindows": [100], "theoryMinCellGames": 3, "activeDays": 90, "topN": 10,
             "mainGames": 100, "roleWindowGames": 10, "loyalWindowGames": 40, "overallMinGames": 250,
             "assassinAttempts": 20, "assassinMinAttempts": 10, "newcomerDays": 90, "newcomerMinGames": 10,
             "roleTitleMinGames": 20, "roleTitleGames": 20},
  "boards": [
    {"id": "main", "metric": "roleTheory", "title": "角色理論勝率排行", "titleEn": "Role-theory win rate",
     "period": "各角色近 10 場、忠臣近 40 場", "periodEn": "Each role's last 10 games (Loyal Servant: last 40)", "minGames": 100,
     "note": "近 90 天內有出賽、六個特殊角色各至少 10 場、忠臣至少 40 場；位置理論與最終勝率看最近 100 場；角色理論 = …",
     "noteEn": "…", "roleWindowGames": {"刺客": 10, "...": "...", "忠臣": 40},
     "rows": [{"rank": 1, "name": "…", "value": 56.0, "roleTheory": 56.0, "positionTheory": 55.2, "overallTheory": 54.2,
               "finalWinRate": 56.0, "games": 100, "careerGames": 1018, "from": "2025-07-29", "to": "2026-10-10",
               "sparseRoles": 0, "sparseSeats": 0}]}
  ]
}
```

| id | metric（value 是什麼） | 誰上榜 | 數字看哪些場 | 每列另附 |
|---|---|---|---|---|
| `main` 角色理論勝率排行 | `roleTheory`（角色視窗） | 近 90 天有出賽、每個角色都打滿（六個特殊角色各 ≥ 10 場、忠臣 ≥ 40 場，`fullWindows`） | 各角色近 10 場、忠臣近 40 場（`roleWindowGames`）；`positionTheory`、`finalWinRate` 看最近 100 場 | `roleTheory`、`positionTheory`、`overallTheory`（生涯角色理論）、`finalWinRate`、`games`（角色視窗場數，100）、`careerGames`、`from`、`to`、`sparseRoles`、`sparseSeats` |
| `position` 位置理論勝率排行 | `positionTheory` | 近 90 天有出賽、生涯 ≥ 100 場 | 各人最近 100 場（`windowGames: 100`） | `positionTheory`、`overallTheory`、`finalWinRate`、`games`、`careerGames`、`from`、`to`、`sparseSeats` |
| `overall` 整體理論勝率排行 | `overallTheory` = 生涯角色理論 | 近 90 天有出賽、生涯 ≥ 250 場（`overallMinGames`） | 生涯全部場次 | `overallTheory`、`positionTheory`（生涯）、`finalWinRate`（生涯）、`games`（= 生涯場數）、`careerGames`、`from`、`to`、`sparseRoles`、`sparseSeats` |
| `improved` 進步榜 | `roleTheoryDelta` = 角色視窗的角色理論 − 每個角色再之前同樣場數的角色理論 | 近 90 天有出賽、六個特殊角色各 ≥ 20 場、忠臣 ≥ 80 場（兩段都打滿）；只列有進步（> 0）的人 | 每個角色：最近 10 場（忠臣 40）vs 再之前 10 場（忠臣 40） | `recentRoleTheory`、`priorRoleTheory`、`recentGames`、`priorGames`、`careerGames`；`roleWindowGames` |
| `assassin` 刺客刺中率 | `hitRate` = 三藍死 /（三藍死 + 三藍活） | 近 90 天有出賽、至少 10 次刺殺 | 各人當刺客、任務做到三藍的最近 20 局（三紅沒有刺殺） | `hits`、`attempts`（= `games`）、`careerGames`、`from`、`to` |
| `newcomers` 新人榜（例外） | `roleTheory`（角色視窗） | 首次出賽在近 90 天內、每局都有日期、≥ 10 場 | 他的全部場次：角色理論每個角色用全部場次（最多近 10 場、忠臣 40；通常打不滿，不到 3 場補值），位置理論與最終勝率用全部場次（`allGames: true`，`windowDays: 90`） | 同 `main`，加 `firstPlayed` |
| `roleTitles` 角色王 | `finalWinRate` | 每個角色：近 90 天有出賽、生涯該角色 ≥ 20 場 | 各人該角色最近 20 場 | `role`、`wins`、`careerRoleGames`；每個角色只列第一名 |

- 排序：value 高 → 低，同分看 `games` 多的、再看 `careerGames` 多的、再看名字；角色王同率看該角色生涯場數多的、再看名字。每榜最多 `topN`（10）列；做不出來的榜（沒有人符合）就不放。
- 進步榜的 value 是兩段角色理論勝率相減，單位是**百分點**（網站顯示「+10.4 個百分點」，機器人顯示「+10.4」），不是相對成長幾 %。兩段都打滿時，角色理論剛好等於該段 100 場的最終勝率，所以列裡不再另附 `recentFinalWinRate` / `priorFinalWinRate`。
- 角色王：同一個人可以同時拿好幾個角色的稱號。2146 局快照裡，一位玩家拿了 7 個角色中的 5 個（刺客、莫甘娜、莫德雷德、梅林、忠臣），其中莫甘娜、莫德雷德（都是最近 20 場贏 18 場）與忠臣（9/20）三個是同率，靠「該角色生涯場數多」勝出（例如 89 場對 46 場）。要不要改成同率並列、或每人最多一個稱號，由 Edward 決定。
- 每個榜都有 `id`、`metric`、`title`、`titleEn`、`period`、`periodEn`、`minGames`、`note`、`noteEn`、`rows`；`position`、`assassin`、`roleTitles` 有 `windowGames`，`main`、`improved` 有 `roleWindowGames`（`{角色: 場數}`），`newcomers` 有 `windowDays` 與 `allGames`，`overall` 都沒有（生涯）。`main` 的 `minGames` 是 Σ 角色視窗（100，必要不充分；真正條件是每個角色），`improved` 是它的兩倍。`note` 第一個「；」前是上榜條件（機器人只印這段），後面是公式說明（網站顯示整段）。
- 拿掉的榜：`last50`（近 50 場角色理論，2026-10-14：場數太少），以及更早的 90 天日期窗的 `recent`、日期窗的 `improved`、7 天的 `assassin`、上個月的 `roleTitles`、`online`（線瓦榜）。線瓦榜拿掉是因為近一年的局幾乎都是線瓦：2026-10-12 的快取裡，近一年的局 100% 有填分類，超額主榜與線瓦榜上是同樣的 10 個人，他們這一年的 627 場出賽中 555 場（約 89%）是線瓦，兩個榜幾乎一樣。設定裡的 `shortGames`、`improvedGames` 也一起拿掉（進步榜改看角色視窗）。
- 「近 90 天內有出賽」看該玩家全部有日期的局的最晚一場；日期在 asOf 之後（打錯字）的局當作沒有日期。`asOf` 預設為台灣（+08）當天，環境變數 `AVALON_STATS_AS_OF=YYYY-MM-DD` 可覆寫（測試與重現用）；`leaderboard.config` 是 `LEADERBOARD_CONFIG` 的完整複本，前面再加自動帶出的 `theoryWindows`（= [`mainGames`]）。日期只影響「誰算近期出賽」與新人榜的期間；若和前一天的檔案相比只差 asOf，就不重寫檔案（`only_the_day_changed`）。
- 舊快取（2026-10-12 版）的榜沒有 `metric`、是超額勝率：網站與機器人一律不顯示，改提示「下次每日更新後提供」；機器人 `/排行` 會先退到 `overview.topPlayersByRoleTheory`。schemaVersion 3（2026-10-13 版）的快取：榜與玩家卡照 10-13 的樣子（近 100 場、近 50 場）顯示，直到每日重算寫出 schemaVersion 4。
- 機器人 `/排行`（schemaVersion 4）每行：名次、名字、角色理論、位置理論、整體理論、最終勝率、生涯場數；標題附期間（各角色近 10 場、忠臣近 40 場）與上榜條件。`/戰績`：「角色理論（各角色近 10 場、忠臣近 40 場）」「位置理論（近 100 場）＋最終勝率」「整體理論（生涯 N 場）＋生涯位置理論、最終勝率」三行，角色視窗沒打滿時註明場數、「不列入角色理論勝率排行」（只有主榜要每個角色打滿；同一人可能在位置理論、整體理論榜上，所以不寫「不列入排行」），人在新人榜上時再附「新人榜第 k 名」；再接紅方、藍方各一行三塊結果（任務結果、刺殺結果附三藍局數、遊戲結果）。schemaVersion 3 的快取照 10-13 的寫法。週一戰績週報：主榜 Top 10、進步榜 Top 5、角色王、新人榜。新人榜那行印新人自己的場數（`careerGames`；schemaVersion 4 的 `games` 是角色視窗的場數，某個角色超過 10 場時會比較少），並註明「新人例外：看全部場次，角色理論每個角色最多算近 10 場、忠臣 40 場」（數字讀 `leaderboard.config`）。
- 守門（`validate_new_cache`）：新快取的 `players[].theory.career.games` 必須等於 `totalGames`，`leaderboard.boards` 必須是陣列；從舊版（沒有 `theory` / `roleOutcomes`）換成新版不算欄位遺失。
- 改設定時：所有門檻都只改 `LEADERBOARD_CONFIG`，機器人與網站的榜名、期間、上榜條件、說明文字都讀快取，隔天重算後自動跟上。`/help`（Discord）與 `/指令`（LINE）的「角色理論勝率排行 Top 10（…）」也讀快取（`statsQueries.leaderboardScopeText` → `statsReplies.leaderboardScope`：主榜的 `period`，沒有主榜時看設定），所以推上去之後、第一次每日重算之前，舊的 schemaVersion 3 快取仍顯示「各人最近 100 場」，和 `/排行` 一致；讀不到快取時不寫期間。只有兩處寫的是預設值：Discord `/排行` 指令的說明（`bots/discord/client.ts`；部署時向 Discord 註冊一次，讀不到快取，所以直接寫 schemaVersion 4 的「各角色近 10 場、忠臣近 40 場」，推上去到第一次重算之間會和舊快取的 `/排行` 不一致），以及舊快取才會出現的「排行改版中」提示（`LEADERBOARD_PENDING_NOTE`）；`formatStatsHelp` 沒給期間時的預設（`DEFAULT_LEADERBOARD_SCOPE`）也是。改 `roleWindowGames` / `loyalWindowGames` 時這幾行要一起改。
- 本機預覽：環境變數 `AVALON_ANALYSIS_CACHE=<檔案>` 讓後端（`services/sheetsAnalysis.ts`）與 `AnalysisCacheContract.test.ts` 改讀那個檔（例如每日重算前，用 `sheets_cache.json` 快照離線產生的 schemaVersion 4 快取）；正式環境不設。

## 特徵研究（`featureStudies`）

- `L141` 改由 `generate_cache.py` 從牌譜計算（`visualType: "lakeClaim"`）：持湖者宣告紅 / 藍時，目標真的是紅 / 藍的機率，分首湖、二湖、三湖；每格附 `n`、Wilson 95% 區間（`ciLow`、`ciHigh`）、`lowSample`（n < 30）。湖線 `H>T x` 的 x = 宣告紅、o = 宣告藍（2146 局快照驗證：藍方持湖宣告與事實一致 99%）。

```json
{"loopId": "L141", "visualType": "lakeClaim", "data": {"minSample": 30,
 "rows": [{"lake": "首湖", "lakeEn": "Lake 1", "declared": "紅", "declaredEn": "evil", "n": 300, "hitRate": 77.1, "ciLow": 72.0, "ciHigh": 81.6, "lowSample": false}]}}
```

  實作補充：`rows` 每格另有 `hits`；`data.holderRows` 是同一格式再依**持湖者陣營**（`holder`：藍／紅，`holderEn`：good／evil）× 宣告分的四格，`data.undeclared` 是沒寫 x/o 的湖線數；首湖／二湖／三湖 = 文字記錄的第 1／2／3 條湖線（`H>T x`，單一座位字元，0 = 10 號）；`sampleSize.links` 與 `featureStudies.sampleSize.lakeLinks` = 前三條湖線的總數（含未宣告）；`sourceReport: "generate_cache.py"`、`computedAt` = asOf；`featureStudies.generatedAt` 也改為 asOf（`YYYY-MM-DD`，每天不會因時間不同而變動）。oneLineHook／takeaway 由數字生成。

- `L142`、`L143`、`L136`、`L139` 仍沿用快取（擁有者電腦產生），但 `generate_cache.py` 每次都會覆寫其結論文字並補 `n` 標記（`annotate_feature_studies`）：
  - L143：隊長次數多是座位輪替造成，不代表主動。
  - L142：每格標 n；n < 30 標「樣本不足」（刺客 100% 只有 15 筆）。
  - L136：差距只有 ±1.6pp，明講差距很小。
  - L139：註明選擇偏誤（forced P5 本身就是局勢已偏向紅方的結果）。

  實作補充：只改 `oneLineHook`／`oneLineHookEn`／`takeaway`／`takeawayEn`（文字由各研究自己的數字生成），數字欄位不動；`L142.data.rows[]` 與 `data.highEvCells[]` 各加 `lowSample`（`total` / `n` < 30）。函式是純函式且冪等，第一次沒有舊快取時 featureStudies 只有 L141。

## 檔案分工

| 範圍 | 檔案 |
|---|---|
| 資料層 | `packages/server/generate_cache.py`（`LEADERBOARD_CONFIG`、`player_timelines`、`theory_window`、`role_window_theory`、`compute_leaderboard`）、`test_generate_cache.py`（`TheoryTest` 手算例子、`LeaderboardTest`、`RotationBoardsTest`、`LeaderboardConfigTest`）、`analysis_cache.json`（每日由 workflow 重算） |
| 共用 | `packages/shared/src/derived/outcomeBlocks.ts`（三塊結果）；測試 `packages/server/src/__tests__/OutcomeBlocks.test.ts` |
| 後端與機器人 | `services/sheetsAnalysis.ts`、`routes/analysis.ts`、`__tests__/AnalysisCacheContract.test.ts`、`bots/stats/*`、`bots/discord/commands.ts`、`bots/discord/client.ts`（/help 與 /排行 說明文字）、`__tests__/*Stats*.test.ts` |
| 網站 | `packages/web/src/services/api.ts`、`pages/AnalyticsPage.tsx`、`components/analysis/*`（`LeaderboardBoards`、`OverviewPanel`、`PlayerRadarChart`、`RoleFinalWinRates`）、`components/analytics/*`、`i18n/locales/*` |
