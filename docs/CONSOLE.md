# 主控台：系統圖、鏡像與編輯回流

站長 2026-11-18：「你主控台目前也沒跟百科網站作完整連動吧? (唯一來源 牌譜 資料庫同步 文章同步 等等的)」

原則只有一條：**repo `main` 是唯一來源**。主控台（站長私人的 claude.ai artifact）是 main 的**鏡像**，再加一個**編輯收件匣**：
站長在主控台按的裁定、開關、格式，先存在主控台自己的 db，由 Claude 依下面的合約寫回 repo（開 PR），合併後下一次匯出再鏡像回主控台。
主控台不是資料的正本，也不在主控台裡手工拼資料。

主控台頁面受 CSP 限制，**讀不到網站、也讀不到 GitHub**：它只能讀跟它一起發佈的檔案（`files`）和自己的 db。所以鏡像的方式是
「從 main 的 checkout 產生檔案 → 跟主控台頁面一起發佈」。

```
 Google Sheet（牌譜／模擬瓦／Discord匯入）─┐
 Discord 牌譜論壇 ─────────────────────────┤ 每晚 workflow           repo main（唯一來源）
 站上對局 avalon-game-records/ ─────────────┘ ──────────────────►  caches、game_db.json、wiki_data.json、
                                                                     concepts.json、threads_*.json、docs/threads/comments/
                                                                              │
                                              console:export（從 checkout）  │  ▲ console:apply（Claude 開 PR）
                                                                              ▼  │
                                                 主控台 artifact：鏡像檔（files）＋ 自己的 db（編輯收件匣）
```

## 1. 來源

完整的來源與衍生檔清單在 [`docs/architecture/sources.json`](architecture/sources.json)；主控台用到的是這些：

| 領域 | repo 裡的檔（正本或從正本產生） | 誰寫 | 主控台看到的 |
|---|---|---|---|
| 牌譜（實戰） | `packages/server/sheets_cache.json`、`games_cache.json`（試算表牌譜分頁） | `generate_cache.py`（每晚） | 問題牌譜、牌譜數量 |
| 牌譜（Discord／模擬瓦） | `packages/server/records_cache.json` | `discord_records_export.py`（每晚） | 同上 |
| 牌譜總庫 | `packages/server/game_db.json`、`docs/data/game_db_report.md` | `game_db.py`（每晚，讀上面兩個檔） | 同上 |
| 站長更正 | `packages/server/game_db_corrections.json` | console:apply（站長的裁定） | 套用後問題消失 |
| 玩家別名／拆分 | `packages/server/player_aliases.json`（`aliases` 合併、`splits` 同名不同人） | console:apply（站長的裁定） | 同名不同人候選（`name_collisions.json`） |
| ProAvalon（外部） | `packages/server/proavalon_games.json` | 預設不進總庫（2026-11-18） | 不顯示（`--with-proavalon` 才有） |
| 百科文章 | `packages/server/wiki_data.json` | 人工／PR | 文章清單 |
| 觀念卡 | `packages/server/src/bots/threads/concepts.json` | `concepts:apply`（docs/CONCEPTS.md） | 觀念卡 |
| Threads 題庫 | `packages/server/sim_bank.json` | `buildSimBank.ts` | 一週草稿 |
| Threads 選題 | `packages/server/threads_picks.json` | console:apply | 一週草稿、選局頁 |
| Threads 正式發開關 | `packages/server/threads_live.json` | console:apply | 開關狀態 |
| Threads 貼文／留言格式 | `packages/server/threads_template.json`（沒有就用內建格式） | console:apply | 範本編輯、草稿 |
| Threads 第一則留言 | `docs/threads/comments/<日期>.md` | Claude 寫、PR | 草稿的留言 |
| Threads 發文狀態 | `threads-state` 分支（`state/<日期>.json`、圖） | `threads-publish.yml` | 已發出（frozen） |

## 2. 每天的流程（台北時間）

| 時間 | 流程 | 寫什麼 |
|---|---|---|
| 03:17 | `import-discord-records.yml` | Discord 牌譜貼文匯入試算表的 Discord匯入 分頁 |
| 03:47 | `refresh-analysis-cache.yml` | `generate_cache.py` → `discord_records_export.py` → `game_db.py`；有變動才 commit 到 main |
| 每小時 :07 | `threads-publish.yml` | 讀 main 的 `threads_live.json`、`threads_picks.json`、`threads_template.json`、留言檔；試跑或正式發，狀態寫 `threads-state` |
| 每天（Claude 同步） | **console:apply → console:export** | 先把主控台 db 的編輯寫回 repo（PR），合併後從 main 匯出、重新發佈主控台 |

