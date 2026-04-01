import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { initializeFirebase } from './services/firebase';
import { authenticateSocket } from './middleware/auth';
import { GameServer } from './socket/GameServer';
import { createApiRouter } from './routes/api';
import { RoomManager } from './game/RoomManager';
import { setSharedRoomManager } from './game/roomManagerSingleton';

const app = express();
const httpServer = createServer(app);

const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:3000';
const PORT = process.env.PORT || 3001;
const NODE_ENV = process.env.NODE_ENV || 'development';

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: CORS_ORIGIN, credentials: true }));
app.use(express.json());

// ── Socket.IO ─────────────────────────────────────────────────────────────────
const io = new SocketIOServer(httpServer, {
  cors: {
    origin: CORS_ORIGIN,
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

io.use(authenticateSocket);

// Shared RoomManager so REST routes can read active/replay rooms
const roomManager = new RoomManager();
setSharedRoomManager(roomManager);
const gameServer = new GameServer(io, roomManager);
gameServer.start();

// ── REST API ──────────────────────────────────────────────────────────────────
app.use('/api', createApiRouter(roomManager));

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: NODE_ENV,
    rooms: roomManager.getRoomCount(),
  });
});

// ── Firebase init + room rehydration ─────────────────────────────────────────
initializeFirebase()
  .then(async () => {
    console.log('Firebase initialized');
    const count = await gameServer.rehydrateRooms();
    if (count > 0) {
      console.log(`Rehydrated ${count} active rooms from Firebase RTD`);
    }
  })
  .catch((err) => console.error('Firebase initialization failed:', err));

// ── Start server ──────────────────────────────────────────────────────────────
// FUNCTION_NAME / K_SERVICE are set by Firebase Functions / Cloud Run runtimes.
// In those environments Firebase manages the listener; we must not call listen().
const isFirebaseFunctions = !!(process.env.FUNCTION_NAME || process.env.K_SERVICE);

if (!isFirebaseFunctions) {
  httpServer.listen(PORT, () => {
    console.log(`\n🚀 Avalon server running on port ${PORT}`);
    console.log(`📡 CORS Origin: ${CORS_ORIGIN}`);
    console.log(`🌍 Environment: ${NODE_ENV}\n`);
  });
}

// Export Express app for Firebase Functions (REST only — no WebSocket in Functions context)
export { app };
