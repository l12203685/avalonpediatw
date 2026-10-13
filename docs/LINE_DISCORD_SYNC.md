# LINE / Discord 同步 — 操作與驗證

> 版號 20261008。對應 `tree_registry/architecture/avalon_line_sync.md`（2026-04-26 架構鎖）
> 與 `tree_registry/branches/avalon.md` §2026-09-07（第 5 次故障診斷）。

## 結論

1. **Render 這一側的直接原因**：2026-06-25 重建 `render.yaml` 時沒帶任何 LINE / Discord 變數，
   正式機開機時 Discord bot、LINE bot、ChatMirror 三者全部被跳過，`/webhook/line` 路由也沒註冊。
   程式碼本身一直都在，只是沒有被餵設定。
2. **五次故障的共同結構性原因是 Layer 1**：LINE webhook URL 一直是「在 LINE Console 手動設、code 不知道」。
   後端每搬一次家（Render → ngrok → Cloudflare quick tunnel → Cloud Run → Render）就孤兒一次。
   本次把 webhook URL 的所有權搬進 code：開機自動 `PUT` 到 LINE Messaging API、每 6 小時重查、
   結果掛在 `/api/bots/status`、CI 每天探測一次。架構鎖點名的三個檢查這次全部落地。
3. **LINE 出站改走 reply_token 排隊**（免費額度路線），不再逐則 push。Render 上沒有
   edward-listen-bot，所以把 listen-bot 的 drain 邏輯搬進 server 內部；修掉了 09-07 查到的
   「送失敗就把訊息丟掉」那個洞（失敗回填佇列頭）。

## 拓撲

```
            fanout / crossFanout
  網頁大廳 ◀───────────────────────▶ server (ChatMirror)
                                        │            ▲
                   push / reply ────────┤            │ webhook POST /webhook/line
                                        ▼            │ (簽章驗 raw bytes)
                                    LINE 群 ─────────┘

                                        │            ▲
                  channel.send ─────────┤            │ messageCreate (gateway)
                                        ▼            │
                                   Discord 頻道 ─────┘
```

- 每一則訊息帶 `source`（`lobby` / `line` / `discord`），出站只送到「不是來源」的平台，不會迴圈。
- 統一格式 `[MMDD hh:mm][AP|LINE|DC][名字] 內容`（2026-04-24 Edward 指令，+08）。
- LINE 出站：有 `LISTEN_BOT_ENQUEUE_URL` → 走 listen-bot；否則 `LINE_REPLY_DRAIN`（預設 true）→ 排隊，
  等鏡像群任何一個帶 reply_token 的事件（文字、貼圖、加入…）一次最多帶 5 則回出去；
  `LINE_REPLY_DRAIN=false` 才逐則 push。
- 圖片、貼圖、檔案（20261013 起）：見下方「圖片同步」。

## 三層驗證（這次才真的存在）

| 層 | 檢查什麼 | 誰在做、多久一次 |
|---|---|---|
| Layer 1 · webhook URL | `line.webhook.actual == expected` 且 `active == true` | server 開機 + 每 `LINE_WEBHOOK_RECHECK_MIN`（預設 360）分鐘；CI `verify-line-webhook.yml` 每日 09:17 +08 |
| Layer 3 · bot 活著 | `discord.ready` / `line.ready` / `error` | 同上 |
| round-trip | 大廳→LINE 佇列+Discord、LINE webhook→大廳+Discord+drain、Discord→大廳+LINE 佇列、簽章、迴圈 | `pnpm test:line-sync`（本機與 `test.yml`） |

CI 探測**不需要任何 LINE 憑證**：它只讀正式機公開的 `/api/bots/status`，特權動作（GET/PUT LINE）
已經由 server 自己在開機時做完。網址取 repo Variable `PUBLIC_SERVER_URL`，沒設就沿用既有的
secret `VITE_SERVER_URL`（玩家前端連的那個後端，探測玩家實際在用的網址）；兩者皆無則印 skipped 結束，不會假綠。

## `/api/bots/status` 怎麼讀