同步的順序固定是「先 apply、再 export」：export 只反映 main 上已經有的東西，所以 apply 的 PR 合併前，主控台會同時顯示「站長已裁定（db）」和「main 還沒套用（鏡像）」，這是對的狀態，不要在主控台裡把它抹平。

## 3. 主控台鏡像：`console:export`

```
pnpm --filter @avalon/server console:export -- --out <repo 外面的資料夾> [--date YYYY-MM-DD] [--state-dir <threads-state 的 clone>]
```

程式：`packages/server/scripts/consoleExport.ts`（文章、觀念卡、草稿、manifest）＋ `packages/server/console_export.py`（牌譜總庫是 Python）。
只讀這份 checkout（含 git 歷史），不連網路、不需要憑證。`--out` 不能在 repo 裡面（程式會拒絕）：問題牌譜含試算表原文，只給私人主控台。

| 檔 | 內容 | 主控台用在 |
|---|---|---|
| `problem_games.json` | 問題牌譜：`games`（id、分組、問題、規則、細節、選項、網站連結、來源標籤）＋ `records`（每一局每個來源的 DC 牌譜格式文字，試算表另附原文） | 問題牌譜分頁（取代手工的 `problem_records.json` 與 db 的 `games` 內容欄） |
| `game_counts.json` | 依種類／狀態的局數、錯誤局、問題分組數、「要注意」計數；`dbVersion` = commit；`gameDbInSync` | 牌譜數量（`meta/gameCounts`） |
| `concepts.json` | 觀念卡庫照抄；沒有卡庫時 `available: false` | 觀念卡 |
| `wiki_index.json` | 每篇文章的 id、標題、分類、章節（錨點與深連結）、網址、最後修改的 commit／日期 | 文章同步 |
| `week_drafts.json` ＋ `week_drafts/*.png` | 從 `--date` 起 7 天：貼文、第一則留言、圖、`parts`（範本佔位符的內容，都是字串）、`type`（題型 `{ kind, name }`，#89 的 `draft.parts.type`）、`frozen`；實際套用的範本與佔位符說明 | 一週草稿、範本編輯 |
| `name_collisions.json` | 同名不同人的候選（`name_collisions.py`）：`candidates`（規則 `a1`／`a2`／`b`、可信度、名字、局號、每群的日期／分類／Discord 標籤／牌友數、理由）＋每筆的 `suggested`（`nameSplits/<id>` 建議文件，見〈4. 編輯佇列〉）；`counts` 各規則的名字數與局數；`dbVersion` = commit。**這個檔的內容就是名字，一律含名字** | 同名不同人分頁（主控台頁面由站長另外做） |
| `manifest.json` | `sourceSha`（來源 commit，同 `source.sha`；另有 `dirty`）、`generatedAt`（產生時間，ISO、UTC）、每個檔的數量、注意事項 | 頁首「鏡像自 main @sha」與右上角的時間戳記 |

問題牌譜的分組（照 2026-11-17 第一版整理腳本移植，`test_console_export.py` 鎖住跟舊腳本一致）：
`excluded` 錯誤局 → `error` 規則錯誤 → `conflict` 來源不一致 → `dup` 疑似重複 → `stuck` 第 N、N+1 局黏在一起；一局只列在第一個符合的分組。
`problem_games.json` 預設不輸出玩家名字；`--names` 才在 `records` 加座位暱稱（只給私人主控台）。`name_collisions.json` 一律有名字（`--out` 本來就必須在 repo 外面）。

同名不同人的規則（`packages/server/name_collisions.py`，讀 `games_cache.json`，名字已套用別名與拆分；百科AI 局不算）：
`a1` 同一局兩個座位同名（確定：一個人不能坐兩個位置，多半是座位打錯，真的兩人同名才拆）→
`a2` 同一天、同分類、同場次的兩桌都有這個名字，兩桌共同的名字少於 6 個（很可能：資料沒有時刻，場次是各紀錄者自己數的；Discord 發文時間是上傳時間，常常一次補貼好幾局，不能當開局時間）→
`b` 這個名字的局分成幾群，群與群之間沒有任何共同的牌友（要人看；每局至少列了 5 個其他名字才算）。
建議的 `as` 是「名字（2）」「名字（3）」…（沒被用過的），`b` 建議把最大群以外的每一群各拆成一個人，`a2` 建議兩桌裡跟這個名字平常的牌友比較不重疊的那一局，`a1` 建議第二個座位（`seat`）。
公開的 `docs/data/game_db_report.md` 只有各規則的數量（`game_db.py` 每晚寫），名字只在這裡。

