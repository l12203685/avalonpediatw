# 兩段結算與超額勝率：資料契約

[20261012] 依 Edward 裁定：「遊戲分成任務結算跟刺殺結算／任務結算不是三紅就是三藍／刺殺結算只有三藍時需要結算是否刺殺成功／但最終就是考慮 藍方要獲勝就是必須三藍且梅林活」。

[20261013] 依 Edward 裁定改用「角色理論勝率／位置理論勝率」與「各人最近 N 場」（見下方〈理論勝率〉與〈排行〉）；超額勝率保留在資料裡，但排行、機器人、網站主畫面都不再使用。

本文件是 `generate_cache.py`（資料層）、`services/sheetsAnalysis.ts` 與 `routes/analysis.ts`（後端）、`packages/web`（網站）、`bots/stats`（機器人）共同遵守的欄位契約。舊欄位一律保留。

## 定義

| 名稱 | 定義 |
|---|---|
| 任務結算（missionStage） | 三紅 = 紅方；三藍（死或活）= 藍方 |
| 刺殺結算（assassinationStage） | 只在三藍局：三藍死 = 刺中；三藍活 = 沒刺中 |
| 最終（final） | 紅勝 = 三紅 + 三藍死；藍勝 = 三藍活 |

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
| `theory` | 理論勝率：`last100`、`last50`、`career` 三段（schemaVersion 3，見〈理論勝率〉） |

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
"topPlayersByRoleTheory": [{"name": "…", "roleTheory": 55.2, "positionTheory": 55.2, "finalWinRate": 56.0, "games": 100, "careerGames": 1014}]
```

- `seatFinalWinRates`：全體各位置（鍵 `1`～`10`，10 號位）的最終勝率，算法同 `roleFinalWinRates`（有名字的座位、結果是三紅／三藍死／三藍活的局）。位置理論補值用。
- `topPlayersByRoleTheory`：生涯至少 `mainGames`（100）場的玩家，**不限近期出賽**，依各人最近 100 場的角色理論勝率排序（同分看生涯場數多的、再看名字），前 `topN`（10）名；網站總覽用。

`players.players[]` 與 `playerDetails[name].player`：上表玩家層欄位全部加入。

`playerDetails[name].radar`（由 `routes/analysis.ts` 組）：

```json
{"winRate": finalWinRate, "redWinRate": finalRedWinRate, "blueMerlinProtect": blueMerlinAlive,
 "missionWinRate": missionWinRate, "excessWinRate": excessWinRate, "redMerlinKillRate": redMerlinDead,
 "experience": min(totalGames/10, 100),
 "roleTheory": theory.career.roleTheory, "positionTheory": theory.career.positionTheory}
