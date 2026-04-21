import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft,
  User,
  Link2,
  History,
  Users,
  Swords,
  LogOut,
  Chrome,
  Pencil,
  Loader,
} from 'lucide-react';
import { useGameStore } from '../store/gameStore';
import {
  logout,
  renameGuest,
  signInWithGoogle,
  signInWithDiscord,
  signInWithLine,
  hasFirebaseAuthConfigured,
} from '../services/auth';

type SectionId = 'basic' | 'binding' | 'history' | 'watchlist' | 'pairStats' | 'logout';

interface SectionConfig {
  id: SectionId;
  labelKey: string;
  icon: typeof User;
}

const SECTIONS: SectionConfig[] = [
  { id: 'basic',      labelKey: 'settings.basic',      icon: User },
  { id: 'binding',    labelKey: 'settings.binding',    icon: Link2 },
  { id: 'history',    labelKey: 'settings.history',    icon: History },
  { id: 'watchlist',  labelKey: 'settings.watchlist',  icon: Users },
  { id: 'pairStats',  labelKey: 'settings.pairStats',  icon: Swords },
  { id: 'logout',     labelKey: 'settings.logout',     icon: LogOut },
];

/**
 * #84 訪客判定：Player 型別現已帶 `provider` 欄位（socket.ts auth:success 從
 * session.user.provider 塞進來），所以判斷「是否為訪客」直接看 provider 即可。
 *
 * Regression note: 初版用 name 形如 Guest_NNN 或 avatar 空值作 heuristic，但
 * Discord / Line 綁定的正式使用者有可能沒有 photoURL，會被誤判為訪客 → 綁定後
 * 仍顯示訪客 UI。改用 provider 後，此誤判被修掉。
 *
 * Fallback：若 provider 未定義（legacy state、極早期 bot、或 server 還沒補完
 * 舊 socket 重連事件），就只認 name 形如 Guest_NNN 才當訪客；沒頭像不再視為
 * 訪客指標。
 */
function isGuestPlayer(player: { name?: string; provider?: string } | null | undefined): boolean {
  if (!player) return true;
  if (player.provider) return player.provider === 'guest';
  // Legacy fallback — provider 缺值時只認 Guest_NNN 預設名
  return /^Guest_\d{3,}$/i.test(player.name ?? '');
}

