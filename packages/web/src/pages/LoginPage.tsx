import { useState } from 'react';
import { Chrome, Loader, UserCircle, Mail, Eye, EyeOff } from 'lucide-react';
import {
  signInWithGoogle,
  signInWithEmail,
  signUpWithEmail,
  signInWithDiscord,
  signInWithLine,
  extractOAuthErrorFromUrl,
} from '../services/auth';
import { useGameStore } from '../store/gameStore';
import { initializeSocket } from '../services/socket';
import { v4 as uuidv4 } from 'uuid';

type Tab = 'social' | 'email' | 'guest';

export default function LoginPage(): JSX.Element {
  const [loading, setLoading] = useState(false);
  const [error, setError]   = useState(() => extractOAuthErrorFromUrl() ?? '');
  const [tab, setTab]       = useState<Tab>('social');

  // Email 表單
  const [emailMode, setEmailMode]     = useState<'login' | 'signup'>('login');
  const [email, setEmail]             = useState('');
  const [password, setPassword]       = useState('');
  const [displayName, setDisplayName] = useState('');
  const [showPw, setShowPw]           = useState(false);

  // 訪客表單
  const [guestName, setGuestName]   = useState('');
  const [showGuest, setShowGuest]   = useState(false);

  const { setGameState } = useGameStore();

  const go = async (fn: () => Promise<void>) => {
    try { setLoading(true); setError(''); await fn(); }
    catch (err) { setError(err instanceof Error ? err.message : '登入失敗'); }
    finally { setLoading(false); }
  };

  // ── Google ──────────────────────────────────────────────────
  const handleGoogle = () => go(async () => {
    const user  = await signInWithGoogle();
    const token = await user.getIdToken();
    await initializeSocket(token);
    setGameState('home');
  });

  // ── Discord / Line（重導向，不需要 async 處理）────────────
  const handleDiscord = () => { setLoading(true); signInWithDiscord(); };
  const handleLine    = () => { setLoading(true); signInWithLine(); };

  // ── Email ──────────────────────────────────────────────────
  const handleEmail = () => go(async () => {
    if (!email || !password) throw new Error('請填寫 Email 和密碼');
    let user;
    if (emailMode === 'signup') {
      if (!displayName.trim()) throw new Error('請填寫顯示名稱');
      if (password.length < 6) throw new Error('密碼至少需要 6 個字元');
      user = await signUpWithEmail(email, password, displayName.trim());
    } else {
      user = await signInWithEmail(email, password);
    }
    const token = await user.getIdToken();
    await initializeSocket(token);
    setGameState('home');
  });

  // ── Guest ──────────────────────────────────────────────────
  const handleGuest = () => go(async () => {
    const name = guestName.trim();
    if (!name) throw new Error('請輸入你的名字');
    if (name.length < 2) throw new Error('名字至少需要 2 個字元');
    const token = JSON.stringify({ uid: uuidv4(), displayName: name });
    await initializeSocket(token);
    setGameState('home');
  });

  // ── 小元件 ─────────────────────────────────────────────────
  const TabBtn = ({ id, label }: { id: Tab; label: string }) => (
    <button
      onClick={() => setTab(id)}
      className={`flex-1 py-2 text-sm font-semibold rounded-lg transition-all ${
        tab === id ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="flex items-center justify-center min-h-screen p-4">
      <div className="w-full max-w-md space-y-6">

        {/* Header */}
        <div className="text-center space-y-2">
          <h1 className="text-6xl font-black bg-gradient-to-r from-blue-400 via-amber-400 to-yellow-300 bg-clip-text text-transparent">
            AVALON
          </h1>
          <p className="text-xl text-gray-300">阿瓦隆：抵抗組織 (Avalon: The Resistance)</p>
          <p className="text-sm text-gray-500">5–10 人 (players) • 即時連線對戰 (Real-time Online)</p>
        </div>

        {/* Error */}
        {error && (
          <div className="bg-red-900/50 border border-red-600 rounded-lg p-3 text-red-200 text-sm">
            {error}
          </div>
        )}

        {/* Tabs */}
        <div className="flex gap-1 bg-avalon-card/40 p-1 rounded-xl">
          <TabBtn id="social" label="社群登入 (Social Login)" />
          <TabBtn id="email"  label="Email 登入 (Email Login)" />
          <TabBtn id="guest"  label="訪客 (Guest)" />
        </div>

        {/* ── 社群登入 ── */}
        {tab === 'social' && (
          <div className="space-y-3">
            <button
              onClick={handleGoogle}
              disabled={loading}
              className="w-full bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-white font-semibold py-3 px-6 rounded-xl transition-all flex items-center justify-center gap-3 border border-gray-600"
            >
              <Chrome size={20} className="text-blue-400" />
              Google 登入
            </button>

            <button
              onClick={handleDiscord}
              disabled={loading}
              className="w-full bg-[#5865F2] hover:bg-[#4752C4] disabled:opacity-50 text-white font-semibold py-3 px-6 rounded-xl transition-all flex items-center justify-center gap-3"
            >
              {/* Discord icon */}
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057c.002.022.015.043.032.055a19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/>
              </svg>
              Discord 登入
            </button>

            <button
              onClick={handleLine}
              disabled={loading}
              className="w-full bg-[#00B900] hover:bg-[#009900] disabled:opacity-50 text-white font-semibold py-3 px-6 rounded-xl transition-all flex items-center justify-center gap-3"
            >
              {/* Line icon */}
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <path d="M19.365 9.89c.50 0 .907.41.907.91s-.406.91-.907.91h-2.25v1.356h2.25c.5 0 .907.408.907.909s-.406.91-.907.91H16.21a.907.907 0 0 1-.907-.91V9.89c0-.5.407-.91.907-.91h3.155m-9.503 4.995a.907.907 0 0 1-.877.91.9.9 0 0 1-.715-.35l-2.56-3.482V14.8a.907.907 0 1 1-1.815 0V9.89a.907.907 0 0 1 1.59-.602l2.562 3.482V9.89a.907.907 0 0 1 1.815 0v4.996M7.077 9.89a.907.907 0 0 1 0 1.815h-2.25v4.096a.907.907 0 1 1-1.814 0V9.89c0-.5.406-.91.907-.91h3.157M24 10.27C24 4.595 18.627 0 12 0S0 4.594 0 10.27c0 5.076 4.504 9.331 10.59 10.131.413.089.975.272 1.117.624.13.32.083.823.04 1.148l-.182 1.089c-.053.321-.26 1.256 1.1.685 1.363-.572 7.347-4.326 10.025-7.406C23.253 14.672 24 12.563 24 10.27"/>
              </svg>
              Line 登入
            </button>

            {loading && (
              <div className="flex justify-center pt-2">
                <Loader size={20} className="animate-spin text-gray-400" />
              </div>
            )}
          </div>
        )}

        {/* ── Email 登入 ── */}
        {tab === 'email' && (
          <div className="space-y-3 bg-avalon-card/40 p-5 rounded-xl border border-gray-700">
            {/* 切換登入 / 註冊 */}
            <div className="flex gap-2 text-sm">
              <button
                onClick={() => setEmailMode('login')}
                className={`flex-1 py-1.5 rounded-lg font-semibold transition-all ${emailMode === 'login' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'}`}
              >登入</button>
              <button
                onClick={() => setEmailMode('signup')}
                className={`flex-1 py-1.5 rounded-lg font-semibold transition-all ${emailMode === 'signup' ? 'bg-amber-600 text-white' : 'text-gray-400 hover:text-white'}`}
              >註冊</button>
            </div>

            {emailMode === 'signup' && (
              <input
                type="text"
                placeholder="顯示名稱"
                value={displayName}
                onChange={e => setDisplayName(e.target.value)}
                className="w-full bg-avalon-dark border border-gray-600 rounded-lg px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
              />
            )}

            <input
              type="email"
              placeholder="電子郵件"
              value={email}
              onChange={e => setEmail(e.target.value)}
              className="w-full bg-avalon-dark border border-gray-600 rounded-lg px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
            />

            <div className="relative">
              <input
                type={showPw ? 'text' : 'password'}
                placeholder="密碼"
                value={password}
                onChange={e => setPassword(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleEmail()}
                className="w-full bg-avalon-dark border border-gray-600 rounded-lg px-4 py-2.5 pr-11 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
              />
              <button
                type="button"
                onClick={() => setShowPw(v => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300"
              >
                {showPw ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>

            <button
              onClick={handleEmail}
              disabled={loading}
              className="w-full bg-gradient-to-r from-blue-600 to-amber-600 hover:from-blue-700 hover:to-amber-700 disabled:opacity-50 text-white font-bold py-2.5 rounded-xl transition-all flex items-center justify-center gap-2"
            >
              {loading ? <Loader size={18} className="animate-spin" /> : <Mail size={18} />}
              {emailMode === 'signup' ? '建立帳號 (Sign Up)' : '登入 (Sign In)'}
            </button>
          </div>
        )}

        {/* ── 訪客登入 ── */}
        {tab === 'guest' && (
          <div className="bg-avalon-card/40 border-2 border-blue-500/40 rounded-xl p-5 space-y-4">
            <div className="flex items-center gap-2">
              <UserCircle size={20} className="text-blue-400" />
              <p className="font-bold text-white text-sm">訪客模式 (Guest Mode — identity resets on refresh)</p>
            </div>
            {showGuest ? (
              <>
                <input
                  type="text"
                  placeholder="輸入你的名字（2–12 字）"
                  value={guestName}
                  maxLength={12}
                  onChange={e => setGuestName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleGuest()}
                  className="w-full bg-avalon-dark border border-gray-600 rounded-lg px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
                  autoFocus
                />
                <button
                  onClick={handleGuest}
                  disabled={loading || guestName.trim().length < 2}
                  className="w-full bg-gradient-to-r from-blue-600 to-amber-600 hover:from-blue-700 hover:to-amber-700 disabled:opacity-50 text-white font-bold py-2.5 rounded-xl transition-all flex items-center justify-center gap-2"
                >
                  {loading ? <Loader size={18} className="animate-spin" /> : null}
                  進入遊戲
                </button>
              </>
            ) : (
              <button
                onClick={() => setShowGuest(true)}
                className="w-full bg-gradient-to-r from-blue-600 to-amber-600 hover:from-blue-700 hover:to-amber-700 text-white font-bold py-2.5 rounded-xl transition-all"
              >
                訪客進入（不需帳號）(Guest — No account needed)
              </button>
            )}
          </div>
        )}

      </div>
    </div>
  );
}