```json
{
  "generatedAt": "2026-10-08T01:17:03.000Z",
  "keepAlive": { "enabled": true, "url": "https://<service>.onrender.com/health", "intervalMs": 600000,
                 "lastOkAt": 1791314100000, "lastError": null, "consecutiveFailures": 0 },
  "discord": { "enabled": true, "ready": true, "error": null, "mirrorChannelConfigured": true },
  "line": {
    "enabled": true, "ready": true, "error": null,
    "commandsEnabled": false, "mirrorGroupConfigured": true,
    "outbound": "reply-drain", "replyQueueSize": 0,
    "webhook": {
      "expected": "https://<service>.onrender.com/webhook/line",
      "actual":   "https://<service>.onrender.com/webhook/line",
      "active": true, "autoset": true, "action": "noop",
      "verified": true, "lastCheckedAt": 1791314223000, "lastError": null
    },
    "stats": { "requests": 12, "signatureFailures": 0, "events": 12, "mirrorGroupEvents": 11,
               "repliesDrained": 7, "replyFailures": 0, "lastEventAt": 1791314200000 }
  },
  "feedback": {
    "commandEnabled": true,
    "weeks": [ { "week": "2026-W42", "line": { "排行": 3, "問題": 1 }, "discord": { "機器人": 2 } } ],
    "opinions": { "line": 1, "discord": 0 }
  },
  "chatExport": {
    "enabled": true, "sheetConfigured": true, "publicSheet": true,
    "lastRun": { "day": "2026-10-12", "at": "2026-10-13T02:03:40.000Z", "messages": 356, "channels": 8, "threads": 3, "truncated": 0, "outcome": "written" },
    "catchUp": { "startedAt": "2026-10-13T02:01:05.000Z", "from": "2026-10-06", "to": "2026-10-12", "exported": 7, "skipped": 0, "failed": 0, "pending": 0, "expired": 0 }
  }
}
```

`feedback` 是社群反應的主題計數與 `/意見` 次數（只有數字，見 `docs/COMMUNITY_FEEDBACK.md`）。
`chatExport` 是每日聊天紀錄匯出（每天 04:30 +08 起把前一天的聊天寫進**阿瓦隆百科試算表**的「聊天紀錄」分頁，只留 7 天；重啟後補齊最近 7 天。
那份試算表知道連結的人都能看，發言者換成每天重新編號的「成員N」；Edward 2026-10-13 決定）：
三個布林（含 `publicSheet`）＋最近一天的日期、時間、則數、頻道數與結果代碼＋補齊的天數，沒有任何文字或名字；`lastRun`、`catchUp` 重啟後是 `null`（見 `docs/COMMUNITY_FEEDBACK.md`）。
2026-10-13 以前的 `communityDigest`（付費週報）已移除。

| 欄位 | 意義 | 不對時代表 |
|---|---|---|
| `generatedAt` | 這份快照的時間 | 先看這個，舊快照不算綠燈 |
| `line.webhook.action` | `noop` 已一致 / `updated` 剛改回來 / `report-only` 有漂移但未改（autoset=false）/ `failed` API 失敗 / `skipped` 沒 token 或算不出 URL | `failed` 看 `lastError`；`skipped` 看環境變數 |
| `line.webhook.active` | LINE Console「Use webhook」開關，API 改不了 | `false` → 進 Console 打開 |
| `line.webhook.verified` | LINE 自己打一次 endpoint 的結果 | `false` → 對外網址不通（冷啟動中、tunnel 死、憑證錯） |
| `line.stats.signatureFailures` | 簽章驗不過的次數 | 持續增加 → channel secret 填錯或 body 被中間層改寫 |
| `line.stats.lastEventAt` | 最後一次收到 LINE 事件 | 群裡剛講話卻沒動 → webhook 沒進來（Layer 1） |
| `line.replyQueueSize` | 等著回 LINE 的訊息數 | 一直很高 → LINE 群沒人講話（設計如此）或 reply 一直失敗（看 `replyFailures`） |
| `discord.ready` | gateway 連線中 | `false` 且 `enabled` → token 錯、或 MESSAGE CONTENT INTENT 沒開、或 Render 剛喚醒 |
| `keepAlive.enabled` | 自我喚醒是否在跑 | Render 上為 `false` → 15 分鐘沒人用就休眠，Discord 腿跟著斷 |
| `chatExport.sheetConfigured` | 有試算表 id，而且 `GOOGLE_SERVICE_ACCOUNT_JSON` 讀得懂 | `false` → Render 少了服務帳號 JSON（跑一次 Render ops → apply）、`CHAT_EXPORT_SHEET_ID=off`，或設了 `CHAT_EXPORT_ALLOW_PUBLIC_SHEET=0`（阿瓦隆百科試算表被拒絕） |
| `chatExport.lastRun.outcome` | 最近處理的那一天的結果 | `written` 寫好了；`already-exported` 那天早就寫好（「匯出紀錄」有「完成」，例如重啟後）；`empty` 那天沒有聊天；`claimed-elsewhere` 另一台伺服器正在寫那天（部署交接時會出現，10 分鐘後再看）；`sheet-error` 試算表寫不進去（多半是沒分享給服務帳號，10 分鐘後重試）；`tab-conflict` 試算表裡有同名但不是 bot 的分頁；`read-error` 有頻道讀不到（不會當成沒聊天，10 分鐘後再讀）；`error` 未預期的錯誤（看 server log）；`not-configured` 見上一列。`catchUp.failed` > 0 表示補齊時有日子還沒寫好 |

