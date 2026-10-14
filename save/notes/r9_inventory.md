# 複合篩選 — 資料盤點（r9 inventory）

- 盤點日：2026-10-14；唯讀，程式碼一律取自 `r6/base`（1ec510f）的暫時 worktree，盤點完已移除。
- 快照：`packages/server/sheets_cache.json`（牌譜 3117 列，其中 2146 列是局；同贏 / 同輸 / 贏相關 / 同贏-同輸 各 29×29；**沒有 Discord匯入 分頁**）。
- 本文件只寫計數，不寫任何真實玩家名字；note 欄裡像人名的值一律遮成〔人名N〕（本機看原值：`python3.11 r9/inv/note.py <r6/base checkout>`）。
- 重現用腳本都在 `r9/inv/`（參數 = 任一 r6/base checkout 路徑）：`cols.py` `dist.py` `note.py` `misc.py` `fields.py` `subsets.py` `chem*.py` `size.py` `replay.ts` `build4.py`；`r9/inv/ref_schema4.json` 是用 r6/base 的 generate_cache.py 從快照重建的 schemaVersion 4 快取（as_of 2026-02-28，含真名，資料檔）。

---

## 0. 先看這裡：會改變做法的發現

1. **committed `analysis_cache.json` 是 schemaVersion 3，不是 4。** r6/base（以及 main、lane/r6-data）的 committed 快取都是 2026-10-13 每日排程寫的：`overview.schemaVersion = 3`、`players[].theory = {last100, last50, career}`、沒有 `roleOutcomes`、`topPlayersByGames` 沒有 outcomes、leaderboard 的榜是 `main / last50 / improved / assassin / newcomers / roleTitles`、`leaderboard.config` 有 `shortGames / improvedGames`。排程 checkout 的是 **main**（`.github/workflows/refresh-analysis-cache.yml`），r6 的 schema-4 產生器還沒合進 main，所以 committed 檔不會變成 4。
   → 「不加篩選時 TS 引擎要和 committed 快取完全一致」這道關卡**不能拿 r6/base 的 committed 檔比**（理論區塊、排行榜一定對不上）。必須比對 r6 產生器重建的快取。
2. **快照和 committed 快取不是同一份資料。** 快照 2146 局（測試稱 2026-04-03 的牌譜副本；最晚日期 2026-02-27；無 Discord匯入），committed 快取 2228 局（`leaderboard.dates.latest = 2026-10-10`，多出的 82 局全部有日期）。兩者不能互比。
   → 建議兩道關卡：
   - **(a) 固定資料關卡（CI 每次跑）**：快照 → Python `build_cache`（`AVALON_STATS_AS_OF` 固定，例如 2026-02-28；用 2026-10-14 的話快照裡沒人「近 90 天有出賽」，排行榜整段是空的）→ 參考 JSON；同一份快照 → 每局資料集 → TS 引擎，兩者逐欄相等。`r9/inv/build4.py` 就是這個流程的雛形（輸出 `ref_schema4.json`：171 人；榜 main 10 / position 10 / overall 10 / improved 7 / assassin 10 / roleTitles 7，無 newcomers）。
   - **(b) 每日關卡**：產生器同一次執行寫出每局資料集 + 快取，TS(資料集) 必須等於快取裡「從局算出來」的區塊；不等就不寫檔（跟現有 shrink guard 同一層）。
3. **「分類空白 971」不是局。** 971 列是牌譜底部沒有 流水號 的空白列（全部在最後一局之後，中間沒有夾空列）。2146 局**每一局都有分類**：線瓦 1373 / 面瓦 627 / 娛樂 146。但 **Discord匯入 的局可能分類空白**：匯入程式只從論壇標籤取 線瓦 / 面瓦，兩個都沒有或兩個都有就寫空字串，也永遠不會是 娛樂（`discord_records_import.py` 第 831 行）。篩選要有「未分類」這一格。
4. **chemistry 的四個試算表矩陣（同贏 / 同輸 / 贏相關 / 同贏-同輸）不是從牌譜算的，而且已經過期。** 用「最終結算」規則（三藍死算紅勝）、大小寫折疊後的名字、只算牌譜前 1959 局（流水號 1..1959，最後日期 2025-08-13）去算，coWin 784 格中 775 格相符、coLose 784 格中 768 格相符；全部 2146 局去算只有 477 / 453 格相符；用任務階段規則則幾乎都不符。另外確認了 `贏相關[i][j] = round(同贏[i][j] / 同贏[i][i] × 100)`、`同贏-同輸[i][j] = round(同贏[i][j]/同贏[i][i]×100 − 同輸[i][j]/同輸[i][i]×100)`（784/784 格相符，整數 %）。
   → v1 無法對這四個矩陣做精確篩選。只有 `chemistry.outcomePair`（產生器從局算的）可以篩。是否改成「從局算的同贏 / 同輸」需要 Edward 決定，因為不篩選時數字也會和現在不同（多算了 2025-08-14 之後的局）。
5. **note 欄是自由文字。** 混了賽季（S1/S2/S3/S5）、地點、人名、紀錄者視角、更正標記、整句的事件描述（含代打者名字）。只能出「白名單解析後」的結構化標籤，原文不能進資料集。
6. **很多局沒寫齊 10 個名字。** 2146 局中 10 人全寫 1696 局、只寫 1 人 317 局、一個都沒寫 83 局、2–9 人 50 局。面瓦尤其多（627 局中只有 380 局寫齊）。「排除含某玩家的局」看不到沒寫名字的座位，介面要講清楚。
7. **Python 3.12 起 `sum()` 對浮點數改用補償加總（Neumaier）。** 產生器在 CI 用 3.11；`expectedFinalWinRate`、legacy `roleTheory` 是浮點數 `sum()`。TS 照 3.11 的逐項相加才會一致；若業主電腦用 ≥3.12 跑產生器，結果可能差最後一位、四捨五入後偶爾差 0.1。（理論勝率用 Fraction，不受影響。）

---

