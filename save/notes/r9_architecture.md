# 複合篩選 — 架構設計（r9 architecture）

- 日期：2026-10-14；唯讀設計，依據 `r9/inventory.md`（下稱「盤點」）與 `r6/base`（1ec510f）的程式碼。
- 業主需求（Edward 2026-10-14）：「我希望所有數據都有可以複合篩選的功能 最基本的是 比如 線瓦/面瓦、娛樂局、排除某些條件玩家（角色理論勝率/位置理論勝率/整體理論勝率 大於 小於 PR XX）之類的 包含但不限於以上的條件 能的話盡可能客製化」。
- GM 已定方向：每日產生「有名字、沒有文字」的每局資料集；`packages/shared` 的 TypeScript 引擎從篩選後的局重算每個區塊；不篩選時引擎必須與 Python 快取逐欄相同；預設畫面照舊讀快取，有篩選才跑引擎（瀏覽器 Web Worker）。
- 本文件只寫計數與虛構名字（玩家甲、玩家乙）；量測腳本在 `r9/arch/`（`proto_size.py` 資料集大小與 Python 計時、`bench_theory.mjs` BigInt 精確理論勝率計時）。

---

## 0. 決策一覽

| # | 決策 | 理由 |
|---|---|---|
| 1 | 新檔 `packages/server/games_cache.json`，`generate_cache.py` 同一次執行寫出，與 `analysis_cache.json` **「同寫或同不寫」**，一起 commit | 兩檔永遠同源；部署（Render 看 `packages/server/**`）一起生效 |
| 2 | 格式：每局一個「位置固定的陣列」（tuple），**一局一行**；名字放 `players` 表、局裡存索引 | 每天的 git diff 只有新增的幾行；2300 局約 312 KB、gzip 約 69 KB（實測縮放） |
| 3 | 資料集只放解析後的結構化欄位；`文字記錄`、`note` 原文、`頁碼`、`組成`、`discord_title` 一律不出；note 只出白名單標籤 | 公開 repo；原文含人名與事件描述（盤點 §3.3） |
| 4 | 兩檔用 `gamesKey`（資料集內容的 sha256 前 16 碼）綁定：資料集的 `key` = 快取的 `overview.gamesKey` | 伺服器與網站能偵測「資料集與快取不同批」並停用篩選，而不是算出錯的數字 |
| 5 | 產生器重構（不改任何數值）：`GameRow` 多 `captains`、`lake_claims`、`timeline_date`、`slot`、`note_tags`、`source`；計算函式改讀這些屬性，不再讀 `text_record` | Python 能從資料集「解碼回 GameRow」重算整份快取（round-trip 守門），且 Python 在子集上的結果 = TS 在子集上的結果（可做篩選後的一致性測試） |
| 6 | 時間序鍵（無日期局繼承上一個有日期局的日期）一律在**全部局**上算一次，篩選不改它 | 篩掉上一局不應改變某局在玩家時間線上的位置（盤點 §5-7） |
| 7 | 引擎在 `packages/shared/src/stats/`，一個 Python 函式對一個 TS 函式；理論勝率用 BigInt 分數；所有四捨五入照 Python（五成雙） | 不篩選時逐欄相同的硬性要求 |
| 8 | 篩選 = 子句的 AND；子句內的 `in` 清單是 OR；每個子句可 `not`。玩家條件子句兩種範圍：`dropGames`（丟掉含此人的局）、`hideFromLists`（局留著、只從名單 / 榜上拿掉） | 業主要的兩種「排除」 |
| 9 | 玩家條件的指標預設看**未篩選**（= 快取現成值），可選看「篩選後」；PR = 在「有資格的人」中的百分等級 `(低於 + 0.5 × 同分) / n`，比較用一位小數的公開值 | GM 決定；沿用 repo 既有的 `percentile_rank` 定義 |
| 10 | 「隱藏」永遠不改任何人的數字：先用全體算好，再拿掉被隱藏者並補滿前 N 名 | 語意單純、可驗證 |
| 11 | 排行的「近 90 天有出賽 / 新人」預設在**篩選後的局**上判斷，as-of = min(快取 asOf, 日期子句的結束日)；可切換「看全部局」或「不限」 | 預設值 = Python 在子集上跑 `compute_leaderboard`，可直接拿 Python 當參考答案；待 Edward 確認（§8-1） |
| 12 | 一致性三道關：(A) committed 兩檔不篩選逐欄比對（Node，每次 CI）；(B) 固定快照 + 8 個篩選預設，Python 參考答案在 CI 現產（不 commit 大 fixture）；(C) 伺服器第一次被要求 `/games` 時自己再比一次，不一致就關掉篩選 | 快照、live、執行期三層 |
| 13 | 瀏覽器：第一次用篩選才下載資料集與載入 worker chunk；Worker 內重算全部區塊（桌機約 30–80 ms、中階手機約 150–400 ms 估計） | 預設畫面零成本 |

---

## 1. 每局資料集 `games_cache.json`

### 1.1 位置與生命週期

- 路徑：`packages/server/games_cache.json`（與 `analysis_cache.json`、`sheets_cache.json` 同層）。`generate_cache.py` 新常數 `GAMES_OUTPUT_PATH`、參數 `--games-output`；伺服器另認環境變數 `AVALON_GAMES_DATASET`（本機預覽，比照 `AVALON_ANALYSIS_CACHE`）。
- 寫入者：`generate_cache.run()`，與快取同一次執行、同一份 `games`（`merge_game_logs` → `drop_dates_after(as_of)` → `canonicalize_player_names`（含 lane/r6-alias 的別名）→ `assign_timeline_dates`）。
- 讀者：伺服器 `GET /api/analysis/games`（§1.7）、Node 測試（§4）、之後的機器人篩選（§6）。
- 資料集**不放 as-of**（只有日子變時不應改檔）；引擎的 as-of 取快取的 `leaderboard.asOf`（§2.4）。日期本身是 `drop_dates_after(as_of)` 之後的值，所以「打錯成未來日期的局」在兩檔裡一致地當作無日期。

### 1.2 Schema（`format: "avalon-games"`, `version: 1`）

頂層：

```jsonc
{
  "format": "avalon-games",
  "version": 1,
  "key": "3f9c0a1b2c4d5e6f",          // sha256(去掉 key 的 canonical JSON) 前 16 碼；= analysis_cache.overview.gamesKey
  "cacheSchemaVersion": 4,             // 同一次執行寫的快取 overview.schemaVersion
  "config": {                          // 產生器的常數（Python 是唯一來源；引擎只讀這裡）
    "leaderboard": { /* LEADERBOARD_CONFIG 全部鍵 */ },
    "theoryWindows": [100],
    "minGamesThreshold": 30,           // MIN_GAMES_THRESHOLD（topPlayersByTheory / ByExcess）
    "excessShrinkK": 20,               // EXCESS_SHRINK_K
    "lakeClaimMinSample": 30           // LAKE_CLAIM_MIN_SAMPLE（L141）
  },
  "constants": {                       // 漂移偵測：TS 解碼時與自己的常數比對，不同就拒用
    "allRoles": ["刺客","莫甘娜","莫德雷德","奧伯倫","派西維爾","梅林","忠臣"],
    "configRoleOrder": ["刺客","莫甘娜","莫德雷德","奧伯倫","派西維爾","梅林"],
    "redRoles": ["刺客","莫甘娜","莫德雷德","奧伯倫"],
    "seats": ["1","2","3","4","5","6","7","8","9","0"],
    "roleDealTenths": {"刺客":1, "...": 1, "忠臣":4}
  },
  "counts": { "games": 2300, "fromSheet": 2250, "fromDiscord": 50, "players": 195, "dated": 2237, "undated": 63 },   // 示意數字
  "vocab": {
    "category": ["線瓦","面瓦","娛樂","","其他"],            // "" = 未分類（Discord匯入 可能）
    "outcome":  ["三紅","三藍死","三藍活","","其他"],         // 只有前三種算「有結果」
    "state":    ["紅紅紅","紅紅藍藍藍", "...", "?"],          // 局勢；不符 ^[紅藍]{1,5}$ 的值一律 "?"
    "noteTags": ["season:S1","season:S2","season:S3","season:S5",
                 "venue:<白名單地點代號>", "...",
                 "flag:spectated","flag:notRecorderGame","flag:review","flag:badGame",
                 "flag:lakeCorrected","flag:substitution","flag:incident"]
  },
  "players": ["玩家甲", "玩家乙", "..."],   // 顯示名（大小寫 / 全半形折疊 + 別名之後），索引 = 首次出現順序
  "aliases": { "舊寫法": "正式名字" },        // = 快取 players.aliases（lane/r6-alias；沒有就 {}）
  "fields": ["id","src","date","cat","slot","note","config","outcome","kill",
             "seats","missions","rounds","state","firstTeam","lakes","claims","captains"],
  "games": [
    ["1",0,"2022-03-04",0,1,[],"125803",0,"",[3,-1,7,0,12,5,9,1,4,22],"ooo|oox|ooo||","BRB--",2,"178","05----","05o",
     "41-"],
    ...（一局一行）
  ]
}
```

