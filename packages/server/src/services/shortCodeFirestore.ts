// 玩家可見短碼 — Firestore 版（Task #48，路 B：放棄 Supabase 改 Firestore）
// ─────────────────────────────────────────────────────────────
// 資料模型：
//   - users/{uid}.shortCode            : 玩家擁有的短碼（正向）
//   - shortCodeIndex/{code}            : 反向索引 doc = { uid }，保唯一 + O(1) 查詢
//
// Unique 保證：
//   用 Firestore transaction 原子地 (a) 建 shortCodeIndex/{code} doc
//   (b) 回寫 users/{uid}.shortCode；若 index doc 已存在則撞碼重試。
//
// 純函式（generateShortCode / normalizeShortCode / isValidShortCode /
//        generateUniqueShortCode）繼續共用 ./shortCode。
//
// 相對舊 Supabase 版，唯一性從「DB unique index on NULLs allowed」
// 升級為「index doc 存在 = 佔用；tx read + create 原子」。
// 避免了 Supabase unique index 在高併發下偶發的 409 fallback 噪音。

import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { getAdminFirestore } from './firebase';
import {
  generateUniqueShortCode,
  isValidShortCode,
  normalizeShortCode,
} from './shortCode';

// Collections（小檔名常數化，避免 typo）
export const USERS_COLLECTION = 'users';
export const AUTH_USERS_COLLECTION = 'auth_users';
export const SHORT_CODE_INDEX_COLLECTION = 'shortCodeIndex';

/**
 * 依短碼查用戶 uid（走反向索引，O(1)）。
 * 格式非法 → 直接 null，不打 DB。
 *
 * @param code 玩家輸入或正規化過的短碼
 * @param db   可注入 Firestore（測試用）；預設走 getAdminFirestore()
 */
export async function getUserIdByShortCode(
  code: string,
  db?: Firestore,
): Promise<string | null> {
  const normalized = normalizeShortCode(code);
  if (!isValidShortCode(normalized)) return null;

  const firestore = db ?? getAdminFirestore();
  try {
    const snap = await firestore
      .collection(SHORT_CODE_INDEX_COLLECTION)
      .doc(normalized)
      .get();
    if (!snap.exists) return null;
    const data = snap.data() as { uid?: string } | undefined;
    return data?.uid ?? null;
  } catch (err) {
    console.error('[firestore] getUserIdByShortCode error:', err);
    return null;
  }
}

/**
 * 為缺少短碼的用戶 backfill，或直接回傳既有短碼。
 *
 * 流程：
 *  1. 讀 users/{uid}.shortCode；有 → 回傳
 *  2. 產生候選；每次以 transaction 檢查 shortCodeIndex/{code} 是否存在
 *  3. 不存在 → 原子寫入 index doc + users/{uid}.shortCode；完成
 *  4. 存在 → 回傳「已撞」觸發 generateUniqueShortCode 重試
 *
 * 失敗（Firebase 沒 init、tx 連續撞碼）→ null，呼叫端退化回 UUID 末 6 碼。
 *
 * @param uid  用戶 Firestore users 文件 id
 * @param db   可注入 Firestore（測試用）
 */
export async function ensureUserShortCode(
  uid: string,
  db?: Firestore,
): Promise<string | null> {
  if (!uid || typeof uid !== 'string') return null;

  let firestore: Firestore;
  try {
    firestore = db ?? getAdminFirestore();
  } catch {
    // Firebase admin 未 init → 退化
    return null;
  }

  try {
    const userRef = firestore.collection(USERS_COLLECTION).doc(uid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) return null;

    const existing = (userSnap.data() as { shortCode?: string } | undefined)?.shortCode;
    if (existing && isValidShortCode(existing)) return existing;

    // 生成未撞的短碼並原子寫入
    const code = await generateUniqueShortCode(async (candidate) => {
      return await tryClaimShortCode(firestore, uid, candidate);
    });

    return code;
  } catch (err) {
    console.error('[firestore] ensureUserShortCode error:', err);
    return null;
  }
}

/**
 * 嘗試在 transaction 內原子地把 `candidate` 短碼綁到 `uid`。
 *
 * 回傳：
 *   true  → 此候選已被佔用（要重試）
 *   false → 綁定成功（呼叫端把 candidate 當成新短碼）
 *
 * 這個「佔用 = true」的反向語意是為了對齊 generateUniqueShortCode
 * 的 `isTaken` callback 契約（見 ./shortCode.ts）。
 */
