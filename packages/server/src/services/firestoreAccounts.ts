/**
 * Firestore-backed multi-account binding + OAuth session store.
 *
 * Ticket #42 rewrite (2026-04-23) — route B: Firestore over Supabase.
 *
 * Why this file exists:
 *   The legacy `supabase.ts` helpers (getLinkedAccounts / linkProviderIdentity /
 *   unlinkProviderIdentity / mergeUserAccounts / createOAuthSession /
 *   consumeOAuthSession / findUserIdByProviderIdentity) expected a Supabase
 *   project that was never actually provisioned — `SUPABASE_URL` /
 *   `SUPABASE_SERVICE_KEY` are not set in production, so every helper returned a
 *   silent no-op. This module re-implements the same contract against Firebase
 *   Firestore, which is the database the server is already talking to for
 *   GameHistoryRepository / FirestoreLeaderboard.
 *
 * Firestore schema:
 *
 *   auth_users/{userId}                -- primary user record for binding
 *     .provider         string         -- originating provider ('discord' | 'line' | 'google')
 *     .discord_id       string | null
 *     .line_id          string | null
 *     .firebase_uid     string | null
 *     .email            string | null
 *     .display_name     string
 *     .photo_url        string | null
 *     .short_code       string | null
 *     .elo_rating       number
 *     .total_games      number
 *     .games_won        number
 *     .games_lost       number
 *     .badges           string[]
 *     .createdAt        number (ms epoch)
 *     .updatedAt        number (ms epoch)
 *
 *   oauth_sessions/{stateToken}        -- short-lived OAuth CSRF sessions
 *     .provider         'discord' | 'line'
 *     .expiresAt        number (ms epoch)
 *     .linkUserId       string | null  -- set when user is binding an extra provider
 *     .createdAt        number (ms epoch)
 *
 *   friendships/{followerId}_{followingId}  -- for merge flow
 *     .follower_id, .following_id, .createdAt
 *
 *   game_records                       -- existing Firestore `games` collection is
 *     read-only from this module; we update player identity inside merge via
 *     scanning the collection and rewriting playerId in-place.
 *
 * Design choices:
 *   - `auth_users` is *separate* from the Realtime DB `users/{uid}` node used
 *     by firebase.ts. The RTDB path stores Firebase-authenticated profiles;
 *     this collection stores server-minted user rows that can wear multiple
 *     provider hats. Keeping them separate avoids schema collisions and
 *     guarantees that existing Firebase Auth users flow untouched.
 *   - Merge uses a Firestore batched write to stay atomic for the `auth_users`
 *     mutation, then best-effort scans for game_records / friendships (same
 *     semantics as the legacy Supabase code: partial failure does not rollback
 *     the primary write).
 *   - OAuth session lookup uses the state token as the document id (natural
 *     primary key), which makes `consumeOAuthSession` a single get+delete.
 */

import type { Firestore } from 'firebase-admin/firestore';
import { getAdminFirestore, isFirebaseAdminReady } from './firebase';
import { assignShortCodeToAuthUser } from './shortCodeFirestore';

// ── Types (mirror supabase.ts exports for API drop-in) ──────────────

export type LinkProvider = 'discord' | 'line' | 'google';

export interface LinkedAccountSummary {
  provider:     LinkProvider;
  linked:       boolean;
  external_id:  string | null;
  primary:      boolean;
  /**
   * 2026-04-23 Edward 指令：UI 顯「已綁定 @xxx」時需要一個可讀 label。
   *   - google  → email（如 'alice@gmail.com'）
   *   - discord → display_name + '#' 末四碼 id（如 'Alice#1234'），fallback display_name
   *   - line    → display_name（如 'Alice LINE'）
   * 沒綁時為 null；firestore/supabase 實作回同一格式。
   */
  display_label: string | null;
}

