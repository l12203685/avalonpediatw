# 🤖 Avalon Bot Setup Guide

Complete guide for setting up Discord and Line bots for Avalon game platform.

## Table of Contents

1. [Discord Bot Setup](#discord-bot-setup)
2. [Line Bot Setup](#line-bot-setup)
3. [Environment Variables](#environment-variables)
4. [Deployment](#deployment)
5. [Commands](#commands)
6. [補位機器人（/機器人補位、/補位）](#補位機器人機器人補位補位)
7. [百科AI 對局紀錄與回饋](#百科ai-對局紀錄與回饋dc-百科問題回報網站-ai-games)

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
| Discord | `/機器人補位 房號或描述 [人數] [密碼]`（斜線指令；人數選單：補滿、1–9） | `/機器人補位 房號或描述:百科陪練 人數:補滿 密碼:1234` |
| LINE | `/補位 房號或房間描述 [補滿｜幾人] [密碼:xxxx]`（也接受 `/機器人補位`、全形 `／`） | `/補位 1460`、`/補位 百科陪練 補滿 密碼:1234`、`/補位 「百科 陪練」 3人` |

- **房號或描述**：`Room-1460`／`1460`；房間內看不到房號時，打建房時寫的房間描述裡的一段字（最多 40 字，不能有引號或換行；有空白就用「」包起來）。
- **人數**：1–9 個，不填就是 1 個；「補滿」＝一直坐到房間 10 人為止。暱稱 `百科AI_數字`（依房號／描述分段，同時兩間房不撞名），戰績上全部算「百科AI」。
- **密碼**：私房密碼，只用來進房；GitHub log 會遮掉。LINE 群組裡打的密碼大家看得到。沒給密碼時會照慣例試今天日期 MMDD（台灣時間；凌晨 6 點前也試昨天的），特殊私約局再自己給。
- **局數**：不限（最多跑 3 小時）；每局開始前與打完後，百科AI 會在聊天室問「需要我離開嗎？」，有人回「離開」就走。
- 成功時回覆：「已叫百科AI 到「…」（N 個／補到 10 人），約 1–2 分鐘後進房；局數不限，要它走就在房內聊天室打「離開」。」Discord 成功的回覆大家看得到，格式錯誤、冷卻中等拒絕只有下指令的人看得到（ephemeral）。
- **限制**（兩個平台共用，存在伺服器記憶體，重啟會歸零）：全站每 3 分鐘最多叫一次；每天（台北時間）最多 10 次；同一間房 15 分鐘內不重複叫。GitHub 回錯誤時不扣次數；連不到 GitHub（逾時）時仍算一次，避免同一房進兩隻。
- 兩個指令都列在 `/help`（Discord）與 `/指令`（LINE）裡，也不算進意見主題計數與聊天匯出。
- 運作方式：伺服器呼叫 GitHub Actions 的 workflow_dispatch，跑 `.github/workflows/signage-player.yml`（輸入 `room`、`bots`、`password`，ref `main`）。程式在 `packages/server/src/services/signagePlayerDispatch.ts`、`packages/server/src/bots/seatFiller/`。Log 只記狀態碼，不記玩家名字、訊息內容或 token。

### 管理者要做的設定：GITHUB_DISPATCH_TOKEN

沒設 token 時，指令會回「補位機器人還沒設定好」。設定步驟：

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

---

## 百科AI 對局紀錄與回饋（DC #百科問題回報＋網站 #ai-games）

Edward 2026-11-05：「只要有百科AI參與的牌局就自動記錄在網站&DC上 我們可以直接針對AI的動作作反饋」。百科AI（上面的補位機器人，`signage-player.yml`）在遊玩頁打的**每一局**，打完、角色公開之後自動記錄，大家可以針對它的每個派隊、投票、任務、湖、宣告、刺殺給回饋。

### 在 DC 上

- 論壇 **#百科問題回報** 一局開一篇，標籤 **百科AI對局**（論壇沒有這個標籤時，機器人第一次貼文會用 API 加上去；加不了就不掛標籤照貼）。
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
- 機器人要在 #百科問題回報 有「傳送訊息」「建立公開討論串」「附加檔案」「在討論串傳送訊息」權限；自動加標籤要「管理頻道」（沒有的話請管理者手動在論壇加一個「百科AI對局」標籤）。
- 選填：`AI_GAME_FORUM_CHANNEL_ID`（換論壇；`off` 關掉貼文與網站頁）、`DISCORD_GUILD_ID`（列出進行中的討論串用，預設阿瓦隆百科群組）。
- 伺服器讀 DC 的結果在記憶體快取 5 分鐘；附件只從 Discord 的 CDN 讀，只認這個論壇裡標題「百科AI對局」開頭、起始訊息是機器人發的貼文。網站回饋每個 IP 每分鐘 10 則（同網站問題回報），全站每小時最多 120 則。
- 隱私：公開的 GitHub Actions log 只有時間、房號、狀態與數量（例：`Room-1460：百科AI對局已貼到 DC（42 個決定、6 則後續訊息）`），trace 不印到 log；DC 失敗只記狀態碼。本機跑 `--private-log DIR` 會另存一份 `ai-trace-*.json`。
- 開關：`signagePlayer.ts --ai-trace off` 不貼；私房測試（`--mode private-test`）預設不貼，加 `--ai-trace on` 才貼。

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
