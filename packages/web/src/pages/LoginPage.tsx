import { useState } from 'react';
import { motion } from 'framer-motion';
import { Chrome, Github, Loader, UserCircle, MessageCircle } from 'lucide-react';
import { signInWithGoogle, signInWithGithub } from '../services/auth';
import { useGameStore } from '../store/gameStore';
import { initializeSocket } from '../services/socket';
import { toast } from '../store/toastStore';

export default function LoginPage(): JSX.Element {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const { setGameState, setGuestMode } = useGameStore();

  const handleGoogleLogin = async (): Promise<void> => {
    try {
      setLoading(true);
      setError('');
      const user = await signInWithGoogle();
      const token = await user.getIdToken();
      await initializeSocket(token);
      setGameState('home');
    } catch (err) {
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
      setError(err instanceof Error ? err.message : '登入失敗');
    } finally {
      setLoading(false);
    }
  };

  const handleGuestLogin = (): void => {
    setGuestMode(true);
    setGameState('home');
    toast.info('以訪客身份進入，部分功能受限');
  };

  const handleComingSoon = (name: string): void => {
    toast.info(`${name} 登入即將推出`);
  };

  return (
    <div className="flex items-center justify-center min-h-screen p-4">
      <div className="w-full max-w-md space-y-8">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center space-y-3"
        >
          <h1 className="text-5xl font-black bg-gradient-to-r from-blue-400 via-purple-400 to-pink-400 bg-clip-text text-transparent">
            AVALON
          </h1>
          <p className="text-xl text-gray-300">The Resistance</p>
          <p className="text-sm text-gray-500">登入以開始遊戲</p>
        </motion.div>

        {/* Error Message */}
        {error && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-red-900/50 border border-red-600 rounded-lg p-4 text-red-200 text-sm"
          >
            {error}
          </motion.div>
        )}

        {/* Login Options */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="space-y-3"
        >
          {/* Google */}
          <motion.button
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={handleGoogleLogin}
            disabled={loading}
            className="w-full bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800 disabled:opacity-60 text-white font-bold py-3 px-6 rounded-lg transition-all flex items-center justify-center gap-3"
          >
            {loading ? <Loader size={20} className="animate-spin" /> : <Chrome size={20} />}
            <span>{loading ? '登入中...' : '使用 Google 登入'}</span>
          </motion.button>

          {/* GitHub */}
          <motion.button
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={handleGithubLogin}
            disabled={loading}
            className="w-full bg-gradient-to-r from-gray-700 to-gray-800 hover:from-gray-800 hover:to-gray-900 disabled:opacity-60 text-white font-bold py-3 px-6 rounded-lg transition-all flex items-center justify-center gap-3"
          >
            {loading ? <Loader size={20} className="animate-spin" /> : <Github size={20} />}
            <span>{loading ? '登入中...' : '使用 GitHub 登入'}</span>
          </motion.button>

          {/* Divider */}
          <div className="flex items-center gap-3 py-1">
            <div className="flex-1 h-px bg-gray-700" />
            <span className="text-xs text-gray-500">或</span>
            <div className="flex-1 h-px bg-gray-700" />
          </div>

          {/* Discord — coming soon */}
          <motion.button
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={() => handleComingSoon('Discord')}
            className="w-full bg-indigo-900/40 hover:bg-indigo-900/60 border border-indigo-600/40 text-indigo-300 font-semibold py-3 px-6 rounded-lg transition-all flex items-center justify-center gap-3 relative"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
              <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057.1 18.08.114 18.1.134 18.111a19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994.021-.04.001-.088-.041-.104a13.201 13.201 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z"/>
            </svg>
            <span>使用 Discord 登入</span>
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs bg-indigo-800/60 text-indigo-300 px-2 py-0.5 rounded">
              即將推出
            </span>
          </motion.button>

          {/* LINE — coming soon */}
          <motion.button
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={() => handleComingSoon('LINE')}
            className="w-full bg-green-900/40 hover:bg-green-900/60 border border-green-600/40 text-green-300 font-semibold py-3 px-6 rounded-lg transition-all flex items-center justify-center gap-3 relative"
          >
            <MessageCircle size={20} />
            <span>使用 LINE 登入</span>
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs bg-green-800/60 text-green-300 px-2 py-0.5 rounded">
              即將推出
            </span>
          </motion.button>

          {/* Guest */}
          <motion.button
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={handleGuestLogin}
            className="w-full bg-gray-700/50 hover:bg-gray-700 border border-gray-600 text-gray-300 hover:text-white font-semibold py-3 px-6 rounded-lg transition-all flex items-center justify-center gap-3"
          >
            <UserCircle size={20} />
            <span>訪客體驗（模擬資料）</span>
          </motion.button>
        </motion.div>

        {/* Footer */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.2 }}
          className="text-center text-xs text-gray-500"
        >
          <p>登入即表示您同意我們的服務條款</p>
          <p className="mt-1">我們僅收集您的名稱與頭像</p>
        </motion.div>
      </div>
    </div>
  );
}