export interface OAuthSession {
  linkUserId: string | null;
  /**
   * True when the OAuth redirect was initiated by a guest (訪客 JWT). The
   * callback uses this to trigger `absorbGuestIntoUser` + a fresh JWT so the
   * client can re-handshake with the real account's identity (#42 bind-path
   * fix).
   */
  isGuest?: boolean;
  /**
   * OAuth flow mode. Default `undefined` = original login flow (callback mints
   * a new user doc or reuses an existing one by provider externalId).
   *
   * `'quickLogin'` = 2026-04-23 Edward 要求的 OAuth 快速登入：callback 僅接受
   * 「當前 provider email 已綁到某既有 auth_users row」的 case，找得到直接發
   * JWT 直登；找不到 → 導回前端提示「請先以 email 登入後再綁定」，**禁止**建新
   * 帳號（避免使用者誤以為 Google 登入會自動建立帳號後卻沒綁到 email-only 那邊）。
   */
  mode?: 'quickLogin';
}

type ProviderColumn = 'discord_id' | 'line_id' | 'firebase_uid';

interface AuthUserDoc {
  provider?:     string;
  discord_id?:   string | null;
  line_id?:      string | null;
  firebase_uid?: string | null;
  email?:        string | null;
  display_name?: string;
  photo_url?:    string | null;
  short_code?:   string | null;
  elo_rating?:   number;
  total_games?:  number;
  games_won?:    number;
  games_lost?:   number;
  badges?:       string[];
  createdAt?:    number;
  updatedAt?:    number;
}

// ── Module-scoped collections ───────────────────────────────────────

const AUTH_USERS     = 'auth_users';
const OAUTH_SESSIONS = 'oauth_sessions';
const FRIENDSHIPS    = 'friendships';
const GAME_RECORDS   = 'games';

const OAUTH_TTL_MS = 10 * 60 * 1000; // 10 minutes

function providerToColumn(provider: LinkProvider): ProviderColumn {
  switch (provider) {
    case 'discord': return 'discord_id';
    case 'line':    return 'line_id';
    case 'google':  return 'firebase_uid';
  }
}

function getFirestoreSafe(): Firestore | null {
  if (!isFirebaseAdminReady()) return null;
  try {
    return getAdminFirestore();
  } catch {
    return null;
  }
}

/**
 * True when Firebase admin SDK is initialised — required for any Firestore op.
 * Mirrors `isSupabaseReady` semantics so route guards stay ergonomic.
 */
export function isFirestoreReady(): boolean {
  return getFirestoreSafe() !== null;
}

// ── Multi-account binding ────────────────────────────────────────────

/**
 * Get the three-provider binding summary for a user document.
 * Returns an empty array when the user row or Firestore is unavailable.
 */
export async function getLinkedAccounts(userId: string): Promise<LinkedAccountSummary[]> {
  const db = getFirestoreSafe();
  if (!db) return [];
  try {
    const snap = await db.collection(AUTH_USERS).doc(userId).get();
    if (!snap.exists) return [];
    const data = (snap.data() ?? {}) as AuthUserDoc;
    const primary = data.provider ?? '';
    const providers: LinkProvider[] = ['discord', 'line', 'google'];
    const displayName = typeof data.display_name === 'string' ? data.display_name : null;
    const email       = typeof data.email === 'string' ? data.email : null;
    return providers.map((p) => {
      const col = providerToColumn(p);
      const raw = data[col];
      const externalId = typeof raw === 'string' && raw.length > 0 ? raw : null;
      return {
        provider:      p,
        linked:        externalId !== null,
        external_id:   externalId,
        primary:       primary === p,
        display_label: buildProviderDisplayLabel(p, externalId, { displayName, email }),
      };
    });
  } catch (err) {
    console.error('[firestoreAccounts] getLinkedAccounts error:', err);
    return [];
  }
}

/**
 * 把一個 provider 的綁定資訊算成顯示字串。auth_users 目前只存一組共用的
 * display_name / email（source-of-truth 為最後一次登入/綁定時的 provider 資訊），
 * 所以三個 provider 在沒拆 per-provider profile 之前，共用同一組文字。
 *
 * 未綁定的 provider 一律回 null。
 */
