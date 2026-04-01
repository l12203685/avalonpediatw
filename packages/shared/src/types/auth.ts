/**
 * Authentication and User Type Definitions
 * Shared between frontend and backend
 */

export type AuthProvider = 'google' | 'discord' | 'line' | 'email' | 'guest';

export interface User {
  uid: string;
  email?: string;
  displayName: string;
  photoURL?: string;
  provider: AuthProvider;
  createdAt: number;
  updatedAt: number;
}

export interface AuthToken {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  expiresAt: number;
}

export interface AuthSession {
  user: User;
  token: AuthToken;
  isAuthenticated: boolean;
}

export interface UserProfile extends User {
  totalGames: number;
  gamesWon: number;
  gamesLost: number;
  totalKills: number;
  winRate: number;
  averageGameDuration: number;
  favoriteRole?: string;
  eloRating: number;
  badges: string[];
}

export interface UserStats {
  userId: string;
  totalGames: number;
  gamesWon: number;
  gamesLost: number;
  rolesPlayed: Record<string, number>;
  winRateByRole: Record<string, number>;
  totalKills: number;
  averageGameDuration: number;
  lastGameAt: number;
  eloRating: number;
  updatedAt: number;
}

// Socket.IO Auth Events
export interface ClientToServerAuthEvents {
  'auth:login': (token: string) => void;
  'auth:logout': () => void;
  'auth:refresh': (refreshToken: string) => void;
  'user:update-profile': (profile: Partial<User>) => void;
}

export interface ServerToClientAuthEvents {
  'auth:success': (session: AuthSession) => void;
  'auth:error': (error: string) => void;
  'auth:logout-success': () => void;
  'user:profile-updated': (user: User) => void;
}
