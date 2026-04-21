import { initializeApp, FirebaseApp } from 'firebase/app';
import { getDatabase, Database } from 'firebase/database';
import { getAuth, Auth } from 'firebase/auth';
import * as admin from 'firebase-admin';
import { User, UserProfile } from '@avalon/shared';
import { Firestore } from 'firebase-admin/firestore';

// Firebase config (will be set from environment)
const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.FIREBASE_APP_ID,
  databaseURL: `https://${process.env.FIREBASE_PROJECT_ID}.firebaseio.com`,
};

let firebaseApp: FirebaseApp | null = null;
let database: Database | null = null;
let auth: Auth | null = null;
let adminApp: admin.app.App | null = null;

export async function initializeFirebase(): Promise<void> {
  const hasConfig = !!(process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_API_KEY);

  if (!hasConfig) {
    console.log('⚠ Firebase config missing — running in guest-only mode');
    return;
  }

  try {
    // Initialize Firebase App (client SDK)
    firebaseApp = initializeApp(firebaseConfig);
    database = getDatabase(firebaseApp);
    auth = getAuth(firebaseApp);

    // Initialize Firebase Admin (server SDK)
    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
      adminApp = admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: `https://${process.env.FIREBASE_PROJECT_ID}.firebaseio.com`,
      });
    } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      // Support ADC (Application Default Credentials) for local dev
      adminApp = admin.initializeApp({
        databaseURL: `https://${process.env.FIREBASE_PROJECT_ID}.firebaseio.com`,
      });
    }

    console.log('✓ Firebase initialized successfully');
  } catch (error) {
    console.error('Firebase initialization error:', error);
    // Don't crash — fall back to guest-only mode
  }
}

export function getFirebaseDB(): Database {
  if (!database) {
    throw new Error('Firebase database not initialized');
  }
  return database;
}

export function getFirebaseAuth(): Auth {
  if (!auth) {
    throw new Error('Firebase auth not initialized');
  }
  return auth;
}

export function getFirebaseApp(): FirebaseApp {
  if (!firebaseApp) {
    throw new Error('Firebase app not initialized');
  }
  return firebaseApp;
}

export function isFirebaseAdminReady(): boolean {
  return adminApp !== null;
}

export function getAdminAuth(): admin.auth.Auth {
  if (!adminApp) {
    throw new Error('Firebase admin not initialized');
  }
  return admin.auth(adminApp);
}

export function getAdminDB(): admin.database.Database {
  if (!adminApp) {
    throw new Error('Firebase admin not initialized');
  }
  return admin.database(adminApp);
}

export function getAdminFirestore(): Firestore {
  if (!adminApp) {
    throw new Error('Firebase admin not initialized');
  }
  return admin.firestore(adminApp);
}

/**
 * Verify Firebase ID Token
 */
export async function verifyIdToken(idToken: string): Promise<admin.auth.DecodedIdToken> {
  try {
    const decodedToken = await getAdminAuth().verifyIdToken(idToken);
    return decodedToken;
  } catch (error) {
    // 呼叫端(auth middleware) 會處理「非 Firebase token」的 fallthrough,不是每次失敗
    // 都是 error。這裡壓成 throw 讓呼叫端決定嚴重性;verbose log 留給 DEBUG_FIREBASE_AUTH。
    if (process.env.DEBUG_FIREBASE_AUTH === 'true') {
      console.error('Token verification error:', error);
    }
    throw new Error('Invalid token');
  }
}

/**
 * Create a new user in Realtime Database
 */
export async function createUserProfile(user: User): Promise<void> {
  const db = getAdminDB();
  const userRef = db.ref(`users/${user.uid}`);

  await userRef.set({
    ...user,
    totalGames: 0,
    gamesWon: 0,
    gamesLost: 0,
    winRate: 0,
    eloRating: 1000,
    badges: [],
  });
}

/**
 * Get user profile from database
 */
