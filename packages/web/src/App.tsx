import { useEffect, useState } from 'react';
import { useGameStore } from './store/gameStore';
import { initializeAuth, onAuthStateChange } from './services/auth';
import { disconnectSocket } from './services/socket';
import HomePage from './pages/HomePage';
import GamePage from './pages/GamePage';
import LobbyPage from './pages/LobbyPage';
import LoginPage from './pages/LoginPage';
import WikiPage from './pages/WikiPage';
import LeaderboardPage from './pages/LeaderboardPage';
import ProfilePage from './pages/ProfilePage';
import ReplayPage from './pages/ReplayPage';
import AiStatsPage from './pages/AiStatsPage';
import ToastContainer from './components/ToastContainer';

function App(): JSX.Element {
  const { gameState, guestMode, setCurrentPlayer } = useGameStore();
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    initializeAuth();

    const unsubscribe = onAuthStateChange(async (userWithToken) => {
      if (userWithToken) {
        setIsAuthenticated(true);
      } else {
        setIsAuthenticated(false);
        setCurrentPlayer(null);
        disconnectSocket();
      }
      setIsLoading(false);
    });

    return () => unsubscribe();
  }, [setCurrentPlayer]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gradient-to-br from-avalon-dark to-avalon-card">
        <div className="text-white text-center">
          <div className="inline-block animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-400 mb-4" />
          <p>載入中...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-avalon-dark to-avalon-card">
      <ToastContainer />

      {!isAuthenticated && !guestMode ? (
        <LoginPage />
      ) : (
        <>
          {gameState === 'home' && <HomePage />}
          {gameState === 'lobby' && <LobbyPage />}
          {(gameState === 'playing' || gameState === 'voting' || gameState === 'ended') && (
            <GamePage />
          )}
          {gameState === 'wiki' && <WikiPage />}
          {gameState === 'leaderboard' && <LeaderboardPage />}
          {gameState === 'profile' && <ProfilePage />}
          {gameState === 'replay' && <ReplayPage />}
          {gameState === 'ai-stats' && <AiStatsPage />}
        </>
      )}
    </div>
  );
}

export default App;