export default function ProfileSettingsPage(): JSX.Element {
  const { t } = useTranslation();
  const { setGameState, setCurrentPlayer, currentPlayer, addToast } = useGameStore();
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  // 訪客改名 state
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState(currentPlayer?.name ?? '');
  const [submittingRename, setSubmittingRename] = useState(false);
  const [renameError, setRenameError] = useState('');

  // 訪客轉正式註冊 state
  const [upgrading, setUpgrading] = useState(false);

  const isGuest = isGuestPlayer(currentPlayer);

  const handleLogoutConfirmed = async (): Promise<void> => {
    setLoggingOut(true);
    try {
      await logout();
      // Clear local storage guest markers + player name so cold start shows login
      try {
        localStorage.removeItem('avalon_player_name');
        localStorage.removeItem('avalon_room');
      } catch {
        // localStorage unavailable (SSR / private mode) — non-fatal
      }
      setCurrentPlayer(null);
      setGameState('home');
    } catch {
      addToast(t('auth.logoutFailed'), 'error');
    } finally {
      setLoggingOut(false);
      setShowLogoutConfirm(false);
    }
  };

  const handleRenameSubmit = async (): Promise<void> => {
    const trimmed = newName.trim();
    if (trimmed.length < 2 || trimmed.length > 20) {
      setRenameError(t('guest.renameLengthError'));
      return;
    }
    if (/^guest_/i.test(trimmed)) {
      setRenameError(t('guest.renameReservedPrefix'));
      return;
    }
    setSubmittingRename(true);
    setRenameError('');
    try {
      const result = await renameGuest(trimmed);
      if (!result.ok) {
        // Map server error codes to i18n keys; fall back to raw error text.
        let message = result.error ?? t('guest.renameFailed');
        if (result.code === 'RESERVED_PREFIX') message = t('guest.renameReservedPrefix');
        // 404 means the /auth/guest/rename endpoint isn't available on the
        // deployed server yet (commit #84 shipped the client before the server
        // build/redeploy caught up). Surface a friendlier message instead of
        // the raw "rename failed: 404" so users don't think their input is bad.
        else if (/rename failed: 404/i.test(message)) {
          message = t('guest.renameUnavailable', {
            defaultValue: '伺服器尚未支援改名，請稍候再試',
          });
        }
        setRenameError(message);
        return;
      }
      // 成功 → 更新 currentPlayer.name（UI 端先更新，之後 Phase 2 server 會
      // broadcast canonical display name）
      if (currentPlayer) {
        setCurrentPlayer({ ...currentPlayer, name: trimmed });
      }
      addToast(t('guest.renameSuccess'), 'success');
      setRenaming(false);
    } catch (err) {
      setRenameError(err instanceof Error ? err.message : t('guest.renameFailed'));
    } finally {
      setSubmittingRename(false);
    }
  };

  // 訪客轉正式帳號 — 觸發社群登入 flow，server 端 callback 時會把 guest_session
  // cookie 的 uid 合併到新帳號（Phase 2 會在 /auth/guest/upgrade 做完整 merge）。
  const handleUpgrade = async (
    provider: 'google' | 'discord' | 'line',
  ): Promise<void> => {
    setUpgrading(true);
    try {
      if (provider === 'google') {
        if (!hasFirebaseAuthConfigured()) {
          addToast(t('settings.upgradeGoogleUnavailable'), 'error');
          return;
        }
        await signInWithGoogle();
        // onAuthStateChange in App.tsx will finish wiring socket + merging
      } else if (provider === 'discord') {
        signInWithDiscord();
      } else if (provider === 'line') {
        signInWithLine();
      }
    } catch (err) {
      addToast(err instanceof Error ? err.message : t('settings.upgradeFailed'), 'error');
    } finally {
      setUpgrading(false);
    }
  };

  return (
    <div className="min-h-screen bg-black p-4 pb-24">
      <div className="max-w-3xl mx-auto">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <motion.button
            whileHover={{ scale: 1.1 }}
            whileTap={{ scale: 0.9 }}
            onClick={() => setGameState('home')}
            className="p-2 bg-zinc-900/70 rounded-lg border border-zinc-700 hover:border-white text-zinc-300 hover:text-white transition-colors"
            aria-label={t('nav.back')}
          >
            <ArrowLeft size={20} />
          </motion.button>
          <h1 className="text-2xl font-black text-white">{t('nav.profileSettings')}</h1>
        </div>

        {/* Sections */}
        <div className="space-y-4">
          {SECTIONS.map(section => {
            const Icon = section.icon;
            const isLogout = section.id === 'logout';
            return (
              <section
                key={section.id}
                id={`settings-${section.id}`}
                className={`bg-zinc-900/60 border rounded-xl p-6 ${
                  isLogout ? 'border-red-900/60' : 'border-zinc-700'
                }`}
              >
                <div className="flex items-center gap-3 mb-3">
                  <Icon size={18} className={isLogout ? 'text-red-400' : 'text-white'} />
                  <h2 className={`text-lg font-bold ${isLogout ? 'text-red-300' : 'text-white'}`}>
                    {t(section.labelKey)}
                  </h2>
                </div>

                {section.id === 'basic' && (
                  <div className="text-sm text-zinc-400 space-y-3">
                    <p>
                      <span className="text-zinc-500">{t('settings.currentName')}: </span>
                      <span className="text-white font-semibold">
                        {currentPlayer?.name ?? t('auth.guest')}
                      </span>
                    </p>
                    {isGuest ? (
                      renaming ? (
                        <div className="space-y-2">
                          <input
                            type="text"
                            value={newName}
                            onChange={e => {
                              setNewName(e.target.value);
                              if (renameError) setRenameError('');
                            }}
                            maxLength={20}
                            placeholder={t('guest.renamePlaceholder')}
                            className="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-white placeholder-zinc-500 focus:outline-none focus:border-white"
                          />
                          {renameError && (
                            <p className="text-xs text-red-400">{renameError}</p>
                          )}
                          <p className="text-[11px] text-zinc-500">{t('guest.renameLimit')}</p>
                          <div className="flex gap-2">
                            <button
                              onClick={handleRenameSubmit}
                              disabled={submittingRename}
                              className="inline-flex items-center gap-2 bg-white hover:bg-zinc-200 disabled:opacity-50 text-black font-semibold py-1.5 px-3 rounded-lg text-sm transition-colors"
                            >
                              {submittingRename && <Loader size={14} className="animate-spin" />}
                              {t('action.save')}
                            </button>
                            <button
                              onClick={() => {
                                setRenaming(false);
                                setNewName(currentPlayer?.name ?? '');
                                setRenameError('');
                              }}
                              disabled={submittingRename}
                              className="inline-flex items-center gap-2 bg-zinc-800 hover:bg-zinc-700 text-white font-semibold py-1.5 px-3 rounded-lg text-sm transition-colors border border-zinc-700 disabled:opacity-50"
                            >
                              {t('action.cancel')}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          onClick={() => {
                            setRenaming(true);
                            setNewName(currentPlayer?.name ?? '');
                          }}
                          className="inline-flex items-center gap-2 bg-zinc-800 hover:bg-zinc-700 text-white font-semibold py-1.5 px-3 rounded-lg text-sm transition-colors border border-zinc-700"
                        >
                          <Pencil size={14} />
                          {t('guest.rename')}
                        </button>
                      )
                    ) : (
                      <p className="text-zinc-500 text-xs">{t('settings.comingSoon')}</p>
                    )}
                  </div>
                )}

                {section.id === 'binding' && (
                  <div className="text-sm space-y-3">
                    <p className="text-zinc-500">{t('settings.upgradeGuest')}</p>
                    {isGuest ? (
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                        <button
                          onClick={() => handleUpgrade('google')}
                          disabled={upgrading || !hasFirebaseAuthConfigured()}
                          className="inline-flex items-center justify-center gap-2 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 text-white font-semibold py-2 px-3 rounded-lg border border-zinc-700 transition-colors"
                          title={hasFirebaseAuthConfigured() ? '' : t('settings.upgradeGoogleUnavailable')}
                        >
                          <Chrome size={16} className="text-blue-400" />
                          {t('settings.upgradeWithGoogle')}
                        </button>
                        <button
                          onClick={() => handleUpgrade('discord')}
                          disabled={upgrading}
                          className="inline-flex items-center justify-center gap-2 bg-[#5865F2] hover:bg-[#4752C4] disabled:opacity-50 text-white font-semibold py-2 px-3 rounded-lg transition-colors"
                        >
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                            <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057c.002.022.015.043.032.055a19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/>
                          </svg>
                          {t('settings.upgradeWithDiscord')}
                        </button>
                        <button
                          onClick={() => handleUpgrade('line')}
                          disabled={upgrading}
                          className="inline-flex items-center justify-center gap-2 bg-[#00B900] hover:bg-[#009900] disabled:opacity-50 text-white font-semibold py-2 px-3 rounded-lg transition-colors"
                        >
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                            <path d="M19.365 9.89c.50 0 .907.41.907.91s-.406.91-.907.91h-2.25v1.356h2.25c.5 0 .907.408.907.909s-.406.91-.907.91H16.21a.907.907 0 0 1-.907-.91V9.89c0-.5.407-.91.907-.91h3.155m-9.503 4.995a.907.907 0 0 1-.877.91.9.9 0 0 1-.715-.35l-2.56-3.482V14.8a.907.907 0 1 1-1.815 0V9.89a.907.907 0 0 1 1.59-.602l2.562 3.482V9.89a.907.907 0 0 1 1.815 0v4.996M7.077 9.89a.907.907 0 0 1 0 1.815h-2.25v4.096a.907.907 0 1 1-1.814 0V9.89c0-.5.406-.91.907-.91h3.157M24 10.27C24 4.595 18.627 0 12 0S0 4.594 0 10.27c0 5.076 4.504 9.331 10.59 10.131.413.089.975.272 1.117.624.13.32.083.823.04 1.148l-.182 1.089c-.053.321-.26 1.256 1.1.685 1.363-.572 7.347-4.326 10.025-7.406C23.253 14.672 24 12.563 24 10.27"/>
                          </svg>
                          {t('settings.upgradeWithLine')}
                        </button>
                      </div>
                    ) : (
                      <p className="text-zinc-500 text-xs">{t('settings.alreadyRegistered')}</p>
                    )}
                    <p className="text-xs text-zinc-600">{t('settings.upgradeHint')}</p>
                  </div>
                )}

                {(section.id === 'history' || section.id === 'watchlist' || section.id === 'pairStats') && (
                  <p className="text-sm text-zinc-500">{t('settings.comingSoon')}</p>
                )}

                {isLogout && (
                  <div className="space-y-3">
                    <p className="text-sm text-zinc-400">{t('settings.logoutHint')}</p>
                    <motion.button
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                      onClick={() => setShowLogoutConfirm(true)}
                      className="inline-flex items-center gap-2 bg-red-900/70 hover:bg-red-800 border border-red-700 text-red-100 font-semibold py-2 px-4 rounded-lg transition-colors"
                    >
                      <LogOut size={16} />
                      {t('auth.logout')}
                    </motion.button>
                  </div>
                )}
              </section>
            );
          })}
        </div>
      </div>

      {/* Logout confirm modal */}
      <AnimatePresence>
        {showLogoutConfirm && (
          <motion.div
            key="logout-confirm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4"
            onClick={() => !loggingOut && setShowLogoutConfirm(false)}
          >
            <motion.div
              initial={{ scale: 0.9, y: 12 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.9, y: 12 }}
              className="bg-zinc-900 border border-zinc-700 rounded-2xl p-6 w-full max-w-sm space-y-4"
              onClick={e => e.stopPropagation()}
            >
              <h3 className="text-lg font-bold text-white">{t('settings.logoutConfirm')}</h3>
              <p className="text-sm text-zinc-400">{t('settings.logoutConfirmBody')}</p>
              <div className="flex gap-3">
                <button
                  onClick={handleLogoutConfirmed}
                  disabled={loggingOut}
                  className="flex-1 bg-red-900/70 hover:bg-red-800 border border-red-700 text-red-100 font-bold py-2 px-4 rounded-lg transition-colors disabled:opacity-50"
                >
                  {t('auth.logout')}
                </button>
                <button
                  onClick={() => setShowLogoutConfirm(false)}
                  disabled={loggingOut}
                  className="flex-1 bg-zinc-800 hover:bg-zinc-700 text-white font-bold py-2 px-4 rounded-lg transition-colors border border-zinc-700 disabled:opacity-50"
                >
                  {t('action.cancel')}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