export async function getUserProfile(uid: string): Promise<User | null> {
  const db = getAdminDB();
  const userRef = db.ref(`users/${uid}`);

  const snapshot = await userRef.once('value');
  return snapshot.val() as User | null;
}

/**
 * Update user profile
 */
export async function updateUserProfile(uid: string, updates: Partial<User>): Promise<void> {
  const db = getAdminDB();
  const userRef = db.ref(`users/${uid}`);

  await userRef.update({
    ...updates,
    updatedAt: Date.now(),
  });
}

interface UserStats {
  totalGames: number;
  gamesWon: number;
  gamesLost: number;
  rolesPlayed: Record<string, number>;
  eloRating: number;
  totalKills?: number;
  averageGameDuration?: number;
  lastGameAt?: number;
  updatedAt?: number;
}

/**
 * Get user game statistics
 */
export async function getUserStats(uid: string): Promise<UserStats | null> {
  const db = getAdminDB();
  const statsRef = db.ref(`user-stats/${uid}`);

  const snapshot = await statsRef.once('value');
  return snapshot.val() as UserStats | null;
}

/**
 * Update user statistics after game
 */
export async function updateUserStats(
  uid: string,
  gameResult: {
    won: boolean;
    role: string;
    duration: number;
    kills?: number;
  }
): Promise<void> {
  const db = getAdminDB();
  const statsRef = db.ref(`user-stats/${uid}`);

  const current = (await statsRef.once('value')).val() || {
    totalGames: 0,
    gamesWon: 0,
    gamesLost: 0,
    rolesPlayed: {},
    eloRating: 1000,
  };

  const newElo = calculateElo(current.eloRating, gameResult.won);

  await statsRef.update({
    totalGames: (current.totalGames || 0) + 1,
    gamesWon: gameResult.won ? (current.gamesWon || 0) + 1 : current.gamesWon,
    gamesLost: !gameResult.won ? (current.gamesLost || 0) + 1 : current.gamesLost,
    [`rolesPlayed/${gameResult.role}`]: (current.rolesPlayed?.[gameResult.role] || 0) + 1,
    totalKills: (current.totalKills || 0) + (gameResult.kills || 0),
    averageGameDuration:
      ((current.averageGameDuration || 0) * (current.totalGames || 1) + gameResult.duration) /
      ((current.totalGames || 1) + 1),
    eloRating: newElo,
    lastGameAt: Date.now(),
    updatedAt: Date.now(),
  });
}

/**
 * Simple ELO calculation
 */
function calculateElo(currentElo: number, won: boolean, K = 32): number {
  if (won) {
    return currentElo + K;
  } else {
    return Math.max(0, currentElo - K);
  }
}

/**
 * Get leaderboard — top N players sorted by ELO descending
 */
export async function getLeaderboard(limit = 50): Promise<(UserStats & { uid: string })[]> {
  const db = getAdminDB();
  const snapshot = await db.ref('user-stats')
    .orderByChild('eloRating')
    .limitToLast(limit)
    .once('value');

  const results: (UserStats & { uid: string })[] = [];
  snapshot.forEach((child) => {
    const val = child.val() as UserStats;
    if (val) results.push({ ...val, uid: child.key as string });
  });

  return results.reverse(); // highest ELO first
}

/**
 * Get full user profile merged with stats — used for profile page
 */
export async function getFullUserProfile(uid: string): Promise<UserProfile | null> {
  const [user, stats] = await Promise.all([getUserProfile(uid), getUserStats(uid)]);
  if (!user) return null;

  return {
    ...user,
    totalGames: stats?.totalGames ?? 0,
    gamesWon: stats?.gamesWon ?? 0,
    gamesLost: stats?.gamesLost ?? 0,
    totalKills: stats?.totalKills ?? 0,
    winRate: stats?.totalGames ? (stats.gamesWon / stats.totalGames) * 100 : 0,
    averageGameDuration: stats?.averageGameDuration ?? 0,
    eloRating: stats?.eloRating ?? 1000,
    badges: [],
  };
}