## 環境變數（Render Dashboard → 服務 → Environment）

需要手填（機密，`sync: false`）只有 4 個：

| 變數 | 來源 | 缺了會怎樣 |
|---|---|---|
| `DISCORD_BOT_TOKEN` | Discord Developer Portal → 阿瓦隆 bot（App `1138799027664732180`）→ Bot | Discord 腿停用（LINE 不受影響） |
| `LINE_BOT_CHANNEL_ACCESS_TOKEN` | LINE Console → 阿瓦隆百科 channel → Messaging API → long-lived token | LINE 腿停用 |
| `LINE_BOT_CHANNEL_SECRET` | LINE Console → Basic settings | 簽章全部 401 |
| `LOBBY_MIRROR_LINE_GROUP_ID` | 阿瓦隆百科 LINE 群 `C…` id（不知道見下方「找群組 ID」） | LINE 腿變 no-op |

藍圖已填好、不用動：

| 變數 | 值 | 說明 |
|---|---|---|
| `DISCORD_CLIENT_ID` | `1138799027664732180` | 阿瓦隆 bot 的 Application ID（公開值） |
| `LOBBY_MIRROR_DISCORD_CHANNEL_ID` | `1132901301802504242` | 原本 listen-bot 的阿瓦隆同步頻道（公開值） |
| `LINE_WEBHOOK_AUTOSET` | `true` | false = 只回報漂移、不寫 LINE |
| `LINE_REPLY_DRAIN` | `true` | false = 逐則 push，吃每月免費額度 |
| `KEEP_ALIVE` | `true` | false = 允許 Render 休眠 |
| `WEB_BASE_URL` | 玩家前端網域 | bot 產生的連結 |

`LINE_WEBHOOK_URL` / `PUBLIC_BASE_URL` 只有**非 Render** 部署才需要；Render 自動用 `RENDER_EXTERNAL_URL`。

`DISCORD_GUILD_ID` 可選（只在單一伺服器註冊指令，測試較快）。

社群相關（`docs/COMMUNITY_FEEDBACK.md`）：

| 變數 | 機密 | 預設 |
|---|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | 是（Render ops → apply 從 GitHub secret `AVALON_STATS_SHEETS_CREDENTIALS_JSON` 複製） | 沒有 → 不匯出聊天紀錄 |
| `CHAT_EXPORT_ENABLED` | 否 | 開；`false` 關 |
| `CHAT_EXPORT_SHEET_ID` | 否 | 阿瓦隆百科試算表（知道連結就能看；Edward 2026-10-13 決定）；填私人那份的 id 就改寫那份；`off` 關 |
| `CHAT_EXPORT_ALLOW_PUBLIC_SHEET` | 否 | 不設＝照寫阿瓦隆百科試算表；`0`（或任何不是「是」的值）＝拒絕那份、不匯出（見 `docs/COMMUNITY_FEEDBACK.md`） |
| `CHAT_EXPORT_EXTRA_SOURCE_IDS` / `CHAT_EXPORT_SOURCE_CHANNEL_IDS` / `CHAT_EXPORT_EXCLUDE_CHANNEL_IDS` | 否 | 空（所有公開頻道、公開論壇＋同步頻道；「大劍管理員」和 `/意見` 頻道一定不讀）；加讀／取代／排除，見 `docs/COMMUNITY_FEEDBACK.md` |
| `FEEDBACK_DISCORD_CHANNEL_ID` | 否 | 管理員頻道「大劍管理員」`1145513360545296574`；`off` 不轉貼 |
| `FEEDBACK_COMMAND_ENABLED` | 否 | 開；`false` 關 `/意見` |

