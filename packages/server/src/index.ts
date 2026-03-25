import express from 'express';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import http from 'http';
import { GameServer } from './socket/GameServer';
import { initializeFirebase } from './services/firebase';
import { authenticateSocket } from './middleware/auth';

const app = express();
const server = http.createServer(app);

// Environment
const PORT = process.env.PORT || 3001;
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5173';
const NODE_ENV = process.env.NODE_ENV || 'development';

// Middleware
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json());

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Auth endpoint (for testing)
app.post('/auth/validate', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ error: 'No token provided' });
    }
    // Token will be validated in Socket.IO middleware
    res.json({ valid: true });
  } catch (error) {
    res.status(401).json({ error: 'Invalid token' });
  }
});

// Socket.IO Setup
const io = new SocketIOServer(server, {
  cors: {
    origin: CORS_ORIGIN,
    methods: ['GET', 'POST'],
  },
  transports: ['websocket', 'polling'],
});

// Apply authentication middleware
io.use(authenticateSocket);

// Initialize services
async function startServer(): Promise<void> {
  try {
    // Initialize Firebase
    await initializeFirebase();
    console.log('✓ Firebase initialized');

    // Initialize Game Server
    const gameServer = new GameServer(io);
    gameServer.start();
    console.log('✓ Game server started');

    // Start listening
    server.listen(PORT, () => {
      console.log(`\n🚀 Avalon server running on port ${PORT}`);
      console.log(`📡 CORS Origin: ${CORS_ORIGIN}`);
      console.log(`🌍 Environment: ${NODE_ENV}\n`);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

startServer();

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n📛 Shutting down gracefully...');
  server.close(() => {
    console.log('✓ Server closed');
    process.exit(0);
  });
});
