/**
 * Core Avalon Game Type Definitions
 * Shared between frontend and backend
 */

// Game States
export type GameState = 'lobby' | 'voting' | 'quest' | 'discussion' | 'ended';

// Player Roles (Standard Avalon)
export type Role =
  | 'merlin'      // Good - Knows all Evil players
  | 'percival'    // Good - Knows Merlin (but might see Morgana)
  | 'loyal'       // Good - No special info
  | 'assassin'    // Evil - Can kill Merlin at end
  | 'morgana'     // Evil - Appears to Merlin as Evil
  | 'oberon';     // Evil - Hidden from Evil players (optional)

export type Team = 'good' | 'evil';

// Player Status
export type PlayerStatus = 'active' | 'disconnected' | 'idle';

// Voting Status
export type VoteStatus = 'pending' | 'approved' | 'rejected';

// Quest Result
export type QuestResult = 'success' | 'fail' | 'pending';

// Core Interfaces

export interface Player {
  id: string;
  name: string;
  avatar?: string;
  role: Role | null;
  team: Team | null;
  status: PlayerStatus;
  vote?: boolean | null; // true = approve, false = reject, null = not voted
  kills?: string[]; // IDs of players killed (for assassin)
  createdAt: number;
}

export interface Room {
  id: string;
  name: string;
  host: string;
  state: GameState;
  players: Record<string, Player>;
  maxPlayers: number;
  currentRound: number;
  maxRounds: number;
  votes: Record<string, boolean>; // playerId -> vote
  questTeam: string[]; // Player IDs in current quest
  questResults: QuestResult[]; // History of quest results
  failCount: number; // Number of failed votes
  evilWins: boolean | null; // null = not ended, true = evil won, false = good won
  leaderIndex: number; // Index of current quest leader in player list
  createdAt: number;
  updatedAt: number;
}

export interface GameConfig {
  minPlayers: number;
  maxPlayers: number;
  maxFailedVotes: number;
  roles: Role[];
  questTeams: number[]; // Team sizes for each round
}

// Game Statistics
export interface GameStats {
  totalGames: number;
  gamesWon: number;
  gamesLost: number;
  rolesPlayed: Record<Role, number>;
  winRateByRole: Record<Role, number>;
  averageGameDuration: number;
}

// Socket Events
export interface ClientToServerEvents {
  'game:join-room': (roomId: string, playerId: string) => void;
  'game:create-room': (playerName: string) => void;
  'game:start-game': (roomId: string) => void;
  'game:vote': (roomId: string, playerId: string, vote: boolean) => void;
  'game:submit-quest-result': (roomId: string, result: QuestResult) => void;
  'game:assassinate': (roomId: string, targetId: string) => void;
  'chat:send-message': (roomId: string, message: string) => void;
  'player:disconnect': (roomId: string, playerId: string) => void;
}

export interface ServerToClientEvents {
  'game:state-updated': (room: Room) => void;
  'game:player-joined': (player: Player) => void;
  'game:player-left': (playerId: string) => void;
  'game:started': (room: Room) => void;
  'game:voting-phase': (questTeam: string[]) => void;
  'game:voting-result': (approved: boolean, approvalCount: number) => void;
  'game:quest-phase': (questTeam: string[]) => void;
  'game:quest-result': (result: QuestResult) => void;
  'game:ended': (room: Room, winner: 'good' | 'evil') => void;
  'chat:message-received': (message: ChatMessage) => void;
  'error': (message: string) => void;
}

export interface ChatMessage {
  id: string;
  roomId: string;
  playerId: string;
  playerName: string;
  message: string;
  timestamp: number;
}

// Avalon Game Rules
export const AVALON_CONFIG: Record<number, GameConfig> = {
  5: {
    minPlayers: 5,
    maxPlayers: 5,
    maxFailedVotes: 3,
    roles: ['merlin', 'percival', 'loyal', 'assassin', 'morgana'],
    questTeams: [2, 3, 2, 3, 3],
  },
  6: {
    minPlayers: 6,
    maxPlayers: 6,
    maxFailedVotes: 3,
    roles: ['merlin', 'percival', 'loyal', 'loyal', 'assassin', 'morgana'],
    questTeams: [2, 3, 4, 3, 4],
  },
  7: {
    minPlayers: 7,
    maxPlayers: 7,
    maxFailedVotes: 3,
    roles: ['merlin', 'percival', 'loyal', 'loyal', 'assassin', 'morgana', 'morgana'],
    questTeams: [2, 3, 3, 4, 4],
  },
  8: {
    minPlayers: 8,
    maxPlayers: 8,
    maxFailedVotes: 3,
    roles: ['merlin', 'percival', 'loyal', 'loyal', 'assassin', 'morgana', 'morgana', 'oberon'],
    questTeams: [3, 4, 4, 5, 5],
  },
  9: {
    minPlayers: 9,
    maxPlayers: 9,
    maxFailedVotes: 3,
    roles: [
      'merlin',
      'percival',
      'loyal',
      'loyal',
      'loyal',
      'assassin',
      'morgana',
      'morgana',
      'oberon',
    ],
    questTeams: [3, 4, 4, 5, 5],
  },
  10: {
    minPlayers: 10,
    maxPlayers: 10,
    maxFailedVotes: 3,
    roles: [
      'merlin',
      'percival',
      'loyal',
      'loyal',
      'loyal',
      'loyal',
      'assassin',
      'morgana',
      'morgana',
      'oberon',
    ],
    questTeams: [3, 4, 5, 5, 5],
  },
};

export const DEFAULT_QUEST_ROUNDS = 5;
