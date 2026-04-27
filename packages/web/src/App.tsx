import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { useGameStore } from './store/gameStore';
import {
  initializeAuth,
  onAuthStateChange,
  extractOAuthTokenFromUrl,
  stashLinkedProviderToken,
  consumeLinkedProviderToken,
  getGuestToken,
  resumeGuestFromCookie,
} from './services/auth';
import { initializeSocket, disconnectSocket, getStoredToken } from './services/socket';
import { startVersionCheck } from './services/versionCheck';
import { forceRefresh } from './utils/forceRefresh';
import HomePage from './pages/HomePage';
import RoomPage from './pages/RoomPage';
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
import ReplayPage from './pages/ReplayPage';
import ClaimsNewPage from './pages/ClaimsNewPage';
import AdminClaimsPage from './pages/AdminClaimsPage';
import AdminAdminsPage from './pages/AdminAdminsPage';
import AdminImportPage from './pages/AdminImportPage';
import AdminEloPage from './pages/AdminEloPage';
import HelpPage from './pages/HelpPage';
import ToastContainer from './components/ToastContainer';
import { submitError } from './services/api';

function App(): JSX.Element {
  const { t } = useTranslation();
  const { gameState, currentPlayer, socketStatus } = useGameStore();
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [newVersionAvailable, setNewVersionAvailable] = useState(false);

  // Version check poller — detects a fresh server deploy and prompts the
  // user to refresh so they don't keep running against a stale JS bundle
  // (root cause of the intermittent xhr/ws errors Edward reported 2026-04-23).
  // Safe to start before login: the endpoint is unauthenticated.
  //
  // 2026-04-24 #cache-upgrade (hineko_20260424_1030): escalate toast to a
  // sticky banner so Edward doesn't miss it behind other toasts. Keep the
  // toast as a secondary signal for when the banner is hidden mid-game.
  useEffect(() => {
    startVersionCheck((_current, _latest) => {
      setNewVersionAvailable(true);
      const { addToast } = useGameStore.getState();
      addToast(t('connection.newVersionAvailable'), 'info');
    });
    // No teardown — this is a singleton and polls once a minute; a hot
    // reload replaces the module rather than leaking timers.
  }, [t]);

  // Hide the version banner mid-match so a fresh deploy doesn't yank focus
  // during voting / quest resolution. It re-appears once Edward returns to
  // the lobby.
  const bannerHiddenInGame =
    gameState === 'playing' || gameState === 'voting';
  const showNewVersionBanner = newVersionAvailable && !bannerHiddenInGame;

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

    // 2026-04-24 LINE-bind landing fix：authed 用戶走 /auth/link/<provider> 成功後，
    // 後端會 302 到 `${FRONTEND_URL}?link_ok=1&provider=line`（以前是 /profile?...，
    // 但 SPA 無 client-side router → 落在 Home 看起來像「舊訪客頁面」）。這段在
    // mount 的最前面讀 query，flag 一筆 pendingLinkNotice 到 localStorage，等
    // socket init / Firebase auth 回來之後再由下一個 useEffect 撈出來 toast +
    // setGameState('settings')，把使用者帶回他原本按「綁定」那頁。
    {
      const params = new URLSearchParams(window.location.search);
      const linkOk     = params.get('link_ok');
      const linkMerged = params.get('link_merged');
      const linkError  = params.get('link_error');
      const linkProv   = params.get('provider') || '';
      // 訪客綁定 (oauth_token + link_merged) 由下面原本的 flow 接走；這裡只處理
      // 不帶 oauth_token 的 authed-bind callback（url 只有 link_* + provider）。
      const hasOauthToken = params.get('oauth_token') !== null;
      if (!hasOauthToken && (linkOk || linkMerged || linkError)) {
        const kind = linkError ? 'error' : linkMerged ? 'merged' : 'ok';
        const reason = linkError || '';
        try {
          localStorage.setItem('pendingLinkNotice', JSON.stringify({ kind, provider: linkProv, reason }));
        } catch {
          // private mode / quota — no stash, user just won't see toast
        }
        ['link_ok', 'link_merged', 'link_error', 'provider'].forEach(k => params.delete(k));
        const qs = params.toString();
        window.history.replaceState({}, '', `/${qs ? `?${qs}` : ''}${window.location.hash}`);
      }
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

    // 2026-04-26 Edward landing-route fix：清快取後重新整理直接進大廳，不再
    // 強制經 LoginPage。三層 fallback：
    //   1) Firebase user 存在 → 走原本 OAuth 流程
    //   2) 已 stored JWT → 用既有 token 起 socket（reload 後最常見路徑）
    //   3) 都沒有 → 試 /auth/guest/resume cookie 續簽 → 失敗就 mint 新訪客
    //      JWT (/auth/guest)，自動進大廳訪客模式（chip 顯「登入/綁定」）。
    //   4) 訪客 mint 失敗（後端離線）→ 才退回 LoginPage 顯示給使用者選擇。
    //
    // 大廳對訪客的限制（建立/加入房間 → AuthGateModal）已由 #177 / #196 wired，
    // 此修改只動 routing：從「強制登入」變「lazy 登入」。
    const ensureGuestSession = async (): Promise<void> => {
      // resumeGuestFromCookie 會打 /auth/guest/resume —— 若 server 還沒實作
      // (Phase A 砍掉) 會回 404 → null，自動往下 fallback 到 mint 新 token。
      try {
        const resumed = await resumeGuestFromCookie();
        if (resumed) {
          await initializeSocket(resumed.token);
          setIsAuthenticated(true);
          return;
        }
      } catch {
        // network error — keep falling through to fresh mint
      }
      // 沒 cookie 或續簽失敗 → mint 新 guest JWT。displayName 沿用上次本機暫存
      // 的名字（HomePage 在開房/加房時 setItem 'avalon_player_name'）；沒有就
      // 隨機產生 Guest_<6 位>。
      try {
        const savedName = localStorage.getItem('avalon_player_name')?.trim();
        const displayName = savedName && savedName.length > 0
          ? savedName
          : `Guest_${Math.floor(Math.random() * 900000 + 100000)}`;
        const token = await getGuestToken(displayName);
        await initializeSocket(token);
        setIsAuthenticated(true);
      } catch {
        // Guest mint failed — server outage. Fall back to LoginPage so the
        // user has an explicit recovery path; connection banner will surface.
        setIsAuthenticated(false);
        disconnectSocket();
      }
    };

    const unsubscribe = onAuthStateChange(async (userWithToken) => {
      if (userWithToken) {
        // Firebase user present (Google / email login persisted) → OAuth path
        setIsAuthenticated(true);
        try {
          await initializeSocket(userWithToken.token);
        } catch {
          // Socket init failed — user will see connection banner
        }
      } else {
        const stored = getStoredToken();
        if (stored) {
          // Page reload with stored JWT (most common warm-start path).
          try {
            await initializeSocket(stored);
            setIsAuthenticated(true);
          } catch {
            // Stored token rejected (expired) → fresh guest mint
            await ensureGuestSession();
          }
        } else {
          // Cold start, cleared cache → auto-issue guest session so the user
          // lands directly on the lobby (HomePage in 訪客 mode) instead of the
          // OAuth wall.
          await ensureGuestSession();
        }
      }
      setIsLoading(false);
    });

    return () => {
      unsubscribe();
    };
  }, []);

  // 2026-04-24 LINE-bind landing fix (part 2): 等 authed 完成後把暫存的
  // pendingLinkNotice 撈出來 → toast + setGameState('settings')。這樣使用者
  // 綁定回來不會卡在 HomePage（看起來像「舊訪客頁面」），而是回到 Settings
  // 頁繼續看「已綁定 LINE」的狀態。currentPlayer 變化時才檢查，避免還沒
  // 登入就亂跳。
  useEffect(() => {
    if (!currentPlayer) return;
    let raw: string | null = null;
    try { raw = localStorage.getItem('pendingLinkNotice'); } catch { return; }
    if (!raw) return;
    try { localStorage.removeItem('pendingLinkNotice'); } catch { /* noop */ }

    let parsed: { kind?: string; provider?: string; reason?: string };
    try {
      parsed = JSON.parse(raw) as { kind?: string; provider?: string; reason?: string };
    } catch {
      return;
    }
    const { addToast, setGameState } = useGameStore.getState();
    const providerLabel =
      parsed.provider === 'line'    ? 'LINE'    :
      parsed.provider === 'discord' ? 'Discord' :
      parsed.provider === 'google'  ? 'Google'  :
      '';
    if (parsed.kind === 'ok') {
      addToast(
        providerLabel
          ? t('settings.bindSuccess', { defaultValue: '{{provider}} 綁定成功', provider: providerLabel })
          : t('settings.bindSuccess', { defaultValue: '綁定成功' }),
        'success',
      );
      setGameState('settings');
    } else if (parsed.kind === 'merged') {
      addToast(
        providerLabel
          ? t('settings.bindMerged', { defaultValue: '{{provider}} 綁定成功（戰績已合併）', provider: providerLabel })
          : t('settings.bindMerged', { defaultValue: '綁定成功（戰績已合併）' }),
        'success',
      );
      setGameState('settings');
    } else if (parsed.kind === 'error') {
      addToast(
        providerLabel
          ? t('settings.bindError', { defaultValue: '{{provider}} 綁定失敗（{{reason}}）', provider: providerLabel, reason: parsed.reason })
          : t('settings.bindError', { defaultValue: '綁定失敗' }),
        'error',
      );
      setGameState('settings');
    }
  }, [currentPlayer, t]);

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

  // Edward 2026-04-25 18:08 mobile root fix: routes that own a full-height
  // single-viewport layout (LobbyPage / GamePage) need `h-[100dvh]` rather
  // than `min-h-screen` so the inner overflow-hidden actually clips. We keep
  // `min-h-screen` for the rest (HomePage / ProfilePage / WikiPage etc.) so
  // long content pages still scroll naturally.
  const fullViewportRoute =
    gameState === 'lobby'
    || gameState === 'playing'
    || gameState === 'voting'
    || gameState === 'ended';
  const rootClass = fullViewportRoute
    ? 'h-[100dvh] overflow-hidden bg-gradient-to-br from-avalon-dark to-avalon-card'
    : 'min-h-screen bg-gradient-to-br from-avalon-dark to-avalon-card';

  return (
    <div className={rootClass}>
      {/* Connection status banner */}
      <AnimatePresence>
        {showConnectionBanner && (
          <motion.div
            key="conn-banner"
            initial={{ y: -48, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -48, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            // Edward 2026-04-27 PWA status-bar fix: pt-safe so the connection
            // banner sits below the iOS/Android status bar instead of being
            // overlapped by the notch + 電信/時間/電量 row in standalone PWA.
            className={`fixed top-0 left-0 right-0 z-[100] flex items-center justify-center gap-2 px-4 py-2 text-sm font-semibold pt-safe ${
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

        {/* 2026-04-24 #cache-upgrade: sticky banner when /api/version flips.
            Hidden mid-match (playing/voting) so Edward isn't pulled out of a
            live round; re-appears on lobby return. */}
        {showNewVersionBanner && (
          <motion.div
            key="new-version-banner"
            initial={{ y: -48, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -48, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            // Edward 2026-04-27 PWA status-bar fix: pt-safe so the new-version
            // banner clears the iOS/Android status bar (PWA standalone mode).
            className="fixed top-0 left-0 right-0 z-[100] flex items-center justify-center gap-3 px-4 py-2 text-sm font-semibold bg-amber-900/90 border-b border-amber-700 text-amber-100 pt-safe"
          >
            <span className="inline-block w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
            {t('connection.newVersionBanner', { defaultValue: '有新版本可用' })}
            <button
              type="button"
              onClick={() => { void forceRefresh(); }}
              className="ml-2 px-3 py-0.5 rounded bg-amber-600 hover:bg-amber-500 text-amber-50 text-xs font-semibold transition-colors"
            >
              {t('connection.updateNow', { defaultValue: '立即更新' })}
            </button>
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
          {/* Edward 2026-04-25 23:39 — Lobby + Game 共用 RoomPage. RoomPage
              internally branches on `room.state` to swap top section + toolbar
              while keeping the rails+chat layout phase-agnostic. */}
          {(gameState === 'lobby' || gameState === 'playing' || gameState === 'voting' || gameState === 'ended') && <RoomPage />}
          {gameState === 'wiki' && <WikiPage />}
          {gameState === 'leaderboard' && <LeaderboardPage />}
          {gameState === 'profile' && <ProfilePage />}
          {gameState === 'friends' && <FriendsPage />}
          {gameState === 'aiStats' && <AiStatsPage />}
          {gameState === 'analysis' && <AnalysisPage />}
          {gameState === 'analytics' && <AnalyticsPage />}
          {gameState === 'settings' && <SettingsPage />}
          {gameState === 'personalStats' && <PersonalStatsPage />}
          {/* P0 fix 2026-04-25: PersonalStatsPage timeline grid + ProfilePage
              GameRow ↗ buttons both call navigateToReplay() which sets
              gameState='replay'. Without this line the page renders blank
              (Edward 16:08 "歷史戰績查詢點了最近一場打不開"). ReplayPage already
              exists at /pages/ReplayPage.tsx and uses replayRoomId from store. */}
          {gameState === 'replay' && <ReplayPage />}
          {/* #86 backward compat: 舊 profileSettings state 自動 redirect 到 settings */}
          {gameState === 'profileSettings' && <SettingsPage />}
          {gameState === 'claimsNew' && <ClaimsNewPage />}
          {gameState === 'adminClaims' && <AdminClaimsPage />}
          {gameState === 'adminAdmins' && <AdminAdminsPage />}
          {gameState === 'adminElo' && <AdminEloPage />}
          {gameState === 'adminImport' && <AdminImportPage />}
          {gameState === 'help' && <HelpPage />}
          {/* Phase C 簡化：保留 forgot/reset 兩頁給密碼重設流程；註冊頁已併入 LoginPage */}
          {gameState === 'forgotPassword'   && <ForgotPasswordPage />}
          {gameState === 'resetPassword'    && <ResetPasswordPage />}
        </>
      )}
      <ToastContainer />
    </div>
  );
}

export default App;