## 1. analysis_cache.json 各區塊：誰算的、用哪些每局輸入、v1 能不能篩

產生流程：`run()` → `merge_game_logs`（牌譜 + Discord匯入，Discord 的局 fingerprint / 流水號 重複就丟）→ `canonicalize_player_names`（大小寫 / 全半形折疊，顯示「最常用的寫法」）→ `drop_dates_after(as_of)`（未來日期當作沒日期）→ `build_cache` → `assemble_cache`（加 strength、搬舊區塊、刷新 featureStudies）。

共同的局範圍（TS 引擎要照抄，否則對不上）：
- **全部局**（`len(games)`，含 結果 不在三種內的局）：overview 的 totalGames / redWinRate / blueWinRate / merlinKillRate / outcomeBreakdown、seatPositionWinRates、missions、lake、rounds、seatOrder、captainAnalysis。
- **只算 結果 ∈ {三紅, 三藍死, 三藍活} 的局**：players / playerDetails、missionStage / assassinationStage / final、roleFinalWinRates、seatFinalWinRates、theory、leaderboard、outcomePair、seatOutcomes。
- **只算有寫名字的座位**：players 全部欄位、roleFinalWinRates / seatFinalWinRates（族群率！83 局零名字的局對它沒有貢獻），但 seatPositionWinRates 每個座位都算（不管有沒有名字）。
- 「勝」有兩套：任務階段（`red_win = 三紅`、`blue_win = 三藍死 或 三藍活`）用在所有舊欄位；最終結算（紅 = 三紅 + 三藍死、藍 = 三藍活，`is_final_win`）用在 final* / excess* / roleFinalWinRates / seatFinalWinRates / theory / leaderboard / 同贏同輸試算表。

