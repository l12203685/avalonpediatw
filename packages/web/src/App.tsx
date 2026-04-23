import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { useGameStore } from './store/gameStore';
import {
  initializeAuth,
  onAuthStateChange,
  extractOAuthTokenFromUrl,
  resumeGuestFromCookie,
  stashLinkedProviderToken,
  consumeLinkedProviderToken,
} from './services/auth';
import { initializeSocket, disconnectSocket, getStoredToken } from './services/socket';
import { startVersionCheck } from './services/versionCheck';
import HomePage from './pages/HomePage';
import GamePage from './pages/GamePage';
import LobbyPage from './pages/LobbyPage';
import LoginPage from './pages/LoginPage';
import ForgotPasswordPage from './pages/ForgotPasswordPage';
import ResetPasswordPage from './pages/ResetPasswordPage';
import WikiPage from './pages/WikiPage';
import LeaderboardPage from './pages/LeaderboardPage';
import ProfilePage from './pages/ProfilePage';
import FriendsPage from './pages/FriendsPage';
import AiStatsPage from './pages/AiStatsPage';
import AnalysisPage from './pages/AnalysisPage';
import AnalyticsPage from './pages/AnalyticsPage';
import SettingsPage from './pages/SettingsPage';
import PersonalStatsPage from './pages/PersonalStatsPage';
import ClaimsNewPage from './pages/ClaimsNewPage';
import AdminClaimsPage from './pages/AdminClaimsPage';
import AdminAdminsPage from './pages/AdminAdminsPage';
import AdminEloPage from './pages/AdminEloPage';
import HelpPage from './pages/HelpPage';
import ToastContainer from './components/ToastContainer';
import FloatingControls from './components/FloatingControls';
import { submitError } from './services/api';

