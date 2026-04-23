import { useEffect, useMemo, useState } from 'react';
import { Loader, Lock, Eye, EyeOff, CheckCircle2, XCircle } from 'lucide-react';
import { resetPassword, estimatePasswordStrength } from '../services/auth';
import { useGameStore } from '../store/gameStore';
import BrandHeader from '../components/BrandHeader';

/**
 * 從 email 連結進入的重設密碼頁（Phase B）：
 *
 *   - 從 URL query `?token=...` 讀一次性 reset token
 *   - 使用者輸入新密碼（+ 確認、+ 強度條）
 *   - 送 POST /auth/reset-password
 *   - 成功後不自動登入 — 讓使用者回登入頁確認記住新密碼
 *
 * 若 URL 沒 token → 顯示錯誤並引導回登入頁。
 */
export default function ResetPasswordPage(): JSX.Element {
  const { setGameState } = useGameStore();

  const token = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('token') ?? '';
  }, []);

  const [newPassword, setNewPassword] = useState('');
  const [confirmPw,   setConfirmPw]   = useState('');
  const [showPw,      setShowPw]      = useState(false);
  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState('');
  const [done,        setDone]        = useState(false);

  const strength = useMemo(() => estimatePasswordStrength(newPassword), [newPassword]);
  const pwMatches = newPassword.length > 0 && newPassword === confirmPw;
  const pwMismatch = confirmPw.length > 0 && newPassword !== confirmPw;

  // 清 URL query 避免 token 外洩（F5 時不重送、reload 不帶 token）
  useEffect(() => {
    if (token) {
      const clean = window.location.pathname + window.location.hash;
      window.history.replaceState({}, '', clean);
    }
  }, [token]);

  const handleSubmit = async (): Promise<void> => {
    if (!token) return;
    if (newPassword.length < 8) { setError('密碼至少 8 字元'); return; }
    if (!/[A-Za-z]/.test(newPassword)) { setError('密碼需要至少一個英文字母'); return; }
    if (!/\d/.test(newPassword)) { setError('密碼需要至少一個數字'); return; }
    if (newPassword !== confirmPw) { setError('兩次輸入的密碼不一致'); return; }
    setLoading(true);
    setError('');
    try {
      await resetPassword(token, newPassword);
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : '重設失敗，連結可能已過期');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex items-center justify-center min-h-screen p-4 bg-black">
      <div className="w-full max-w-md space-y-6">
        <BrandHeader size="lg" />

        <div className="bg-zinc-900/70 border border-zinc-800 rounded-2xl p-5 space-y-4">
          <h1 className="text-white text-lg font-bold">重設密碼</h1>

          {!token && (
            <div className="bg-red-900/50 border border-red-600 rounded-lg p-3 text-red-200 text-sm flex items-start gap-2" data-testid="reset-no-token">
              <XCircle size={18} className="flex-shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold">找不到重設連結</p>
                <p className="text-xs text-red-300 mt-1">請重新到忘密頁索取新的重設連結</p>
              </div>
            </div>
          )}

          {token && !done && (
            <>
              {error && (
                <div data-testid="reset-error" className="bg-red-900/50 border border-red-600 rounded-lg p-3 text-red-200 text-sm">
                  {error}
                </div>
              )}

              <div className="space-y-1.5">
                <label htmlFor="reset-password" className="text-xs text-zinc-400 font-semibold">
                  新密碼（至少 8 字、含英文字母 + 數字）
                </label>
                <div className="relative">
                  <Lock size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
                  <input
                    id="reset-password"
                    data-testid="reset-input-password"
                    type={showPw ? 'text' : 'password'}
                    autoComplete="new-password"
                    placeholder="新密碼"
                    value={newPassword}
                    onChange={e => setNewPassword(e.target.value)}
                    className="w-full bg-black border border-zinc-700 rounded-lg pl-9 pr-10 py-2.5 text-white placeholder-zinc-500 focus:outline-none focus:border-white"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPw(v => !v)}
                    aria-label={showPw ? '隱藏' : '顯示'}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
                  >
                    {showPw ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
                {newPassword.length > 0 && (
                  <div className="flex gap-1" data-testid="reset-pw-strength">
                    {[0, 1, 2, 3, 4].map(i => (
                      <div
                        key={i}
                        className={`h-1.5 flex-1 rounded transition-colors ${
                          i < strength.score
                            ? (['bg-red-500', 'bg-red-500', 'bg-orange-500', 'bg-yellow-500', 'bg-emerald-500'])[strength.score]
                            : 'bg-zinc-800'
                        }`}
                      />
                    ))}
                  </div>
                )}
              </div>

              <div className="space-y-1.5">
                <label htmlFor="reset-password2" className="text-xs text-zinc-400 font-semibold">
                  再次輸入
                </label>
                <div className="relative">
                  <Lock size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
                  <input
                    id="reset-password2"
                    data-testid="reset-input-password-confirm"
                    type={showPw ? 'text' : 'password'}
                    autoComplete="new-password"
                    placeholder="再輸入一次"
                    value={confirmPw}
                    onChange={e => setConfirmPw(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleSubmit()}
                    className={`w-full bg-black border rounded-lg pl-9 pr-3 py-2.5 text-white placeholder-zinc-500 focus:outline-none ${
                      pwMismatch ? 'border-red-500 focus:border-red-400'
                      : pwMatches ? 'border-emerald-500 focus:border-emerald-400'
                      : 'border-zinc-700 focus:border-white'
                    }`}
                  />
                </div>
                {pwMismatch && (
                  <p className="text-[11px] text-red-400">兩次輸入不一致</p>
                )}
              </div>

              <button
                onClick={handleSubmit}
                disabled={loading}
                data-testid="reset-btn-submit"
                className="w-full bg-white hover:bg-zinc-200 disabled:opacity-50 text-black font-bold py-2.5 rounded-xl transition-all flex items-center justify-center gap-2"
              >
                {loading && <Loader size={18} className="animate-spin" />}
                重設密碼
              </button>
            </>
          )}

          {done && (
            <div className="text-center space-y-4 py-3" data-testid="reset-done">
              <CheckCircle2 size={48} className="mx-auto text-emerald-400" />
              <div className="space-y-1">
                <p className="text-white font-semibold">密碼已更新</p>
                <p className="text-xs text-zinc-400">請用新密碼重新登入</p>
              </div>
              <button
                onClick={() => setGameState('home')}
                data-testid="reset-btn-back-to-login"
                className="w-full bg-white hover:bg-zinc-200 text-black font-bold py-2.5 rounded-xl"
              >
                回到登入
              </button>
            </div>
          )}

          {!token && (
            <button
              onClick={() => setGameState('home')}
              className="w-full bg-zinc-800 hover:bg-zinc-700 text-white font-semibold py-2.5 rounded-xl border border-zinc-700"
            >
              回到登入
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
