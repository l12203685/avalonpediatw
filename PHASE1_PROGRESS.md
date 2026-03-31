# Phase 1: Firebase Integration -- Progress Report

> Date: 2026-03-30
> Status: Core integration complete, testing pending

---

## What Was Done

### 1. Firebase Config Setup -- ALREADY EXISTED

Pre-existing and functional:
- `packages/server/src/services/firebase.ts` -- Firebase Admin SDK (RTD + Auth), client SDK init
- `packages/web/src/services/auth.ts` -- Firebase client Auth (Google, GitHub sign-in)
- `packages/server/src/middleware/auth.ts` -- Socket.IO auth middleware (token verification)
- `packages/server/src/middleware/httpAuth.ts` -- Express HTTP auth middleware
- `firebase.json` -- Hosting, Functions, Emulators config

**Added**: `getAdminFirestore()` export and ADC (Application Default Credentials) support for local dev.

### 2. Game State Persistence (RTD) -- NEW

**File**: `packages/server/src/services/GameStatePersistence.ts`

| Method | Description |
|--------|-------------|
| `saveRoom(room)` | Write full room state to `/rooms/{roomId}` in RTD |
| `loadRoom(roomId)` | Load single room from RTD |
| `loadAllRooms()` | Load all active rooms (for server restart rehydration) |
| `removeRoom(roomId)` | Remove room from RTD after game ends |

Design decisions:
- Fire-and-forget writes -- persistence failure does not break gameplay
- `JSON.parse(JSON.stringify())` serialisation strips `undefined` values (RTD requirement)
- Defensive deserialisation with defaults for schema evolution

**Wiring in GameServer.ts**:
- Every state-changing handler (create, join, reconnect, disconnect, start, vote, quest team, quest vote, assassinate) now calls `persistRoom(room)`
- The `GameEngine` timeout callback also persists state
- Server startup calls `gameServer.rehydrateRooms()` after Firebase init, restoring in-memory rooms and re-creating `GameEngine` instances for in-progress games

### 3. Game History Recording (Firestore) -- NEW

**File**: `packages/server/src/services/GameHistoryRepository.ts`

| Method | Description |
|--------|-------------|
| `saveGameRecord(room, winReason)` | Archive completed game to `games/{gameId}` |
| `getGameRecord(gameId)` | Retrieve single game record |
| `listRecentGames(limit)` | Recent games ordered by `endedAt` desc |
| `listPlayerGames(playerId, limit)` | Player's game history (filtered in-memory) |

Firestore document schema (`GameRecord`):
- `gameId`, `roomName`, `playerCount`, `winner`, `winReason`
- `questResults[]`, `duration`, `players[]` (with role/team/won)
- `createdAt`, `endedAt` timestamps

**REST API endpoints added** (`packages/server/src/routes/api.ts`):
- `GET /api/games/recent?limit=N` -- recent completed games
- `GET /api/games/:gameId` -- single game record
- `GET /api/games/player/:playerId?limit=N` -- player's game history

### 4. Game End Lifecycle -- ENHANCED

`GameServer.onGameEnd()` now:
1. Saves in-memory replay snapshot (existing)
2. Archives full game record to Firestore (new)
3. Removes active room from RTD (new)
4. Updates per-player stats in RTD (existing)
5. Cleans up GameEngine instance (new)
6. Infers `winReason` from room state (new helper: `inferWinReason`)

### 5. Auth Integration -- ALREADY EXISTED

Pre-existing and functional:
- Google + GitHub OAuth via Firebase Auth (web client)
- Token verification on Socket.IO connections
- Auto-create user profile on first login
- User stats (ELO, win rate, roles played)
- Guest mode (no auth, limited features)

### 6. Disconnect/Reconnect -- ENHANCED

Pre-existing basic handling enhanced with persistence:
- Player disconnect now persists to RTD (survives server restart)
- Player reconnect restores status and persists to RTD
- Server restart rehydrates rooms, so players can reconnect to games in progress

---

## Files Modified

| File | Change |
|------|--------|
| `packages/server/src/services/firebase.ts` | Added `getAdminFirestore()`, ADC support |
| `packages/server/src/services/GameStatePersistence.ts` | **NEW** -- RTD room persistence |
| `packages/server/src/services/GameHistoryRepository.ts` | **NEW** -- Firestore game history |
| `packages/server/src/socket/GameServer.ts` | Wired persistence + history into all handlers |
| `packages/server/src/game/RoomManager.ts` | Added `rehydrate()` method |
| `packages/server/src/routes/api.ts` | Added game history REST endpoints |
| `packages/server/src/index.ts` | Added room rehydration on startup |

---

## What Remains (Phase 1)

| # | Task | Status | Notes |
|---|------|--------|-------|
| 1 | Firebase Auth integration | Done | Pre-existing, verified |
| 2 | Firebase RTD game state persistence | Done | GameStatePersistence.ts |
| 3 | Disconnect/reconnect handling | Done | Enhanced with RTD persistence |
| 4 | Game history recording to Firestore | Done | GameHistoryRepository.ts |
| 5 | Unit + integration tests (80% coverage) | TODO | GameStatePersistence, GameHistoryRepository, GameEngine need tests |
| 6 | Local multi-player testing verification | TODO | Need to run with Firebase emulators |

### Testing TODO

- [ ] Unit tests for `GameStatePersistence` (mock RTD)
- [ ] Unit tests for `GameHistoryRepository` (mock Firestore)
- [ ] Integration test: full game lifecycle with persistence
- [ ] Integration test: server restart rehydration (lobby rooms + mid-game engine restore)
- [ ] Integration test: disconnect + reconnect preserves game state
- [ ] Verify Firebase emulator setup works (`firebase emulators:start`)
- [ ] Smoke test: 5-player game through all phases

### Known Limitations

1. `listPlayerGames()` uses in-memory filtering (not scalable beyond ~1000 games). Phase 2 should add a denormalised `users/{uid}/gameHistory` sub-collection.
2. ~~Rehydrated in-progress games (voting/quest phase) do not restore internal `GameEngine` state (questVotes, roleAssignments).~~ **FIXED**: `GameEngine.serialize()` / `GameEngine.restore()` added; `GameStatePersistence` now saves engine state alongside room state; `GameServer.rehydrateRooms()` restores engine state on startup. Legacy rooms without saved engine state fall back gracefully to a blank engine.
3. No Firestore security rules written yet -- needed before production deploy.