function buildProviderDisplayLabel(
  provider:   LinkProvider,
  externalId: string | null,
  ctx: { displayName: string | null; email: string | null },
): string | null {
  if (!externalId) return null;
  switch (provider) {
    case 'google':
      return ctx.email || ctx.displayName || externalId;
    case 'discord': {
      const base = ctx.displayName || externalId;
      const tail = externalId.slice(-4);
      return ctx.displayName ? `${base}#${tail}` : base;
    }
    case 'line':
      return ctx.displayName || externalId;
  }
}

/**
 * Find which user doc currently owns this (provider, externalId) identity.
 * Returns null when unbound.
 */
export async function findUserIdByProviderIdentity(
  provider: LinkProvider,
  externalId: string,
): Promise<string | null> {
  const db = getFirestoreSafe();
  if (!db) return null;
  const col = providerToColumn(provider);
  try {
    const snapshot = await db
      .collection(AUTH_USERS)
      .where(col, '==', externalId)
      .limit(1)
      .get();
    if (snapshot.empty) return null;
    return snapshot.docs[0].id;
  } catch (err) {
    console.error('[firestoreAccounts] findUserIdByProviderIdentity error:', err);
    return null;
  }
}

/**
 * #42 bind-path fix：建/更新 auth_users doc 並綁定 provider identity。
 *
 * 跟 `linkProviderIdentity` 的差別：當 doc 不存在時會直接建（不會回 false）。
 * 用於訪客綁 Discord/Line 且該 identity 從未被註冊過的情境 — 這時還沒有
 * 真帳號 row，必須先建一個才能綁。回傳 auth_users docId（= externalId，
 * 沿用 Discord/Line OAuth 登入時 JWT sub = externalId 的慣例）。
 *
 * 失敗回 null（Firestore 不可用 / 寫入 error）。
 */
export async function ensureAuthUserWithProvider(
  provider:    LinkProvider,
  externalId:  string,
  displayName: string,
  photoUrl?:   string,
  email?:      string,
): Promise<string | null> {
  const db = getFirestoreSafe();
  if (!db) return null;
  const col = providerToColumn(provider);
  const docId = externalId; // 沿用 OAuth 登入時 JWT sub = externalId 的慣例
  try {
    const ref  = db.collection(AUTH_USERS).doc(docId);
    const snap = await ref.get();
    const now = Date.now();
    if (snap.exists) {
      await ref.update({
        [col]:        externalId,
        display_name: displayName,
        photo_url:    photoUrl ?? null,
        updatedAt:    now,
      });
    } else {
      await ref.set({
        provider,
        [col]:        externalId,
        email:        email ?? null,
        display_name: displayName,
        photo_url:    photoUrl ?? null,
        elo_rating:   1000,
        total_games:  0,
        games_won:    0,
        games_lost:   0,
        badges:       [],
        createdAt:    now,
        updatedAt:    now,
      });
      // 2026-04-24 #48 修復：訪客 → 真帳號升級路徑（Discord/LINE link-callback）
      // 建新 row 時同步 backfill 短碼到 Firestore shortCodeIndex，best-effort。
      try {
        await assignShortCodeToAuthUser(docId, db);
      } catch (err) {
        console.error('[firestoreAccounts] backfill shortCode failed (non-fatal):', err);
      }
    }
    return docId;
  } catch (err) {
    console.error('[firestoreAccounts] ensureAuthUserWithProvider error:', err);
    return null;
  }
}

/**
 * Bind a provider identity to an existing user doc.
 * Returns false when the user doc is missing or the update fails.
 */
export async function linkProviderIdentity(
  userId:     string,
  provider:   LinkProvider,
  externalId: string,
): Promise<boolean> {
  const db = getFirestoreSafe();
  if (!db) return false;
  const col = providerToColumn(provider);
  try {
    const ref  = db.collection(AUTH_USERS).doc(userId);
    const snap = await ref.get();
    if (!snap.exists) return false;
    await ref.update({ [col]: externalId, updatedAt: Date.now() });
    return true;
  } catch (err) {
    console.error('[firestoreAccounts] linkProviderIdentity error:', err);
    return false;
  }
}

