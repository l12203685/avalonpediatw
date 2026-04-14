# 🎭 Avalon Pedia - Complete Game Platform

A modern, real-time Avalon (The Resistance) game platform with encyclopedia, social bot integration, and zero-lag gameplay experience.

**Status**: Phase 1 MVP - Infrastructure & Core Setup ✅

## 🚀 Quick Start

### Prerequisites
- Node.js >= 18
- pnpm >= 8.0
- Python >= 3.12 (only for regenerating game-data YAML — see [docs/parser.md](docs/parser.md))

### Installation

```bash
# Install dependencies
pnpm install

# Setup environment
cp packages/server/.env.example packages/server/.env
cp packages/web/.env.example packages/web/.env

# Edit .env files with your Firebase credentials
```

### Development

```bash
# Start both frontend and backend in parallel
pnpm dev

# Frontend: http://localhost:5173
# Backend: http://localhost:3001
```

### Build & Deploy

```bash
# Build all packages
pnpm build

# Type checking
pnpm type-check

# Linting
pnpm lint
```

## 📦 Project Structure

```
avalon-game/
├── packages/
│   ├── shared/          # Shared types & constants
│   │   └── src/types/game.ts      # Core game interfaces
│   ├── server/          # Backend (Express + Socket.IO)
│   │   ├── src/
│   │   │   ├── index.ts           # Server entry point
│   │   │   ├── socket/            # WebSocket handlers
│   │   │   ├── game/              # Game logic
│   │   │   └── services/          # Firebase, auth
│   │   └── .env                   # Server config
│   └── web/             # Frontend (React + Vite)
│       ├── src/
│       │   ├── pages/             # Game pages
│       │   ├── components/        # Reusable components
│       │   ├── store/             # Zustand state
│       │   ├── services/          # Socket, API
│       │   └── index.css          # Tailwind styles
│       └── .env                   # Frontend config
├── pnpm-workspace.yaml
├── tsconfig.json
└── turbo.json
```

## 🎮 Game Features (Phase 1)

✅ **Core Mechanics**
- Role assignment (Merlin, Percival, Loyal, Assassin, Morgana)
- Voting phase with approval/rejection
- Quest phase with success/fail tracking
- Assassination phase (Merlin elimination)

✅ **UI Components**
- Home page (Create/Join game)
- Lobby (Player management)
- Game board (Real-time state sync)
- Voting & quest panels

✅ **Real-time Sync**
- WebSocket communication (Socket.IO)
- Optimistic updates (zero lag)
- Live player status updates

## 🔧 Technology Stack

| Layer | Tech | Why |
|-------|------|-----|
| **Frontend** | React 18 + TypeScript + Vite | Fast, modern, type-safe |
| **State** | Zustand | Lightweight, no boilerplate |
| **Styling** | Tailwind CSS | Rapid development |
| **Backend** | Express + Socket.IO | Lightweight, real-time ready |
| **Types** | Shared @shared package | Single source of truth |
| **Database** | Firebase RTD | Real-time, free tier |
| **Deployment** | Vercel (web) + Railway (server) | Free, fast, reliable |

## 📋 Development Roadmap

### Phase 1: MVP ✅
- [x] Monorepo setup
- [x] Shared types
- [x] Backend infrastructure
- [x] Socket.IO setup
- [x] Game logic engine
- [x] Frontend UI
- [ ] Firebase integration
- [ ] Testing & optimization

### Phase 2: Social Bots
- [ ] Discord bot
- [ ] Line bot
- [ ] Deep linking
- [ ] Notifications

### Phase 3: Advanced Features
- [ ] Rankings (ELO system)
- [ ] Game statistics
- [ ] Avalon encyclopedia
- [ ] Game variants
- [ ] Replay system

## 🎯 Current Implementation Status

### Completed ✅
1. **Monorepo Structure** - Turborepo + pnpm workspace
2. **Shared Type Definitions** - Complete Avalon game types
3. **Backend Server** - Express + Socket.IO
4. **Game Logic Engine** - Role assignment, voting, quests
5. **Socket.IO Handlers** - Real-time event system
6. **Frontend React App** - Home, Lobby, Game pages
7. **State Management** - Zustand store with game state
8. **Styling System** - Tailwind CSS with game theme

### Next Steps 🔄
1. Firebase RTD & Auth integration
2. Environment setup (.env files)
3. Local testing with multiple players
4. Zero-lag performance optimization
5. Discord/Line bot integration

## 🚦 Running the Game

### Terminal 1 (Backend)
```bash
cd packages/server
pnpm dev
# Server runs on http://localhost:3001
```

### Terminal 2 (Frontend)
```bash
cd packages/web
pnpm dev
# App runs on http://localhost:5173
```

### Test Flow
1. Create a game (Host)
2. Join the same game (Client 1, Client 2, ...)
3. Host starts game when 5+ players join
4. Game begins → Voting phase
5. Vote → Quest → Results → Assassination (if good wins)

## 🔐 Environment Setup

### Firebase Configuration
Get your Firebase credentials from [Firebase Console](https://console.firebase.google.com)

**Backend (.env)**:
```
FIREBASE_API_KEY=xxx
FIREBASE_AUTH_DOMAIN=xxx.firebaseapp.com
FIREBASE_PROJECT_ID=xxx
...
```

**Frontend (.env)**:
```
VITE_SERVER_URL=http://localhost:3001
VITE_FIREBASE_API_KEY=xxx
...
```

## 🧪 Testing

```bash
# Unit tests (coming soon)
pnpm test

# E2E tests (coming soon)
pnpm test:e2e

# Type checking
pnpm type-check

# Linting
pnpm lint

# Format code
pnpm format
```

## 📊 Performance Targets

- ⚡ Zero lag voting response (<50ms)
- 📡 Real-time state sync (<100ms)
- 🎨 60 FPS game UI
- 📱 Mobile responsive (iOS/Android)
- 🌍 <3s initial load time

## 🛠️ Troubleshooting

### Connection Issues
```bash
# Check if server is running
curl http://localhost:3001/health

# Verify Socket.IO connection
# Open browser console and check WebSocket logs
```

### Firebase Errors
- Ensure .env files are properly set
- Check Firebase Security Rules
- Verify database is enabled in Firebase console

## 📚 Documentation

- [Game Rules](./docs/RULES.md) - Detailed Avalon rules
- [Architecture](./docs/ARCHITECTURE.md) - System design
- [API Reference](./docs/API.md) - WebSocket events
- [Contributing](./CONTRIBUTING.md) - Development guide

## 📄 License

MIT - Feel free to use and modify!

## 🤝 Contributing

Contributions welcome! Please read [CONTRIBUTING.md](./CONTRIBUTING.md) first.

---

**Made with ❤️ for Avalon players worldwide**

