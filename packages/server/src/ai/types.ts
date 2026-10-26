/**
 * Avalon AI — Type Definitions
 *
 * Defines the observation space and action space for the Avalon AI agent.
 * These types form the interface between the game engine and the AI model.
 */

import { Role, VoteRecord, QuestRecord } from '@avalon/shared';
export type { VoteRecord, QuestRecord };

// ── Lake history (public-only subset) ───────────────────────────
/**
 * Public-only Lady-of-the-Lake record shared with all observers.
 *
 * The full `LadyOfTheLakeRecord` (in `@avalon/shared`) carries the
 * private `result` field — what the holder actually saw. That stays out
 * of every player's `lakeHistory`. This subset surfaces only the public
 * declaration:
 *   - who held the lake at which round
 *   - who they targeted
 *   - what camp they publicly claimed to have seen ('good' | 'evil')
 *
 * Records appear in `lakeHistory` only AFTER the holder has declared, or —
 * since 2026-10-14 (S1-9c, docs/ai/logic_first.md) — after the lake phase
 * ended without a declaration (`declaredClaim: 'none'`). A pending lake
 * (inspected, declaration still open) is NOT included to avoid leaking the
 * holder's pending state.
 *
 * `'none'` is plumbing only: every reader that interprets claims skips it
 * (`belief/Certainty.declaredLakes`); legality readers (who was already
 * inspected) count it. Stage 3 will read it as a likelihood (red holders
 * leave a lake undeclared about 18 times as often as good ones).
 *
 * Wave A scope: schema only — no caller in HeuristicAgent or
 * SelfPlayEngine reads `lakeHistory` yet. Wave B will wire the four
 * hard rules (湖中傳遞鏈) on top of this field.
 */
export interface LakePublicRecord {
  /** Round at which the lake was used. */
  round:          number;
  /** Player who held the lake token. */
  holderId:       string;
  /** Player who was inspected. */
  targetId:       string;
  /** Public claim: what camp the holder declared they saw; `'none'` = the lake phase ended undeclared. */
  declaredClaim:  'good' | 'evil' | 'none';
}

/**
 * The holder's own private Lady-of-the-Lake result (S1-9b, 2026-10-14):
 * what the holder actually saw. Only ever present in the holder's own
 * observation (`PlayerObservation.myLakeResults`); never in anyone else's.
 */
export interface PrivateLakeResult {
  round:    number;
  targetId: string;
  /** The target's camp as the lake shows it (Mordred / Oberon red, Merlin good). */
  result:   'good' | 'evil';
}

// ── Observation ────────────────────────────────────────────────

/** The information visible to a specific player at a given moment */
export interface PlayerObservation {
  // Static info (known at game start)
  myPlayerId:    string;
  myRole:        Role;
  myTeam:        'good' | 'evil';
  playerCount:   number;
  allPlayerIds:  string[];    // All player IDs in the game (always complete)
  knownEvils:    string[];    // IDs of players I know are evil (my role's knowledge)
  knownWizards?: string[];   // IDs that look like Merlin/Morgana to Percival (can't tell which)
  /**
   * Edward 2026-04-24 batch 3 fix — assassinator POV only: the full evil
   * roster (including Oberon/Mordred that `knownEvils` hides mid-game).
   * Populated by the harness when `gamePhase === 'assassination'` so the
   * assassin can hard-filter the candidate pool to loyal good only (no
   * targeting Oberon/Mordred as "good"). `undefined` in all other phases
   * and for all other roles. The assassinator is the `assassin`, or
   * Mordred / Morgana when no assassin is dealt (`game/assassinator.ts`;
   * the 7-player setup: Mordred, 2026-10-26 fix).
   */
  allEvilIds?:   string[];
  /**
   * Edward 2026-10-26「刺殺階段紅方會開牌相認」: at the assassination the reds
   * show each other their cards, so the assassinator knows every red's ROLE
   * (which one is Morgana, Oberon, Mordred). Same scope as `allEvilIds`
   * (assassinator, assassination phase); id → role.
   */
  allEvilRoles?: Record<string, Role>;

