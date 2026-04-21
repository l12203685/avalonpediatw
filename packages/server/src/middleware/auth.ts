import { Socket } from 'socket.io';
import { verify, JwtPayload } from 'jsonwebtoken';
import { verifyIdToken, getUserProfile, createUserProfile, isFirebaseAdminReady } from '../services/firebase';
import { upsertUser } from '../services/supabase';
import { User } from '@avalon/shared';
import { verifyGuestToken } from './guestAuth';

const JWT_SECRET = process.env.JWT_SECRET as string;

/** 嘗試以自訂 JWT 驗證（Discord / Line OAuth 發行）；不吞 guest JWT。 */
function verifyCustomJwt(token: string): (JwtPayload & { sub: string; displayName: string; provider: string }) | null {
  try {
    const payload = verify(token, JWT_SECRET) as JwtPayload & { provider?: string };
    if (!payload.sub || !payload.displayName) return null;
    // 我們自己簽的 guest JWT 也會過 verify，但 provider === 'guest' 表示應走 guest
    // 路徑（socket.data.supabaseId 不是 Supabase UUID），這裡必須跳過。
    if (payload.provider === 'guest') return null;
    return payload as JwtPayload & { sub: string; displayName: string; provider: string };
  } catch {
    return null;
  }
}

/**
 * Socket.IO 認證 Middleware
 *
 * 依序嘗試三種 token 格式：
 * 1. 自訂 JWT（Discord / Line OAuth）
 * 2. Firebase ID Token（Google / Email）
 * 3. Guest JSON { uid, displayName }
 */
export async function authenticateSocket(socket: Socket, next: (err?: Error) => void): Promise<void> {
  try {
    const token = socket.handshake.auth.token as string | undefined;
    if (!token) return next(new Error('No token provided'));

    // ── 路徑 1：自訂 JWT（Discord / Line）──────────────────
    const customPayload = verifyCustomJwt(token);
    if (customPayload) {
      const user: User = {
        uid:         customPayload.sub,
        email:       '',
        displayName: customPayload.displayName,
        photoURL:    undefined,
        provider:    (customPayload.provider as User['provider']) || 'discord',
        createdAt:   Date.now(),
        updatedAt:   Date.now(),
      };
      socket.data.user       = user;
      socket.data.uid        = user.uid;
      socket.data.supabaseId = customPayload.sub; // sub IS the supabase UUID for Discord/Line
      console.log(`[custom-jwt] ${user.displayName} (${customPayload.provider})`);
      return next();
    }

    // ── 路徑 2：Firebase Admin 驗證（Google / Email）────────
    // 只對看起來像 JWT 的 token（三段 dot-separated）才嘗試 Firebase 驗證；
    // 否則直接 fallthrough 到 guest path，避免 guest JSON 被誤判成 Invalid token。
    const looksLikeJwt = typeof token === 'string' && token.split('.').length === 3;
    let decodedToken: Awaited<ReturnType<typeof verifyIdToken>> | null = null;
    if (isFirebaseAdminReady() && looksLikeJwt) {
      try {
        decodedToken = await verifyIdToken(token);
      } catch (error) {
        const msg = (error instanceof Error ? error.message : '').toLowerCase();
        // 只有 token 過期 / revoked 才真的終止;其他驗不過(缺 kid / 非 Firebase 簽發 / 格式不符)
        // 就 fallthrough 到下面的 guest / custom path 繼續嘗試,因為 guest 和 Discord/Line
        // 用的也是三段式 JWT 但不是 Firebase 簽的。
        if (msg.includes('expired') || msg.includes('revoked')) {
          return next(new Error('Token expired'));
        }
        decodedToken = null;
      }

      if (decodedToken) {
        const uid      = decodedToken.uid;
        const email    = decodedToken.email || '';
        const name     = decodedToken.name  || email.split('@')[0];
        const photoURL = decodedToken.picture;
        const rawProvider = decodedToken.firebase?.sign_in_provider || 'google.com';
        const provider: User['provider'] = rawProvider.includes('google') ? 'google' : 'email';

        let userProfile = await getUserProfile(uid);
        if (!userProfile) {
          const newUser: User = { uid, email, displayName: name, photoURL, provider, createdAt: Date.now(), updatedAt: Date.now() };
          await createUserProfile(newUser);
          userProfile = newUser;
        }

        // 每次登入都 upsert Supabase（保持 display_name/photo_url 最新）
        const supabaseUserId = await upsertUser({ firebase_uid: uid, display_name: name, email, photo_url: photoURL, provider });

        socket.data.user       = userProfile;
        socket.data.uid        = uid;
        socket.data.supabaseId = supabaseUserId;
        console.log(`[firebase] ${userProfile.displayName} (${uid})`);
        return next();
      }
    }

    // ── 路徑 3：Guest — server-signed JWT (新) 或 legacy JSON (3 天 grace)───
    //
    // S10 fix (Plan v2 R1.0): 過去這裡信任 client 送的 JSON `{uid, displayName}`，
    // 攻擊者能用受害者 uid 偽造連線污染其統計。現在統一透過 verifyGuestToken
    // 驗證：新 client 拿到 server-signed JWT；舊 client 的 JSON token 保留 3 天
    // grace 期讓現有玩家無感升級，之後強制重新取 token。
    const guestIdentity = verifyGuestToken(token);
    if (!guestIdentity) {
      return next(new Error('Guest token expired — please re-enter as guest'));
    }
    const guestUser: User = {
      uid:         guestIdentity.uid,
      email:       '',
      displayName: guestIdentity.displayName,
      photoURL:    undefined,
      provider:    'guest',
      createdAt:   Date.now(),
      updatedAt:   Date.now(),
    };
    socket.data.user = guestUser;
    socket.data.uid  = guestUser.uid;
    console.log(`[guest${guestIdentity.signed ? ':signed' : ':legacy'}] ${guestUser.displayName} (${guestUser.uid})`);
    return next();

  } catch (error) {
    console.error('Socket auth error:', error);
    return next(new Error('Authentication failed'));
  }
}

export function requireAuth(socket: Socket, next: (err?: Error) => void): void {
  if (!socket.data.user) return next(new Error('Not authenticated'));
  next();
}
