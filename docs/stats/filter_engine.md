# 複合篩選引擎與資料集

依 r9 架構實作：每日 Python 產生解析後的每局資料集，TypeScript 從篩選後的局清單重算。舊 `winRate`、`roleWinRates`、`seat*WinRates` 繼續採任務結算；`final*` 與理論勝率繼續採最終結算。

## 資料生命週期

`generate_cache.py` 在相同下載、去重、名字正規化與日期檢查後，同時準備 `analysis_cache.json` 和 `games_cache.json`。後者預設與 `--output` 同目錄，也可用 `--games-output` 指定。`overview.gamesKey` 等於資料集 `key`，用來識別同一批資料。

既有防止局數減少的守門繼續有效；守門失敗時兩檔都不寫。資料集的隱私形狀或編碼往返比對失敗時，分析快取照常更新，資料集停寫；工作流程先提交快取，最後報錯。網站會停用篩選，直到下一次成功重建兩檔。寫檔先寫資料集再寫快取；途中失敗時批次鍵不符，也不會顯示錯批的篩選結果。

首次合併不提交較舊的 2,146 局快照去取代正式資料。每日更新會第一次產生並提交配對檔案；首次更新前既有分析照常使用，篩選端點回傳 503。Docker 可在沒有資料集的情況啟動。

## 資料集版本 2

頂層包含 `format`、`version`、`key`、`cacheSchemaVersion`、`config`、`constants`、`counts`、`vocab`、`players`、`aliases`、`fields`、`games`。名字只在玩家索引表及別名映射，對局以索引引用。批次鍵是排除 `key` 後、固定鍵順序 JSON 的 SHA-256 前 16 碼。

每局陣列依 `fields` 順序儲存：

| 欄位 | 意義與限制 |
|---|---|
| `id`、`src` | 純數字流水號；非數字及 Discord 識別值雜湊。來源為牌譜或 Discord 匯入 |
| `date`、`cat`、`slot` | ISO 日期或空白、分類白名單索引、當日第幾場 |
| `note` | 僅賽季、地點與固定旗標索引；不保存 note 原文或聊天 |
| `config`、`outcome`、`kill` | 角色配置、結果索引、三藍局刺殺座位；三紅局的刺殺欄清空 |
| `seats` | 十個座位的玩家索引；-1 表示缺名字 |
| `missions`、`rounds`、`state` | 各任務出牌、回合紅藍結果及局勢，均限定字元 |
| `firstTeam`、`lakes`、`claims`、`captains` | 首隊、三條湖鏈、湖宣告及任務隊長座位 |
| `votes` | `[回合, 提議次數, 隊伍座位, 贊成座位]`；最多 25 筆，第 5 次的贊成座位固定空白 |

版本 1 沒有 `votes`，不能重算新投票指標，因此引擎只接受版本 2。提案解析沿用 `voting_stats.py` 的完整回合檢查：不完整或不合法的回合不產生票，強制第 5 提議不計分子或分母。任務隊伍座位包含在已解析提案內。

63 局缺日期的固定快照用來驗證：篩選日期預設排除缺日期，勾選包含時保留。角色與位置時間窗的排序日期先在全部對局上固定，篩選不讓缺日期的對局移位。

## 計算與篩選

入口為 `@avalon/shared/stats` 的 `decodeGamesDataset` 與 `computeStats`。精確分數採 BigInt，所有捨入與浮點加總順序對齊 Python 3.11；無容差比對，差 0.1 也算失敗。

1. 局條件以 AND 組合，同一清單內以 OR 組合；可逐條反轉。
2. 玩家條件預設在全部對局評估；選擇 `filtered` 時，在局條件之後、任何玩家丟局之前評估一次。各條玩家條件共用同一評估集，不循環重算。
3. `dropGames` 丟掉包含被選玩家的整局；可同時排除名字未填齊的局。`hideFromLists` 保留全部對局與數字，只移除玩家名單、榜單、默契軸與配對，排行依序補滿。
4. PR = `(2 × 低於人數 + 同分人數) / (2 × 有資格人數) × 100`，同分包含自己，以精確分數五成雙至一位小數。角色理論須各角色視窗全滿；最低場數不能放寬此條件。其他指標依其門檻選母體。
5. 預設基準日為快取基準日與日期上界中的較早日期。活躍資格可依篩選後、全部對局，或不要求活躍；不要求活躍時不出新人榜。

