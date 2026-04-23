import { useState } from 'react';
import { Loader, Eye, EyeOff, UserCircle, Lock } from 'lucide-react';
import { loginPassword, extractOAuthErrorFromUrl } from '../services/auth';
import { useGameStore } from '../store/gameStore';
import { initializeSocket } from '../services/socket';
import BrandHeader from '../components/BrandHeader';

/**
 * Phase B 新登入架構（2026-04-23 Edward 指令）：
 *
 *   - 帳號 + 密碼 登入，首次即註冊（帳號 = server mint 的 uuid）
 *   - 砍掉訪客 / Google / Discord / LINE 入口（既有 Discord/LINE OAuth 仍在 server 側保留
 *     給「綁定」用，見 SettingsPage；登入流程只走帳號+密碼）
 *   - 忘記密碼連結在表單下方
 *
 * 註冊頁是獨立頁面（RegisterCompletePage），在按「建立帳號」或首次登入後才進入。
 * 這裡只處理既有使用者登入 + 前往註冊 / 忘密。
 */
export default function LoginPage(): JSX.Element {
  const { setGameState } = useGameStore();
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState(() => extractOAuthErrorFromUrl() ?? '');
  const [accountName, setAccountName] = useState('');
  const [password,    setPassword]    = useState('');
  const [showPw,      setShowPw]      = useState(false);

  const handleLogin = async (): Promise<void> => {
    if (!accountName.trim() || !password) {
      setError('請輸入帳號與密碼');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const result = await loginPassword(accountName.trim(), password);
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

  const handleSignup = (): void => {
    setGameState('registerComplete');
  };

  return (
    <div className="flex items-center justify-center min-h-screen p-4 bg-black">
      <div className="w-full max-w-md space-y-6">
        {/* Header — 跟大廳一致 */}
        <BrandHeader size="lg" />

        {/* Error */}
        {error && (
          <div
            data-testid="login-error"
            className="bg-red-900/50 border border-red-600 rounded-lg p-3 text-red-200 text-sm"
          >
            {error}
          </div>
        )}

        <div className="bg-zinc-900/70 border border-zinc-800 rounded-2xl p-5 space-y-4">
          <h1 className="text-white text-lg font-bold flex items-center gap-2">
            <Lock size={18} className="text-amber-400" />
            帳號登入
          </h1>

          {/* 帳號 */}
          <div className="space-y-1.5">
            <label htmlFor="login-account" className="text-xs text-zinc-400 font-semibold">
              帳號
            </label>
            <div className="relative">
              <UserCircle size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
              <input
                id="login-account"
                data-testid="login-input-account"
                type="text"
                autoComplete="username"
                placeholder="輸入帳號"
                value={accountName}
                maxLength={20}
                onChange={e => setAccountName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleLogin()}
                className="w-full bg-black border border-zinc-700 rounded-lg pl-9 pr-3 py-2.5 text-white placeholder-zinc-500 focus:outline-none focus:border-white"
              />
            </div>
          </div>

          {/* 密碼 */}
          <div className="space-y-1.5">
            <label htmlFor="login-password" className="text-xs text-zinc-400 font-semibold">
              密碼
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
                onKeyDown={e => e.key === 'Enter' && handleLogin()}
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

          {/* 登入鍵 */}
          <button
            onClick={handleLogin}
            disabled={loading}
            data-testid="login-btn-submit"
            className="w-full bg-white hover:bg-zinc-200 disabled:opacity-50 text-black font-bold py-2.5 rounded-xl transition-all flex items-center justify-center gap-2"
          >
            {loading && <Loader size={18} className="animate-spin" />}
            登入
          </button>

          {/* 忘密 + 註冊 連結 */}
          <div className="flex items-center justify-between text-xs pt-1">
            <button
              type="button"
              onClick={handleForgot}
              data-testid="login-link-forgot"
              className="text-zinc-400 hover:text-white underline underline-offset-2"
            >
              忘記密碼？
            </button>
            <button
              type="button"
              onClick={handleSignup}
              data-testid="login-link-signup"
              className="text-amber-400 hover:text-amber-300 font-semibold"
            >
              建立新帳號
            </button>
          </div>
        </div>

        <p className="text-center text-[11px] text-zinc-600 leading-relaxed">
          新玩家按「建立新帳號」後會進入個人設定頁
          <br />
          可以強制綁定主要信箱，另外選綁 Google / Discord / LINE
        </p>
      </div>
    </div>
  );
}
