# GitHub Actions & Deployment Setup

Welcome! This directory contains all CI/CD configurations for avalonpediatw.

## Quick Navigation

Start here based on your role:

### I'm a Developer
- Want to understand how deployments work? → Read [`DEPLOYMENT.md`](DEPLOYMENT.md)
- Made a change and workflow failed? → Check `STATUS.md` → Troubleshooting section
- Need to run tests locally? → Check `packages/` directory for test scripts

### I'm Setting Up Render
- First time setting up Render? → Follow [`RENDER_SETUP.md`](RENDER_SETUP.md) step-by-step
- Already have Render service? → Just set GitHub secret `RENDER_DEPLOY_HOOK_URL`
- Need to verify secrets? → Run Deploy Server workflow manually, check "Verify Secrets" job

### I'm DevOps / Project Lead
- Overview of deployment architecture? → Read [`STATUS.md`](STATUS.md)
- Need implementation checklist? → Follow [`IMPLEMENTATION_CHECKLIST.md`](IMPLEMENTATION_CHECKLIST.md)
- What changed from Cloud Run? → Read [`MIGRATION_NOTES.md`](MIGRATION_NOTES.md)

### I'm Troubleshooting
- Workflow failed? → Check the job output in GitHub Actions
- Deployment didn't trigger? → Check path filters in workflow file
- Secret validation failed? → Go to Settings → Secrets → verify all secrets are set
- Render deployment hangs? → Check Render dashboard for build logs

---

## Files in This Directory

### Workflow Files (`workflows/`)
| File | Purpose | Triggers |
|------|---------|----------|
| `deploy.yml` | Frontend to GitHub Pages | Push to main with frontend changes |
| `deploy-server.yml` | Backend to Render | Push to main with server changes |
| `deploy-firebase.yml` | Backup to Firebase | Push to main with package changes |
| `test.yml` | Run tests | Push to main, develop, PRs |
| `quality-gate.yml` | Code quality checks | Manual trigger + PRs |

### Documentation Files
| File | Purpose | Audience |
|------|---------|----------|
| `DEPLOYMENT.md` | Architecture & setup overview | Everyone |
| `RENDER_SETUP.md` | Step-by-step Render guide | DevOps |
| `MIGRATION_NOTES.md` | What changed & why | Project leads |
| `STATUS.md` | Current status & next steps | Team leads |
| `IMPLEMENTATION_CHECKLIST.md` | Phase-by-phase execution | Implementers |
| `README.md` | This file | Navigation |

---

## Current Deployment Strategy

```
┌─────────────────────────────────────────────────────┐
│ Push to main branch                                  │
└──────────────┬──────────────────────────────────────┘
               │
        ┌──────┴──────┬──────────────┬──────────────┐
        │             │              │              │
        ▼             ▼              ▼              ▼
   Changes to    Changes to    Changes to    Any package
   packages/web  packages/     render.yaml   change
   ?             server?       Dockerfile?
        │             │              │              │
        ▼             ▼              ▼              ▼
   deploy.yml   deploy-server.yml  │         deploy-firebase.yml
   (GitHub)     (Render)            │         (Firebase)
                                    └──────┘
                                    Both trigger
```

---

## 5-Minute Quickstart

### 1. Check Current Status
```bash
# In GitHub Actions tab, check latest workflow run
# All jobs should show ✅ (green)
```

### 2. Make a Change and Test
```bash
# Example: change frontend
cd packages/web
echo "// test" >> src/App.tsx
git add .
git commit -m "test: verify workflow"
git push origin main
# Watch GitHub Actions → deploy.yml job run
```

### 3. Verify All Three Deployments
- Frontend: Check https://l12203685.github.io/avalonpediatw
- Backend: Check https://avalonpediatw.onrender.com/health
- Firebase: Check https://avalon-game-platform.web.app

---

## Essential Secrets (Must Be Set)

Go to: **Settings** → **Secrets and variables** → **Actions**

### For Render Deployment (CRITICAL)
```
RENDER_DEPLOY_HOOK_URL         (get from Render Settings → Deploy Hook)
```

