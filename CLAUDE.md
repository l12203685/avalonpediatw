# avalonpediatw — Claude Code Project Config

## Project Overview

Real-time Avalon/The Resistance social deduction game platform.
- **Frontend**: React 18 + TypeScript + Vite (`packages/web`)
- **Backend**: Express + Socket.IO (`packages/server`)
- **Database**: Firebase Realtime DB + Firebase Auth
- **Monorepo**: Turborepo + pnpm workspaces
- **Deployment**: Firebase Hosting (frontend) + Render.com (backend, Singapore region)

## Build Order (always build shared first)

```bash
pnpm --filter @avalon/shared build
pnpm --filter @avalon/server build   # or @avalon/web
```

## Key URLs

- Frontend: https://avalonpediatw.vercel.app / https://avalon-game-platform.web.app
- Backend: https://avalonpediatw.onrender.com
- Health check: https://avalonpediatw.onrender.com/health

## gstack

Use /browse from gstack for all web browsing. Never use mcp__claude-in-chrome__* tools.

Available skills:
/office-hours, /plan-ceo-review, /plan-eng-review, /plan-design-review,
/design-consultation, /review, /ship, /land-and-deploy, /canary, /benchmark, /browse,
/qa, /qa-only, /design-review, /setup-browser-cookies, /setup-deploy, /retro,
/investigate, /document-release, /codex, /cso, /autoplan, /careful, /freeze, /guard,
/unfreeze, /gstack-upgrade.

If gstack skills aren't working, run: `cd ~/.claude/skills/gstack && ./setup`
