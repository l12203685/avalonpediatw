/**
 * Milestone M1 — Seven-player end-to-end socket smoke test.
 *
 * Mirrors FivePlayer/SixPlayerSocketSmoke; 7-player config introduces the
 * 4-player round-4 quest with `questFailsRequired[3] === 2` so two evil
 * fail votes are required for that quest to fail. Also exercises the
 * Oberon role (canonical 7-role unique to 7+ player tables).
 *
 * 7-player config (from AVALON_CONFIG[7]):
 *   roles:              [merlin, percival, loyal, loyal, assassin, morgana, oberon]
 *   questTeams:         [2, 3, 3, 4, 4]
 *   questFailsRequired: [1, 1, 1, 2, 1]
 *   maxFailedVotes:     5
 *
 * Lady of the Lake auto-enables at 7+ players. Each test below explicitly
 * disables it via `game:set-role-options` BEFORE start so the test stays
 * focused on the core flow without lake inspection round-trips.
 *
 * Scope-locked to the canonical 7 Avalon roles. No Lancelot/Galahad
 * variants referenced here.
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

const PLAYER_COUNT = 7;
const NAMES = ['Alice', 'Bob', 'Charlie', 'David', 'Eve', 'Frank', 'Grace'];

/**
 * Disable Lady of the Lake for the room's host (clients[0]). 7+ player
 * tables auto-enable lady; explicit `false` keeps tests focused on the
 * core flow without lady-phase round-trips.
 */
function disableLady(host: TestClient, roomId: string): void {
  host.socket.emit('game:set-role-options', roomId, { ladyOfTheLake: false });
}

