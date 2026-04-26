# Implementation Checklist: Cloud Run → Render Migration

> **DEPRECATED 2026-04-23** — Render.com 後端已全面刪除；後端遷回 Google Cloud Run（asia-east1）。
> 本檔記錄歷史軌跡，不可執行。當前後端 URL：`https://avalon-server-169653523467.asia-east1.run.app`。
> 見 `tree_registry/architecture/render_deprecation.md` + `tree_registry/architecture/url_aliasing.md`。


## Phase 1: Pre-Deployment Setup (REQUIRED)

### Render Service Configuration
- [ ] Verify/create Render service `avalonpediatw`
- [ ] Set Service Region to Singapore
- [ ] Set Build Command: `pnpm install --frozen-lockfile && pnpm --filter @avalon/shared build && pnpm --filter @avalon/server build`
- [ ] Set Start Command: `pnpm --filter @avalon/server start`
- [ ] Set Node Version to 20

### GitHub Secrets Configuration
Go to: https://github.com/l12203685/avalonpediatw/settings/secrets/actions

#### Render Secrets (REQUIRED FOR DEPLOYMENT)
- [ ] `RENDER_DEPLOY_HOOK_URL` — Get from Render Settings → Deploy Hook
  - Format: `https://api.render.com/deploy/srv-xxxxxxx?key=xxxxxxx`

#### Bot Secrets (REQUIRED FOR SERVICE)
- [ ] `LINE_BOT_CHANNEL_ACCESS_TOKEN`
- [ ] `LINE_BOT_CHANNEL_SECRET`
- [ ] `LINE_NOTIFY_CLIENT_ID`
- [ ] `LINE_NOTIFY_CLIENT_SECRET`
- [ ] `DISCORD_BOT_TOKEN`

#### Firebase Secrets (FOR deploy-firebase.yml)
- [ ] `FIREBASE_SERVICE_ACCOUNT_AVALON`
- [ ] `VITE_FIREBASE_API_KEY`
- [ ] `VITE_FIREBASE_AUTH_DOMAIN`
- [ ] `VITE_FIREBASE_PROJECT_ID`
- [ ] `VITE_FIREBASE_STORAGE_BUCKET`
- [ ] `VITE_FIREBASE_MESSAGING_SENDER_ID`
- [ ] `VITE_FIREBASE_APP_ID`
- [ ] `VITE_FIREBASE_MEASUREMENT_ID`

---

## Phase 2: Workflow Files (COMPLETED)

### Updated Files
- [x] `.github/workflows/deploy.yml` — Frontend to GitHub Pages
- [x] `.github/workflows/deploy-server.yml` — Backend to Render
- [x] `.github/workflows/deploy-firebase.yml` — Backup to Firebase Hosting

### Unchanged Files
- [x] `.github/workflows/test.yml` — Test suite (no changes needed)
- [x] `.github/workflows/quality-gate.yml` — Code quality (no changes needed)

---

## Phase 3: Documentation (COMPLETED)

### Documentation Files
- [x] `DEPLOYMENT.md` — Architecture and overview
- [x] `RENDER_SETUP.md` — Step-by-step Render configuration
- [x] `MIGRATION_NOTES.md` — Migration details and decisions
- [x] `STATUS.md` — Project status report
- [x] `IMPLEMENTATION_CHECKLIST.md` — This file

---

## Phase 4: Testing (IN PROGRESS)

### Manual Workflow Tests

#### Test 1: Verify All Secrets Are Set
- [ ] Go to GitHub Actions → Deploy Server to Render
- [ ] Click "Run workflow" → "Run workflow"
- [ ] Wait for "Verify Render & Bot Secrets" job to complete
- [ ] Expected: All 6 secrets show ✅

**If any secrets show ⚠️ WARNING:**
- Return to Phase 1
- Set missing secrets
- Re-run test

#### Test 2: Server Tests Pass
- [ ] Check "Test Server" job in the same workflow run
- [ ] Expected: All tests pass or tests continue on error
- [ ] If tests fail: Fix in source code, retry

#### Test 3: Render Deploy Webhook Triggers
- [ ] Check "Trigger Render Deploy" job
- [ ] Expected: curl to RENDER_DEPLOY_HOOK_URL succeeds
- [ ] Expected output: "Render deployment triggered successfully"

