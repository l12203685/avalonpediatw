# avalonpediatw Deployment Guide

> **DEPRECATED 2026-04-23** — Render.com 後端已刪除（見 `digital-immortal-tree-lyh/agent/tree_registry/architecture/render_deprecation.md`）。
> 後端現址：Google Cloud Run `https://avalon-server-169653523467.asia-east1.run.app`（asia-east1）。
> URL aliasing 規則：`tree_registry/architecture/url_aliasing.md`。
> 本檔僅保留 git 歷史，不可作為 deployment SOP — 內文所有 onrender.com URL 已過期。

## Overview

The avalonpediatw project uses a multi-platform deployment strategy:

- **Frontend**: Firebase Hosting (via `deploy-firebase.yml`) — 玩家唯一入口 `avalon-game-platform.web.app`
- **Backend**: Google Cloud Run (asia-east1) — `avalon-server-169653523467.asia-east1.run.app`
- **Backup Frontend (legacy)**: GitHub Pages (`deploy.yml`, dispatch-only) / Cloudflare Pages

## Deployment Workflows

### 1. Frontend Deployment (GitHub Pages)

**File**: `.github/workflows/deploy.yml`

**Triggers**:
- Push to `main` branch with changes to `packages/web/**` or `packages/shared/**`
- Manual trigger via `workflow_dispatch`

**Process**:
1. Runs tests on web package
2. Builds shared package
3. Builds frontend with `VITE_SERVER_URL=https://avalonpediatw.onrender.com`
4. Deploys to GitHub Pages branch

**No secrets required** (uses `GITHUB_TOKEN`)

### 2. Backend Deployment (Render.com)

**File**: `.github/workflows/deploy-server.yml`

**Triggers**:
- Push to `main` branch with changes to:
  - `packages/server/**`
  - `packages/shared/**`
  - `render.yaml`
  - `Dockerfile`
  - `pnpm-lock.yaml`
- Manual trigger via `workflow_dispatch`

**Process**:
1. Runs server tests
2. Verifies all required secrets are set
3. Triggers Render deploy via webhook

**Required Secrets**:
- `RENDER_DEPLOY_HOOK_URL` — Render deployment webhook
- `LINE_BOT_CHANNEL_ACCESS_TOKEN` — LINE Bot credentials
- `LINE_BOT_CHANNEL_SECRET` — LINE Bot secret
- `LINE_NOTIFY_CLIENT_ID` — LINE Notify OAuth
- `LINE_NOTIFY_CLIENT_SECRET` — LINE Notify secret
- `DISCORD_BOT_TOKEN` — Discord Bot token

### 3. Firebase Hosting Deployment (Backup)

**File**: `.github/workflows/deploy-firebase.yml`

**Triggers**:
- Push to `main` branch with changes to `packages/**`, `firebase.json`, or `pnpm-lock.yaml`
- Manual trigger via `workflow_dispatch`

**Required Secrets**:
- `FIREBASE_SERVICE_ACCOUNT_AVALON` — Firebase service account JSON
- Firebase environment variables for build

---

## Setup Instructions

### Setting up Render Deployment Hook

1. Go to [Render Dashboard](https://dashboard.render.com)
2. Select the avalonpediatw service
3. Navigate to **Settings** → **Deploy Hook**
4. Copy the Deploy Hook URL
5. In GitHub repo settings → **Secrets and variables** → **Actions secrets**
6. Create new secret: `RENDER_DEPLOY_HOOK_URL` = (paste the hook URL)

### Setting up GitHub Secrets

Go to: `https://github.com/l12203685/avalonpediatw/settings/secrets/actions`

Create these secrets:

```
RENDER_DEPLOY_HOOK_URL              (from Render settings)
LINE_BOT_CHANNEL_ACCESS_TOKEN       (from LINE Developers Console)
LINE_BOT_CHANNEL_SECRET             (from LINE Developers Console)
LINE_NOTIFY_CLIENT_ID               (from LINE Notify)
LINE_NOTIFY_CLIENT_SECRET           (from LINE Notify)
DISCORD_BOT_TOKEN                   (from Discord Developer Portal)
FIREBASE_SERVICE_ACCOUNT_AVALON     (from Firebase Console)
VITE_SERVER_URL                     (https://avalonpediatw.onrender.com)
VITE_FIREBASE_API_KEY               (from Firebase Console)
VITE_FIREBASE_AUTH_DOMAIN           (from Firebase Console)
VITE_FIREBASE_PROJECT_ID            (from Firebase Console)
VITE_FIREBASE_STORAGE_BUCKET        (from Firebase Console)
VITE_FIREBASE_MESSAGING_SENDER_ID   (from Firebase Console)
VITE_FIREBASE_APP_ID                (from Firebase Console)
VITE_FIREBASE_MEASUREMENT_ID        (from Firebase Console)
```

---

## Deployment URLs

- **Frontend (GitHub Pages)**: https://l12203685.github.io/avalonpediatw
- **Backend (Render)**: https://avalonpediatw.onrender.com
- **Firebase Hosting**: https://avalon-game-platform.web.app
- **Health Check**: `GET https://avalonpediatw.onrender.com/health`

---

## Workflow Dependencies

```
deploy.yml:
  test → build-and-deploy

deploy-server.yml:
  test ↘
        → deploy
  verify-secrets ↗

deploy-firebase.yml:
  (standalone)
```

---

## Troubleshooting

### Render Deploy Fails
1. Check that `RENDER_DEPLOY_HOOK_URL` secret is set and valid
2. Verify the Render service is not already deploying
3. Check Render dashboard for build logs
4. Ensure `render.yaml` and `Dockerfile` are valid

### Frontend Build Fails
1. Run `pnpm install --frozen-lockfile` locally
2. Run `pnpm build` to test locally
3. Check that all required environment variables are set

### Secret Verification Fails
1. Check all required secrets are set in GitHub
2. Run the secret verification job manually to see which is missing
3. Copy exact secret names from the workflow file

### Health Check Fails
After deployment, test: `curl https://avalonpediatw.onrender.com/health`

---

## Manual Deployments

### Manual Trigger via GitHub UI

1. Go to **Actions** tab
2. Select desired workflow (Deploy Frontend, Deploy Server, or Deploy to Firebase)
3. Click **Run workflow** → **Run workflow**

### Local Testing

**Frontend**:
```bash
pnpm --filter @avalon/shared build
pnpm --filter @avalon/web build
```

**Backend**:
```bash
pnpm --filter @avalon/shared build
pnpm --filter @avalon/server build
pnpm --filter @avalon/server test
```

---

## Migration from Cloud Run to Render

This project was migrated from Google Cloud Run to Render.com:

**Key Changes**:
- Removed Cloud Build configuration
- Removed Cloud Run service references
- Added Render deploy hook webhook
- Updated frontend VITE_SERVER_URL to point to Render backend
- Maintained Firebase Hosting for static assets (backup)

**Benefits of Render**:
- Simpler deployment model (no complex build steps)
- Automatic preview deployments from PRs
- Built-in environment variable management
- Cost-effective for small teams

---

## Cost Optimization

**Current Deployment Stack**:
- GitHub Pages (frontend) — **Free** (unlimited)
- Render (backend) — **Paid** ($12/month minimum for free tier sleeping disabled)
- Firebase Hosting (backup) — **Free** (with limits)

To reduce costs:
- Keep backend on Render free tier if traffic is low (will sleep after 15 min inactivity)
- Use Firebase Hosting as primary frontend (free tier)
- Archive rarely-used deployments

---

Last updated: 2026-04-01