## 一次性設定（Edward 動手）

1. **唯一必做**：Render Dashboard → 服務 → Environment，填上表 4 個值 → Save → 自動重新部署。
2. 以下後台設定以前的同步就依賴它們，多半已是對的；上線後 `/api/bots/status` 與每日 CI 會點名哪一項不對，屆時再改：
   - LINE Console → Messaging API：**Use webhook ON**（狀態頁 `line.webhook.active`）、**Webhook redelivery ON**、
     **Auto-reply / Greeting OFF**（會搶 reply_token）。**Webhook URL 不用手填**，server 開機會自己寫入。
   - Discord Developer Portal → Bot：**MESSAGE CONTENT INTENT ON**（沒開時狀態頁 `discord.error` 會寫 disallowed intents）。
3. 驗證：
   - LINE 群講一句 → Discord 頻道出現 `[…][LINE][名字] …`。
   - Discord 頻道講一句 → **回 LINE 群再講一句** → 剛才那句以 `[…][DC][…]` 補進來。延遲是設計，不是壞。
   - Actions → Verify LINE webhook → Run workflow → 綠（每天 09:17 +08 也會自動跑）。

### 找群組 ID

LINE 群組 ID 只能從 webhook 事件得知。`LOBBY_MIRROR_LINE_GROUP_ID` 先空著、其他 3 個填好部署後，
在阿瓦隆百科 LINE 群講一句話 → Render → Logs 搜 `[LINE] event from group` → 那行最後的 `C…` 就是，
貼回 `LOBBY_MIRROR_LINE_GROUP_ID` 再存一次。只印在 server log，不會出現在公開的狀態頁。

## 單一擁有者規則

一個 LINE channel 同時只有一個 webhook URL。**只允許一個部署開 autoset。**
若地端 systemd 的 server 或 edward-listen-bot 也在服務同一個 channel，二擇一：

- 地端設 `LINE_WEBHOOK_AUTOSET=false`，且不要再手改 Console；或
- Render 設 `LINE_WEBHOOK_AUTOSET=false`，由地端持有。

兩邊都開 = 每次 Render 喚醒就互搶一次，症狀會是「時好時壞」。
如果要讓 listen-bot 持有，`LINE_WEBHOOK_URL` 就填 listen-bot 的路徑（例如 `https://<host>/line/webhook/avalon`），
server 會把那個值 PUT 上去，自己不收 webhook。

## Render Free 休眠（已處理，20261009）

Free 方案閒置 15 分鐘會休眠：Discord gateway 斷線（期間 Discord 的訊息永遠收不到）、reply 佇列與大廳聊天清空、
LINE 第一發 webhook 逾時。server 每 10 分鐘打一次自己的公開網址 `/health`（經過 Render 邊緣，算 inbound），
因此不會休眠。免費、不靠外部服務；單一服務全月常駐 ≤ 744 小時，低於 Render 每個 workspace 每月 750 小時的免費額度。

| 注意 | 內容 |
|---|---|
| 同 workspace 第二個常駐 Free 服務 | 兩個加起來會超過 750 小時，超過後所有 Free 服務停到下個月 |
| 重新部署／Render 重啟 | 開機後自動恢復自我喚醒，不需人工 |
| 要關掉 | `KEEP_ALIVE=false` |

## 戰績查詢指令與每週排行（20261010）

對局在 signage-cloud，戰績照舊記在 Google Sheet → `analysis_cache.json`；Discord 與 LINE 群都能查。
兩邊指令寫法相同，回覆文字也相同（`bots/stats/`，一則 ≤ 1800 字）。

