import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useGameStore } from './store/gameStore';
import { initializeAuth, onAuthStateChange, extractOAuthTokenFromUrl } from './services/auth';
import { initializeSocket, disconnectSocket } from './services/socket';
import HomePage from './pages/HomePage';
import GamePage from './pages/GamePage';
import LobbyPage from './pages/LobbyPage';
import LoginPage from './pages/LoginPage';
import WikiPage from './pages/WikiPage';
import LeaderboardPage from './pages/LeaderboardPage';
import ProfilePage from './pages/ProfilePage';
import ToastContainer from './components/ToastContainer';
import FloatingControls from './components/FloatingControls';

function App(): JSX.Element {
  const { gameState, currentPlayer, socketStatus } = useGameStore();
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // 處理 Discord / Line OAuth callback（URL 帶有 ?oauth_token=...）
    const oauthResult = extractOAuthTokenFromUrl();
    if (oauthResult) {
      const { setGameState } = useGameStore.getState();
      initializeSocket(oauthResult.token)
        .then(() => { setGameState('home'); setIsLoading(false); })
        .catch(() => { setIsLoading(false); });
      return;
    }

    // Initialize Firebase Auth
    initializeAuth();

    // Listen to auth state changes
    const unsubscribe = onAuthStateChange(async (userWithToken) => {
      if (userWithToken) {
        setIsAuthenticated(true);
      } else {
        setIsAuthenticated(false);
        disconnectSocket();
      }
      setIsLoading(false);
    });

    return () => unsubscribe();
  }, []);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gradient-to-br from-avalon-dark to-avalon-card">
        <div className="text-white text-center">
          <div className="inline-block animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-400 mb-4"></div>
          <p>載入中…</p>
        </div>
      </div>
    );
  }

  const showConnectionBanner = currentPlayer && socketStatus !== 'connected';

  return (
    <div className="min-h-screen bg-gradient-to-br from-avalon-dark to-avalon-card">
      {/* Connection status banner */}
      <AnimatePresence>
        {showConnectionBanner && (
          <motion.div
            key="conn-banner"
            initial={{ y: -48, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -48, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            className={`fixed top-0 left-0 right-0 z-[100] flex items-center justify-center gap-2 px-4 py-2 text-sm font-semibold ${
              socketStatus === 'reconnecting'
                ? 'bg-yellow-900/90 border-b border-yellow-700 text-yellow-200'
                : 'bg-red-900/90 border-b border-red-700 text-red-200'
            }`}
          >
            <span className={`inline-block w-2 h-2 rounded-full ${socketStatus === 'reconnecting' ? 'bg-yellow-400 animate-pulse' : 'bg-red-400'}`} />
            {socketStatus === 'reconnecting'
              ? '重新連線中… (Reconnecting…)'
              : '連線中斷 (Disconnected) — 正在嘗試重連'}
          </motion.div>
        )}
      </AnimatePresence>

      {!isAuthenticated && !currentPlayer ? (
        <LoginPage />
      ) : (
        <>
          {gameState === 'home' && <HomePage />}
          {gameState === 'lobby' && <LobbyPage />}
          {(gameState === 'playing' || gameState === 'voting' || gameState === 'ended') && <GamePage />}
          {gameState === 'wiki' && <WikiPage />}
          {gameState === 'leaderboard' && <LeaderboardPage />}
          {gameState === 'profile' && <ProfilePage />}
        </>
      )}
      <ToastContainer />
      {/* Global floating controls — audio & theme, always accessible */}
      {currentPlayer && <FloatingControls />}
    </div>
  );
}

export default App;
