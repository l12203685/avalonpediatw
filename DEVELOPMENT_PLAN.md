# Avalon Pedia (avalonpediatw) Development Continuation Plan

> Last updated: 2026-03-30
> Priority: Edward's #2 project (after DNA agent system)

---

## 1. Current State Assessment

### What's Built

| Component | Status | Notes |
|-----------|--------|-------|
| Monorepo (Turborepo + pnpm) | Done | `packages/shared`, `packages/server`, `packages/web` |
| Shared type definitions | Done | `game.ts` + `auth.ts` -- complete Avalon types for 5-10 players |
| GameEngine (TypeScript) | Done | Role assignment, voting, quests, assassination, timeouts |
| Socket.IO event system | Done | `ClientToServerEvents` / `ServerToClientEvents` typed |
| RoomManager | Done | Room lifecycle management |
| React frontend pages | Done | Home, Lobby, Game, Wiki, Login, Profile, Leaderboard, Replay, AiStats |
| UI components | Done | GameBoard, VotePanel, QuestPanel, TeamSelection, RoleCard, ChatPanel, WikiContent |
| Bot integration stubs | Done | `packages/server/src/bots/` -- Discord client/commands/config, LINE client/config/messages |
| Firebase config | Done | `firebase.json` with Hosting + Functions + Emulators |
| CI/CD | Done | GitHub Actions, deploy scripts, Dockerfile |
| Wiki data model | Done | Categories (rules, roles, strategies, FAQ) + article types |

### What's Missing

| Component | Gap | Impact |
|-----------|-----|--------|
| Firebase RTD/Auth integration | Not wired -- env vars exist but no runtime calls | Blocking: no persistence, no auth |
| Bot handlers (LINE/Discord) | Stubs only -- `initializeDiscordBot`/`initializeLineBot` exist but empty | No social bot gameplay |
| Game history recording | No Firestore/RTD writes after game ends | No replay, no stats |
| Test suite | `GameEngine.test.ts` exists, no integration/E2E tests | Coverage ~0% |
| Wiki content pipeline | Hardcoded mock data in `wiki.ts`, real content in GDrive `阿瓦隆百科/wiki/` | Wiki page is static |
| ELO/ranking system | Page exists (`LeaderboardPage`), no backend | Placeholder only |
| Replay system | Page exists (`ReplayPage`), no recording | Placeholder only |
| AI stats | Page exists (`AiStatsPage`), no data pipeline | Placeholder only |
| Deep linking (LINE/Discord -> web) | Not implemented | Can't invite from chat |
| Game state persistence | In-memory only via `RoomManager` | Server restart = all games lost |
| Disconnect/reconnect handling | Basic disconnect event, no rejoin | Players can't recover |

---

## 2. Architecture Overview

```
                    +------------------+
                    |   React + Vite   |
                    |  (packages/web)  |
                    |  Zustand state   |
                    |  Tailwind CSS    |
                    +--------+---------+
                             |
                      Socket.IO + REST
                             |
                    +--------+---------+
                    |  Express Server  |
                    | (packages/server)|
                    |  GameEngine.ts   |
                    |  RoomManager.ts  |
                    +---+----+----+----+
                        |    |    |
              +---------+    |    +---------+
              |              |              |
     +--------+--+   +------+------+  +----+------+
     | Firebase   |   | Discord Bot |  | LINE Bot  |
     | RTD + Auth |   | (discord/)  |  | (line/)   |
     | Firestore  |   | slash cmds  |  | webhook   |
     +------------+   +------+------+  +-----+-----+
                             |               |
                      +------+------+  +-----+-----+
                      | Discord     |  | LINE      |
                      | Servers     |  | Groups    |
                      | (avalon群)  |  | (阿瓦隆)  |
                      +-------------+  +-----------+
```

### Key Integration Points

**avalon_core (Python) -> avalonpediatw (TypeScript)**
- avalon_core has the authoritative Python game engine (`game_engine/`) with roles, voting, missions, game_state
- avalonpediatw has its own TypeScript GameEngine that mirrors the same logic
- Decision: TypeScript engine is the runtime engine; Python engine is reference/analysis
- avalon_core's `analysis/stats.py` can feed the AI stats page via a data pipeline

**listen-bot -> avalonpediatw**
- listen-bot monitors Discord servers (including avalon groups) passively
- Connection: listen-bot writes to `voice_listen.md` -> daily Claude sync
- For real-time: listen-bot can forward game-related Discord messages to avalonpediatw server via webhook/ntfy
- Future: listen-bot detects "want to play avalon" in Discord -> sends game creation link

**Wiki content (阿瓦隆百科/wiki/) -> avalonpediatw wiki page**
- 7 categories of markdown content: 入門基礎, 角色玩法, 派票策略, 湖中與投票, 進階思考, 覆盤, QnA
- Historical game data: `gameRecordsDataAnon_20220606.json` (anonymized records)
- Build pipeline: markdown files -> JSON/API -> WikiPage component
- Game record data feeds leaderboard analytics and AI stats

---

## 3. avalon_core Integration Strategy

