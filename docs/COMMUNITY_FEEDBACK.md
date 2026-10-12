# 社群反應彙整 — 不搬聊天原文的做法

> 版號 20261012。程式在 `packages/server/src/bots/feedback/`；測試 `__tests__/Feedback*.test.ts`。
> 相關：`docs/LINE_DISCORD_SYNC.md`（三向同步）、`docs/stats/two_stage_outcome.md`（數據口徑）。

## 結論

1. Edward 要看 LINE 群、Discord 頻道裡大家對功能與數據的反應，再照合理的意見微調。
2. 上一次（GitHub Actions 讀 Discord 訊息 → 加密印進 log → 本機解密）觸發安全機制、整段對話被鎖。那條路放棄。
3. 這次**聊天原文不離開 Render**。Render 上的 bot 本來就收得到群訊息（LINE webhook、Discord gateway），
   就在它身上把訊息「當場縮成數字」（主題計數），只有玩家**主動**用 `/意見` 打的那段文字才會轉貼到 Discord 給 Edward 看。
4. 管理者讀法：每週看一次 `/api/bots/status` 的 `feedback` 區塊（數字）＋ Discord 指定頻道的 `📮 意見` 貼文（文字）。

## 前一次為什麼失敗

| 做法 | 問題 |
|---|---|
| Actions 用 bot token 拉 Discord 頻道歷史訊息 | 把一整段群聊搬到 GitHub 的執行環境 |
| 加密後印在 job log | log 是公開 repo 的公開產物；「印出來再解密」這個形狀本身就會被安全機制擋，而且擋了就整個對話一起鎖 |
| 本機解密閱讀 | 需要金鑰在兩邊同步，和「公開 repo 不得寫入任何金鑰」衝突 |

教訓：**不要設計任何「聊天內容要經過 GitHub Actions / log / artifact」的路徑。**

## 隱私原則（程式裡怎麼守）

| 原則 | 落地 |
|---|---|
| 不存使用者 id、不存名字 | `TopicCounter` 只有 `Map<週, Map<主題, 整數>>`；`FeedbackService` 只有 `opinions: {line, discord}` 兩個整數 |
| 原文不存到任何會離開 Render 的地方 | `observe()` 讀一次文字就丟；server log 只印固定原因字串（`not forwarded: hourly cap`）與平台名，從不印內容。錯誤也只印 `name / code / status / message`（`describeError`），**不把錯誤物件整包交給 console**：discord.js 的 `DiscordAPIError.requestBody` 帶著轉貼內容，整包印就等於把原文寫進 log |
| 公開端點只出數字 | `/api/bots/status` 的 `feedback` 只有 `weeks[].line/discord` 的整數、`opinions` 的整數、`commandEnabled` 一個布林；測試 `FeedbackCommands.test.ts` 直接 `JSON.stringify` 檢查裡面沒有訊息文字和 id |
| 唯一離開 Render 的文字是玩家主動提交的 | `/意見 內容` 轉貼格式 `📮 意見（LINE）：內容`，**沒有名字、沒有 id**，`allowedMentions: { parse: [] }` 不會 @ 到任何人，內容截到 500 字 |
| 全部在記憶體 | 重新部署 / 重啟就歸零（Render Free）。這是刻意的：沒有檔案、沒有資料庫、沒有外送 |
| CI / log 不印聊天內容、牌譜原文、玩家名字 | 本功能沒有任何 Actions 步驟 |

## 本次做法

### 1. 主題計數（`topicCounter.ts`）

- 預設主題與關鍵字（每則訊息對每個主題**最多計 1**，拉丁字不分大小寫）：

  | 主題 | 關鍵字 |
  |---|---|
  | 排行 | 排行、排名 |
  | 戰績 | 戰績、战绩 |
  | 默契 | 默契 |
  | 機器人 | 機器人、bot |
  | 網站 | 網站、網頁 |
  | 牌譜 | 牌譜、記錄、紀錄 |
  | 格式 | 格式 |
  | 問題 | 錯、壞、bug、怪（比對前先去掉「不錯」「沒錯」，稱讚和附和不算問題） |
  | 建議 | 建議、希望、可以加 |
  | 稱讚 | 讚、好用、不錯 |
  | 湖 | 湖、湖中 |
  | 刺殺 | 刺殺 |
  | 意見 | （沒有關鍵字；只有 `/意見` 指令會加） |

