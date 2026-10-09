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
  }
}
```

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
- `packages/server/src/bots/ChatMirror.ts` — 三向扇出
- `packages/server/src/bots/index.ts` — 初始化（各 bot 失敗隔離）、`/api/bots/status`
- `packages/server/src/middleware/rawBody.ts` — 保留原始 bytes
- `packages/server/src/services/keepAlive.ts` — Render Free 自我喚醒
- `.github/workflows/verify-line-webhook.yml` — 每日探測
- `render.yaml` — 變數清單
- 測試：`src/__tests__/LineSyncRoundTrip.test.ts`、`LineReplyQueue.test.ts`、`LineWebhookEndpoint.test.ts`
