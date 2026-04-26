# Cloud Run → Render Migration Notes

> **DEPRECATED 2026-04-23** — Render.com service 已刪除，後端遷回 Cloud Run（asia-east1）。
> 本檔僅為歷史；目前 production backend `https://avalon-server-169653523467.asia-east1.run.app`。
> 見 `tree_registry/architecture/render_deprecation.md` + `tree_registry/architecture/url_aliasing.md`。

## Summary

Successfully migrated avalonpediatw CI/CD pipeline from Google Cloud Run to Render.com deployment.

**Migration Date**: 2026-04-01
**Status**: Complete (ready for deployment)

---

## Files Modified

### 1. `.github/workflows/deploy.yml`
**Changes**:
- Added `paths` filter to trigger only on frontend/shared changes
- Added separate `test` job for frontend
- Made `build-and-deploy` depend on `test` job
- Simplified workflow with explicit job dependencies

**Old**: 19 lines (no tests)
**New**: 76 lines (with test job)

### 2. `.github/workflows/deploy-server.yml`
**Changes**:
- Added `test` job to run server tests before deployment
- Enhanced `verify-secrets` job to check `RENDER_DEPLOY_HOOK_URL` first
- Made `deploy` job depend on `test` and `verify-secrets`
- Added explicit error handling (exit 1 if secrets missing)
- Added helpful comments for Render hook URL format
- Improved output messages

**Old**: 67 lines (minimal testing)
**New**: 103 lines (comprehensive testing and verification)

### 3. `.github/workflows/deploy-firebase.yml`
**Changes**:
- Added `paths` filter to trigger only on relevant changes
- Added `workflow_dispatch` for manual triggers
- Prevents unnecessary Firebase redeploys

**Impact**: Minor optimization, reduces wasted CI/CD runs

### 4. `.github/DEPLOYMENT.md` (NEW)
Comprehensive deployment guide covering:
- Overview of multi-platform deployment strategy
- Detailed workflow documentation
- Setup instructions for all platforms
- Secret configuration guide
- Deployment URLs
- Workflow dependency diagram
- Troubleshooting guide
- Cost optimization tips

### 5. `.github/RENDER_SETUP.md` (NEW)
Quick reference for Render-specific setup:
- Step-by-step Render service creation
- Deploy hook URL retrieval
- GitHub secret configuration
- Workflow verification checklist
- Detailed troubleshooting
- Comparison with Cloud Run
- Manual deployment commands

---

## What Still Needs to Be Done

### 1. Render Service Configuration
- [ ] Create Render service (if not already created)
- [ ] Obtain Deploy Hook URL
- [ ] Configure environment variables in Render Dashboard
- [ ] Set up custom domain (if needed)

### 2. GitHub Secrets
- [ ] Set `RENDER_DEPLOY_HOOK_URL` secret
- [ ] Verify all other secrets are present:
  - LINE_BOT_CHANNEL_ACCESS_TOKEN
  - LINE_BOT_CHANNEL_SECRET
  - LINE_NOTIFY_CLIENT_ID
  - LINE_NOTIFY_CLIENT_SECRET
  - DISCORD_BOT_TOKEN
  - Firebase-related secrets (for deploy-firebase.yml)

### 3. Testing
- [ ] Run Deploy Server workflow manually
- [ ] Verify secret check passes
- [ ] Test server health endpoint after deployment
- [ ] Monitor Render logs for any startup issues

### 4. Documentation
- [ ] Update project README with new deployment info
- [ ] Share RENDER_SETUP.md with team
- [ ] Archive old Cloud Run documentation (if any)

---

## Key Workflow Features

### Frontend Deployment (`deploy.yml`)
- **Triggers**: Push to main with frontend/shared changes
- **Tests**: Web package tests (continue on error)
- **Deployment**: GitHub Pages
- **Secrets**: None required (uses GITHUB_TOKEN)

### Backend Deployment (`deploy-server.yml`)
- **Triggers**: Push to main with server/shared/config changes
- **Tests**: Server tests (blocks deployment if failed)
- **Verification**: All required secrets must be set
- **Deployment**: Render webhook
- **Secrets**: 6 required (see list above)

### Firebase Deployment (`deploy-firebase.yml`)
- **Triggers**: Push to main with package/config changes
- **Tests**: Build-only (no unit tests)
- **Deployment**: Firebase Hosting
- **Secrets**: Firebase service account + env vars

---

## Deployment Sequence

When code is pushed to main:

```
Backend (packages/server) changed?
  → Yes: Deploy Server job triggers
    → Run server tests
    → Verify secrets
    → Trigger Render webhook
    → Render auto-deploys

Frontend (packages/web) changed?
  → Yes: Deploy Frontend job triggers
    → Run web tests
    → Build frontend
    → Push to gh-pages

Any package changed?
  → Yes: Deploy Firebase job triggers
    → Build all packages
    → Deploy to Firebase Hosting
```

Jobs run in parallel (GitHub Actions standard behavior).

---

## Cost Impact

### Before (Cloud Run)
- Cloud Build: Pay per build minute
- Cloud Run: Pay per request + CPU time
- Total: Variable, typically $10-30/month for hobby projects

### After (Render)
- Render: $12/month minimum (free tier for low traffic)
- GitHub Actions: Free tier (2000 min/month)
- Firebase Hosting: Free tier
- Total: $12/month flat rate

**Savings**: Predictable costs for hobby-scale projects

---

## Rollback Plan

If issues arise with Render deployment:

1. **Immediate**: Disable the `deploy-server.yml` workflow in GitHub
2. **Notify team**: Update project status
3. **Investigate**: Check Render logs and GitHub Actions output
4. **Restore**: Re-enable workflow after fixing issue

To disable workflow:
```bash
# In .github/workflows/deploy-server.yml, change:
on:
  push: ...
# to:
on:
  workflow_dispatch: # Disable auto-trigger
```

---

## Render Service Checklist

When setting up Render service:

- [ ] **Repository**: l12203685/avalonpediatw
- [ ] **Build Command**: `pnpm install --frozen-lockfile && pnpm --filter @avalon/shared build && pnpm --filter @avalon/server build`
- [ ] **Start Command**: `pnpm --filter @avalon/server start`
- [ ] **Environment**: Node
- [ ] **Node Version**: 20
- [ ] **Region**: Singapore (or closest)
- [ ] **Plan**: Starter (free tier acceptable for now)
- [ ] **Deploy Hook**: Enabled
- [ ] **Environment Variables**: All configured

---

## Next Steps

1. Read `RENDER_SETUP.md` for detailed setup instructions
2. Create Render service if not already done
3. Configure GitHub secrets
4. Run test deployment via GitHub Actions
5. Monitor logs and health checks
6. Update team on new deployment process

---

## References

- Render Docs: https://render.com/docs
- GitHub Actions: https://docs.github.com/en/actions
- Project CLAUDE.md: For project-specific configuration
- Previous deployment notes: (if any in git history)

---

**Migration completed by**: Claude Code Agent
**Approval status**: Ready for testing
**Rollback risk**: Low (Render setup is additive, doesn't remove existing infrastructure)