| 指令 | 回覆 | Discord | LINE（鏡像群、1 對 1） |
|---|---|---|---|
| `/戰績 名字` | 場次、**最終勝率**、超額勝率；任務結算 → 刺殺結算 → 最終；紅／藍方最終勝率；擅長角色、風格、對戰風格、網站連結（口徑見 `docs/stats/two_stage_outcome.md`；不再顯示「角色理論勝率」） | slash 指令，公開回覆 | ✓ |
| `/排行`（`/排行榜`） | 快取 `leaderboard` 的主榜：超額勝率 Top 10（標題含期間與門檻：近 90 天內有出賽、期間至少 20 場），每行「名次 名字 超額 ±x｜最終 y%｜n 場」＋總計（最終紅勝／藍勝、任務結算、三藍局刺中率）。舊快取退回全期超額或理論勝率 | ✓ | ✓ |
| `/默契 名字1 名字2` | 同隊場次、一起贏／一起輸、同隊勝率（默契矩陣只收場次最多的 28 位；沒有「對戰」數據） | ✓ | ✓ |
| `/意見 文字` | 固定回覆「已收到」，內容匿名轉貼到管理員頻道「大劍管理員」（`FEEDBACK_DISCORD_CHANNEL_ID` 可改；見 `docs/COMMUNITY_FEEDBACK.md`） | slash 指令，只有本人看得到回覆 | ✓ |
| `/指令` | 指令說明（Discord 看 `/help`） | — | ✓ |

- 2026-10-13 起沒有 `/社群週報` 了（付費週報移除；指令清單每次開機整批覆寫，部署後就從 Discord 消失）。
  機器人不回一般聊天，只回上表的指令。
- 名字比對：完全相同 → 不分大小寫 → 唯一的部分字串；多人符合列出最多 5 位，查無此人會提示查詢指令。
  表單裡有只差大小寫的不同玩家（`Sin` / `SIN` / `sin`），完全相同優先，卡片會註明另有哪些寫法。
- Discord 指令名直接用中文（Discord 允許），和 LINE 寫法一致，任何介面語系都一樣；從「/」選單點選即可，不必切輸入法。
- LINE：在鏡像群裡指令那句**照常同步**到 Discord／大廳，答案只回 LINE。答案和佇列共用同一個 reply_token：
  一次 `replyMessage`、最多 5 則 = 答案 1 則 + 佇列 4 則，其餘留到下一次；回覆失敗只把取出的佇列訊息放回佇列頭（答案不重送）。
- 開關：`LINE_STATS_COMMANDS_ENABLED`（預設開，`false` 關），與舊的 `LINE_BOT_COMMANDS_ENABLED`（遊戲指令，預設關）分開；
  狀態頁 `line.statsCommandsEnabled`、`line.stats.statsReplies`。

**每週排行**：每週一 12:00（+08）把排行貼到 Discord 同步頻道（`LOBBY_MIRROR_DISCORD_CHANNEL_ID`），
內容 = 主榜 Top 10 ＋ 近 90 天 Top 5 ＋ 上月角色王一行（超過 1800 字時從後面的榜開始省略），
同時排進 LINE reply 佇列（免費，群裡下一次有人講話時送出；不會 push）。只在 12:00–12:10 的窗口內發，
同一週只發一次（記在記憶體）；窗口外重啟絕不重發，窗口內 Discord 還沒連上會每分鐘重試到 12:10。
`STATS_DIGEST_ENABLED=false` 關閉；狀態頁 `statsDigest.lastPostedWeek` 顯示最近一次發送的週一日期（重啟歸零）。

## 圖片同步（20261013）

以前只同步文字，圖片在兩邊都會消失。現在 LINE 群 ↔ Discord 同步頻道兩邊的圖片都會過去，
全部免費：不用 push、不用付費 API、不用外部儲存。

