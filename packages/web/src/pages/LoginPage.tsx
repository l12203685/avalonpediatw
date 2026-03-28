import { useState } from 'react';
import { Chrome, Github, Loader, UserCircle } from 'lucide-react';
import { signInWithGoogle, signInWithGithub } from '../services/auth';
import { useGameStore } from '../store/gameStore';
import { initializeSocket } from '../services/socket';
import { v4 as uuidv4 } from 'uuid';

export default function LoginPage(): JSX.Element {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [guestName, setGuestName] = useState('');
  const [showGuest, setShowGuest] = useState(false);
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
      setError(err instanceof Error ? err.message : '登入失敗');
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
      setError(err instanceof Error ? err.message : '登入失敗');
    } finally {
      setLoading(false);
    }
  };

  const handleGuestLogin = async (): Promise<void> => {
    const name = guestName.trim();
    if (!name) {
      setError('請輸入你的名字');
      return;
    }
    try {
      setLoading(true);
      setError('');
      // Guest token: JSON with uid + displayName, server accepts this when Firebase Admin is not configured
      const uid = uuidv4();
      const token = JSON.stringify({ uid, displayName: name });
      await initializeSocket(token);
      setGameState('home');
    } catch (err) {
      console.error('Guest login error:', err);
      setError(err instanceof Error ? err.message : '連線失敗');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex items-center justify-center min-h-screen p-4">
      <div className="w-full max-w-md space-y-8">
        {/* Header */}
        <div className="text-center space-y-3">
          <h1 className="text-6xl font-black bg-gradient-to-r from-blue-400 via-purple-400 to-pink-400 bg-clip-text text-transparent">
            AVALON
          </h1>
          <p className="text-xl text-gray-300">阿瓦隆：抵抗組織</p>
          <p className="text-sm text-gray-500">5–10 人 • 即時連線對戰</p>
        </div>

        {/* Error Message */}
        {error && (
          <div className="bg-red-900/50 border border-red-600 rounded-lg p-3 text-red-200 text-sm">
            {error}
          </div>
        )}

        {/* Guest login (primary for prototype) */}
        <div className="bg-avalon-card/60 border-2 border-blue-500/50 rounded-xl p-5 space-y-4">
          <div className="flex items-center gap-2 mb-1">
            <UserCircle size={20} className="text-blue-400" />
            <p className="font-bold text-white">訪客登入（測試用）</p>
          </div>
          {showGuest ? (
            <>
              <input
                type="text"
                placeholder="輸入你的名字（2–12 字）"
                value={guestName}
                maxLength={12}
                onChange={e => setGuestName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleGuestLogin()}
                className="w-full bg-avalon-dark border border-gray-600 rounded-lg px-4 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
                autoFocus
              />
              <button
                onClick={handleGuestLogin}
                disabled={loading || !guestName.trim()}
                className="w-full bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700 disabled:from-gray-600 disabled:to-gray-700 text-white font-bold py-2.5 px-6 rounded-lg transition-all flex items-center justify-center gap-2"
              >
                {loading ? <Loader size={18} className="animate-spin" /> : null}
                進入遊戲
              </button>
            </>
          ) : (
            <button
              onClick={() => setShowGuest(true)}
              className="w-full bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700 text-white font-bold py-2.5 px-6 rounded-lg transition-all"
            >
              訪客進入（不需帳號）
            </button>
          )}
        </div>

        {/* Divider */}
        <div className="flex items-center gap-3">
          <div className="flex-1 h-px bg-gray-700" />
          <span className="text-xs text-gray-500">或用帳號登入</span>
          <div className="flex-1 h-px bg-gray-700" />
        </div>

        {/* Social login */}
        <div className="space-y-3">
          <button
            onClick={handleGoogleLogin}
            disabled={loading}
            className="w-full bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-white font-semibold py-2.5 px-6 rounded-lg transition-all flex items-center justify-center gap-3 border border-gray-600"
          >
            <Chrome size={18} />
            Google 登入
          </button>

          <button
            onClick={handleGithubLogin}
            disabled={loading}
            className="w-full bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-white font-semibold py-2.5 px-6 rounded-lg transition-all flex items-center justify-center gap-3 border border-gray-600"
          >
            <Github size={18} />
            GitHub 登入
          </button>
        </div>

        <p className="text-center text-xs text-gray-600">
          訪客模式不需要帳號，但重新整理後身分會重置
        </p>
      </div>
    </div>
  );
}
