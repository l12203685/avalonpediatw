import { User } from '@avalon/shared';
import { NGROK_SKIP_HEADER } from './api';

// Check if Firebase is configured
const hasFirebaseConfig = !!(
  import.meta.env.VITE_FIREBASE_API_KEY &&
  import.meta.env.VITE_FIREBASE_PROJECT_ID
);

/**
 * 提示目前 client 是否具備 Firebase（正式帳號）能力。
 *
 * `ProfileSettingsPage` 的「綁定訪客」區塊要據此決定 Google 按鈕可不可按：
 * 沒 Firebase 配置就只剩 Discord / Line。
 */
export function hasFirebaseAuthConfigured(): boolean {
  return hasFirebaseConfig;
}

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
 * 訪客轉正式註冊。
 *
 * 2026-04-23 fix：原 Phase 1 stub 讓 server 回 501，前端沒重建 socket，導致
 * Edward 綁完 Google 仍被當訪客無法改名。現在：
 *   1. 呼叫 /auth/guest/upgrade 驗 providerToken、在 user store 建 google row
 *   2. 回傳成功時附帶 Firebase ID token，讓 caller 以新 token 重新 initializeSocket
 *      （見 SettingsPage.handleUpgrade）—socket 重連後 `auth:success` 會帶
 *      provider='google'，settings 頁就不再顯示訪客 UI。
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
      let errMsg = `upgrade failed: ${res.status}`;
      try {
        const body = await res.json() as { error?: string };
        if (body?.error) errMsg = body.error;
      } catch {
        // non-JSON response
      }
      return { ok: false, error: errMsg };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'network error' };
  }
}

/**
 * Discord OAuth 進入點。`mode` 決定走登入還是綁定路徑（#42 bind-path fix）：
 *
 *   - `'login'`（預設、無 token 時）→ `/auth/discord`：OAuth 走完 server 會發
 *     新 JWT、把 token 帶回 URL，前端當成登入處理。
 *   - `'bind'` + `jwt` → `/auth/link/discord?token=<jwt>`：server 驗證當前身份
 *     後把 discord_id 綁到既有 user row；訪客 JWT 也接受（後端會在 callback
 *     把訪客戰績合併到 discord 真帳號）。
 *
 * 舊 call site（無參數）= 原登入行為，向後相容。
 */
export function signInWithDiscord(mode: 'login' | 'bind' = 'login', jwt?: string): void {
  if (mode === 'bind' && jwt) {
    const q = new URLSearchParams({ token: jwt }).toString();
    window.location.href = `${SERVER_URL}/auth/link/discord?${q}`;
    return;
  }
  window.location.href = `${SERVER_URL}/auth/discord`;
}

/**
 * Line Login 進入點。同 `signInWithDiscord`：
 *   - `'login'` → `/auth/line`
 *   - `'bind'` + `jwt` → `/auth/link/line?token=<jwt>`
 */
export function signInWithLine(mode: 'login' | 'bind' = 'login', jwt?: string): void {
  if (mode === 'bind' && jwt) {
    const q = new URLSearchParams({ token: jwt }).toString();
    window.location.href = `${SERVER_URL}/auth/link/line?${q}`;
    return;
  }
  window.location.href = `${SERVER_URL}/auth/line`;
}

/**
 * 處理 OAuth callback：從 URL 讀取 ?oauth_token=...
 *
 * 回傳 token + provider + `linkMerged`（`?link_merged=1` 代表是訪客綁定完成 flow），
 * 或 null（代表沒有 OAuth callback）。
 *
 * 2026-04-23 bind-name-sync：`linkMerged=true` 時 App.tsx 會走硬 reload 路徑，
 * 保證 React state / socket / store 全部從乾淨狀態起，不會有訪客 provider 殘留。
 * 對應 orphan commit 01785fa8 的修復（未進 main，本次重建）。
 */
export function extractOAuthTokenFromUrl():
  | { token: string; provider: string; linkMerged: boolean }
  | null
{
  const params = new URLSearchParams(window.location.search);
  const token      = params.get('oauth_token');
  const provider   = params.get('provider') || 'oauth';
  const linkMerged = params.get('link_merged') === '1';
  if (!token) return null;
  // 清除 URL 參數，避免 token 留在瀏覽器記錄
  const cleanUrl = window.location.pathname + window.location.hash;
  window.history.replaceState({}, '', cleanUrl);
  return { token: decodeURIComponent(token), provider, linkMerged };
}

