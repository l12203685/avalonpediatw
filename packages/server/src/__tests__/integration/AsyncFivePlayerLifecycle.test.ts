/**
 * Integration test: 5-player async ("棋瓦" / Avalon Chess) lifecycle.
 *
 * Verifies P1 MVP scope:
 *   - mode='async' rooms skip every phase timer (no setTimeout fires)
 *   - room.pending is recomputed on every state mutation
 *   - serialize/restore between phases preserves engine state cleanly
 *     (= "save & restart" — players quit browser, server restarts, etc.)
 *   - Full 5p game create-to-completion runs through TEAM_SELECT, VOTE,
 *     QUEST, ASSASSINATE phases with pause-and-wait gating
 *   - mode='realtime' default (undefined) keeps the legacy timer path
 *
 * Tests do NOT assert the specific assassination win condition (depends
 * on randomized role assignment), only that the engine reaches the
 * 'ended' state with a well-formed result.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { GameEngine, GAME_ENGINE_STATE_VERSION } from '../../game/GameEngine';
import { Room, Player, Role, AVALON_CONFIG } from '@avalon/shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PLAYER_NAMES = ['Alice', 'Bob', 'Charlie', 'David', 'Eve'];

function makePlayers(count: number): Record<string, Player> {
  return Object.fromEntries(
    Array.from({ length: count }, (_, i) => {
      const id = `p${i + 1}`;
      const player: Player = {
        id,
        name: PLAYER_NAMES[i],
        role: null,
        team: null,
        status: 'active',
        createdAt: Date.now(),
      };
      return [id, player];
    })
  );
}

function makeAsyncRoom(playerCount = 5): Room {
  return {
    id: 'room-async-5p',
    name: '棋瓦 5p',
    host: 'p1',
    state: 'lobby',
    players: makePlayers(playerCount),
    maxPlayers: 10,
    currentRound: 0,
    maxRounds: 5,
    votes: {},
    questTeam: [],
    questResults: [],
    failCount: 0,
    evilWins: null,
    leaderIndex: 0,
    voteHistory: [],
    questHistory: [],
    questVotedCount: 0,
    roleOptions: {
      percival: true,
      morgana: true,
      oberon: false,
      mordred: false,
    },
    readyPlayerIds: [],
    mode: 'async',
    createdAt: Date.now() - 1000,
    updatedAt: Date.now(),
  };
}

function makeRealtimeRoom(playerCount = 5): Room {
  const room = makeAsyncRoom(playerCount);
  room.id = 'room-realtime-5p';
  room.name = 'Realtime 5p';
  room.mode = undefined; // default = realtime
  return room;
}

/**
 * Simulate "save & restart" between phases: serialise, throw away the
 * engine, rebuild a fresh one with the same room object via restore().
 * Returns the restored engine.
 */
function saveAndRestart(engine: GameEngine, room: Room): GameEngine {
  const snapshot = engine.serialize();
  expect(snapshot.version).toBe(GAME_ENGINE_STATE_VERSION);
  engine.cleanup();
  return GameEngine.restore(snapshot, room);
}

function findByRole(room: Room, role: Role): string {
  const entry = Object.entries(room.players).find(([_, p]) => p.role === role);
  if (!entry) throw new Error(`No player with role ${role}`);
  return entry[0];
}