支援分類、來源、日期、星期、當日場次、賽季、地點、note 旗標、具名座位數、結果、最終勝方、任務數／失敗張數、局勢、首隊角色組成、有無湖與湖鏈條件、刺殺目標、角色座位、三角順序、隊長陣營、局識別值、指定玩家與兩人同／異陣營。玩家指標完整清單見 `filter/types.ts`。

URL 使用 `#stats?f=1.<base64url>`，亦可保存預設組名稱。解碼會檢查版本、未知條件與值；未知玩家只停用該條件並警告，不默默變成零局。別名依 `playerNameKey` 與 `players.aliases` 解析。

## 默契分母與試算表的關係

| 區塊 | 分母與計數 |
|---|---|
| `pairs.outcomePair` | 兩人共同出賽且結果為三紅／三藍死／三藍活的局數；不論陣營。每人每局只算一次；對角線為空 |
| `pairs.sameFaction[].sharedGames` | 同上，兩人共同出賽的有效結果局數 |
| `sameFactionGames` | 兩人確定同屬紅方或同屬藍方的局數；同名跨陣營重複佔位時不納入 |
| `missionWins`／`missionLosses` | 在上述同陣營對局，依任務結算的勝敗；三藍死對藍方算勝 |
| `finalWins`／`finalLosses` | 在上述同陣營對局，依最終結算的勝敗；三藍死對紅方算勝 |

兩種勝率均以 `sameFactionGames` 為分母，分母零則為 `null`。這裡「同隊」指同陣營，不是某次任務一起上隊。

`outcomePair` 沿用試算表 `coWin` 的橫軸與 `rowLabels` 順序，數字完全由對局計算，與 Python 快取逐欄相同。試算表四張舊矩陣 `coWin`、`coLose`、`winCorr`、`coWinMinusLose` 的完整公式不在牌譜內，不能聲稱由新配對數字重現。無篩選保留既有顯示；改變對局後隱藏四張舊矩陣，顯示重算的三結果與同陣營勝負。

## 端點與一致性門檻

`GET /api/analysis/games` 回傳 `{dataset, context}`。`context` 提供快取基準日、別名、默契名單、門檻與未篩選計數。首次讀取會逐欄比較所有可重算區塊；不符回傳 503。成功回應預先產生 gzip／Brotli，附 ETag，支援 304。公開日誌不輸出玩家或差異值。

本機可設定 `AVALON_ANALYSIS_CACHE`、`AVALON_GAMES_DATASET` 指向配對暫存檔。`AVALON_STATS_ENGINE_CHECK=off` 僅供本機診斷，交付驗證不可用它繞過一致性檢查。

`archetype`、舊 `playstyle`、`strength` 與 L141 以外的特徵研究沒有相應引擎，介面須標示「此區塊不隨篩選變動」。新 `players[].voting`、L141、所有對局統計與理論排行均可重算。Gemini 的特徵研究每日更新不等於本引擎支援任意條件重算。

## 重現驗證

固定日期及虛構資料的測試可直接執行伺服器測試。完整快照參考答案僅寫暫存目錄：

```bash
set -euo pipefail
parity_dir="$(mktemp -d)"
trap 'rm -rf -- "$parity_dir"' EXIT
python3.11 packages/server/scripts/build_stats_parity_fixtures.py --source snapshot --out "$parity_dir"
python3.11 packages/server/scripts/build_mission_parity_fixture.py --source snapshot --out "$parity_dir"
python3.11 packages/server/scripts/build_lake_parity_fixture.py --source snapshot --out "$parity_dir"
AVALON_STATS_PARITY_DIR="$parity_dir" pnpm --filter @avalon/server test
python3.11 packages/server/scripts/audit_stats_compound_filters.py --out "$parity_dir/audit.json"
node --import tsx packages/server/scripts/statsBenchmark.ts "$parity_dir" "$parity_dir/audit.json"
```

獨立驗算只共用原始牌譜解析與名字正規化；篩選、PR、局數、三結果、最終紅勝與名單人數另行逐局計數，不呼叫 TS 引擎或 Python 參考篩選器。完整測試結果與效能見交接報告。