主控台另外還讀 `candidates.json`、`games.json`（`threads:candidates` 產生）和 `players.json`，這三個還沒併進 console:export。

發佈：Claude 把 `--out` 的檔案用 artifact 的 `files` 跟主控台頁面一起發佈（同一個網址）；主控台 db 裡的內容欄（例如 `games` 的問題文字）以鏡像檔為準，db 只留站長的回答與狀態。

**每一次同步或重新發佈主控台，兩個時間都要更新**：重新跑 `console:export`（`manifest.json` 的 `generatedAt`、`sourceSha` 跟著換），
並把 db 的 `meta/summary.updatedAt` 寫成同一次同步的時間。主控台右上角的時間戳記顯示這兩個裡比較新的那個；只更新其中一個，
另一個就會停在舊的時間，看起來像沒同步（2026-11-18 就發生過 `meta/summary.updatedAt` 沒更新、戳記停住）。

## 4. 編輯佇列：`console:apply`（合約）

主控台 db 裡每一筆站長的編輯都照下表寫回 repo。共同規則：

- **誰套用**：Claude（每天同步時，或站長說「套用」時）。程式化的 applier 一種一種補；還沒有程式的就由 Claude 照表手動改檔。
- **怎麼進 main**：一律開 PR（分支 `claude/console-apply-<日期>`），標題寫套用了哪幾筆；PR 合併才算套用。不直接推 main。
- **回寫主控台**：合併後在那筆 db 文件寫 `appliedSha`（main 的 commit）與 `appliedAt`；被拒絕或不能套用的寫 `applyError`（原因）。下一次 export 的 `manifest.source.sha` 包含 `appliedSha`，主控台就能顯示「已進 main」。
- **冪等**：同一筆編輯套兩次結果一樣（以 db 文件的 id 當鍵）；套用前先讀 repo 現況，已經一樣就只回寫 `appliedSha`。
- **隱私**：寫進 repo 的只有座位、牌譜記號、id、日期與站長的裁定說明；不寫玩家名字、聊天內容或憑證（repo 是公開的）。唯一的例外是站長自己的 `packages/server/player_aliases.json`：別名與拆分（同名不同人）的名字只寫在那裡。