每局欄位（順序 = `fields`）：

| 欄位 | 型別 | 來源（Python） | 清理規則（保證不出文字） | 誰用 |
|---|---|---|---|---|
| `id` | string | 流水號 → `g.id` | 牌譜：原值（純數字）。Discord匯入：`"D" + sha256(post id) 前 10 碼`（不公開論壇貼文 id） | 篩選 `gameId`、除錯 |
| `src` | 0 / 1 | `merge_game_logs`（新 `g.source`） | 0 = 牌譜、1 = Discord匯入 | 篩選 `source` |
| `date` | `"YYYY-MM-DD"` / `""` | `g.date`（`drop_dates_after` 後） | 只接受 `^\d{4}-\d\d-\d\d$` | 時間線、排行、日期篩選 |
| `cat` | int | `g.category` | vocab 索引；白名單外的非空值 → `"其他"` | 分類篩選（Python 區塊不用） |
| `slot` | int | 場次（新 `g.slot`；Discord 是 `game_no`） | 只取純數字，空 / 非數字 = 0 | 場次篩選 |
| `note` | int[] | note（新 `g.note_tags`，解析在 `parse_game_log` 內完成，原文不存進 GameRow） | vocab.noteTags 索引；白名單外的內容全丟 | 賽季 / 地點 / 旗標篩選 |
| `config` | string(6) | `g.config` | `^\d{6}$` 原樣；否則非數字字元換 `?`（快照 0 局），並由 round-trip 守門判斷有沒有影響 | 座位→角色 |
| `outcome` | int | `g.outcome` | vocab 索引；三種以外的非空值 → `"其他"`（Python 只拿它做「不屬於三種」） | 全部 |
| `kill` | 座位字元 / `""` | `g.kill` | 單一數字字元；其他 → `?`；建議只在三藍局輸出（§8-7）。Python 區塊不用 | 刺殺篩選 |
| `seats` | int[10] | `g.seat_players`（SEATS 順序 1..9,0） | 玩家索引，空座位 -1 | 玩家相關全部 |
| `missions` | string | `g.missions` / `g.round_results` | 5 格以 `|` 連接，空格 = 沒打；每格把 o/x/O/X 以外的字元換 `?`（保留長度與小寫 x 數 = Python 的 `fails`、`total`） | missions、rounds、captain、篩選 |
| `rounds` | string(5) | `g.rounds`（第一局..第五局） | `紅`→`R`、`藍`→`B`、空→`-`、其他→`?` | rounds.roundProgression |
| `state` | int | `g.game_state` | vocab 索引，空 = -1 | rounds.gameStates、篩選 |
| `firstTeam` | string | `g.r11_seats`（1-1） | 數字原樣、其他字元 → `?`（保留長度與重複） | rounds、篩選 |
| `lakes` | string(6) | `g.lake1..3`（`parse_lake` 後） | 每湖兩字元（持湖、目標）：數字原樣；`parse_lake` 有結果但該段不是單一數字 → `?`；沒有湖 → `--` | lake、篩選 |
| `claims` | string | 新 `g.lake_claims`（`parse_lake_claims(text)[:3]`） | 每條三字元：持湖座位、目標座位（非 ASCII 數字 → `?`）、宣告 `x`（紅）/ `o`（藍）/ `-`（沒宣告） | featureStudies L141、篩選 |
| `captains` | string | 新 `g.captains`（`_parse_captain_per_mission(text)[:5]`） | 每個任務一字元：ASCII 數字、`-`（找不到）、`?`（`isdigit()` 為真但不是 ASCII，例如全形；Python 會當忠臣 → 藍方，TS 同） | captainAnalysis、篩選 |

衍生欄位（**不存檔**，Python `decode_games_dataset` 與 TS `decodeDataset` 用同一規則在全部局上算一次）：`seatRoles`（`decode_config`）、`redWin` / `blueWin` / `merlinKilled`、每個任務的 `fails`（小寫 x 數）/ `total`、`r11` 的紅方人數 / 有沒有梅林 / 派西、每湖的持湖 / 目標陣營與角色、`namedSeats`、`timelineDate`（`player_timelines` 的「`date` 或上一個有日期局的日期」，含沒有結果的局，在**全部局**的資料集順序上算）、`seq`（陣列索引 = 合併順序）。

### 1.3 隱私與白名單

- 名字只出現在 `players` 與 `aliases`（快取本來就公開這些名字）。
- note 白名單（待 Edward 確認，§8-5）：`season:S1/S2/S3/S5`；地點（盤點 §3.3 的 13 個地點中**不是人名**的，`九號 = 9號`、`古亭週五 → 古亭` 是否合併待定）；旗標 `spectated`（我旁觀 / 旁觀）、`notRecorderGame`（不是我打的）、`review`（覆盤局）、`badGame`（爛局）、`lakeCorrected`（`[2025/8/14 update]湖女`）、`substitution`（含「代打」）、`incident`（`[1-1]` 之類的事件描述存在，只出「有事件」這個旗標）。比對規則寫成「整格完全符合」或「固定前綴」，其餘一律丟；以人名命名的地點（〔人名〕家）預設丟。
- 產生器的隱私自檢（`games_dataset_problems`）：`vocab` 必須等於程式內白名單；除了 `players`、`aliases`、`vocab` 之外，每個字串欄位都必須符合上表的正規式（只會有數字、日期、`o x O X ? - | R B` 這些記號）——不過就不寫資料集（§1.6）。
- 單元測試放一筆含假事件描述與假人名的 note、一段含湖行與提案的假文字記錄，斷言輸出 JSON 裡找不到那些字。

### 1.4 大小（實測縮放）

`r9/arch/proto_size.py`（快照 2146 局；名字表 + 上表欄位，不含 note/slot 的少量增量）：

| 格式 | 2146 局 raw / gzip -9 | 縮放到 2300 局 |
|---|---|---|
| 每局 tuple（本設計；一局一行時幾乎一樣：293 KB / 64 KB） | 291 KB / 64 KB | **約 312 KB / 69 KB** |
| 欄式（columnar） | 260 KB / 55 KB | 約 279 KB / 59 KB |

選 tuple 不選欄式：差 10 KB gzip，但欄式每天整行重寫，git diff 與 repo 增長差很多；一局一行時每日 commit 只多幾行（玩家首次出現也只在 `players` 尾端加一個）。加上 note / slot / src 約 +3–5%。brotli 未量測（通常比 gzip 小 10–20%）。對照：`analysis_cache.json` 3.6 MB、gzip 232 KB。

Python 3.11 在本容器的計時（快照）：players 0.29 s、overview 0.03 s、leaderboard 0.08 s、missions + lake + rounds + seatOrder + captain 0.14 s（含 captain 重新解析文字）。

### 1.5 產生器改動（全部不改快取任何數值）

1. `GameRow` 新屬性：`source`、`slot`、`note_tags`、`captains`、`lake_claims`、`timeline_date`（`None` = 未指定）。`parse_game_log` 在讀列時就把 `文字記錄` 解析成 `captains` / `lake_claims`、把 note 解析成 `note_tags`；`text_record` 仍保留給 `record_fingerprint`（合併去重）用，但**計算函式不再讀它**：`compute_captain_analysis` 讀 `g.captains`、`compute_lake_claim_feature` 讀 `g.lake_claims`。
2. `assign_timeline_dates(games)`：在 run() 的 `canonicalize_player_names` 之後、`build_cache` 之前對全部局算一次；`player_timelines` 有 `timeline_date` 就用它，否則照舊。對全部局結果相同（no-op），但讓「Python 在子集上」與「TS 在子集上」的時間序一致。
3. 浮點 `sum()` 改成明確的由左而右相加（`_sum_ltr`）：`expectedFinalWinRate`、legacy `roleTheory` 兩處。Python 3.11 數值完全不變；業主電腦若用 3.12+（`sum()` 改為補償加總，盤點 §0-7）也不會差最後一位。
4. `encode_games_dataset(games, merge, aliases) -> dict`、`decode_games_dataset(doc) -> list[GameRow]`、`games_dataset_key(doc)`、`games_dataset_problems(doc, cache, games, show_names)`、`write_games_dataset_atomically(doc, path)`（暫存檔 + rename；頂層縮排、`games` 一局一行）、`load_previous_games(path)`。
5. `build_cache` 在 `overview` 加 `gamesKey`（由 run() 傳入；`build_cache` 單獨被呼叫時為 `None` 不寫）。
6. note 解析器 `parse_note_tags(raw) -> list[str]`：白名單、正規化（全半形、空白）、合併規則都在這一個函式。