  // Dynamic game state
  currentRound:  number;
  currentLeader: string;
  failCount:     number;     // consecutive team-vote failures
  questResults:  ('success' | 'fail')[];
  gamePhase:     'team_select' | 'team_vote' | 'quest_vote' | 'assassination';

  // History (anonymised — includes all public info)
  voteHistory:   VoteRecord[];
  questHistory:  QuestRecord[];
  proposedTeam:  string[];   // current proposed team (if in vote phase)
  /**
   * Public-only Lake history visible to all players. Only includes
   * declared records (no pending). Optional for backward-compat — readers
   * should treat `undefined` and `[]` interchangeably. Populated by the
   * harness from `room.ladyOfTheLakeHistory`.
   *
   * Wave A 2026-04-28: schema-only ship. No reader yet — Wave B will
   * wire the four hard 湖中 rules (傳遞鏈) on top of this field.
   */
  lakeHistory?:  LakePublicRecord[];
  /**
   * S1-9b (2026-10-14): this player's own lake results — what they saw
   * when they held the lake (at most one entry per lake they held). Private:
   * the harness fills it for the holder only (GameServer, SelfPlayEngine,
   * the replay). Optional; readers treat `undefined` as `[]`.
   */
  myLakeResults?: PrivateLakeResult[];
  /**
   * Number of reds in this game (the public lobby setup). Optional; readers
   * fall back to the standard table (`belief/Certainty.evilCountFor`). It
   * differs from the table in the 9-player Oberon variants.
   */
  evilCount?:    number;
  /**
   * The roles dealt this game — the public lobby setup (role toggles, the
   * 9-player variants), one entry per seat, unordered; never who holds
   * which. Optional; readers fall back to the standard table
   * (`AVALON_CONFIG[playerCount].roles`). Added 2026-10-26 so the
   * assassination tier knows whether a Mordred can hide among the
   * assassin's teammates when the host switched Mordred off.
   */
  lobbyRoles?:   Role[];
}

// ── Actions ────────────────────────────────────────────────────

/** Leader selects a team of N players for a quest */
export interface TeamSelectAction {
  type:     'team_select';
  teamIds:  string[];
}

/** Player votes to approve or reject the proposed team */
export interface TeamVoteAction {
  type:  'team_vote';
  vote:  boolean;   // true = approve, false = reject
}

/** Quest team member submits a success or fail token */
export interface QuestVoteAction {
  type:  'quest_vote';
  vote:  'success' | 'fail';
}

/** Assassin picks a target to assassinate */
export interface AssassinateAction {
  type:     'assassinate';
  targetId: string;
}

export type AgentAction =
  | TeamSelectAction
  | TeamVoteAction
  | QuestVoteAction
  | AssassinateAction;

// ── Agent Interface ─────────────────────────────────────────────

export interface AvalonAgent {
  readonly agentId: string;
  readonly agentType: 'random' | 'heuristic' | 'neural';

  /** Called at the start of a game with this agent's role assignment */
  onGameStart(obs: PlayerObservation): void;

  /** Called when it's this agent's turn to act. Must return an action synchronously. */
  act(obs: PlayerObservation): AgentAction;

  /** Called at game end with final result */
  onGameEnd(obs: PlayerObservation, won: boolean): void;
}

// ── Self-Play Result ────────────────────────────────────────────

export interface SelfPlayResult {
  roomId:     string;
  /** 最終勝方：三紅或三藍死 = evil；三藍活 = good。 */
  winner:     'good' | 'evil';
  rounds:     number;
  playerCount: number;
  eventCount: number;
  /** 任務結算明細（2026-10-12 新增，舊呼叫端可忽略）。 */
  questResults?: ('success' | 'fail')[];
  /** 任務結算到了三藍。 */
  threeBlue?: boolean;
  /** 刺殺結算：三藍時是否刺中梅林；沒到三藍為 null。 */
  merlinKilled?: boolean | null;
}
