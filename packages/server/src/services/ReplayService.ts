import { Role, QuestResult } from '@avalon/shared';
import { getAdminFirestore } from './firebase';

// ---------------------------------------------------------------------------
// Timeline event types
// ---------------------------------------------------------------------------

export type ReplayEventType =
  | 'game_started'
  | 'leader_selected_team'
  | 'player_voted'
  | 'team_vote_resolved'
  | 'quest_vote_cast'
  | 'quest_resolved'
  | 'assassination_attempt'
  | 'game_ended';

export interface ReplayEvent {
  /** Sequential index within the game (0-based) */
  seq: number;
  type: ReplayEventType;
  timestamp: number;
  /** Round number at the time of this event (1-5) */
  round: number;
  payload: ReplayEventPayload;
}

export type ReplayEventPayload =
  | GameStartedPayload
  | TeamSelectedPayload
  | PlayerVotedPayload
  | TeamVoteResolvedPayload
  | QuestVoteCastPayload
  | QuestResolvedPayload
  | AssassinationPayload
  | GameEndedPayload;

export interface GameStartedPayload {
  playerCount: number;
  /** Role assignments are hidden for other players — only sent in full replay after game ends */
  roleAssignments: Record<string, Role>;
}

export interface TeamSelectedPayload {
  leaderId: string;
  teamPlayerIds: string[];
  teamSize: number;
}

export interface PlayerVotedPayload {
  playerId: string;
  /** Approval vote is revealed only after voting closes */
  vote: boolean;
  voteNumber: number;
}

export interface TeamVoteResolvedPayload {
  approved: boolean;
  approveCount: number;
  rejectCount: number;
  totalVoters: number;
  votes: Record<string, boolean>;
}

export interface QuestVoteCastPayload {
  /** Anonymised: quest votes are secret during play */
  successCount: number;
  failCount: number;
  totalSoFar: number;
  totalRequired: number;
}

export interface QuestResolvedPayload {
  round: number;
  result: QuestResult;
  successCount: number;
  failCount: number;
}

export interface AssassinationPayload {
  assassinId: string;
  targetId: string;
  targetRole: Role;
  success: boolean;
}

export interface GameEndedPayload {
  winner: 'good' | 'evil';
  winReason: string;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Full replay document
// ---------------------------------------------------------------------------

export interface GameReplay {
  gameId: string;
  roomName: string;
  playerCount: number;
  winner: 'good' | 'evil';
  winReason: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  /** All player identities revealed at game end */
  players: Array<{
    playerId: string;
    displayName: string;
    role: Role | null;
    team: 'good' | 'evil' | null;
    won: boolean;
  }>;
  timeline: ReplayEvent[];
}

// ---------------------------------------------------------------------------
// In-memory event buffer (per active game)
// ---------------------------------------------------------------------------

/**
 * ReplayRecorder accumulates events during a live game.
 * Instances are held in GameServer keyed by roomId and flushed to Firestore
 * when the game ends via ReplayService.saveReplay().
 */
export class ReplayRecorder {
  private seq = 0;
  private events: ReplayEvent[] = [];
  readonly gameId: string;
  private round = 1;

  constructor(gameId: string) {
    this.gameId = gameId;
  }

  setRound(round: number): void {
    this.round = round;
  }

  record(type: ReplayEventType, payload: ReplayEventPayload): void {
    this.events.push({
      seq: this.seq++,
      type,
      timestamp: Date.now(),
      round: this.round,
      payload,
    });
  }

  getEvents(): Readonly<ReplayEvent[]> {
    return this.events;
  }

  /** Total recorded events */
  get size(): number {
    return this.events.length;
  }
}

// ---------------------------------------------------------------------------
// ReplayService — Firestore-backed
// ---------------------------------------------------------------------------

export class ReplayService {
  private readonly collection = 'replays';

  /**
   * Persist a completed game replay to Firestore.
   */
  async saveReplay(replay: GameReplay): Promise<void> {
    try {
      const firestore = getAdminFirestore();
      await firestore.collection(this.collection).doc(replay.gameId).set(replay);

      console.log(JSON.stringify({
        timestamp: new Date().toISOString(),
        event: 'replay_saved',
        gameId: replay.gameId,
        eventCount: replay.timeline.length,
        winner: replay.winner,
      }));
    } catch (err) {
      console.error(JSON.stringify({
        timestamp: new Date().toISOString(),
        event: 'replay_save_error',
        gameId: replay.gameId,
        error: err instanceof Error ? err.message : 'Unknown',
      }));
      throw err;
    }
  }

  /**
   * Retrieve a full replay by game ID.
   * Returns null if not found.
   */
  async getReplay(gameId: string): Promise<GameReplay | null> {
    try {
      const firestore = getAdminFirestore();
      const doc = await firestore.collection(this.collection).doc(gameId).get();
      if (!doc.exists) return null;
      return doc.data() as GameReplay;
    } catch (err) {
      console.error(JSON.stringify({
        timestamp: new Date().toISOString(),
        event: 'replay_load_error',
        gameId,
        error: err instanceof Error ? err.message : 'Unknown',
      }));
      return null;
    }
  }

  /**
   * List recent replays, ordered by endedAt descending.
   */
  async listRecentReplays(limit = 20): Promise<GameReplay[]> {
    try {
      const firestore = getAdminFirestore();
      const snapshot = await firestore
        .collection(this.collection)
        .orderBy('endedAt', 'desc')
        .limit(limit)
        .get();

      return snapshot.docs.map((doc) => doc.data() as GameReplay);
    } catch (err) {
      console.error(JSON.stringify({
        timestamp: new Date().toISOString(),
        event: 'replay_list_error',
        error: err instanceof Error ? err.message : 'Unknown',
      }));
      return [];
    }
  }

  /**
   * Build a GameReplay document from a ReplayRecorder and game metadata.
   * Called at game end before calling saveReplay().
   */
  buildReplay(
    recorder: ReplayRecorder,
    meta: {
      roomName: string;
      startedAt: number;
      winner: 'good' | 'evil';
      winReason: string;
      players: GameReplay['players'];
    }
  ): GameReplay {
    const endedAt = Date.now();
    return {
      gameId: recorder.gameId,
      roomName: meta.roomName,
      playerCount: meta.players.length,
      winner: meta.winner,
      winReason: meta.winReason,
      startedAt: meta.startedAt,
      endedAt,
      durationMs: endedAt - meta.startedAt,
      players: meta.players,
      timeline: [...recorder.getEvents()],
    };
  }
}