avalon_core (`C:/Users/admin/GoogleDrive/專案/avalon_core/`) is a clean Python refactoring:

| avalon_core module | avalonpediatw equivalent | Integration |
|---|---|---|
| `game_engine/roles.py` | `shared/types/game.ts` AVALON_CONFIG | Type parity verified |
| `game_engine/game_state.py` | `server/game/GameEngine.ts` | Logic parity -- same state machine |
| `game_engine/voting.py` | `GameEngine.submitVote()` | Same approval logic |
| `game_engine/missions.py` | `GameEngine.resolveQuestPhase()` | Same 1-fail rule |
| `bot/bridge.py` | `server/bots/index.ts` | Port BindingCodeManager + ChannelSyncManager to TS |
| `bot/config.py` | `server/bots/*/config.ts` | Same env-var pattern already applied |
| `analysis/stats.py` | Not implemented | Port GameAnalyzer for win rates, role balance |

### Action Items

1. Port `bridge.py` BindingCodeManager to TypeScript for LINE-Discord user binding
2. Port `analysis/stats.py` GameAnalyzer to feed AiStatsPage
3. Keep Python engine as reference -- TS engine is production runtime
4. Import game record JSON into Firebase for historical analytics

---

## 4. listen-bot Sync Connection

listen-bot (`C:/Users/admin/GoogleDrive/staging/listen-bot/`) is a passive message collector:

```
Discord avalon群 -> listen-bot -> voice_listen.md / ntfy
                                      |
                              daily_sync (13:17)
                                      |
                              Claude processes
```

### Integration with Game Platform

| Feature | How |
|---------|-----|
| Game invite detection | listen-bot detects keywords ("要打瓦", "開阿瓦隆") in Discord -> POST to avalonpediatw `/api/game-invite` |
| Player binding | Discord user ID <-> avalonpediatw user account via BindingCodeManager |
| Game result broadcast | After game ends, server sends result summary to Discord channel via bot |
| Community activity feed | listen-bot feeds message volume/activity metrics to AI stats dashboard |
| Cross-platform notifications | Game reminders sent via both LINE and Discord bots |

### Implementation Priority

Phase 1: One-way (game results -> Discord broadcast)
Phase 2: Two-way (Discord trigger -> game creation link)
Phase 3: Full binding (Discord/LINE accounts linked to web accounts)

---

## 5. MVP Priority Features

### P0 -- Must Have (Ship First)

| # | Feature | Effort | Dependency |
|---|---------|--------|------------|
| 1 | Firebase Auth integration | 2d | None |
| 2 | Firebase RTD game state persistence | 2d | #1 |
| 3 | Disconnect/reconnect handling | 1d | #2 |
| 4 | Game history recording to Firestore | 1d | #2 |
| 5 | Unit + integration tests (80% coverage) | 2d | None |
| 6 | Local multi-player testing verification | 1d | #1, #2 |

### P1 -- Core Experience

| # | Feature | Effort | Dependency |
|---|---------|--------|------------|
| 7 | Wiki content pipeline (markdown -> web) | 2d | None |
| 8 | Discord bot: game creation + result broadcast | 2d | #4 |
| 9 | LINE bot: webhook + game notifications | 2d | #4 |
| 10 | Deep linking (discord/line -> web game room) | 1d | #8, #9 |
| 11 | Player profile page with game history | 1d | #4 |

### P2 -- Differentiation

| # | Feature | Effort | Dependency |
|---|---------|--------|------------|
| 12 | ELO ranking system | 2d | #4 |
| 13 | Game replay viewer | 2d | #4 |
| 14 | AI stats dashboard (role balance, win rates) | 2d | #4, #12 |
| 15 | listen-bot integration (invite detection) | 1d | #8, listen-bot |
| 16 | LINE-Discord user binding (BindingCodeManager port) | 2d | #8, #9 |

### P3 -- Polish

| # | Feature | Effort | Dependency |
|---|---------|--------|------------|
| 17 | UI animations + sound effects | 2d | None |
| 18 | Mobile responsive optimization | 1d | None |
| 19 | Game variants (custom roles, Lady of the Lake) | 3d | #2 |
| 20 | E2E tests with Playwright | 2d | #6 |
| 21 | Performance optimization (<50ms vote response) | 1d | #2 |

---

## 6. Technical Architecture Details

### Frontend (packages/web)

```
React 18 + TypeScript + Vite
State: Zustand (useGameStore)
Styling: Tailwind CSS
Routing: React Router
Real-time: Socket.IO client
Auth: Firebase Auth SDK
```

Pages:
- `HomePage` -- Create/Join game
- `LobbyPage` -- Wait for players, start game
- `GamePage` -- Main gameplay (voting, quests, assassination)
- `WikiPage` -- Encyclopedia content
- `LoginPage` -- Firebase Auth UI
- `ProfilePage` -- Player stats + history
- `LeaderboardPage` -- ELO rankings
- `ReplayPage` -- Watch past games
- `AiStatsPage` -- Analytics dashboard

### Backend (packages/server)