| 區塊 / 欄位 | 計算函式 | 每局輸入 | v1 可篩？ |
|---|---|---|---|
| **overview** | `compute_overview(games, players)` | | 可 |
| totalGames, totalPlayers | 同上 | 局數、players 列數 | 可 |
| redWinRate, blueWinRate, merlinKillRate, outcomeBreakdown{threeRed,threeBlueAlive,threeBlueDead,+Pct} | 同上 | 結果（全部局，任務階段規則；merlinKillRate = 三藍死 / 三藍） | 可 |
| topPlayersByTheory[{name,roleTheory,winRate,games}] | 同上（legacy `roleTheory`，≥30 場，前 10） | players 列 | 可 |
| topPlayersByGames[{name,games,winRate,outcomes,redGames,blueGames}] | 同上 + `player_game_outcomes`（outcomes/redGames/blueGames 是 schema 4 才有） | players 列 | 可 |
| seatPositionWinRates[10]{seat,overallWinRate,totalGames,roles[{role,winRate,games,outcomes}],outcomes} | `compute_seat_position_win_rates` | 配置（座位→角色）、結果 | 可 |
| schemaVersion (=4) | 常數 | — | — |
| missionStage / assassinationStage / final | `compute_overview` | 結果（三種內的局） | 可 |
| roleFinalWinRates{7 角色} | `compute_role_final_win_rates` | 有名字的座位的角色、結果 | 可 |
| topPlayersByExcess | `compute_overview`（≥30 場、`shrunk_excess` K=20 排序；網站與機器人已不顯示） | players 列 | 可 |
| seatFinalWinRates{"1".."10"} | `compute_seat_final_win_rates` | 有名字的座位、角色、結果 | 可 |
| topPlayersByRoleTheory / ByPositionTheory / ByOverallTheory | `top_players_by_role_theory`（fullWindows）/ `_position_`（生涯 ≥ mainGames=100）/ `_overall_`（生涯 ≥ overallMinGames=250）；不看是否近期出賽 | players[].theory | 可 |
| theoryConfig | `theory_config()`（常數） | — | — |
| **players** {players[], total, seatOutcomesSource:"games"} | `compute_player_stats` → `_PlayerTally.to_row` + `player_theory`；`compute_seat_outcomes_per_player` | 每局每個有名字的座位：玩家（正規化名字）、座位、角色、結果、日期、合併後的牌譜順序 | 可 |
| 列欄位（每人）：name, totalGames, winRate, roleTheory(legacy), positionTheory(=0.0), redWin, blueWin, red3Red, redMerlinDead, redMerlinAlive, blue3Red, blueMerlinDead, blueMerlinAlive, roleWinRates{7}, roleDistribution{7}, redRoleRate, blueRoleRate, seatWinRates{1..9,0}, seatRedWinRates, seatBlueWinRates, rawRoleGames{7}, rawRedWins, rawBlueWins, rawTotalWins, rawRedGames, rawBlueGames, rawRed/BlueThreeRed/MerlinDead/MerlinAlive, roleSeatStats{"角色\|座號":{games,wins,winRate}}（首見順序）, finalWinRate, finalRedWinRate, finalBlueWinRate, missionWinRate, merlinSurvivalRate, rawBlueThreeBlue, roleFinalWinRates{7}, expectedFinalWinRate, excessWinRate, firstPlayed, lastPlayed, roleOutcomes{角色:{三紅,三藍死,三藍活}}（schema 4）, theory{roleWindows, last100, career}, seatOutcomes{seat:{threeRed..,Pct}} | 同上 | 同上 | 可 |
| theory.roleWindows{roleTheory, fullWindows, games, sparseRoles, from, to, roles{角色:{games,wins,window,rate}}} | `role_window_theory`（每角色自己最近 K_r 場：特殊角色 10、忠臣 40；不足 3 場用族群率補） | 時間序（`player_timelines`）、角色、結果、日期；族群率 = 本次的 roleFinalWinRates | 可 |
| theory.last100 / theory.career {window, games, roleTheory, positionTheory, finalWinRate, from, to, sparseRoles, sparseSeats} | `theory_window` | 同上 + 座位；族群率 = seatFinalWinRates | 可 |
| **playerDetails** {名字:{player:(列去掉 seatOutcomes), radar:(roleWinRates 副本，沒人讀)}} | `compute_player_details` | players 列 | 可 |
| **chemistry**.coWin / coLose / winCorr / coWinMinusLose {players, rowLabels, values} | `load_chemistry`（讀 同贏 / 同輸 / 贏相關 / 同贏-同輸 分頁）+ `canonicalize_chemistry`（只改名字） | **不是局**：試算表公式算好的配對彙總，28 人名單，停在約 2025-08-13（見 §0-4） | **不可**（v1） |
| **chemistry**.outcomePair {players,rowLabels,values(三紅%),threeBlueDeadPct,threeBlueAlivePct,games,source:"games"} | `compute_outcome_pair_matrix` | 名單 = coWin 的 28 人；每局兩人都有座位時的結果 | 可（名單仍取自試算表） |
| **missions** missionPassRates[{round,passRate,totalGames}], missionOutcomeByRound[{round,allPass,oneFail,twoFail(≥2),total}], missionOutcomeCorrelation[{round,passedGames,passedThenBlueWin,passedBlueWinRate,passedOutcomes,failedGames,failedThenRedWin,failedRedWinRate,failedOutcomes}] | `compute_missions` | 第N局成功失敗（`fails = 字串裡小寫 x 的個數`，`pass = fails == 0`——第 4 局 1 張失敗也算 fail）、結果 | 可 |
| **lake** perLake[{lake,totalGames,holderStats[{faction,games,redWinRate,outcomes}],comboStats[{holderFaction,targetFaction,...}]}], holderRoleStats / targetRoleStats（首湖）, allLakeRoleStats[{lake,holderRoleStats,targetRoleStats,sameFaction,diffFaction}] | `compute_lake` | 首湖 / 二湖 / 三湖 欄（`parse_lake`：去掉 x、以 > 切）、配置、結果 | 可 |
| **rounds** visionStats{merlinInTeam,merlinNotInTeam,percivalInTeam,percivalNotInTeam}, redInR11[], mission1Branch[2], roundProgression{第一局..第五局:{bluePct,redPct,total}}, gameStates[前 20] | `compute_rounds` | 1-1 欄（首隊座位）、第一局成功失敗、第一局..第五局 欄（紅/藍）、局勢 欄、結果 | 可 |
| **seatOrder** permutations[6]{order,total,三藍梅活,三藍梅死,三紅,+pct,穿插任務,redWinRate,blueWinRate,merlinKillRate,穿插率,穿插紅勝率,無穿插紅勝率}, totalGames, overallRedWinRate | `compute_seat_order` | 配置（派 / 梅 / 娜 的座位）、結果 | 可 |
| **captainAnalysis** perMission[{mission,redCaptainRate,blueCaptainRate,games}], captainFactionVsOutcome[{captainFaction,missionResult,count,percentage}], captainMissionGameWinRates[{...,outcomes}] | `compute_captain_analysis` + `_parse_captain_per_mission` | **文字記錄**（每個任務前最後一個提案行的第一個數字 = 隊長座位；湖行重置）、配置、第N局成功失敗、結果 | 可（資料集要帶解析好的隊長座位，不帶原文） |
| **leaderboard** {asOf, dates{parsed,unparsed,earliest,latest}, config{theoryWindows,+LEADERBOARD_CONFIG}, boards[main, position, overall, improved, assassin, newcomers, roleTitles]（空的榜不輸出）} | `compute_leaderboard(games, as_of, roleFinalWinRates, seatFinalWinRates)` | 時間序、角色、座位、結果、日期、as_of（誰近 90 天有出賽、新人期間） | 可（但「近期出賽 / 新人」在篩選後怎麼定義要決定，見 §6） |
| **strength** {perPlayer{名字:{roles[7]{role,winRate,sampleSize,zScore,color},topRoles,bottomRoles,hasData}}, cohort{perRole{mean,std,n},minRoleSample:3,rolesOrder}} | `scripts/build_archetype_strength.build_strength_section(players)`，每日重算 | 只用 players 列的 roleWinRates（任務階段）+ rawRoleGames | 原則上可（要把 `statistics.mean / pstdev` 與 `round(x,1)` / `round(x,2)` 照 Python 移植）；只有個人頁與機器人用，建議 v1 先不做 |
| **archetype** {perPlayer, cohort, axisLabels, axisHelp} | 業主電腦 `build_archetype_strength.py` 讀 `staging/selfplay/real_games_features_player_signatures.tsv`；每日只搬舊的 + 新玩家補 `hasData:false` 佔位列 | 不在 repo 的 TSV | **不可**（191 人中 116 人有資料） |
| **playstyle** {perPlayer, cohort, thresholds, labels} | 業主電腦 `build_panel_c_playstyle.py` 讀 `real_games_panel_c_playstyle.tsv`（Firestore 抽出）；每日只搬 + 佔位 | 不在 repo 的 TSV | **不可**（152/191 有資料） |
| **featureStudies** {generatedAt, sampleSize{games,lakeLinks,...}, features[L141,L142,L143,L136,L139]} | `refresh_feature_studies`：**L141**（湖中宣告可信度）每天從局重算（`compute_lake_claim_feature`，`parse_lake_claims` 讀文字記錄的湖行）；L142 / L143 / L136 / L139 數字是舊檔搬來的，只重寫結論文字 | L141：每局湖行（持湖座位、目標座位、宣告 o/x/無）、配置 | **L141 可**（資料集帶解析好的湖宣告）；其餘四個**不可** |

另外兩個「不在快取裡、但由快取再算」的統計：
- `GET /api/leaderboard/v3`（網站「排行」分頁下方的精算榜 `LeaderboardV3Table`）：`server/src/services/LeaderboardV3.ts` 用 players 列（roleSeatStats、raw* 計數、rawRoleGames）在 TS 現算 → 只要引擎產出 players 列，就能跟著篩。
- `GET /api/leaderboard`（`FirestoreLeaderboard.ts` 的 ELO，讀 legacy `roleTheory`、`totalGames`、`winRate`）→ 同上，但網站目前的「排行」頁不顯示它。

