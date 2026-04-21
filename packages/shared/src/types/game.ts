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
  | 'minion';     // Evil - Legacy substitute type; NOT canonical, NOT emitted in default games (see CANONICAL_ROLES)

/**
 * Canonical Avalon 7 roles — scope lock.
 *
 * This is the ONLY set of roles allowed in a shipped game. Memory rule
 * `project_avalon_scope_canonical_7.md` forbids adding Lancelot, Galahad,
 * Troublemaker, Lady of the Lake (role-form), Minion of Mordred, etc.
 *
 * Adding a new role to `Role` above WITHOUT also adding it here will trip
 * the canonical-role assertion in GameEngine.assignRoles and fail CI. This
 * is intentional — do NOT relax the lock to unblock a PR. Discuss with
 * Edward first and update the scope memory.
 */
export const CANONICAL_ROLES = [
  'merlin',
  'percival',
  'loyal',
  'assassin',
  'morgana',
  'mordred',
  'oberon',
] as const;

export type CanonicalRole = typeof CANONICAL_ROLES[number];

/** True iff the role is part of the canonical 7-role Avalon scope. */
export function isCanonicalRole(role: unknown): role is CanonicalRole {
  return typeof role === 'string' && (CANONICAL_ROLES as readonly string[]).includes(role);
}

export type Team = 'good' | 'evil';

// Player Status
export type PlayerStatus = 'active' | 'disconnected' | 'idle';

// Voting Status
export type VoteStatus = 'pending' | 'approved' | 'rejected';

// Phase Timer Multipliers — per-room setting.
// `null` = unlimited time (no timer runs, no auto-default).
// Numeric values multiply the base timeout (team vote 90s, quest vote 30s,
// lady of the lake 90s, assassin 180s).
export type TimerMultiplier = 0.5 | 1 | 1.5 | 2 | null;

export interface TimerConfig {
  multiplier: TimerMultiplier;
}

export const DEFAULT_TIMER_CONFIG: TimerConfig = { multiplier: 1 };

export const TIMER_MULTIPLIER_OPTIONS: ReadonlyArray<{ label: string; value: TimerMultiplier }> = [
  { label: '0.5x (加速)', value: 0.5 },
  { label: '1x (標準)', value: 1 },
  { label: '1.5x', value: 1.5 },
  { label: '2x (慢節奏)', value: 2 },
  { label: '無限 (不計時)', value: null },
];

/** True iff the value is a valid TimerMultiplier. */
export function isTimerMultiplier(value: unknown): value is TimerMultiplier {
  return value === null || value === 0.5 || value === 1 || value === 1.5 || value === 2;
}

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
  /**
   * Auth provider of the backing User record. Populated on the web client when
   * `auth:success` fires (socket.ts copies it from `session.user.provider`).
   * Optional because legacy Player rows (bots, pre-#84 reconstructed state) may
   * not have it; UI that needs to distinguish guests from registered users
   * should check `provider === 'guest'` rather than heuristics on name/avatar
   * (#84 regression: registered users without a `photoURL` were misclassified
   * as guests).
   */
  provider?: 'google' | 'github' | 'discord' | 'line' | 'email' | 'guest';
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
  endReason?: 'failed_quests' | 'vote_rejections' | 'merlin_assassinated' | 'assassination_failed' | 'assassination_timeout' | 'host_cancelled'; // Why game ended
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
  timerConfig?: TimerConfig;        // Per-room phase-timer multiplier; undefined = { multiplier: 1 } (backward compat)
  createdAt: number;
  updatedAt: number;
}

/** Host-configurable role toggles for optional special roles */
export interface RoleOptions {
  percival: boolean;  // Include Percival + Morgana (must be toggled together for balance)
  morgana: boolean;   // Include Morgana (paired with Percival)
  oberon: boolean;    // Include Oberon (evil unknown to other evil)
  mordred: boolean;   // Include Mordred (hidden from Merlin)
  /**
   * Post-MVP feature; canonical-7 scope lock still in force. Engine reads the
   * value as-is (pure read, no implicit default-on). UI derives the default
   * suggestion (7+ & Mordred on → pre-check true) and sends it explicitly.
   */
  ladyOfTheLake?: boolean;
  /**
   * 9-player variant selector. `'standard'` (default) = canonical 6 good /
   * 3 evil with quest sizes [3,4,4,5,5]. `'oberonMandatory'` = 5 good /
   * 4 evil with Oberon forced into the evil pool and quest sizes overridden
   * to [4,3,4,5,5].
   */
  variant9Player?: 'standard' | 'oberonMandatory';
  /**
   * 9-player variant option 2 ("inverted protection"). Only meaningful when
   * `variant9Player === 'oberonMandatory'`. Inverts quest result logic on
   * rounds 1/2/3/5 so that EXACTLY ONE fail vote flips the quest to
   * "failed", while 0 or 2+ fails count as success. Round 4 (the "protection
   * round" that already requires 2 fails in 7+ player games) keeps its
   * standard rule. Ignored when `variant9Player !== 'oberonMandatory'`.
   */
  variant9Option2?: boolean;
  /** Swap the team sizes for quests 1 and 2 when true. */
  swapR1R2?: boolean;
  /**
   * Initial Lady-of-the-Lake holder. 'random' randomises; 'seat0' (default)
   * maps to seat 10 (= playerIds[playerIds.length - 1], the canonical
   * "leader's right neighbour"); 'seat1'..'seat9' map to playerIds[0]..[8].
   */
  ladyStart?: 'random' | 'seat0' | 'seat1' | 'seat2' | 'seat3' | 'seat4' | 'seat5' | 'seat6' | 'seat7' | 'seat8' | 'seat9';
  /**
   * "Oberon must fail" house-rule toggle. When `true`, any player holding
   * the `oberon` role is forced to vote `fail` during the quest phase,
   * regardless of whether they are AI or human:
   *
   *   - AI: `GameEngine.submitQuestVote` coerces their submitted vote to
   *     `'fail'` at the entry point (no change to `HeuristicAgent`).
   *   - Human: UI (QuestPanel) hides the success button and shows only
   *     the fail option, matching the engine-side coercion.
   *
   * Default `false` = vanilla Avalon (Oberon may freely pick success or
   * fail). Edward 2026-04-21 principle: every variant rule is opt-in.
   */
  oberonAlwaysFail?: boolean;
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
  /**
   * True once the holder has publicly declared what they "saw". The claim
   * itself is not trusted — holders may lie — so this field only gates the
   * UI (declare button is hidden after first declaration).
   */
  declared?:      boolean;
  /** The public claim the holder made ('good' or 'evil'). */
  declaredClaim?: 'good' | 'evil';
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