### 1.6 守門與寫檔（與現有 refresh guard 的互動）

run() 新流程（在現有步驟之間插入）：

```
games ← merge → drop_dates_after → canonicalize（含別名）→ assign_timeline_dates
dataset ← encode_games_dataset(games, …)；key ← games_dataset_key(dataset)
cache ← assemble_cache(build_cache(games, chemistry, as_of, games_key=key), …)
problems ← validate_new_cache(...)                       # 既有：失敗 → exit 4，兩檔都不寫
ds_problems ← games_dataset_problems(dataset, cache, games)
    · 局數 = overview.totalGames、players 數 = overview.totalPlayers
    · round-trip：build_cache(decode(dataset)) 的「從局算的區塊」與 cache 逐欄相等（canonical JSON）
    · 隱私自檢（§1.3）
unchanged ← not problems and only_the_day_changed(cache, previous, games) and dataset == 現有 games_cache.json
```

- **同寫或同不寫**：資料集內容一變（例如牌譜只改了某局的 分類，快取的區塊都不受影響），`overview.gamesKey` 跟著變 → 快取也算有變 → 兩檔一起寫。只有日子變時兩檔都不寫（`only_the_day_changed` 照舊；`gamesKey` 不含日期，不會干擾它）。
- `ds_problems` 非空（理論上只會是清理規則碰到新的怪資料、且真的影響某個區塊）：**照寫快取，不寫資料集**；`overview.gamesKey` 仍是新 key → 伺服器看到 key 不符就停用篩選並顯示「篩選資料更新中」。在 Actions 下印 `::error title=Games dataset withheld::` + 只有計數與欄位路徑（不印名字、不印值），並在 `$GITHUB_OUTPUT` 寫 `games_dataset=withheld`。withheld 時「資料集是否相同」不參與 `unchanged` 判斷（否則問題沒修好的每一天都會因為資料集不同而重寫只差日子的快取）。
- 寫檔順序：先資料集、後快取（中途當掉 → key 不符 → 篩選停用，下次執行修正）。
- `--compare`：job summary 多一行（只有計數）：「每局資料集：N 局、M 位、約 X KB（gzip Y KB）；分類 線瓦 a / 面瓦 b / 娛樂 c / 未分類 d；round-trip 通過」。
- `--allow-shrink` 對資料集沒有額外意義（局數守門已經在快取那層）。
- 公開日誌：資料集相關訊息一律只印計數 / 欄位路徑（`players[12].theory.career.roleTheory` 用索引，不用名字）。

`.github/workflows/refresh-analysis-cache.yml` 改動：
- `env` 加 `GAMES_PATH: packages/server/games_cache.json`。
- 「有沒有變」改用 `git status --porcelain -- "${CACHE_PATH}" "${GAMES_PATH}"`（**第一次寫出時資料集是未追蹤檔，`git diff --quiet` 看不到**）；`git add` 兩個路徑；commit 訊息多一句「每局資料集 N 局」。
- 最後加一步：`games_dataset=withheld` 時 `exit 1`（快取已推送；讓 Edward 看到紅燈）。
- 選配（§4.5）：裝 Node、`pnpm install --frozen-lockfile --filter @avalon/shared...`、跑 `node packages/shared/dist/stats/cli/parity.js`；不一致時 `git checkout -- "${GAMES_PATH}"` 後再 commit（只推快取），效果同 withheld。這步約 +1 分鐘，可先不做，靠伺服器執行期檢查（§1.7）兜底。

### 1.7 伺服器端點 `GET /api/analysis/games`

- 回應：`{ success: true, data: { dataset, context } }`（與其他 `/api/analysis/*` 同一個信封，網站 `analysisApiFetch` 直接用）。
- `context`（伺服器從已載入的快取組，約 5 KB）：

  ```ts
  interface GamesContext {
    gamesKey: string;                 // cache.overview.gamesKey
    asOf: string;                     // cache.leaderboard.asOf
    leaderboardConfig: object;        // cache.leaderboard.config（與 dataset.config.leaderboard 交叉比對）
    schemaVersion: number;
    chemistryRoster: { players: string[]; rowLabels: string[] };   // cache.chemistry.coWin 的名單（outcomePair 用）
    aliases: Record<string, string>;  // cache.players.aliases ?? {}
    unfiltered: { totalGames: number; totalPlayers: number };
    engineCheck: 'passed' | 'skipped';
  }
  ```
- 載入：與 `analysis_cache.json` 同一套路徑候選；第一次請求時讀檔、組 body 字串一次、預先算 gzip 與 brotli（`zlib.gzipSync` / `brotliCompressSync`，約數十 ms 一次）、ETag = body 的 sha1（強 ETag）。目前 Express 沒有 compression 中介層，所以在路由內自己依 `Accept-Encoding` 回對應 buffer，`Vary: Accept-Encoding`；`If-None-Match` 相符回 304。
- `Cache-Control: public, max-age=300, stale-while-revalidate=3600`。另外 `/api/analysis/overview` 原樣回傳快取的 overview（`getOverview()` = `loadCache().overview`），所以新欄位 `gamesKey` 不用改路由就會到網站；網站若發現手上資料集的 key ≠ overview 的 key，就用 `cache: 'no-cache'` 重抓一次。
- 錯誤：檔案不存在 → 503 `Games dataset not yet generated`；`dataset.key !== cache.overview.gamesKey` → 503 `Games dataset does not match the analysis cache`；執行期一致性檢查失敗 → 503 `Filtered statistics temporarily unavailable`。網站對這三種都顯示「篩選暫時無法使用」，預設畫面不受影響。
- 執行期一致性檢查（`engineCheck`）：第一次請求時在伺服器跑一次不篩選的引擎（約 0.1–0.3 s），與快取的「從局算的區塊」逐欄比（§4.6 規則）；不一致只在 log 印欄位數與前 20 個路徑（索引，不印名字）。`AVALON_STATS_ENGINE_CHECK=off` 可跳過（本機）。
- `POST /cache/invalidate` 一併清掉資料集 buffer 與檢查結果。速率限制沿用同一個 limiter（60 次 / 分）。

### 1.8 別名（lane/r6-alias）

- 資料集的名字是別名套用後的正式名字（`canonicalize_player_names` 先套別名再折疊），`aliases` 複製快取的 `players.aliases`。
- 篩選子句裡存的是正式名字；解碼分享連結時，每個名字用 `@avalon/shared` 的 `matchPlayerName(name, dataset.players, aliases)`（大小寫、全半形、舊名都認得）換成正式名字；找不到的名字讓該子句**不生效**並顯示「找不到玩家：…」（不是讓結果變成空集合）。之後才併入的別名也不會讓舊連結失效。
- round-trip 守門用解碼後的名字重跑 `build_cache`：別名的目標不會是別的別名的來源（別名檔已驗證），所以 `canonicalize_player_names` 對它是 no-op。

---

## 2. TS 計算引擎 `packages/shared/src/stats/`

### 2.1 檔案配置

```
packages/shared/src/stats/
  index.ts            公開 API：decodeDataset、computeStats(dataset, context, filter?, opts?)、METRICS、PRESETS、encode/decodeFilter
  constants.ts        ALL_ROLES、RED_ROLES、BLUE_ROLES、CONFIG_ROLE_ORDER、SEATS、SEAT_LABELS、OUTCOMES、FINAL_RED_OUTCOMES、ROLE_DEAL_TENTHS（解碼時與 dataset.constants 比對）
  pyround.ts          rnd1、rate、sumLtr、pyFormatFixed、cmpCodePoint、sortByKeys（見 2.3）
  fraction.ts         BigInt 有理數：fromInt、fromDecimalString（= Fraction(str(x))）、add、mul、roundTenthHalfEven
  dataset.ts          型別 + decodeDataset（tuple → Game；衍生欄位、timelineDate、常數比對、key 驗證）
  players.ts          PlayerTally（_PlayerTally / to_row）、playerTallies、computeRoleFinalWinRates、computeSeatFinalWinRates、computePlayerStats
  theory.ts           playerTimelines、cellRate、theoryWindow、roleWindowTheory、playerTheory、theoryConfig、theoryWindows、roleWindowGames、theoryKey
  overview.ts         computeOverview、playerGameOutcomes、topPlayersByRoleTheory / Position / Overall、shrunkExcess、computeSeatPositionWinRates、outcomeSplit
  seatOutcomes.ts     computeSeatOutcomesPerPlayer
  chemistry.ts        computeOutcomePairMatrix（名單來自 context.chemistryRoster）
  missions.ts         computeMissions
  lake.ts             computeLake
  rounds.ts           computeRounds
  seatOrder.ts        computeSeatOrder
  captain.ts          computeCaptainAnalysis
  leaderboard.ts      windowStart、ranked、board、roleRow、theoryLegend、computeLeaderboard、dateSummary
  featureL141.ts      wilsonInterval、claimCell、computeLakeClaimFeature（含中英文 hook / takeaway 字串）
  details.ts          computePlayersEndpoint、computePlayerDetails
  build.ts            buildSections(games, ctx, asOf, activity) = build_cache 的「從局算的區塊」；hide 後處理
  served.ts           從 server/services/sheetsAnalysis.ts 搬來：servedPlayerRow、servedChemistry、normalizeSeatOrderPermutation、withFinalFields、assassinationWinRates、playerRadar（routes/analysis.ts 的 radar 組裝）
  leaderboardV3.ts    從 server/services/LeaderboardV3.ts 搬出純計算 computeLeaderboardV3(players)
  filter/
    types.ts          GameFilter、Clause、PlayerSelector、MetricId（§3.2）
    predicates.ts     每種子句 → (game) => boolean
    metrics.ts        METRICS 登錄表、percentileRank（§3.4）
    apply.ts          applyFilter → { G1, G2, dropped, hidden, asOf, activity, meta }
    hide.ts           hideFromSections(sections, hidden)
    url.ts            encodeFilter / decodeFilter / canonicalFilterKey
    presets.ts        PRESETS（§3.7）
    describe.ts       describeFilter(filter, lang) → 「分類：線瓦；排除：角色理論 PR > 90 的玩家（不計入他們的局）」
  cli/parity.ts       node 用：讀兩檔、比對、只印路徑與計數（選配的每日檢查、本機除錯）
```

