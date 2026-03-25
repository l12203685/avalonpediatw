import { Socket } from 'socket.io';
import { verifyIdToken, getUserProfile, createUserProfile } from '../services/firebase';
import { User } from '@avalon/shared';

enum AuthErrorCode {
  NO_TOKEN = 'NO_TOKEN',
  INVALID_TOKEN = 'INVALID_TOKEN',
  EXPIRED_TOKEN = 'EXPIRED_TOKEN',
  UNKNOWN = 'UNKNOWN'
}

class AuthError extends Error {
  constructor(
    message: string,
    public code: AuthErrorCode
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

/**
 * Middleware to authenticate Socket.IO connections
 */
export async function authenticateSocket(socket: Socket, next: Function): Promise<void> {
  try {
    const token = socket.handshake.auth.token;

    if (!token) {
      return next(new AuthError('No token provided', AuthErrorCode.NO_TOKEN));
    }

    // Verify Firebase ID token
    let decodedToken;
    try {
      decodedToken = await verifyIdToken(token);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      if (errorMsg.includes('expired') || errorMsg.includes('auth/id-token-expired')) {
        throw new AuthError('Token has expired', AuthErrorCode.EXPIRED_TOKEN);
      }
      throw new AuthError('Invalid token', AuthErrorCode.INVALID_TOKEN);
    }

    const uid = decodedToken.uid;
    const email = decodedToken.email || '';
    const name = decodedToken.name || email.split('@')[0];
    const photoURL = decodedToken.picture;

    // Get or create user profile
    let userProfile = await getUserProfile(uid);

    if (!userProfile) {
      // Create new user profile
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

    // Attach user to socket
    socket.data.user = userProfile;
    socket.data.uid = uid;

    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      event: 'socket_authenticated',
      uid,
      displayName: userProfile.displayName,
      provider: userProfile.provider
    }));

    next();
  } catch (error) {
    if (error instanceof AuthError) {
      console.error(JSON.stringify({
        timestamp: new Date().toISOString(),
        event: 'auth_error',
        code: error.code,
        message: error.message
      }));
      return next(new Error(`Auth error [${error.code}]: ${error.message}`));
    }

    console.error('Socket authentication error:', error);
    next(new AuthError('Authentication failed', AuthErrorCode.UNKNOWN));
  }
}

/**
 * Middleware to require authentication
 */
export function requireAuth(socket: Socket, next: Function): void {
  if (!socket.data.user) {
    return next(new Error('Not authenticated'));
  }
  next();
}
