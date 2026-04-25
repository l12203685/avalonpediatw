/**
 * P0 regression — 玩家跳出遊戲後重整回不到遊戲
 *
 * Edward 原話 (2026-04-24 13:45 +08): 「有個嚴重問題 跳出後 重新整理
 * 回不到遊戲 應該要有回到遊戲 的功能」。
 *
 * Root-cause:
 *   When a player reloads mid-game, the browser opens a fresh Socket.IO
 *   connection that finishes the handshake and emits `game:join-room`
 *   *before* the old socket's `disconnect` event has propagated through
 *   the server. At that instant:
 *     room.players[playerId].status === 'active' (stale)
 *     old socket is already dead
 *   The previous `handleJoinRoom` implementation rejected with
 *   "Already in this room" because it only rejoined when status was
 *   'disconnected'. The frontend then treated the rejoin as failed and
 *   the player was stuck on HomePage / LobbyPage without room state.
 *
 * Fix (GameServer.handleJoinRoom):
 *   When the player already exists, check whether the previously mapped
 *   socket is still live via `io.sockets.sockets.get(prevId)?.connected`.
 *   If not (or if it's the same socket.id), treat the second join as a
 *   reconnect instead of rejecting. The sanitised room snapshot is then
 *   broadcast so the refreshed client rebuilds its store from scratch.
 *
 * These tests spin up a real Socket.IO GameServer in-process and drive
 * two reload scenarios:
 *   1. Lobby reload — player in lobby reloads, sees 5 players + lobby
 *   2. Active-game reload — player reloads mid `voting`, sees same
 *      state, currentRound, questTeam and retains their role.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, Server as HttpServer } from 'http';
import { AddressInfo } from 'net';
import { Server as SocketIOServer } from 'socket.io';
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';

import { Room, Role } from '@avalon/shared';
import { GameServer } from '../../socket/GameServer';
import { authenticateSocket } from '../../middleware/auth';

interface TestClient {
  uid: string;
  displayName: string;
  socket: ClientSocket;
  latestState: Room | null;
  startedState: Room | null;
  errors: string[];
  reconnectEvents: string[];
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

function instrument(socket: ClientSocket, uid: string, displayName: string): TestClient {
  const client: TestClient = {
    uid,
    displayName,
    socket,
    latestState: null,
    startedState: null,
    errors: [],
    reconnectEvents: [],
  };
  socket.on('game:state-updated', (room: Room) => { client.latestState = room; });
  socket.on('game:started', (room: Room) => { client.startedState = room; client.latestState = room; });
  socket.on('error', (msg: string) => { client.errors.push(msg); });
  socket.on('game:player-reconnected', (pid: string) => { client.reconnectEvents.push(pid); });
  return client;
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

  const client = instrument(socket, uid, displayName);

  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(client));
    socket.once('connect_error', (err) => reject(err));
    setTimeout(() => reject(new Error(`connect timeout for ${displayName}`)), 4000);
  });
}

describe('P0: player can rejoin after reload', () => {
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

  it('reload in lobby: player re-emits game:join-room and receives the lobby snapshot', async () => {
    // ── 1. Host + 4 joiners set up a 5-player lobby ─────────────────────────
    const names = ['Alice', 'Bob', 'Charlie', 'David', 'Eve'];
    for (let i = 0; i < names.length; i++) {
      clients.push(await connectGuestClient(port, `reload-${i + 1}`, names[i]));
    }
    const host = clients[0];
    host.socket.emit('game:create-room', host.displayName);
    const roomId = (await waitFor(
      () => host.latestState?.id ?? null,
      { label: 'host receives created room' }
    )) as string;
    for (let i = 1; i < clients.length; i++) {
      clients[i].socket.emit('game:join-room', roomId);
    }
    await waitFor(
      () => Object.keys(host.latestState?.players ?? {}).length === 5 ? true : null,
      { label: 'all 5 players in lobby' }
    );

    // ── 2. Simulate a reload for Charlie: kill old socket + open new one ────
    const charlie = clients[2];
    charlie.socket.disconnect();
    // Open a brand-new client using the same uid (like a fresh page load).
    // Do NOT wait for the server to process the old socket's `disconnect`
    // first — this is the race we want to catch. The new handshake arrives
    // while `room.players[uid].status` is still 'active' on the server.
    const freshSocket = ioClient(`http://127.0.0.1:${port}`, {
      transports: ['websocket'],
      reconnection: false,
      auth: { token: JSON.stringify({ uid: charlie.uid, displayName: charlie.displayName }) },
    });
    const charlieReloaded = instrument(freshSocket, charlie.uid, charlie.displayName);
    clients[2] = charlieReloaded;
    await new Promise<void>((resolve, reject) => {
      freshSocket.once('connect', () => resolve());
      freshSocket.once('connect_error', (err) => reject(err));
      setTimeout(() => reject(new Error('reload client connect timeout')), 4000);
    });
    // Mirror the frontend auto-rejoin logic (socket.ts:162 uses localStorage).
    freshSocket.emit('game:join-room', roomId);

    // ── 3. The reloaded client should receive a full lobby snapshot ─────────
    const snapshot = await waitFor(
      () => charlieReloaded.latestState && Object.keys(charlieReloaded.latestState.players).length === 5
        ? charlieReloaded.latestState
        : null,
      { label: 'reloaded client receives lobby snapshot' }
    );
    expect(snapshot.id).toBe(roomId);
    expect(snapshot.state).toBe('lobby');
    expect(snapshot.players[charlie.uid]).toBeTruthy();
    expect(snapshot.players[charlie.uid].status).toBe('active');

    // And crucially no error was emitted.
    expect(charlieReloaded.errors).not.toContain('Already in this room');
    expect(charlieReloaded.errors).not.toContain('Room not found');
  });

  it('reload mid-game: player re-joins, keeps role, and sees current round/state', async () => {
    const names = ['Alice', 'Bob', 'Charlie', 'David', 'Eve'];
    for (let i = 0; i < names.length; i++) {
      clients.push(await connectGuestClient(port, `mid-${i + 1}`, names[i]));
    }
    const host = clients[0];
    host.socket.emit('game:create-room', host.displayName);
    const roomId = (await waitFor(
      () => host.latestState?.id ?? null,
      { label: 'host receives created room' }
    )) as string;
    for (let i = 1; i < clients.length; i++) {
      clients[i].socket.emit('game:join-room', roomId);
    }
    await waitFor(
      () => Object.keys(host.latestState?.players ?? {}).length === 5 ? true : null,
      { label: 'all 5 players in lobby' }
    );

    // Start the game — everyone should see voting + round 1.
    host.socket.emit('game:start-game', roomId);
    await waitFor(
      () => clients.every((c) => c.startedState !== null),
      { label: 'all 5 clients receive game:started' }
    );

    // Capture Charlie's assigned role BEFORE reload so we can assert the
    // server re-emits the same role to the reloaded socket.
    const charlie = clients[2];
    const originalRole = charlie.startedState!.players[charlie.uid].role as Role;
    expect(originalRole).not.toBeNull();

    // ── Simulate reload mid-game ────────────────────────────────────────────
    charlie.socket.disconnect();
    const freshSocket = ioClient(`http://127.0.0.1:${port}`, {
      transports: ['websocket'],
      reconnection: false,
      auth: { token: JSON.stringify({ uid: charlie.uid, displayName: charlie.displayName }) },
    });
    const charlieReloaded = instrument(freshSocket, charlie.uid, charlie.displayName);
    clients[2] = charlieReloaded;
    await new Promise<void>((resolve, reject) => {
      freshSocket.once('connect', () => resolve());
      freshSocket.once('connect_error', (err) => reject(err));
      setTimeout(() => reject(new Error('reload client connect timeout')), 4000);
    });
    freshSocket.emit('game:join-room', roomId);

    // ── Reloaded client should get a fresh game snapshot with its role ──────
    const rehydrated = await waitFor(
      () => charlieReloaded.latestState && charlieReloaded.latestState.state === 'voting'
        ? charlieReloaded.latestState
        : null,
      { label: 'reloaded client receives voting-phase snapshot' }
    );
    expect(rehydrated.id).toBe(roomId);
    expect(rehydrated.currentRound).toBe(1);
    expect(rehydrated.players[charlie.uid]).toBeTruthy();
    // Server sanitises for the reloaded socket — but the rejoining player
    // must still see their own role (getVisiblePlayerIds always adds self).
    expect(rehydrated.players[charlie.uid].role).toBe(originalRole);
    expect(rehydrated.players[charlie.uid].status).toBe('active');

    expect(charlieReloaded.errors).not.toContain('Already in this room');
    expect(charlieReloaded.errors).not.toContain('Game already in progress');

    // Other clients should have been notified of the reconnect.
    await waitFor(
      () => clients.filter((c, i) => i !== 2).every((c) => c.reconnectEvents.includes(charlie.uid)),
      { label: 'other players receive game:player-reconnected' }
    );
  });

  it('stale socket mapping: previous socket.id already gone from io.sockets does not block rejoin', async () => {
    // This test asserts the specific race: server has `playerToSocket.get(uid)`
    // pointing at a socket.id that is no longer in `io.sockets.sockets`. Before
    // the fix, `status === 'active'` + stale mapping → "Already in this room".
    // After the fix, the stale-mapping branch treats the new connection as a
    // reconnect.
    const [alice, bob] = await Promise.all([
      connectGuestClient(port, 'stale-1', 'Alice'),
      connectGuestClient(port, 'stale-2', 'Bob'),
    ]);
    clients.push(alice, bob);

    alice.socket.emit('game:create-room', alice.displayName);
    const roomId = (await waitFor(
      () => alice.latestState?.id ?? null,
      { label: 'host creates room' }
    )) as string;

    bob.socket.emit('game:join-room', roomId);
    await waitFor(
      () => Object.keys(alice.latestState?.players ?? {}).length === 2 ? true : null,
      { label: 'both players in lobby' }
    );

    // Abruptly kill Bob's socket — the server's disconnect handler will
    // eventually flip status to 'disconnected', but the reload path below
    // may land before or after that transition.
    bob.socket.disconnect();

    const freshSocket = ioClient(`http://127.0.0.1:${port}`, {
      transports: ['websocket'],
      reconnection: false,
      auth: { token: JSON.stringify({ uid: bob.uid, displayName: bob.displayName }) },
    });
    const bobReloaded = instrument(freshSocket, bob.uid, bob.displayName);
    clients[clients.indexOf(bob)] = bobReloaded;
    await new Promise<void>((resolve, reject) => {
      freshSocket.once('connect', () => resolve());
      freshSocket.once('connect_error', (err) => reject(err));
      setTimeout(() => reject(new Error('reload client connect timeout')), 4000);
    });
    freshSocket.emit('game:join-room', roomId);

    const snapshot = await waitFor(
      () => bobReloaded.latestState && bobReloaded.latestState.players[bob.uid]
        ? bobReloaded.latestState
        : null,
      { label: 'Bob reload receives lobby snapshot' }
    );
    expect(snapshot.id).toBe(roomId);
    expect(snapshot.players[bob.uid].status).toBe('active');
    expect(bobReloaded.errors).toHaveLength(0);
  });
});