| 從 → 到 | 怎麼送 | 限制與例外 |
|---|---|---|
| LINE 群的圖片 → Discord 同步頻道 | server 用 LINE 內容 API（同一組 channel access token，免費）下載，當**附件**貼出，內文 `[MMDD hh:mm][LINE][名字] （圖片）`；一次傳多張 → 每張一則，標 `（圖片 1/3）`、`（圖片 2/3）`… | 超過 Discord 上傳上限（一般 10 MB；伺服器加成 2 級 50 MB、3 級 100 MB；最多讀 25 MB）→ 改貼文字 `（圖片太大，請到 LINE 看）`；下載失敗、下載超過 30 秒或 bot 沒有附加檔案權限 → `（圖片沒有同步過來，請到 LINE 看）` |
| LINE 貼圖／影片／語音／檔案／位置 → Discord 與網站大廳 | 一句固定短文字：`（貼圖）`、`（影片，請到 LINE 看）`、`（語音訊息，請到 LINE 聽）`、`（檔案，請到 LINE 看）`、`（位置資訊，請到 LINE 看）` | 不下載、不轉內容、不帶檔名或地址 |
| Discord 同步頻道的圖片（可附文字）→ LINE 群 | 訊息進來後幾秒內 server 先把圖下載存一份，排進 reply 佇列：先一句 `[…][DC][名字] 文字 （圖片）`，接著每張一則 LINE 圖片訊息，網址是 `https://<server>/media/relay/<隨機碼>.jpg` | 只收 JPEG／PNG、≤ 10 MB（以 10,000,000 bytes 計）、不是防雷（spoiler）圖；超過 1 MB（1,000,000 bytes）的圖另向 Discord 媒體代理拿縮圖當預覽（LINE 規定預覽 ≤ 1 MB）；一則 Discord 訊息最多 4 張圖（文字＋4 張剛好一次回覆）。其餘的、webp／gif／heic、太大、下載失敗 → 一句 `（Discord 有一張圖片，請到 Discord 看）` 或 `（Discord 有 2 張圖片、一個檔案，請到 Discord 看）` |
| Discord 貼圖／其他檔案 → LINE 與大廳 | 文字後面加 `（貼圖）`／`（檔案）`；檔案另加一句「請到 Discord 看」 | 不轉檔案、不帶檔名 |
| 任何圖片 → 網站大廳 | 只有文字標記 `（圖片）`（LINE 一次多張 → 一句 `（圖片 ×3）`），網頁不顯示圖 | |

LINE 這一側照舊是「群裡下一次有人講話才送出」：圖片和文字排在同一個佇列、同樣的順序、一次回覆最多 5 則（一張圖算一則）。

**順序與下載量**（審查後修正）：

- 網站大廳：訊息一進來就顯示（圖片只顯示標記），順序就是進來的順序；限流也在這一刻算，被限流的訊息完全不下載。
- Discord → LINE：所有 Discord 訊息依進來的順序排隊進 LINE 佇列。前一則的圖還在下載時，後面的文字會等它（LINE 本來就要等群裡有人講話才送，多等幾秒看不出來），
  所以 LINE 上看到的順序和 Discord 一樣。下載一次只跑一張（不管幾個人同時貼），一則訊息所有下載合計最多 45 秒，超過的圖改成那句文字說明；
  已經有 10 則在等的時候，新訊息的圖不下載、直接改文字說明。
- LINE → Discord：圖片一張一張上傳；同一個人先傳圖再打字時，文字會等前面的圖貼完再貼（最多等 20 秒），所以 Discord 上也是先圖後字。
  沒有圖在處理時，文字照舊立刻貼。單張圖下載超過 30 秒、或整個上傳流程超過 60 秒就放棄，不會卡住後面的圖。

**為什麼 Discord → LINE 要先存一份**：LINE 的圖片訊息只是兩個 https 網址，由 LINE 自己來抓；我們的出站是 reply 佇列，
可能幾小時後才送出，Discord CDN 的簽名網址到時已經過期。所以 server 在 Discord 訊息進來時就下載，從自己的網址提供：

- 網址帶 192 位元隨機碼，猜不到；不寫進 log、不出現在狀態頁。查無、過期、格式不對一律 404。
- 只放記憶體，總量上限 50 MB，每張最多保存 72 小時；真的送出時延長到送出後至少 24 小時（以防 LINE 要等有人點開大圖才來抓）。
  滿了先丟過期的，再丟「還沒送出」裡最舊的（那張之後會改成文字說明），最後才丟「已送出」的，因為已送出的副本不見了，LINE 上會變成一張打不開的圖、而且沒有任何地方會報錯。
