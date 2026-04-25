/**
 * GameServer visibility unit tests — Edward 2026-04-26 00:22 spec.
 *
 * Covers `getVisiblePlayerIds` + `sanitizeRoomForPlayer` per
 * `staging/notes/avalon_visibility_full_spec_2026-04-26.md`:
 *
 *   | observer  | visible (camp-only)         | hidden               |
 *   |-----------|-----------------------------|----------------------|
 *   | merlin    | assassin + morgana + oberon | mordred              |
 *   | percival  | merlin + morgana            | (others = role-back) |
 *   | assassin  | morgana + mordred           | oberon               |
 *   | morgana   | assassin + mordred          | oberon               |
 *   | mordred   | assassin + morgana          | oberon               |
 *   | oberon    | (none)                      | all evil             |
 *   | loyal     | (none)                      | all                  |
 *
 * Regression target — pre-fix `getVisiblePlayerIds` excluded oberon from
 * Merlin's vision, which violated canonical Avalon (Merlin sees the three
 * thumbs-up evils: assassin, morgana, oberon).
 */
import { describe, expect, it } from 'vitest';
import { Server as SocketIOServer } from 'socket.io';
import { createServer } from 'http';
import { Room, Player, Role } from '@avalon/shared';

import { GameServer } from './GameServer';

interface VisibilityTestCase {
  observer: Role;
  expectVisibleAsEvilCard: Role[];
  expectVisibleAsCandidatePair?: Role[];
  expectHiddenRoleBack: Role[];
}

function makeServer(): GameServer {
  const httpServer = createServer();
  const io = new SocketIOServer(httpServer);
  const server = new GameServer(io);
  return server;
}

function makePlayer(id: string, role: Role): Player {
  // Edward 2026-04-25 visibility logic depends on `team` field; derive it from
  // role so the canonical evil set keeps team='evil'.
  const evilRoles: Role[] = ['assassin', 'morgana', 'mordred', 'oberon', 'minion'];
  const team: 'good' | 'evil' = evilRoles.includes(role) ? 'evil' : 'good';
  return {
    id,
    name: id,
    role,
    team,
    status: 'active',
  } as Player;
}

function make9pRoom(): Room {
  // Canonical 9p variant containing all 4 special evil + Merlin + Percival
  // so a single fixture exercises every visibility branch.
  const players: Record<string, Player> = {
    p1_merlin:    makePlayer('p1_merlin', 'merlin'),
    p2_percival:  makePlayer('p2_percival', 'percival'),
    p3_loyal:     makePlayer('p3_loyal', 'loyal'),
    p4_loyal:     makePlayer('p4_loyal', 'loyal'),
    p5_loyal:     makePlayer('p5_loyal', 'loyal'),
    p6_assassin:  makePlayer('p6_assassin', 'assassin'),
    p7_morgana:   makePlayer('p7_morgana', 'morgana'),
    p8_mordred:   makePlayer('p8_mordred', 'mordred'),
    p9_oberon:    makePlayer('p9_oberon', 'oberon'),
  };
  return {
    id: 'room-vis-test',
    state: 'voting',
    players,
    host: 'p1_merlin',
    leaderIndex: 0,
    currentRound: 1,
    questTeam: [],
    questResults: [],
    questHistory: [],
    voteHistory: [],
    votes: {},
    failCount: 0,
    maxPlayers: 9,
    createdAt: Date.now(),
    isPrivate: false,
    roleOptions: { percival: true, morgana: true, mordred: true, oberon: true },
  } as unknown as Room;
}

