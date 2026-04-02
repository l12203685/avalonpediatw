/**
 * Core Avalon Game Type Definitions
 * Shared between frontend and backend
 */

// Game States
export type GameState = 'lobby' | 'voting' | 'quest' | 'lady_of_the_lake' | 'discussion' | 'ended';

// Player Roles (Standard Avalon)
export type Role =
  | 'merlin'      // Good - Knows all Evil players (except Mordred)
  | 'percival'    // Good - Knows Merlin (but might see Morgana)
  | 'loyal'       // Good - No special info
  | 'assassin'    // Evil - Can kill Merlin at end; knows teammates
  | 'morgana'     // Evil - Appears to Percival as possible Merlin; knows teammates
  | 'oberon'      // Evil - Hidden from Evil players (and can't see them)
  | 'mordred'     // Evil - Hidden from Merlin; knows other evil teammates
  | 'minion';     // Evil - Generic evil minion (substitute when optional evil roles disabled)

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
  isBot?: boolean;  // true = AI-controlled player
  botDifficulty?: 'easy' | 'normal' | 'hard'; // AI difficulty level (only set when isBot=true)
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
  voteHistory: VoteRecord[];   // All team-vote records (public info for deduction)
  questHistory: QuestRecord[]; // All completed quest records
  questVotedCount: number;     // How many quest team members have submitted their vote (count only, not direction)
  endReason?: 'failed_quests' | 'vote_rejections' | 'merlin_assassinated' | 'assassination_failed' | 'assassination_timeout'; // Why game ended
  assassinTargetId?: string;   // ID of the player the assassin targeted (set on game end)
  roleOptions: RoleOptions;    // Host-configured optional role toggles
  readyPlayerIds: string[];    // Player IDs who clicked "Ready" in lobby
  isPrivate?: boolean;         // Room requires password to join
  eloDeltas?: Record<string, number>; // playerId -> elo delta (populated on game end)
  // Lady of the Lake
  ladyOfTheLakeHolder?: string;     // Player ID who currently holds the Lady token
  ladyOfTheLakeTarget?: string;     // Player ID being inspected (during lady_of_the_lake phase)
  ladyOfTheLakeResult?: 'good' | 'evil'; // Result shown to the holder (private, cleared after phase)
  ladyOfTheLakeUsed?: string[];     // Player IDs who have already held the Lady (cannot be targeted again)
  ladyOfTheLakeEnabled?: boolean;   // Whether Lady of the Lake is active in this game
  ladyOfTheLakeHistory?: LadyOfTheLakeRecord[]; // Completed Lady inspections (public info: holder->target, result visible only to holder)
  createdAt: number;
  updatedAt: number;
}

/** Host-configurable role toggles for optional special roles */
export interface RoleOptions {
  percival: boolean;  // Include Percival + Morgana (must be toggled together for balance)
  morgana: boolean;   // Include Morgana (paired with Percival)
  oberon: boolean;    // Include Oberon (evil unknown to other evil)
  mordred: boolean;   // Include Mordred (hidden from Merlin)
  ladyOfTheLake?: boolean; // Include Lady of the Lake ability (default: true for 7+ players)
}

export interface GameConfig {
  minPlayers: number;
  maxPlayers: number;
  maxFailedVotes: number;
  roles: Role[];
  questTeams: number[]; // Team sizes for each round
  questFailsRequired: number[]; // Fail votes needed per round (usually 1; round 4 in 7+ player = 2)
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

// Public vote record (all votes are public in Avalon)
export interface VoteRecord {
  round:    number;
  attempt:  number;   // attempt number within the round (1-5)
  leader:   string;   // player ID of the leader who proposed the team
  team:     string[]; // proposed team player IDs
  approved: boolean;  // true = team approved, false = rejected
  votes:    Record<string, boolean>; // playerId -> vote
}

// Quest outcome record
export interface QuestRecord {
  round:     number;
  team:      string[]; // player IDs on the quest
  result:    'success' | 'fail';
  failCount: number;   // number of fail votes submitted
}

// Lady of the Lake inspection record
export interface LadyOfTheLakeRecord {
  round:    number;
  holderId: string;   // player who held the Lady
  targetId: string;   // player who was inspected
  result:   'good' | 'evil'; // what the holder saw
}

export interface ChatMessage {
  id: string;
  roomId: string;
  playerId: string;
  playerName: string;
  message: string;
  timestamp: number;
}

// Avalon Game Rules — standard player counts, team sizes, and role assignments
export const AVALON_CONFIG: Record<number, GameConfig> = {
  5: {
    // 3 good, 2 evil
    minPlayers: 5,
    maxPlayers: 5,
    maxFailedVotes: 5,
    roles: ['merlin', 'percival', 'loyal', 'assassin', 'morgana'],
    questTeams: [2, 3, 2, 3, 3],
    questFailsRequired: [1, 1, 1, 1, 1],
  },
  6: {
    // 4 good, 2 evil
    minPlayers: 6,
    maxPlayers: 6,
    maxFailedVotes: 5,
    roles: ['merlin', 'percival', 'loyal', 'loyal', 'assassin', 'morgana'],
    questTeams: [2, 3, 4, 3, 4],
    questFailsRequired: [1, 1, 1, 1, 1],
  },
  7: {
    // 4 good, 3 evil — Round 4 requires 2 fail votes
    minPlayers: 7,
    maxPlayers: 7,
    maxFailedVotes: 5,
    roles: ['merlin', 'percival', 'loyal', 'loyal', 'assassin', 'morgana', 'oberon'],
    questTeams: [2, 3, 3, 4, 4],
    questFailsRequired: [1, 1, 1, 2, 1],
  },
  8: {
    // 5 good, 3 evil — Round 4 requires 2 fail votes
    minPlayers: 8,
    maxPlayers: 8,
    maxFailedVotes: 5,
    roles: ['merlin', 'percival', 'loyal', 'loyal', 'loyal', 'assassin', 'morgana', 'mordred'],
    questTeams: [3, 4, 4, 5, 5],
    questFailsRequired: [1, 1, 1, 2, 1],
  },
  9: {
    // 6 good, 3 evil — Round 4 requires 2 fail votes
    minPlayers: 9,
    maxPlayers: 9,
    maxFailedVotes: 5,
    roles: [
      'merlin',
      'percival',
      'loyal',
      'loyal',
      'loyal',
      'loyal',
      'assassin',
      'morgana',
      'mordred',
    ],
    questTeams: [3, 4, 4, 5, 5],
    questFailsRequired: [1, 1, 1, 2, 1],
  },
  10: {
    // 6 good, 4 evil — Round 4 requires 2 fail votes
    minPlayers: 10,
    maxPlayers: 10,
    maxFailedVotes: 5,
    roles: [
      'merlin',
      'percival',
      'loyal',
      'loyal',
      'loyal',
      'loyal',
      'assassin',
      'morgana',
      'mordred',
      'oberon',
    ],
    questTeams: [3, 4, 4, 5, 5],
    questFailsRequired: [1, 1, 1, 2, 1],
  },
};

export const DEFAULT_QUEST_ROUNDS = 5;