- 伺服器改為從 shared 匯入 `served.ts` / `leaderboardV3.ts`（行為不變；既有 `AnalysisCacheContract`、`AnalysisServedOutcomes` 測試涵蓋）。
- `package.json` 加子路徑匯出（`"./stats"`、`"./stats/filter"`），網站主程式只匯入 `stats/filter`（型別、URL、描述、預設集，幾 KB），引擎本體只進 worker chunk；shared 目前編成 CommonJS，從 `index` 匯入會把整包拉進主 bundle，這點實作時要驗證 Vite 的輸出。

### 2.2 Python → TS 對照

| Python（generate_cache.py） | TS | 備註 |
|---|---|---|
| `decode_config`、`role_faction`、`is_final_win` | `constants.ts` | |
| `parse_lake`、`count_mission_fails`、`_parse_captain_per_mission`、`parse_lake_claims` | （不移植） | 產生器解析，資料集帶結果 |
| `rnd1`、`_rate`、`_round_exact`、`_cell_rate` | `pyround.ts`、`fraction.ts`、`theory.ts` | |
| `_PlayerTally`、`_player_tallies`、`compute_player_stats` | `players.ts` | 名單順序 = `-totalGames`、同分按首次出現（Map 插入順序） |
| `compute_role_final_win_rates`、`compute_seat_final_win_rates` | `players.ts` | 族群率：篩選後的局上算 |
| `player_timelines`、`theory_window`、`role_window_theory`、`player_theory`、`theory_config`… | `theory.ts` | 用 `timelineDate` |
| `compute_overview`、`player_game_outcomes`、`top_players_by_*`、`shrunk_excess`、`compute_seat_position_win_rates`、`_outcome_split` | `overview.ts` | |
| `compute_seat_outcomes_per_player`、`_outcome_split_counts` | `seatOutcomes.ts` | |
| `compute_outcome_pair_matrix` | `chemistry.ts` | |
| `compute_missions`（`mission_by_composition` 是死碼，不移植） | `missions.ts` | |
| `compute_lake`、`compute_rounds`、`compute_seat_order`、`compute_captain_analysis` | 各自檔案 | |
| `window_start`、`_ranked`、`_board`、`_role_row`、`theory_legend`、`compute_leaderboard`、`date_summary` | `leaderboard.ts` | 榜的 note / period 中英文字串也移植，一併比對 |
| `wilson_interval`、`_claim_cell`、`_cell_text*`、`compute_lake_claim_feature` | `featureL141.ts` | |
| `compute_players_endpoint`、`compute_player_details` | `details.ts` | |
| `build_cache`（扣掉 chemistry 四個試算表矩陣） | `build.ts` | |
| `refresh_feature_studies` | （網站合併） | 引擎只出 L141 物件與 `sampleSize.{games, lakeLinks}`，網站換進 API 的 featureStudies |
| `build_archetype_strength.build_strength_section` | v1 不做 | §6 |

### 2.3 精確運算 helper（規格）

| helper | 定義 | 對應 Python |
|---|---|---|
| `rnd1(x)` | `s = x*10; f = floor(s); if (s - f === 0.5) return (f 偶 ? f : f+1)/10; return Math.round(s)/10`（`s - f` 在浮點下是精確的；負數同理） | `round(n * 10) / 10`（現有 `sheetsAnalysis.rnd1` 搬到 shared） |
| `rate(c, t)` | `t ? rnd1(c / t * 100) : 0`（運算順序照抄：先除再乘 100） | `_rate` |
| `sumLtr(xs)` | 從 0 開始逐項相加 | 產生器改用的 `_sum_ltr`（= 3.11 的 `sum()`） |
| `Rational` | BigInt 分子分母、每步約分；`fromDecimalString(String(x))`：族群率是 `rnd1` 輸出，JS `String(x)` 與 Python `repr` 在 0–100 的一位小數完全相同（都是最短可還原表示；`45` vs `45.0` 值相同） | `Fraction(str(population))` |
| `roundTenthHalfEven(r)` | `q = floor(10·num/den)`；餘數 ×2 與 den 比；等於時取偶；回傳 `Number(q) / 10`（`|q| < 2^53`，IEEE 除法與 Python `int / 10` 相同） | `round(Fraction * 10) / 10` |
| `pyFormatFixed(x, d)` | 把 double 的**精確**二進位值展開成十進位（BigInt），在第 d 位五成雙；L141 的 `:.1f`、`:.0f` 用（JS `toFixed` 遇到剛好一半時往大的方向，`40.5.toFixed(0)` = `"41"`，Python 是 `"40"`） | `f"{x:.1f}"`、`f"{x:.0f}"` |
| `cmpCodePoint(a, b)` | 依 Unicode 碼位比較（逐個 `codePointAt`）；JS `<` 比 UTF-16 單元，名字含擴充區字 / emoji 時不同 | Python `str` 比較 |
| `sortByKeys(arr, key)` | 穩定排序；key 是 tuple，數字比數值、字串用 `cmpCodePoint`、布林 `false < true` | `sorted(key=...)`、`sorted(dict.items())` |
| `wilsonInterval` | 逐式照抄（`Math.sqrt` 與 Python `math.sqrt` 都是正確捨入） | `wilson_interval` |

效能實測：`r9/arch/bench_theory.mjs`，171 人 × 6 個視窗 × 角色 + 位置理論（BigInt、每步 gcd），Node 22 本容器 **12.8 ms**；整個引擎估計桌機 30–80 ms。

### 2.4 設定與 as-of

- 設定：`dataset.config`（產生器常數）是引擎唯一來源；解碼時檢查 `dataset.config.leaderboard` 與 `context.leaderboardConfig`（去掉 `theoryWindows`）相同，不同就拒用（兩檔不同批）。
- as-of：`context.asOf`（= 快取 `leaderboard.asOf`；只有日子變時快取不重寫，所以引擎與預設畫面永遠用同一天）。有篩選時的有效 as-of `A` 見 §3.5；L141 的 `computedAt` 也用 `A`。
- 名單 `context.chemistryRoster`：outcomePair 的列 / 欄（試算表 coWin 的 28 人，已經是正式名字）。

### 2.5 輸出

`computeStats` 回傳：

```ts
interface StatsResult {
  key: string;                      // dataset.key
  filterKey: string;                // canonicalFilterKey(filter)；無篩選 = ''
  meta: FilterMeta;                 // 局數前後、被丟掉的局（依子句）、隱藏人數、有效 asOf、activity、未解析的名字、樣本過小提醒
  overview: Overview;               // 快取同形狀（含 schemaVersion、theoryConfig）
  players: { players: PlayerRow[]; total: number; seatOutcomesSource: 'games'; aliases?: Record<string,string> };
  playerDetails?: Record<string, {player: PlayerRow; radar: Record<string, number>}>;   // opts.details（worker 預設不產生，主執行緒需要時由 players 組）
  chemistry: { outcomePair: OutcomePairMatrix; sheetMatrices: 'unavailable' | 'hiddenOnly' };
  missions; lake; rounds; seatOrder; captainAnalysis; leaderboard;
  featureStudies: { l141: FeatureStudy; sampleSize: { games: number; lakeLinks: number } };
}
```

網站在畫面上用的是「伺服器處理後」的形狀，所以引擎輸出也經 `served.ts` 同一套函式（`servedPlayerRow`、`normalizeSeatOrderPermutation`、`playerRadar`…）再交給元件，元件不用知道資料來自 API 或引擎。