---

## 2. 每局欄位（解析後）與快照出現次數

快照 2146 局（= 有 流水號 的列；配置 全都是 6 碼，沒有被略過的列）。「GameRow」= `generate_cache.GameRow` 的屬性；沒有對應屬性的欄位目前產生器不讀。

| 欄位 | 來源欄 / 屬性 | 快照出現 | 值 / 說明 | 資料集 |
|---|---|---|---|---|
| 局 ID | 流水號 → `id` | 2146 | 牌譜 1..2146 純數字、無重複；Discord匯入 是 `D<post id>` | 出（也用來判斷來源） |
| 來源 | 牌譜 / Discord匯入（`merge_game_logs`） | 牌譜 2146、Discord 0 | 快照沒有 Discord匯入 分頁；live 的拆分 repo 裡看不到（每日 log 印「N from 牌譜 + M from Discord匯入」） | 出（`source` 欄） |
| 合併順序 | 牌譜列順序，然後 Discord匯入 | 2146 | `player_timelines` 的同日排序、無日期局的「繼承日期」都靠它 | 出（陣列順序或 `seq`） |
| 日期 | 日期時間 → `date`（`parse_game_date`） | 2083 有 / 63 無 | 原值全是 `YYYY/MM/DD`（沒有時間）；63 個 `1900/01/01` 佔位 = 無日期；範圍 2017-02-13 ～ 2026-02-27；392 個不同日期 | 出（drop_dates_after 之後的值） |
| 分類 | 分類 → `category` | 2146 | 線瓦 1373 / 面瓦 627 / 娛樂 146；Discord匯入 可空白 | 出 |
| 場次 | 場次（GameRow 沒讀） | 2146 | 當天第幾局，1..40（見 §3） | 出 |
| 頁碼 | 頁碼（沒讀） | 54 | 「1-381」「瓦1-5」之類的出處頁碼 | 不出（沒用途） |
| note | note（沒讀） | 767 | 自由文字，見 §3 | **原文不出**；只出白名單標籤 |
| 文字記錄 | 文字記錄 → `text_record` | 2146 | 原始牌譜文字（提案、異常票、任務、湖、偶爾貼上的名單） | **不出**；只出解析結果（下列幾項） |
| 配置 | 配置 → `config`、`seat_roles`（`decode_config`） | 2146 | 6 碼 = 刺 娜 德 奧 派 梅 的座位，其餘 4 座忠臣；固定 10 人 | 出 |
| 玩家 | 玩1..玩9、玩0 → `seat_players`（正規化 + 折疊成顯示名） | 每欄 1742–1766 | 每局有名字的座位數：10 人 1696、1 人 317、0 人 83、2–9 人 50；折疊後 171 人（27 個寫法併成 22 人；5 局同一人出現在兩個座位） | 出（用顯示名；可用名字表 + 索引） |
| 結果 | 結果 → `outcome`、`red_win`、`blue_win`、`merlin_killed` | 2146 | 三紅 971 / 三藍活 659 / 三藍死 516（沒有其他值） | 出 |
| 刺殺 | 刺殺 → `kill` | 1362 | 三藍局 1175 中 1148 有填；目標角色：梅林 513、忠臣 473、派西維爾 161、奧伯倫 1（資料錯）；**三紅局也有 214 局填了，其中 211 局填的是梅林座位**（不是刺殺） | 出（只在三藍局有意義） |
| 任務結果 | 第一局..第五局成功失敗 → `missions[{round,result,fails,total}]`、`round_results` | 2146 / 2146 / 2143 / 1291 / 688 | 局長度：2 局 3（紀錄不完整）、3 局 852、4 局 603、5 局 688；原值都是小寫 o/x | 出（原 o/x 字串即可，是結構化資料） |
| 每局紅藍 | 第一局..第五局 → `rounds` | 同上 | 紅 / 藍（第 4 局要 2 張失敗才紅） | 出（或由任務結果推） |
| 局勢 | 局勢 → `game_state` | 2146 | 27 種，前幾名：紅紅紅 629、紅紅藍藍藍 243、紅藍藍藍 233、藍藍藍 214、藍紅藍藍 208 | 出 |
| 首隊 | 1-1 → `r11_seats` 等 | 2146 | 全是 3 人隊；紅方人數 0:444 / 1:1029 / 2:606 / 3:67；含梅林 566、含派西 692 | 出 |
| 派5 / 派0 / 外灑 | 同名欄（沒讀；= 由 1-1 推出） | 3117（含空白列都有值） | 局中：派5 Y 308、派0 Y 175、外灑 Y 271 | 不必出（可由首隊推） |
| 湖 | 首湖 / 二湖 / 三湖 → `lake1..3`（`parse_lake`）+ 持湖 / 目標的陣營、角色 | 2146 / 1277 / 650 | 每局湖數 1:869 / 2:627 / 3:650；首湖全部有（live 快取 2228 局有 2227 局有首湖）；目標陣營缺 1 / 2 / 4（格式怪） | 出（Python 解析後的持湖座位、目標座位） |
| 湖玩家角色 | 首湖玩家 / 二湖玩家 / 三湖玩家（沒讀；由首湖、二湖推） | 2146 / 2146 / 1277 | 角色簡寫 | 不必出 |
| 湖宣告 | 文字記錄的湖行 → `parse_lake_claims`（featureStudies L141） | 2146 局、4073 條湖行（宣告藍 2993 / 紅 997 / 未宣告 83） | 每條 (持湖座位, 目標座位, 紅/藍/空) | 出（解析後三元組） |
| 隊長 | 文字記錄 → `_parse_captain_per_mission` | 2146 局、8411 個任務找到隊長、4 個找不到 | 每個任務的隊長座位 | 出（解析後座位陣列） |
| 提案與投票 | 文字記錄 → 嚴格解析 `server/src/ai/benchmark/sheetsReplay.ts::parseReplayGame`（產生器沒有） | 1970/2146 局可完整重播；29953 個提案、其中 4613 個第五次強制出發、24649 個票可信（`votesReliable`）；1945 局有異常票標記；1460 局所有非強制提案的票都可信 | 每個提案：輪、第幾次、隊長、隊伍、+/- 異常票、是否出任務 | v1 可不出；要出就由 Python 移植嚴格解析或由 TS 解析後只存結構（不存原文） |
| 角1 / 角4 / 角5 / 角0 | 同名欄（沒讀；= 由配置推） | 2146 | 該座位的角色簡寫 | 不必出 |
| 組成 | 組成（沒讀） | 2016 | 10 個名字大寫、逗號連接（= 玩1..玩0） | 不出（重複且是名字） |
| 強人 / 戳人 | 同名欄（沒讀；試算表公式） | 2016 | 強人 0..9、戳人 0..6、各 1 個 `#REF!`；意義不明（舊報告猜是「關鍵玩家座位 / 揭示次數」，沒有定義來源） | 不出（除非 Edward 說明定義） |
| discord_*、匯入時間、更新時間 | 只有 Discord匯入 有 | 快照 0 | discord_title 是自由文字 | 不出（更新時間只給 shrink guard 用） |

