/**
 * AuthGateModal — hard-lock OAuth gate for guest users.
 *
 * Design SSoT: staging/subagent_results/design_pregame_binding_2026-04-24.md
 * Task:        hineko_20260424_1040_ux_phase2_modal_badge
 *
 * Edward 10:09 rule: there is no "continue as guest" escape here — only
 * "回大廳" (close modal, stay in lobby). The caller decides what target
 * page to land on after a successful bind by setting `gateTarget` —
 * `HomePage` useEffect reads `localStorage.pendingGateTarget` on reload
 * and jumps the user there.
 *
 * Email flow (2026-04-26 Edward fix「為什麼要即將開放」):
 *   `/auth/login` (handleLoginOrRegister) is fully shipped — sends to
 *   loginOrRegister(email, password) which auto-creates the account on
 *   first hit and otherwise logs in. Same pattern as handleGoogle:
 *   stash the resulting JWT, set pendingGateTarget, reload. The guest's
 *   ephemeral display name is dropped — the user picks up an isNew=true
 *   account whose displayName is derived from the email local part.
 */

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { Loader, Chrome, Mail, X, Lock, Eye, EyeOff, ChevronDown, ChevronUp } from 'lucide-react';
import { useGameStore } from '../store/gameStore';
import {
  signInWithDiscord,
  signInWithLine,
  hasFirebaseAuthConfigured,
  quickLoginWithGoogle,
  stashLinkedProviderToken,
  loginOrRegister,
} from '../services/auth';
import { getStoredToken } from '../services/socket';

export type AuthGateTarget = 'stats' | 'settings' | 'chat' | 'createRoom' | 'joinRoom';

interface AuthGateModalProps {
  isOpen: boolean;
  onClose: () => void;
  gateTarget: AuthGateTarget;
}

