import { createServer } from 'http';
import express, { Express } from 'express';
import cors from 'cors';
import { Server as SocketIOServer } from 'socket.io';
import { initializeFirebase } from './services/firebase';
import { isSupabaseReady } from './services/supabase';
import { authenticateSocket } from './middleware/auth';
import { GameServer } from './socket/GameServer';
import { authRouter } from './routes/auth';
import { apiRouter } from './routes/api';
import { friendsRouter } from './routes/friends';
import { feedbackRouter } from './routes/feedback';
import { analysisRouter } from './routes/analysis';
import { claimsRouter } from './routes/claims';
import { adminEloRouter } from './routes/adminElo';
import { healthDeepRouter } from './routes/healthDeep';
import { startSelfPlayScheduler, getSelfPlayStatus } from './ai/SelfPlayScheduler';
import { ensureAdminsSeed } from './services/AdminService';
import {
  loadEloConfigFromFirestore,
  subscribeEloConfigChanges,
} from './services/EloConfigLoader';

const app: Express = express();

// Environment
const NODE_ENV = process.env.NODE_ENV || 'development';
// Allow all origins for prototype; lock down later with CORS_ORIGIN env var
// Parse comma-separated origins into an array so cors() matches per-request
const CORS_ORIGIN: string | string[] | true = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.includes(',')
    ? process.env.CORS_ORIGIN.split(',').map(o => o.trim())
    : process.env.CORS_ORIGIN
  : true;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: CORS_ORIGIN, credentials: true }));
app.use(express.json());

// OAuth routes（不需要 Socket 認證，掛在 Socket 之前）
app.use('/auth', authRouter);

// REST API routes
app.use('/api', apiRouter);
app.use('/api/friends', friendsRouter);
app.use('/api/feedback', feedbackRouter);
app.use('/api/analysis', analysisRouter);
// Claim system: /api/claims/* (player) + /api/admin/* (admin whitelist)
app.use('/api', claimsRouter);
// #54 Phase 2 Day 3: admin-only ELO config (/api/admin/elo/config)
app.use('/api', adminEloRouter);
// Deep health: /api/health/deep — dependency probe (Plan v2 R0-C)
app.use('/api', healthDeepRouter);

// HTTP server (needed for Socket.IO)
const httpServer = createServer(app);

// Socket.IO server
const io = new SocketIOServer(httpServer, {
  cors: {
    origin: CORS_ORIGIN,
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

// Health check — must be defined before main() so listen() can serve it immediately
let firebaseInitialized = false;
app.get('/health', (_req, res) => {
  res.json({
    status: firebaseInitialized ? 'ok' : 'initializing',
    timestamp: new Date().toISOString(),
    environment: NODE_ENV,
    supabase: isSupabaseReady() ? 'connected' : 'not configured',
    selfPlay: getSelfPlayStatus(),
  });
});

const PORT = process.env.PORT || 3001;

// Bootstrap: fully prepare Socket.IO (Firebase + auth middleware + connection handler)
// BEFORE binding the HTTP port. This eliminates the Render cold-start race where
// clients connected into a listening socket whose connection handler wasn't attached
// yet, causing `socket.once('auth:success')` to time out on the client.
async function main() {
  // 0. Critical env vars — fail fast before binding any port
  if (!process.env.JWT_SECRET) {
    console.error('[FATAL] JWT_SECRET env var is not set. Refusing to start.');
    process.exit(1);
  }

  // 1. Firebase — required for ID-token verification in authenticateSocket middleware
  try {
    await initializeFirebase();
    firebaseInitialized = true;
    console.log('✓ Firebase initialized');
    // Seed admin whitelist (idempotent — no-op if already seeded)
    await ensureAdminsSeed();

    // #54 Phase 3: load persisted ELO config from Firestore + subscribe for hot
    // reload. Safe if Firebase admin is not ready — logs warning and uses
    // DEFAULT_ELO_CONFIG.
    await loadEloConfigFromFirestore();
    subscribeEloConfigChanges();
  } catch (err) {
    console.error('Firebase initialization failed:', err);
    // Continue anyway — individual auth will fail but health checks + guest-only
    // flows should still be reachable. Flag stays false so /health reports 'initializing'.
  }

  // 2. Attach Socket.IO auth middleware (must run before any connection lands)
  io.use(authenticateSocket);

  // 3. Start GameServer — this binds `io.on('connection', ...)` handlers
  const gameServer = new GameServer(io);
  gameServer.start();
  console.log(
    firebaseInitialized
      ? '✓ Socket.IO game server started'
      : 'Socket.IO game server started (Firebase unavailable)'
  );

  // 4. Start self-play scheduler after game server is ready
  startSelfPlayScheduler();

  // 5. Finally bind the HTTP port — now any connection has a complete handler chain
  httpServer.listen(PORT, () => {
    console.log(`\nAvalon server running on port ${PORT}`);
    console.log(`CORS Origin: ${CORS_ORIGIN}`);
    console.log(`Environment: ${NODE_ENV}\n`);
  });
}

main().catch(err => {
  console.error('Fatal: server bootstrap failed', err);
  process.exit(1);
});

export { app };
