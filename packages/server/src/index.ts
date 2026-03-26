import { createServer } from 'http';
import express, { Express } from 'express';
import cors from 'cors';
import { Server as SocketIOServer } from 'socket.io';
import { initializeFirebase } from './services/firebase';
import { authenticateSocket } from './middleware/auth';
import { GameServer } from './socket/GameServer';

const app: Express = express();

// Environment
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:3000';
const NODE_ENV = process.env.NODE_ENV || 'development';

// Middleware
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json());

// HTTP server (needed for Socket.IO)
const httpServer = createServer(app);

// Socket.IO server
const io = new SocketIOServer(httpServer, {
  cors: {
    origin: CORS_ORIGIN,
    methods: ['GET', 'POST'],
  },
  transports: ['websocket', 'polling'],
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
  })
  .catch(err => {
    console.error('❌ Firebase initialization failed:', err);
    // Start game server anyway — auth will fail for individual connections
    // but the server itself should still be reachable for health checks
    const gameServer = new GameServer(io);
    gameServer.start();
    console.log('⚠️  Socket.IO game server started (Firebase unavailable)');
  });

// Health check
app.get('/health', (_req, res) => {
  res.json({
    status: firebaseInitialized ? 'ok' : 'initializing',
    timestamp: new Date().toISOString(),
    environment: NODE_ENV,
  });
});

// Start server
const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`\n🚀 Avalon server running on port ${PORT}`);
  console.log(`📡 CORS Origin: ${CORS_ORIGIN}`);
  console.log(`🌍 Environment: ${NODE_ENV}\n`);
});

export { app };
