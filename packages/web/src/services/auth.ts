import { initializeApp, FirebaseApp } from 'firebase/app';
import {
  getAuth,
  signInWithPopup,
  signOut,
  GoogleAuthProvider,
  GithubAuthProvider,
  User as FirebaseUser,
  onAuthStateChanged,
  Auth,
} from 'firebase/auth';
import { User, AuthSession } from '@avalon/shared';

// Firebase config
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

let firebaseApp: FirebaseApp | undefined;
let auth: Auth | undefined;

export function initializeAuth(): void {
  if (!firebaseApp) {
    firebaseApp = initializeApp(firebaseConfig);
    auth = getAuth(firebaseApp);
  }
}

export function getFirebaseAuth(): Auth {
  if (!auth) {
    throw new Error('Firebase auth not initialized');
  }
  return auth;
}

/**
 * Sign in with Google
 */
export async function signInWithGoogle(): Promise<FirebaseUser> {
  try {
    const auth = getFirebaseAuth();
    const provider = new GoogleAuthProvider();
    const result = await signInWithPopup(auth, provider);
    return result.user;
  } catch (error) {
    console.error('Google sign-in error:', error);
    throw error;
  }
}

/**
 * Sign in with GitHub
 */
export async function signInWithGithub(): Promise<FirebaseUser> {
  try {
    const auth = getFirebaseAuth();
    const provider = new GithubAuthProvider();
    const result = await signInWithPopup(auth, provider);
    return result.user;
  } catch (error) {
    console.error('GitHub sign-in error:', error);
    throw error;
  }
}

/**
 * Sign out
 */
export async function logout(): Promise<void> {
  try {
    const auth = getFirebaseAuth();
    await signOut(auth);
  } catch (error) {
    console.error('Sign-out error:', error);
    throw error;
  }
}

/**
 * Get current user and ID token
 */
export async function getCurrentUserWithToken(): Promise<{
  user: FirebaseUser;
  token: string;
} | null> {
  const auth = getFirebaseAuth();
  const user = auth.currentUser;

  if (!user) {
    return null;
  }

  const token = await user.getIdToken();
  return { user, token };
}

/**
 * Convert Firebase user to App User
 */
export function firebaseUserToAppUser(firebaseUser: FirebaseUser, provider: string): User {
  const email = firebaseUser.email || '';
  const creationTime = firebaseUser.metadata?.creationTime;
  const createdAt = creationTime ? new Date(creationTime).getTime() : Date.now();

  return {
    uid: firebaseUser.uid,
    email,
    displayName: firebaseUser.displayName || email.split('@')[0] || 'Unknown',
    photoURL: firebaseUser.photoURL || undefined,
    provider: provider as 'google' | 'github',
    createdAt,
    updatedAt: Date.now(),
  };
}

/**
 * Listen to auth state changes
 */
export function onAuthStateChange(
  callback: (userWithToken: { user: User; token: string } | null) => void
): () => void {
  const auth = getFirebaseAuth();

  const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
    if (firebaseUser) {
      const token = await firebaseUser.getIdToken();
      const provider = firebaseUser.providerData[0]?.providerId?.split('.')[0] || 'google';
      const appUser = firebaseUserToAppUser(firebaseUser, provider);

      callback({ user: appUser, token });
    } else {
      callback(null);
    }
  });

  return unsubscribe;
}

/**
 * Get fresh ID token
 */
export async function getIdToken(): Promise<string> {
  const auth = getFirebaseAuth();
  const user = auth.currentUser;

  if (!user) {
    throw new Error('No user signed in');
  }

  return await user.getIdToken(true);
}