快照各分類的交叉計數（篩選後的樣本有多小）：

| | 局 | 有日期 | 10 人全寫 | 三紅 / 三藍死 / 三藍活 | 有 note |
|---|---|---|---|---|---|
| 線瓦 | 1373 | 1333 | 1178 | 644 / 324 / 405 | 405 |
| 面瓦 | 627 | 604 | 380 | 254 / 161 / 212 | 355 |
| 娛樂 | 146 | 146 | 138 | 73 / 31 / 42 | 7 |

各年：線瓦 2020:8 / 2022:86 / 2023:366 / 2024:571 / 2025:302 / 無日期 40；面瓦 2017:2 / 2020:5 / 2022:191 / 2023:210 / 2024:111 / 2025:62 / 2026:23 / 無日期 23；娛樂 2022:1 / 2024:120 / 2025:25。

資料集大小估計（2146 局；名字表 + 每局：id、日期、分類、配置、結果、刺殺、10 個名字索引、任務字串、局勢、首隊、湖、湖宣告、隊長）：約 526 KB，gzip 約 70 KB。加上提案 / 投票大約再加一倍。

---

## 3. 資料撐得起的篩選維度與分布（只列計數）

### 3.1 局層級（AND 組合）

| 維度 | 值與局數（快照 2146 局） | 備註 |
|---|---|---|
| 分類 | 線瓦 1373 / 面瓦 627 / 娛樂 146 /（Discord 可能有）未分類 | Edward 指定的基本款 |
| 日期區間 | 2083 有日期（2017-02-13 ～ 2026-02-27），63 無日期；各年 2017:2 / 2020:13 / 2022:278 / 2023:576 / 2024:802 / 2025:389 / 2026:23 | 要有「無日期的局要不要算」選項 |
| 星期 | 一 164 / 二 214 / 三 201 / 四 193 / 五 444 / 六 551 / 日 316（只算有日期） | 由日期推 |
| 場次（當天第幾局） | 1:424 / 2–3:648 / 4–6:575 / 7–10:263 / 11–20:199 / 21+:37（最大 40） | 例如「只看每晚前 3 局」 |
| 賽季（note） | S1 22（2023-08-16～09-28）/ S2 283（2023-10-31～12-26）/ S3 20（2024-01-04～01-29）/ S5 5（2024-11-29～12-20）；沒有 S4；全是線瓦 | 阿瓦隆百科主辦的比賽（`data/sheets_export` 有 S1 新人挑戰賽、S2 無差別亂鬥、S5 歲末健檢日的規則頁） |
| 地點（note） | 古亭 123、古亭週五 6、九號 42 + 9號 5、台中 26、東門 22、小巨蛋 21、Discopia星球 18（線瓦）、台中家 13、學餐 10、新竹謎寶 9、不鳥谷 7、政大 4；另有 Discopia星球 + 事件描述 4 筆 | 除 Discopia星球 外都是面瓦；「九號」「9號」要合併 |
| 紀錄者視角 / 品質（note） | 我旁觀 15、旁觀 5、不是我打的 2、覆盤局 3、爛局 1 | 可做「排除旁觀 / 爛局」 |
| 更正標記（note） | 「[2025/8/14 update]湖女」7（2023-12-16～2025-08-13 的局，是事後更正湖資料的標記，不是規則版本），另有 1 筆與地點連寫 | 可忽略或當旗標 |
| 來源 | 牌譜 2146 / Discord匯入 0（快照） | live 有多少 Discord 局 repo 看不到 |
| 結果 | 三紅 971 / 三藍死 516 / 三藍活 659 | |
| 局長度（任務數） | 3:852 / 4:603 / 5:688 /（2:3 不完整） | |
| 局勢 | 27 種 | 下拉選或「第 N 局紅 / 藍」 |
| 第 N 局成功 / 失敗、失敗張數 | 第 1 局：ooo 885 / oox 1125 / oxx 131 / 其他 5；第 4 局：5 張全成功 853、1 失敗 240 … | |
| 首隊（1-1） | 紅方人數 0/1/2/3 = 444/1029/606/67；含梅林 566；含派西 692；外灑 271；派5 308；派0 175 | |
| 湖 | 湖數 1/2/3 = 869/627/650；每湖持湖者陣營 / 角色、目標陣營 / 角色、同陣營 / 異陣營；宣告紅 / 藍 / 未宣告 | 「有沒有湖」在快照裡沒有差別（全有） |
| 刺殺 | 三藍局 1175：刺中梅林 513（= 三藍死）、刺忠臣 473、刺派西 161、刺奧伯倫 1 | 只在三藍局有意義 |
| 角色座位 | 梅林座位 1..10 = 208/211/206/227/226/243/196/218/212/199；其他特殊角色同理 | 由配置推 |
| 派 / 梅 / 娜 順序 | 梅娜派 382 / 梅派娜 377 / 娜梅派 361 / 派娜梅 359 / 派梅娜 357 / 娜派梅 310 | seatOrder 的分組 |
| 隊長陣營（某任務） | 8411 個任務有隊長 | |
| 名字完整度 | 10 人全寫 1696 / 部分 367 / 零 83 | 建議做「只看 10 人全寫的局」 |
| 提案 / 投票（若出） | 1970 局可重播；有異常票 1945 局；強制出發 4613 次 | v2 |