function App(): JSX.Element {
  const { t } = useTranslation();
  const { gameState, currentPlayer, socketStatus } = useGameStore();
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  // Version check poller — detects a fresh server deploy and prompts the
  // user to refresh so they don't keep running against a stale JS bundle
  // (root cause of the intermittent xhr/ws errors Edward reported 2026-04-23).
  // Safe to start before login: the endpoint is unauthenticated.
  useEffect(() => {
    startVersionCheck((_current, _latest) => {
      const { addToast } = useGameStore.getState();
      addToast(t('connection.newVersionAvailable'), 'info');
    });
    // No teardown — this is a singleton and polls once a minute; a hot
    // reload replaces the module rather than leaking timers.
  }, [t]);

  // Global error capture — auto-report JS errors to server
  useEffect(() => {
    const handleError = (event: ErrorEvent): void => {
      const { gameState: gs } = useGameStore.getState();
      submitError({ message: event.message, stack: event.error?.stack, gameState: gs });
    };
    const handleUnhandled = (event: PromiseRejectionEvent): void => {
      const { gameState: gs } = useGameStore.getState();
      const msg = event.reason instanceof Error ? event.reason.message : String(event.reason);
      const stack = event.reason instanceof Error ? event.reason.stack : undefined;
      submitError({ message: `Unhandled: ${msg}`, stack, gameState: gs });
    };
    window.addEventListener('error', handleError);
    window.addEventListener('unhandledrejection', handleUnhandled);
    return () => {
      window.removeEventListener('error', handleError);
      window.removeEventListener('unhandledrejection', handleUnhandled);
    };
  }, []);

  useEffect(() => {
    // Phase B 新登入架構 (2026-04-23)：email 寄出的重設密碼連結格式為
    // `${FRONTEND_URL}/reset-password?token=xxxx`。SPA 本身沒 router，我們靠
    // window.location.pathname 判斷是否從該連結進入，是就把 gameState 切到
    // resetPassword；ResetPasswordPage 會從 search params 讀 token。Landing
    // 完成後把 pathname 清成 `/` 避免 reload 把 user 又打回同頁。
    if (window.location.pathname === '/reset-password') {
      const { setGameState } = useGameStore.getState();
      setGameState('resetPassword');
      // 保留 search（token）讓 ResetPasswordPage 讀，但把 path 清掉
      // ResetPasswordPage mount 後會自己 replaceState 清 query。
      window.history.replaceState({}, '', '/' + window.location.search + window.location.hash);
    }

    // 處理 Discord / Line OAuth callback（URL 帶有 ?oauth_token=...）
    //
    // 2026-04-23 bind-name-sync (重建 orphan 01785fa8)：若 URL 帶 `?link_merged=1`
    // 代表訪客剛剛完成 Discord / Line 綁定，server 已經幫我們合併戰績並發了新的
    // 真帳號 JWT。直接接上 socket 有時會被 Firebase `onAuthStateChange` 或
    // guest_session cookie 搶先 race — 所以改走 stash → reload → 下一輪 mount
    // consume 的硬 reload 流程，確保所有 React state / zustand store / 舊 socket
    // 都重置，不會殘留 provider='guest'。
    const oauthResult = extractOAuthTokenFromUrl();
    if (oauthResult) {
      if (oauthResult.linkMerged) {
        // 訪客綁定 flow：stash 新 JWT → hard reload → 下一輪 mount consume 起 socket
        stashLinkedProviderToken(oauthResult.token);
        window.location.reload();
        return;
      }
      const { setGameState } = useGameStore.getState();
      initializeSocket(oauthResult.token)
        .then(() => { setGameState('home'); setIsLoading(false); })
        .catch(() => { setIsLoading(false); });
      return;
    }

    // Bind-name-sync reload 後，localStorage 裡會有 stash 的真帳號 JWT — 優先用它
    // 起 socket，繞過 guest cookie 續簽，provider='discord' / 'line' 乾淨寫入。
    const stashed = consumeLinkedProviderToken();
    if (stashed) {
      const { setGameState } = useGameStore.getState();
      initializeSocket(stashed)
        .then(() => { setGameState('home'); setIsLoading(false); })
        .catch(() => { setIsLoading(false); });
      return;
    }

    // Initialize Firebase Auth
    initializeAuth();

    // #84 訪客 cookie 綁定：冷啟動若發現還沒有活 socket，且 Firebase 也沒 signed-in
    // user（下面的 onAuthStateChange 會先觸發 null），就先試 `guest_session` cookie
    // 續簽；成功就直接起 socket，省掉 LoginPage 再走一次「訪客進入」。失敗就 fall
    // through 到 LoginPage，使用者自己選登入方式。
    let guestResumeCancelled = false;
    const tryGuestResume = async (): Promise<boolean> => {
      if (getStoredToken()) return true; // 已經有 token（另一條路接上了）
      try {
        const resumed = await resumeGuestFromCookie();
        if (!resumed || guestResumeCancelled) return false;
        await initializeSocket(resumed.token);
        return true;
      } catch {
        return false;
      }
    };

    // Listen to auth state changes — re-init socket on page refresh.
    // Firebase's listener fires `null` for every unauthenticated session,
    // including guest sessions that have already established a socket via
    // LoginPage.handleGuest. Do NOT disconnect in that case, or the guest
    // loses their live socket (+ stored token) and every subsequent action
    // (create-room / fetch friends) fails with "Socket not initialized".
    const unsubscribe = onAuthStateChange(async (userWithToken) => {
      if (userWithToken) {
        setIsAuthenticated(true);
        try {
          await initializeSocket(userWithToken.token);
        } catch {
          // Socket init failed — user will see connection banner
        }
      } else if (!getStoredToken()) {
        // 沒 Firebase user + 沒 stored token → 先嘗試 guest cookie 續簽；不成再
        // 進入登出狀態讓 LoginPage 出現。
        const resumed = await tryGuestResume();
        if (!resumed) {
          setIsAuthenticated(false);
          disconnectSocket();
        }
      }
      setIsLoading(false);
    });

    return () => {
      guestResumeCancelled = true;
      unsubscribe();
    };
  }, []);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gradient-to-br from-avalon-dark to-avalon-card">
        <div className="text-white text-center">
          <div className="inline-block animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-400 mb-4"></div>
          <p>{t('app.loading')}</p>
        </div>
      </div>
    );
  }

  const showConnectionBanner = currentPlayer && socketStatus !== 'connected';

  return (
    <div className="min-h-screen bg-gradient-to-br from-avalon-dark to-avalon-card">
      {/* Connection status banner */}
      <AnimatePresence>
        {showConnectionBanner && (
          <motion.div
            key="conn-banner"
            initial={{ y: -48, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -48, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            className={`fixed top-0 left-0 right-0 z-[100] flex items-center justify-center gap-2 px-4 py-2 text-sm font-semibold ${
              socketStatus === 'reconnecting'
                ? 'bg-yellow-900/90 border-b border-yellow-700 text-yellow-200'
                : 'bg-red-900/90 border-b border-red-700 text-red-200'
            }`}
          >
            <span className={`inline-block w-2 h-2 rounded-full ${socketStatus === 'reconnecting' ? 'bg-yellow-400 animate-pulse' : 'bg-red-400'}`} />
            {socketStatus === 'reconnecting'
              ? t('connection.reconnecting')
              : t('connection.disconnected')}
            {/* P0 2026-04-23: when disconnected (not mid-reconnect), offer an
                explicit refresh button so guests whose browser/PWA cache got
                out of sync with a fresh deploy can recover without knowing
                about Ctrl+Shift+R. */}
            {socketStatus === 'disconnected' && (
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="ml-2 px-2 py-0.5 rounded bg-red-800 hover:bg-red-700 text-red-100 text-xs font-semibold transition-colors"
              >
                {t('connection.refresh')}
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {!isAuthenticated && !currentPlayer ? (
        // Phase C 簡化登入架構 (2026-04-23)：LoginPage 單頁登入/註冊；
        // forgot-password / reset-password 兩頁保留給忘密流程。
        gameState === 'forgotPassword' ? <ForgotPasswordPage />
        : gameState === 'resetPassword'  ? <ResetPasswordPage />
        : <LoginPage />
      ) : (
        <>
          {gameState === 'home' && <HomePage />}
          {gameState === 'lobby' && <LobbyPage />}
          {(gameState === 'playing' || gameState === 'voting' || gameState === 'ended') && <GamePage />}
          {gameState === 'wiki' && <WikiPage />}
          {gameState === 'leaderboard' && <LeaderboardPage />}
          {gameState === 'profile' && <ProfilePage />}
          {gameState === 'friends' && <FriendsPage />}
          {gameState === 'aiStats' && <AiStatsPage />}
          {gameState === 'analysis' && <AnalysisPage />}
          {gameState === 'analytics' && <AnalyticsPage />}
          {gameState === 'settings' && <SettingsPage />}
          {gameState === 'personalStats' && <PersonalStatsPage />}
          {/* #86 backward compat: 舊 profileSettings state 自動 redirect 到 settings */}
          {gameState === 'profileSettings' && <SettingsPage />}
          {gameState === 'claimsNew' && <ClaimsNewPage />}
          {gameState === 'adminClaims' && <AdminClaimsPage />}
          {gameState === 'adminAdmins' && <AdminAdminsPage />}
          {gameState === 'adminElo' && <AdminEloPage />}
          {gameState === 'help' && <HelpPage />}
          {/* Phase C 簡化：保留 forgot/reset 兩頁給密碼重設流程；註冊頁已併入 LoginPage */}
          {gameState === 'forgotPassword'   && <ForgotPasswordPage />}
          {gameState === 'resetPassword'    && <ResetPasswordPage />}
        </>
      )}
      <ToastContainer />
      {/* Global floating controls — audio, theme & feedback, always accessible */}
      {currentPlayer && <FloatingControls />}
    </div>
  );
}

export default App;