```
Express + Socket.IO + TypeScript
Game: GameEngine + RoomManager
Bots: Discord.js + LINE SDK
DB: Firebase Admin SDK (RTD + Firestore)
Deploy: Firebase Functions (via firebase.json)
```

### Database Schema (Firebase)

```
Realtime Database:
  /rooms/{roomId}           -- Active game state (Room type)
  /rooms/{roomId}/players   -- Player list
  /rooms/{roomId}/votes     -- Current round votes

Firestore:
  users/{uid}               -- Profile, stats, linked accounts
  games/{gameId}            -- Completed game records
  games/{gameId}/rounds     -- Round-by-round history
  rankings/{uid}            -- ELO score, rank position
  wiki/articles/{articleId} -- Wiki content (or static markdown)
```

### Shared Types (packages/shared)

```
game.ts   -- GameState, Role, Team, Player, Room, GameConfig, AVALON_CONFIG
auth.ts   -- User auth types
```

### Deployment

```
Web:     Vercel (or Firebase Hosting)
Server:  Railway (or Firebase Functions)
DB:      Firebase RTD + Firestore
Bots:    Same server process (or separate worker)
```

---

## 7. Implementation Phases

### Phase 1: Foundation (Week 1-2)

Goal: Playable game with persistence and auth.

```
Day 1-2:  Firebase Auth + RTD integration
Day 3:    Game state persistence (write/read rooms from RTD)
Day 4:    Disconnect/reconnect handling
Day 5:    Game history recording to Firestore
Day 6-7:  Unit tests + integration tests (target 80%)
Day 8:    Local multi-player smoke test
```

### Phase 2: Social (Week 3-4)

Goal: Play Avalon via Discord/LINE invites with wiki.

```
Day 9-10:   Discord bot -- slash commands (/avalon create, /avalon join)
Day 11-12:  LINE bot -- webhook handler, flex messages
Day 13:     Deep linking (bot -> web game room URL)
Day 14-15:  Wiki content pipeline (GDrive markdown -> web)
Day 16:     Player profile + game history page
```

### Phase 3: Analytics (Week 5-6)

Goal: Rankings, replays, AI-powered insights.

```
Day 17-18:  ELO ranking system
Day 19-20:  Game replay viewer
Day 21-22:  AI stats dashboard (port avalon_core analysis)
Day 23:     listen-bot integration (game invite detection)
Day 24:     LINE-Discord user binding
```

### Phase 4: Polish (Week 7-8)

Goal: Production-ready, mobile-optimized, tested.

```
Day 25-26:  UI animations, sound effects, game theme
Day 27:     Mobile responsive final pass
Day 28-29:  E2E tests with Playwright
Day 30:     Performance optimization
Day 31:     Game variants (Lady of the Lake, custom roles)
Day 32:     Production deployment + monitoring
```

---

## 8. Key Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Game engine language | TypeScript (not Python port) | Already built, same logic, native to Node.js runtime |
| Database | Firebase RTD for game state, Firestore for history | RTD = real-time sync, Firestore = structured queries |
| Bot framework | Discord.js + LINE SDK in same server | Simpler deployment, shared game state access |
| Wiki storage | Markdown files -> build-time JSON (or Firestore) | 阿瓦隆百科 already has organized markdown |
| Ranking | ELO algorithm | Standard for competitive games, well-understood |
| State management | Zustand | Already in place, lightweight, sufficient |
| Deploy target | Firebase Hosting + Functions | firebase.json already configured, free tier |

---

## 9. Risk Register

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Firebase free tier limits | Medium | High | Monitor usage, upgrade to Blaze if needed |
| Socket.IO scaling beyond 100 concurrent | Low | Medium | Firebase RTD handles sync, Socket.IO is supplementary |
| Bot rate limiting (Discord/LINE) | Medium | Low | Queue outbound messages, respect rate limits |
| Wiki content stale | Low | Low | Automate GDrive -> Firebase sync |
| avalon_core / avalonpediatw logic drift | Medium | Medium | Reference tests that validate parity |

---

## 10. File Reference

| Path | Description |
|------|-------------|
| `專案/avalonpediatw/` | Main project root |
| `專案/avalonpediatw/packages/shared/src/types/game.ts` | All game types + AVALON_CONFIG |
| `專案/avalonpediatw/packages/server/src/game/GameEngine.ts` | Core game engine (532 lines) |
| `專案/avalonpediatw/packages/server/src/bots/index.ts` | Bot initialization hub |
| `專案/avalonpediatw/packages/web/src/data/wiki.ts` | Wiki data model |
| `專案/avalon_core/` | Python reference engine + analysis |
| `專案/avalon_core/bot/bridge.py` | BindingCodeManager + ChannelSyncManager to port |
| `專案/avalon_core/analysis/stats.py` | GameAnalyzer to port for AI stats |
| `專案/阿瓦隆百科/wiki/` | 7 categories of Avalon strategy content |
| `專案/阿瓦隆百科/data/gameRecordsDataAnon_20220606.json` | Historical game records |
| `staging/listen-bot/` | Passive message collector for Discord/LINE |

---

## Next Action

Start Phase 1, Feature #1: Wire Firebase Auth into `packages/server` and `packages/web`.
