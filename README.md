# Avalon Game Platform

A modern, real-time multiplayer platform for [The Resistance: Avalon](https://www.indieboardsandcards.com/index.php/games/avalon/), with bot integration, persistent stats, and a built-in encyclopedia of strategy notes.

> Project lead: [@AvalonPediaTW](https://github.com/AvalonPediaTW). Source code is MIT licensed; original visual assets are CC BY-NC-SA 4.0. **Original board game artwork is NOT redistributed** — see [`ASSET_CREDITS.md`](./ASSET_CREDITS.md).

## Features

- Real-time multiplayer Avalon (5-10 players) over WebSocket
- Full role set: Merlin, Percival, Loyal Servants, Assassin, Mordred, Morgana, Oberon
- Lake of the Lady token, multi-round vote tracking, mission/quest history
- Persistent player stats, ELO rating, suspicion analytics
- Discord bot integration (game-room mirror, lobby chat bridge)
- Encyclopedia of strategy notes (`/docs/avalon-wiki/`)
- Built-in self-play simulator and AI bot opponents

## Quick start

### Prerequisites

- Node.js >= 20
- pnpm >= 8
- (optional) Python >= 3.12 for regenerating game-data YAML — see [`docs/parser.md`](./docs/parser.md)

### Install and run

```bash
pnpm install

# Set up local env
cp packages/server/.env.example packages/server/.env
cp packages/web/.env.example packages/web/.env
# Fill in your own Firebase project credentials

# Run frontend + backend in parallel
pnpm dev
# Frontend: http://localhost:5173
# Backend:  http://localhost:3001
```

### Build, type-check, lint

```bash
pnpm build
pnpm type-check
pnpm lint
pnpm test
```

## Project structure

```
.
├── packages/
│   ├── shared/    # Shared types & constants
│   ├── server/    # Backend (Express + Socket.IO + Firebase)
│   └── web/       # Frontend (React 18 + Vite + Zustand + Tailwind)
├── apps/
│   └── wiki/      # Avalon strategy wiki (Astro)
├── docs/          # Project docs + strategy articles (text only)
├── scripts/       # Data import / migration / self-play scripts
└── supabase/      # SQL schema & migrations
```

## Tech stack

| Layer        | Stack                                |
|--------------|--------------------------------------|
| Frontend     | React 18, TypeScript, Vite, Zustand, Tailwind |
| Realtime     | Socket.IO                            |
| Backend      | Express, Node.js                     |
| Database     | Firebase Realtime Database, Firestore |
| Auth         | Firebase Auth (email + Google)       |
| Storage      | Cloudflare R2 (replays, video clips) |
| Optional ext | Discord bot, LINE bot                |

## How to play

The platform implements the standard *The Resistance: Avalon* rules. New to the game? Read:

- The official [Indie Boards & Cards rulebook](https://www.indieboardsandcards.com/index.php/games/avalon/)
- This repo's strategy notes under [`docs/avalon-wiki/`](./docs/avalon-wiki/)

In-game flow:

1. **Lobby** — players join, host starts when 5-10 are seated.
2. **Role reveal** — Merlin / Percival / Minions get their respective views.
3. **Mission rounds** — leader proposes a team, all players approve or reject the team. Approved teams attempt the quest; team members secretly play SUCCESS / FAIL cards.
4. **First side to 3 mission wins** — Good wins (with one final twist: Assassin gets a chance to identify Merlin) or Evil wins.

## Visual assets disclaimer

The 27 image files in [`packages/web/public/avalon-assets/`](./packages/web/public/avalon-assets/) (role cards, board, voting tokens, etc.) are **placeholder stubs** committed to keep the frontend functional. The original artwork is copyrighted by Indie Boards & Cards and is **not redistributed** in this repository. See [`ASSET_CREDITS.md`](./ASSET_CREDITS.md) for the filename map and [`LICENSE-ASSETS`](./LICENSE-ASSETS) for license terms covering original assets contributed to this project.

If you legally own a copy of the board game, you may drop your own scans into the `avalon-assets/` directory under the same filenames for personal, non-commercial play. The project `.gitignore` blocks accidental re-commits.

## Contributing

PRs welcome — see [`CONTRIBUTING.md`](./CONTRIBUTING.md). Particularly looking for help with:

- AI-generated original role/board artwork to replace placeholders (CC BY-NC-SA 4.0)
- New game-mode variants (5-Anti / 9P-variant)
- Translation of strategy notes to English
- Self-play AI improvements

CI runs `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm type-check`, `pnpm lint`, and `pnpm test` against Node 20 and 22 — see [`.github/workflows/`](./.github/workflows/).

## License

- **Source code**: MIT — see [`LICENSE`](./LICENSE)
- **Original visual assets** contributed to this project: CC BY-NC-SA 4.0 — see [`LICENSE-ASSETS`](./LICENSE-ASSETS)
- **Original board game artwork**: copyrighted by Indie Boards & Cards, NOT included in this repo

## Acknowledgements

- *The Resistance: Avalon* designed by Don Eskridge, published by Indie Boards & Cards.
- Strategy wiki content contributed by the Taiwan Avalon community ([Discord](https://discord.gg/mBqFqM2TXs)).