### 2.6 決定性要點（照抄 Python 才會一致）

- 局的範圍三種（盤點 §1）：全部局（overview 的 totalGames / 紅藍勝率 / outcomeBreakdown、seatPositionWinRates、missions、lake、rounds、seatOrder、captain）；只算 `結果 ∈ {三紅, 三藍死, 三藍活}`（players、missionStage 等、role/seatFinalWinRates、theory、leaderboard、outcomePair、seatOutcomes）；只算有名字的座位（players、role/seatFinalWinRates）。
- 「勝」兩套：任務階段（舊欄位）、最終結算（final*、excess*、theory、leaderboard）。
- 排序鍵完全照抄（`_ranked`：`(-value, -games, -careerGames, name)`；`_ranked_overview`：`(-value, -careerGames, name)`；角色王：`(-rate, -games, -careerRoleGames, name)`；gameStates 依局數、同數保持首見順序；`sorted(..., reverse=True)` 的同值仍保持原順序，JS 穩定排序用反向比較即可）。
- 物件鍵順序：座位鍵（`"1".."9","0"`）的物件在 JS 一定是 `"0"` 先——API 回來的 JSON 經 `JSON.parse` 本來就是這樣，所以元件必須依 `SEATS` 常數迭代（實作時順便檢查現有元件有沒有依 `Object.keys` 順序畫圖）。比對一律用語意相等（§4.6）。
- 數字型別：Python 的 `1080.0` 與 JS 的 `1080` 視為相等。

---

## 3. 篩選模型

### 3.1 管線

```
G   資料集全部局（順序 = 合併順序；timelineDate 已在 G 上算好）
 │  ① 局子句、玩家在局子句（AND；每個子句可 not）
G1
 │  ② 每個 excludePlayers 子句：在「評估集」（預設 G、可選 G1）上算玩家指標 → 被選中的人 P_c
 │     D = ∪ P_c（scope = dropGames）     H = ∪ P_c（scope = hideFromLists）
 │  ③ 丟掉有任何座位是 D 中的人的局（dropIncompleteGames 時連名字沒寫齊的局一起丟）
G2
 │  ④ buildSections(G2, asOf = A, activity)
 │  ⑤ hideFromSections(結果, H)
結果 + meta
```

- 所有 excludePlayers 子句都在同一個評估集上判斷，彼此順序無關；丟局之後不再重新判斷（單次，不迭代）。
- 只有 hideFromLists 子句、且 options 是預設值（G2 = G、A = 快取 asOf）時，不需要引擎也不需要資料集：直接對快取資料做 ⑤（指標看未篩選 = 快取的 players 列）。這時試算表默契矩陣、strength、archetype、playstyle 也都還有效（隱藏不改數字），只拿掉被隱藏的列 / 欄。
- 空篩選（`clauses` 為空且 options 為預設）= 用快取，不跑引擎。

### 3.2 型別（JSON 可序列化）

```ts
export interface GameFilter {
  v: 1;
  clauses: Clause[];                       // AND；空 = 不篩選
  options?: {
    activity?: 'filtered' | 'all' | 'none';  // 排行「近 N 天有出賽」「新人」看哪些局；預設 'filtered'（§3.5）
    asOf?: 'auto' | string;                  // 'auto'（預設）= min(快取 asOf, date 子句的 to)
  };
}

type Role = '刺客' | '莫甘娜' | '莫德雷德' | '奧伯倫' | '派西維爾' | '梅林' | '忠臣';
type SeatNo = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
type Side = 'red' | 'blue';
interface Base { not?: boolean }           // 反轉此子句（excludePlayers 不接受 not，用 who.invert）

export type Clause =
  // ── 局 ──
  | Base & { kind: 'category'; in: Array<'線瓦' | '面瓦' | '娛樂' | '未分類' | '其他'> }
  | Base & { kind: 'source'; in: Array<'sheet' | 'discord'> }
  | Base & { kind: 'date'; from?: string; to?: string; undated?: 'exclude' | 'include' }
  | Base & { kind: 'weekday'; in: Array<1 | 2 | 3 | 4 | 5 | 6 | 7> }          // ISO：1 = 星期一
  | Base & { kind: 'sessionIndex'; min?: number; max?: number }              // 場次（當天第幾局）
  | Base & { kind: 'season'; in: Array<'S1' | 'S2' | 'S3' | 'S5' | 'none'> }
  | Base & { kind: 'venue'; in: string[] }                                    // 白名單地點代號 | 'none'
  | Base & { kind: 'noteFlag'; any: string[] }                                // spectated、badGame…
  | Base & { kind: 'namedSeats'; min?: number; max?: number }                // 有寫名字的座位數
  | Base & { kind: 'outcome'; in: Array<'三紅' | '三藍死' | '三藍活' | 'other'> }
  | Base & { kind: 'finalWinner'; is: Side }
  | Base & { kind: 'missionCount'; in: number[] }                            // 打了幾個任務
  | Base & { kind: 'mission'; round: 1 | 2 | 3 | 4 | 5; result?: 'pass' | 'fail'; minFails?: number; maxFails?: number }
  | Base & { kind: 'gameState'; in: string[] }                               // 局勢
  | Base & { kind: 'firstTeam'; redCount?: number[]; hasMerlin?: boolean; hasPercival?: boolean }
  | Base & { kind: 'lakeCount'; in: Array<0 | 1 | 2 | 3> }
  | Base & { kind: 'lake'; index: 1 | 2 | 3; holderSide?: Side; targetSide?: Side;
             holderRole?: Role[]; targetRole?: Role[]; claim?: Array<'red' | 'blue' | 'none'> }
  | Base & { kind: 'assassination'; target: Array<Role | 'none'> }
  | Base & { kind: 'roleSeat'; role: Role; seats: SeatNo[] }
  | Base & { kind: 'trioOrder'; in: Array<'派梅娜' | '派娜梅' | '梅派娜' | '梅娜派' | '娜派梅' | '娜梅派'> }
  | Base & { kind: 'captain'; round: 1 | 2 | 3 | 4 | 5; side: Side }
  | Base & { kind: 'gameId'; in: string[] }
  // ── 玩家在局 ──
  | Base & { kind: 'withPlayer'; player: string; role?: Role[]; side?: Side; seat?: SeatNo[];
             result?: 'win' | 'loss'; resultRule?: 'final' | 'mission' }
  | Base & { kind: 'withAnyPlayer'; players: string[] }
  | Base & { kind: 'withPlayers'; players: [string, string]; relation: 'together' | 'sameTeam' | 'opposingTeams' }
  // ── 玩家集合（排除）──
  | { kind: 'excludePlayers'; who: PlayerSelector; scope: 'dropGames' | 'hideFromLists'; dropIncompleteGames?: boolean };

export type PlayerSelector =
  | { by: 'names'; names: string[]; invert?: boolean }
  | { by: 'metric'; metric: MetricId; role?: Role;
      op: 'gt' | 'ge' | 'lt' | 'le';
      value?: number; pr?: number;                   // 二擇一
      evaluatedOn?: 'unfiltered' | 'filtered';       // 預設 'unfiltered'
      ineligible?: 'keep' | 'select';                // 預設 'keep'：沒資格的人不會被選中
      minGames?: number;                             // 覆寫資格門檻
      invert?: boolean };                            // 選「有資格但不符合」的人
```

### 3.3 子句語意（g = 一局；「有名字的座位」才看得到玩家）

