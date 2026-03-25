import { useState } from 'react';
import { Chrome, Github, Loader } from 'lucide-react';
import { signInWithGoogle, signInWithGithub } from '../services/auth';
import { useGameStore } from '../store/gameStore';
import { initializeSocket } from '../services/socket';

export default function LoginPage(): JSX.Element {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const { setGameState } = useGameStore();

  const handleGoogleLogin = async (): Promise<void> => {
    try {
      setLoading(true);
      setError('');

      const user = await signInWithGoogle();
      const token = await user.getIdToken();

      await initializeSocket(token);
      setGameState('home');
    } catch (err) {
      console.error('Login error:', err);
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  const handleGithubLogin = async (): Promise<void> => {
    try {
      setLoading(true);
      setError('');

      const user = await signInWithGithub();
      const token = await user.getIdToken();

      await initializeSocket(token);
      setGameState('home');
    } catch (err) {
      console.error('Login error:', err);
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex items-center justify-center min-h-screen p-4">
      <div className="w-full max-w-md space-y-8">
        {/* Header */}
        <div className="text-center space-y-4">
          <h1 className="text-5xl font-bold bg-gradient-to-r from-blue-400 to-purple-400 bg-clip-text text-transparent">
            AVALON
          </h1>
          <p className="text-xl text-gray-300">The Resistance</p>
          <p className="text-sm text-gray-500">Sign in to start playing</p>
        </div>

        {/* Error Message */}
        {error && (
          <div className="bg-red-900/50 border border-red-600 rounded-lg p-4 text-red-200">
            <p className="text-sm">{error}</p>
          </div>
        )}

        {/* Login Options */}
        <div className="space-y-4">
          <button
            onClick={handleGoogleLogin}
            disabled={loading}
            className="w-full bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800 disabled:from-gray-600 disabled:to-gray-700 text-white font-bold py-3 px-6 rounded-lg transition-all flex items-center justify-center gap-3"
          >
            {loading ? (
              <>
                <Loader size={20} className="animate-spin" />
                <span>Signing in...</span>
              </>
            ) : (
              <>
                <Chrome size={20} />
                <span>Continue with Google</span>
              </>
            )}
          </button>

          <button
            onClick={handleGithubLogin}
            disabled={loading}
            className="w-full bg-gradient-to-r from-gray-700 to-gray-800 hover:from-gray-800 hover:to-gray-900 disabled:from-gray-600 disabled:to-gray-700 text-white font-bold py-3 px-6 rounded-lg transition-all flex items-center justify-center gap-3"
          >
            {loading ? (
              <>
                <Loader size={20} className="animate-spin" />
                <span>Signing in...</span>
              </>
            ) : (
              <>
                <Github size={20} />
                <span>Continue with GitHub</span>
              </>
            )}
          </button>
        </div>

        {/* Info */}
        <div className="text-center text-xs text-gray-500">
          <p>By signing in, you agree to our Terms of Service</p>
          <p>We only collect your name and avatar</p>
        </div>
      </div>
    </div>
  );
}