- 分桶：台灣時間（+08）的 ISO 週 `YYYY-Www`（例：2026-10-12 週一 = `2026-W42`），只保留最近 8 週。
- 分平台：`line`（只有 `LOBBY_MIRROR_LINE_GROUP_ID` 那個鏡像群）、`discord`（只有 `LOBBY_MIRROR_DISCORD_CHANNEL_ID` 鏡像頻道的**人類**訊息；bot 自己、其他 bot、webhook 貼文都排除）。
- 網頁大廳的訊息不計（不是這次的範圍）。
- `/意見 …` 這則文字在提交時計一次（關鍵字＋「意見」主題），不會再當一般聊天重複計。
  Discord 若用**純文字**打 `/意見 …`（例如全形 `／意見`，slash 選單沒跳出來），那只是一般聊天：關鍵字照計、不算「意見」、不轉貼、不回覆——Discord 只有 slash 指令會提交。
- 指令本身不算反應：`/戰績 /排行 /默契 /指令`（含全形斜線）在兩個平台都**不計**主題。否則 LINE 每查一次 `/排行` 就讓「排行」+1，而 Discord 的 slash 指令根本不經過計數，兩邊數字不可比。
- LINE webhook 重送（`deliveryContext.isRedelivery`，同一個 `webhookEventId`）：這個程序已處理過的事件不會再計數、再鏡像、再轉貼，只會再回一次固定文字（第一次的回覆可能沒送出去）。若原始那次根本沒到我們（Render 冷啟動超時），重送就是第一次，照常處理。只記最近 500 個事件 id，不記文字。

### 2. `/意見` 指令（`commands.ts`、`service.ts`、`discordCommand.ts`）

| 平台 | 怎麼打 | 回覆 |
|---|---|---|
| LINE 鏡像群、LINE 1:1 | `/意見 內容`（全形 `／意見` 也可，空白可省） | 固定文字「已收到，謝謝。管理者每週彙整後調整。」；走既有 reply_token 機制，在鏡像群佔第 1 格、後面 4 格照常排空鏡像佇列（和 `/戰績` 同一套） |
| Discord | slash 指令 `/意見 內容:…`（選項必填、最多 500 字） | 同一句固定文字，**只有本人看得到**（ephemeral）；意見本體走轉貼，不會在頻道出現兩次 |
| 沒打內容 | `/意見` | 「請在 /意見 後面寫下內容，例如：/意見 排行榜希望加上場次。」不計數、不轉貼 |

- 轉貼：`📮 意見（LINE）：內容` / `📮 意見（Discord）：內容` 貼到 `FEEDBACK_DISCORD_CHANNEL_ID`；**未設就只回覆＋計數、不轉貼**。
  刻意**不**退回 `LOBBY_MIRROR_DISCORD_CHANNEL_ID`（公開鏡像頻道）：轉貼是匿名的，而任何加 LINE 官方帳號好友的人（1:1 聊天）或 Discord 伺服器的任何成員都能提交，等於 bot 幫人把匿名文字洗進主頻道；要轉貼就必須明確指定一個 Edward 自己選的（私人）頻道。
- 轉貼和回覆**脫鉤**：`submit()` 先計數、先決定回覆文字，轉貼在背景跑（`FeedbackSubmitResult.forwarded` 是另一個 promise）。
  LINE 的 reply_token 一分鐘過期、webhook 要盡快回 200，而 discord.js 對卡住的請求會重試到約 60 秒（429 還會原地等），所以 LINE 的回覆**絕不**等 Discord；Discord slash 指令已 defer，才會等轉貼完成再回 ephemeral 的「已收到」。
- 轉貼失敗（Discord gateway 還沒 ready、頻道沒權限…）：回覆照樣是固定的「已收到」、`opinions` 照樣 +1，但**那則文字不會補送**，管理者可從 `opinions` 和頻道貼文數對不上察覺。失敗的轉貼**不吃**每小時額度。
- 防洗版：全程序每小時最多轉貼 30 則（`FEEDBACK_MAX_FORWARDS_PER_HOUR`），超過仍回覆、仍計數、不轉貼。因為不存 id，無法做「每人」限制——一個人可以把額度用完；這也是轉貼目的頻道必須是私人頻道的原因之一。
- 旗標：`FEEDBACK_COMMAND_ENABLED`（預設開；`false/0/no/off` 關）。關了之後 `/意見` 就是一般聊天（LINE 不回、Discord 回「目前停用」），主題計數不受此旗標影響。
- 和 `/戰績` 一樣，LINE 鏡像群裡打的 `/意見 …` 原文仍會照三向同步規則鏡像到 Discord 鏡像頻道與大廳（帶名字）——這是既有行為，不是本功能新增的外流路徑；要不要例外見下方待裁定。

### 3. `/api/bots/status` 新增 `feedback`

```json
"feedback": {
  "commandEnabled": true,
  "weeks": [
    { "week": "2026-W41", "line": { "排行": 3, "戰績": 1, "問題": 2, "意見": 1, "...": 0 }, "discord": { "...": 0 } },
    { "week": "2026-W42", "line": { "...": 0 }, "discord": { "機器人": 2, "稱讚": 1, "...": 0 } }
  ],
  "opinions": { "line": 1, "discord": 0 }
}
```