/**
 * Clear a provider binding. Caller is responsible for enforcing
 * "must have at least one provider left" semantics (matches route guard).
 */
export async function unlinkProviderIdentity(
  userId:   string,
  provider: LinkProvider,
): Promise<boolean> {
  const db = getFirestoreSafe();
  if (!db) return false;
  const col = providerToColumn(provider);
  try {
    const ref  = db.collection(AUTH_USERS).doc(userId);
    const snap = await ref.get();
    if (!snap.exists) return false;
    await ref.update({ [col]: null, updatedAt: Date.now() });
    return true;
  } catch (err) {
    console.error('[firestoreAccounts] unlinkProviderIdentity error:', err);
    return false;
  }
}

/**
 * Merge secondary into primary.
 *   - stats summed, ELO max, badges union
 *   - provider columns absorbed into primary when primary column is empty
 *   - game_records.playerId rewritten from secondary to primary (best-effort)
 *   - friendships follower/following rewritten + self-follow cleaned (best-effort)
 *   - secondary auth_user doc deleted
 *
 * The primary auth_user mutation runs in a Firestore batched write so it
 * remains atomic even if the later collection scans fail. Returns true on
 * success, false when the primary batch failed or inputs were invalid.
 */
export async function mergeUserAccounts(
  primaryId:   string,
  secondaryId: string,
): Promise<boolean> {
  if (primaryId === secondaryId) return false;
  const db = getFirestoreSafe();
  if (!db) return false;

  try {
    const primaryRef   = db.collection(AUTH_USERS).doc(primaryId);
    const secondaryRef = db.collection(AUTH_USERS).doc(secondaryId);

    const [primarySnap, secondarySnap] = await Promise.all([primaryRef.get(), secondaryRef.get()]);
    if (!primarySnap.exists || !secondarySnap.exists) return false;

    const primary   = (primarySnap.data()   ?? {}) as AuthUserDoc;
    const secondary = (secondarySnap.data() ?? {}) as AuthUserDoc;

    // 1. Absorb provider columns + email that primary lacks.
    const providerPatch: Record<string, unknown> = {};
    for (const col of ['discord_id', 'line_id', 'firebase_uid', 'email'] as const) {
      const pVal = primary[col];
      const sVal = secondary[col];
      const primaryEmpty = pVal === null || pVal === undefined || pVal === '';
      if (primaryEmpty && typeof sVal === 'string' && sVal.length > 0) {
        providerPatch[col] = sVal;
      }
    }

    // 2. Summed stats + merged badges + ELO max (conservative; avoids farming).
    const totalGames  = (primary.total_games ?? 0) + (secondary.total_games ?? 0);
    const gamesWon    = (primary.games_won   ?? 0) + (secondary.games_won   ?? 0);
    const gamesLost   = (primary.games_lost  ?? 0) + (secondary.games_lost  ?? 0);
    const eloRating   = Math.max(primary.elo_rating ?? 1000, secondary.elo_rating ?? 1000);
    const badgesUnion = Array.from(new Set([
      ...(primary.badges   ?? []),
      ...(secondary.badges ?? []),
    ]));

    // 3. Batched atomic write: clear secondary provider cols (avoid unique
    //    constraint-like double-bind), update primary, then delete secondary.
    const batch = db.batch();
    batch.update(secondaryRef, {
      discord_id:   null,
      line_id:      null,
      firebase_uid: null,
      updatedAt:    Date.now(),
    });
    batch.update(primaryRef, {
      ...providerPatch,
      elo_rating:  eloRating,
      total_games: totalGames,
      games_won:   gamesWon,
      games_lost:  gamesLost,
      badges:      badgesUnion,
      updatedAt:   Date.now(),
    });
    batch.delete(secondaryRef);
    await batch.commit();

    // 4. Best-effort cleanup: rewrite game_records + friendships; self-follow prune.
    //    Partial failure here is logged but not rolled back — the binding itself
    //    is already merged above.
    try {
      const recordsSnap = await db
        .collection(GAME_RECORDS)
        .where('playerId', '==', secondaryId)
        .get();
      if (!recordsSnap.empty) {
        const recBatch = db.batch();
        recordsSnap.docs.forEach((doc) => {
          recBatch.update(doc.ref, { playerId: primaryId });
        });
        await recBatch.commit();
      }
    } catch (err) {
      console.error('[firestoreAccounts] merge game_records rewrite failed (non-fatal):', err);
    }

    try {
      const followerSnap  = await db.collection(FRIENDSHIPS).where('follower_id',  '==', secondaryId).get();
      const followingSnap = await db.collection(FRIENDSHIPS).where('following_id', '==', secondaryId).get();
      const frBatch = db.batch();
      followerSnap.docs.forEach((doc) => {
        frBatch.update(doc.ref, { follower_id: primaryId });
      });
      followingSnap.docs.forEach((doc) => {
        frBatch.update(doc.ref, { following_id: primaryId });
      });
      if (!followerSnap.empty || !followingSnap.empty) {
        await frBatch.commit();
      }

      // Prune self-follow rows that the rewrite may have produced.
      const selfFollow = await db
        .collection(FRIENDSHIPS)
        .where('follower_id',  '==', primaryId)
        .where('following_id', '==', primaryId)
        .get();
      if (!selfFollow.empty) {
        const pruneBatch = db.batch();
        selfFollow.docs.forEach((doc) => pruneBatch.delete(doc.ref));
        await pruneBatch.commit();
      }
    } catch (err) {
      console.error('[firestoreAccounts] merge friendships rewrite failed (non-fatal):', err);
    }

    return true;
  } catch (err) {
    console.error('[firestoreAccounts] mergeUserAccounts error:', err);
    return false;
  }
}

