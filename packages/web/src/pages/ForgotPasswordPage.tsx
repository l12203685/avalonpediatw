import { useState } from 'react';
import { Loader, Mail, UserCircle, ArrowLeft, CheckCircle2 } from 'lucide-react';
import { forgotPassword } from '../services/auth';
import { useGameStore } from '../store/gameStore';
import BrandHeader from '../components/BrandHeader';

/**
 * 忘密頁（Phase B 新登入架構）：
 *
 *   - 輸入「帳號 + 綁定的 email」（Edward 原話「忘密：帳號 + 綁定 email」）
 *   - 送 /auth/forgot-password（server 永遠回 202；命中才寄信，避免 enumeration）
 *   - UI 永遠顯示「如果帳號存在，重設連結已寄到信箱」— 同樣不洩漏帳號是否存在
 */
export default function ForgotPasswordPage(): JSX.Element {
  const { setGameState } = useGameStore();

  const [accountName, setAccountName] = useState('');
  const [email,       setEmail]       = useState('');
  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState('');
  const [submitted,   setSubmitted]   = useState(false);
  const [ttlMs,       setTtlMs]       = useState<number | undefined>(undefined);

  const handleSubmit = async (): Promise<void> => {
    if (!accountName.trim() || !email.trim()) {
      setError('帳號與信箱都必填');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const result = await forgotPassword(accountName.trim(), email.trim());
      setTtlMs(result.ttlMs);
      setSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : '送出失敗');
    } finally {
      setLoading(false);
    }
  };

  const handleBackToLogin = (): void => {
    setGameState('home');  // App 判斷未登入 → LoginPage
  };

  return (
    <div className="flex items-center justify-center min-h-screen p-4 bg-black">
      <div className="w-full max-w-md space-y-6">
        <BrandHeader size="lg" />

        <div className="bg-zinc-900/70 border border-zinc-800 rounded-2xl p-5 space-y-4">
          <div className="flex items-center gap-2">
            <button
              onClick={handleBackToLogin}
              aria-label="返回登入"
              className="p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-white"
            >
              <ArrowLeft size={18} />
            </button>
            <h1 className="text-white text-lg font-bold">忘記密碼</h1>
          </div>

          {!submitted ? (
            <>
              <p className="text-xs text-zinc-400">
                輸入帳號與當初綁定的主要信箱，系統會寄重設連結到該信箱
              </p>

              {error && (
                <div data-testid="forgot-error" className="bg-red-900/50 border border-red-600 rounded-lg p-3 text-red-200 text-sm">
                  {error}
                </div>
              )}

              <div className="space-y-1.5">
                <label htmlFor="forgot-account" className="text-xs text-zinc-400 font-semibold">帳號</label>
                <div className="relative">
                  <UserCircle size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
                  <input
                    id="forgot-account"
                    data-testid="forgot-input-account"
                    type="text"
                    autoComplete="username"
                    placeholder="你的帳號"
                    value={accountName}
                    onChange={e => setAccountName(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleSubmit()}
                    className="w-full bg-black border border-zinc-700 rounded-lg pl-9 pr-3 py-2.5 text-white placeholder-zinc-500 focus:outline-none focus:border-white"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <label htmlFor="forgot-email" className="text-xs text-zinc-400 font-semibold">綁定的信箱</label>
                <div className="relative">
                  <Mail size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
                  <input
                    id="forgot-email"
                    data-testid="forgot-input-email"
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

              <button
                onClick={handleSubmit}
                disabled={loading}
                data-testid="forgot-btn-submit"
                className="w-full bg-white hover:bg-zinc-200 disabled:opacity-50 text-black font-bold py-2.5 rounded-xl transition-all flex items-center justify-center gap-2"
              >
                {loading && <Loader size={18} className="animate-spin" />}
                送出
              </button>
            </>
          ) : (
            <div className="text-center space-y-4 py-3" data-testid="forgot-submitted">
              <CheckCircle2 size={48} className="mx-auto text-emerald-400" />
              <div className="space-y-1">
                <p className="text-white font-semibold">若資料正確，重設連結已寄出</p>
                <p className="text-xs text-zinc-400">
                  請到信箱收信。連結{ttlMs ? ` ${Math.round(ttlMs / 60000)} 分鐘` : ' 30 分鐘'}內有效
                </p>
              </div>
              <button
                onClick={handleBackToLogin}
                className="w-full bg-zinc-800 hover:bg-zinc-700 text-white font-semibold py-2.5 rounded-xl border border-zinc-700"
              >
                回到登入
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