/**
 * Bind-name-sync (2026-04-23)：訪客綁 Discord / Line 回來後，我們把新發的
 * 真帳號 JWT 塞到 localStorage，讓接下來 `window.location.reload()` 之後
 * `App.tsx` 能直接用這顆 token 重開 socket，不會被 `guest_session` cookie 拉回
 * 訪客身份。reload 後 socket handshake 跑新 JWT → `provider='discord' / 'line'`
 * → SettingsPage.isGuestPlayer 回 false → 顯示正式帳號 UI。
 *
 * 一次性：App.tsx mount 讀完立刻刪掉，避免舊 token 常駐 localStorage 被別的
 * tab 或 Firebase 流程讀到造成混亂。
 *
 * 重建 orphan commit 01785fa8 的邏輯（該 commit 從未進 main，被 1f628c2d force-push 丟失）。
 */
const BIND_REFRESH_TOKEN_KEY = 'avalon_bind_refresh_token';

export function stashLinkedProviderToken(token: string): void {
  try {
    localStorage.setItem(BIND_REFRESH_TOKEN_KEY, token);
  } catch {
    // Private mode / quota — 無暫存不致命，reload 後會落回 guest cookie。
  }
}

export function consumeLinkedProviderToken(): string | null {
  try {
    const token = localStorage.getItem(BIND_REFRESH_TOKEN_KEY);
    if (token) localStorage.removeItem(BIND_REFRESH_TOKEN_KEY);
    return token;
  } catch {
    return null;
  }
}

/** 從 URL 讀取 OAuth 錯誤參數（?auth_error=...），清除後回傳錯誤訊息，無則回傳 null */
export function extractOAuthErrorFromUrl(): string | null {
  const params = new URLSearchParams(window.location.search);
  const error  = params.get('auth_error');
  const provider = params.get('provider');
  if (!error) return null;
  const cleanUrl = window.location.pathname + window.location.hash;
  window.history.replaceState({}, '', cleanUrl);
  // 2026-04-23 OAuth 快速登入：provider 未綁到任何 email 帳號 → 明示提示「先用 email 登入」。
  if (error === 'provider_not_linked') {
    const label = provider === 'discord' ? 'Discord'
                : provider === 'line'    ? 'LINE'
                : provider === 'google'  ? 'Google'
                : '這個第三方帳號';
    return `${label} 尚未綁定過站上帳號，請先以 email 登入後再到「系統設定」綁定`;
  }
  const messages: Record<string, string> = {
    discord_denied:  'Discord 登入已取消',
    discord_failed:  'Discord 登入失敗，請再試一次',
    line_denied:     'Line 登入已取消',
    line_failed:     'Line 登入失敗，請再試一次',
    invalid_state:   '登入驗證失敗（CSRF），請重新嘗試',
  };
  return messages[error] || '登入失敗，請再試一次';
}

// ── OAuth Quick Login (2026-04-23 Edward) ────────────────────
//
// Edward 原話：「能不能登入頁面綁 google/line/dc => 有的話就直接登入」。
//
// Discord / LINE：直接把整頁導到 /auth/oauth/login/<provider>，server 的
// callback 會處理「email 已綁 → JWT」/「email 沒綁 → auth_error」分支，
// 回到前端時 `extractOAuthTokenFromUrl` / `extractOAuthErrorFromUrl` 會接。
//
// Google：Firebase popup 拿 idToken → POST /auth/oauth/login/google → 200 時
// 拿到站上 JWT；401 時顯示 `provider_not_linked` 訊息。

export function quickLoginWithDiscord(): void {
  window.location.href = `${SERVER_URL}/auth/oauth/login/discord`;
}

export function quickLoginWithLine(): void {
  window.location.href = `${SERVER_URL}/auth/oauth/login/line`;
}

/**
 * Google 快速登入：Firebase popup → ID token → server 查 email → 200 直登。
 *
 * 沒綁（後端 401） → 丟 AuthApiException（code='provider_not_linked'），
 * caller 轉成使用者看得懂的訊息。
 */