async function tryClaimShortCode(
  firestore: Firestore,
  uid: string,
  candidate: string,
): Promise<boolean> {
  const indexRef = firestore.collection(SHORT_CODE_INDEX_COLLECTION).doc(candidate);
  const userRef = firestore.collection(USERS_COLLECTION).doc(uid);

  return await firestore.runTransaction(async (tx: Transaction) => {
    const indexSnap = await tx.get(indexRef);
    if (indexSnap.exists) {
      const ownerUid = (indexSnap.data() as { uid?: string } | undefined)?.uid;
      // 同 uid 已持有同碼（極罕見 — 平行呼叫）→ 視為成功
      if (ownerUid === uid) return false;
      return true; // taken
    }

    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) {
      // 用戶消失（不應發生，但防呆）→ 視為撞碼讓上層重試/報錯
      return true;
    }

    tx.create(indexRef, { uid });
    tx.update(userRef, { shortCode: candidate });
    return false; // not taken, 成功綁定
  });
}

/**
 * Signup-path 版 ensure：針對剛在 `auth_users/{uid}` 建好 row 的新帳號產生短碼，
 * 並原子寫入 `shortCodeIndex/{code} = { uid }` + `auth_users/{uid}.shortCode = code`。
 *
 * 跟 `ensureUserShortCode` 的差別：
 *   - 這個寫 `auth_users`（password/OAuth signup 的實際用戶 collection），
 *     而不是舊的 `users`（legacy Supabase mirror）
 *   - 已有 `shortCode` → 直接回傳不動
 *   - 失敗（Firestore 不可用 / 撞碼重試耗盡）→ null；caller 應 best-effort 處理
 *
 * 為何要新增而非改舊的：`ensureUserShortCode` 走 `users/{uid}` 是設計上為了
 * legacy mirror；signup 新帳號只會被建在 `auth_users/{uid}`，重用會因「users doc
 * 不存在 → 視為撞碼」讓整個流程失敗。2026-04-24 #48 修復新增這個函式明確給
 * signup 路徑用。
 *
 * @param uid  auth_users doc id
 * @param db   可注入 Firestore（測試用）
 */
export async function assignShortCodeToAuthUser(
  uid: string,
  db?: Firestore,
): Promise<string | null> {
  if (!uid || typeof uid !== 'string') return null;

  let firestore: Firestore;
  try {
    firestore = db ?? getAdminFirestore();
  } catch {
    // Firebase admin 未 init → 退化
    return null;
  }

  try {
    const userRef = firestore.collection(AUTH_USERS_COLLECTION).doc(uid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      // 本函式前提：caller 剛剛建好 auth_users/{uid}。doc 不存在 → 放棄（不建假 row）。
      return null;
    }

    const existing = (userSnap.data() as { shortCode?: string } | undefined)?.shortCode;
    if (existing && isValidShortCode(existing)) return existing;

    // 生成未撞的短碼並原子寫入
    const code = await generateUniqueShortCode(async (candidate) => {
      return await tryClaimShortCodeForAuthUser(firestore, uid, candidate);
    });

    return code;
  } catch (err) {
    console.error('[firestore] assignShortCodeToAuthUser error:', err);
    return null;
  }
}

/**
 * 跟 `tryClaimShortCode` 一樣但寫入 `auth_users/{uid}.shortCode`（不是 `users/{uid}`）。
 *
 * 回傳：
 *   true  → 此候選已被佔用（要重試）
 *   false → 綁定成功
 */
async function tryClaimShortCodeForAuthUser(
  firestore: Firestore,
  uid: string,
  candidate: string,
): Promise<boolean> {
  const indexRef = firestore.collection(SHORT_CODE_INDEX_COLLECTION).doc(candidate);
  const userRef  = firestore.collection(AUTH_USERS_COLLECTION).doc(uid);

  return await firestore.runTransaction(async (tx: Transaction) => {
    const indexSnap = await tx.get(indexRef);
    if (indexSnap.exists) {
      const ownerUid = (indexSnap.data() as { uid?: string } | undefined)?.uid;
      // 同 uid 已持有同碼（極罕見 — 平行呼叫）→ 視為成功
      if (ownerUid === uid) return false;
      return true; // taken
    }

    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) {
      // auth_users doc 消失（不應發生；caller 剛建）→ 視為撞碼讓上層重試/放棄
      return true;
    }

    tx.create(indexRef, { uid });
    tx.update(userRef, { shortCode: candidate });
    return false; // not taken, 成功綁定
  });
}

/**
 * Firestore users doc 是否存在（對應舊 friends.ts 的 userExists）。
 */
export async function firestoreUserExists(
  uid: string,
  db?: Firestore,
): Promise<boolean> {
  if (!uid || typeof uid !== 'string') return false;
  let firestore: Firestore;
  try {
    firestore = db ?? getAdminFirestore();
  } catch {
    return false;
  }
  try {
    const snap = await firestore.collection(USERS_COLLECTION).doc(uid).get();
    return snap.exists;
  } catch (err) {
    console.error('[firestore] firestoreUserExists error:', err);
    return false;
  }
}