| 子句 | 成立條件 | 備註 |
|---|---|---|
| `category` | `g.category ∈ in`（`未分類` = 空白；`其他` = 白名單外的值） | 「排除娛樂局」= `{category, in:[娛樂], not:true}`，未分類的局保留；「只看線瓦」不含未分類 |
| `source` | 牌譜 / Discord匯入 | |
| `date` | 有日期：`from ≤ date ≤ to`（含兩端，ISO 字串比較；沒給的那端不限）；無日期：`undated === 'include'` 才成立（預設 exclude）。from、to 都沒給時只決定無日期局的去留 | 用實際 `date`，不用 `timelineDate` |
| `weekday` | 有日期且星期 ∈ in | |
| `sessionIndex` | `slot > 0` 且在 [min, max] | 例：只看每晚前 3 局 |
| `season` / `venue` / `noteFlag` | note 標籤；`none` = 沒有該類標籤 | 待白名單（§8-5） |
| `namedSeats` | 有名字的座位數在 [min, max] | 「只看 10 人全寫」= `{min:10}` |
| `outcome` | 結果 ∈ in；`other` = 三種以外（含空白） | |
| `finalWinner` | red：三紅或三藍死；blue：三藍活；其他結果兩者都不成立 | 最終結算 |
| `missionCount` | 非空任務格數 ∈ in | 快照：3 / 4 / 5 局 852 / 603 / 688，2 局 3（不完整） |
| `mission` | 該任務格非空，且 `pass` ⇔ 小寫 x 數 = 0（Python 規則：第 4 局 1 張失敗也算 fail）；`minFails/maxFails` 限 x 數 | |
| `gameState` | 局勢 ∈ in | |
| `firstTeam` | 1-1 非空，且各條件成立（紅方人數只數座位對應到紅方角色的字元，與 `r11_red_count` 同） | |
| `lakeCount` | 有持湖座位（`lakes` 該湖不是 `--`）的湖數 | |
| `lake` | 第 index 湖存在，且持湖 / 目標陣營、角色符合；`claim` 看文字記錄第 index 條湖行（`claims`，與 首湖/二湖/三湖 欄不同來源，`none` = 有湖行但沒宣告） | |
| `assassination` | 結果是三藍死或三藍活，且 刺殺 座位的角色 ∈ target；`none` = 三藍但沒填 | 依 刺殺 欄原樣（快照三藍死 516 局中刺中梅林 513 局，少數幾局目標不是梅林或沒填，盤點 §2） |
| `roleSeat` | 該角色的座位 ∈ seats | |
| `trioOrder` | 派 / 梅 / 娜 的順時針順序（`compute_seat_order` 的定義） | |
| `captain` | 第 round 個任務有隊長字元且有該任務結果；陣營 = 座位角色的陣營，`?` 或查不到 → 忠臣 → 藍方（Python 同） | |
| `withPlayer` | 存在一個有名字的座位是該玩家，且其角色 / 陣營 / 座位 / 勝負（`resultRule` 預設 final）都符合；勝負只在三種結果的局成立 | `not` = 「沒有這樣的座位」（含他沒出賽的局） |
| `withAnyPlayer` | 任一玩家在局 | |
| `withPlayers` | 兩人都在局；`sameTeam` = 兩人陣營相同；`opposingTeams` = 不同 | |
| `excludePlayers` | 見 3.4；`dropGames` 丟掉任一有名字座位是被選中者的局；`dropIncompleteGames` 再丟掉 namedSeats < 10 的局 | 名字沒寫的座位看不到（盤點 §0-6：零名字 83 局、只寫 1 人 317 局） |

`not` 一律只反轉該子句本身（例：`{withPlayer: 玩家甲, role:[梅林], not:true}` = 「玩家甲不是梅林的局」，包括玩家甲沒出賽的局）。

### 3.4 玩家條件（排除某些條件玩家）

指標登錄表（`metrics.ts`；欄位都是 players 列在評估集上的值，即公開的一位小數）：

| MetricId | 值 | 預設資格（PR 母體） | 快照有資格人數（盤點 §3.2） |
|---|---|---|---|
| `roleTheory` 角色理論 | `theory.roleWindows.roleTheory` | `fullWindows`（六個特殊角色各 ≥ roleWindowGames、忠臣 ≥ loyalWindowGames） | 35 |
| `positionTheory` 位置理論 | `theory.last{mainGames}.positionTheory` | 場數 ≥ mainGames | 41 |
| `overallTheory` 整體理論 | `theory.career.roleTheory` | 場數 ≥ overallMinGames | 24 |
| `finalWinRate` 最終勝率 | `finalWinRate` | 場數 ≥ minGamesThreshold（30） | 62 |
| `missionWinRate` 任務勝率 | `winRate` | 同上 | |
| `excessWinRate` 超額勝率 | `excessWinRate` | 同上 | |
| `games` 場數 | `totalGames` | 全部 | 171 |
| `roleFinalWinRate`（需 `role`） | `roleFinalWinRates[role]` | 該角色場數 ≥ roleTitleMinGames | |
| `roleGames`（需 `role`） | `rawRoleGames[role]` | 全部 | |
| `merlinSurvivalRate` | `merlinSurvivalRate` | `rawBlueThreeBlue` ≥ 30 | |
| `assassinHitRate` 刺中率 | 最近 assassinAttempts 次刺殺的 `_rate(hits, attempts)`（assassin 榜定義） | 刺殺次數 ≥ assassinMinAttempts | |
| `daysSinceLastPlayed` | 評估集 as-of − lastPlayed（天） | 有日期 | |
| `daysSinceFirstPlayed` | 評估集 as-of − firstPlayed（天） | 有日期 | |

- `minGames` 可覆寫資格門檻（例：「最終勝率，至少 100 場才比」）。
- **PR** = 在有資格的人之中：`(2 × 低於 + 同分) / (2n) × 100`，用精確分數算、五成雙到一位小數（同分包含自己；與 `build_archetype_strength.percentile_rank` 同義，但避免了 `round(x, 1)` 的浮點細節）。角色理論只有約 17 種不同值、最多 5 人同分，同分者 PR 相同、同進同出。
- **比較**一律用一位小數的公開值（使用者看到 PR 90.0 就是 90.0）：`gt` 是 `>`、`ge` 是 `≥`…；`value` 與 `pr` 二擇一。
- `ineligible: 'keep'`（預設）：沒資格的人永遠不被選中（例如角色窗沒打滿的人，其值被族群率補值拉向平均，不該參加「> X」的比較）；`'select'`：沒資格的人一律被選中（例：「只留下有資格的人」）。`invert` 只翻轉「有資格者是否符合」，不影響沒資格者。
- **評估集**：`unfiltered`（預設）= 全部局 G、as-of = 快取 asOf，值就是快取現成的數字（不循環）；`filtered` = 步驟 ① 之後的 G1、as-of = A，族群率與時間窗都在 G1 上算。
- `by: 'names'`：直接列名字（`invert` = 「除了這些人以外」，例如 hideFromLists + invert = 「名單只看這幾位」）。

例（業主原句）：

```jsonc
// 只看線瓦；丟掉含「角色理論 PR > 90」的人的局（依全部場次判斷）
{ "v": 1, "clauses": [
  { "kind": "category", "in": ["線瓦"] },
  { "kind": "excludePlayers", "scope": "dropGames",
    "who": { "by": "metric", "metric": "roleTheory", "op": "gt", "pr": 90 } } ] }

// 排除娛樂局；位置理論 < 45 的人留在局裡但不上榜
{ "v": 1, "clauses": [
  { "kind": "category", "in": ["娛樂"], "not": true },
  { "kind": "excludePlayers", "scope": "hideFromLists",
    "who": { "by": "metric", "metric": "positionTheory", "op": "lt", "value": 45 } } ] }
```

### 3.5 排行榜、as-of 與「近期出賽」

- 有效 as-of：`A = options.asOf === 'auto' ? min(快取 asOf, date 子句的 to（若有）) : options.asOf`。只看 2023 年時 A = 2023-12-31，否則近 90 天內沒有任何局、所有榜都空。
- `activity`：
  - `'filtered'`（建議預設）：完全等於 Python `compute_leaderboard(G2, A)`——「近 activeDays 天有出賽」「新人（首局在近 newcomerDays 天、每局都有日期）」都看 G2 的局。可以直接拿 Python 在子集上的輸出當參考答案（§4.2）。
  - `'all'`：「誰算數」（active、newcomer）看全部局 G（as-of 仍是 A），數字與場數門檻看 G2。適合「現役玩家的面瓦表現」。
  - `'none'`：不要求近期出賽（所有在 G2 有局的人都可上榜），不出新人榜。適合歷史區間。
- 場數門檻（mainGames、overallMinGames、roleWindowGames/loyalWindowGames 的 fullWindows、assassinMinAttempts、newcomerMinGames、roleTitleMinGames）一律看 G2：篩選後的資料本身要夠多場（業主規則「資料不能少場」）。
- `leaderboard.dates`（parsed / unparsed / earliest / latest）是 G2 的；榜的 note / period 文字依 A 與設定重產。
- 若榜因 activity 變空，介面提示「篩選範圍內近 90 天沒有人出賽」並提供切換 `all` / `none` 的按鈕。

### 3.6 各區塊怎麼反應

（「改」= 在 G2 上重算；「隱藏」= hideFromLists 的效果；「—」= 無關）