### 3.2 玩家層級

| 條件 | 說明 |
|---|---|
| 包含 / 排除指定玩家 | 有名字的座位才看得到（§0-6） |
| 含某玩家的局，且他是某角色 / 某座位 / 紅或藍 / 贏或輸 | 每局座位 → 角色 → 陣營，皆可推 |
| 兩人同局 / 同隊 / 不同隊 | 由座位與配置推 |
| 依玩家指標排除（Edward 指定） | 模式 (a) 丟掉含此人的局、(b) 局留著但名單 / 榜上不顯示此人；指標預設看**未篩選**的值（= 快取現成值），可選「看篩選後的值」 |

可用的玩家指標與「有資格算 PR 的人」（快照重建的 schema 4，171 人；live 快取 191 人）：

| 指標 | 快取欄位 | 有資格的人（PR 的母體） | 分布（有資格者） |
|---|---|---|---|
| 角色理論 | `theory.roleWindows.roleTheory`；資格 `fullWindows`（六個特殊角色各 ≥10 場、忠臣 ≥40 場） | 35 | 最小 34.0 / P25 41.0 / 中位 44.0 / P75 48.0 / P90 51.0 / 最大 56.0；只有 17 種不同值、最多 5 人同值 |
| 位置理論 | `theory.last100.positionTheory`；資格 生涯 ≥ mainGames(100) | 41 | 35.8 / 41.7 / 45.2 / 47.6 / 52.9 / 61.2 |
| 整體理論 | `theory.career.roleTheory`；資格 生涯 ≥ overallMinGames(250) | 24 | 40.4 / 44.3 / 46.0 / 47.1 / 48.2 / 54.2 |
| 最終勝率 | `finalWinRate`（≥30 場） | 62 | 35.3 / 41.7 / 45.6 / 47.7 / 50.5 / 58.2 |
| 生涯場數 | `totalGames` | 171 | 1 / 4 / 15 / 95 / 359 / 1084 |
| 其他可用 | excessWinRate、merlinSurvivalRate、各角色 / 各座位勝率、刺客刺中率（assassin 榜的定義）、firstPlayed / lastPlayed（新人 / 近期出賽） | | |

- 沒資格的人（例如角色窗沒打滿）也有數字（不足的格子用族群率補），若讓他們參加「> X」的比較會被補值拉向平均。建議：數值比較預設也只對有資格的人生效，沒資格的人「不被排除」或「一律排除」由使用者選。
- PR 的同分處理：角色理論值很粗（35 人只有 17 種值），PR 要定義同分規則。repo 裡已經有一個定義可沿用：`build_archetype_strength.percentile_rank` =（比他低的人數 + 0.5 × 同分人數）/ 母體 × 100，`round(…, 1)`。
- 分類子集的資格人數（同一套規則在子集上重算，as_of 2026-02-28）：

| 子集 | 局 | 玩家 | fullWindows | ≥100 場 | ≥250 場 | 有內容的榜 |
|---|---|---|---|---|---|---|
| 全部 | 2146 | 171 | 35 | 41 | 24 | main 10 / position 10 / overall 10 / improved 7 / assassin 10 / roleTitles 7 |
| 線瓦 | 1373 | 118 | 27 | 35 | 16 | main 10 / position 10 / overall 10 / improved 5 / assassin 10 / roleTitles 7 |
| 面瓦 | 627 | 61 | 10 | 13 | 5 | main 8 / position 10 / overall 4 / improved 3 / assassin 8 / roleTitles 7 |
| 娛樂 | 146 | 87 | 0 | 1 | 0 | position 1 / roleTitles 1 |
| 排除娛樂 | 2000 | 146 | 32 | 39 | 23 | main 10 / position 10 / overall 10 / improved 6 / assassin 10 / roleTitles 7 |

（Python 跑一次 players + leaderboard：全部 0.41 s；TS 在瀏覽器應同一量級。）

### 3.3 note 欄的值（61 種非空值，767 局有值；1379 局空白）

| 類別 | 值（局數） |
|---|---|
| 賽季（4 種、330 局） | S2 283、S1 22、S3 20、S5 5 |
| 地點（13 種、306 局） | 古亭 123、九號 42、台中 26、東門 22、小巨蛋 21、Discopia星球 18、台中家 13、學餐 10、新竹謎寶 9、不鳥谷 7、古亭週五 6、9號 5、政大 4 |
| 紀錄者視角 / 品質（5 種、26 局） | 我旁觀 15、旁觀 5、覆盤局 3、不是我打的 2、爛局 1 |
| 更正標記 | [2025/8/14 update]湖女 7 |
| **像人名（標記，原值不寫）** | 〔人名1〕26、〔人名1〕線瓦 6、〔人名1〕那邊 4、〔人名2〕9、〔人名3〕私揪 9、〔人名4〕家 7（玩家名 + 家，地點以人命名）、感覺是〔人名5〕4、〔人名5〕? 1、沒〔人名6〕2（疑似）、跟〔人名7〕視角 1 —— 10 種、69 局 |
| 地點 + 事件 | Discopia星球[…]梅林踩拇指 類 3 種、4 局（其中 1 種還連寫了更正標記） |
| 事件描述（自由文字，多數含座位、部分含代打者名字） | 25 種、25 局（例：「[1-1]派西踩拇指」「[3-2]9家改為〔人名〕代打。」「三壞進車送三藍」） |