| 編輯（主控台 db） | 寫到 repo 的哪裡 | applier | 套用後怎麼確認 |
|---|---|---|---|
| 問題牌譜裁定：`games/<id>` 的 `answer`／`answerText`／`correctedRecord`、`decisions/<id>` | `packages/server/game_db_corrections.json`：`set`（只能改 config、rounds、lakes、assassination、outcome；重打整局要五欄都給）或 `exclude`（ASSASSIN_TEAMMATE、FORCED_NOT_RUN），附 `by`、`date`、`note`；再跑 `python packages/server/game_db.py` 重建總庫與報告 | Claude 手動（`game_db.py` 的 `apply_corrections` 會驗證欄位） | 下一次 export 的 `problem_games.json` 不再列這一局 |
| 「我在來源改好了」：`fixes/<id>` 的 `owner_fixed` | 不改 repo：等每晚的快取更新從試算表／Discord 讀到新版 | 每晚 workflow | export 後那一局消失；還在就回寫 `applyError` |
| Threads 正式發開關：`meta/threadsLive`（liveFrom、paused） | `packages/server/threads_live.json` | Claude 手動（檔案格式見檔內 note 與 docs/THREADS.md〈自動發佈〉） | `threads-publish.yml` 的閘門摘要 |
| 貼文／留言格式：`meta/postTemplate` | `packages/server/threads_template.json`（`post`、`comment`、`updatedAt`；要通過 `template.ts` 的 `validateTemplate`） | Claude 手動 | export 的 `week_drafts.json` 的 `templateSource` 變成 `file` |
| 選題：`picks/<日期>` 的 `exerciseId` | `packages/server/threads_picks.json` 的 `picks` | Claude 手動 | export 的那一天 `exerciseId` 變成選的題號 |
| 草稿：`drafts/<日期>` 的 `commentEdit` | `docs/threads/comments/<日期>.md`（格式見那個資料夾的 README） | Claude 手動 | export 的 `commentSource` 變成 `file` |
| 草稿：`drafts/<日期>` 的 `postEdit`、`note` | 沒有對應的檔：貼文是產生的。改成選題、範本或程式的修改再套用；做不到就回寫 `applyError` | Claude 判斷 | — |
| 觀念卡編輯 | `packages/server/src/bots/threads/concepts.json` | `concepts:apply <edits.json>`（格式與驗證見 [docs/CONCEPTS.md](CONCEPTS.md)；`concepts:export` 另給每張卡的待複查旗標與章節目錄） | export 的 `concepts.json`、`concepts:check` 待複查 0 |
| 玩家別名：`aliasDecisions/<key>` | `packages/server/player_aliases.json` | Claude 手動 | 每晚的快取更新合併那位玩家 |
| 同名不同人：`nameSplits/<id>`（`status: 'confirmed'`；每天 08:00 的例行同步套用） | `packages/server/player_aliases.json` 的 `splits`：在 `name` 那一筆（沒有就新增）加一條規則 `{"as": as, "games": games}`，有 `seat` 就帶上，`note` 寫 `nameSplits/<id>` 與站長的說明；格式與驗證見 docs/stats/two_stage_outcome.md〈玩家別名〉的「拆分」。再跑 `python packages/server/generate_cache.py --compare`（本機）確認那幾局改算 `as`、守門通過 | Claude 手動（`parse_player_splits` 會驗證） | 下一次 export 的 `name_collisions.json` 不再列這一筆（那幾局已是 `as` 的名字）；報告〈同名不同人〉的「已拆開」局數 |
| 收件匣：`items/<id>` 的 `reply`、`status` | 看內容：多半是開 issue 或 PR | Claude 判斷 | 回寫 `appliedSha` 或關聯的 PR |

`nameSplits/<id>` 的文件格式（站長確認拆分；id 是 `name_collisions.json` 給的 `ns_<12 hex>`，同樣的名字＋局號＋座位每次匯出都是同一個 id，所以已經回答過的不會重複出現）：

```json
{
  "name": "牌譜上的名字（戰績顯示的那個）",
  "games": ["S572", "D1b044c559d"],
  "as": "另一個人的名字",
  "status": "pending",
  "seat": "0",
  "rule": "b",
  "reason": "為什麼懷疑（匯出時帶的，給站長看）"
}
```

- `name`、`games`（局號：`S` + 流水號、`D` + Discord匯入編號；站長也可以改成 Discord 貼文編號）、`as`、`status` 必填；`seat` 只有同一局兩個座位同名時才有；`rule`、`reason` 是匯出帶的說明，套用時不寫進 repo。
- `status`：`pending`（匯出的建議，還沒看）→ 站長改成 `confirmed`（是兩個人；`as` 和 `games` 可以先改）或 `rejected`（是同一個人，不拆）。只有 `confirmed` 會被套用；`rejected` 留在 db，下次匯出同一個 id 時主控台就知道已經回答過。
- 套用後照共同規則回寫 `appliedSha`／`appliedAt`（不能套用的寫 `applyError`，例如 `as` 是某個別名的舊寫法）。
- 隱私：`player_aliases.json` 是站長的檔，名字只寫在那裡；PR 標題與內文、commit 訊息只寫「拆分 N 筆」與局號，不寫名字。

主控台唯讀、由 Claude 同步時照 repo 寫的：`meta/gameCounts`（＝ `game_counts.json`）、`meta/summary`、`posted/<日期>`（＝ `threads-state` 的發文紀錄）。

## 5. 驗證

- `python packages/server/test_console_export.py`：牌譜這一半在 fixture 上跟舊整理腳本一致、重跑一字不差、fixture 沒有玩家名字。
- `python packages/server/test_name_collisions.py`：同名不同人的三條規則、建議文件的格式與 id、公開報告只有數量。
- `pnpm --filter @avalon/server exec vitest run src/__tests__/ConsoleExport.test.ts`：文章清單、最後修改的 commit、觀念卡、manifest；整支程式重跑一字不差、拒絕把輸出寫進 repo。
- `pnpm --filter @avalon/server type-check:scripts`：匯出程式的型別檢查（`scripts/` 不在 `tsc --noEmit` 的範圍）。
