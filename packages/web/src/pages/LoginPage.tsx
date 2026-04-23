import { useState } from 'react';
import { Loader, Eye, EyeOff, Mail, Lock } from 'lucide-react';
import {
  loginOrRegister,
  extractOAuthErrorFromUrl,
  quickLoginWithDiscord,
  quickLoginWithLine,
  quickLoginWithGoogle,
  hasFirebaseAuthConfigured,
} from '../services/auth';
import { useGameStore } from '../store/gameStore';
import { initializeSocket } from '../services/socket';
import BrandHeader from '../components/BrandHeader';

/**
 * Phase C 單頁登入／註冊（2026-04-23 Edward 原話）：
 *
 *   「帳號 = email，註冊的時候設定新密碼，不用再特別有個建立新帳號的頁面；
 *   直接在帳號登入那邊就備註 登入 or 註冊；不存在的 email 就等同註冊，
 *   存在的 email 就是登入。」
 *
 * 規格：email + password 兩欄 + 「登入 / 註冊」按鈕；備註「不存在的 email 會自動
 * 建立帳號」；忘記密碼連結保留。社群登入 / 綁定仍放在 SettingsPage。
 */
export default function LoginPage(): JSX.Element {
  const { setGameState } = useGameStore();
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState(() => extractOAuthErrorFromUrl() ?? '');
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

  // OAuth 快速登入（2026-04-23 Edward）：登入頁綁 google/line/dc 直登入口。
  const handleQuickDiscord = (): void => { quickLoginWithDiscord(); };
  const handleQuickLine    = (): void => { quickLoginWithLine(); };
  const handleQuickGoogle  = async (): Promise<void> => {
    setLoading(true);
    setError('');
    try {
      const result = await quickLoginWithGoogle();
      await initializeSocket(result.token);
      setGameState('home');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Google 快速登入失敗');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex items-center justify-center min-h-screen p-4 bg-black">
      <div className="w-full max-w-md space-y-6">
        <BrandHeader size="lg" />

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
            登入 / 註冊
          </h1>
          <p className="text-xs text-zinc-400 leading-relaxed">
            不存在的信箱會自動建立帳號；已註冊的信箱輸入密碼即登入。
          </p>

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
            className="w-full bg-white hover:bg-zinc-200 disabled:opacity-50 text-black font-bold py-2.5 rounded-xl transition-all flex items-center justify-center gap-2"
          >
            {loading && <Loader size={18} className="animate-spin" />}
            登入 / 註冊
          </button>

          <div className="flex items-center justify-center text-xs pt-1">
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

        {/*
          OAuth 快速登入區塊（2026-04-23 Edward）：帳號已綁過 Google/LINE/DC 的使用者
          免打密碼，直接點對應按鈕即可登入；若該第三方對應的 email 尚未在站上綁定，
          server 會回 provider_not_linked，錯誤區塊提示「先以 email 登入後再綁定」。
        */}
        <div className="bg-zinc-900/70 border border-zinc-800 rounded-2xl p-5 space-y-3">
          <div className="flex items-center gap-2">
            <div className="flex-1 h-px bg-zinc-800" />
            <span className="text-[11px] text-zinc-500 uppercase tracking-wider">
              或使用第三方快速登入
            </span>
            <div className="flex-1 h-px bg-zinc-800" />
          </div>
          <p className="text-[11px] text-zinc-500 leading-relaxed">
            這組 Google / LINE / Discord 的 email 必須先在站上以 email 註冊過並完成綁定，
            否則會提示請先用 email 登入。
          </p>
          <div className="grid grid-cols-1 gap-2">
            {/* Google */}
            <button
              type="button"
              onClick={handleQuickGoogle}
              disabled={loading || !hasFirebaseAuthConfigured()}
              data-testid="login-btn-quick-google"
              className="w-full bg-white hover:bg-zinc-100 disabled:opacity-40 text-black font-semibold py-2.5 rounded-xl transition-all flex items-center justify-center gap-2 border border-zinc-300"
              title={hasFirebaseAuthConfigured() ? '' : '未設定 Firebase，Google 快登不可用'}
            >
              <span className="text-base">G</span>
              <span>使用 Google 快速登入</span>
            </button>
            {/* LINE */}
            <button
              type="button"
              onClick={handleQuickLine}
              disabled={loading}
              data-testid="login-btn-quick-line"
              className="w-full bg-[#06C755] hover:bg-[#05b04b] disabled:opacity-40 text-white font-semibold py-2.5 rounded-xl transition-all flex items-center justify-center gap-2"
            >
              <span className="text-base">L</span>
              <span>使用 LINE 快速登入</span>
            </button>
            {/* Discord */}
            <button
              type="button"
              onClick={handleQuickDiscord}
              disabled={loading}
              data-testid="login-btn-quick-discord"
              className="w-full bg-[#5865F2] hover:bg-[#4853e0] disabled:opacity-40 text-white font-semibold py-2.5 rounded-xl transition-all flex items-center justify-center gap-2"
            >
              <span className="text-base">D</span>
              <span>使用 Discord 快速登入</span>
            </button>
          </div>
        </div>

        <p className="text-center text-[11px] text-zinc-600 leading-relaxed">
          若第三方快速登入失敗，請先以 email 登入後到「系統設定」頁綁定
        </p>
      </div>
    </div>
  );
}
