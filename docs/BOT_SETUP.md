# 🤖 Avalon Bot Setup Guide

Complete guide for setting up Discord and Line bots for Avalon game platform.

## Table of Contents

1. [Discord Bot Setup](#discord-bot-setup)
2. [Line Bot Setup](#line-bot-setup)
3. [Environment Variables](#environment-variables)
4. [Deployment](#deployment)
5. [Commands](#commands)
6. [補位機器人（/機器人補位、/補位）](#補位機器人機器人補位補位)

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

2026-11-03 起，玩家可以叫 signage-cloud 的「補位機器人」進房間補一個位子，方便測試。一間房一次只叫一隻；指令只有房號和局數兩個參數。

| 平台 | 指令 | 範例 |
|---|---|---|
| Discord | `/機器人補位 房號 [局數]`（斜線指令，選項「房號」「局數」） | `/機器人補位 房號:Room-1460 局數:2` |
| LINE | `/補位 房號 [局數]`（也接受 `/機器人補位`、全形 `／`） | `/補位 Room-1460`、`/補位 1460 2` |

- **房號**：`Room-1460`（大小寫不拘）或直接打數字 `1460`（1–6 位數）。
- **局數**：1–3，不填就是 1 局。
- 成功時回覆：「已叫補位機器人到 Room-1460（1 局），約 1–2 分鐘後進房；打完會離開。」Discord 成功的回覆大家看得到，格式錯誤、冷卻中等拒絕只有下指令的人看得到（ephemeral）。
- **限制**（兩個平台共用，存在伺服器記憶體，重啟會歸零）：全站每 3 分鐘最多叫一次；每天（台北時間）最多 10 次；同一間房 15 分鐘內不重複叫。GitHub 回錯誤時不扣次數；連不到 GitHub（逾時）時仍算一次，避免同一房進兩隻。
- 兩個指令都列在 `/help`（Discord）與 `/指令`（LINE）裡，也不算進意見主題計數與聊天匯出。
- 運作方式：伺服器呼叫 GitHub Actions 的 workflow_dispatch，跑 `.github/workflows/signage-player.yml`（輸入 `room`、`games`，ref `main`）。程式在 `packages/server/src/services/signagePlayerDispatch.ts`、`packages/server/src/bots/seatFiller/`。Log 只記狀態碼，不記玩家名字、訊息內容或 token。

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