describe('GameServer visibility — Edward 2026-04-26 00:22 spec', () => {
  describe('getVisiblePlayerIds', () => {
    it('Merlin sees assassin + morgana + oberon, hides mordred (canonical 3-thumbs-up)', () => {
      const server = makeServer();
      const room = make9pRoom();
      // Access private method via index signature (test-only).
      const visible = (server as unknown as {
        getVisiblePlayerIds(playerId: string, room: Room): Set<string>;
      }).getVisiblePlayerIds('p1_merlin', room);

      // Self always visible.
      expect(visible.has('p1_merlin')).toBe(true);
      // Three evils Merlin should see (Edward 00:22 spec verbatim:
      // 「梅林知道三個紅方位置 (刺客 + 莫甘娜 + 奧伯倫)」).
      expect(visible.has('p6_assassin')).toBe(true);
      expect(visible.has('p7_morgana')).toBe(true);
      expect(visible.has('p9_oberon')).toBe(true);
      // Mordred stays hidden from Merlin (the only canonical exclusion).
      expect(visible.has('p8_mordred')).toBe(false);
      // Loyals not visible (Merlin doesn't peek at goods).
      expect(visible.has('p3_loyal')).toBe(false);
    });

    it('Percival sees merlin + morgana only', () => {
      const server = makeServer();
      const room = make9pRoom();
      const visible = (server as unknown as {
        getVisiblePlayerIds(playerId: string, room: Room): Set<string>;
      }).getVisiblePlayerIds('p2_percival', room);

      expect(visible.has('p2_percival')).toBe(true);
      expect(visible.has('p1_merlin')).toBe(true);
      expect(visible.has('p7_morgana')).toBe(true);
      // Other evils invisible to Percival.
      expect(visible.has('p6_assassin')).toBe(false);
      expect(visible.has('p8_mordred')).toBe(false);
      expect(visible.has('p9_oberon')).toBe(false);
    });

    it('Evil non-Oberon sees other evils except Oberon', () => {
      const server = makeServer();
      const room = make9pRoom();
      const visible = (server as unknown as {
        getVisiblePlayerIds(playerId: string, room: Room): Set<string>;
      }).getVisiblePlayerIds('p6_assassin', room);

      expect(visible.has('p6_assassin')).toBe(true);
      expect(visible.has('p7_morgana')).toBe(true);
      expect(visible.has('p8_mordred')).toBe(true);
      // Oberon hidden from other evils ("孤狼").
      expect(visible.has('p9_oberon')).toBe(false);
      // Goods invisible.
      expect(visible.has('p1_merlin')).toBe(false);
    });

    it('Oberon sees no other evils (孤狼)', () => {
      const server = makeServer();
      const room = make9pRoom();
      const visible = (server as unknown as {
        getVisiblePlayerIds(playerId: string, room: Room): Set<string>;
      }).getVisiblePlayerIds('p9_oberon', room);

      expect(visible.has('p9_oberon')).toBe(true);
      expect(visible.has('p6_assassin')).toBe(false);
      expect(visible.has('p7_morgana')).toBe(false);
      expect(visible.has('p8_mordred')).toBe(false);
    });

    it('Loyal sees no one (no night info)', () => {
      const server = makeServer();
      const room = make9pRoom();
      const visible = (server as unknown as {
        getVisiblePlayerIds(playerId: string, room: Room): Set<string>;
      }).getVisiblePlayerIds('p3_loyal', room);

      expect(visible.has('p3_loyal')).toBe(true);
      expect(visible.size).toBe(1); // self only
    });
  });

  describe('sanitizeRoomForPlayer — camp-only / candidate-pair masking', () => {
    it('Merlin views see {role: null, team: "evil"} for all visible evils (camp-only)', () => {
      const server = makeServer();
      const room = make9pRoom();
      const sanitized = (server as unknown as {
        sanitizeRoomForPlayer(room: Room, playerId: string, revealAll?: boolean): Room;
      }).sanitizeRoomForPlayer(room, 'p1_merlin');

      // Self keeps full role.
      expect(sanitized.players.p1_merlin.role).toBe('merlin');
      // Visible evils — camp leaked, role masked.
      for (const id of ['p6_assassin', 'p7_morgana', 'p9_oberon']) {
        expect(sanitized.players[id].role).toBeNull();
        expect(sanitized.players[id].team).toBe('evil');
      }
      // Mordred fully hidden (role+team null).
      expect(sanitized.players.p8_mordred.role).toBeNull();
      expect(sanitized.players.p8_mordred.team).toBeNull();
      // Loyals fully hidden.
      expect(sanitized.players.p3_loyal.role).toBeNull();
      expect(sanitized.players.p3_loyal.team).toBeNull();
    });

    it('Percival views see {role: null, team: null, revealedCandidates: [merlin,morgana]} for both candidates', () => {
      const server = makeServer();
      const room = make9pRoom();
      const sanitized = (server as unknown as {
        sanitizeRoomForPlayer(room: Room, playerId: string, revealAll?: boolean): Room;
      }).sanitizeRoomForPlayer(room, 'p2_percival');

      expect(sanitized.players.p2_percival.role).toBe('percival');

      for (const id of ['p1_merlin', 'p7_morgana']) {
        const p = sanitized.players[id];
        expect(p.role).toBeNull();
        expect(p.team).toBeNull();
        expect(p.revealedCandidates).toEqual(['merlin', 'morgana']);
      }
      // Other seats fully hidden.
      expect(sanitized.players.p6_assassin.team).toBeNull();
    });

    it('Evil teammates see camp-only red cards for each other', () => {
      const server = makeServer();
      const room = make9pRoom();
      const sanitized = (server as unknown as {
        sanitizeRoomForPlayer(room: Room, playerId: string, revealAll?: boolean): Room;
      }).sanitizeRoomForPlayer(room, 'p6_assassin');

      expect(sanitized.players.p6_assassin.role).toBe('assassin');
      // Visible evil teammates — camp shown, role masked.
      for (const id of ['p7_morgana', 'p8_mordred']) {
        expect(sanitized.players[id].role).toBeNull();
        expect(sanitized.players[id].team).toBe('evil');
      }
      // Oberon hidden from assassin.
      expect(sanitized.players.p9_oberon.team).toBeNull();
    });

    it('revealAll=true exposes full roles (game-end disclosure)', () => {
      const server = makeServer();
      const room = make9pRoom();
      const sanitized = (server as unknown as {
        sanitizeRoomForPlayer(room: Room, playerId: string, revealAll?: boolean): Room;
      }).sanitizeRoomForPlayer(room, 'p3_loyal', true);

      expect(sanitized.players.p1_merlin.role).toBe('merlin');
      expect(sanitized.players.p8_mordred.role).toBe('mordred');
      expect(sanitized.players.p9_oberon.role).toBe('oberon');
    });
  });
});
