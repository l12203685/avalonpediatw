# 🚀 Deployment Guide - Avalon Pedia

Complete guide for deploying Avalon Pedia to production.

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Frontend Deployment (Vercel)](#frontend-deployment-vercel)
3. [Backend Deployment (Railway)](#backend-deployment-railway)
4. [Environment Setup](#environment-setup)
5. [CI/CD Pipeline](#cicd-pipeline)
6. [Domain & SSL](#domain--ssl)
7. [Monitoring & Logging](#monitoring--logging)
8. [Scaling & Performance](#scaling--performance)
9. [Troubleshooting](#troubleshooting)

---

## Architecture Overview

```
┌─────────────────────────────────────────┐
│         Client Applications             │
├─────────┬──────────────────┬────────────┤
│ Web App │  Discord Bot    │  Line Bot  │
│ (React) │  (@discord.js)  │  (@line)   │
└────┬────┴────────┬─────────┴────────┬───┘
     │             │                  │
     ▼             ▼                  ▼
┌──────────────────────────────────────────┐
│        Vercel (Frontend)                 │
│        Railway (Backend)                 │
├──────────────────────────────────────────┤
│  Express Server + Socket.IO + Bots       │
└────┬──────────────────────────────────┬──┘
     │                                  │
     ▼                                  ▼
┌──────────────────────┐        ┌─────────────┐
│  Firebase (Auth      │        │  Realtime   │
│  + Database)         │        │  Database   │
└──────────────────────┘        └─────────────┘
```

---

## Frontend Deployment (Vercel)

### Prerequisites

- Vercel Account (https://vercel.com)
- GitHub Repository
- Node.js >= 18

### Step 1: Create Vercel Project

```bash
# Option 1: Using CLI
npm install -g vercel
cd packages/web
vercel

# Option 2: GitHub Integration
# 1. Go to vercel.com
# 2. Click "New Project"
# 3. Import your GitHub repository
# 4. Select "packages/web" as root directory
```

### Step 2: Configure Environment Variables

In Vercel Dashboard:

```
Settings → Environment Variables

Add:
- VITE_API_URL = https://your-api.railway.app
- FIREBASE_API_KEY = your_firebase_api_key
- FIREBASE_AUTH_DOMAIN = your_project.firebaseapp.com
- FIREBASE_PROJECT_ID = your_project_id
- FIREBASE_STORAGE_BUCKET = your_bucket.appspot.com
- FIREBASE_MESSAGING_SENDER_ID = 123456789
- FIREBASE_APP_ID = 1:123456789:web:abcdef
```

### Step 3: Configure Build Settings

```
Build Command: pnpm build
Output Directory: dist
Install Command: pnpm install --frozen-lockfile
```

### Step 4: Deploy

```bash
# Automatic: Commit to main branch (if GitHub integrated)
# Manual:
vercel --prod

# Check deployment
https://your-project.vercel.app
```

---

## Backend Deployment (Railway)

### Prerequisites

- Railway Account (https://railway.app)
- GitHub Repository
- Node.js >= 18

### Step 1: Create Railway Project

```bash
# Option 1: Using Railway CLI
npm install -g @railway/cli
railway login
cd packages/server
railway init

# Option 2: Web Dashboard
# 1. Go to railway.app
# 2. Click "New Project"
# 3. Select "Deploy from GitHub"
# 4. Authorize and select repository
```

### Step 2: Configure Build Settings

In `railway.json` (already included):

```json
{
  "builder": "nixpacks",
  "buildCommand": "pnpm build",
  "startCommand": "pnpm start"
}
```

### Step 3: Set Environment Variables

In Railway Dashboard:

```
Settings → Variables

Add all from .env.example:

Firebase:
- FIREBASE_PROJECT_ID
- FIREBASE_PRIVATE_KEY (base64 encoded)
- FIREBASE_CLIENT_EMAIL

Discord:
- DISCORD_BOT_TOKEN
- DISCORD_CLIENT_ID
- DISCORD_GUILD_ID (optional)

Line:
- LINE_CHANNEL_ACCESS_TOKEN
- LINE_CHANNEL_SECRET

Server:
- NODE_ENV = production
- PORT = 3001
```

### Step 4: Configure Database

```bash
# Option 1: Use Railway's PostgreSQL
railway add postgresql

# Option 2: External database
DATABASE_URL=postgresql://user:pass@host:5432/db
```

### Step 5: Deploy

```bash
# Automatic (GitHub integration)
git push origin main

# Manual
railway up

# Check deployment
railway logs
railway open
```

---

## Environment Setup

### Local Development

```bash
# 1. Copy environment template
cp .env.example .env.local

# 2. Fill in credentials
# Edit .env.local with your values

# 3. Start development
pnpm dev

# Frontend: http://localhost:5173
# Backend: http://localhost:3001
```

### Firebase Service Account

```bash
# 1. Get from Firebase Console:
# Project Settings > Service Accounts > Generate New Private Key

# 2. Encode as base64:
base64 -w 0 < service-account.json

# 3. Set in environment:
FIREBASE_PRIVATE_KEY_B64=encoded_content
```

### Discord Bot Setup

```bash
# 1. Create Discord Application
# https://discord.com/developers/applications

# 2. Get Bot Token
# Settings > Bot > TOKEN (Copy)

# 3. Set Permissions
# OAuth2 > URL Generator
# Scopes: bot, applications.commands
# Permissions: Send Messages, Embed Links, etc.

# 4. Invite Bot to Server
# Copy generated URL and open in browser
```

### Line Bot Setup

```bash
# 1. Create Channel
# https://developers.line.biz/

# 2. Get Credentials
# Messaging API > Channel Secret & Access Token

# 3. Set Webhook
# Channel Settings > Webhook URL
# https://your-domain/webhook/line

# 4. Enable Webhook
# Settings > Webhook > Enable
```

---

## CI/CD Pipeline

### GitHub Actions

Workflows included in `.github/workflows/`:

#### test.yml
Runs on: `push`, `pull_request`
- Type checking (TypeScript)
- Linting (ESLint)
- Tests (Vitest)
- Build verification
- Security audit

```bash
# Manual trigger
gh workflow run test.yml
```

#### deploy.yml
Runs on: `push to main`, manual trigger
- Deploy frontend to Vercel
- Deploy backend to Railway
- Notify deployment status

```bash
# Manual trigger
gh workflow run deploy.yml
```

### Local Testing

```bash
# Before pushing
pnpm type-check  # TypeScript
pnpm lint        # ESLint
pnpm test        # Tests
pnpm build       # Build
```

---

## Domain & SSL

### Custom Domain Setup

#### Vercel

```
Settings → Domains

Add domain:
- avalon-pedia.com
- www.avalon-pedia.com

Add DNS records:
- Type: CNAME
- Name: www
- Value: cname.vercel-dns.com
```

#### Railway

```
Settings → Custom Domain

Add domain:
- api.avalon-pedia.com

Configure DNS:
- Type: CNAME
- Name: api
- Value: railway.app
```

### SSL Certificate

- Vercel: Automatic (Let's Encrypt)
- Railway: Automatic (Let's Encrypt)

Verify:
```bash
curl -I https://your-domain.com
```

---

## Monitoring & Logging

### Frontend Monitoring (Vercel)

```
Dashboard → Analytics

Monitor:
- Page Load Time
- First Contentful Paint (FCP)
- Cumulative Layout Shift (CLS)
- Core Web Vitals
```

### Backend Logging

```bash
# View Railway logs
railway logs -f

# Local development
LOG_LEVEL=debug pnpm dev
```

### Error Tracking (Optional)

```bash
# Setup Sentry
npm install @sentry/node

# Add to code
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV,
});

# Set environment variable
SENTRY_DSN=https://your-sentry-dsn
```

---

## Scaling & Performance

### Frontend Optimization

- ✅ Code splitting (already in Vite)
- ✅ Image optimization
- ✅ CSS minification
- ✅ Bundle analysis: `pnpm build -- --analyze`

### Backend Optimization

- Implement caching
- Optimize database queries
- Use connection pooling
- Monitor memory usage

```bash
# Monitor in Railway
railway logs | grep memory
```

### Load Balancing

Railway automatically handles:
- Request routing
- Auto-scaling
- Health checks

### Database Optimization

```sql
-- Create indexes
CREATE INDEX idx_player_room ON players(room_id);
CREATE INDEX idx_vote_room ON votes(room_id);
```

---

## Troubleshooting

### Common Issues

#### Vercel Build Fails

```
Error: Cannot find module '@avalon/shared'

Solution:
- Check pnpm-workspace.yaml
- Verify build command: pnpm build
- Check node version: Node >= 18
```

#### Railway Deployment Fails

```
Error: FIREBASE_PRIVATE_KEY not found

Solution:
- Verify environment variable is set
- Check base64 encoding
- Verify newlines in key: -----END PRIVATE KEY-----\n
```

#### Discord Bot Not Responding

```
Solution:
- Verify DISCORD_BOT_TOKEN
- Check bot has permissions in server
- Verify commands are registered
- Check server logs: railway logs
```

#### Line Bot Not Receiving Messages

```
Solution:
- Verify webhook URL is accessible
- Check LINE_CHANNEL_SECRET for signature
- Enable webhook in Channel Settings
- Test with: curl -X POST https://your-domain/webhook/line
```

### Debugging

```bash
# SSH into Railway
railway shell

# Check environment
printenv | grep DISCORD
printenv | grep FIREBASE

# Check logs
tail -f /var/log/app.log

# Test connectivity
curl http://localhost:3001/health
```

---

## Production Checklist

- [ ] All environment variables set
- [ ] CORS configured correctly
- [ ] SSL certificate valid
- [ ] Database backups enabled
- [ ] Monitoring/logging setup
- [ ] Error tracking enabled
- [ ] Rate limiting configured
- [ ] Security headers set
- [ ] HTTPS only enforced
- [ ] Bot permissions verified
- [ ] Webhook signatures verified
- [ ] Load testing completed
- [ ] Disaster recovery plan
- [ ] Documentation updated

---

## Rollback Procedure

### Vercel

```bash
# Revert to previous deployment
Vercel Dashboard → Deployments → Select → Redeploy

# Or using CLI
vercel rollback
```

### Railway

```bash
# View deployment history
railway deployments

# Redeploy previous version
railway redeploy [deployment-id]
```

---

## Support & Resources

- [Vercel Docs](https://vercel.com/docs)
- [Railway Docs](https://docs.railway.app)
- [Firebase Hosting](https://firebase.google.com/docs/hosting)
- [GitHub Actions](https://docs.github.com/en/actions)
- [Discord.js Hosting](https://discord.js.org/)

---

**Last Updated**: 2025-03-25
**Maintenance**: Check dependencies monthly, review logs weekly
