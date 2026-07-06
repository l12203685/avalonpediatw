/**
 * Avalon AI — Type Definitions
 *
 * Defines the observation space and action space for the Avalon AI agent.
 * These types form the interface between the game engine and the AI model.
 */

import { Role, VoteRecord, QuestRecord } from '@avalon/shared';
export type { VoteRecord, QuestRecord };

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
   * Edward 2026-04-24 batch 3 fix — assassin POV only: the full evil
   * roster (including Oberon/Mordred that `knownEvils` hides mid-game).
   * Populated by the harness when `gamePhase === 'assassination'` so the
   * assassin can hard-filter the candidate pool to loyal good only (no
   * targeting Oberon/Mordred as "good"). `undefined` in all other phases
   * and for all other roles.
   */
  allEvilIds?:   string[];

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
  winner:     'good' | 'evil';
  rounds:     number;
  playerCount: number;
  eventCount: number;
}
