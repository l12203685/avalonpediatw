# avalonpediatw — Project Context

## Project Overview

Real-time Avalon/The Resistance social deduction game platform.
- **Frontend**: React 18 + TypeScript + Vite (`packages/web`)
- **Backend**: Express + Socket.IO (`packages/server`)
- **Database**: Firebase Realtime DB + Firebase Auth
- **Monorepo**: Turborepo + pnpm workspaces
- **Deployment**: Firebase Hosting (frontend) + Google Cloud Run (backend, asia-east1)

## Build Order (always build shared first)

```bash
pnpm --filter @avalon/shared build
pnpm --filter @avalon/server build   # or @avalon/web
```

## Key URLs

- Frontend: https://avalon-game-platform.web.app
- Backend: https://avalon-server-169653523467.asia-east1.run.app
- Health check: https://avalon-server-169653523467.asia-east1.run.app/health
- Build version probe: https://avalon-server-169653523467.asia-east1.run.app/api/version

> URL aliasing rules: see `digital-immortal-tree-lyh/agent/tree_registry/architecture/url_aliasing.md`.
> Render.com 後端已於 2026-04-23 全面刪除（見 `tree_registry/architecture/render_deprecation.md`），ngrok / trycloudflare 為歷史過渡 URL — 一律不寫死進新 config / docs。

## gstack

Use /browse from gstack for all web browsing. Never use mcp__claude-in-chrome__* tools.

Available skills:
/office-hours, /plan-ceo-review, /plan-eng-review, /plan-design-review,
/design-consultation, /review, /ship, /land-and-deploy, /canary, /benchmark, /browse,
/qa, /qa-only, /design-review, /setup-browser-cookies, /setup-deploy, /retro,
/investigate, /document-release, /codex, /cso, /autoplan, /careful, /freeze, /guard,
/unfreeze, /gstack-upgrade.

If gstack skills aren't working, run: `cd ~/.claude/skills/gstack && ./setup`
