import { useState } from 'react';
import { Loader, Eye, EyeOff, Mail, Lock, ChevronDown, ChevronUp } from 'lucide-react';
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
 * OAuth-primary 登入頁（2026-04-23 Edward）：
 *
 *   「如果綁 google => email 直接填入 gmail 信箱。
 *    簡單說 email 綁定是 for 同時沒有 google/line/dc 的」
 *
 * 架構：
 *   1. 上半 — 3 大 OAuth 按鈕（主要登入路徑）；點下去 server 自動用 OAuth email
 *      建帳 or 登入，不需要先填 email/密碼。
 *   2. 下半 — email + 密碼（備援，給沒有任何 OAuth 帳號的使用者）。可折疊，預設
 *      展開；標題明示「沒有 OAuth 帳號？用 email 註冊」。
 *   3. OAuth 失敗（缺 email / Firebase 未設定 / Firestore 寫入錯）→ 顯示錯誤訊息，
 *      引導使用者改走 email 備援。
 */
export default function LoginPage(): JSX.Element {
  const { setGameState } = useGameStore();
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState(() => extractOAuthErrorFromUrl() ?? '');
  const [email,    setEmail]    = useState('');
  const [password, setPassword] = useState('');
  const [showPw,   setShowPw]   = useState(false);
  const [emailPanelOpen, setEmailPanelOpen] = useState(true);

  // OAuth 快速登入（現在是主登入路徑 — 自動建帳 or 登入）
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
      setError(err instanceof Error ? err.message : 'Google 登入失敗，請稍後再試');
    } finally {
      setLoading(false);
    }
  };

  // email + 密碼（備援，給沒 OAuth 帳號的人）
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
    /* Edward 2026-04-27 mobile single-viewport: p-4 → p-3 sm:p-4. */
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

        {/* ────────── 上半：OAuth 主登入路徑 ────────── */}
        {/* Edward 2026-04-27 mobile single-viewport: 縮 p-5 → p-3, h1 縮一級, hint
            縮成單行 truncate-able. */}
        <div className="bg-zinc-900/70 border border-zinc-800 rounded-2xl p-3 sm:p-5 space-y-2 sm:space-y-3">
          <h1 className="text-white text-base sm:text-lg font-bold">快速登入 / 註冊</h1>
          <p className="text-[11px] sm:text-xs text-zinc-400 leading-relaxed">
            點擊任一選項即可登入。若該 email 尚未註冊，系統會自動以此 email 建立帳號；
            已註冊則直接登入。
          </p>
          <div className="grid grid-cols-1 gap-2 pt-1">
            {/* Google */}
            <button
              type="button"
              onClick={handleQuickGoogle}
              disabled={loading || !hasFirebaseAuthConfigured()}
              data-testid="login-btn-quick-google"
              className="w-full bg-white hover:bg-zinc-100 disabled:opacity-40 text-black font-semibold py-2.5 sm:py-3 rounded-xl transition-all flex items-center justify-center gap-2 border border-zinc-300"
              title={hasFirebaseAuthConfigured() ? '' : '未設定 Firebase，Google 登入不可用'}
            >
              {loading && <Loader size={16} className="animate-spin" />}
              <span className="text-base font-bold">G</span>
              <span>使用 Google 登入</span>
            </button>
            {/* LINE */}
            <button
              type="button"
              onClick={handleQuickLine}
              disabled={loading}
              data-testid="login-btn-quick-line"
              className="w-full bg-[#06C755] hover:bg-[#05b04b] disabled:opacity-40 text-white font-semibold py-2.5 sm:py-3 rounded-xl transition-all flex items-center justify-center gap-2"
            >
              <span className="text-base font-bold">L</span>
              <span>使用 LINE 登入</span>
            </button>
            {/* Discord */}
            <button
              type="button"
              onClick={handleQuickDiscord}
              disabled={loading}
              data-testid="login-btn-quick-discord"
              className="w-full bg-[#5865F2] hover:bg-[#4853e0] disabled:opacity-40 text-white font-semibold py-2.5 sm:py-3 rounded-xl transition-all flex items-center justify-center gap-2"
            >
              <span className="text-base font-bold">D</span>
              <span>使用 Discord 登入</span>
            </button>
          </div>
        </div>

        {/* ────────── 下半：email + 密碼（備援） ────────── */}
        <div className="bg-zinc-900/70 border border-zinc-800 rounded-2xl">
          <button
            type="button"
            onClick={() => setEmailPanelOpen(v => !v)}
            data-testid="login-toggle-email-panel"
            /* Edward 2026-04-27 mobile single-viewport: p-5 → p-3 sm:p-5;
               備援路徑 hint 只在 sm+ 顯示, mobile 留 h2 + chevron 即可. */
            className="w-full p-3 sm:p-5 flex items-center justify-between text-left"
            aria-expanded={emailPanelOpen}
          >
            <div>
              <h2 className="text-white text-[13px] sm:text-sm font-semibold flex items-center gap-2">
                <Mail size={16} className="text-zinc-400" />
                沒有 Google / LINE / Discord？用 email 註冊
              </h2>
              <p className="hidden sm:block text-[11px] text-zinc-500 mt-1">
                備援路徑 — 完全用不到 OAuth 的使用者適用
              </p>
            </div>
            {emailPanelOpen
              ? <ChevronUp size={18} className="text-zinc-500 flex-shrink-0" />
              : <ChevronDown size={18} className="text-zinc-500 flex-shrink-0" />}
          </button>

          {emailPanelOpen && (
            /* Edward 2026-04-27 mobile single-viewport: 縮 px-5 pb-5 → px-3 pb-3
               sm:px-5 sm:pb-5; space-y-4 → space-y-2 sm:space-y-4; 隱藏 hint
               (mobile 直接 input fields, 解釋文字略). */
            <div className="px-3 pb-3 sm:px-5 sm:pb-5 space-y-2 sm:space-y-4 border-t border-zinc-800 pt-3 sm:pt-4">
              <p className="hidden sm:block text-xs text-zinc-400 leading-relaxed">
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
                className="w-full bg-zinc-200 hover:bg-white disabled:opacity-50 text-black font-bold py-2.5 rounded-xl transition-all flex items-center justify-center gap-2"
              >
                {loading && <Loader size={18} className="animate-spin" />}
                email 登入 / 註冊
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
          )}
        </div>
      </div>
    </div>
  );
}
