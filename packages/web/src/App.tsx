import { useEffect } from 'react';
import { useGameStore } from './store/gameStore';
import { initializeSocket } from './services/socket';
import HomePage from './pages/HomePage';
import GamePage from './pages/GamePage';
import LobbyPage from './pages/LobbyPage';

function App(): JSX.Element {
  const { gameState } = useGameStore();

  useEffect(() => {
    // Initialize socket connection
    initializeSocket();
  }, []);

  return (
    <div className="min-h-screen bg-gradient-to-br from-avalon-dark to-avalon-card">
      {gameState === 'home' && <HomePage />}
      {gameState === 'lobby' && <LobbyPage />}
      {(gameState === 'playing' || gameState === 'voting') && <GamePage />}
    </div>
  );
}

export default App;
