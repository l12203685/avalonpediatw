# Changelog

All notable changes to Avalon Pedia are documented here.

## [2026-04-22] — Phase 2 Social & Variants Batch

### Added

#### User Accounts & Identity
- **Multi-account binding**: Link Discord, LINE, and Google accounts to a single profile
  - Automatic merge of game records, ELO ratings, badges, and friends list
  - Prevents account duplication and preserves game history across login methods
  - Security: Requires at least one login method to remain active
  - Accessible via Profile → Linked Accounts

- **Player short code system**: 8-character alphanumeric identifier (e.g., `7K3M9P2Q`)
  - Excludes ambiguous characters (0/O, 1/I/L) for easy verbal communication
  - Auto-generated on registration; lazy backfill for existing users
  - Quick friend search: Search players by short code
  - Displayed prominently on profile with one-click copy

#### Social & Communication
- **Public lobby chat**: Real-time chat in main lobby (room list page)
  - Registered users can send messages (200 char limit)
  - Guests can view but not send (read-only mode)
  - Memory buffer: Server keeps 50 most recent messages per session
  - Rate limited to 2 messages per 2 seconds per user

- **Cross-platform chat mirroring** (outbound):
  - Lobby messages automatically forwarded to configured LINE group and Discord channel
  - Format: `[Avalon] PlayerName: message`
  - Includes system events (e.g., "PlayerName joined lobby")
  - Message truncation: 200 char max with `…` indicator
  - Loop protection: Messages from external platforms don't re-mirror back
  - Platform-specific rate limiting: 5 messages/min per external user
  - **Phase 2 scope**: Outbound only; inbound sync (LINE/Discord → Lobby) in next phase

#### Game Variants & Mechanics
- **9-player variant enhancements**:
  - Standard 9p mode now supports Oberon toggle (previously fixed configurations only)
  - All four special roles (Percival, Morgana, Mordred, Oberon) freely combinable in 9p
  - Quest round swap (R1/R2 exchange) works in both standard and Oberon modes
  - Predefined Oberon "forced" variant configuration still available
  - **Note**: Predefined roles enable Oberon by default; toggle OFF to revert to 6-good/3-evil baseline

- **Lady of the Lake integration**: 
  - Holder can check target's alignment (Good/Evil)
  - AI decisions for target selection now informed by historical game data
  - Smoother role reveal progression

#### Player Analytics & ELO
- **Three-phase ELO attribution system**:
  - Phase 1 Global Prior: Historical baseline for AI decision quality
  - Phase 2 Role-granularity: Win/loss attribution per role
  - Phase 3 Per-player learning: Individual player style personas
  - ELO recalculation based on phase outcomes
  - Visible in player profile under "Game Statistics"

- **Historical data learning for AI**:
  - AI now learns strategy patterns from 2145+ historical games
  - Improved decision-making for team formation, voting, and quest decisions
  - Data-driven priors replace hardcoded strategy constants
  - Feature flag allows rollback to baseline behavior if needed

### Changed

#### UI & Navigation
- **Lobby home page restructure** (6-button grid):
  1. Create Game
  2. Join Game
  3. Stats (links to game statistics & analytics)
  4. Profile Info (personal details, linked accounts, account settings)
  5. Wiki (Avalon rules & strategy guides)
  6. Settings (history, watchlist, pair stats, FAQ, logout)
  - Cleaner information architecture
  - Analytics dashboards accessible from Stats button
  - Settings consolidated into single view

- **Profile page enhancements**:
  - Linked accounts section with provider icons (Discord/LINE/Google)
  - Visual indicators for already-linked vs. available-to-link accounts
  - One-click binding flow with automatic account merge

### Fixed

- AI off-team rejection threshold calibration against historical data (prevents over-aggressive rejections)
- Evil role quest voting now informed by game phase and pressure scenarios
- Lady of the Lake target selection aligned with historical player tendencies

### Database

- New column: `users.short_code TEXT UNIQUE NULLABLE`
- New column: `oauth_sessions.link_user_id UUID NULLABLE` (for multi-account linking flow)
- New table: `game_events` JSONB events log (for per-action historical analysis)
- Schema: All migrations include `IF NOT EXISTS` for idempotent deployment

### Deployment Notes

- **Feature flags**:
  - `USE_HISTORICAL_PRIOR`: Toggle historical data learning (default: enabled)
  - `LOBBY_MIRROR_LINE_GROUP_ID`: LINE group ID for chat outbound (optional)
  - `LOBBY_MIRROR_DISCORD_CHANNEL_ID`: Discord channel ID for chat outbound (optional)

- **Prerequisites**:
  - Run database migrations before deployment (see `supabase/migrations/` folder)
  - For cross-platform chat: Create LINE group & Discord channel, invite bot, provide IDs to deployment config
  - For Google account binding in-place: (Optional) Deploy with Firebase SDK support

### Testing

- Multi-account binding: 7 unit tests, account merge logic verified
- Short code: 17 unit tests (uniqueness, format, collision handling)
- Public chat: 11 unit tests, buffer eviction, guest access, rate limiting
- 9-player variant: 6 new tests for role selection combinations
- Chat mirror: 27 unit tests covering format, loop protection, rate limiting, error handling
- AI historical priors: Self-play validation (good win rate 30-40%, within expected bounds)
- ELO attribution: Phase 1 baseline established; Phase 2+ pending per-role aggregation

### Known Limitations & Future Work

- Chat persistence: Lobby messages not yet stored to database (only in-memory 50-message buffer)
- Inbound chat: LINE/Discord messages not yet synced back to lobby (Phase 3)
- Per-player personas: Available to AI only; not yet exposed to UI (Phase 3)
- Google in-place account binding: Requires additional Firebase SDK wiring (optional)
- E2E tests: Comprehensive test coverage for chat and variant flows pending (Framework TBD)

---

## [2026-04-15] — Phase 1 Core MVP

- Monorepo setup (Turborepo + pnpm workspace)
- Shared TypeScript type definitions
- Express + Socket.IO backend
- React 18 + Vite frontend
- Game logic engine (role assignment, voting, quests)
- Real-time state synchronization
- Tailwind CSS styling system
- Zustand state management

---

**See [FEATURES.md](./docs/features/) for detailed usage guides.**
