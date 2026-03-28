import { Socket } from 'socket.io';
import { verifyIdToken, getUserProfile, createUserProfile, isFirebaseAdminReady } from '../services/firebase';
import { User } from '@avalon/shared';
import { v4 as uuidv4 } from 'uuid';

/**
 * Middleware to authenticate Socket.IO connections.
 *
 * Guest mode: if Firebase Admin SDK is not configured (no service account),
 * the server accepts a plain JSON token { uid, displayName } so users can
 * play without setting up Firebase credentials.
 */
export async function authenticateSocket(socket: Socket, next: (err?: Error) => void): Promise<void> {
  try {
    const token = socket.handshake.auth.token as string | undefined;

    if (!token) {
      return next(new Error('No token provided'));
    }

    // Guest / prototype mode — Firebase Admin not configured
    if (!isFirebaseAdminReady()) {
      let guestUser: User;
      try {
        const parsed = JSON.parse(token) as { uid?: string; displayName?: string };
        guestUser = {
          uid: parsed.uid || uuidv4(),
          email: '',
          displayName: parsed.displayName || 'Guest',
          photoURL: undefined,
          provider: 'google',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
      } catch {
        // token is not JSON — create a fully anonymous user
        guestUser = {
          uid: uuidv4(),
          email: '',
          displayName: 'Guest',
          photoURL: undefined,
          provider: 'google',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
      }
      socket.data.user = guestUser;
      socket.data.uid = guestUser.uid;
      console.log(`[guest] ${guestUser.displayName} (${guestUser.uid})`);
      return next();
    }

    // Normal mode — verify Firebase ID token
    let decodedToken;
    try {
      decodedToken = await verifyIdToken(token);
    } catch (error) {
      const msg = error instanceof Error ? error.message : '';
      return next(new Error(msg.includes('expired') ? 'Token expired' : 'Invalid token'));
    }

    const uid = decodedToken.uid;
    const email = decodedToken.email || '';
    const name = decodedToken.name || email.split('@')[0];
    const photoURL = decodedToken.picture;

    let userProfile = await getUserProfile(uid);
    if (!userProfile) {
      const newUser: User = {
        uid,
        email,
        displayName: name,
        photoURL,
        provider: decodedToken.firebase?.sign_in_provider === 'github.com' ? 'github' : 'google',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await createUserProfile(newUser);
      userProfile = newUser;
    }

    socket.data.user = userProfile;
    socket.data.uid = uid;
    console.log(`[auth] ${userProfile.displayName} (${uid})`);
    next();
  } catch (error) {
    console.error('Socket auth error:', error);
    next(new Error('Authentication failed'));
  }
}

export function requireAuth(socket: Socket, next: (err?: Error) => void): void {
  if (!socket.data.user) return next(new Error('Not authenticated'));
  next();
}
