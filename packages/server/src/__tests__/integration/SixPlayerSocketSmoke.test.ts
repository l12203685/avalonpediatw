/**
 * Milestone M1 — Six-player end-to-end socket smoke test.
 *
 * Clone of FivePlayerSocketSmoke.test.ts adapted for the 6-player Avalon
 * configuration (4 good / 2 evil). Same architecture: real Socket.IO
 * GameServer in-process, 6 guest clients, drives full games through
 * create -> join -> start -> vote -> quest x N -> (assassinate |
 * failed_quests | vote_rejections) -> game:ended, and asserts broadcast
 * state.
 *
 * 6-player config (from AVALON_CONFIG[6]):
 *   roles:              [merlin, percival, loyal, loyal, assassin, morgana]
 *   questTeams:         [2, 3, 4, 3, 4]
 *   questFailsRequired: [1, 1, 1, 1, 1]
 *   maxFailedVotes:     5
 *
 * Scope-locked to the canonical 7 Avalon roles. No Lancelot/Galahad/Lady
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

const PLAYER_COUNT = 6;
const NAMES = ['Alice', 'Bob', 'Charlie', 'David', 'Eve', 'Frank'];

describe('M1 smoke: 6 concurrent socket clients complete a full Avalon game', () => {
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

  it('create/join/start/vote/quest x3/assassinate -> evil wins broadcast reaches all 6 players', async () => {
    // ── 1. Connect 6 guest clients ─────────────────────────────────────────────
    for (let i = 0; i < NAMES.length; i++) {
      const uid = `smoke6-uid-${i + 1}`;
      clients.push(await connectGuestClient(port, uid, NAMES[i]));
    }
    expect(clients).toHaveLength(PLAYER_COUNT);

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

    // ── 3. Other 5 players join ────────────────────────────────────────────────
    for (let i = 1; i < clients.length; i++) {
      clients[i].socket.emit('game:join-room', roomId);
    }

    await waitFor(
      () => {
        const r = host.latestState;
        return r && Object.keys(r.players).length === PLAYER_COUNT ? r : null;
      },
      { label: 'all 6 players in lobby' }
    );

    for (const c of clients) {
      expect(c.latestState).toBeTruthy();
      expect(Object.keys(c.latestState!.players)).toHaveLength(PLAYER_COUNT);
      expect(c.latestState!.state).toBe('lobby');
    }

    // ── 4. Host starts the game ────────────────────────────────────────────────
    host.socket.emit('game:start-game', roomId);

    await waitFor(
      () => clients.every((c) => c.startedState !== null),
      { label: 'all 6 players receive game:started' }
    );

    // Each player's own view reveals their own role. Assigned set equals the
    // canonical 6-player role list.
    const assignedRoles: Role[] = [];
    for (const c of clients) {
      const mine = c.startedState!.players[c.uid];
      expect(mine).toBeTruthy();
      expect(mine.role).not.toBeNull();
      expect(CANONICAL_ROLES).toContain(mine.role as Role);
      assignedRoles.push(mine.role as Role);
    }
    expect([...assignedRoles].sort()).toEqual([...AVALON_CONFIG[6].roles].sort());

    for (const c of clients) {
      expect(c.latestState!.state).toBe('voting');
      expect(c.latestState!.currentRound).toBe(1);
    }

    // ── 5. Identify good/evil split deterministically from each client's view.
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

    // ── 6. Play 3 successful quest rounds — good-only teams.
    //     Team sizes for rounds 1-3 are [2, 3, 4] (per AVALON_CONFIG[6]).
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
      const teamSize = AVALON_CONFIG[6].questTeams[round];
      const leaderId = orderedPlayerIds[currentRoom.leaderIndex % orderedPlayerIds.length];
      const team = [...new Set([...goodUids])].slice(0, teamSize);
      const leaderClient = clients.find((c) => c.uid === leaderId)!;

      leaderClient.socket.emit('game:select-quest-team', roomId, team);

      await waitFor(
        () => host.latestState?.questTeam.length === teamSize ? true : null,
        { label: `team selection broadcast round ${round + 1}` }
      );

      // Pace votes vs. 1-vote/sec rate limiter (applies to game:vote only).
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

    // ── 7. Should be in discussion phase with 3 successes recorded ─────────────
    const roomAtDiscussion = host.latestState!;
    expect(roomAtDiscussion.state).toBe('discussion');
    expect(roomAtDiscussion.questResults.filter((r) => r === 'success')).toHaveLength(3);

    // ── 8. Assassin kills Merlin -> evil wins ──────────────────────────────────
    const assassinClient = clients.find((c) => c.uid === assassinUid)!;
    assassinClient.socket.emit('game:assassinate', roomId, assassinUid, merlinUid);

    await waitFor(
      () => clients.every((c) => c.endedState !== null),
      { label: 'all 6 players receive game:ended', timeoutMs: 5000 }
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

  it('role reveal correctness: exactly 4 good + 2 evil, including merlin/percival/assassin/morgana', async () => {
    for (let i = 0; i < NAMES.length; i++) {
      clients.push(await connectGuestClient(port, `roles6-uid-${i + 1}`, NAMES[i]));
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
      { label: 'all 6 players in lobby' }
    );

    host.socket.emit('game:start-game', roomId as string);
    await waitFor(
      () => clients.every((c) => c.startedState !== null),
      { label: 'all 6 players receive game:started' }
    );

    // Collect role map from each client's self-view.
    const roleByUid = new Map<string, Role>();
    for (const c of clients) {
      roleByUid.set(c.uid, c.startedState!.players[c.uid].role as Role);
    }

    const roleCount = new Map<Role, number>();
    for (const r of roleByUid.values()) {
      roleCount.set(r, (roleCount.get(r) ?? 0) + 1);
    }

    // 6-player expected distribution: 1 merlin, 1 percival, 2 loyal, 1 assassin, 1 morgana.
    expect(roleCount.get('merlin')).toBe(1);
    expect(roleCount.get('percival')).toBe(1);
    expect(roleCount.get('loyal')).toBe(2);
    expect(roleCount.get('assassin')).toBe(1);
    expect(roleCount.get('morgana')).toBe(1);
    // No other roles present.
    expect(roleCount.get('oberon')).toBeUndefined();
    expect(roleCount.get('mordred')).toBeUndefined();

    const total = [...roleCount.values()].reduce((a, b) => a + b, 0);
    expect(total).toBe(PLAYER_COUNT);

    // Good/evil split.
    const goodCount = ['merlin', 'percival', 'loyal']
      .map((r) => roleCount.get(r as Role) ?? 0)
      .reduce((a, b) => a + b, 0);
    const evilCount = ['assassin', 'morgana']
      .map((r) => roleCount.get(r as Role) ?? 0)
      .reduce((a, b) => a + b, 0);
    expect(goodCount).toBe(4);
    expect(evilCount).toBe(2);

    for (const c of clients) {
      expect(c.errors).toEqual([]);
    }
  }, 20_000);
});

/**
 * Quarantine toggle mirrors the 5-player pattern: full-round test paces votes
 * against the 1-vote-per-second rate limiter and waits on multi-stage
 * broadcast propagation. Set `AVALON_QUARANTINE_6P=1` in CI env to skip.
 */
