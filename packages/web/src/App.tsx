import { useEffect, useState } from 'react';
import { useGameStore } from './store/gameStore';
import { initializeAuth, onAuthStateChange, logout } from './services/auth';
import { disconnectSocket } from './services/socket';
import HomePage from './pages/HomePage';
import GamePage from './pages/GamePage';
import LobbyPage from './pages/LobbyPage';
import LoginPage from './pages/LoginPage';
import WikiPage from './pages/WikiPage';
import { User } from '@avalon/shared';

function App(): JSX.Element {
  const { gameState, currentPlayer } = useGameStore();
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // Initialize Firebase Auth
    initializeAuth();

    // Listen to auth state changes
    const unsubscribe = onAuthStateChange(async (userWithToken) => {
      if (userWithToken) {
        setIsAuthenticated(true);
        // Socket will be initialized in LoginPage after auth
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
          <p>Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-avalon-dark to-avalon-card">
      {!isAuthenticated && !currentPlayer ? (
        <LoginPage />
      ) : (
        <>
          {gameState === 'home' && <HomePage />}
          {gameState === 'lobby' && <LobbyPage />}
          {(gameState === 'playing' || gameState === 'voting' || gameState === 'ended') && <GamePage />}
          {gameState === 'wiki' && <WikiPage />}
        </>
      )}
    </div>
  );
}

export default App;