| 區塊 | 有改局的篩選 | 隱藏 H |
|---|---|---|
| overview：totalGames、紅藍勝率、merlinKillRate、outcomeBreakdown、missionStage / assassinationStage / final、seatPositionWinRates | 改 | — |
| overview.totalPlayers | 改（G2 中有結果局的玩家數） | 不變；`meta.hiddenPlayers` 另給（介面寫「171 位，隱藏 5 位」） |
| overview.roleFinalWinRates、seatFinalWinRates（族群率） | 改（含被隱藏者的座位） | — |
| overview.topPlayersBy*（Theory / Games / Excess / RoleTheory / PositionTheory / OverallTheory） | 改 | 拿掉 H 後依原排序補滿前 N |
| players.players、playerDetails、雷達 | 改（每人只算他在 G2 的局；理論勝率的補值用 G2 的族群率；expectedFinalWinRate 用 G2 的 roleFinalWinRates） | 拿掉 H 的列；雷達搜尋找不到被隱藏者（連結帶來時顯示「此玩家在目前篩選中被隱藏」） |
| players.total | 改 | = 實際回傳列數 |
| chemistry.outcomePair | 改（名單仍是試算表 28 人） | 拿掉 H 的列與欄 |
| chemistry 四個試算表矩陣 | **不提供**（不是從局算的，盤點 §0-4）；顯示「篩選時不提供（試算表彙總）」 | 仍有效：拿掉 H 的列與欄 |
| missions、lake、rounds、seatOrder、captainAnalysis | 改 | — |
| leaderboard 全部榜 | 改（§3.5） | 全排名算完後拿掉 H、補滿 topN、重編名次；角色王的候選排除 H |
| featureStudies L141 | 改（含 sampleSize.games / lakeLinks） | — |
| featureStudies L136 / L139 / L142 / L143 | 不改，標「未套用篩選」 | — |
| strength / archetype / playstyle（個人頁） | 不改，標「未套用篩選」（v1） | 只隱藏不影響（個人頁本來就只看一人） |
| LeaderboardV3 精算表（`/api/leaderboard/v3`） | 改：`computeLeaderboardV3(引擎 players 列)`；ELO 欄（Firestore 線上對局，與牌譜無關）在有篩選時隱藏 | 用全部列算完（全域平均含 H）再拿掉 H |
| 機器人（/戰績、/排行、週報、/默契） | v1 不變（§6） | — |

### 3.7 URL、分享與預設集

- 格式：`#stats?f=1.<base64url(UTF-8 JSON)>`，玩家連結 `#player=<名字>&f=…`，預設集可用短碼 `#stats?preset=online`（機器人以後可以直接貼）。`parseStatsHash` 擴充成 `{ kind: 'stats' | 'player', filter?, preset? }`。
- 解碼：版本前綴 `1.`；未知的子句種類丟掉並顯示提醒；欄位用白名單驗證（數值範圍、日期格式、角色名、座位 1..10）；名字依 §1.8 對到正式名字。一般篩選 100–300 字元。
- 進入統計頁時 App 會把 hash 吃掉（現行行為），所以篩選存在 store；篩選變動時用 `history.replaceState` 寫回 `#stats?f=…`（不觸發 hashchange），離開統計頁時清掉；另有「複製分享連結」按鈕。
- `canonicalFilterKey`：子句依 JSON 排序、`in` 清單排序、去掉預設值 → 給 worker 的結果快取與比對用；畫面上保留使用者的順序。
- 預設集（`presets.ts`，中英標籤）：

| id | 名稱 | 內容 |
|---|---|---|
| `online` | 只看線瓦 | `category in [線瓦]` |
| `offline` | 只看面瓦 | `category in [面瓦]` |
| `noCasual` | 排除娛樂局 | `category in [娛樂], not` |
| `fullNames` | 只看 10 人全寫 | `namedSeats min 10` |
| `lastYear` | 近一年 | `date from = asOf − 364 天`（套用時依 context.asOf 展開成固定日期，分享連結存展開後的日期） |

使用者自訂預設集（存瀏覽器 localStorage，帳號同步以後再說）列在 §6。

### 3.8 介面輪廓（v1）

- 統計頁頂端（排行、分析兩個 tab 共用）一列「篩選列」：預設集 chips、分類 chips（線瓦 / 面瓦 / 娛樂 / 未分類）、日期區間、「排除玩家」（名字或條件：指標下拉 + 大於 / 小於 + 數值 / PR + 「丟掉他們的局 / 只是不上榜」+ 「依全部場次 / 依篩選後」）、「更多條件」抽屜（其餘子句）。
- 有篩選時顯示橫幅：`describeFilter` 文字 + 「篩選後 1,234 / 2,228 局」+ 清除 + 複製連結；樣本小（< 100 局或玩家指標 PR 母體 < 10 人）時加提醒。
- 不能篩的卡片右上角標「未套用篩選」，試算表默契矩陣在有改局的篩選時收起並說明原因。
- 計算中保留舊結果、只加小轉圈，不閃白。

---

## 4. 一致性驗證（parity）

### 4.1 A：committed 兩檔，不篩選（每次 CI，純 Node）

- `packages/server/src/__tests__/StatsEngineParity.test.ts`：讀 `games_cache.json` + `analysis_cache.json`；`dataset.key !== cache.overview.gamesKey`（或資料集不存在）時 `it.skip` 並印原因——合併後第一次每日更新前一定是這樣（committed 快取還是 main 產生器寫的 schemaVersion 3，盤點 §0-1）。
- 比對範圍（逐欄，§4.6）：`overview` 全部鍵；`players`（players、total、seatOutcomesSource、aliases）；`playerDetails`；`chemistry.outcomePair`；`missions`、`lake`、`rounds`、`seatOrder`、`captainAnalysis`；`leaderboard` 全部（含 asOf、dates、config、每個榜的文字）；`featureStudies` 中 loopId = L141 的那筆與 `sampleSize.games / lakeLinks`。不比：試算表四矩陣、strength、archetype、playstyle、其他 featureStudies。
- 同時驗 `served.ts` 路徑：引擎輸出經 served 函式 = 伺服器 `/api/analysis/*` 對同一份快取的回應（用既有的 supertest 架構）。

### 4.2 B：固定快照 + 篩選預設（CI 現產參考答案，不 commit 大 fixture）

- `packages/server/scripts/build_stats_parity_fixtures.py`（只用標準函式庫；產生器在沒有 Google 套件時可匯入）：讀 committed `sheets_cache.json` 快照，`AVALON_STATS_AS_OF = 2026-02-28`（快照最晚 2026-02-27；用今天的話沒人「近 90 天有出賽」），化學名單取快照的 同贏 分頁（同 `r9/inv/build4.py`）。輸出到 `--out` 目錄：`games.json`（encode）、`context.json`、以及每個預設的 `ref/<id>.json`（Python 對子集跑 `build_cache` 的「從局算的區塊」+ L141，再做 Python 版的 hide 後處理）。全程約 5 秒。
- 預設清單放 `packages/shared/src/stats/__fixtures__/parity_presets.json`（GameFilter JSON；Python 與 TS 共讀；**不含任何名字**——需要「某位玩家」時用指標選人）：
  1. 無篩選；2. 線瓦；3. 面瓦；4. 排除娛樂；5. 2024-01-01～2024-12-31（A 移到年底）；6. 10 人全寫；7. 排除角色理論 PR > 90（dropGames、unfiltered）；8. 同 7 但 hideFromLists。
- Python 參考篩選器 `scripts/stats_filter_reference.py` 只實作上列用到的子句（category、date、namedSeats、excludePlayers metric），以獨立實作交叉驗證 TS 的語意。
- `.github/workflows/test.yml` 在 `pnpm --filter @avalon/server test` 前加：`actions/setup-python@v5`（3.11）→ `python packages/server/scripts/build_stats_parity_fixtures.py --out "$RUNNER_TEMP/stats-parity"`，測試讀 `AVALON_STATS_PARITY_DIR`；本機沒設時 skip 並提示 `pnpm --filter @avalon/server test:parity`（先跑 Python 再跑 vitest）。順便把 `test_generate_cache.py`、`test_discord_records_import.py` 也放進這個 job（現在只有每日 workflow 會跑）。

### 4.3 Python 端測試（`test_generate_cache.py`，虛構名字）

- round-trip：快照 → `encode` → `decode` → `build_cache` 的從局算的區塊，與直接從快照算的完全相同（canonical JSON）。
- 重構 no-op：`captains` / `lake_claims` / `timeline_date` / `_sum_ltr` 前後的快取完全相同（以重構前的函式結果當期望值）。
- 隱私：塞入含假人名與事件描述的 note、含湖行與提案的假文字記錄、Discord 貼文標題，斷言資料集 JSON 找不到這些字；不在白名單的 分類 / 局勢 / 怪字元被換成 `其他` / `?`。
- key：同內容同 key；只改某局 分類 → key 變、快取的 `overview.gamesKey` 變、兩檔都寫；只有日子變 → 兩檔都不寫；資料集出問題 → 只寫快取、`games_dataset=withheld`。
- 公開日誌：Actions 模式下資料集相關訊息不含任何名字。
- 新怪資料：`config` 含非數字、`1-1` 含空白、湖欄 `7o`（快照真的有）等，round-trip 仍相等。

### 4.4 TS 單元測試（`packages/server/src/__tests__/stats/*.test.ts`，vitest 已把 `@avalon/shared` 指到 src）

