# Render.com Deployment Setup

## Quick Setup Checklist

- [ ] Render service created and running
- [ ] Render Deploy Hook URL obtained
- [ ] GitHub Secret `RENDER_DEPLOY_HOOK_URL` set
- [ ] All other required secrets configured
- [ ] Test deployment via manual workflow trigger

---

## Step-by-Step Setup

### 1. Create Render Service (if not already done)

1. Go to [Render Dashboard](https://dashboard.render.com)
2. Click **New +** → **Web Service**
3. Connect your GitHub repository `l12203685/avalonpediatw`
4. Configure:
   - **Name**: avalonpediatw
   - **Environment**: Node
   - **Build Command**: `pnpm install --frozen-lockfile && pnpm --filter @avalon/shared build && pnpm --filter @avalon/server build`
   - **Start Command**: `pnpm --filter @avalon/server start`
   - **Region**: Singapore (or closest to your users)
   - **Plan**: Starter (free tier)

### 2. Obtain Deploy Hook URL

1. In Render Dashboard, select the **avalonpediatw** service
2. Go to **Settings** tab
3. Scroll down to **Deploy Hook**
4. Copy the full URL (looks like: `https://api.render.com/deploy/srv-xxxxxxx?key=xxxxxxx`)

### 3. Set GitHub Secret

1. Go to GitHub repo: https://github.com/l12203685/avalonpediatw
2. Click **Settings** → **Secrets and variables** → **Actions**
3. Click **New repository secret**
4. **Name**: `RENDER_DEPLOY_HOOK_URL`
5. **Value**: (paste the URL from step 2)
6. Click **Add secret**

### 4. Verify All Secrets Are Set

Run the **Deploy Server to Render** workflow manually:

1. Go to **Actions** tab
2. Select **Deploy Server to Render**
3. Click **Run workflow** → **Run workflow**
4. The **Verify Render & Bot Secrets** job will show which secrets are missing

Expected output:
```
✅ RENDER_DEPLOY_HOOK_URL is set
✅ LINE_BOT_CHANNEL_ACCESS_TOKEN is set
✅ LINE_BOT_CHANNEL_SECRET is set
✅ LINE_NOTIFY_CLIENT_ID is set
✅ LINE_NOTIFY_CLIENT_SECRET is set
✅ DISCORD_BOT_TOKEN is set
```

### 5. Monitor First Deployment

After triggering a deployment:

1. Check GitHub Actions for workflow status
2. Check [Render Dashboard](https://dashboard.render.com) → avalonpediatw → **Events** tab for deployment logs
3. Once deployed, test health endpoint:
   ```bash
   curl https://avalonpediatw.onrender.com/health
   ```
   Expected response: `{ "status": "ok" }`

---

## How the Workflow Works

### Trigger Events

The `deploy-server.yml` workflow is triggered when:

```yaml
push:
  branches: [main]
  paths:
    - 'packages/server/**'      # Backend code changes
    - 'packages/shared/**'      # Shared utilities changes
    - 'render.yaml'            # Render config changes
    - 'Dockerfile'             # Docker image changes
    - 'pnpm-lock.yaml'         # Dependency changes
workflow_dispatch:              # Manual trigger via UI
```

### Workflow Steps

1. **Test Server**
   - Install dependencies
   - Build shared package
   - Run server tests
   - Fails fast if tests don't pass

2. **Verify Secrets**
   - Checks all required secrets are set
   - Fails if any secret is missing

3. **Deploy**
   - Only runs if test and verify-secrets succeed
   - Calls Render deploy hook via webhook
   - Render automatically pulls latest `main`, builds, and deploys

---

## Troubleshooting

### Deployment Hangs or Takes Too Long

**Render is sleeping on free tier** — first request after inactivity takes 30-60 seconds.

Solution: Keep traffic consistent or upgrade to Starter plan (billed hourly, ~$12/month minimum).

### Deploy Hook Returns 404

**The hook URL is invalid or service was deleted.**

1. Verify the service still exists in Render Dashboard
2. Get a fresh hook URL from Settings → Deploy Hook
3. Update the GitHub secret

### Deploy Succeeds but Backend Still Shows Old Code

**Render may be caching the old image.**

1. Go to Render Dashboard → avalonpediatw
2. Click **Manual Deploy** and select **Clear build cache**
3. Then redeploy

### Health Check Fails After Deployment

**Service might still be starting up.**

1. Wait 30 seconds
2. Try again: `curl https://avalonpediatw.onrender.com/health`
3. Check Render deployment logs for errors

### Tests Fail, Deployment Blocks

**The workflow intentionally blocks if tests fail.**

1. Check test output in GitHub Actions
2. Fix failing tests locally
3. Commit and push to trigger redeployment

---

## Environment Variables on Render

All environment variables should be set in Render Dashboard:

1. Go to avalonpediatw service
2. Click **Environment**
3. Add secrets/vars needed by the server:
   - Database URLs
   - API keys
   - Firebase credentials
   - etc.

Or set them via GitHub secrets and pass to Render during deploy.

---

## Comparison: Cloud Run → Render

| Feature | Cloud Run | Render |
|---------|-----------|--------|
| Build process | Cloud Build (complex) | Render (automatic) |
| Deployment | gcloud CLI + IAM | Webhook (simpler) |
| Sleep/Cold start | Can disable sleep | Free tier sleeps after 15 min |
| Cost (development) | Pay per use | $12/month minimum |
| Region | Multiple | Limited options |
| Scaling | Auto (0 → many) | Auto (1 → many, free tier single) |

Render is ideal for small projects and simpler deployments.

---

## Manual Deployment Commands

If you want to deploy without GitHub Actions:

```bash
# Using Render CLI (if installed)
render deploy --service-id srv-xxxxxxx

# Or trigger webhook directly
curl -X POST https://api.render.com/deploy/srv-xxxxxxx?key=xxxxxxx
```

---

Last updated: 2026-04-01
