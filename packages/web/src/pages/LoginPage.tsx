import { useState } from 'react';
import { Loader, Eye, EyeOff, Mail, Lock } from 'lucide-react';
import { loginOrRegister } from '../services/auth';
import { useGameStore } from '../store/gameStore';
import { initializeSocket } from '../services/socket';
import BrandHeader from '../components/BrandHeader';

/**
 * 純帳密登入頁（2026-06-25 Edward「外部協作部份全部拿掉，只保留 github；
 * 註冊登入不用留 Line/DC/gmail，純粹以信箱+密碼（註冊 or 登入）即可」）。
 *
 * 帳號 = 信箱。沿用既有 `loginOrRegister`：不存在的信箱 → 自動註冊；
 * 已註冊 → 驗密碼登入。OAuth（Google / LINE / Discord）入口已移除；
 * 訪客快速入口仍由 App.tsx 的 lazy-guest 流程處理，需要時走完整版。
 */
export default function LoginPage(): JSX.Element {
  const { setGameState } = useGameStore();
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState('');
  const [email,    setEmail]    = useState('');
  const [password, setPassword] = useState('');
  const [showPw,   setShowPw]   = useState(false);

  const handleSubmit = async (): Promise<void> => {
    const trimmed = email.trim();
    if (!trimmed || !password) {
      setError('信箱與密碼必填');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const result = await loginOrRegister(trimmed, password);
      await initializeSocket(result.token);
      setGameState('home');
    } catch (err) {
      setError(err instanceof Error ? err.message : '登入失敗');
    } finally {
      setLoading(false);
    }
  };

  const handleForgot = (): void => {
    setGameState('forgotPassword');
  };

  return (
    <div className="flex items-center justify-center min-h-screen p-3 sm:p-4 bg-black">
      <div className="w-full max-w-md space-y-3 sm:space-y-6">
        <BrandHeader size="lg" />

        {error && (
          <div
            data-testid="login-error"
            className="bg-red-900/50 border border-red-600 rounded-lg p-3 text-red-200 text-sm"
          >
            {error}
          </div>
        )}

        <div className="bg-zinc-900/70 border border-zinc-800 rounded-2xl p-4 sm:p-6 space-y-4">
          <div>
            <h1 className="text-white text-lg font-bold">登入 / 註冊</h1>
            <p className="text-xs text-zinc-400 leading-relaxed mt-1">
              帳號就是信箱。不存在的信箱會自動建立帳號；已註冊則輸入密碼即登入。
            </p>
          </div>

          {/* Email */}
          <div className="space-y-1.5">
            <label htmlFor="login-email" className="text-xs text-zinc-400 font-semibold">
              信箱
            </label>
            <div className="relative">
              <Mail size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
              <input
                id="login-email"
                data-testid="login-input-email"
                type="email"
                autoComplete="email"
                placeholder="email@example.com"
                value={email}
                onChange={e => setEmail(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSubmit()}
                className="w-full bg-black border border-zinc-700 rounded-lg pl-9 pr-3 py-2.5 text-white placeholder-zinc-500 focus:outline-none focus:border-white"
              />
            </div>
          </div>

          {/* Password */}
          <div className="space-y-1.5">
            <label htmlFor="login-password" className="text-xs text-zinc-400 font-semibold">
              密碼（8 字以上，含英文字母與數字）
            </label>
            <div className="relative">
              <Lock size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
              <input
                id="login-password"
                data-testid="login-input-password"
                type={showPw ? 'text' : 'password'}
                autoComplete="current-password"
                placeholder="輸入密碼"
                value={password}
                onChange={e => setPassword(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSubmit()}
                className="w-full bg-black border border-zinc-700 rounded-lg pl-9 pr-10 py-2.5 text-white placeholder-zinc-500 focus:outline-none focus:border-white"
              />
              <button
                type="button"
                onClick={() => setShowPw(v => !v)}
                aria-label={showPw ? '隱藏密碼' : '顯示密碼'}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
              >
                {showPw ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          <button
            onClick={handleSubmit}
            disabled={loading}
            data-testid="login-btn-submit"
            className="w-full bg-zinc-200 hover:bg-white disabled:opacity-50 text-black font-bold py-2.5 rounded-xl transition-all flex items-center justify-center gap-2"
          >
            {loading && <Loader size={18} className="animate-spin" />}
            登入 / 註冊
          </button>

          <div className="flex items-center justify-center text-xs">
            <button
              type="button"
              onClick={handleForgot}
              data-testid="login-link-forgot"
              className="text-zinc-400 hover:text-white underline underline-offset-2"
            >
              忘記密碼？
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