- `weeks` 舊→新排序，每週每平台把 13 個主題都列出來（沒提到就是 0），方便直接當表格看。
- `opinions` 是程序啟動以來收到的 `/意見` 總數；每週的「意見」主題是週的切分。
- 只有數字和一個布林。`verify-line-webhook.yml` 的既有契約（`line.ready`、`line.webhook.*`、`discord.*`）不受影響。

### 4. 環境變數

| 變數 | 用途 | 預設 |
|---|---|---|
| `FEEDBACK_DISCORD_CHANNEL_ID` | `/意見` 轉貼目的頻道（建議私人頻道） | 未設 → 只回覆＋計數，**不轉貼**（不退回鏡像頻道） |
| `FEEDBACK_COMMAND_ENABLED` | `/意見` 指令開關（啟動時讀一次） | 開；留空等同開，只有 `false/0/no/off` 關 |

都不是秘密（頻道 id 在 Discord 任何成員都看得到）。`packages/server/.env.example` 已列出這兩個變數（留空＝預設）；`render.yaml` **尚未**加上 `FEEDBACK_DISCORD_CHANNEL_ID`，所以正式機在 Render dashboard 或 `render.yaml` 設定之前，`/意見` 只會回覆＋計數、不會轉貼，見待辦。

## 我（管理者）怎麼讀

每週一（和排行 digest 同一天）花兩分鐘：

1. 打開 `https://<後端>/api/bots/status`（`PROJECT_CONTEXT.md` 有網址），看 `feedback.weeks` 最後一到兩週：
   哪個主題數字跳起來（例如「問題」＋「排行」同週都高 → 排行剛改版後大家在抱怨），再去 `opinions` 看有沒有人正式留意見。
2. 到 Discord 的 `FEEDBACK_DISCORD_CHANNEL_ID` 頻道看 `📮 意見` 貼文，那是唯一有原文的地方（沒設這個變數就沒有貼文，只剩數字）。
3. 真要看上下文就直接去 LINE 群 / Discord 頻道用人眼讀 — 這一步不需要、也不該由程式代勞。
4. 想保留歷史：重新部署前先把 status 的 JSON 存下來（計數在記憶體，部署就歸零）。

Claude（我）在 session 裡的讀法同上：只讀 `/api/bots/status`（公開、純數字）與 Edward 轉述的意見；不抓聊天原文。

## 還需要 Edward 裁定的事

1. **開一個私人的 `#feedback` 頻道**放 `FEEDBACK_DISCORD_CHANNEL_ID`（程式已不會退回鏡像頻道）：
   不設 → `/意見` 只回覆＋計數，Edward 看不到文字。
   設成鏡像頻道 → 匿名意見會貼在公開頻道（LINE 那邊打的還會出現兩次：帶名字的鏡像原文＋不帶名字的 `📮`），而且 1:1 私訊 LINE 官方帳號的陌生人也能這樣貼；**不建議**。
   設成私人頻道 → 只有 Edward（和他拉進去的人）看得到意見本體；建議這樣。
   另外要知道：LINE 1:1 的 `/意見` 是對外可達的路徑（加好友就能用，沒有群成員檢查），目前照樣轉貼到這個頻道；若想只計數不轉貼，改 `line/client.ts` 1:1 分支一處即可。
2. **是否允許 bot 回覆非指令訊息**（例如偵測到「排行壞了」就自動回「收到，請用 /意見 補充」）？
   目前**不會**：bot 只回指令。自動回覆會讓群覺得被監聽；本設計刻意只在玩家主動開口時才回。
3. `/意見` 在 LINE 鏡像群的原文**要不要排除在三向鏡像之外**（現在和 `/戰績` 一樣照常鏡像）？排除的話 Discord 看不到帶名字那份，只剩 `📮` 匿名那份。
4. 主題關鍵字清單要不要改（例如加「線瓦」「signage」「Elo」）？改 `DEFAULT_TOPICS` 一處即可，不影響其他程式。
5. 計數是否要跨部署保留？保留就得寫檔或資料庫，等於開始「存」東西；目前判斷不值得，先用「部署前存 JSON」頂著。

## 待辦（範圍外，需另開）

- `render.yaml`（或 Render dashboard）加 `FEEDBACK_DISCORD_CHANNEL_ID`＝私人頻道 id；沒設之前正式機不會轉貼。
- `packages/server/.env.example` 的註解仍寫「unset = 用上面的鏡像頻道」，要改成「unset = 不轉貼」（本次修正不在該檔範圍內）。
- 已完成：`.env.example` 列出兩個變數；`docs/LINE_DISCORD_SYNC.md` 的 status 範例與指令表已含 `feedback` / `/意見`；`/指令`、`/help` 已有「/意見 文字」一行（`bots/stats/statsReplies.ts`）。
