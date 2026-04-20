/**
 * Milestone M1 — Five-player end-to-end socket smoke test.
 *
 * Spins up a real Socket.IO GameServer in-process, connects five guest clients,
 * drives a full game (create room -> join -> start -> vote -> quest x 3 ->
 * assassination -> game:ended), and asserts the observable broadcast state.
 *
 * Why this test exists: the engine-level integration tests (GameLifecycle /
 * Reconnect / Rehydration) prove the state machine in isolation, but never
 * exercise the socket layer, player-to-socket identity mapping, role-knowledge
 * sanitisation, or the broadcast fan-out. This smoke test closes that gap.
 *
 * Scope-locked to the canonical 7 Avalon roles. No Lancelot/Galahad/Lady
 * variants are referenced here.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, Server as HttpServer } from 'http';
import { AddressInfo } from 'net';
import { Server as SocketIOServer } from 'socket.io';
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';

import { AVALON_CONFIG, Room, Role } from '@avalon/shared';
import { GameServer } from '../../socket/GameServer';
import { authenticateSocket } from '../../middleware/auth';

const CANONICAL_ROLES: readonly Role[] = [
  'merlin',
  'percival',
  'loyal',
  'assassin',
  'morgana',
  'oberon',
  'mordred',
] as const;

interface TestClient {
  uid: string;
  displayName: string;
  socket: ClientSocket;
  latestState: Room | null;
  startedState: Room | null;
  endedState: Room | null;
  errors: string[];
}

async function waitFor<T>(
  predicate: () => T | null | undefined,
  { timeoutMs = 4000, stepMs = 15, label = 'condition' }: { timeoutMs?: number; stepMs?: number; label?: string } = {}
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = predicate();
    if (v !== null && v !== undefined && v !== false) {
      return v as T;
    }
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

function connectGuestClient(
  port: number,
  uid: string,
  displayName: string
): Promise<TestClient> {
  const socket = ioClient(`http://127.0.0.1:${port}`, {
    transports: ['websocket'],
    reconnection: false,
    auth: { token: JSON.stringify({ uid, displayName }) },
  });

  const client: TestClient = {
    uid,
    displayName,
    socket,
    latestState: null,
    startedState: null,
    endedState: null,
    errors: [],
  };

  socket.on('game:state-updated', (room: Room) => {
    client.latestState = room;
  });
  socket.on('game:started', (room: Room) => {
    client.startedState = room;
    client.latestState = room;
  });
  socket.on('game:ended', (room: Room) => {
    client.endedState = room;
    client.latestState = room;
  });
  socket.on('error', (msg: string) => {
    client.errors.push(msg);
  });

  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(client));
    socket.once('connect_error', (err) => reject(err));
    setTimeout(() => reject(new Error(`connect timeout for ${displayName}`)), 4000);
  });
}

describe('M1 smoke: 5 concurrent socket clients complete a full Avalon game', () => {
  let httpServer: HttpServer;
  let io: SocketIOServer;
  let gameServer: GameServer;
  let port: number;
  const clients: TestClient[] = [];

  beforeEach(async () => {
    httpServer = createServer();
    io = new SocketIOServer(httpServer, {
      cors: { origin: true, credentials: true },
    });
    io.use(authenticateSocket);
    gameServer = new GameServer(io);
    gameServer.start();

    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
    port = (httpServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) {
      if (c.socket.connected) c.socket.disconnect();
    }
    await new Promise<void>((resolve) => {
      io.close(() => {
        httpServer.close(() => resolve());
      });
    });
  });

  it('create/join/start/vote/quest x3/assassinate -> ended broadcast reaches all 5 players', async () => {
    // ── 1. Connect 5 guest clients ─────────────────────────────────────────────
    const names = ['Alice', 'Bob', 'Charlie', 'David', 'Eve'];
    for (let i = 0; i < names.length; i++) {
      const uid = `smoke-uid-${i + 1}`;
      clients.push(await connectGuestClient(port, uid, names[i]));
    }
    expect(clients).toHaveLength(5);

    // ── 2. Host creates room ───────────────────────────────────────────────────
    const host = clients[0];
    host.socket.emit('game:create-room', host.displayName);
    const created = await waitFor(
      () => host.latestState?.id ?? null,
      { label: 'host receives created room' }
    );
    const roomId = created as string;
    expect(typeof roomId).toBe('string');
    expect(roomId.length).toBeGreaterThan(0);

    // ── 3. Other 4 players join ────────────────────────────────────────────────
    for (let i = 1; i < clients.length; i++) {
      clients[i].socket.emit('game:join-room', roomId);
    }

    await waitFor(
      () => {
        const r = host.latestState;
        return r && Object.keys(r.players).length === 5 ? r : null;
      },
      { label: 'all 5 players in lobby' }
    );

    // Every client should see 5 players in the lobby.
    for (const c of clients) {
      expect(c.latestState).toBeTruthy();
      expect(Object.keys(c.latestState!.players)).toHaveLength(5);
      expect(c.latestState!.state).toBe('lobby');
    }

    // ── 4. Host starts the game ────────────────────────────────────────────────
    host.socket.emit('game:start-game', roomId);

    await waitFor(
      () => clients.every((c) => c.startedState !== null),
      { label: 'all 5 players receive game:started' }
    );

    // Each player's own view reveals their own role, and all players hold exactly
    // one of the canonical 5-player roles.
    const assignedRoles: Role[] = [];
    for (const c of clients) {
      const mine = c.startedState!.players[c.uid];
      expect(mine).toBeTruthy();
      expect(mine.role).not.toBeNull();
      expect(CANONICAL_ROLES).toContain(mine.role as Role);
      assignedRoles.push(mine.role as Role);
    }
    expect([...assignedRoles].sort()).toEqual([...AVALON_CONFIG[5].roles].sort());

    // All broadcasts should show state=voting, round=1.
    for (const c of clients) {
      expect(c.latestState!.state).toBe('voting');
      expect(c.latestState!.currentRound).toBe(1);
    }

    // ── 5. Find leader via role-aware trick: the leader's client sees state
    //       voting + questTeam empty; every client reports the same leaderIndex,
    //       and we can map that to the player order from host.latestState.players.
    const orderedPlayerIds = Object.keys(host.latestState!.players);
    const leaderIdRound1 = orderedPlayerIds[host.latestState!.leaderIndex % orderedPlayerIds.length];
    const leaderClientRound1 = clients.find((c) => c.uid === leaderIdRound1)!;
    expect(leaderClientRound1).toBeTruthy();

    // ── 6. Play 3 successful quest rounds ──────────────────────────────────────
    // Identify evil-aligned role holders so we can force "good only" team
    // composition and guarantee quest success. Since this is a smoke test, we
    // use the host's *masked* view — evil players are visible to their own
    // clients, so we collect role claims directly.
    const roleByUid = new Map<string, Role>();
    for (const c of clients) {
      const self = c.startedState!.players[c.uid];
      roleByUid.set(c.uid, self.role as Role);
    }
    const goodUids = [...roleByUid.entries()].filter(([, r]) => r === 'merlin' || r === 'percival' || r === 'loyal').map(([id]) => id);
    const assassinUid = [...roleByUid.entries()].find(([, r]) => r === 'assassin')![0];
    const merlinUid = [...roleByUid.entries()].find(([, r]) => r === 'merlin')![0];

    expect(goodUids).toHaveLength(3);
    expect(assassinUid).toBeTruthy();
    expect(merlinUid).toBeTruthy();

    for (let round = 0; round < 3; round++) {
      // 6a. Wait until the state machine is ready for the current round's
      //     team selection (voting + questTeam empty + correct currentRound).
      await waitFor(
        () => {
          const r = host.latestState;
          if (!r) return null;
          if (r.state !== 'voting') return null;
          if (r.currentRound !== round + 1) return null;
          if (r.questTeam.length !== 0) return null;
          return true;
        },
        { label: `round ${round + 1} ready for team selection` }
      );

      const currentRoom = host.latestState!;
      const teamSize = AVALON_CONFIG[5].questTeams[round];
      const leaderId = orderedPlayerIds[currentRoom.leaderIndex % orderedPlayerIds.length];
      const team = [...new Set([...goodUids])].slice(0, teamSize);
      const leaderClient = clients.find((c) => c.uid === leaderId)!;

      leaderClient.socket.emit('game:select-quest-team', roomId, team);

      // 6b. Wait for broadcast reflecting the new quest team.
      await waitFor(
        () => host.latestState?.questTeam.length === teamSize ? true : null,
        { label: `team selection broadcast round ${round + 1}` }
      );

      // 6c. Everyone approves. GameServer enforces a 1-vote-per-second rate
      //     limit per socket (spam guard); in production a round takes far
      //     longer than 1s but our deterministic smoke test races through
      //     rounds in ms, so pace the votes to stay above the limiter floor.
      if (round > 0) await new Promise((r) => setTimeout(r, 1100));
      for (const c of clients) {
        c.socket.emit('game:vote', roomId, c.uid, true);
      }

      // 6d. Wait for transition to quest phase.
      await waitFor(
        () => host.latestState?.state === 'quest' ? true : null,
        { label: `quest phase entered round ${round + 1}` }
      );

      // 6e. Team members vote success.
      for (const uid of team) {
        const c = clients.find((cl) => cl.uid === uid)!;
        c.socket.emit('game:submit-quest-vote', roomId, uid, 'success');
      }

      // 6f. Wait for the round to resolve — either next voting round or
      //     discussion if this was round 3.
      await waitFor(
        () => {
          const r = host.latestState;
          if (!r) return null;
          if (round < 2) return r.state === 'voting' && r.currentRound === round + 2 ? true : null;
          return r.state === 'discussion' ? true : null;
        },
        { label: `round ${round + 1} resolved` }
      );
    }

    // ── 7. Should be in discussion phase with 3 successes recorded ─────────────
    const roomAtDiscussion = host.latestState!;
    expect(roomAtDiscussion.state).toBe('discussion');
    expect(roomAtDiscussion.questResults.filter((r) => r === 'success')).toHaveLength(3);

    // ── 8. Assassin kills Merlin -> evil wins ──────────────────────────────────
    const assassinClient = clients.find((c) => c.uid === assassinUid)!;
    assassinClient.socket.emit('game:assassinate', roomId, assassinUid, merlinUid);

    await waitFor(
      () => clients.every((c) => c.endedState !== null),
      { label: 'all 5 players receive game:ended', timeoutMs: 5000 }
    );

    // ── 9. Final assertions ────────────────────────────────────────────────────
    for (const c of clients) {
      const ended = c.endedState!;
      expect(ended.state).toBe('ended');
      expect(ended.evilWins).toBe(true);
      expect(ended.endReason).toBe('merlin_assassinated');
      expect(ended.assassinTargetId).toBe(merlinUid);
      // At game end, all roles are revealed — every player should see every
      // player's role.
      for (const p of Object.values(ended.players)) {
        expect(p.role).not.toBeNull();
      }
    }

    // No unexpected errors reported on any socket.
    for (const c of clients) {
      expect(c.errors).toEqual([]);
    }
  }, 30_000);

  it('rejects vote spoofing: client-supplied playerId is ignored, only socket identity counts', async () => {
    const names = ['Alice', 'Bob', 'Charlie', 'David', 'Eve'];
    for (let i = 0; i < names.length; i++) {
      clients.push(await connectGuestClient(port, `spoof-uid-${i + 1}`, names[i]));
    }

    const host = clients[0];
    host.socket.emit('game:create-room', host.displayName);
    const roomId = await waitFor(
      () => host.latestState?.id ?? null,
      { label: 'host receives created room' }
    );
    for (let i = 1; i < clients.length; i++) {
      clients[i].socket.emit('game:join-room', roomId as string);
    }
    await waitFor(
      () => host.latestState && Object.keys(host.latestState.players).length === 5 ? true : null,
      { label: 'all 5 players in lobby' }
    );

    host.socket.emit('game:start-game', roomId as string);
    await waitFor(
      () => clients.every((c) => c.startedState !== null),
      { label: 'all 5 players receive game:started' }
    );

    // Leader selects a team; voting phase opens.
    const orderedPlayerIds = Object.keys(host.latestState!.players);
    const leaderId = orderedPlayerIds[host.latestState!.leaderIndex % orderedPlayerIds.length];
    const leader = clients.find((c) => c.uid === leaderId)!;
    leader.socket.emit(
      'game:select-quest-team',
      roomId as string,
      orderedPlayerIds.slice(0, AVALON_CONFIG[5].questTeams[0])
    );
    await waitFor(
      () => host.latestState?.questTeam.length === AVALON_CONFIG[5].questTeams[0] ? true : null,
      { label: 'team selected' }
    );

    // Alice (spoof-uid-1) tries to cast a vote on Bob's (spoof-uid-2) behalf
    // by putting Bob's uid in the payload. Server must record it as Alice's
    // own vote, not Bob's.
    host.socket.emit('game:vote', roomId as string, 'spoof-uid-2', false);

    await waitFor(
      () => host.latestState && Object.keys(host.latestState.votes).length >= 1 ? true : null,
      { label: 'spoofed vote processed' }
    );

    // Inspect Alice's own view — "has voted" appears for Alice's uid, NOT Bob's.
    expect(host.latestState!.votes['spoof-uid-1']).toBeDefined();
    expect(host.latestState!.votes['spoof-uid-2']).toBeUndefined();
  }, 20_000);

  it('rejects assassination by non-assassin (server verifies role from socket identity)', async () => {
    const names = ['Alice', 'Bob', 'Charlie', 'David', 'Eve'];
    for (let i = 0; i < names.length; i++) {
      clients.push(await connectGuestClient(port, `assn-uid-${i + 1}`, names[i]));
    }

    const host = clients[0];
    host.socket.emit('game:create-room', host.displayName);
    const roomId = await waitFor(
      () => host.latestState?.id ?? null,
      { label: 'host receives created room' }
    );
    for (let i = 1; i < clients.length; i++) {
      clients[i].socket.emit('game:join-room', roomId as string);
    }
    await waitFor(
      () => host.latestState && Object.keys(host.latestState.players).length === 5 ? true : null,
      { label: 'all 5 players in lobby' }
    );

    host.socket.emit('game:start-game', roomId as string);
    await waitFor(
      () => clients.every((c) => c.startedState !== null),
      { label: 'all 5 players receive game:started' }
    );

    // Locate assassin + Merlin from each client's own-role view.
    const roleByUid = new Map<string, Role>();
    for (const c of clients) {
      roleByUid.set(c.uid, c.startedState!.players[c.uid].role as Role);
    }
    const assassinUid = [...roleByUid.entries()].find(([, r]) => r === 'assassin')![0];
    const merlinUid = [...roleByUid.entries()].find(([, r]) => r === 'merlin')![0];
    // Pick a non-assassin, non-merlin player as the attempted spoofer.
    const nonAssassinUid = orderedUidNotEqual(roleByUid, [assassinUid, merlinUid]);

    const nonAssassinClient = clients.find((c) => c.uid === nonAssassinUid)!;
    // The game is still in voting phase, so this should be rejected for
    // BOTH phase-mismatch AND role-mismatch reasons. Either error is fine.
    nonAssassinClient.errors.length = 0;
    nonAssassinClient.socket.emit(
      'game:assassinate',
      roomId as string,
      // Client pretends to be the assassin. Server must ignore this.
      assassinUid,
      merlinUid
    );

    // Wait briefly for the error to come back.
    await waitFor(
      () => nonAssassinClient.errors.length > 0 ? true : null,
      { label: 'spoofed assassination produces error', timeoutMs: 2000 }
    );
    expect(nonAssassinClient.errors.length).toBeGreaterThan(0);
    // Game should NOT have ended.
    expect(host.latestState!.state).not.toBe('ended');
  }, 20_000);
});

/** Pick any uid from `map` that is not in the `exclude` list. */
function orderedUidNotEqual(map: Map<string, Role>, exclude: string[]): string {
  for (const uid of map.keys()) {
    if (!exclude.includes(uid)) return uid;
  }
  throw new Error('No suitable uid found');
}
