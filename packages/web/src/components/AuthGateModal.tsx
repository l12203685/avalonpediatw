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
 * Email flow is stubbed: Phase 1 shipped the `primaryEmail` column but
 * not the OTP / magic-link endpoint, so clicking Email surfaces a toast
 * rather than silently doing nothing. When the endpoint lands, wire the
 * `handleEmail` branch to the real call and drop the toast.
 */

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { Loader, Chrome, Mail, X } from 'lucide-react';
import { useGameStore } from '../store/gameStore';
import {
  signInWithDiscord,
  signInWithLine,
  hasFirebaseAuthConfigured,
  quickLoginWithGoogle,
  stashLinkedProviderToken,
} from '../services/auth';
import { getStoredToken } from '../services/socket';

export type AuthGateTarget = 'stats' | 'settings' | 'chat';

interface AuthGateModalProps {
  isOpen: boolean;
  onClose: () => void;
  gateTarget: AuthGateTarget;
}

export default function AuthGateModal({ isOpen, onClose, gateTarget }: AuthGateModalProps): JSX.Element | null {
  const { t } = useTranslation();
  const { addToast } = useGameStore();
  const [busy, setBusy] = useState<'google' | 'discord' | 'line' | 'email' | null>(null);

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

  function handleEmail(): void {
    // Phase 1 backend has `primaryEmail` but the OTP/magic-link endpoint
    // isn't wired yet — surface a toast so it's clear this is intentional.
    addToast(t('gate.emailComingSoon', { defaultValue: 'Email 綁定即將開放，請先用 Google / Discord / LINE' }), 'info');
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
              onClick={handleEmail}
              disabled={busy !== null}
              data-testid="gate-btn-email"
              className="w-full inline-flex items-center justify-center gap-2 bg-zinc-800/70 hover:bg-zinc-700 disabled:opacity-50 text-zinc-300 font-semibold py-2 px-3 rounded-lg border border-zinc-700 transition-colors"
            >
              <Mail size={16} />
              {t('gate.emailOption', { defaultValue: 'Email (即將開放)' })}
            </button>
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
