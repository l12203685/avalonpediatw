import { User } from '@avalon/shared';
import { NGROK_SKIP_HEADER } from './api';

// Check if Firebase is configured
const hasFirebaseConfig = !!(
  import.meta.env.VITE_FIREBASE_API_KEY &&
  import.meta.env.VITE_FIREBASE_PROJECT_ID
);

// Lazy-load Firebase only when config is present
let _firebaseAuth: import('firebase/auth').Auth | undefined;

async function getFirebaseAuth() {
  if (!hasFirebaseConfig) throw new Error('Firebase not configured');
  if (_firebaseAuth) return _firebaseAuth;
  const { initializeApp } = await import('firebase/app');
  const { getAuth } = await import('firebase/auth');
  const app = initializeApp({
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: import.meta.env.VITE_FIREBASE_APP_ID,
  });
  _firebaseAuth = getAuth(app);
  return _firebaseAuth;
}

export function initializeAuth(): void {
  // no-op in guest mode; Firebase init happens lazily on sign-in
}

export async function signInWithGoogle() {
  const { signInWithPopup, GoogleAuthProvider } = await import('firebase/auth');
  const auth = await getFirebaseAuth();
  const result = await signInWithPopup(auth, new GoogleAuthProvider());
  return result.user;
}

export async function signInWithEmail(email: string, password: string) {
  const { signInWithEmailAndPassword } = await import('firebase/auth');
  const auth = await getFirebaseAuth();
  const result = await signInWithEmailAndPassword(auth, email, password);
  return result.user;
}

export async function signUpWithEmail(email: string, password: string, displayName: string) {
  const { createUserWithEmailAndPassword, updateProfile } = await import('firebase/auth');
  const auth = await getFirebaseAuth();
  const result = await createUserWithEmailAndPassword(auth, email, password);
  await updateProfile(result.user, { displayName });
  return result.user;
}

const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:3001';

/**
 * 取得 server-signed guest token（Plan v2 R1.0 / S10 修補）。
 *
 * 舊做法是 client 自己 `JSON.stringify({uid: uuidv4(), displayName})` 當 token
 * 送給 server，攻擊者能用別人的 uid 冒充身份污染戰績。現在改由 server 發 token：
 * client POST `/auth/guest` 帶 displayName，server 回傳 JWT（uid 由 server mint）。
 * 3 天 grace 期內若此 API 失敗（server 還沒部署到新版），前端自動 fallback 成舊
 * JSON token，確保現有玩家無感過渡。
 *
 * Phase 1 IA 重構：同時讓 server 設 `guest_session` HttpOnly cookie，之後冷啟動
 * 可以呼叫 `/auth/guest/resume` 續簽而不需要使用者再輸入一次名字。
 */
export async function getGuestToken(displayName: string): Promise<string> {
  const res = await fetch(`${SERVER_URL}/auth/guest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...NGROK_SKIP_HEADER },
    body: JSON.stringify({ displayName }),
    credentials: 'include',
  });
  if (!res.ok) {
    throw new Error(`Guest token mint failed: ${res.status}`);
  }
  const data = await res.json() as { token?: string };
  if (!data.token) {
    throw new Error('Guest token mint returned no token');
  }
  return data.token;
}

/**
 * 嘗試從 `guest_session` cookie 續接訪客 session。
 * 成功回傳新的 JWT + uid + displayName，失敗回 null（沒 cookie 或已失效）。
 * App mount 時先試這個，才決定要不要叫使用者點「訪客登入」。
 */
export async function resumeGuestFromCookie(): Promise<
  { token: string; uid: string; displayName: string } | null
> {
  try {
    const res = await fetch(`${SERVER_URL}/auth/guest/resume`, {
      method: 'GET',
      headers: { ...NGROK_SKIP_HEADER },
      credentials: 'include',
    });
    if (!res.ok) return null;
    const data = await res.json() as {
      token?: string;
      user?: { uid?: string; displayName?: string };
    };
    if (!data.token || !data.user?.uid) return null;
    return {
      token: data.token,
      uid: data.user.uid,
      displayName: data.user.displayName ?? 'Guest',
    };
  } catch {
    return null;
  }
}

/**
 * 訪客改名。Server 驗證 2-20 字 + 不以 `Guest_` 開頭（Ticket #81）。
 * 400 會帶 `{error, code?}`，UI 可據 code 顯示對應 i18n 訊息。
 * Phase 2 再補 24hr × 3 rate limit。
 */
export async function renameGuest(newName: string): Promise<{ ok: boolean; error?: string; code?: string }> {
  try {
    const res = await fetch(`${SERVER_URL}/auth/guest/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...NGROK_SKIP_HEADER },
      body: JSON.stringify({ newName }),
      credentials: 'include',
    });
    if (!res.ok) {
      let parsed: { error?: string; code?: string } = {};
      try {
        parsed = await res.json() as { error?: string; code?: string };
      } catch {
        // non-JSON body (e.g. 502 from proxy)
      }
      // TODO(phase2): surface rate-limit (429) details to caller
      return {
        ok: false,
        error: parsed.error || `rename failed: ${res.status}`,
        code: parsed.code,
      };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'network error' };
  }
}