/**
 * #42 bind-path fix：把訪客的戰績 / 好友關係搬到已 OAuth 綁定的真帳號。
 *
 * 訪客沒有 `auth_users` row（只有 games.playerId = guestUid 形式的戰績），
 * 因此無法直接走 `mergeUserAccounts`（那條路徑要求 primary + secondary 兩邊
 * 都有 user 文件）。這個 helper 專門處理「訪客 → 真帳號」流程：
 *
 *   - `games.playerId` 從 guestUid 改寫到 realUserId
 *   - `friendships.follower_id / following_id` 從 guestUid 改寫到 realUserId
 *   - self-follow 清理（同 mergeUserAccounts）
 *
 * 回傳是否成功（或 Firestore 不可用時回 false）。所有 sub-step 都是 best-effort：
 * 單一 step 失敗只會 log，不會中止整個流程 — 綁定本身已在 caller 完成。
 */
export async function absorbGuestIntoUser(
  guestUid:   string,
  realUserId: string,
): Promise<boolean> {
  if (guestUid === realUserId) return false;
  const db = getFirestoreSafe();
  if (!db) return false;

  try {
    // 1. games.playerId rewrite
    try {
      const recordsSnap = await db
        .collection(GAME_RECORDS)
        .where('playerId', '==', guestUid)
        .get();
      if (!recordsSnap.empty) {
        const recBatch = db.batch();
        recordsSnap.docs.forEach((doc) => {
          recBatch.update(doc.ref, { playerId: realUserId });
        });
        await recBatch.commit();
      }
    } catch (err) {
      console.error('[firestoreAccounts] absorbGuestIntoUser games rewrite failed (non-fatal):', err);
    }

    // 2. friendships rewrite + self-follow prune
    try {
      const followerSnap  = await db.collection(FRIENDSHIPS).where('follower_id',  '==', guestUid).get();
      const followingSnap = await db.collection(FRIENDSHIPS).where('following_id', '==', guestUid).get();
      const frBatch = db.batch();
      followerSnap.docs.forEach((doc) => {
        frBatch.update(doc.ref, { follower_id: realUserId });
      });
      followingSnap.docs.forEach((doc) => {
        frBatch.update(doc.ref, { following_id: realUserId });
      });
      if (!followerSnap.empty || !followingSnap.empty) {
        await frBatch.commit();
      }

      const selfFollow = await db
        .collection(FRIENDSHIPS)
        .where('follower_id',  '==', realUserId)
        .where('following_id', '==', realUserId)
        .get();
      if (!selfFollow.empty) {
        const pruneBatch = db.batch();
        selfFollow.docs.forEach((doc) => pruneBatch.delete(doc.ref));
        await pruneBatch.commit();
      }
    } catch (err) {
      console.error('[firestoreAccounts] absorbGuestIntoUser friendships rewrite failed (non-fatal):', err);
    }

    return true;
  } catch (err) {
    console.error('[firestoreAccounts] absorbGuestIntoUser error:', err);
    return false;
  }
}