→ 建議產生器只輸出 `season ∈ {S1,S2,S3,S5}`、`venue ∈ 白名單（含「九號 = 9號」「古亭週五 → 古亭」的對照）`、`flags ⊂ {spectated, notPlayedByRecorder, review, badGame, lakeCorrected, substitution, thumbIncident}` 這類固定字彙；其他一律丟掉。人名類（含「〔人名4〕家」這種以人命名的地點）不出，或由 Edward 決定改成中性地點代號。

---

## 4. 誰讀哪個區塊

### 4.1 網站（packages/web）

| 位置 | 元件 | API → 區塊 / 欄位 |
|---|---|---|
| 統計頁 › 排行 | `tabs/BoardsTab` → `LeaderboardBoards` | `/api/analysis/leaderboard` → leaderboard（asOf、dates、config、boards[].rows 全欄；`CARD_ORDER` 還寫著 last50） |
| 統計頁 › 排行 | `tabs/BoardsTab` → `LeaderboardV3Table` | `/api/leaderboard/v3`（`LeaderboardV3.ts`，由 players 列現算）+ `/api/leaderboard/v2`（Firestore，不是快取） |
| 統計頁 › 分析 › 總覽 | `OverviewPanel`（`useAnalysisOverview`） | overview：totalGames、totalPlayers、outcomeBreakdown、roleFinalWinRates、theoryConfig、topPlayersByGames、topPlayersByRoleTheory |
| 分析 › 派隊 | `CaptainAnalysis` | captainAnalysis 全部 |
| 分析 › 派隊 | `RoundsAnalysis` | rounds：visionStats、redInR11、mission1Branch、roundProgression、gameStates |
| 分析 › 派隊 | `FeatureStudyCard L139` | featureStudies（搬來的，不可篩） |
| 分析 › 投票 | `FeatureStudyCard L136` | featureStudies（搬來的，不可篩）——投票分頁目前沒有任何可篩的內容 |
| 分析 › 任務 | `MissionAnalysis` | missions 全部 |
| 分析 › 湖中女神 | `LakeAnalysis` | lake.perLake、lake.allLakeRoleStats |
| 分析 › 湖中女神 | `FeatureStudyCard L141`（可篩）、`L142`（不可） | featureStudies |
| 分析 › 刺殺 | `AssassinationCard` | overview.assassinationStage、merlinKillRate |
| 分析 › 刺殺 | `FeatureStudyCard L143` | featureStudies（不可篩） |
| 分析 › 位置 | `SeatHeatmap` | `/api/analysis/players` → players[].seatWinRates / seatRedWinRates / seatBlueWinRates / seatOutcomes、totalGames |
| 分析 › 位置 | `SeatPositionChart` | overview.seatPositionWinRates |
| 分析 › 位置 | `SeatOrderAnalysis` | seatOrder 全部 |
| 分析 › 角色 | `RoleFinalWinRates` | overview.roleFinalWinRates、theoryConfig |
| 分析 › 角色 | `ChemistryMatrix` | chemistry 五個矩陣（outcomePair 只在 `source:"games"` 時顯示）+ overview.theoryConfig |
| 分析 › 玩家 | `PlayerRadarChart` | `/api/analysis/players`（名單）+ `/api/analysis/players/:name`（player 列 + **伺服器端組的 radar**：`routes/analysis.ts` 用 `playerOutcomeBlocks`、`assassinationWinRates`、theory.career）+ overview.roleFinalWinRates、theoryConfig |
| 個人頁 / 我的戰績 | `ArchetypeRadar`、`StrengthSignature`、`PlaystyleSnapshot`（`ProfilePage`、`PersonalStatsPage`） | `/api/analysis/profile/:name/{archetype,strength,playstyle}` |

沒有人讀：`playerDetails[].radar`（路由自己組 radar）；網站沒讀 `overview.topPlayersByTheory / topPlayersByExcess / topPlayersByPositionTheory / topPlayersByOverallTheory`（後兩個任務 U 可能會加；機器人只在 main 榜缺席時讀 topPlayersByRoleTheory）。`compute_missions` 裡的 `mission_by_composition` 是算了沒輸出的 dead code。

注意：radar（任務結果 / 刺殺結果 / 遊戲結果三塊、刺殺率）現在在**伺服器**組（`server/src/services/sheetsAnalysis.ts` 的 `assassinationWinRates`、shared 的 `playerOutcomeBlocks`）；瀏覽器端引擎要能在篩選後重組 radar，這段要搬到 shared。

### 4.2 機器人（Discord slash、LINE 文字指令、每週摘要）

都經 `server/src/bots/stats/statsQueries.ts` → `services/sheetsAnalysis.ts` 的存取函式，格式在 `statsReplies.ts`。

| 回覆 | 讀的區塊 / 欄位 |
|---|---|
| `/戰績 名字` (`playerCardReply`) | players（名單比對）+ playerDetails[name].player（`withFinalFields`）：winRate、finalWinRate、finalRed/BlueWinRate、missionWinRate、merlinSurvivalRate、raw 三結果計數、red/blueMerlinDead/Alive、theory.roleWindows、theory.career{roleTheory, positionTheory, finalWinRate, games}；archetype、strength、playstyle；leaderboard.config.theoryMinCellGames、newcomers 榜名次 |
| `/排行` (`leaderboardReply`) | leaderboard 的 main 榜；沒有時退回 overview.topPlayersByRoleTheory + theoryConfig / schemaVersion |
| 每週摘要 (`weeklyDigestText`) | 同上 + improved（前 5）、roleTitles、newcomers 榜 |
| `/默契 A B` (`chemistryReply`) | chemistry.coWin / coLose（**試算表矩陣**；同隊 = 同贏 + 同輸）+ players 的 winRate |
| `/help`、`/指令` 的窗口說明 (`leaderboardScopeText`) | leaderboard.config、overview.theoryConfig |

伺服器其他讀者：`/api/leaderboard`（ELO，legacy roleTheory）、`/api/leaderboard/v3`、`healthDeep`（不讀內容）。

