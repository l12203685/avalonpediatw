import express from 'express';
import cors from 'cors';
import { initializeFirebase } from './services/firebase';

const app = express();

// Environment
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:3000';
const NODE_ENV = process.env.NODE_ENV || 'development';

// Middleware
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json());

// Initialize Firebase once
let firebaseInitialized = false;
initializeFirebase().then(() => {
  firebaseInitialized = true;
  console.log('✓ Firebase initialized');
}).catch(err => {
  console.error('❌ Firebase initialization failed:', err);
});

// Health check
app.get('/health', (_req, res) => {
  res.json({
    status: firebaseInitialized ? 'ok' : 'initializing',
    timestamp: new Date().toISOString(),
    environment: NODE_ENV
  });
});

// Auth endpoint (for testing)
app.post('/auth/validate', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ error: 'No token provided' });
    }
    // Token validation logic here
    res.json({ valid: true });
  } catch (error) {
    res.status(401).json({ error: 'Invalid token' });
  }
});

// For local development
const PORT = process.env.PORT || 3001;
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`\n🚀 Avalon server running on port ${PORT}`);
    console.log(`📡 CORS Origin: ${CORS_ORIGIN}`);
    console.log(`🌍 Environment: ${NODE_ENV}\n`);
  });
}

// Export for Firebase Functions
export { app };
