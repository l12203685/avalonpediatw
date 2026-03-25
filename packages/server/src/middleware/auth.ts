import { Socket } from 'socket.io';
import { verifyIdToken, getUserProfile, createUserProfile } from '../services/firebase';
import { User } from '@avalon/shared';

/**
 * Middleware to authenticate Socket.IO connections
 */
export async function authenticateSocket(socket: Socket, next: Function): Promise<void> {
  try {
    const token = socket.handshake.auth.token;

    if (!token) {
      return next(new Error('Authentication error: No token provided'));
    }

    // Verify Firebase ID token
    const decodedToken = await verifyIdToken(token);
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

    console.log(`✓ Socket authenticated: ${userProfile.displayName} (${uid})`);
    next();
  } catch (error) {
    console.error('Socket authentication error:', error);
    next(new Error(`Authentication error: ${error instanceof Error ? error.message : 'Unknown error'}`));
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