```

`roleTheory` / `positionTheory` 是生涯的理論勝率（2026-10-13 起）；快取沒有 `theory` 時為 `null`，不拿舊的 `roleTheory` 充數。網站雷達只讀 `player.theory`（舊後端送的 radar 這兩鍵是舊口徑），`excessWinRate` 不再畫。

快取缺新欄位時（重算前的舊快取），後端用原始計數現場算：`finalWinRate = (rawRedThreeRed + rawRedMerlinDead + rawBlueMerlinAlive) / totalGames` 等；`excessWinRate` 算不出來時為 `null`，網站與機器人顯示「—」。

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

**看哪些場（視窗）**：每位玩家各算三段，寫在 `players[].theory`：

```json
"theory": {
  "last100": {"window": 100, "games": 100, "roleTheory": 44.3, "positionTheory": 44.6, "finalWinRate": 45.0,
              "from": "2025-08-12", "to": "2026-02-27", "sparseRoles": 0, "sparseSeats": 0},
  "last50":  {"window": 50,  "games": 50,  "roleTheory": 47.6, "positionTheory": 50.1, "finalWinRate": 48.0, "...": "..."},
  "career":  {"window": 0,   "games": 1081, "roleTheory": 46.4, "positionTheory": 47.0, "finalWinRate": 47.1, "...": "..."}
}
```

- `last100` / `last50`：本人最近 100 / 50 場；場數不夠時就是全部場次，`games` 寫實際場數（機器人與網站此時只列生涯那一段）。`career`：全部場次（`games` = `totalGames`）。
- `from` / `to`：這段場次裡最早 / 最晚有日期的局。
- 「最近」的順序：先看日期時間，同一天再看在牌譜（接著是 Discord匯入）裡的列序。沒有日期的局跟著它上面最近一筆有日期的局排；牌譜最上面那批沒有日期的舊局排在最前面（最舊）。
- 只算結果是三紅／三藍死／三藍活的局，和玩家層其他欄位一致。

**少場補值（可以拿掉）**：某個角色或位置在這段場次裡不到 3 場，就用「全體在這個角色／位置的最終勝率」補到 3 場再算。例如最近 100 場只當過 2 次梅林、贏 1 次，梅林那格就算成（贏的 1 場 + 補上的 1 場 × 全體梅林勝率）÷ 3 場；全體梅林勝率 30% 時是 (1 + 0.3) ÷ 3 ≈ 43.3%，不會因為只有 2 場就直接算 50%（或 0%、100%）。完全沒當過的角色就直接用全體勝率。全體勝率用快取裡公開的 `overview.roleFinalWinRates` / `seatFinalWinRates`（一位小數），所以每格怎麼補都查得到。`sparseRoles` / `sparseSeats` 記錄補了幾格（角色共 7 格、位置共 10 格）。這個門檻是 `LEADERBOARD_CONFIG["theoryMinCellGames"]`（3）；**Edward 若不要補值，改成 0 即可**（改成 0 後，有打過的格子用本人自己的勝率，沒打過的格子仍用全體勝率，因為不能留空）。在 2146 局的快照裡，生涯 ≥ 100 場的 40 人，最近 100 場平均補了 0 格；最近 50 場平均補了 0.65 個角色格、1.1 個位置格。

**為什麼還不算「最完整理論勝率」（角色 × 位置）**：那要把 7 個角色 × 10 個位置 = 70 格各自算勝率。特殊角色在某一個位置的機率只有 1/10 × 1/10 = 1/100，要平均每格 3 場就要約 300 場，5 場就要約 500 場。2146 局快照實測：生涯 ≥ 100 場的人，最近 100 場裡 70 格中平均只有 12 格有 3 場以上（最多 16 格），其他格子幾乎全靠補值，算出來就只是全體平均；只有生涯 700 場以上的少數老玩家才把 70 格大致填滿。所以照 Edward 說的，先分角色、分位置各算一個。

計算細節（`generate_cache.py` 的 `player_timelines`、`theory_window`）：分數用精確分數相加、最後四捨五入到一位（同 rnd1，剛好 .x5 時取偶數）；`ROLE_DEAL_TENTHS` 是發牌機率（以 1/10 為單位），`SEAT_DEAL_TENTHS` 每個位置 1。

## 排行（`leaderboard` 段，2026-10-13 版）

原則：**條件篩選可以是近期，但資料篩選不能少場**。誰能上榜看近期（近 `activeDays` = 90 天內有出賽，含 asOf 當天），榜上的數字一律是**各人自己的最近 N 場**，不再用 90 天、7 天、上個月這種短日期區間。唯一例外是新人榜（新人本來就場數少，用他的全部場次，榜上標「例外」）。常數集中在 `generate_cache.py` 的 `LEADERBOARD_CONFIG` 一處；TS 只讀快取，不重算。

```json
"leaderboard": {
  "asOf": "2026-10-13",
  "dates": {"parsed": 2165, "unparsed": 63, "earliest": "2017-02-13", "latest": "2026-10-10"},
  "config": {"theoryWindows": [100, 50], "theoryMinCellGames": 3, "activeDays": 90, "topN": 10,
             "mainGames": 100, "shortGames": 50, "improvedGames": 50, "assassinAttempts": 20,
             "assassinMinAttempts": 10, "newcomerDays": 90, "newcomerMinGames": 10,
             "roleTitleMinGames": 20, "roleTitleGames": 20},
  "boards": [
    {"id": "main", "metric": "roleTheory", "title": "角色理論勝率排行", "titleEn": "Role-theory win rate",
     "period": "各人最近 100 場", "periodEn": "Each player's last 100 games", "minGames": 100,
     "note": "近 90 天內有出賽、生涯至少 100 場；角色理論 = …", "noteEn": "…", "windowGames": 100,
     "rows": [{"rank": 1, "name": "…", "value": 55.2, "roleTheory": 55.2, "positionTheory": 55.2, "finalWinRate": 56.0,
               "games": 100, "careerGames": 1014, "from": "2025-08-12", "to": "2026-10-10", "sparseRoles": 0, "sparseSeats": 0}]}
  ]
}
```

| id | metric（value 是什麼） | 誰上榜 | 數字看哪些場 | 每列另附 |
|---|---|---|---|---|
| `main` 角色理論勝率排行 | `roleTheory` | 近 90 天有出賽、生涯 ≥ 100 場 | 各人最近 100 場 | `roleTheory`、`positionTheory`、`finalWinRate`、`games`、`careerGames`、`from`、`to`、`sparseRoles`、`sparseSeats` |
| `last50` 近 50 場角色理論勝率 | `roleTheory` | 近 90 天有出賽、生涯 ≥ 50 場 | 各人最近 50 場 | 同上 |
| `improved` 進步榜 | `roleTheoryDelta` = 最近 50 場角色理論 − 再之前 50 場 | 近 90 天有出賽、生涯 ≥ 100 場；只列有進步（> 0）的人 | 最近 50 場 vs 再之前 50 場 | `recentRoleTheory`、`priorRoleTheory`、`recentFinalWinRate`、`priorFinalWinRate`、`recentGames`、`priorGames`、`careerGames` |
| `assassin` 刺客刺中率 | `hitRate` = 三藍死 /（三藍死 + 三藍活） | 近 90 天有出賽、至少 10 次刺殺 | 各人當刺客、任務做到三藍的最近 20 局（三紅沒有刺殺） | `hits`、`attempts`（= `games`）、`careerGames`、`from`、`to` |
| `newcomers` 新人榜（例外） | `roleTheory` | 首次出賽在近 90 天內、每局都有日期、≥ 10 場 | 他的全部場次（`allGames: true`，`windowDays: 90`） | 同 `main`，加 `firstPlayed` |
| `roleTitles` 角色王 | `finalWinRate` | 每個角色：近 90 天有出賽、生涯該角色 ≥ 20 場 | 各人該角色最近 20 場 | `role`、`wins`、`careerRoleGames`；每個角色只列第一名 |

- 排序：value 高 → 低，同分看 `games` 多的、再看 `careerGames` 多的、再看名字；角色王同率看該角色生涯場數多的、再看名字。每榜最多 `topN`（10）列；做不出來的榜（沒有人符合）就不放。
- 每個榜都有 `id`、`metric`、`title`、`titleEn`、`period`、`periodEn`、`minGames`、`note`、`noteEn`、`rows`；`main`、`last50`、`improved`、`assassin`、`roleTitles` 有 `windowGames`，`newcomers` 有 `windowDays` 與 `allGames`。`note` 第一個「；」前是上榜條件（機器人只印這段），後面是公式說明（網站顯示整段）。
- 拿掉的舊榜：90 天日期窗的 `recent`、日期窗的 `improved`、7 天的 `assassin`、上個月的 `roleTitles`，以及 `online`（線瓦榜）。線瓦榜拿掉是因為近一年的局幾乎都是線瓦：2026-10-12 的快取裡，近一年的局 100% 有填分類，超額主榜與線瓦榜上是同樣的 10 個人，他們這一年的 627 場出賽中 555 場（約 89%）是線瓦，兩個榜幾乎一樣。
- 「近 90 天內有出賽」看該玩家全部有日期的局的最晚一場；日期在 asOf 之後（打錯字）的局當作沒有日期。`asOf` 預設為台灣（+08）當天，環境變數 `AVALON_STATS_AS_OF=YYYY-MM-DD` 可覆寫（測試與重現用）；`leaderboard.config` 是 `LEADERBOARD_CONFIG` 的完整複本。日期只影響「誰算近期出賽」與新人榜的期間；若和前一天的檔案相比只差 asOf，就不重寫檔案（`only_the_day_changed`）。
- 舊快取（2026-10-12 版）的榜沒有 `metric`、是超額勝率：網站與機器人一律不顯示，改提示「下次每日更新後提供」；機器人 `/排行` 會先退到 `overview.topPlayersByRoleTheory`。
- 機器人 `/排行` 每行：名次、名字、角色理論、位置理論、最終勝率、場數；標題附期間與上榜條件。`/戰績`：近 100 場、近 50 場（場數夠才列）、生涯三行的角色理論／位置理論／最終勝率，再接任務結算 → 刺殺結算 → 最終。週一戰績週報：主榜 Top 10、進步榜 Top 5、角色王、新人榜。
- 守門（`validate_new_cache`）：新快取的 `players[].theory.career.games` 必須等於 `totalGames`，`leaderboard.boards` 必須是陣列；從 2026-10-12 版（沒有 `theory`）換成新版不算欄位遺失。

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
| 資料層 | `packages/server/generate_cache.py`（`LEADERBOARD_CONFIG`、`player_timelines`、`theory_window`、`compute_leaderboard`）、`test_generate_cache.py`（`TheoryTest` 手算例子、`LeaderboardTest`）、`analysis_cache.json`（每日由 workflow 重算） |
| 後端與機器人 | `services/sheetsAnalysis.ts`、`routes/analysis.ts`、`__tests__/AnalysisCacheContract.test.ts`、`bots/stats/*`、`bots/discord/commands.ts`（/help 文字）、`__tests__/*Stats*.test.ts` |
| 網站 | `packages/web/src/services/api.ts`、`pages/AnalyticsPage.tsx`、`components/analysis/*`（`LeaderboardBoards`、`OverviewPanel`、`PlayerRadarChart`）、`components/analytics/*`、`i18n/locales/*` |
