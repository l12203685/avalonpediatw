import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GameEngine, CanonicalRoleLockError } from './GameEngine';
import { RoomManager } from './RoomManager';
import { Room, Player, Role, CANONICAL_ROLES, isCanonicalRole } from '@avalon/shared';

/**
 * Canonical 7-role scope-lock tests.
 *
 * Purpose: any future contributor who adds a non-canonical role (Lancelot,
 * Galahad, Troublemaker, Lady of the Lake as role, Minion of Mordred, etc.)
 * or re-enables Lady of the Lake as a default MUST break one of these tests.
 *
 * See memory: project_avalon_scope_canonical_7.md.
 */

// Build a room with N active players, no roleOptions set (engine picks defaults).
function makeRoom(playerCount: number, roleOptions?: Room['roleOptions']): Room {
  const players: Record<string, Player> = {};
  for (let i = 1; i <= playerCount; i++) {
    const id = `p${i}`;
    players[id] = {
      id,
      name: `Player ${i}`,
      role: null,
      team: null,
      status: 'active',
      createdAt: Date.now(),
    };
  }
  return {
    id: `room-${playerCount}`,
    name: `Room ${playerCount}`,
    host: 'p1',
    state: 'lobby',
    players,
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
    roleOptions: roleOptions ?? {
      percival: true,
      morgana: true,
      oberon: true,
      mordred: true,
      ladyOfTheLake: false,
    },
    readyPlayerIds: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

describe('Canonical 7-role scope lock', () => {
  afterEach(() => vi.clearAllTimers());

  describe('CANONICAL_ROLES constant', () => {
    it('contains exactly the 7 canonical Avalon roles', () => {
      expect(CANONICAL_ROLES).toHaveLength(7);
      expect([...CANONICAL_ROLES].sort()).toEqual(
        ['assassin', 'loyal', 'merlin', 'mordred', 'morgana', 'oberon', 'percival']
      );
    });

    it('isCanonicalRole accepts every canonical role', () => {
      for (const role of CANONICAL_ROLES) {
        expect(isCanonicalRole(role)).toBe(true);
      }
    });

    it('isCanonicalRole rejects non-canonical roles', () => {
      expect(isCanonicalRole('minion')).toBe(false);
      expect(isCanonicalRole('lancelot')).toBe(false);
      expect(isCanonicalRole('good_lancelot')).toBe(false);
      expect(isCanonicalRole('evil_lancelot')).toBe(false);
      expect(isCanonicalRole('galahad')).toBe(false);
      expect(isCanonicalRole('troublemaker')).toBe(false);
      expect(isCanonicalRole('lady_of_the_lake')).toBe(false);
      expect(isCanonicalRole(undefined)).toBe(false);
      expect(isCanonicalRole(null)).toBe(false);
      expect(isCanonicalRole(123)).toBe(false);
    });
  });

  describe('assignRoles — canonical output', () => {
    it.each([5, 6, 7, 8, 9, 10])(
      'emits only canonical roles for %i-player games (100-trial deterministic sample)',
      (playerCount) => {
        // Run many trials to beat any shuffle non-determinism
        for (let trial = 0; trial < 100; trial++) {
          const room = makeRoom(playerCount);
          const engine = new GameEngine(room);
          engine.startGame();

          const assignedRoles = Object.values(room.players).map(p => p.role);
          for (const role of assignedRoles) {
            expect(role).not.toBeNull();
            expect(isCanonicalRole(role)).toBe(true);
          }
          engine.cleanup();
        }
      }
    );

    it('does NOT emit the legacy "minion" role when defaults are used', () => {
      for (let trial = 0; trial < 50; trial++) {
        const room = makeRoom(7);
        const engine = new GameEngine(room);
        engine.startGame();
        const assignedRoles = Object.values(room.players).map(p => p.role);
        expect(assignedRoles).not.toContain('minion');
        engine.cleanup();
      }
    });

    it('every 10-player game includes all canonical evil roles (morgana/mordred/oberon/assassin)', () => {
      // 10-player game mandates all canonical evil roles in AVALON_CONFIG.
      const room = makeRoom(10);
      const engine = new GameEngine(room);
      engine.startGame();
      const assignedRoles = Object.values(room.players).map(p => p.role);
      expect(assignedRoles).toContain('assassin');
      expect(assignedRoles).toContain('morgana');
      expect(assignedRoles).toContain('mordred');
      expect(assignedRoles).toContain('oberon');
      engine.cleanup();
    });
  });

  describe('assignRoles — lock enforcement', () => {
    it('throws CanonicalRoleLockError if AVALON_CONFIG is tampered with to add a non-canonical role', async () => {
      // Simulate a future contributor sneaking a non-canonical role into the config
      // by monkey-patching the resolved array. We cannot mutate AVALON_CONFIG easily
      // without module-level tricks, so inject via a subclass that overrides the
      // mapped role list. Since assignRoles is private, we simulate by pre-setting
      // the room config indirectly: patch shared config clone.
      const shared = await import('@avalon/shared');
      const originalRoles = [...shared.AVALON_CONFIG[5].roles];
      (shared.AVALON_CONFIG[5].roles as unknown as string[]) = [
        'merlin', 'percival', 'loyal', 'assassin', 'lancelot_evil' // <-- non-canonical
      ];
      try {
        const room = makeRoom(5);
        const engine = new GameEngine(room);
        expect(() => engine.startGame()).toThrow(CanonicalRoleLockError);
        expect(() => engine.startGame()).toThrow(/Canonical 7-role scope violation/);
        engine.cleanup();
      } finally {
        (shared.AVALON_CONFIG[5].roles as unknown as string[]) = originalRoles;
      }
    });

    it('throws CanonicalRoleLockError when the legacy "minion" substitute would be emitted', () => {
      // Disable an evil toggle — the engine's legacy behaviour substitutes
      // 'minion'. Under canonical scope lock this must throw instead of
      // silently emitting 'minion'.
      const room = makeRoom(7, {
        percival: true,
        morgana: false, // would trigger minion substitute
        oberon: true,
        mordred: true,
        ladyOfTheLake: false,
      });
      const engine = new GameEngine(room);
      expect(() => engine.startGame()).toThrow(CanonicalRoleLockError);
      expect(() => engine.startGame()).toThrow(/minion/);
      engine.cleanup();
    });

    it('CanonicalRoleLockError reports the offending roles', () => {
      const err = new CanonicalRoleLockError(['lancelot', 'galahad']);
      expect(err.message).toContain('lancelot');
      expect(err.message).toContain('galahad');
      expect(err.message).toContain('project_avalon_scope_canonical_7.md');
      expect(err.offendingRoles).toEqual(['lancelot', 'galahad']);
      expect(err.name).toBe('CanonicalRoleLockError');
    });
  });

  describe('Lady of the Lake — 7+ ON by default, explicit opt-out honoured', () => {
    it('RoomManager.createRoom leaves ladyOfTheLake flag set to false (UI explicit opt-out baseline)', () => {
      // RoomManager still seeds the flag as false so the lobby UI can render
      // a de-selected toggle by default. The engine's 7+ default-ON policy
      // is independent of this seed value — see startGame() lady logic.
      const rm = new RoomManager();
      const room = rm.createRoom('r1', 'Alice', 'p1');
      expect(room.roleOptions?.ladyOfTheLake).toBe(false);
      rm.destroy();
    });

    it('RoomManager.createRoom defaults all canonical evil toggles to true', () => {
      const rm = new RoomManager();
      const room = rm.createRoom('r1', 'Alice', 'p1');
      expect(room.roleOptions?.morgana).toBe(true);
      expect(room.roleOptions?.oberon).toBe(true);
      expect(room.roleOptions?.mordred).toBe(true);
      expect(room.roleOptions?.percival).toBe(true);
      rm.destroy();
    });

    it('startGame honours explicit ladyOfTheLake=false opt-out for 7+ player games', () => {
      // When the host explicitly disables Lady via the lobby toggle, Lady
      // stays off even at 7+ players.
      const room = makeRoom(7); // uses default ladyOfTheLake: false
      const engine = new GameEngine(room);
      engine.startGame();
      expect(room.ladyOfTheLakeEnabled).toBe(false);
      expect(room.ladyOfTheLakeHolder).toBeUndefined();
      engine.cleanup();
    });

    it('startGame keeps Lady of the Lake OFF when roleOptions is missing entirely (pure-read #90)', () => {
      // After #90 the engine performs a pure read of ladyOfTheLake; the
      // UI is now responsible for computing the canonical default
      // (7+ players & Mordred on → pre-check true) and sending the
      // resolved boolean. "Missing roleOptions" = host sent nothing → off.
      const room = makeRoom(7);
      delete (room as Partial<Room>).roleOptions;
      const engine = new GameEngine(room);
      engine.startGame();
      expect(room.ladyOfTheLakeEnabled).toBe(false);
      engine.cleanup();
    });

    it('startGame keeps Lady of the Lake OFF for 7+ players when not explicitly enabled (pure-read #90)', () => {
      // Same pure-read semantics: without ladyOfTheLake: true in
      // roleOptions, engine leaves it off regardless of player count.
      for (const count of [7, 8, 9, 10]) {
        const room = makeRoom(count, {
          percival: true,
          morgana: true,
          oberon: true,
          mordred: true,
          // ladyOfTheLake intentionally omitted — pure-read → off.
        });
        const engine = new GameEngine(room);
        engine.startGame();
        expect(room.ladyOfTheLakeEnabled).toBe(false);
        engine.cleanup();
      }
    });

    it('startGame enables Lady of the Lake for 7+ players when explicitly opted in (#90 pure-read)', () => {
      // The UI's job is to tick the checkbox; the engine obeys.
      for (const count of [7, 8, 9, 10]) {
        const room = makeRoom(count, {
          percival: true,
          morgana: true,
          oberon: true,
          mordred: true,
          ladyOfTheLake: true,
        });
        const engine = new GameEngine(room);
        engine.startGame();
        expect(room.ladyOfTheLakeEnabled).toBe(true);
        expect(room.ladyOfTheLakeHolder).toBeDefined();
        engine.cleanup();
      }
    });

    it('startGame never enables Lady of the Lake for 5-6 player games regardless of flag', () => {
      for (const count of [5, 6]) {
        // Even with ladyOfTheLake: true (explicit opt-in), <7 player games
        // must not activate Lady — this matches official Avalon rules.
        const room = makeRoom(count, {
          percival: true,
          morgana: true,
          oberon: true,
          mordred: true,
          ladyOfTheLake: true,
        });
        const engine = new GameEngine(room);
        engine.startGame();
        expect(room.ladyOfTheLakeEnabled).toBe(false);
        engine.cleanup();
      }
    });

    it('Lady of the Lake respects explicit opt-in with canonical role lock intact', () => {
      // Explicit opt-in path still works and canonical role lock holds.
      const room = makeRoom(7, {
        percival: true,
        morgana: true,
        oberon: true,
        mordred: true,
        ladyOfTheLake: true,
      });
      const engine = new GameEngine(room);
      engine.startGame();
      expect(room.ladyOfTheLakeEnabled).toBe(true);
      // Even with Lady on, all assigned roles remain canonical
      const assignedRoles = Object.values(room.players).map(p => p.role);
      for (const role of assignedRoles) {
        expect(isCanonicalRole(role)).toBe(true);
      }
      engine.cleanup();
    });
  });

  describe('Integration smoke — 10 simulated games', () => {
    it('every role dealt across 10 random-size games is canonical', () => {
      const sizes = [5, 6, 7, 8, 9, 10, 5, 7, 10, 6];
      for (const size of sizes) {
        const room = makeRoom(size);
        const engine = new GameEngine(room);
        engine.startGame();
        for (const player of Object.values(room.players)) {
          expect(player.role).not.toBeNull();
          expect(isCanonicalRole(player.role)).toBe(true);
          expect(['good', 'evil']).toContain(player.team);
        }
        engine.cleanup();
      }
    });
  });
});
