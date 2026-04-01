import { Socket } from 'socket.io';
import { verify, JwtPayload } from 'jsonwebtoken';
import { verifyIdToken, getUserProfile, createUserProfile, isFirebaseAdminReady } from '../services/firebase';
import { upsertUser } from '../services/supabase';
import { User } from '@avalon/shared';
import { v4 as uuidv4 } from 'uuid';

const JWT_SECRET = process.env.JWT_SECRET || 'avalon-dev-secret-change-in-prod';

/** 嘗試以自訂 JWT 驗證（Discord / Line OAuth 發行） */
function verifyCustomJwt(token: string): (JwtPayload & { sub: string; displayName: string; provider: string }) | null {
  try {
    const payload = verify(token, JWT_SECRET) as JwtPayload;
    if (payload.sub && payload.displayName) {
      return payload as JwtPayload & { sub: string; displayName: string; provider: string };
    }
    return null;
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
    if (isFirebaseAdminReady()) {
      let decodedToken;
      try {
        decodedToken = await verifyIdToken(token);
      } catch (error) {
        const msg = error instanceof Error ? error.message : '';
        // 如果是明確的 Firebase token 錯誤，直接拒絕
        if (msg.includes('expired')) return next(new Error('Token expired'));
        if (!msg.includes('JSON') && !msg.includes('invalid')) {
          return next(new Error('Invalid token'));
        }
        // 否則 fallthrough 到路徑 3（guest JSON）
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

    // ── 路徑 3：Guest JSON { uid, displayName }──────────────
    let guestUser: User;
    try {
      const parsed = JSON.parse(token) as { uid?: string; displayName?: string };
      guestUser = {
        uid:         parsed.uid || uuidv4(),
        email:       '',
        displayName: parsed.displayName || 'Guest',
        photoURL:    undefined,
        provider:    'guest',
        createdAt:   Date.now(),
        updatedAt:   Date.now(),
      };
    } catch {
      guestUser = { uid: uuidv4(), email: '', displayName: 'Guest', photoURL: undefined, provider: 'guest', createdAt: Date.now(), updatedAt: Date.now() };
    }
    socket.data.user = guestUser;
    socket.data.uid  = guestUser.uid;
    console.log(`[guest] ${guestUser.displayName} (${guestUser.uid})`);
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