export async function quickLoginWithGoogle(): Promise<AuthResult> {
  // Step 1: Firebase popup 拿 Google ID token
  const { signInWithPopup, GoogleAuthProvider } = await import('firebase/auth');
  const auth = await getFirebaseAuth();
  const popupResult = await signInWithPopup(auth, new GoogleAuthProvider());
  const idToken = await popupResult.user.getIdToken();

  // Step 2: server 驗 idToken + 查 email 是否已綁站上 auth_users
  const res = await fetch(`${SERVER_URL}/auth/oauth/login/google`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...NGROK_SKIP_HEADER },
    body: JSON.stringify({ idToken }),
  });
  if (!res.ok) {
    throw await parseAuthError(res, 'Google 快速登入失敗');
  }
  const data = await res.json() as AuthResult;
  return data;
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

// ── Phase B (2026-04-23) 新登入架構：帳號 + 密碼 + 信箱 ───────────
//
// Phase A 後端已就緒：/auth/register /auth/login /auth/forgot-password
// /auth/reset-password，以及 authed 的 PATCH /api/user/password 跟
// POST /api/user/claim-history。此段是對應的前端 helper：把 fetch 包成
// type-safe 函式、把 server error code 原封不動 surface 上去讓 UI i18n
// 對應訊息、JWT 交給呼叫端決定怎麼存（通常 → initializeSocket → socket.ts
// 的 _storedToken 就會持有）。

export interface AuthenticatedUser {
  uid:            string;
  accountName:    string;
  displayName:    string;
  provider:       'password' | 'discord' | 'line' | 'google';
  primaryEmail?:  string;
  emailsVerified?: string[];
  /**
   * Phase C 簡化：201 = 剛註冊 / 200 = 登入既有；UI 兩種情況都跳首頁，僅保留
   * flag 供 future 可做 onboarding toast 用。
   */
  isFirstLogin?:  boolean;
}

export interface AuthApiError {
  error: string;
  code?: string;
}

export class AuthApiException extends Error {
  public code?: string;
  public status: number;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'AuthApiException';
    this.status = status;
    this.code = code;
  }
}

async function parseAuthError(res: Response, fallback: string): Promise<AuthApiException> {
  let body: AuthApiError = { error: fallback };
  try {
    body = await res.json() as AuthApiError;
  } catch {
    // non-JSON body (e.g. 502 proxy error) — stick with fallback
  }
  return new AuthApiException(body.error || fallback, res.status, body.code);
}

export interface AuthResult {
  token: string;
  user:  AuthenticatedUser;
}

/**
 * Phase C (2026-04-23) 單一入口 — email 不存在 → 自動註冊；存在 → 登入。
 *
 *   server: POST /auth/login { email, password }
 *   201 = 剛剛註冊 / 200 = 登入既有帳號。UI 兩種情況都一樣跳首頁。
 */
export async function loginOrRegister(
  email:    string,
  password: string,
): Promise<AuthResult> {
  const res = await fetch(`${SERVER_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...NGROK_SKIP_HEADER },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    throw await parseAuthError(res, '登入失敗，請稍後再試');
  }
  const data = await res.json() as AuthResult;
  return {
    token: data.token,
    user:  { ...data.user, isFirstLogin: res.status === 201 },
  };
}

/**
 * 忘記密碼：email 一欄（Phase C 簡化後 email 就是帳號）。
 * server 永遠回 202（不論命中與否）。
 */
export async function forgotPassword(
  email: string,
): Promise<{ ok: true; ttlMs?: number }> {
  const res = await fetch(`${SERVER_URL}/auth/forgot-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...NGROK_SKIP_HEADER },
    body: JSON.stringify({ email }),
  });
  if (!res.ok && res.status !== 202) {
    throw await parseAuthError(res, '送出失敗，請稍後再試');
  }
  const data = await res.json().catch(() => ({}));
  return { ok: true, ttlMs: (data as { ttl_ms?: number }).ttl_ms };
}

/**
 * 用 email 連結裡的 token 重設密碼。成功後不自動登入 — 讓使用者在 LoginPage
 * 重新輸入新密碼，確認記得。
 */