function voteAll(engine: GameEngine, room: Room, approve: boolean): void {
  Object.keys(room.players).forEach((id) => engine.submitVote(id, approve));
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Integration: 5-player async lifecycle (棋瓦 P1)', () => {
  afterEach(() => vi.clearAllTimers());

  // -------------------------------------------------------------------------
  // Pause-gate semantics
  // -------------------------------------------------------------------------

  it('async mode populates room.pending on startGame', () => {
    const room = makeAsyncRoom();
    const engine = new GameEngine(room);
    engine.startGame();

    expect(room.mode).toBe('async');
    expect(room.pending).toBeDefined();
    expect(room.pending?.phase).toBe('voting');
    expect(room.pending?.round).toBe(1);
    expect(room.pending?.pendingActors).toHaveLength(1); // [leader]
    expect(room.pending?.pendingActors[0]).toBe(engine.getCurrentLeaderId());

    engine.cleanup();
  });

  it('realtime mode (undefined mode) does NOT populate room.pending', () => {
    const room = makeRealtimeRoom();
    const engine = new GameEngine(room);
    engine.startGame();

    expect(room.mode).toBeUndefined();
    expect(room.pending).toBeUndefined();

    engine.cleanup();
  });

  it('pendingActors tracks team-select → vote → quest transitions', () => {
    const room = makeAsyncRoom();
    const engine = new GameEngine(room);
    engine.startGame();

    // TEAM_SELECT: only leader pending
    const leaderId = engine.getCurrentLeaderId();
    expect(room.pending?.pendingActors).toEqual([leaderId]);

    // Leader picks team → VOTE phase: all 5 players pending
    const team = Object.keys(room.players).slice(0, AVALON_CONFIG[5].questTeams[0]);
    engine.selectQuestTeam(team);
    expect(room.state).toBe('voting');
    expect(new Set(room.pending?.pendingActors)).toEqual(new Set(Object.keys(room.players)));

    // Each vote shrinks pendingActors
    engine.submitVote('p1', true);
    expect(room.pending?.pendingActors).toHaveLength(4);
    expect(room.pending?.submittedActors).toEqual(['p1']);

    // Complete the remaining 4 votes (approve)
    ['p2', 'p3', 'p4', 'p5'].forEach((id) => engine.submitVote(id, true));
    expect(room.state).toBe('quest');
    // QUEST: only team members pending
    expect(new Set(room.pending?.pendingActors)).toEqual(new Set(team));

    engine.cleanup();
  });

  it('async mode skips all setTimeout calls (no phase timer fires)', () => {
    vi.useFakeTimers();
    const room = makeAsyncRoom();
    const engine = new GameEngine(room);
    engine.startGame();

    // Advance 24 hours of fake time. In realtime mode, the team-select
    // AFK timer (90s) would have fired and auto-picked. In async mode,
    // nothing should change.
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);

    expect(room.state).toBe('voting');
    expect(room.questTeam).toEqual([]);
    expect(room.pending?.pendingActors).toEqual([engine.getCurrentLeaderId()]);

    vi.useRealTimers();
    engine.cleanup();
  });

  // -------------------------------------------------------------------------
  // Save & restart between phases
  // -------------------------------------------------------------------------

  it('serialize/restore between every phase preserves state', () => {
    const room = makeAsyncRoom();
    let engine = new GameEngine(room);
    engine.startGame();

    // Snapshot 1: after startGame, before team picked
    engine = saveAndRestart(engine, room);
    expect(room.pending?.phase).toBe('voting');
    expect(room.pending?.pendingActors).toEqual([engine.getCurrentLeaderId()]);

    // Leader picks team → VOTE
    const playerIds = Object.keys(room.players);
    const team1 = playerIds.slice(0, AVALON_CONFIG[5].questTeams[0]);
    engine.selectQuestTeam(team1);

    // Snapshot 2: after team picked, mid-vote
    engine = saveAndRestart(engine, room);
    expect(room.state).toBe('voting');
    expect(room.questTeam).toEqual(team1);

    // Half the votes
    engine.submitVote('p1', true);
    engine.submitVote('p2', true);

    // Snapshot 3: mid-vote
    engine = saveAndRestart(engine, room);
    expect(Object.keys(room.votes)).toHaveLength(2);
    expect(room.pending?.pendingActors).toHaveLength(3);

    // Complete the vote → approve
    engine.submitVote('p3', true);
    engine.submitVote('p4', false);
    engine.submitVote('p5', false);
    expect(room.state).toBe('quest');

    // Snapshot 4: mid-quest
    engine = saveAndRestart(engine, room);
    expect(room.state).toBe('quest');
    expect(new Set(room.pending?.pendingActors)).toEqual(new Set(team1));

    engine.cleanup();
  });

  // -------------------------------------------------------------------------
  // Full lifecycle: 5p create → finish, with restart between every phase
  // -------------------------------------------------------------------------

  it('plays a full 5p async game to completion across simulated restarts', () => {
    const room = makeAsyncRoom();
    let engine = new GameEngine(room);
    engine.startGame();

    const playerIds = Object.keys(room.players);
    const config = AVALON_CONFIG[5];

    // Force good to win quests 1/2/3 by having all team members vote success.
    // Team selection uses leader + first N-1 other seats (deterministic),
    // and we vote approve unanimously so the team-vote always passes.
    let safetyRounds = 0;
    while (
      room.state !== 'discussion' &&
      room.state !== 'ended' &&
      safetyRounds < 10
    ) {
      safetyRounds++;
      const roundIdx = room.currentRound - 1;
      const teamSize = config.questTeams[roundIdx];

      // Restart before team-select
      engine = saveAndRestart(engine, room);

      // Leader picks team (clockwise from leader+1, no leader)
      const leaderId = engine.getCurrentLeaderId();
      const leaderIdx = playerIds.indexOf(leaderId);
      const team: string[] = [];
      for (let i = 1; i <= teamSize; i++) {
        team.push(playerIds[(leaderIdx + i) % playerIds.length]);
      }
      engine.selectQuestTeam(team);

      // Restart before vote
      engine = saveAndRestart(engine, room);

      // Vote approve unanimously
      voteAll(engine, room, true);
      expect(room.state).toBe('quest');

      // Restart before quest votes
      engine = saveAndRestart(engine, room);

      // All team votes success (good wins quest)
      team.forEach((id) => engine.submitQuestVote(id, 'success'));
    }

    expect(room.state).toBe('discussion');
    expect(room.questResults.filter((r) => r === 'success')).toHaveLength(3);

    // Restart at assassination phase
    engine = saveAndRestart(engine, room);
    expect(room.pending?.phase).toBe('discussion');
    expect(room.pending?.pendingActors).toHaveLength(1);

    // Assassin picks a target. We pick a non-evil seat (Merlin or another
    // good role). The win condition depends on whether we hit Merlin —
    // we just verify the engine reaches 'ended' cleanly with a well-formed
    // endReason.
    const assassinId = findByRole(room, 'assassin');
    expect(room.pending?.pendingActors[0]).toBe(assassinId);

    // Pick the first good-team player (Merlin or otherwise) as target.
    const goodTarget = Object.entries(room.players).find(
      ([id, p]) => id !== assassinId && p.team === 'good'
    )?.[0];
    expect(goodTarget).toBeDefined();
    engine.submitAssassination(assassinId, goodTarget!);

    expect(room.state).toBe('ended');
    expect(room.endReason).toMatch(/^(merlin_assassinated|assassination_failed)$/);
    expect(room.evilWins).not.toBeNull();
    // pending cleared on game end
    expect(room.pending).toBeUndefined();

    engine.cleanup();
  });

  // -------------------------------------------------------------------------
  // Engine state version stamping
  // -------------------------------------------------------------------------

  it('serialize() stamps the snapshot with version 2', () => {
    const room = makeAsyncRoom();
    const engine = new GameEngine(room);
    engine.startGame();

    const snap = engine.serialize();
    expect(snap.version).toBe(2);
    expect(snap.pending).toBeDefined();
    expect(snap.pending?.phase).toBe('voting');

    engine.cleanup();
  });

  it('restore() accepts a v1 snapshot (legacy realtime) without async fields', () => {
    const room = makeRealtimeRoom();
    const engine = new GameEngine(room);
    engine.startGame();

    // Build a synthetic v1 snapshot to mimic a pre-async game saved
    // before this PR shipped. Persistence layer migrates it to v2 via
    // deserialiseEngineState; here we test the engine's restore() directly
    // because that is the in-memory path the migration produces.
    const v2Snap = engine.serialize();
    const v1Snap = { ...v2Snap, version: 1, pending: undefined };

    const restored = GameEngine.restore(v1Snap, room);
    expect(restored.getCurrentLeaderId()).toBe(engine.getCurrentLeaderId());
    // Realtime room → no pending populated on restore
    expect(room.pending).toBeUndefined();

    engine.cleanup();
    restored.cleanup();
  });
});
