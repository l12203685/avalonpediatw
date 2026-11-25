# 🤖 Avalon Bot Setup Guide

Complete guide for setting up Discord and Line bots for Avalon game platform.

## Table of Contents

1. [Discord Bot Setup](#discord-bot-setup)
2. [Line Bot Setup](#line-bot-setup)
3. [Environment Variables](#environment-variables)
4. [Deployment](#deployment)
5. [Commands](#commands)
6. [補位機器人（/機器人補位、/補位）](#補位機器人機器人補位補位)
7. [百科AI 對局紀錄與回饋](#百科ai-對局紀錄與回饋dc-牌譜紀錄與覆盤網站-ai-games)
8. [待修正牌譜清單（/待修正）](#待修正牌譜清單待修正)
9. [百科回報與 ID 認領（/回報、/認領）](#百科回報與-id-認領回報認領)
10. [牌譜更正（/更正）](#牌譜更正更正)
11. [每日「阿瓦隆百科小觀念」與觀念卡回饋](#每日阿瓦隆百科小觀念與觀念卡回饋)

---

## Discord Bot Setup

### Step 1: Create Discord Application

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click "New Application"
3. Give your app a name (e.g., "Avalon Bot")
4. Go to "Bot" section and click "Add Bot"
5. Copy the bot token (keep it secret!)

### Step 2: Configure Bot Permissions

1. Go to "OAuth2" → "URL Generator"
2. Select scopes: `bot`, `applications.commands`
3. Select permissions:
   - Send Messages
   - Embed Links
   - Read Message History
   - Add Reactions
4. Copy the generated URL and invite the bot to your server

### Step 3: Get Required IDs

- **Client ID**: From "General Information" tab
- **Guild ID** (optional, for testing): Right-click your server → Copy ID

### Step 4: Set Environment Variables

```bash
DISCORD_BOT_TOKEN=your_bot_token_here
DISCORD_CLIENT_ID=your_client_id_here
DISCORD_GUILD_ID=your_guild_id_here  # Optional, for testing
```

### Step 5: Start Discord Bot

The bot initializes automatically when the server starts. Commands are registered globally by default or in the specified guild.

---

## Line Bot Setup

### Step 1: Create Line Messaging API Channel

1. Go to [Line Developers Console](https://developers.line.biz/)
2. Create a new provider
3. Create a new Messaging API channel
4. Accept the agreement and create

### Step 2: Get Credentials

1. Go to "Channel settings" → "Basic settings"
   - Copy **Channel Secret**
2. Go to "Messaging API" → "Channel access token"
   - Copy **Channel Access Token** (or create new one)

### Step 3: Configure Webhook

1. In Channel settings, enable **"Use webhook"** and **"Webhook redelivery"**;
   turn **off** "Auto-reply messages" and "Greeting messages" (they consume reply tokens).
2. **Do not type the Webhook URL by hand.** Since 2026-10-08 the server owns it:
   on boot it derives the URL from `LINE_WEBHOOK_URL` / `PUBLIC_BASE_URL` /
   `RENDER_EXTERNAL_URL` and `PUT`s it to the LINE Messaging API, then re-checks
   every 6 hours. Whatever you type in the console gets overwritten with the code's
   value. See `docs/LINE_DISCORD_SYNC.md`.

### Step 4: Set Environment Variables

```bash
LINE_CHANNEL_ACCESS_TOKEN=your_access_token_here
LINE_CHANNEL_SECRET=your_channel_secret_here
```

### Step 5: Start Line Bot

The bot initializes automatically and listens for webhook events.

---

## Environment Variables

Add these to your `.env` file in the `packages/server` directory:

```env
# Discord Bot
DISCORD_BOT_TOKEN=xoxb_...
DISCORD_CLIENT_ID=123456789...
DISCORD_GUILD_ID=987654321...  # Optional

# Line Bot
LINE_CHANNEL_ACCESS_TOKEN=ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef...
LINE_CHANNEL_SECRET=1234567890abcdef1234567890abcdef...

# General
GAME_SERVER_URL=http://localhost:3001
```

---

## Deployment

### Discord Bot

Discord bots require continuous connection. Options:

1. **Local/Self-hosted**: Run the server continuously
2. **Cloud Hosting**:
   - Railway
   - Heroku
   - AWS EC2
   - DigitalOcean

### Line Bot

Line uses webhook (HTTP POST) for events.

1. **Requirements**:
   - Public HTTPS endpoint
   - Valid SSL certificate
   - Accept POST requests

2. **Deployment Options**:
   - Vercel
   - Railway
   - AWS Lambda
   - Google Cloud Functions
   - Azure Functions

### Recommended Setup

- **Discord Bot**: Railway (continuous process)
- **Line Bot**: Vercel or Railway (webhook endpoint)

---

## Commands

> **這一節是舊清單**（對局還在本站開的時候寫的）。現在的指令、兩邊的差別、每個指令回什麼，看 [`BOTS.md`](BOTS.md)；群組裡打 `/help` 或 `/說明` 也看得到。下面的 `/create`、`/join`、`/vote` 等只會回 signage-cloud 的開局網址。

### Discord Commands (Slash Commands)

#### Basic Commands

```
/help          - Show all available commands
/create        - Create a new game
/join <room>   - Join an existing game
/status        - Check current game status
/rules         - View game rules
/roles         - View role descriptions
/vote <yes/no> - Cast your vote
```

### Line Bot Commands (Text Messages)

#### Message Format

```
help           - Show help message
create         - Create a new game
join <room>    - Join a game
status         - Check game status
rules          - View game rules
roles          - View role descriptions
vote approve   - Vote approve
vote reject    - Vote reject
```

---

## 補位機器人（/機器人補位、/補位）

2026-11-03 起，玩家可以叫 signage-cloud 的百科AI（補位機器人）進房間補位。2026-11-04 起（Edward）：房號或房間描述都可以、私房可帶密碼、一次可以補滿、局數不限（房內聊天室打「離開」它就走）。

| 平台 | 指令 | 範例 |
|---|---|---|
| Discord | `/補位 房號或描述 [人數] [密碼]`（斜線指令；人數選單：補滿、1–9；原本的 `/機器人補位` 照舊可以用，2026-11-25 起兩個名字同一個指令） | `/補位 房號或描述:百科陪練 人數:補滿 密碼:1234` |
| LINE | `/補位 房號或房間描述 [補滿｜幾人] [密碼:xxxx]`（也接受 `/機器人補位`、全形 `／`） | `/補位 1460`、`/補位 百科陪練 補滿 密碼:1234`、`/補位 「百科 陪練」 3人` |
| 網站（2026-11-19 起，不用登入、不用在群組裡） | 「百科AI 對局」頁（`#ai-games`，也可用 `#seat-filler`）最上面的「叫百科AI 補位」：房號或描述、人數（1–9、補滿）、密碼（選填） | `https://avalon-game-platform.web.app/#seat-filler` |

- **房號或描述**：`Room-1460`／`1460`；房間內看不到房號時，打建房時寫的房間描述裡的一段字（最多 40 字，不能有引號或換行；有空白就用「」包起來）。
- **人數**：1–9 個，不填就是 1 個；「補滿」＝一直坐到房間 10 人為止。暱稱 `百科AI_數字`（依房號／描述分段，同時兩間房不撞名），戰績上全部算「百科AI」。
- **密碼**：私房密碼，只用來進房；GitHub log 會遮掉。LINE 群組裡打的密碼大家看得到。沒給密碼時會照慣例試今天日期 MMDD（台灣時間；凌晨 6 點前也試昨天的），特殊私約局再自己給。
- **局數**：不限（最多跑 3 小時）；每局開始前與打完後，百科AI 會在聊天室問「需要我離開嗎？」，有人回「離開」就走。
- 成功時回覆：「已叫百科AI 到「…」（N 個／補到 10 人），約 1–2 分鐘後進房；局數不限，要它走就在房內聊天室打「離開」。」Discord 成功的回覆大家看得到，格式錯誤、冷卻中等拒絕只有下指令的人看得到（ephemeral）。
- **限制**（LINE、DC、網站三個入口共用一份，存在伺服器記憶體，重啟會歸零）：全站每 3 分鐘最多叫一次；每天（台北時間）最多 10 次；同一間房 15 分鐘內不重複叫。GitHub 回錯誤時不扣次數；連不到 GitHub（逾時）時仍算一次，避免同一房進兩隻。
- **網站入口**（站長 2026-11-19：讓不在 LINE／DC 群組的人也能補）：`POST /api/seat-filler`，body `{ room, bots?, password? }`（`packages/server/src/routes/seatFiller.ts`；表單 `packages/web/src/components/aiGames/SeatFillerCard.tsx`）。驗證、回覆文字跟指令一樣，另外每個 IP 每小時最多 3 次（只算真的送出去的；格式錯、被全站限制擋下、GitHub 回錯誤都不算）、每分鐘最多 10 個請求。IP 只以加鹽雜湊存在記憶體，不寫 log；密碼只送給 workflow，不回傳、不記錄。狀態碼：200 已送出、400 格式錯、429 限制、503 還沒設定好、502 GitHub 錯誤、202 連不到 GitHub（可能已送出）。
- 兩個指令都列在 `/help`（Discord）與 `/指令`（LINE）裡，也不算進意見主題計數與聊天匯出。
- 運作方式：伺服器（三個入口都一樣）呼叫 GitHub Actions 的 workflow_dispatch，跑 `.github/workflows/signage-player.yml`（輸入 `room`、`bots`、`password`，ref `main`）。程式在 `packages/server/src/services/signagePlayerDispatch.ts`、`packages/server/src/bots/seatFiller/`。Log 只記狀態碼，不記玩家名字、訊息內容或 token。

### 管理者要做的設定：GITHUB_DISPATCH_TOKEN

沒設 token 時，指令（和網站表單）會回「補位機器人還沒設定好」。設定步驟：

1. GitHub → 右上頭像 → **Settings** → **Developer settings** → **Personal access tokens** → **Fine-grained tokens** → **Generate new token**。
2. **Repository access** 選 **Only select repositories**，只勾這個 repo（`l12203685/avalonpediatw`）。
3. **Repository permissions** → **Actions** 設成 **Read and write**（其他權限都不用開）。設一個到期日，到期前記得換新。
4. 產生後複製 token，直接貼到 Render → 這個 server 服務 → **Environment** → 新增 `GITHUB_DISPATCH_TOKEN`，存檔讓服務重啟。**不要把 token 貼到聊天、issue 或任何檔案裡。**

選填（不設就用預設值）：

| 變數 | 預設 | 用途 |
|---|---|---|
| `SIGNAGE_PLAYER_WORKFLOW` | `signage-player.yml` | 要觸發的 workflow 檔名 |
| `GITHUB_DISPATCH_REPO` | `l12203685/avalonpediatw` | workflow 所在的 repo（`owner/repo`） |

workflow 還沒合併進 `main` 之前，叫機器人會回「GitHub 回應 404」之類的錯誤（不扣次數）。

同一把 `GITHUB_DISPATCH_TOKEN` 也給伺服器的兩個每日觸發用（GitHub 自己的排程常晚好幾小時，所以由伺服器觸發；Actions: Read and write 就能觸發這個 repo 的任何 workflow，不用另外開權限）：

| 變數 | 預設 | 用途 |
|---|---|---|
| `NIGHTLY_DISPATCH` | 開 | 設 `off` 停掉每晚觸發牌譜記錄員＋百科AI 每晚補位（`services/nightlyDispatch.ts`） |
| `NIGHTLY_DISPATCH_AT` | `18:35` | 每晚觸發的開始時間（台北，HH:MM，到 23:00 為止） |
| `THREADS_DISPATCH` | 開 | 設 `off` 停掉每天觸發 Threads 每日發文（`services/threadsDispatch.ts`；見 docs/THREADS.md〈誰來觸發〉） |
| `THREADS_POST_HOUR` | `12` | Threads 每天幾點觸發（台北，整點 07 分起、到 23:00 為止；跟 repo 變數同名，要改兩邊一起改）。正式發不發仍由 repo 變數 `THREADS_PUBLISH` 與起始日決定：起始日／暫停在主控台設，Claude 每天同步進 `packages/server/threads_live.json`（repo 變數 `THREADS_LIVE_FROM` 選用，有設就蓋過）；見 docs/THREADS.md〈正式發的開關〉 |

---

## 百科AI 對局紀錄與回饋（DC #牌譜紀錄與覆盤＋網站 #ai-games）

Edward 2026-11-05：「只要有百科AI參與的牌局就自動記錄在網站&DC上 我們可以直接針對AI的動作作反饋」。百科AI（上面的補位機器人，`signage-player.yml`）在遊玩頁打的**每一局**，打完、角色公開之後自動記錄，大家可以針對它的每個派隊、投票、任務、湖、宣告、刺殺給回饋。

### 在 DC 上

- 2026-11-09 起貼在論壇 **#牌譜紀錄與覆盤**，格式同記錄員的待檢視貼文（標題「【待檢視】含百科機器人_…」，標籤 模擬＋線瓦＋結果），附 `trace.json`；每日匯入看到「待檢視」或「模擬」不收進真人戰績。原本的論壇 #百科問題回報 已刪除（`AI_GAME_FORUM_CHANNEL_ID` 還設成它的 id 時自動改用 #牌譜紀錄與覆盤）。以下幾點是 11-05～11-08 在舊論壇時的格式，留作紀錄：
- 標題：`百科AI對局 20261105_2105 週四練習團／Room-1460`（台灣時間的開局時刻、房間描述／房號）。
- 起始訊息：房間、時間、結果、六碼配置、百科AI 坐哪幾家，以及回饋方式；附 `trace.json`（完整紀錄，網站讀這個）。
- 後面幾則：依局分組的對局紀錄（每次提議的隊長、隊伍、贊成／反對，任務結果，湖中，刺殺）。2026-11-05 起（Edward「百科AI 的戰局只需要貼紀錄就好 思考內容那些不用」）DC 不貼百科AI 的夜晚資訊與每一步的理由；理由只在網站上看得到。每則 2000 字以內，最多 20 則；最後附網站上這一局的網址。
- 清單＝最近 50 篇百科AI對局；點一局看回顧（同練習模式：開牌後的角色、依局分段的公開紀錄、每個百科AI 決定附理由，可以依座位、動作種類篩選）。網站上不顯示真人暱稱，只有座位與角色（DC 上照房間裡的暱稱）。
- 每一步有「這步怪怪的」按鈕：寫原因、暱稱選填（不填＝匿名）→ 伺服器在那篇 DC 討論串貼一則回覆：

  ```
  **【網站回饋】這步怪怪的** — 小明
  第 1 局第 1 次・2家 刺客 百科AI_22・投票：反對（決定 #2）
  > 隊上 1、3、4 家都乾淨，第一局反對很怪
  ```

### 程式與設定

| 項目 | 位置 |
|---|---|
| 記每個決定、局末組 trace、合併多個百科AI | `packages/server/scripts/signagePlayer.ts`、`scripts/signageAiTrace.ts` |
| trace 格式、DC 文字、拆訊息、回饋格式 | `packages/server/src/services/aiGameTrace.ts` |
| 貼 DC（標籤、討論串、附檔、後續訊息）；伺服器讀論壇 | `packages/server/src/services/aiGameForum.ts` |
| API：`GET /api/ai-games`、`GET /api/ai-games/:id`、`POST /api/ai-games/:id/flag` | `packages/server/src/routes/aiGames.ts` |
| 網站頁 | `packages/web/src/pages/AiGamesPage.tsx`、`components/aiGames/` |

- **不用新的設定**：GitHub Actions 的 Play 步驟和 Render 都用既有的 `DISCORD_BOT_TOKEN`（同記錄員、牌譜回覆）。沒有 token 時只打牌不貼（log 寫「沒有 DISCORD_BOT_TOKEN」），網站 API 回 503。
- 機器人要在 #牌譜紀錄與覆盤 有「傳送訊息」「建立公開討論串」「附加檔案」「在討論串傳送訊息」權限。
- 選填：`AI_GAME_FORUM_CHANNEL_ID`（換論壇；`off` 關掉貼文與網站頁）、`DISCORD_GUILD_ID`（列出進行中的討論串用，預設阿瓦隆百科群組）。
- 伺服器讀 DC 的結果在記憶體快取 5 分鐘；附件只從 Discord 的 CDN 讀，只認這個論壇裡標題「百科AI對局」開頭、起始訊息是機器人發的貼文。網站回饋每個 IP 每分鐘 10 則，全站每小時最多 120 則。
- 隱私：公開的 GitHub Actions log 只有時間、房號、狀態與數量（例：`Room-1460：百科AI對局已貼到 DC（42 個決定、6 則後續訊息）`），trace 不印到 log；DC 失敗只記狀態碼。本機跑 `--private-log DIR` 會另存一份 `ai-trace-*.json`。
- 開關：`signagePlayer.ts --ai-trace off` 不貼；私房測試（`--mode private-test`）預設不貼，加 `--ai-trace on` 才貼。

---

## 待修正牌譜清單（/待修正）

2026-11-09 起（Edward：「你直接加入一個功能給line/dc bot 讓他們可以送出目前需要修正的牌譜跟原因」），LINE 和 DC 都可以查 DC 論壇 **#牌譜紀錄與覆盤** 裡目前需要修正的牌譜。

| 平台 | 指令 |
|---|---|
| Discord | `/待修正`（斜線指令，沒有選項；回覆大家看得到） |
| LINE | `/待修正`（也接受 `/牌譜待修正`、全形 `／`） |

- 列的是掛著「待修正」標籤的貼文（每日匯入 `discord_records_import.py` 讀不懂時掛上，改好後自動拿掉），進行中與已封存的都算；標題有「待檢視」或掛「模擬」標籤的（記錄員／百科AI 的貼文）不列。
- 每篇一段：標題、原因（取機器人在討論串最新一則「🤖 牌譜格式檢查」回覆的原因行，例如「第 22 行「刺客刺殺: 4」：刺殺目標和結果標籤對不起來（…）」）、討論串連結，新的在前。結尾提示「改好首篇後不用做別的，每天凌晨的匯入會自動重新讀取。」
- 一次最多列 15 篇，LINE 一則 5000 字、DC 2000 字以內；放不下時說「還有 N 篇沒列出」，請到論壇用「待修正」標籤篩選。沒有的話回「目前沒有需要修正的牌譜。」
- 回覆範例：

  ```
  目前有 2 篇牌譜需要修正：

  1. 2026/11/01 線瓦 週六練習
  原因：第 22 行「刺客刺殺: 4」：刺殺目標和結果標籤對不起來（三藍被刀的刺殺目標要是梅林的座號）
  https://discord.com/channels/1132682489840812113/<討論串 id>

  2. 2026/10/20 線瓦
  原因：玩家名單不完整（要有 1～9 號和 10 號，每個座位一行：1.名字）
  https://discord.com/channels/1132682489840812113/<討論串 id>

  改好首篇後不用做別的，每天凌晨的匯入會自動重新讀取。
  ```

- 運作方式：伺服器用既有的 `DISCORD_BOT_TOKEN` 走 Discord REST（不用新設定）讀論壇的標籤、進行中與已封存的討論串、每篇最近 50 則訊息；結果在記憶體快取 5 分鐘，DC 暫時讀不到時回舊的清單並註明幾分鐘前。機器人要能看到 #牌譜紀錄與覆盤 並「讀取訊息歷史」。Log 只記狀態碼，不記標題、暱稱或內容。
- 程式在 `packages/server/src/services/paipuFixList.ts`、`packages/server/src/bots/paipuFix/`；兩個指令都列在 `/help`（Discord）與 `/指令`（LINE）裡，也不算進意見主題計數與聊天匯出。

---

## 百科回報與 ID 認領（/回報、/認領）

2026-11-09 起（Edward：「回報跟ID認領都改用DC/LINE指令，然後整區刪掉 網站上的回報跟ID認領都同步傳到 line群組/dc 同步閒聊頻道」），回報與 ID 認領都貼到 **DC #同步閒聊** 和 **LINE 群組**。DC 論壇 #百科問題回報 刪除，程式不再用它。

| 平台 | 指令 | 範例 |
|---|---|---|
| LINE | `/回報 [錯誤｜建議｜文章內容] 內容`（類型不寫＝錯誤；全形 `／` 也可以） | `/回報 牌譜頁在手機上表格超出畫面`、`/回報 建議 加一個深色模式` |
| LINE | `/認領 主ID 其他ID…`（名字有空白用「」包起來；也可以用 、 或 , 隔開） | `/認領 星野路 小路 「Kip Lune」` |
| Discord | `/回報 內容:… [類型:錯誤／建議／文章內容]`（斜線指令） | `/回報 內容:加一個深色模式 類型:建議` |
| Discord | `/認領 主id:… 其他id:…` | `/認領 主id:星野路 其他id:小路 「Kip Lune」` |
| 網站 | 右下角「問題回報」按鈕與「回報與修正」頁 `#reports`（`POST /api/feedback`）、「ID 認領」頁（`POST /api/feedback/claim`） | — |

- 回覆：`/回報` →「已收到，會在每天的處理裡看（編號 #R…）」；`/認領` →「已送出，等管理者核准（編號 #C…）」。Discord 的回覆只有下指令的人看得到，大家要看的那則由 bot 直接貼到同步閒聊。`/認領` 的檢查同網站 ID 認領頁（至少一個、最多 10 個其他 ID，每個最多 40 字，其他 ID 不能跟主 ID 一樣——只差大小寫或全半形也算一樣）。
- 貼出去的訊息（名字都是虛構的）：

  ```
  【百科回報・錯誤】#RNF2HA0G0 牌譜頁在手機上表格超出畫面
  （來自網站・小明・頁面 https://avalonpediatw.com/#records）
  ```

  ```
  【ID認領】#CNF2HBX9K 星野路 ← 小路、Kip Lune
  （來自網站・聯絡：路路）
  場數（送出時算的，僅供參考）：星野路 120 場；小路 3 場；Kip Lune 場數未知
  核准：管理者在這則訊息按 ✅；合併好會在這則加註已合併。
  CLAIM:{"main":"星野路","others":["小路","Kip Lune"]}
  ```

  LINE 群組那則沒有最後兩行（核准在 DC 按）。編號＝R（回報）／C（認領）＋送出時間＋2 碼亂數（Crockford base32，沒有 I L O U），寫在訊息裡之後不變。
- 兩邊都由 bot 直接貼，不靠同步：同步本來就略過 bot 的訊息（DC 的 bot／webhook 訊息不轉 LINE；bot 送到 LINE 的訊息不是 webhook 事件，不會回到 DC），所以不會重複。LINE 群組裡打的 `/回報`、`/認領` 原文也不同步到 DC（同步閒聊裡已經有 bot 貼的那則）。
- DC：`DISCORD_BOT_TOKEN` 走 REST，頻道 `COMMUNITY_REPORT_DISCORD_CHANNEL_ID` ＞ `LOBBY_MIRROR_DISCORD_CHANNEL_ID` ＞ #同步閒聊（`1132901301802504242`）。DC 貼不出去就算沒送出（指令回「請稍後再試」，網站 ID 認領回 503，網站回報退回舊的 `DISCORD_WEBHOOK_URL`），LINE 也不放。
- LINE：`LOBBY_MIRROR_LINE_GROUP_ID` 群組。有 reply_token 佇列（Render 上的預設）就排進去，免費；群組裡打的指令跟確認訊息同一個 reply 送出，其他來源的等下一個人說話時送出。沒有佇列時才 push，每天（台北時間）最多 `COMMUNITY_REPORT_LINE_PUSH_MAX_PER_DAY`（預設 20）則。
- 頻率限制：bot 指令每個人 10 分鐘 5 筆；所有來源加起來每小時 60 筆；網站另有每個 IP 的限制（回報每分鐘 10 則、認領每 10 分鐘 5 則）。都存在記憶體，重啟歸零。
- 程式：`packages/server/src/services/communityReports.ts`（驗證、編號、格式、貼文）、`packages/server/src/bots/reports/`（指令）、`packages/server/src/routes/feedback.ts`（網站）。log 只記狀態碼，不記內容或名字。

### 每日例行作業：列出與標記

核准＝群組擁有者（`GET /guilds/{id}` 的 `owner_id`）或 `ADMIN_DISCORD_IDS`（逗號或空白隔開的 Discord 使用者 id）在【ID認領】那則按 ✅。只在本機跑（輸出有暱稱，不要放進 GitHub Actions）：

```bash
cd packages/server
DISCORD_BOT_TOKEN=… ADMIN_DISCORD_IDS=… npx tsx scripts/listCommunityReports.ts --days 7 > items.json
DISCORD_BOT_TOKEN=… npx tsx scripts/listCommunityReports.ts --mark-merged <訊息 id>      # 【ID認領】那則加註「（已合併）」
DISCORD_BOT_TOKEN=… npx tsx scripts/listCommunityReports.ts --mark-processed <訊息 id>   # 【百科回報】那則加註「（已處理）」
```

- stdout 是 JSON：`claims[]`（`id`、`messageId`、`url`、`createdAt`、`main`、`others`、`source`、`approved`、`approvedBy`（只寫 owner／admin，不寫名字）、`merged`）與 `reports[]`（`id`、`messageId`、`url`、`createdAt`、`kind`、`text`、`source`、`processed`）；stderr 只有數量與狀態碼。
- 只列 bot 自己發、開頭「【ID認領】」或「【百科回報」的訊息（別人貼的假訊息不算）。處理完的判斷：那則有一行以「（已合併）」／「（已處理）」結尾，或 bot 回覆那則、內容有「已合併」／「已處理」。
- 核准的認領：把 `others` 寫進 `packages/server/player_aliases.json`（`{"其他ID": "主ID"}`），下一次每日資料更新生效，再用 `--mark-merged` 標上。
- 機器人在 #同步閒聊 要有「讀取訊息歷史」；標記是編輯 bot 自己的訊息，不用額外權限。

### 網站「回報與修正」頁與處理狀態（`--note`／`--link`／`--status`）

2026-11-19 起（站長：「bug 修正可以直接呈現在百科網站上嗎? (留言功能)」）。網站 `#reports`（右下角「問題回報」送出後、說明頁都有連結）上面是回報表單，下面是最近約 60 天的【百科回報】（網站＋LINE／DC 的 `/回報`、`/更正`），新的在前，附狀態、處理說明與連結。

**公開的範圍**：回報內容會**公開在網站上**（任何人不用登入就看得到；之前只有 LINE／DC 群組成員看得到）。不給暱稱、帳號、DC 訊息連結；「（來自…・暱稱・頁面 …）」那行整行不給（只拿頁面路徑）；內容裡的 @提及、`<@id>`、「暱稱：／ID：／聯絡：…」與最後一行「by 某人」「—某人」換成 ○○；`/更正` 只給第一行「[更正] 局號」（後面可能是整份牌譜）。其他照回報者寫的原樣——內容裡直接寫的名字擋不掉，看到就用 `--status 隱藏` 拿掉。整個關掉：Render 設 `REPORTS_BOARD=off`。

處理完把狀態寫進 bot 那則訊息（編輯，最後加一行；再標一次會換掉舊的那行）：

```bash
cd packages/server
# 修好了（--status 預設 已修正；「已修正：」開頭會自動拿掉）
DISCORD_BOT_TOKEN=… npx tsx scripts/listCommunityReports.ts --mark-processed <訊息 id> --note "已修正：牌譜表格改成可以左右滑" --link https://github.com/l12203685/avalonpediatw/pull/<N>
# 不改
DISCORD_BOT_TOKEN=… npx tsx scripts/listCommunityReports.ts --mark-processed <訊息 id> --status 不處理 --note "那是原文用法，不算錯字"
# 還在弄／從網站拿掉（有個資、別人的名字）
DISCORD_BOT_TOKEN=… npx tsx scripts/listCommunityReports.ts --mark-processed <訊息 id> --status 處理中 --note "查原因中"
DISCORD_BOT_TOKEN=… npx tsx scripts/listCommunityReports.ts --mark-processed <訊息 id> --status 隱藏
```

- 加上的那行（名字、網址是範例）：`【處理・已修正】牌譜表格改成可以左右滑｜<https://github.com/…/pull/123>（已處理）`。已修正／不處理／隱藏 結尾帶「（已處理）」，所以列表的 `processed` 照舊；處理中／收到 不帶（會把舊的「（已處理）」拿掉）。說明跳脫 DC markdown，網址包在 `<>`（不展開預覽）。
- 規則：已修正、不處理 一定要 `--note`（網站上顯示）；`--note` 最多 300 字、一行；`--link` 只收 `https://`；`--status` 也收 `fixed`、`wontfix`、`in-progress`、`hide`。換完超過 2000 字回 `too_long`、不編輯。結果 `{"messageId":…,"result":"edited|already|not_found|failed|too_long","status":…}`。
- 列表 `reports[]` 多了 `status`（沒有狀態行＝null）、`note`、`link`。
- 網站上的狀態：收到（沒標）、處理中、已修正、不處理，以及舊標記「已處理」（只有「（已處理）」或 bot 回覆「已處理」、沒有說明的）；隱藏的不列。日期＝送出時間；說明旁的日期＝那則最後被編輯的時間。
- 伺服器：`GET /api/reports`（`packages/server/src/routes/reports.ts`、`services/reportBoard.ts`、`services/reportStatus.ts`）用 `DISCORD_BOT_TOKEN` 往回讀 #同步閒聊（最多 20 頁×100 則、60 天），記憶體快取 5 分鐘；網站有人送出回報就清快取，下一次讀馬上看得到。沒設 token 或 `REPORTS_BOARD=off` → 503 `{ ok: false, reports: [] }`。每個 IP 每分鐘 30 次。DC 讀不到時回上一次的（`stale: true`）。頻道很熱鬧、20 頁讀不到 60 天時，更早的只會列重啟後讀過的。

---

## 牌譜更正（/更正）

2026-11-17 起（站長：玩家要能對有問題的牌譜送出更正；claude.ai 的頁面外人只能看，所以走大家已經在用的機器人）。

| 平台 | 指令 | 範例 |
|---|---|---|
| LINE | `/更正 局號`：查這局 | `/更正 S1794`、`/更正 M536`、`/更正 <DC 貼文 id>`（網站網址 `#records=` 後面那段；小寫、`#`、整個網址也可以） |
| LINE | `/更正 局號 內容`：送出更正（內容可以多行） | `/更正 S1794 第一局是 158`，或局號後換行貼整份改好的牌譜 |
| Discord | `/更正 局號:… [內容:…]`（內容不填＝查這局；回覆只有本人看得到） | `/更正 局號:S1794 內容:第一局是 158` |

- **查詢**的回覆：標頭（`【局號】實戰／模擬・線瓦・日期`）、文字牌譜（同網站「DC 牌譜格式（文字）」：每次提議一行、任務、湖、六碼、`刺客刺殺:`；Discord 包在 code block）、
  座位一行 `1家 暱稱｜…｜0家 暱稱`（網站上沒有那一篇就寫配置推出來的角色）、問題（牌譜總庫 `game_db.json` 的 problem 與 error／warn 檢查、網站那一篇的 problem）、網站連結、一行「要更正：…」。
  局號查不到 → 「找不到局號…」。資料讀 `packages/server/game_db.json`（牌譜以總庫為準）與 `records_cache.json`（暱稱、網站上有沒有），兩份都在每日資料更新一起 commit。
- **送出**跟 `/回報` 同一條路（`submitReport`，類型 `correction`，標籤「牌譜更正」）：bot 貼到 DC #同步閒聊＋LINE 群組，回覆「收到，站長確認後才會改（局號）（編號 #R…）」。貼出去的訊息（名字是虛構的）：

  ```
  【百科回報・牌譜更正】#RNF2HA0G0 [更正] S1794
  第一局是 158
  （來自LINE・小明）
  ```

  「來自」後面是送出的人在那個平台的顯示名稱（LINE 群組成員名稱或 1 對 1 的名稱；Discord 伺服器暱稱＞顯示名稱＞使用者名稱），拿不到就不寫。內容最多 1000 字扣掉「[更正] 局號」那一行（S1794 是 989 字）；太長不會截斷，直接回「更正內容太長…最多 N 字」請他縮短或分次送。
- **每日例行作業**：`scripts/listCommunityReports.ts`（上一節）的 `reports[]` 裡 `kind: "correction"` 就是更正，`text` 第一行 `[更正] 局號`、後面是內容；改好總庫後 `--mark-processed <訊息 id>`。
- 頻率限制：送出跟 `/回報` 共用（每個人 10 分鐘 5 筆）；查詢每個人 10 分鐘 20 次。LINE 重送同一個事件：查詢照答，更正不再送一次。
- 不同步：LINE 群組裡打的 `/更正` 原文和回覆都不同步到 DC，Discord 的回覆也不同步到 LINE（同 `/回報`；送出的那則 bot 已經直接貼到兩邊）。
- 程式：`packages/server/src/bots/recordCorrection/`（指令）、`packages/server/src/services/recordLookup.ts`（查局號）。說明：`/help 更正`。

## 每日「阿瓦隆百科小觀念」與觀念卡回饋

2026-11-18 起（站長：「百科觀念卡 我希望能公開出去 並且群組(line & dc) 固定每天早上第一則訊息回覆」「其他人也可以針對這些觀念做回覆 認為不合理或是不清楚的 你再收下做調整」「牌局: 優先以當日 threads/IG 發文的題目」）。**預設全部關閉**，要在 Render 設下面的環境變數才會動。

### 群組裡看到什麼

開了的 LINE 群組／Discord 頻道裡，每天台北 06:00（`CONCEPT_DAILY_START`）以後第一個人講話，bot 就回覆那一則（LINE 用那則訊息的 reply_token、引用它，不用 push 額度；Discord 回覆那一則、不 @ 任何人）。一個群組一天一則，LINE 和 Discord 同一天是同一張卡：

```
[阿瓦隆百科小觀念]
情境: 你是忠臣尾家，在1-5要派3人隊。
觀念: 你唯一確定的好人是自己，外灑等於放棄這個確定的好人。
應用: 派自己加上共識最好的兩位，要外灑就得有理由。
牌局: https://avalon-game-platform.web.app/#records=S358&upto=4&seat=5
觀念卡: https://avalon-game-platform.web.app/#concepts=w206-loyal-self
覺得不合理或不清楚？直接回覆這則訊息，或打「觀念回饋 內容」
```

- **選卡**：先看當天 Threads／IG 的題目（跟每日草稿同一個 `ThreadsGenerator.pickFor`：`threads_picks.json`、threads-state 分支的 `state/<日期>.json`、`threads_live.json` 都在發之前從公開 repo 讀最新的），用 `conceptMatches(那一題)` 取最貼近、而且 14 天內沒發過的卡。沒有題目、或配不到卡，才輪替：整副卡照雜湊排好、一輪裡不重複；情境寫了前提（角色、座位、比分、湖、上一局…）的卡要題庫裡有對得上的實戰牌譜才排進輪替。
- **牌局**：當天那一題的牌譜，**只到出題的那一刻**（`#records=<id>&upto=<整局第幾次派票，從 0 數；刺殺題是 A>&seat=<座位，0 家寫 0>`）：網站藏起那一次（含）之後的派票、任務、湖、結果、刺殺、其他人的角色、名字、標題、標籤與 DC 回覆，只寫「你是 N 家 某角色」和他看得到的座位，按「看完整牌譜」才打開整局。網站上沒有那一局就改連文章那一節，標「文章:」。當天的 Threads 貼文已經發出去（下午才第一則訊息時）會多一行 `Threads: <網址>`。
- **觀念卡**：公開頁是百科攻略的第三個檢視「觀念卡」（`#concepts`，`#concepts=<卡片 id>` 捲到那一張；`packages/web/src/components/ConceptCards.tsx`），可以搜尋、照決策和局篩選，每張卡有證據標籤與「讀這一節」。

### 「第一則」怎麼判斷、怎麼不重發

- 每分鐘的計時器在起始時間前 30 分鐘就把當天的卡算好、存起來。第一則訊息來時卡還沒好（例如伺服器剛被這則訊息叫醒、題庫還在讀），LINE 最多等 2.5 秒、Discord 15 秒，等不到就這一則不發，下一則再發。
- 記憶體先標「處理中」，同一個群組同時來的第二則不會再發；**真的送出去之後**才記「今天發過」，沒送出去（reply_token 過期、Discord 失敗）就不記，下一則再試。
- 「今天發過」、每天選的卡、bot 那一則的訊息 id 存在 private repo 的 JSON 檔（預設帳號庫 `GITHUB_ACCOUNTS_REPO` 的 `bot-state/concept-daily.json`，用 `GITHUB_ACCOUNTS_TOKEN`），重啟後照樣知道今天發過。檔案裡沒有聊天內容：群組 id 是雜湊過的。沒有設定 repo 時只放記憶體（開機 log 會寫；重啟後當天可能再發一次）。
- 模擬瓦進行中的題目（2026-11-25）存在同一個 repo、同一個資料夾的 `bot-state/sim-sessions.json`，用同一把權杖，不用另外設定；見 [`BOTS.md`〈伺服器重啟〉](BOTS.md#伺服器重啟什麼還在什麼會不見)。

### 回饋

- 在開了的群組裡**引用（回覆）bot 那一則小觀念**（Discord 的回覆、LINE 的引用回覆），或打 `觀念回饋 內容`／`/觀念 內容`（LINE 的引用萬一認不出來時用，算到這個群組最近一次發的那張卡），bot 回「收到，會轉給百科整理，謝謝。」，並把內容貼到管理員頻道（`FEEDBACK_DISCORD_CHANNEL_ID`，沒設就是「大劍管理員」；跟 /意見 同一個地方，**不進 repo、不進 log**）：

  ```
  【觀念卡回饋】w206-loyal-self
  日期 2026-11-18｜LINE｜群 3f9c0a1b2c4d｜人 8e1f2a3b4c5d｜時間 2026-11-17T22:31:05.000Z
  應用那句跟情境對不上
  ```

  群組與人都只有雜湊（`CONCEPT_ID_SALT`），不寫名字、不 @ 任何人。只打「觀念回饋」沒有內容 → 回用法。
- 限流：每人 10 分鐘 3 則、一天 10 則；全部每小時 60 則。超過的不回、不存（狀態頁只算次數）。

#### 每日例行作業：讀回饋、標記已處理

只在本機跑（輸出有群友打的原文，不要放進 GitHub Actions、公開 log、issue 或 repo）：

```bash
cd packages/server
DISCORD_BOT_TOKEN=… npx tsx scripts/conceptFeedback.ts list --since 2026-11-18T00:00:00+08:00 > concept_feedback.json   # 只列沒處理的；--all 連已處理的
DISCORD_BOT_TOKEN=… npx tsx scripts/conceptFeedback.ts mark <訊息 id> [<訊息 id> …]                              # 那一則第一行結尾加「（已處理）」
```

- `list` 的 stdout：`{channelId, since, items: [{messageId, cardId, date, platform, groupHash, userHash, createdAt, text, handled}]}`；`mark` 每一則一行 `{"messageId", "result": "edited|already|not_found|failed"}`。只認 bot 自己貼、開頭「【觀念卡回饋】」的訊息。
- 改卡：照回饋改 `packages/server/src/bots/threads/concepts.json`（開 PR，`ThreadsConcepts.test.ts` 檢查格式與文章章節），合併後 `mark` 那幾則。
- 機器人在管理員頻道要有「讀取訊息歷史」；標記是編輯 bot 自己的訊息。

### 環境變數（Render → Environment；全部選填，預設關）

| 變數 | 值 | 說明 |
|---|---|---|
| `CONCEPT_DAILY_LINE` | `true` | 開 LINE |
| `CONCEPT_DAILY_LINE_GROUP_IDS` | `C…,C…` | LINE 群組 id（逗號或空白分隔）；空的就算開了也不發。群組 id：在群裡講一句話，Render → Logs 會印 `[LINE] event from group C…`；鏡像群就是 `LOBBY_MIRROR_LINE_GROUP_ID` 那個 |
| `CONCEPT_DAILY_DISCORD` | `true` | 開 Discord |
| `CONCEPT_DAILY_DISCORD_CHANNEL_IDS` | `123…,456…` | Discord 頻道 id（開發者模式 → 頻道右鍵 → 複製 ID） |
| `CONCEPT_DAILY_START` | `06:00` | 每天幾點（台北）以後的第一則訊息；預設 06:00 |
| `CONCEPT_FEEDBACK` | `false` | 關掉回饋（預設開，只在上面的群組／頻道） |
| `CONCEPT_ID_SALT` | 隨機字串 | 群組／使用者 id 雜湊的鹽（選填，有預設值；設了以後別再改，不然同一個群組的雜湊會變） |
| `CONCEPT_DAILY_STATE_REPO` / `_TOKEN` / `_BRANCH` / `_PATH` | | 狀態檔放哪（預設 `GITHUB_ACCOUNTS_REPO`／`GITHUB_ACCOUNTS_TOKEN`／`GITHUB_ACCOUNTS_BRANCH`／`bot-state/concept-daily.json`）；**務必 private repo**、權杖要有那個 repo 的 Contents 讀寫 |
| `THREADS_LIVE_FROM` | `YYYY-MM-DD` | 選用：跟 repo 變數同名同義（Threads 正式發的第一天）；沒設就讀 `threads_live.json` 的 `liveFrom` |

- 狀態頁 `/api/bots/status` → `conceptDaily`：開關、列了幾個群組／頻道、狀態放哪（github／memory）、今天的卡片 id 與連結種類、計數（只有數字，沒有 id 或內容）。
- 程式：`packages/server/src/bots/conceptDaily/`（`plan.ts` 選卡與格式、`service.ts` 一天一次與回饋、`store.ts` 狀態檔、`threadsToday.ts` 當天的 Threads 題目、`discord.ts`）、`packages/server/src/bots/line/client.ts`（跟同步佇列共用 reply_token：指令回答 → 小觀念 → 同步佇列，最多 5 則）、`packages/server/src/services/conceptFeedbackList.ts`（讀回饋、標記）。測試：`ConceptDaily.test.ts`、`WebConceptsAndCut.test.ts`。

---

## Features

### Discord Bot Features

✅ **Slash Commands**
- Native Discord command system
- Auto-complete support
- Embedded rich messages

✅ **Status Rotation**
- Dynamic bot status
- Configurable status messages
- Automatic rotation

✅ **Error Handling**
- Comprehensive error messages
- User-friendly feedback
- Graceful degradation

### Line Bot Features

✅ **Flex Messages**
- Rich card-based UI
- Carousel support
- Interactive buttons

✅ **Quick Reply**
- Quick action buttons
- Improved UX
- One-click commands

✅ **Webhook Verification**
- Signature validation
- Security verification
- Event filtering

---

## Troubleshooting

### Discord Bot Not Responding

1. **Check Bot Token**: Verify `DISCORD_BOT_TOKEN` is correct
2. **Check Permissions**: Ensure bot has required permissions in server
3. **Check Guild ID**: If using guild-specific commands, verify `DISCORD_GUILD_ID`
4. **Check Server Logs**: Look for error messages in console

### Line Bot Not Receiving Messages

1. **Check Webhook URL**: Ensure it's publicly accessible
2. **Check Credentials**: Verify access token and channel secret
3. **Check Signature**: Line verifies webhook signatures
4. **Check HTTPS**: Webhook must use HTTPS with valid certificate

### Environment Variables Not Loading

1. **File Location**: Ensure `.env` is in `packages/server` directory
2. **Format**: Check for syntax errors in `.env` file
3. **Restart**: Restart server after changing `.env`
4. **Quotes**: Remove quotes around values

---

## Testing

### Local Testing - Discord

```bash
# Terminal 1: Start server
cd packages/server
pnpm dev

# Terminal 2: In Discord server
/help
/create
/status
```

### Local Testing - Line

```bash
# The production backend owns the LINE webhook URL (it PUTs it to LINE at boot —
# see docs/LINE_DISCORD_SYNC.md). Cloud Run (asia-east1) was retired 2026-06-25;
# the backend is on Render, and RENDER_EXTERNAL_URL is used automatically.
#
# Never register a temporary tunnel URL in LINE Console — every tunnel restart
# orphaned the webhook (root cause of the recurring outages, 2026-04-19→09-07).
# To exercise the webhook locally, run the in-process round-trip suite instead:
pnpm test:line-sync
# If you really need a live tunnel, keep it out of the console and self-post a
# signed LINE event JSON with curl/postman; Ctrl+C when done:
cloudflared tunnel --url http://localhost:3001
#
# 長期穩定別名：見 tree_registry/architecture/url_aliasing.md（Edward 買網域後啟用）
```

---

## Security Notes

⚠️ **Never commit credentials to git!**

```bash
# Good: Store in .env (gitignored)
DISCORD_BOT_TOKEN=secret_token

# Bad: Hardcoded in code
const token = 'secret_token'
```

---

## Support & Resources

- [Discord.js Docs](https://discord.js.org/)
- [Line Bot SDK](https://line.github.io/line-bot-sdk-nodejs/)
- [Discord Developer Docs](https://discord.com/developers/docs)
- [Line Messaging API](https://developers.line.biz/en/reference/messaging-api/)

---

**Last Updated**: 2025-03-25