/**
 * 訪客轉正式註冊（Phase 1 stub — server 目前回 501）。
 * Phase 2 會驗證 providerToken、檢查 email 衝突、合併戰績與 ELO。
 */
export async function upgradeGuestToRegistered(
  provider: string,
  providerToken: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${SERVER_URL}/auth/guest/upgrade`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...NGROK_SKIP_HEADER },
      body: JSON.stringify({ provider, providerToken }),
      credentials: 'include',
    });
    if (!res.ok) {
      // TODO(phase2): handle 409 duplicate-email + 501 not-implemented UI
      return { ok: false, error: `upgrade failed: ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'network error' };
  }
}

/** Discord OAuth：重導向到後端 → Discord → 後端 callback → 前端 */
export function signInWithDiscord(): void {
  window.location.href = `${SERVER_URL}/auth/discord`;
}

/** Line Login：重導向到後端 → Line → 後端 callback → 前端 */
export function signInWithLine(): void {
  window.location.href = `${SERVER_URL}/auth/line`;
}

/**
 * 處理 OAuth callback：從 URL 讀取 ?oauth_token=...
 * 回傳 token 字串，或 null（代表沒有 OAuth callback）
 */
export function extractOAuthTokenFromUrl(): { token: string; provider: string } | null {
  const params = new URLSearchParams(window.location.search);
  const token    = params.get('oauth_token');
  const provider = params.get('provider') || 'oauth';
  if (!token) return null;
  // 清除 URL 參數，避免 token 留在瀏覽器記錄
  const cleanUrl = window.location.pathname + window.location.hash;
  window.history.replaceState({}, '', cleanUrl);
  return { token: decodeURIComponent(token), provider };
}

/** 從 URL 讀取 OAuth 錯誤參數（?auth_error=...），清除後回傳錯誤訊息，無則回傳 null */
export function extractOAuthErrorFromUrl(): string | null {
  const params = new URLSearchParams(window.location.search);
  const error  = params.get('auth_error');
  if (!error) return null;
  const cleanUrl = window.location.pathname + window.location.hash;
  window.history.replaceState({}, '', cleanUrl);
  const messages: Record<string, string> = {
    discord_denied:  'Discord 登入已取消',
    discord_failed:  'Discord 登入失敗，請再試一次',
    line_denied:     'Line 登入已取消',
    line_failed:     'Line 登入失敗，請再試一次',
    invalid_state:   '登入驗證失敗（CSRF），請重新嘗試',
  };
  return messages[error] || '登入失敗，請再試一次';
}

export async function logout(): Promise<void> {
  if (!hasFirebaseConfig) return;
  const { signOut } = await import('firebase/auth');
  const auth = await getFirebaseAuth();
  await signOut(auth);
}

export function onAuthStateChange(
  callback: (userWithToken: { user: User; token: string } | null) => void
): () => void {
  if (!hasFirebaseConfig) {
    // Guest mode — immediately signal "not authenticated" so LoginPage shows
    setTimeout(() => callback(null), 0);
    return () => {};
  }

  let unsubscribe = () => {};
  getFirebaseAuth().then(async (auth) => {
    const { onAuthStateChanged } = await import('firebase/auth');
    unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        const token = await firebaseUser.getIdToken();
        const provider = firebaseUser.providerData[0]?.providerId?.split('.')[0] || 'google';
        const email = firebaseUser.email || '';
        callback({
          user: {
            uid: firebaseUser.uid,
            email,
            displayName: firebaseUser.displayName || email.split('@')[0] || 'Guest',
            photoURL: firebaseUser.photoURL || undefined,
            provider: (provider === 'password' ? 'email' : 'google') as 'google' | 'email',
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
          token,
        });
      } else {
        callback(null);
      }
    });
  });

  return () => unsubscribe();
}

export async function getIdToken(): Promise<string> {
  const auth = await getFirebaseAuth();
  const user = auth.currentUser;
  if (!user) throw new Error('No user signed in');
  return await user.getIdToken(true);
}