// ── OAuth CSRF sessions ──────────────────────────────────────────────

/**
 * Persist a short-lived OAuth state token. 10-minute TTL enforced at consume
 * time by comparing expiresAt; a scheduled cleanup is out of scope (expired
 * rows are cheap to leave around since state tokens are single-use).
 *
 * `linkUserId` is populated when the OAuth redirect originated from a logged-in
 * user binding a new provider — the callback uses it to route to
 * handleLinkCallback instead of minting a brand-new JWT.
 */
export async function createOAuthSession(
  stateToken: string,
  provider:   'discord' | 'line',
  linkUserId?: string,
  isGuest?:   boolean,
  mode?:      'quickLogin',
): Promise<void> {
  const db = getFirestoreSafe();
  if (!db) return;
  try {
    await db.collection(OAUTH_SESSIONS).doc(stateToken).set({
      provider,
      expiresAt:  Date.now() + OAUTH_TTL_MS,
      linkUserId: linkUserId ?? null,
      isGuest:    isGuest === true,
      mode:       mode ?? null,
      createdAt:  Date.now(),
    });
  } catch (err) {
    console.error('[firestoreAccounts] createOAuthSession error:', err);
  }
}

/**
 * Validate + consume (single-use) an OAuth state token using a Firestore
 * transaction so concurrent callbacks can't both succeed.
 *
 * Returns:
 *   - `{ linkUserId }`    on success (linkUserId may be null when not linking)
 *   - `null`              when state missing / expired / provider mismatch
 *   - `{ linkUserId: null }` when Firestore unavailable (matches legacy
 *     "skip CSRF when DB not configured" behaviour so dev without firebase
 *     admin still sees login working).
 */
export async function consumeOAuthSession(
  stateToken: string,
  provider:   'discord' | 'line',
): Promise<OAuthSession | null> {
  const db = getFirestoreSafe();
  if (!db) return { linkUserId: null };
  try {
    const ref = db.collection(OAUTH_SESSIONS).doc(stateToken);
    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return null;
      const data = snap.data() as {
        provider?: 'discord' | 'line';
        expiresAt?: number;
        linkUserId?: string | null;
        isGuest?: boolean;
        mode?: 'quickLogin' | null;
      };
      if (data.provider !== provider) return null;
      if ((data.expiresAt ?? 0) < Date.now()) {
        tx.delete(ref);
        return null;
      }
      tx.delete(ref);
      return {
        linkUserId: data.linkUserId ?? null,
        isGuest:    data.isGuest === true,
        mode:       data.mode === 'quickLogin' ? 'quickLogin' : undefined,
      } as OAuthSession;
    });
    return result;
  } catch (err) {
    console.error('[firestoreAccounts] consumeOAuthSession error:', err);
    return null;
  }
}

/**
 * Legacy boolean verification signature retained for call sites that don't
 * care about linkUserId. Returns true when consume succeeded.
 */
export async function verifyAndDeleteOAuthSession(
  stateToken: string,
  provider:   'discord' | 'line',
): Promise<boolean> {
  const session = await consumeOAuthSession(stateToken, provider);
  return session !== null;
}
