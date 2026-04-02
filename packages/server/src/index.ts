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
import { startSelfPlayScheduler, getSelfPlayStatus } from './ai/SelfPlayScheduler';

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

// Socket.IO auth middleware
io.use(authenticateSocket);

// Initialize Firebase, then start Socket.IO game server
let firebaseInitialized = false;
initializeFirebase()
  .then(() => {
    firebaseInitialized = true;
    console.log('✓ Firebase initialized');
    // Start game server after Firebase is ready
    const gameServer = new GameServer(io);
    gameServer.start();
    console.log('✓ Socket.IO game server started');
    startSelfPlayScheduler();
  })
  .catch(err => {
    console.error('Firebase initialization failed:', err);
    // Start game server anyway — auth will fail for individual connections
    // but the server itself should still be reachable for health checks
    const gameServer = new GameServer(io);
    gameServer.start();
    console.log('Socket.IO game server started (Firebase unavailable)');
    startSelfPlayScheduler();
  });

// Health check
app.get('/health', (_req, res) => {
  res.json({
    status: firebaseInitialized ? 'ok' : 'initializing',
    timestamp: new Date().toISOString(),
    environment: NODE_ENV,
    supabase: isSupabaseReady() ? 'connected' : 'not configured',
    selfPlay: getSelfPlayStatus(),
  });
});

// Start server
const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`\nAvalon server running on port ${PORT}`);
  console.log(`CORS Origin: ${CORS_ORIGIN}`);
  console.log(`Environment: ${NODE_ENV}\n`);
});

export { app };
