import { useMemo, useState } from 'react';
import {
  Loader, Lock, Eye, EyeOff, Mail, UserCircle, Chrome, ArrowLeft,
} from 'lucide-react';
import {
  registerPassword,
  estimatePasswordStrength,
  signInWithDiscord,
  signInWithLine,
  signInWithGoogle,
  hasFirebaseAuthConfigured,
  getIdToken,
  upgradeGuestToRegistered,
  stashLinkedProviderToken,
} from '../services/auth';
import { useGameStore } from '../store/gameStore';
import { initializeSocket, getStoredToken } from '../services/socket';
import BrandHeader from '../components/BrandHeader';

/**
 * 首次即註冊頁（Edward 2026-04-23 原話）：
 *
 *   - 帳號 (3-20 字 [A-Za-z0-9_.-])
 *   - 密碼 (8-256 字 + ≥1 字母 + ≥1 數字) — 附 zxcvbn 風格強度條
 *   - 必填主要信箱
 *   - 可選即時綁 Google / Discord / LINE（完成註冊後）
 *
 * 流程：填完基本欄位 → 送 /auth/register → 拿 JWT → initializeSocket →
 * 進入「可選綁定社群」區塊；使用者可選擇「完成」直接進首頁，或點綁定按鈕
 * 走原有 OAuth 流程（已登入狀態 = bind 模式）。
 */
