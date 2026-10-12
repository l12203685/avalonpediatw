# 兩段結算與超額勝率：資料契約

[20261012] 依 Edward 裁定：「遊戲分成任務結算跟刺殺結算／任務結算不是三紅就是三藍／刺殺結算只有三藍時需要結算是否刺殺成功／但最終就是考慮 藍方要獲勝就是必須三藍且梅林活」。

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
| `excessWinRate` | `finalWinRate` − `expectedFinalWinRate`（可為負；取代「角色理論」） |
| `firstPlayed` / `lastPlayed` | 解析得到的最早 / 最晚出賽日 `YYYY-MM-DD`，沒有則 `""` |

舊欄位語意（保留不改）：`winRate`、`redWin`、`blueWin`、`roleWinRates`、`seat*WinRates` 都是任務結算口徑（三藍死算藍勝）。`roleTheory` ≈ 本人任務結算勝率，`positionTheory` 恆為 0，網站不再顯示。

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

`topPlayersByExcess` 門檻同 `topPlayersByTheory`（`MIN_GAMES_THRESHOLD` = 30），依全期縮減後超額勝率排序。

`players.players[]` 與 `playerDetails[name].player`：上表玩家層欄位全部加入。

`playerDetails[name].radar`（由 `routes/analysis.ts` 組）：

```json
{"winRate": finalWinRate, "redWinRate": finalRedWinRate, "blueMerlinProtect": blueMerlinAlive,
 "missionWinRate": missionWinRate, "excessWinRate": excessWinRate, "redMerlinKillRate": redMerlinDead,
 "experience": min(totalGames/10, 100), "roleTheory": roleTheory, "positionTheory": 0}
```

快取缺新欄位時（重算前的舊快取），後端用原始計數現場算：`finalWinRate = (rawRedThreeRed + rawRedMerlinDead + rawBlueMerlinAlive) / totalGames` 等；`excessWinRate` 算不出來時為 `null`，網站與機器人顯示「—」。

## 排行（新段 `leaderboard`）

常數集中在 `generate_cache.py` 的 `LEADERBOARD_CONFIG` 一處；TS 只讀快取，不重算。

```json
"leaderboard": {
  "asOf": "2026-10-12",
  "dates": {"parsed": 2160, "unparsed": 68, "earliest": "2017-01-01", "latest": "2026-10-11"},
  "config": {"windowDays": 365, "activeDays": 90, "minGames": 20, "shrinkK": 20, "fallbackWindowDays": [730, 0], "minBoardRows": 5, "topN": 10},
  "boards": [
    {
      "id": "main", "title": "超額勝率排行", "period": "2025-10-13 ～ 2026-10-12", "windowDays": 365,
      "minGames": 20, "note": "近 90 天內有出賽、期間至少 20 場",
      "rows": [{"rank": 1, "name": "HAO", "value": 6.3, "excessWinRate": 8.9, "finalWinRate": 38.5, "expectedFinalWinRate": 29.6, "games": 48}]
    }
  ]
}
```

- `value` 是該榜的排序值；`main`、`online`、`recent`、`newcomers` 的 value = 縮減後超額勝率 = `excess × games / (games + shrinkK)`，同一列另附未縮減的 `excessWinRate`（網站與機器人顯示這個，不顯示 `value`）、`finalWinRate`、`expectedFinalWinRate`、`games`。其他榜的 rows 沒有 `finalWinRate`：`improved` 有 `recentFinalWinRate`、`priorFinalWinRate`、`recentGames`、`priorGames`；`assassin` 有 `hits`、`attempts`；`roleTitles` 有 `role`、`wins`。
- 日期來源：牌譜的「日期時間」、Discord匯入的「日期時間」；解析不了的局計入 `dates.unparsed`，不猜（`1900/01/01` 視為沒有日期）。
- `main` 上榜不足 `minBoardRows` 人時依序放寬到 `fallbackWindowDays`（0 = 全期），實際用的 `windowDays` 與 `period` 寫在榜上。
- 其他榜（都在同一段，id 固定）：`online`（分類 = 線瓦，覆蓋率 ≥ 60% 才產生）、`recent`（近 90 天，至少 10 場）、`improved`（近 90 天最終勝率 − 前 275 天最終勝率，兩段各 ≥ 10 場）、`assassin`（近 7 天刺客刺中率，附場數）、`newcomers`（首次出賽在近 90 天內、≥ 5 場）、`roleTitles`（上個月各角色最終勝率第一名，各角色 ≥ 5 場）。做不出來的榜就不放（rows 為空則整個 board 省略）。
- 機器人每行只顯示：名次、名字、超額勝率、最終勝率、期間場數；標題註明期間。