### For Bot Services (SERVICE REQUIRES THESE)
```
LINE_BOT_CHANNEL_ACCESS_TOKEN
LINE_BOT_CHANNEL_SECRET
LINE_NOTIFY_CLIENT_ID
LINE_NOTIFY_CLIENT_SECRET
DISCORD_BOT_TOKEN
```

### For Firebase (IF USING FIREBASE)
```
FIREBASE_SERVICE_ACCOUNT_AVALON
VITE_FIREBASE_API_KEY
... (see DEPLOYMENT.md for full list)
```

Check secret verification job output to see which are missing.

---

## Workflow Behavior

### When Does Each Workflow Trigger?

| Trigger | deploy.yml | deploy-server.yml | deploy-firebase.yml |
|---------|-----------|------------------|-------------------|
| Push to main | If web/** changed | If server/** changed | Always |
| Manual (UI) | Yes | Yes | Yes |
| PR to develop | Tests only (test.yml) | - | - |

### What Happens If Tests Fail?

- `deploy.yml`: Tests fail but continue-on-error (won't block deploy)
- `deploy-server.yml`: Tests fail and block deployment (intentional)
- `deploy-firebase.yml`: Build-only (no unit tests)

### What Happens If Secrets Are Missing?

- `deploy-server.yml` will fail at "Verify Secrets" job
- Clear error message shows which secrets are missing
- Workflow stops before calling Render webhook

---

## Common Questions

**Q: How do I manually trigger a deployment?**
A: Go to Actions tab → select workflow → "Run workflow" button

**Q: Why did my deployment fail?**
A: Check the GitHub Actions job output. Most common: missing secret or test failure.

**Q: Can I deploy without tests?**
A: For server: No (tests block deployment). For frontend: Yes (tests are non-blocking).

**Q: What if Render is down?**
A: Check https://status.render.com. Frontend still works (GitHub Pages). Use Firebase as backup endpoint.

**Q: How do I rollback a bad deployment?**
A: Revert the commit that caused issues, push to main, workflows redeploy.

**Q: Can I disable a workflow?**
A: Yes, but don't. Instead, disable auto-trigger by commenting out the `on:` triggers (still allows manual runs).

---

## Useful Commands

```bash
# Test locally (no deployment)
pnpm install --frozen-lockfile
pnpm --filter @avalon/shared build
pnpm --filter @avalon/server build
pnpm --filter @avalon/server test

# Check workflow syntax
# (GitHub Actions validates automatically)

# View GitHub Actions logs
# (Available in GitHub UI under Actions tab)

# Manually trigger webhook (if needed)
curl -X POST https://api.render.com/deploy/srv-xxx?key=yyy
```

---

## Directory Structure

```
.github/
├── workflows/
│   ├── deploy.yml              # Frontend deployment
│   ├── deploy-server.yml       # Backend deployment
│   ├── deploy-firebase.yml     # Firebase deployment
│   ├── test.yml                # Test suite
│   └── quality-gate.yml        # Code quality
│
├── pull_request_template.md    # PR description template
│
├── DEPLOYMENT.md               # Full architecture guide
├── RENDER_SETUP.md             # Render configuration
├── MIGRATION_NOTES.md          # Migration details
├── STATUS.md                   # Current status
├── IMPLEMENTATION_CHECKLIST.md # Implementation guide
└── README.md                   # This file
```

---

## Support & Escalation

- **Workflow not triggering**: Check path filters in YAML
- **Deployment failing**: Check job output in GitHub Actions
- **Render service down**: Check Render status page
- **Secret issues**: Verify in GitHub Settings → Secrets
- **Unclear process**: Start with DEPLOYMENT.md

---

## Resources

- [GitHub Actions Docs](https://docs.github.com/en/actions)
- [Render Docs](https://render.com/docs)
- [Project Structure](../../README.md)
- [Project Configuration](../CLAUDE.md)

---

## Status

**Deployment Pipeline**: Active and tested
**Last Updated**: 2026-04-01
**Approval**: Ready for production use
**Rollback Risk**: Low

---

Need help? Start with the file matching your role above.