---

## 5. TS 引擎要和 Python 完全一致的要點

1. **rnd1 = `round(n * 10) / 10`，Python 的 float 四捨六入五成雙。** 已有正確的 TS 版本：`server/src/services/sheetsAnalysis.ts::rnd1`（`frac === 0.5` 取偶）。運算順序也要照抄：`count / total * 100`（不是 `count * 100 / total`）、`shrunk_excess` 是 `excess * games / (games + K)`、`merlinKillRate` 是 `kills / (kills + (blue - kills)) * 100`、進步榜 `rnd1(now - before)` 是兩個一位小數相減。
2. **理論勝率用精確分數**（`fractions.Fraction`）：`_cell_rate` = `Fraction(100·wins, games)` 或補值 `(100·wins + (m − n)·pop) / m`，其中 `pop = Fraction(str(族群率))`（一位小數 → 整數十分之一）；總和 Σ（十分之 w_r）× cell 後只四捨五入一次（`_round_exact`：分數上的五成雙）。TS 要用 BigInt 分數或公分母整數，不能用浮點。
3. **浮點 `sum()` 逐項相加**（Python 3.11 行為，見 §0-7）：`expectedFinalWinRate = rnd1(Σ_r rawRoleGames[r] × roleFinalWinRates[r] / total)`（ALL_ROLES 順序）、legacy `roleTheory = rnd1(Σ roleDistribution × roleWinRates / 100)`。
4. **排序與同分**：Python `sorted` 穩定，JS `sort` 也穩定（ES2019+），但鍵要完全一樣：players `-totalGames`（同分按首次出現）、`_ranked` `(-value, -games, -careerGames, name)`、overview 理論排名 `(-value, -careerGames, name)`、角色王 `(-rate, -games, -careerRoleGames, name)`、gameStates 按局數（同分按首見）取前 20、redInR11 按 redCount、captain 的 `sorted(items)`（紅方 < 藍方、fail < pass）。**名字比較是 Python 的碼位順序**；JS `<` 比的是 UTF-16 單元，名字有擴充區字或 emoji 時會不同 → 用碼位比較。
5. **物件鍵順序**：Python dict 按插入；JS 物件的「像整數的鍵」會排到最前面並按數字排序——`seatWinRates / seatRed/BlueWinRates / seatOutcomes` 的鍵是 `"1".."9","0"`，JS 物件會變成 `"0"` 在前。比對用語意相等（解析後比），不要比位元組；要輸出同順序就用 Map。lake 的 holderStats / comboStats / holderRoleStats、roleSeatStats 的順序 = 遍歷局時首次遇到的順序。
6. **數字型別**：Python 寫 `1080.0`、JS 寫 `1080`；`0` 與 `0.0` 混用（例如 overallWinRate 無局時是 int 0）。比對時當數字比。
7. **不要在篩選後的子集上重算的東西**（建議由產生器算好放進資料集）：
   - 顯示名（`canonicalize_player_names` 取「全部局最常用的寫法」）——在子集上重算名字會跟著篩選變。
   - 時間序鍵：`player_timelines` 對無日期局用「牌譜中上一個有日期的局」的日期；若在子集上重算，上一局被篩掉時排序會變。建議資料集帶每局的 `(有效日期, 合併順序)`。
   - 解析結果：`parse_lake` / `count_mission_fails`（只數小寫 x）/ `_parse_captain_per_mission` / `parse_lake_claims` 的輸出，直接帶 Python 的結果，TS 不重新解析。
8. **as_of**：排行榜、featureStudies 依 as_of；資料集本身不要放 as_of（否則每天都會變、破壞 `only_the_day_changed` 的「只有日子變就不寫檔」），as_of 從快取的 `leaderboard.asOf` 取。
9. **strength 若要做**：`statistics.mean / pstdev`（3.11 內部用精確分數）+ `round(x, 1)` / `round(x, 2)`（Python 對十進位展開做五成雙；JS `toFixed` 在剛好一半時往遠離零的方向進位）——需要專門移植。建議 v1 不做。
10. **公開 log**：Actions 下產生器只印計數；資料集寫檔、比對失敗訊息也只能印計數 / 欄位路徑，不印名字。

---

## 6. 待 Edward / GM 決定

1. 試算表默契矩陣（同贏 / 同輸 / 贏相關 / 同贏-同輸）：篩選時 (a) 只顯示 outcomePair、四個舊矩陣在有篩選時隱藏，還是 (b) 改成「從局算」（最終結算規則、同樣公式），讓不篩選時的數字也更新到最新（和現在顯示的不同，等於修掉 2025-08-13 之後沒更新的問題）？機器人 `/默契` 讀的也是這兩個矩陣。
2. 篩選後的「近 90 天有出賽」「新人（首局在近 90 天）」「生涯場數門檻」：看篩選後的局，還是看全部的局？（例如篩「面瓦」時，一個近期只打線瓦的人算不算 active。）
3. 玩家指標條件的 PR 母體：只在「有資格的人」中排（角色理論 35 人、位置理論 41 人、整體理論 24 人），沒資格的人預設「不排除」還是「排除」？同分規則用 `(低於 + 0.5 × 同分) / n`？
4. 名字不全的局（零名字 83 局、只寫 1 人 317 局）：「排除含某玩家的局」時要不要一併排除名字不全的局（選項），還是只在說明裡提醒？
5. note：白名單字彙與人名類（含以人命名的地點）怎麼處理；「九號 / 9號」「古亭 / 古亭週五」要不要合併。
6. 強人 / 戳人：要不要當篩選條件（需要 Edward 給定義），否則不出。
7. 提案 / 投票層級的篩選（例如「首輪有人投異常票的局」）要不要進 v1；要的話資料集多一倍大，且只有 1970 / 2146 局能嚴格重播。
8. 「刺殺」欄在三紅局也有值（214 局，211 局是梅林座位）：資料集只在三藍局帶刺殺目標，還是照原樣？