- **重開機就清空，而 Render 每次部署都會重開**：除了合併到 main，每天的戰績快取 commit（`chore(stats)`，改 `packages/server/analysis_cache.json`）也會觸發部署，
  所以實際上**至少每天清空一次**，「72 小時」只是上限。reply 佇列本來也在記憶體，會一起清空；佇列裡的圖若副本已經不在（過期、被擠掉），送出時自動改成那句文字說明。
- 還沒在正式環境確認的一點：LINE 是送出當下就來抓圖，還是等有人點開才抓。**上線後請確認一次**：在 Discord 同步頻道貼一張圖 → 回 LINE 群講一句讓它送出 →
  一分鐘內看 `/api/bots/status` 的 `mediaRelay.stats.served`。有增加 1～2 → LINE 送出時就抓走了，部署只影響還在佇列裡的圖（會改成文字說明）；
  一直不動、要等有人點開圖才增加 → 部署前送出的圖，部署後在 LINE 點開會是壞圖。
- LINE 拒收某張圖的網址，或同一張圖連續兩次回覆失敗 → 改送文字說明，不會卡住整個佇列；文字訊息的「失敗放回佇列頭」規則不變。
- 只有 reply 佇列模式（`LINE_REPLY_DRAIN` 預設開）而且算得出 https 公開網址時才送圖（Render 自動用 `RENDER_EXTERNAL_URL`；
  其他部署設 `PUBLIC_BASE_URL`，或沿用 `LINE_WEBHOOK_URL` 的網域）；否則只送文字標記。`CHAT_MIRROR_IMAGES=false` 可單獨關掉
  Discord → LINE 的圖（改文字說明）；LINE → Discord 的圖不受影響。

**不會迴圈**：bot 自己貼到 Discord 的圖（作者是 bot）、webhook、`[Avalon]` 開頭的訊息照舊忽略；LINE 來的圖只到 Discord，不會排回 LINE。
**聊天紀錄匯出**：bot 貼的那則圖片只有固定標記 `（圖片）`，匯出時名字照樣換成「成員N」；檔名、網址、圖片內容都不會進試算表（附件只算數量）。
目前這種只有標記的貼文（`（圖片）`、`（貼圖）`、`（圖片沒有同步過來…）`）會各成一列，而 Discord 那邊只有附件沒有文字的訊息會被略過；要不要把只有標記的列也略過，由聊天紀錄匯出那邊決定。
**Log 與狀態頁**只有次數與結果代碼（例如 `picture outcome=too-large`、`status=403 code=50013`），沒有文字、名字、網址：

| 欄位 | 意義 |
|---|---|
| `line.stats.imagesToDiscord` / `imageNotesToDiscord` | LINE → Discord：上傳成功／改貼文字說明 |
| `line.stats.imagesSkipped` | LINE → Discord：限流或排隊太多（> 20 張）而略過 |
| `line.stats.imageFailures` | LINE → Discord：圖和文字說明都沒貼出去（找不到同步頻道、Discord 貼文失敗、整個流程超過 60 秒） |
| `line.stats.mediaNotesToDiscord` | 貼圖／影片／語音／檔案／位置轉成短文字的次數 |
| `line.stats.imagesToLine` / `imageNotesToLine` | Discord → LINE：以圖片送出／副本不在改送文字 |
| `mediaRelay.enabled` | Discord → LINE 圖片暫存是否開著（`false` → 不是 reply 佇列模式、沒有 https 公開網址，或 `CHAT_MIRROR_IMAGES=false`） |
| `mediaRelay.stats` | `entries`／`bytes` 目前存量，`stored`／`evicted`／`expired` 累計，`served` LINE 來抓圖的次數，`notFound` 抓不到的次數 |

**驗證**：LINE 群傳一張照片 → Discord 同步頻道出現 `[…][LINE][名字] （圖片）` 和那張圖。
Discord 同步頻道貼一張 JPG／PNG → 回 LINE 群講一句 → 群裡先出現 `[…][DC][名字] （圖片）`，接著那張圖；`mediaRelay.stats.served` 會增加（見上面「上線後請確認一次」）。

**要 Edward 確認的設定**（其他都不用動）：