export async function resetPassword(
  token:       string,
  newPassword: string,
): Promise<{ ok: true; userId: string }> {
  const res = await fetch(`${SERVER_URL}/auth/reset-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...NGROK_SKIP_HEADER },
    body: JSON.stringify({ token, newPassword }),
  });
  if (!res.ok) {
    throw await parseAuthError(res, '重設失敗，連結可能已過期');
  }
  const data = await res.json() as { ok: boolean; userId: string };
  return { ok: true, userId: data.userId };
}

/**
 * 已登入情況下改密碼。token 是當前 session JWT。
 */
export async function changePassword(
  sessionToken: string,
  oldPassword:  string,
  newPassword:  string,
): Promise<{ ok: true }> {
  const res = await fetch(`${SERVER_URL}/api/user/password`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization:  `Bearer ${sessionToken}`,
      ...NGROK_SKIP_HEADER,
    },
    body: JSON.stringify({ oldPassword, newPassword }),
  });
  if (!res.ok) {
    throw await parseAuthError(res, '改密碼失敗，請稍後再試');
  }
  return { ok: true };
}

/**
 * 新帳號 claim 舊 uuid 的戰績。三件式驗證：舊 uuid + 舊 email + 舊密碼
 * （Edward 原話「uuid + email + 密碼 3 件」）。成功後 server 把兩個 user row
 * 合併，舊 uuid 刪除。
 */
export async function claimHistory(
  sessionToken: string,
  uuid:         string,
  email:        string,
  password:     string,
): Promise<{ ok: true; claimedUuid: string }> {
  const res = await fetch(`${SERVER_URL}/api/user/claim-history`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization:  `Bearer ${sessionToken}`,
      ...NGROK_SKIP_HEADER,
    },
    body: JSON.stringify({ uuid, email, password }),
  });
  if (!res.ok) {
    throw await parseAuthError(res, '找不到符合的舊帳號');
  }
  const data = await res.json() as { ok: boolean; claimedUuid: string };
  return { ok: true, claimedUuid: data.claimedUuid };
}

// ── Client-side password strength（不拉 zxcvbn，輕量 heuristic）───
//
// Phase A server 端已強制最小規則：8-256 字元、≥1 英文字母、≥1 數字。
// UI 額外給 0-4 的強度分 + 提示，方便使用者決定要不要再加長 / 加符號。
// 算法刻意保持單檔 <50 行 + zero dep：長度、字元多樣性（小寫/大寫/數字/符號）
// 各計 1 分，超過 12 字再加 1 分。夠直白，也跟 Edward「zxcvbn 強度提示」文
// 意對齊 — 不是要 100% 相容 zxcvbn，是要讓使用者看得懂現在強度。

export interface PasswordStrength {
  /** 0 (最弱) ~ 4 (最強) — 直接對應 UI 顏色條 5 格 */
  score:  0 | 1 | 2 | 3 | 4;
  /** i18n key 後綴，UI 端 `auth.pwStrength.${label}` 查對應字串 */
  label:  'empty' | 'weak' | 'fair' | 'good' | 'strong' | 'excellent';
  /** 提示玩家怎麼加強（e.g.「再加幾個字」、「加個大寫」）— 直接顯示給使用者 */
  hint?:  string;
}

export function estimatePasswordStrength(password: string): PasswordStrength {
  if (!password) return { score: 0, label: 'empty', hint: '' };

  let score = 0;
  const hints: string[] = [];

  // 長度是最大一塊。12 字以上幾乎一定夠 — 大多數線上資料庫洩漏密碼 <10 字。
  if (password.length >= 8)  score += 1; else hints.push('至少 8 字元');
  if (password.length >= 12) score += 1; else if (password.length >= 8) hints.push('建議 12 字以上更安全');

  // 字元多樣性
  const hasLower  = /[a-z]/.test(password);
  const hasUpper  = /[A-Z]/.test(password);
  const hasDigit  = /\d/.test(password);
  const hasSymbol = /[^A-Za-z0-9]/.test(password);

  if (hasLower && hasUpper) score += 1;
  else if (!hasLower && !hasUpper) hints.push('需要至少一個英文字母');

  if (hasDigit) score += 1;
  else hints.push('加個數字');

  if (hasSymbol) score += 1;
  else if (score >= 2) hints.push('加個符號會更強');

  // clamp 到 0-4
  const finalScore = Math.min(4, Math.max(0, score)) as 0 | 1 | 2 | 3 | 4;
  const labels: PasswordStrength['label'][] = ['weak', 'weak', 'fair', 'good', 'strong'];
  // 超滿分 (全有 + >=12) 給 excellent
  const label: PasswordStrength['label'] =
    password.length >= 12 && hasLower && hasUpper && hasDigit && hasSymbol
      ? 'excellent'
      : labels[finalScore];

  return {
    score: finalScore,
    label,
    hint:  hints[0],
  };
}