#### Test 4: Verify Render Deployment Succeeds
- [ ] Go to [Render Dashboard](https://dashboard.render.com)
- [ ] Select avalonpediatw service
- [ ] Check **Events** tab for latest deployment
- [ ] Expected: Deployment shows as "Live"
- [ ] No errors in deployment logs

#### Test 5: Health Check Endpoint
- [ ] Open terminal
- [ ] Run: `curl https://avalonpediatw.onrender.com/health`
- [ ] Expected response: `{"status":"ok"}` or similar success message
- [ ] If connection refused: Service still starting (wait 30 seconds)
- [ ] If connection timeout: Render service may be sleeping (hit endpoint again)

---

## Phase 5: Integration Testing (AFTER PHASE 4)

### Test Scenario 1: Push Frontend Change
- [ ] Make a change to `packages/web/**`
- [ ] Commit and push to main
- [ ] Expected: `deploy.yml` workflow triggers
  - [ ] Frontend test job runs
  - [ ] Build & deploy job runs
  - [ ] Frontend deploys to GitHub Pages

### Test Scenario 2: Push Backend Change
- [ ] Make a change to `packages/server/**`
- [ ] Commit and push to main
- [ ] Expected: `deploy-server.yml` workflow triggers
  - [ ] Test Server job runs
  - [ ] Verify Secrets job runs
  - [ ] Deploy job triggers Render webhook
  - [ ] Render deploys new backend version

### Test Scenario 3: Push Shared Package Change
- [ ] Make a change to `packages/shared/**`
- [ ] Commit and push to main
- [ ] Expected: Both workflows trigger (frontend AND backend)

### Test Scenario 4: Push Render Config Change
- [ ] Modify `render.yaml` or `Dockerfile`
- [ ] Commit and push to main
- [ ] Expected: `deploy-server.yml` workflow triggers

---

## Phase 6: Production Rollout (FINAL)

### Pre-Rollout Verification
- [ ] All Phase 4 tests passed
- [ ] All Phase 5 integration tests passed
- [ ] Backend health check endpoint responding
- [ ] No errors in Render deployment logs
- [ ] Team notified of new deployment process

### Rollout Steps
1. [ ] Enable `deploy-server.yml` workflow (if currently disabled)
2. [ ] Remove any manual deploy instructions from documentation
3. [ ] Update team on new Render-based deployment
4. [ ] Monitor first week of production deployments

### Post-Rollout Monitoring
- [ ] Monitor Render dashboard for any errors
- [ ] Watch GitHub Actions for failed deployments
- [ ] Track response times and health checks
- [ ] Gather team feedback

---

## Rollback Procedure (IF NEEDED)

### If Render Deployment Fails
1. [ ] Disable `deploy-server.yml` by editing on GitHub
2. [ ] Revert the workflow file: `git revert <commit-hash>`
3. [ ] Push reverted version
4. [ ] Investigate root cause in GitHub issues
5. [ ] Fix and retry

### If Secrets Are Wrong
1. [ ] Disable workflows
2. [ ] Correct secrets in GitHub
3. [ ] Re-enable workflows
4. [ ] Retry deployment

### If Render Service Is Down
1. [ ] Check Render status page: https://status.render.com
2. [ ] Wait for Render to recover OR
3. [ ] Migrate to backup Firebase endpoint
4. [ ] Update frontend VITE_SERVER_URL to backup

---

## Troubleshooting Quick Reference

| Problem | Solution |
|---------|----------|
| Secret verification fails | Check Phase 1 secrets are all set |
| Server tests fail | Fix code locally, commit and retry |
| Deploy hook returns 404 | Verify RENDER_DEPLOY_HOOK_URL is current |
| Render deployment hangs | Check Render dashboard, may be building |
| Health endpoint times out | Service sleeping on free tier, wait 30s |
| Health endpoint returns 502 | Service crash, check Render logs |
| Frontend doesn't update | GitHub Pages cache, hard refresh browser |
| Firebase doesn't deploy | Check Firebase credentials secret is set |

---

## Sign-Off Checklist

### For Developer
- [ ] All tests pass locally
- [ ] GitHub Actions workflows execute successfully
- [ ] Render deployment completes without errors
- [ ] Health check endpoint responds

### For DevOps
- [ ] All secrets configured in GitHub
- [ ] Render service created and configured
- [ ] Deploy hook URL obtained and tested
- [ ] Monitoring/alerts set up (if applicable)

### For Project Lead
- [ ] Documentation reviewed and approved
- [ ] Team notified of new deployment process
- [ ] Rollback plan understood
- [ ] Go/no-go decision made

---

## Contact & Escalation

**Workflow Issues**: Check `.github/workflows/` files and GitHub Actions UI
**Render Issues**: Check Render dashboard and logs
**Documentation Issues**: Update `.github/DEPLOYMENT.md`

---

## Success Metrics

After rollout, verify:

- [ ] All pushes to main trigger appropriate workflows
- [ ] Test failures block deployments
- [ ] Deployments to Render succeed within 5 minutes
- [ ] Health endpoint responds with <500ms latency
- [ ] No manual intervention required for routine deployments
- [ ] Team can self-serve deployment with documentation

---

## Notes

- This migration is **non-breaking** (additive changes)
- Existing GitHub Pages and Firebase deployments continue to work
- Render deployment can be disabled independently without affecting other workflows
- All infrastructure changes are reversible via git history

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2026-04-01 | Claude Code | Initial implementation checklist |

---

**Status**: Ready for Phase 1 execution
**Target Date**: 2026-04-01 (immediate)
**Estimated Duration**: 30-60 minutes (Phase 1-2), 15 minutes (Phase 3-4)
