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
} from 'lucide-react';
import { useGameStore } from '../store/gameStore';
import { logout } from '../services/auth';

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

export default function ProfileSettingsPage(): JSX.Element {
  const { t } = useTranslation();
  const { setGameState, setCurrentPlayer, currentPlayer, addToast } = useGameStore();
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

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
                  <div className="text-sm text-zinc-400">
                    <p>
                      <span className="text-zinc-500">{t('settings.currentName')}: </span>
                      <span className="text-white font-semibold">
                        {currentPlayer?.name ?? t('auth.guest')}
                      </span>
                    </p>
                    <p className="mt-2 text-zinc-500 text-xs">{t('settings.comingSoon')}</p>
                  </div>
                )}

                {section.id === 'binding' && (
                  <div className="text-sm text-zinc-500">
                    <p>{t('settings.upgradeGuest')}</p>
                    <p className="mt-2 text-xs">{t('settings.comingSoon')}</p>
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
