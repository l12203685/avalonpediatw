# 🤖 Avalon Bot Setup Guide

Complete guide for setting up Discord and Line bots for Avalon game platform.

## Table of Contents

1. [Discord Bot Setup](#discord-bot-setup)
2. [Line Bot Setup](#line-bot-setup)
3. [Environment Variables](#environment-variables)
4. [Deployment](#deployment)
5. [Commands](#commands)

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

1. In Channel settings, find "Webhook URL"
2. Set to: `https://your-domain.com/webhook/line`
3. Enable "Use webhook"

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
# Use ngrok for local webhook testing
ngrok http 3001

# Set webhook URL to:
https://[ngrok-url]/webhook/line
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