- `pyround`：由 Python 產生的 JSON fixture（五成雙的剛好一半、`:.0f` / `:.1f`、`Fraction(str(x))`、負數）逐筆比對。
- `cmpCodePoint`：虛構的擴充區字 / emoji 名字排序與 Python 相同。
- 每種子句的成立條件（小型合成資料集，虛構名字）；`not`、`in` 的 OR、AND 組合。
- PR：同分、母體 1 人、沒資格者 keep / select、invert。
- hide 不變式：沒被隱藏者的每個數字與不隱藏時相同；前 N 名補滿；H 不出現在任何名單。
- URL：encode → decode 還原；未知子句、壞值、舊名字（別名）處理。
- 只隱藏的篩選不需要資料集（對快取直接後處理）。

### 4.5 執行期與每日

- 伺服器第一次被要求 `/games` 時自己比一次（§1.7）——這是唯一一定跑在 live 資料上的檢查（每日 commit 用 `GITHUB_TOKEN` 推送，不會觸發 test.yml）。
- 選配：每日 workflow 加 Node 比對步驟（§1.6），不一致時只推快取、不推資料集。

### 4.6 比對規則

`diffSections(expected, actual)`：數字用 `Number()` 後 `===`（`1080.0` = `1080`；不允許任何容差）；`null` / `None` 相同；物件比鍵集合（不比順序）；陣列依序逐項；字串完全相同。回報最多 50 個路徑，名字一律換成索引（`players[12]`、`playerDetails[#12]`），CI 日誌不出名字。

---

## 5. 效能預算與 Web Worker

| 項目 | 預算 | 依據 |
|---|---|---|
| 下載資料集 | ≤ 70 KB（gzip，2300 局）、一天最多一次（ETag / 304） | §1.4 實測縮放 |
| 解碼 + 衍生欄位 | 桌機 ≤ 20 ms、中階手機 ≤ 60 ms | 2300 局 × 17 欄 |
| 一次完整重算（全部區塊） | 桌機 30–80 ms、中階手機 p95 ≤ 500 ms（估計） | Python 全部約 0.54 s；BigInt 理論勝率實測 12.8 ms |
| 主執行緒 | 每次套用結果 ≤ 16 ms | worker 不產生 playerDetails（主執行緒需要時從 players 組），結構化複製約 1 MB |
| 引擎程式 | ≤ 25 KB gzip，只在 worker chunk、第一次用篩選才載入 | 預設畫面零成本 |
| 伺服器 | 第一次 `/games` 約 0.1–0.3 s（組 body、壓縮、執行期比對），之後只回 buffer | |

Worker 設計：
- `packages/web/src/stats/statsWorker.ts`（Vite `new Worker(new URL('./statsWorker.ts', import.meta.url), { type: 'module' })`）：訊息 `load {dataset, context}` → `ready`；`compute {id, filter, sections?}` → `result {id, result}` / `error {id, message}`。
- `engineClient.ts`：懶建立 worker；打開篩選面板時就預抓 `/games`；請求帶遞增 id，過期結果直接丟；同一個 `canonicalFilterKey` 的結果 LRU 8 筆；「評估集 = 未篩選」的玩家指標表每個資料集 key 只算一次。
- 編輯篩選時 250 ms debounce；超過 3 s 沒回應就 terminate 重建 worker 並顯示錯誤。
- 不支援 Worker 的環境（極少）在主執行緒跑，顯示轉圈。
- 網站資料流：`useStatsSection(name)`——沒有篩選時走原本的 API hook（現有快取），有篩選時取引擎結果（已經過 `served.ts`）；各分頁元件改用這個 hook（分頁檔案目前由 lane U 改版中，整合放在它合併之後）。

---

## 6. v1 範圍與之後

**v1（本輪）**
- 資料集 + 產生器重構（no-op）+ 守門 + workflow + 伺服器端點（含執行期比對）。
- 引擎：overview、players / playerDetails、outcomePair、missions、lake、rounds、seatOrder、captainAnalysis、leaderboard、L141；`served.ts`、`leaderboardV3.ts`、雷達組裝搬到 shared。
- 篩選引擎支援 §3.2 全部子句（每個都是幾行的判斷）；介面 v1 先做：預設集、分類、日期、排除玩家（名字 / 指標 / PR、兩種範圍、兩種評估集）、指定玩家（withPlayer）、10 人全寫、結果；其餘放「更多條件」抽屜（可分批上）。
- 只隱藏的篩選直接作用在快取資料（含試算表矩陣、strength）。
- 一致性 A / B / C 三道關。

**之後**
- 機器人：伺服器用同一個引擎（Node），以 `canonicalFilterKey` 做 LRU；文字語法（例：`/排行 線瓦`、`/戰績 玩家甲 面瓦`、`/排行 排除:角色理論PR>90`）；週報分類版；啟動時預先算好三個預設集。
- strength 重算（移植 `statistics.mean / pstdev`、`round(x, 1/2)`）。
- archetype / playstyle：來源是站長電腦的 TSV，沒有每局資料，**無法篩選**。
- featureStudies L136 / L139 / L142 / L143：需要每個提案 / 投票的資料 → 資料集 v2 加入嚴格重播解析（`sheetsReplay.parseReplayGame` 的結構，只存結構不存原文；資料集約變兩倍；只有 1970 / 2146 局能完整重播）；同時開放「首輪有人投異常票」這類投票層級的篩選。
- 試算表默契矩陣改由局計算（待 Edward，§8-4）。
- 使用者自訂預設集、伺服器端篩選結果（給不能跑 Worker 的環境 / 分享預覽圖）、產生器預先算好熱門預設集。
- 強人 / 戳人（需要定義，盤點 §6-6）。

---

## 7. 建議分工（給 GM）

| lane | 內容 | 相依 |
|---|---|---|
| 資料（Python） | §1.5 重構與 no-op 測試、encode/decode、note 白名單解析、守門、workflow、§4.2 fixture 腳本與參考篩選器、§4.3 測試 | 無；要先於 r6 產生器進 main 或一起進 |
| 引擎（shared） | §2 全部、§4.1 / §4.4 測試、served / LeaderboardV3 搬家 | fixture 腳本（可先用 `r9/inv/build4.py` 類的臨時腳本開發） |
| 篩選與端點 | `filter/*`、`/api/analysis/games`、執行期比對、URL | 引擎核心 |
| 網站 | worker、store、`useStatsSection`、篩選列、標記、分享連結 | 前三者 + lane U 合併後 |

上線順序：資料集與快取先一起產出（網站還不用）→ 端點與執行期比對 → 網站篩選列。第一次每日更新後 A 關從 skip 變成實際比對，那天要人工看一次結果。

---

## 8. 待業主（Edward）決定

1. **篩選時排行的「近 90 天有出賽 / 新人」看哪些局？** 建議預設「篩選後的局」（例：選面瓦時，近 90 天只打線瓦的人不上面瓦的榜），另提供「看全部局」（現役玩家的面瓦表現）與「不限」。日期區間結束在過去時，as-of 自動移到區間結束日。
2. **PR 的母體**：只在「有資格的人」中排（快照：角色理論 35 人、位置理論 41 人、整體理論 24 人），沒資格的人預設「不被排除」；同分規則 `(低於 + 0.5 × 同分) / n`。母體要不要只算近期有出賽的人？建議不要。
3. **玩家條件預設看未篩選的數字**（GM 已定）——請確認；「看篩選後」作為選項。
4. **試算表默契矩陣**（同贏 / 同輸 / 贏相關 / 同贏-同輸，停在 2025-08-13）：有篩選時 (a) 收起、只顯示 outcomePair，或 (b) 改由局計算（不篩選時的數字也會更新、與現在不同；`/默契` 一起改）？
5. **note 白名單**：賽季 S1/S2/S3/S5、地點清單、旗標（旁觀、不是我打的、覆盤、爛局、湖更正、代打、有事件）；以人命名的地點丟掉或改中性代號；「九號 / 9號」「古亭 / 古亭週五」要不要合併？
6. **名字沒寫齊的局**：排除某玩家的局時，要不要預設一併排除名字不全的局（選項已有）？建議預設不排除、介面註明。
7. **刺殺欄**在三紅局也有值（214 局，211 局是梅林座位）：資料集只在三藍局帶刺殺目標？（Python 區塊不用這欄，不影響一致性。）建議只帶三藍局。
8. **未分類（Discord匯入 沒標線瓦 / 面瓦）**：「只看線瓦」不含它們、「排除娛樂局」保留它們——可以嗎？
9. **分享連結含玩家名字明文**（名字本來就公開在網站上）——可以嗎？
10. **只隱藏時的總玩家數**：照算（「171 位，隱藏 5 位」）還是扣掉？建議照算。
11. **產生器把浮點 `sum()` 改成逐項相加**（3.11 數值不變，3.12+ 也一致）——同意？
12. **每日資料集出問題時**：照常更新快取、資料集暫停（網站顯示「篩選暫時無法使用」）、job 亮紅燈——同意？每日 workflow 要不要加 Node 比對步驟（+約 1 分鐘）？
