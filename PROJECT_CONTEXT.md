# avalonpediatw — Project Context

## Project Overview

Real-time Avalon/The Resistance social deduction game platform.
- **Frontend**: React 18 + TypeScript + Vite (`packages/web`)
- **Backend**: Express + Socket.IO (`packages/server`)
- **Accounts**: email/密碼帳號存 private GitHub repo（GitHub-only，`services/githubAuthAccounts.ts`）；Firebase / Supabase 選用，未設定 = guest-only
- **Game records**: 本 repo `avalon-game-records/`（一場一檔 JSON，`services/GitHubGameArchive.ts`）
- **Monorepo**: Turborepo + pnpm workspaces
- **Deployment**: Firebase Hosting（frontend）+ Render Free（backend `avalon-server`，Singapore，Docker，`render.yaml`，push `main` 自動部署）— 2026-06-25 起；Cloud Run 已停用
- **LINE / Discord 三向同步**：`docs/LINE_DISCORD_SYNC.md`

## Build Order (always build shared first)

```bash
pnpm --filter @avalon/shared build
pnpm --filter @avalon/server build   # or @avalon/web
```

## Key URLs

- Frontend: https://avalon-game-platform.web.app
- Backend: Render `avalon-server`（網址見 Render Dashboard；前端 build 讀 GitHub secret `VITE_SERVER_URL`）
- Health check: `<backend>/health`
- Bot / sync status: `<backend>/api/bots/status`
- Build version probe: `<backend>/api/version`

> URL aliasing rules: see `digital-immortal-tree-lyh/agent/tree_registry/architecture/url_aliasing.md`.
> 2026-04-23 刪除的是當時的 Render 服務；2026-06-25 起後端回到 Render Free（Cloud Run 長連線計費過高，見 `docs/RENDER_FREE_DEPLOY.md`）。
> Cloud Run（`*.run.app`）、ngrok、trycloudflare 皆為歷史 URL — 一律不寫死進新 config / docs。

## gstack

Use /browse from gstack for all web browsing. Never use mcp__claude-in-chrome__* tools.

Available skills:
/office-hours, /plan-ceo-review, /plan-eng-review, /plan-design-review,
/design-consultation, /review, /ship, /land-and-deploy, /canary, /benchmark, /browse,
/qa, /qa-only, /design-review, /setup-browser-cookies, /setup-deploy, /retro,
/investigate, /document-release, /codex, /cso, /autoplan, /careful, /freeze, /guard,
/unfreeze, /gstack-upgrade.

If gstack skills aren't working, run: `cd ~/.claude/skills/gstack && ./setup`