實作細節（`generate_cache.py`，2026-10-12 補充，不改上面的定義）：

- 期間：N 天的視窗 = `[asOf − N + 1, asOf]`（含兩端）；`windowDays: 0`（全期）= 所有的局，**含沒有日期的局**，`period` 的起點寫最早有日期的局。只有有「結果」（三紅／三藍死／三藍活）的局計入，和玩家列一致。
- 期間內的超額勝率：`finalWinRate`（期間內）− Σ 本人期間內該角色出現比例 × `overview.roleFinalWinRates`（全期的全體角色最終勝率，不隨視窗變動）。`expectedFinalWinRate`（玩家層與排行）都用四捨五入到一位的 `overview.roleFinalWinRates` 計算：`rnd1(Σ rawRoleGames[r] × roleFinalWinRates[r] / totalGames)`，所以只靠快取就能重算。
- 「近 90 天內有出賽」（`activeDays`）看該玩家全部有日期的局的最晚一場，與視窗無關。
- `online` 的覆蓋率 = `main` 最後採用的期間內「分類」欄非空白的局數比例（`coverage`、`category` 寫在榜上）；期間與 `main` 相同、不另外放寬。
- `recent`、`newcomers` 的 value 也是縮減後超額勝率（rows 另附 `excessWinRate`、`finalWinRate`、`expectedFinalWinRate`）；`newcomers` 要求該玩家所有局都有日期（有無日期的局就不算新人），rows 附 `firstPlayed`。`improved` 的 value = 近段最終勝率 − 前段最終勝率，rows 有 `recentFinalWinRate`、`priorFinalWinRate`、`recentGames`、`priorGames`，榜上有 `priorPeriod`。`assassin` 的 value = 三藍死 /（三藍死 + 三藍活）的刺客局（`hits`、`attempts`、`games` = 刺客場數）。`roleTitles` 每列一個角色：`role`、`name`、`value`（該角色最終勝率）、`games`、`wins`，同率者場數多的優先，再依名字。
- 每個榜都有 `id`、`title`、`titleEn`、`period`、`windowDays`、`minGames`、`note`、`noteEn`、`rows`；rows 的排序：value 高→低，同值場數多優先，再依名字。
- `asOf` 預設為台灣（+08）當天，環境變數 `AVALON_STATS_AS_OF=YYYY-MM-DD` 可覆寫（測試與重現用）；`leaderboard.config` 是 `LEADERBOARD_CONFIG` 的完整複本。因為 `asOf` 與視窗每天都在動，每日重算幾乎一定有 diff。

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
| 資料層 | `packages/server/generate_cache.py`、`test_generate_cache.py`、`analysis_cache.json`（只動 featureStudies 文字） |
| 後端與機器人 | `services/sheetsAnalysis.ts`、`routes/analysis.ts`、`__tests__/AnalysisCacheContract.test.ts`、`bots/stats/*`、`__tests__/*Stats*.test.ts` |
| 網站 | `packages/web/src/services/api.ts`、`pages/AnalyticsPage.tsx`、`components/analysis/*`、`components/analytics/*`、`components/LeaderboardV3Table.tsx`、`i18n/locales/*` |