export default function RegisterCompletePage(): JSX.Element {
  const { setGameState } = useGameStore();

  const [step, setStep] = useState<'form' | 'bind'>('form');

  // Form state
  const [accountName,  setAccountName]  = useState('');
  const [password,     setPassword]     = useState('');
  const [confirmPw,    setConfirmPw]    = useState('');
  const [primaryEmail, setPrimaryEmail] = useState('');
  const [showPw,       setShowPw]       = useState(false);

  const [submitting,  setSubmitting]  = useState(false);
  const [formError,   setFormError]   = useState('');

  const [bindBusy, setBindBusy] = useState<'google' | 'discord' | 'line' | null>(null);
  const [bindError, setBindError] = useState('');

  const strength = useMemo(() => estimatePasswordStrength(password), [password]);
  const pwMatches = password.length > 0 && password === confirmPw;
  const pwMismatch = confirmPw.length > 0 && password !== confirmPw;

  const validateBeforeSubmit = (): string | null => {
    const name = accountName.trim();
    if (name.length < 3 || name.length > 20) return '帳號需為 3-20 字';
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) return '帳號只能用英文、數字、底線、點、連字號';
    if (password.length < 8) return '密碼至少 8 字元';
    if (!/[A-Za-z]/.test(password)) return '密碼需要至少一個英文字母';
    if (!/\d/.test(password)) return '密碼需要至少一個數字';
    if (password !== confirmPw) return '兩次輸入的密碼不一致';
    const email = primaryEmail.trim();
    if (!email) return '主要信箱必填';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return '信箱格式不正確';
    return null;
  };

  const handleSubmit = async (): Promise<void> => {
    const err = validateBeforeSubmit();
    if (err) { setFormError(err); return; }
    setSubmitting(true);
    setFormError('');
    try {
      const result = await registerPassword({
        accountName:  accountName.trim(),
        password,
        primaryEmail: primaryEmail.trim(),
      });
      await initializeSocket(result.token);
      // 進入綁定步驟 — 使用者可選綁或直接點「完成」
      setStep('bind');
    } catch (e) {
      setFormError(e instanceof Error ? e.message : '註冊失敗');
    } finally {
      setSubmitting(false);
    }
  };

  const handleBindGoogle = async (): Promise<void> => {
    if (!hasFirebaseAuthConfigured()) {
      setBindError('此環境未設定 Google 登入');
      return;
    }
    setBindBusy('google');
    setBindError('');
    try {
      await signInWithGoogle();
      const idToken = await getIdToken();
      const result = await upgradeGuestToRegistered('google', idToken);
      if (!result.ok) {
        setBindError(result.error ?? '綁定失敗');
        return;
      }
      // 跟 SettingsPage.handleUpgrade 同套：stash + reload 讓 state / socket
      // 都乾淨重起，provider='google' 會被 socket auth:success 正確塞回 store。
      stashLinkedProviderToken(idToken);
      window.location.reload();
    } catch (e) {
      setBindError(e instanceof Error ? e.message : '綁定失敗');
    } finally {
      setBindBusy(null);
    }
  };

  const handleBindDiscord = (): void => {
    const jwt = getStoredToken();
    if (!jwt) { setBindError('請先完成註冊'); return; }
    setBindBusy('discord');
    signInWithDiscord('bind', jwt);
  };

  const handleBindLine = (): void => {
    const jwt = getStoredToken();
    if (!jwt) { setBindError('請先完成註冊'); return; }
    setBindBusy('line');
    signInWithLine('bind', jwt);
  };

  const handleFinish = (): void => {
    setGameState('home');
  };

  const handleBack = (): void => {
    setGameState('home');  // 若登入流程被 LoginPage 轉進來就回 login（App 判 isAuth 後去 LoginPage）
  };

  return (
    <div className="flex items-center justify-center min-h-screen p-4 bg-black">
      <div className="w-full max-w-md space-y-6">
        <BrandHeader size="lg" />

        {step === 'form' && (
          <div className="bg-zinc-900/70 border border-zinc-800 rounded-2xl p-5 space-y-4">
            <div className="flex items-center gap-2">
              <button
                onClick={handleBack}
                aria-label="返回"
                className="p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-white"
              >
                <ArrowLeft size={18} />
              </button>
              <h1 className="text-white text-lg font-bold">建立新帳號</h1>
            </div>

            {formError && (
              <div data-testid="register-error" className="bg-red-900/50 border border-red-600 rounded-lg p-3 text-red-200 text-sm">
                {formError}
              </div>
            )}

            {/* 帳號 */}
            <div className="space-y-1.5">
              <label htmlFor="register-account" className="text-xs text-zinc-400 font-semibold">
                帳號（3-20 字，英數 _ . -）
              </label>
              <div className="relative">
                <UserCircle size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
                <input
                  id="register-account"
                  data-testid="register-input-account"
                  type="text"
                  autoComplete="username"
                  placeholder="你的帳號"
                  value={accountName}
                  maxLength={20}
                  onChange={e => setAccountName(e.target.value)}
                  className="w-full bg-black border border-zinc-700 rounded-lg pl-9 pr-3 py-2.5 text-white placeholder-zinc-500 focus:outline-none focus:border-white"
                />
              </div>
            </div>

            {/* 密碼 + 強度條 */}
            <div className="space-y-1.5">
              <label htmlFor="register-password" className="text-xs text-zinc-400 font-semibold">
                密碼（至少 8 字、含英文字母 + 數字）
              </label>
              <div className="relative">
                <Lock size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
                <input
                  id="register-password"
                  data-testid="register-input-password"
                  type={showPw ? 'text' : 'password'}
                  autoComplete="new-password"
                  placeholder="設一組密碼"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
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
              <PasswordStrengthMeter strength={strength} />
              {strength.hint && (
                <p className="text-[11px] text-zinc-500">提示：{strength.hint}</p>
              )}
            </div>

            {/* 確認密碼 */}
            <div className="space-y-1.5">
              <label htmlFor="register-password2" className="text-xs text-zinc-400 font-semibold">
                再次輸入密碼
              </label>
              <div className="relative">
                <Lock size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
                <input
                  id="register-password2"
                  data-testid="register-input-password-confirm"
                  type={showPw ? 'text' : 'password'}
                  autoComplete="new-password"
                  placeholder="再輸入一次"
                  value={confirmPw}
                  onChange={e => setConfirmPw(e.target.value)}
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

            {/* 信箱（必填） */}
            <div className="space-y-1.5">
              <label htmlFor="register-email" className="text-xs text-zinc-400 font-semibold">
                主要信箱（必填，忘密時用）
              </label>
              <div className="relative">
                <Mail size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
                <input
                  id="register-email"
                  data-testid="register-input-email"
                  type="email"
                  autoComplete="email"
                  placeholder="email@example.com"
                  value={primaryEmail}
                  onChange={e => setPrimaryEmail(e.target.value)}
                  className="w-full bg-black border border-zinc-700 rounded-lg pl-9 pr-3 py-2.5 text-white placeholder-zinc-500 focus:outline-none focus:border-white"
                />
              </div>
            </div>

            <button
              onClick={handleSubmit}
              disabled={submitting}
              data-testid="register-btn-submit"
              className="w-full bg-white hover:bg-zinc-200 disabled:opacity-50 text-black font-bold py-2.5 rounded-xl transition-all flex items-center justify-center gap-2"
            >
              {submitting && <Loader size={18} className="animate-spin" />}
              建立帳號
            </button>
          </div>
        )}

        {step === 'bind' && (
          <div className="bg-zinc-900/70 border border-zinc-800 rounded-2xl p-5 space-y-4">
            <h1 className="text-white text-lg font-bold">選擇綁定社群帳號（可選）</h1>
            <p className="text-xs text-zinc-400 leading-relaxed">
              綁定後可以用社群帳號直接登入，也可在系統設定頁管理
            </p>

            {bindError && (
              <div className="bg-red-900/50 border border-red-600 rounded-lg p-3 text-red-200 text-sm">
                {bindError}
              </div>
            )}

            <div className="space-y-2">
              <button
                onClick={handleBindGoogle}
                disabled={bindBusy !== null || !hasFirebaseAuthConfigured()}
                data-testid="register-btn-bind-google"
                className="w-full bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-white font-semibold py-2.5 px-4 rounded-lg flex items-center justify-center gap-3 border border-zinc-600 transition-colors"
              >
                {bindBusy === 'google' ? <Loader size={16} className="animate-spin" /> : <Chrome size={16} className="text-blue-400" />}
                綁定 Google
              </button>
              <button
                onClick={handleBindDiscord}
                disabled={bindBusy !== null}
                data-testid="register-btn-bind-discord"
                className="w-full bg-[#5865F2] hover:bg-[#4752C4] disabled:opacity-50 text-white font-semibold py-2.5 px-4 rounded-lg flex items-center justify-center gap-3 transition-colors"
              >
                {bindBusy === 'discord' ? <Loader size={16} className="animate-spin" /> : <DiscordIcon />}
                綁定 Discord
              </button>
              <button
                onClick={handleBindLine}
                disabled={bindBusy !== null}
                data-testid="register-btn-bind-line"
                className="w-full bg-[#00B900] hover:bg-[#009900] disabled:opacity-50 text-white font-semibold py-2.5 px-4 rounded-lg flex items-center justify-center gap-3 transition-colors"
              >
                {bindBusy === 'line' ? <Loader size={16} className="animate-spin" /> : <LineIcon />}
                綁定 LINE
              </button>
            </div>

            <button
              onClick={handleFinish}
              data-testid="register-btn-finish"
              className="w-full text-zinc-400 hover:text-white text-sm py-2 pt-2"
            >
              跳過，之後到系統設定再綁
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function PasswordStrengthMeter({ strength }: { strength: ReturnType<typeof estimatePasswordStrength> }): JSX.Element {
  const colors = ['bg-zinc-800', 'bg-red-500', 'bg-orange-500', 'bg-yellow-500', 'bg-emerald-500'];
  const labelZh: Record<typeof strength.label, string> = {
    empty:     '',
    weak:      '很弱',
    fair:      '普通',
    good:      '不錯',
    strong:    '強',
    excellent: '超強',
  };
  return (
    <div className="space-y-1">
      <div className="flex gap-1" data-testid="register-pw-strength">
        {[0, 1, 2, 3, 4].map(i => (
          <div
            key={i}
            className={`h-1.5 flex-1 rounded transition-colors ${
              i < strength.score ? colors[strength.score] : 'bg-zinc-800'
            }`}
          />
        ))}
      </div>
      {strength.label !== 'empty' && (
        <p className="text-[11px] text-zinc-500" data-testid="register-pw-strength-label">
          強度：{labelZh[strength.label]}
        </p>
      )}
    </div>
  );
}

function DiscordIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057c.002.022.015.043.032.055a19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/>
    </svg>
  );
}

function LineIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M19.365 9.89c.50 0 .907.41.907.91s-.406.91-.907.91h-2.25v1.356h2.25c.5 0 .907.408.907.909s-.406.91-.907.91H16.21a.907.907 0 0 1-.907-.91V9.89c0-.5.407-.91.907-.91h3.155m-9.503 4.995a.907.907 0 0 1-.877.91.9.9 0 0 1-.715-.35l-2.56-3.482V14.8a.907.907 0 1 1-1.815 0V9.89a.907.907 0 0 1 1.59-.602l2.562 3.482V9.89a.907.907 0 0 1 1.815 0v4.996M7.077 9.89a.907.907 0 0 1 0 1.815h-2.25v4.096a.907.907 0 1 1-1.814 0V9.89c0-.5.406-.91.907-.91h3.157M24 10.27C24 4.595 18.627 0 12 0S0 4.594 0 10.27c0 5.076 4.504 9.331 10.59 10.131.413.089.975.272 1.117.624.13.32.083.823.04 1.148l-.182 1.089c-.053.321-.26 1.256 1.1.685 1.363-.572 7.347-4.326 10.025-7.406C23.253 14.672 24 12.563 24 10.27"/>
    </svg>
  );
}