const QUARANTINE_6P_FULL = process.env.AVALON_QUARANTINE_6P === '1';

describe('M1 smoke: 6-player FULL Avalon game end-to-end', () => {
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

  (QUARANTINE_6P_FULL ? it.skip : it)(
    'rounds 1-5 with mixed quest outcomes (3 success / 2 fail) -> assassination_failed (good wins) broadcast reaches all 6 players',
    async () => {
      for (let i = 0; i < NAMES.length; i++) {
        const uid = `full6-uid-${i + 1}`;
        clients.push(await connectGuestClient(port, uid, NAMES[i]));
      }
      expect(clients).toHaveLength(PLAYER_COUNT);

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
        { label: 'all 6 players in lobby' }
      );

      host.socket.emit('game:start-game', roomId);
      await waitFor(
        () => clients.every((c) => c.startedState !== null),
        { label: 'all 6 players receive game:started' }
      );

      const assignedRoles: Role[] = clients.map((c) => c.startedState!.players[c.uid].role as Role);
      expect([...assignedRoles].sort()).toEqual([...AVALON_CONFIG[6].roles].sort());

      const roleByUid = new Map<string, Role>();
      for (const c of clients) {
        roleByUid.set(c.uid, c.startedState!.players[c.uid].role as Role);
      }
      const goodUids = [...roleByUid.entries()]
        .filter(([, r]) => r === 'merlin' || r === 'percival' || r === 'loyal')
        .map(([id]) => id);
      const evilUids = [...roleByUid.entries()]
        .filter(([, r]) => r === 'assassin' || r === 'morgana')
        .map(([id]) => id);
      const merlinUid = [...roleByUid.entries()].find(([, r]) => r === 'merlin')![0];
      const assassinUid = [...roleByUid.entries()].find(([, r]) => r === 'assassin')![0];
      expect(goodUids).toHaveLength(4);
      expect(evilUids).toHaveLength(2);
      expect(merlinUid).toBeTruthy();
      expect(assassinUid).toBeTruthy();

      const orderedPlayerIds = Object.keys(host.latestState!.players);

      async function driveRound(roundIdx: number, forceFail: boolean, isLast: boolean): Promise<void> {
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
          { label: `round ${roundNum} ready for team selection`, timeoutMs: 5000 }
        );

        const currentRoom = host.latestState!;
        const teamSize = AVALON_CONFIG[6].questTeams[roundIdx];
        const leaderId = orderedPlayerIds[currentRoom.leaderIndex % orderedPlayerIds.length];

        // Team composition: forceFail -> include assassin + fill with good;
        //                   else       -> good-only slice.
        const team: string[] = forceFail
          ? [assassinUid, ...goodUids.filter((g) => g !== assassinUid)].slice(0, teamSize)
          : [...goodUids].slice(0, teamSize);
        expect(team).toHaveLength(teamSize);
        if (forceFail) expect(team).toContain(assassinUid);

        const leaderClient = clients.find((c) => c.uid === leaderId)!;
        leaderClient.socket.emit('game:select-quest-team', roomId, team);

        await waitFor(
          () => host.latestState?.questTeam.length === teamSize ? true : null,
          { label: `team selected broadcast round ${roundNum}`, timeoutMs: 3000 }
        );

        if (roundIdx > 0) await new Promise((r) => setTimeout(r, 1100));
        for (const c of clients) {
          c.socket.emit('game:vote', roomId, c.uid, true);
        }

        await waitFor(
          () => host.latestState?.state === 'quest' ? true : null,
          { label: `quest phase entered round ${roundNum}`, timeoutMs: 3000 }
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

      // Drive 5 rounds: S, F, S, F, S -> good 3-2 -> discussion phase.
      // (6-player rules: 1 fail vote required per round for quest fail.)
      await driveRound(0, false, false); // R1 success
      await driveRound(1, true,  false); // R2 fail
      await driveRound(2, false, false); // R3 success
      await driveRound(3, true,  false); // R4 fail
      await driveRound(4, false, true);  // R5 success -> discussion

      const roomAtDiscussion = host.latestState!;
      expect(roomAtDiscussion.state).toBe('discussion');
      expect(roomAtDiscussion.questResults).toEqual(['success', 'fail', 'success', 'fail', 'success']);
      expect(roomAtDiscussion.questResults.filter((r) => r === 'success')).toHaveLength(3);
      expect(roomAtDiscussion.questResults.filter((r) => r === 'fail')).toHaveLength(2);
      expect(roomAtDiscussion.questHistory).toHaveLength(5);
      for (const c of clients) {
        expect(c.latestState!.state).toBe('discussion');
        expect(c.latestState!.questHistory).toHaveLength(5);
      }

      // Assassin misses Merlin -> GOOD wins.
      const nonMerlinTargetUid = goodUids.find((g) => g !== merlinUid)!;
      expect(nonMerlinTargetUid).toBeTruthy();
      expect(nonMerlinTargetUid).not.toBe(merlinUid);

      const assassinClient = clients.find((c) => c.uid === assassinUid)!;
      assassinClient.socket.emit('game:assassinate', roomId, assassinUid, nonMerlinTargetUid);

      await waitFor(
        () => clients.every((c) => c.endedState !== null),
        { label: 'all 6 players receive game:ended (good wins)', timeoutMs: 5000 }
      );

      for (const c of clients) {
        const ended = c.endedState!;
        expect(ended.state).toBe('ended');
        expect(ended.evilWins).toBe(false);
        expect(ended.endReason).toBe('assassination_failed');
        expect(ended.assassinTargetId).toBe(nonMerlinTargetUid);
        for (const p of Object.values(ended.players)) {
          expect(p.role).not.toBeNull();
          expect(CANONICAL_ROLES).toContain(p.role as Role);
        }
      }

      for (const c of clients) {
        expect(c.errors).toEqual([]);
      }
    },
    45_000
  );

  (QUARANTINE_6P_FULL ? it.skip : it)(
    'evil wins via 3 failed quests in rounds 1-3 (no assassination phase) broadcast reaches all 6 players',
    async () => {
      for (let i = 0; i < NAMES.length; i++) {
        const uid = `evil6-uid-${i + 1}`;
        clients.push(await connectGuestClient(port, uid, NAMES[i]));
      }
      expect(clients).toHaveLength(PLAYER_COUNT);

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
        { label: 'all 6 players in lobby' }
      );

      host.socket.emit('game:start-game', roomId);
      await waitFor(
        () => clients.every((c) => c.startedState !== null),
        { label: 'all 6 players receive game:started' }
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

      // Drive rounds 1-3, all fail (assassin on team votes fail each time).
      // Because questFailsRequired[i] = 1 for each round in 6p, 3 consecutive
      // fails ends the game with endReason='failed_quests' before reaching R4.
      for (let round = 0; round < 3; round++) {
        await waitFor(
          () => {
            const r = host.latestState;
            if (!r) return null;
            if (r.state === 'ended') return true; // game may end before R3 completes
            if (r.state !== 'voting') return null;
            if (r.currentRound !== round + 1) return null;
            if (r.questTeam.length !== 0) return null;
            return true;
          },
          { label: `round ${round + 1} ready for team selection`, timeoutMs: 5000 }
        );

        if (host.latestState!.state === 'ended') break;

        const currentRoom = host.latestState!;
        const teamSize = AVALON_CONFIG[6].questTeams[round];
        const leaderId = orderedPlayerIds[currentRoom.leaderIndex % orderedPlayerIds.length];
        // Assassin + enough good players to fill. Assassin votes fail each round.
        const team = [assassinUid, ...goodUids.filter((g) => g !== assassinUid)].slice(0, teamSize);

        const leaderClient = clients.find((c) => c.uid === leaderId)!;
        leaderClient.socket.emit('game:select-quest-team', roomId, team);

        await waitFor(
          () => host.latestState?.questTeam.length === teamSize ? true : null,
          { label: `team selected broadcast round ${round + 1}`, timeoutMs: 3000 }
        );

        if (round > 0) await new Promise((r) => setTimeout(r, 1100));
        for (const c of clients) {
          c.socket.emit('game:vote', roomId, c.uid, true);
        }

        await waitFor(
          () => host.latestState?.state === 'quest' ? true : null,
          { label: `quest phase entered round ${round + 1}`, timeoutMs: 3000 }
        );

        for (const uid of team) {
          const c = clients.find((cl) => cl.uid === uid)!;
          const role = roleByUid.get(uid)!;
          const voteFail = role === 'assassin';
          c.socket.emit('game:submit-quest-vote', roomId, uid, voteFail ? 'fail' : 'success');
        }

        if (round < 2) {
          await waitFor(
            () => {
              const r = host.latestState;
              if (!r) return null;
              return r.state === 'voting' && r.currentRound === round + 2 ? true : null;
            },
            { label: `round ${round + 1} resolved`, timeoutMs: 4000 }
          );
        }
      }

      // After 3 failed quests, game should end with endReason='failed_quests'.
      await waitFor(
        () => clients.every((c) => c.endedState !== null),
        { label: 'all 6 players receive game:ended (evil 3 fails)', timeoutMs: 5000 }
      );

      for (const c of clients) {
        const ended = c.endedState!;
        expect(ended.state).toBe('ended');
        expect(ended.evilWins).toBe(true);
        expect(ended.endReason).toBe('failed_quests');
        expect(ended.questResults.filter((r) => r === 'fail')).toHaveLength(3);
        for (const p of Object.values(ended.players)) {
          expect(p.role).not.toBeNull();
        }
      }

      for (const c of clients) {
        expect(c.errors).toEqual([]);
      }
    },
    30_000
  );

  (QUARANTINE_6P_FULL ? it.skip : it)(
    '5 consecutive vote rejections -> vote_rejections broadcast reaches all 6 players',
    async () => {
      for (let i = 0; i < NAMES.length; i++) {
        const uid = `rej6-uid-${i + 1}`;
        clients.push(await connectGuestClient(port, uid, NAMES[i]));
      }
      expect(clients).toHaveLength(PLAYER_COUNT);

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
        { label: 'all 6 players in lobby' }
      );

      host.socket.emit('game:start-game', roomId);
      await waitFor(
        () => clients.every((c) => c.startedState !== null),
        { label: 'all 6 players receive game:started' }
      );

      const orderedPlayerIds = Object.keys(host.latestState!.players);

      // 5 consecutive rejections all in R1. Engine enforces maxFailedVotes=5.
      // After 5th rejection, endReason='vote_rejections' ends the game
      // (standard Avalon rule — no team approved => evil win).
      for (let rejection = 0; rejection < 5; rejection++) {
        // Wait for voting-ready state (R1 team selection, empty team).
        await waitFor(
          () => {
            const r = host.latestState;
            if (!r) return null;
            if (r.state === 'ended') return true;
            if (r.state !== 'voting') return null;
            if (r.currentRound !== 1) return null;
            if (r.questTeam.length !== 0) return null;
            // failCount must equal rejections so far.
            return (r.failCount ?? 0) === rejection ? true : null;
          },
          { label: `ready for rejection attempt ${rejection + 1}`, timeoutMs: 5000 }
        );

        if (host.latestState!.state === 'ended') break;

        const currentRoom = host.latestState!;
        const teamSize = AVALON_CONFIG[6].questTeams[0]; // R1 team size = 2
        const leaderId = orderedPlayerIds[currentRoom.leaderIndex % orderedPlayerIds.length];
        const team = orderedPlayerIds.slice(0, teamSize);

        const leaderClient = clients.find((c) => c.uid === leaderId)!;
        leaderClient.socket.emit('game:select-quest-team', roomId, team);

        await waitFor(
          () => host.latestState?.questTeam.length === teamSize ? true : null,
          { label: `team selected for rejection ${rejection + 1}`, timeoutMs: 3000 }
        );

        // Everyone votes REJECT (false). Pace against 1-vote/sec limiter.
        if (rejection > 0) await new Promise((r) => setTimeout(r, 1100));
        for (const c of clients) {
          c.socket.emit('game:vote', roomId, c.uid, false);
        }

        // Wait for the rejection to be processed: either advances to next
        // leader (failCount increments) or ends the game on the 5th.
        if (rejection < 4) {
          await waitFor(
            () => {
              const r = host.latestState;
              if (!r) return null;
              if (r.state !== 'voting') return null;
              if ((r.failCount ?? 0) !== rejection + 1) return null;
              if (r.questTeam.length !== 0) return null;
              return true;
            },
            { label: `rejection ${rejection + 1} processed`, timeoutMs: 5000 }
          );
        }
      }

      // After 5th rejection, game must end with endReason='vote_rejections'.
      await waitFor(
        () => clients.every((c) => c.endedState !== null),
        { label: 'all 6 players receive game:ended (5 rejections)', timeoutMs: 6000 }
      );

      for (const c of clients) {
        const ended = c.endedState!;
        expect(ended.state).toBe('ended');
        expect(ended.evilWins).toBe(true);
        expect(ended.endReason).toBe('vote_rejections');
      }

      for (const c of clients) {
        expect(c.errors).toEqual([]);
      }
    },
    30_000
  );
});