export default function AuthGateModal({ isOpen, onClose, gateTarget }: AuthGateModalProps): JSX.Element | null {
  const { t } = useTranslation();
  const { addToast } = useGameStore();
  const [busy, setBusy] = useState<'google' | 'discord' | 'line' | 'email' | null>(null);
  // Email panel state — collapsed by default, expand on first Email click.
  const [emailPanelOpen, setEmailPanelOpen] = useState(false);
  const [email,    setEmail]    = useState('');
  const [password, setPassword] = useState('');
  const [showPw,   setShowPw]   = useState(false);

  async function handleGoogle(): Promise<void> {
    if (!hasFirebaseAuthConfigured()) {
      addToast(t('settings.upgradeGoogleUnavailable', { defaultValue: '此環境未設定 Google 登入' }), 'error');
      return;
    }
    setBusy('google');
    try {
      const result = await quickLoginWithGoogle();
      if (result && result.token) {
        stashLinkedProviderToken(result.token);
        localStorage.setItem('pendingGateTarget', gateTarget);
        window.location.reload();
        return;
      }
      addToast(t('settings.upgradeFailed', { defaultValue: '綁定失敗，請稍後再試' }), 'error');
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('settings.upgradeFailed', { defaultValue: '綁定失敗' });
      addToast(msg, 'error');
    } finally {
      setBusy(null);
    }
  }

  function handleDiscord(): void {
    const jwt = getStoredToken();
    if (!jwt) {
      addToast(t('settings.upgradeFailed', { defaultValue: '尚未登入' }), 'error');
      return;
    }
    setBusy('discord');
    // Persist the gate target so when the Discord callback redirects back,
    // the reload-triggered useEffect in HomePage knows where to drop the user.
    localStorage.setItem('pendingGateTarget', gateTarget);
    signInWithDiscord('bind', jwt);  // redirects away; no resolve
  }

  function handleLine(): void {
    const jwt = getStoredToken();
    if (!jwt) {
      addToast(t('settings.upgradeFailed', { defaultValue: '尚未登入' }), 'error');
      return;
    }
    setBusy('line');
    localStorage.setItem('pendingGateTarget', gateTarget);
    signInWithLine('bind', jwt);
  }

  // Email button = expand inline panel; no toast.  The actual login/register
  // call lives in handleEmailSubmit so the user has a chance to type creds
  // before we hit the backend.
  function handleEmailToggle(): void {
    setEmailPanelOpen(v => !v);
  }

  async function handleEmailSubmit(): Promise<void> {
    const trimmed = email.trim();
    if (!trimmed || !password) {
      addToast(t('gate.emailMissingFields', { defaultValue: '信箱與密碼必填' }), 'error');
      return;
    }
    setBusy('email');
    try {
      const result = await loginOrRegister(trimmed, password);
      stashLinkedProviderToken(result.token);
      localStorage.setItem('pendingGateTarget', gateTarget);
      window.location.reload();
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('settings.upgradeFailed', { defaultValue: '綁定失敗，請稍後再試' });
      addToast(msg, 'error');
    } finally {
      setBusy(null);
    }
  }

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <motion.div
        key="auth-gate-backdrop"
        className="fixed inset-0 z-[110] bg-black/80 flex items-center justify-center p-4"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
      >
        <motion.div
          key="auth-gate-panel"
          role="dialog"
          aria-modal="true"
          aria-labelledby="auth-gate-title"
          initial={{ y: 16, opacity: 0, scale: 0.96 }}
          animate={{ y: 0, opacity: 1, scale: 1 }}
          exit={{ y: 16, opacity: 0, scale: 0.96 }}
          transition={{ type: 'spring', stiffness: 300, damping: 28 }}
          onClick={(e) => e.stopPropagation()}
          className="bg-zinc-900 border border-zinc-700 rounded-2xl w-full max-w-sm p-6 space-y-4 shadow-2xl"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 id="auth-gate-title" className="text-xl font-black text-white">
                {t('gate.modalTitle', { defaultValue: '登入以繼續' })}
              </h2>
              <p className="text-xs text-zinc-400 mt-1">
                {t('gate.modalHint', { defaultValue: '這個功能需要登入帳號，綁定後戰績自動保存' })}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="text-zinc-500 hover:text-white transition-colors"
              aria-label="回大廳"
            >
              <X size={18} />
            </button>
          </div>

          <div className="space-y-2">
            <button
              type="button"
              onClick={() => { void handleGoogle(); }}
              disabled={busy !== null}
              data-testid="gate-btn-google"
              className="w-full inline-flex items-center justify-center gap-2 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 text-white font-semibold py-2 px-3 rounded-lg border border-zinc-700 transition-colors"
            >
              {busy === 'google' ? (
                <Loader size={16} className="animate-spin" />
              ) : (
                <Chrome size={16} className="text-blue-400" />
              )}
              {t('settings.upgradeWithGoogle', { defaultValue: 'Google 登入' })}
            </button>

            <button
              type="button"
              onClick={handleDiscord}
              disabled={busy !== null}
              data-testid="gate-btn-discord"
              className="w-full inline-flex items-center justify-center gap-2 bg-[#5865F2] hover:bg-[#4752C4] disabled:opacity-50 text-white font-semibold py-2 px-3 rounded-lg transition-colors"
            >
              {busy === 'discord' ? <Loader size={16} className="animate-spin" /> : null}
              {t('settings.upgradeWithDiscord', { defaultValue: 'Discord 登入' })}
            </button>

            <button
              type="button"
              onClick={handleLine}
              disabled={busy !== null}
              data-testid="gate-btn-line"
              className="w-full inline-flex items-center justify-center gap-2 bg-[#00B900] hover:bg-[#009900] disabled:opacity-50 text-white font-semibold py-2 px-3 rounded-lg transition-colors"
            >
              {busy === 'line' ? <Loader size={16} className="animate-spin" /> : null}
              {t('settings.upgradeWithLine', { defaultValue: 'LINE 登入' })}
            </button>

            <button
              type="button"
              onClick={handleEmailToggle}
              disabled={busy !== null && busy !== 'email'}
              data-testid="gate-btn-email"
              aria-expanded={emailPanelOpen}
              className="w-full inline-flex items-center justify-between gap-2 bg-zinc-800/70 hover:bg-zinc-700 disabled:opacity-50 text-zinc-300 font-semibold py-2 px-3 rounded-lg border border-zinc-700 transition-colors"
            >
              <span className="inline-flex items-center gap-2">
                <Mail size={16} />
                {t('gate.emailOption', { defaultValue: 'Email 登入 / 註冊' })}
              </span>
              {emailPanelOpen
                ? <ChevronUp size={14} className="text-zinc-500 flex-shrink-0" />
                : <ChevronDown size={14} className="text-zinc-500 flex-shrink-0" />}
            </button>

            {emailPanelOpen && (
              <div className="space-y-2 px-1 pt-1" data-testid="gate-email-panel">
                <p className="text-[11px] text-zinc-500 leading-relaxed">
                  {t('gate.emailPanelHint', {
                    defaultValue: '不存在的信箱會自動建立帳號；已註冊的信箱輸入密碼即登入。',
                  })}
                </p>
                <div className="relative">
                  <Mail size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
                  <input
                    type="email"
                    autoComplete="email"
                    placeholder="email@example.com"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') void handleEmailSubmit(); }}
                    data-testid="gate-input-email"
                    disabled={busy === 'email'}
                    className="w-full bg-zinc-950 border border-zinc-700 rounded-lg pl-9 pr-3 py-2 text-white placeholder-zinc-500 focus:outline-none focus:border-white text-sm disabled:opacity-50"
                  />
                </div>
                <div className="relative">
                  <Lock size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
                  <input
                    type={showPw ? 'text' : 'password'}
                    autoComplete="current-password"
                    placeholder={t('gate.emailPasswordPlaceholder', { defaultValue: '密碼（8 字以上，含英文字母與數字）' })}
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') void handleEmailSubmit(); }}
                    data-testid="gate-input-password"
                    disabled={busy === 'email'}
                    className="w-full bg-zinc-950 border border-zinc-700 rounded-lg pl-9 pr-10 py-2 text-white placeholder-zinc-500 focus:outline-none focus:border-white text-sm disabled:opacity-50"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPw(v => !v)}
                    aria-label={showPw ? '隱藏密碼' : '顯示密碼'}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
                  >
                    {showPw ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => { void handleEmailSubmit(); }}
                  disabled={busy !== null}
                  data-testid="gate-btn-email-submit"
                  className="w-full inline-flex items-center justify-center gap-2 bg-zinc-200 hover:bg-white disabled:opacity-50 text-black font-bold py-2 px-3 rounded-lg text-sm transition-colors"
                >
                  {busy === 'email' && <Loader size={14} className="animate-spin" />}
                  {t('gate.emailSubmit', { defaultValue: 'Email 登入 / 註冊' })}
                </button>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            <div className="flex-1 h-px bg-zinc-800" />
            <span className="text-[10px] text-zinc-600 uppercase tracking-wider">
              {t('gate.or', { defaultValue: '或' })}
            </span>
            <div className="flex-1 h-px bg-zinc-800" />
          </div>

          <button
            type="button"
            onClick={onClose}
            data-testid="gate-btn-back-to-lobby"
            className="w-full inline-flex items-center justify-center gap-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm py-2 px-3 rounded-lg border border-zinc-700 transition-colors"
          >
            {t('gate.backToLobby', { defaultValue: '回大廳' })}
          </button>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
