import { initializeApp } from 'firebase/app';
import { getDatabase } from 'firebase/database';
import { getAuth } from 'firebase/auth';

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

let firebaseApp: any;
let database: any;
let auth: any;

export async function initializeFirebase(): Promise<void> {
  try {
    // Initialize Firebase App
    firebaseApp = initializeApp(firebaseConfig);

    // Get database and auth references
    database = getDatabase(firebaseApp);
    auth = getAuth(firebaseApp);

    console.log('✓ Firebase initialized successfully');
  } catch (error) {
    console.error('Firebase initialization error:', error);
    throw error;
  }
}

export function getFirebaseDB(): any {
  if (!database) {
    throw new Error('Firebase database not initialized');
  }
  return database;
}

export function getFirebaseAuth(): any {
  if (!auth) {
    throw new Error('Firebase auth not initialized');
  }
  return auth;
}

export function getFirebaseApp(): any {
  if (!firebaseApp) {
    throw new Error('Firebase app not initialized');
  }
  return firebaseApp;
}