1. Discord 同步頻道（`LOBBY_MIRROR_DISCORD_CHANNEL_ID`）要讓 bot 有**附加檔案（Attach Files）**權限；沒有的話 LINE 的圖會變成文字說明，log 會出現 `status=403 code=50013`。
2. LINE Developers Console 不用改：讀圖片內容用的是同一組 channel access token，不需要另外申請。
3. 沒有新增費用：LINE 內容下載免費、reply 不算 push 額度、圖片只放 server 記憶體（Render Free 512 MB 中最多 50 MB）。

## 配額

LINE 官方帳號免費方案每月免費訊息數有限（台灣目前 200 則，以 LINE 當期公告為準）；
reply 不計、push 計。`LINE_REPLY_DRAIN=true`（預設）下 server 不會 push 群訊息；
唯一還會 push 的是 `AsyncNotifier` 對單一玩家的提醒（`pushDirect`）。

## 疑難排解

| 症狀 | 先看 | 動作 |
|---|---|---|
| LINE 講話 Discord 沒反應 | `line.stats.lastEventAt` 沒動 | Layer 1：`webhook.action/actual/active`；Console 按 Verify |
| 同上，但 `lastEventAt` 有動 | `discord.ready` | token / MESSAGE CONTENT INTENT / Render 剛醒 |
| Discord 講話 LINE 一直沒有 | `replyQueueSize` 累積、`replyFailures` | 群裡先有人講一句；`replyFailures` 增加 → token 無效或 reply_token 過期（>1 分鐘） |
| 全部 401 | `signatureFailures` | channel secret 錯；或前面有代理改了 body |
| `webhook.action = skipped` | `lastError` | 沒 token，或算不出 URL（非 Render 要設 `LINE_WEBHOOK_URL`） |
| CI 紅 | step log 的 `::error::` 行 | 每一條都對應上面某一列 |

## 相關檔案

- `packages/server/src/bots/line/webhookEndpoint.ts` — Layer 1 所有權（GET / PUT / test）
- `packages/server/src/bots/line/replyQueue.ts` — reply_token 佇列
- `packages/server/src/bots/line/client.ts` — webhook 處理、raw-body 簽章、drain
- `packages/server/src/bots/ChatMirror.ts` — 三向扇出（含圖片：LINE 圖上傳 Discord、Discord 圖排進 LINE 佇列）
- `packages/server/src/bots/media/` — Discord → LINE 圖片暫存與 `/media/relay/` 路由（`relayMedia.ts`）、下載上限與格式判斷（`bytes.ts`）
- `packages/server/src/bots/discord/mirrorInbound.ts` — Discord 同步頻道訊息（含附件）→ 大廳與 LINE
- `packages/server/src/bots/index.ts` — 初始化（各 bot 失敗隔離）、`/api/bots/status`
- `packages/server/src/middleware/rawBody.ts` — 保留原始 bytes
- `packages/server/src/services/keepAlive.ts` — Render Free 自我喚醒
- `packages/server/src/bots/chatExport/` — 每日聊天紀錄匯出（讀頻道與論壇歷史、發言者換代號、寫試算表「聊天紀錄」分頁、「匯出紀錄」分頁記完成、只留 7 天、重啟後補齊）
- `packages/server/src/bots/digest/sheets.ts` — 服務帳號登入與 Google Sheets REST（共用）
- `packages/server/src/bots/feedback/` — 主題計數與 `/意見`（轉貼到管理員頻道）
- `packages/server/src/bots/stats/` — 戰績回覆（`statsReplies.ts` 純格式化、`statsQueries.ts` 讀快取、`textCommands.ts` LINE 指令、`weeklyDigest.ts` 每週排行）
- `.github/workflows/verify-line-webhook.yml` — 每日探測
- `render.yaml` — 變數清單
- 測試：`src/__tests__/LineSyncRoundTrip.test.ts`、`LineReplyQueue.test.ts`、`LineWebhookEndpoint.test.ts`、
  `LineStatsCommands.test.ts`、`LineDiscordImageSync.test.ts`、`RelayMedia.test.ts`（也在 `pnpm test:line-sync`）、
  `StatsReplies.test.ts`、`DiscordStatsCommands.test.ts`、`StatsWeeklyDigest.test.ts`