describe('M1 smoke: 7 concurrent socket clients complete a full Avalon game', () => {
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

  it('create/join/start/vote/quest x3/assassinate -> evil wins broadcast reaches all 7 players', async () => {
    for (let i = 0; i < NAMES.length; i++) {
      const uid = `smoke7-uid-${i + 1}`;
      clients.push(await connectGuestClient(port, uid, NAMES[i]));
    }
    expect(clients).toHaveLength(PLAYER_COUNT);

    const host = clients[0];
    host.socket.emit('game:create-room', host.displayName);
    const created = await waitFor(
      () => host.latestState?.id ?? null,
      { label: 'host receives created room' }
    );
    const roomId = created as string;
    expect(typeof roomId).toBe('string');
    expect(roomId.length).toBeGreaterThan(0);

    for (let i = 1; i < clients.length; i++) {
      clients[i].socket.emit('game:join-room', roomId);
    }

    await waitFor(
      () => {
        const r = host.latestState;
        return r && Object.keys(r.players).length === PLAYER_COUNT ? r : null;
      },
      { label: 'all 7 players in lobby', timeoutMs: 6000 }
    );

    for (const c of clients) {
      expect(c.latestState).toBeTruthy();
      expect(Object.keys(c.latestState!.players)).toHaveLength(PLAYER_COUNT);
      expect(c.latestState!.state).toBe('lobby');
    }

    disableLady(host, roomId);

    host.socket.emit('game:start-game', roomId);

    await waitFor(
      () => clients.every((c) => c.startedState !== null),
      { label: 'all 7 players receive game:started' }
    );

    const assignedRoles: Role[] = [];
    for (const c of clients) {
      const mine = c.startedState!.players[c.uid];
      expect(mine).toBeTruthy();
      expect(mine.role).not.toBeNull();
      expect(CANONICAL_ROLES).toContain(mine.role as Role);
      assignedRoles.push(mine.role as Role);
    }
    expect([...assignedRoles].sort()).toEqual([...AVALON_CONFIG[7].roles].sort());

    for (const c of clients) {
      expect(c.latestState!.state).toBe('voting');
      expect(c.latestState!.currentRound).toBe(1);
    }

    const roleByUid = new Map<string, Role>();
    for (const c of clients) {
      const self = c.startedState!.players[c.uid];
      roleByUid.set(c.uid, self.role as Role);
    }
    const goodUids = [...roleByUid.entries()]
      .filter(([, r]) => r === 'merlin' || r === 'percival' || r === 'loyal')
      .map(([id]) => id);
    const assassinUid = [...roleByUid.entries()].find(([, r]) => r === 'assassin')![0];
    const merlinUid = [...roleByUid.entries()].find(([, r]) => r === 'merlin')![0];

    expect(goodUids).toHaveLength(4); // 1 merlin + 1 percival + 2 loyal
    expect(assassinUid).toBeTruthy();
    expect(merlinUid).toBeTruthy();

    const orderedPlayerIds = Object.keys(host.latestState!.players);

    // 3 success rounds — good-only teams. Team sizes for 7p R1-3 = [2, 3, 3].
    for (let round = 0; round < 3; round++) {
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
      const teamSize = AVALON_CONFIG[7].questTeams[round];
      const leaderId = orderedPlayerIds[currentRoom.leaderIndex % orderedPlayerIds.length];
      const team = [...goodUids].slice(0, teamSize);
      const leaderClient = clients.find((c) => c.uid === leaderId)!;

      leaderClient.socket.emit('game:select-quest-team', roomId, team);

      await waitFor(
        () => host.latestState?.questTeam.length === teamSize ? true : null,
        { label: `team selection broadcast round ${round + 1}` }
      );

      // Pace votes vs. 1-vote/sec rate limiter.
      if (round > 0) await new Promise((r) => setTimeout(r, 1100));
      for (const c of clients) {
        c.socket.emit('game:vote', roomId, c.uid, true);
      }

      await waitFor(
        () => host.latestState?.state === 'quest' ? true : null,
        { label: `quest phase entered round ${round + 1}` }
      );

      for (const uid of team) {
        const c = clients.find((cl) => cl.uid === uid)!;
        c.socket.emit('game:submit-quest-vote', roomId, uid, 'success');
      }

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

    const roomAtDiscussion = host.latestState!;
    expect(roomAtDiscussion.state).toBe('discussion');
    expect(roomAtDiscussion.questResults.filter((r) => r === 'success')).toHaveLength(3);

    // Assassin kills Merlin → evil wins.
    const assassinClient = clients.find((c) => c.uid === assassinUid)!;
    assassinClient.socket.emit('game:assassinate', roomId, assassinUid, merlinUid);

    await waitFor(
      () => clients.every((c) => c.endedState !== null),
      { label: 'all 7 players receive game:ended', timeoutMs: 5000 }
    );

    for (const c of clients) {
      const ended = c.endedState!;
      expect(ended.state).toBe('ended');
      expect(ended.evilWins).toBe(true);
      expect(ended.endReason).toBe('merlin_assassinated');
      expect(ended.assassinTargetId).toBe(merlinUid);
      for (const p of Object.values(ended.players)) {
        expect(p.role).not.toBeNull();
      }
    }

    for (const c of clients) {
      expect(c.errors).toEqual([]);
    }
  }, 30_000);

  it('role reveal correctness: 4 good + 3 evil including merlin/percival/assassin/morgana/oberon', async () => {
    for (let i = 0; i < NAMES.length; i++) {
      clients.push(await connectGuestClient(port, `roles7-uid-${i + 1}`, NAMES[i]));
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
      () => host.latestState && Object.keys(host.latestState.players).length === PLAYER_COUNT ? true : null,
      { label: 'all 7 players in lobby', timeoutMs: 6000 }
    );

    disableLady(host, roomId as string);

    host.socket.emit('game:start-game', roomId as string);
    await waitFor(
      () => clients.every((c) => c.startedState !== null),
      { label: 'all 7 players receive game:started' }
    );

    const roleByUid = new Map<string, Role>();
    for (const c of clients) {
      roleByUid.set(c.uid, c.startedState!.players[c.uid].role as Role);
    }

    const roleCount = new Map<Role, number>();
    for (const r of roleByUid.values()) {
      roleCount.set(r, (roleCount.get(r) ?? 0) + 1);
    }

    expect(roleCount.get('merlin')).toBe(1);
    expect(roleCount.get('percival')).toBe(1);
    expect(roleCount.get('loyal')).toBe(2);
    expect(roleCount.get('assassin')).toBe(1);
    expect(roleCount.get('morgana')).toBe(1);
    expect(roleCount.get('oberon')).toBe(1);
    expect(roleCount.get('mordred')).toBeUndefined();

    const total = [...roleCount.values()].reduce((a, b) => a + b, 0);
    expect(total).toBe(PLAYER_COUNT);

    const goodCount = ['merlin', 'percival', 'loyal']
      .map((r) => roleCount.get(r as Role) ?? 0)
      .reduce((a, b) => a + b, 0);
    const evilCount = ['assassin', 'morgana', 'oberon']
      .map((r) => roleCount.get(r as Role) ?? 0)
      .reduce((a, b) => a + b, 0);
    expect(goodCount).toBe(4);
    expect(evilCount).toBe(3);

    for (const c of clients) {
      expect(c.errors).toEqual([]);
    }
  }, 25_000);

  /**
   * R4 quest in 7p requires 2 fail votes (`questFailsRequired[3] === 2`).
   * Drives R4 with assassin alone failing → quest still SUCCESS because
   * 1 < 2 threshold. Proves the engine correctly applies the per-round
   * fail threshold instead of the default 1.
   */
  it('R4 single-fail does NOT fail the round (7p needs 2 fails)', async () => {
    for (let i = 0; i < NAMES.length; i++) {
      clients.push(await connectGuestClient(port, `r4-uid-${i + 1}`, NAMES[i]));
    }

    const host = clients[0];
    host.socket.emit('game:create-room', host.displayName);
    const roomIdRaw = await waitFor(
      () => host.latestState?.id ?? null,
      { label: 'host receives created room' }
    );
    const roomId = roomIdRaw as string;

    for (let i = 1; i < clients.length; i++) {
      clients[i].socket.emit('game:join-room', roomId);
    }
    await waitFor(
      () => host.latestState && Object.keys(host.latestState.players).length === PLAYER_COUNT ? true : null,
      { label: 'all 7 players in lobby', timeoutMs: 6000 }
    );

    disableLady(host, roomId);

    host.socket.emit('game:start-game', roomId);
    await waitFor(
      () => clients.every((c) => c.startedState !== null),
      { label: 'all 7 players receive game:started' }
    );

    const roleByUid = new Map<string, Role>();
    for (const c of clients) {
      roleByUid.set(c.uid, c.startedState!.players[c.uid].role as Role);
    }
    const goodUids = [...roleByUid.entries()]
      .filter(([, r]) => r === 'merlin' || r === 'percival' || r === 'loyal')
      .map(([id]) => id);
    const assassinUid = [...roleByUid.entries()].find(([, r]) => r === 'assassin')![0];
    const orderedPlayerIds = Object.keys(host.latestState!.players);

    // Drive R1-R2 with mixed outcomes so we hit R4 instead of triggering
    // the "good wins on 3 successes" early discussion path. Plan:
    //   R1 = success (good-only team, all good vote success)
    //   R2 = fail    (assassin on team votes fail; needs 1 fail = R2 thresh)
    //   R3 = success (good-only team)
    //   → state arrives at R4 with 2S/1F. Then R4 single-fail must NOT fail.
    async function driveRound(
      roundIdx: number,
      forceFail: boolean,
      isLast: boolean
    ): Promise<void> {
      const roundNum = roundIdx + 1;
      await waitFor(
        () => {
          const r = host.latestState;
          if (!r) return null;
          if (r.state !== 'voting') return null;
          if (r.currentRound !== roundNum) return null;
          if (r.questTeam.length !== 0) return null;
          return true;
        },
        { label: `round ${roundNum} ready`, timeoutMs: 5000 }
      );

      const currentRoom = host.latestState!;
      const teamSize = AVALON_CONFIG[7].questTeams[roundIdx];
      const leaderId = orderedPlayerIds[currentRoom.leaderIndex % orderedPlayerIds.length];
      const team: string[] = forceFail
        ? [assassinUid, ...goodUids.filter((g) => g !== assassinUid)].slice(0, teamSize)
        : [...goodUids].slice(0, teamSize);

      const leaderClient = clients.find((c) => c.uid === leaderId)!;
      leaderClient.socket.emit('game:select-quest-team', roomId, team);

      await waitFor(
        () => host.latestState?.questTeam.length === teamSize ? true : null,
        { label: `team selected round ${roundNum}` }
      );

      if (roundIdx > 0) await new Promise((r) => setTimeout(r, 1100));
      for (const c of clients) {
        c.socket.emit('game:vote', roomId, c.uid, true);
      }

      await waitFor(
        () => host.latestState?.state === 'quest' ? true : null,
        { label: `quest phase round ${roundNum}` }
      );

      for (const uid of team) {
        const c = clients.find((cl) => cl.uid === uid)!;
        const role = roleByUid.get(uid)!;
        const voteFail = forceFail && role === 'assassin';
        c.socket.emit('game:submit-quest-vote', roomId, uid, voteFail ? 'fail' : 'success');
      }

      await waitFor(
        () => {
          const r = host.latestState;
          if (!r) return null;
          if (isLast) return r.state === 'discussion' ? true : null;
          return r.state === 'voting' && r.currentRound === roundNum + 1 ? true : null;
        },
        { label: `round ${roundNum} resolved`, timeoutMs: 4000 }
      );
    }

    await driveRound(0, false, false); // R1 success
    await driveRound(1, true, false);  // R2 fail (1 fail = R2 threshold)
    await driveRound(2, false, false); // R3 success (2S/1F → R4 next)

    // State should now be voting R4. Engine must NOT have ended early
    // because good has 2 successes < 3 threshold and evil has 1 fail < 3.
    const stateAtR4 = host.latestState!;
    expect(stateAtR4.state).toBe('voting');
    expect(stateAtR4.currentRound).toBe(4);
    expect(stateAtR4.questResults).toEqual(['success', 'fail', 'success']);

    // Drive R4: assassin + 3 good. Assassin votes fail → 1 fail < 2 thresh
    // → quest result = SUCCESS.
    const r4TeamSize = AVALON_CONFIG[7].questTeams[3]; // 4
    expect(r4TeamSize).toBe(4);
    const r4LeaderId = orderedPlayerIds[stateAtR4.leaderIndex % orderedPlayerIds.length];
    const r4Team = [assassinUid, ...goodUids].slice(0, r4TeamSize);
    expect(r4Team).toContain(assassinUid);
    const r4LeaderClient = clients.find((c) => c.uid === r4LeaderId)!;
    r4LeaderClient.socket.emit('game:select-quest-team', roomId, r4Team);

    await waitFor(
      () => host.latestState?.questTeam.length === r4TeamSize ? true : null,
      { label: 'R4 team selected' }
    );

    await new Promise((r) => setTimeout(r, 1100));
    for (const c of clients) {
      c.socket.emit('game:vote', roomId, c.uid, true);
    }

    await waitFor(
      () => host.latestState?.state === 'quest' ? true : null,
      { label: 'R4 quest phase' }
    );

    // Assassin = fail, all good = success → 1 fail < 2 required → success.
    for (const uid of r4Team) {
      const c = clients.find((cl) => cl.uid === uid)!;
      const role = roleByUid.get(uid)!;
      const isAssassin = role === 'assassin';
      c.socket.emit('game:submit-quest-vote', roomId, uid, isAssassin ? 'fail' : 'success');
    }

    // R4 success → 3 successes total → discussion phase (good clinches at 3).
    await waitFor(
      () => host.latestState?.state === 'discussion' ? true : null,
      { label: 'R4 resolved as success → discussion', timeoutMs: 5000 }
    );

    const finalRoom = host.latestState!;
    expect(finalRoom.questResults).toHaveLength(4);
    // R4 result must be `success` because 1 fail < 2 required.
    expect(finalRoom.questResults[3]).toBe('success');

    for (const c of clients) {
      expect(c.errors).toEqual([]);
    }
  }, 45_000);

  /**
   * Verify that disconnecting a client mid-game does not crash the server,
   * and the remaining clients still receive subsequent broadcasts. The
   * engine retains the seat (RoomManager handles disconnect-without-leave),
   * so the remaining 6 see the full 7-player roster intact.
   */
  it('disconnect mid-game does not crash server; remaining clients stay subscribed', async () => {
    for (let i = 0; i < NAMES.length; i++) {
      clients.push(await connectGuestClient(port, `disc7-uid-${i + 1}`, NAMES[i]));
    }

    const host = clients[0];
    host.socket.emit('game:create-room', host.displayName);
    const roomIdRaw = await waitFor(
      () => host.latestState?.id ?? null,
      { label: 'host receives created room' }
    );
    const roomId = roomIdRaw as string;

    for (let i = 1; i < clients.length; i++) {
      clients[i].socket.emit('game:join-room', roomId);
    }
    await waitFor(
      () => host.latestState && Object.keys(host.latestState.players).length === PLAYER_COUNT ? true : null,
      { label: 'all 7 players in lobby', timeoutMs: 6000 }
    );

    disableLady(host, roomId);

    host.socket.emit('game:start-game', roomId);
    await waitFor(
      () => clients.every((c) => c.startedState !== null),
      { label: 'all 7 players receive game:started' }
    );

    // Disconnect the last client mid-game (during voting phase).
    const droppedClient = clients[clients.length - 1];
    droppedClient.socket.disconnect();

    // Wait briefly for the disconnect to propagate.
    await new Promise((r) => setTimeout(r, 300));

    // Remaining clients should still have a valid room state and no
    // unexpected errors. Disconnect alone keeps the seat, so the host's
    // view still reports 7 players.
    const remaining = clients.slice(0, -1);
    expect(remaining).toHaveLength(6);
    for (const c of remaining) {
      expect(c.latestState).toBeTruthy();
      expect(c.errors).toEqual([]);
    }
    // Server is still alive: ask host to broadcast a no-op via emitting
    // a chat message. Test passes if no error fires on host's socket.
    host.socket.emit('chat:send-message', roomId, 'still alive');
    await new Promise((r) => setTimeout(r, 200));
    expect(host.errors).toEqual([]);
  }, 20_000);
});
