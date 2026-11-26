/**
 * 一般房間「指定哪一位 AI騎士」（站長 2026-11-26）：game:add-bot 第 2 個參數 { knightId }。
 *   - 沒給（或舊的難度字串）→ 照舊：名字「AI」、百科AI 本身。
 *   - 名冊裡的 id → 座位名 AI騎士_ED_01，同房第二位 AI騎士_ED_02；開局時騎士的開關照角色、陣營蓋上去。
 *   - 不認得的 id → 百科（AI騎士_百科_01），記一次次數。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, Server as HttpServer } from 'http';
import { AddressInfo } from 'net';
import { Server as SocketIOServer } from 'socket.io';
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';
import type { Room } from '@avalon/shared';

vi.mock('../../services/supabase', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    saveRoom: vi.fn(async () => true),
    updateRoomState: vi.fn(async () => true),
    saveGameRecords: vi.fn(async () => true),
    saveGameEvents: vi.fn(async () => true),
    awardBadges: vi.fn(async () => undefined),
  };
});
vi.mock('../../middleware/rateLimit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../middleware/rateLimit')>();
  class NoLimit extends actual.SocketRateLimiter {
    isAllowed(): boolean { return true; }
  }
  return { ...actual, SocketRateLimiter: NoLimit };
});

import { GameServer } from '../../socket/GameServer';
import type { RoomManager } from '../../game/RoomManager';
import { authenticateSocket } from '../../middleware/auth';
import { knightFallbackCounter } from '../../arena/knights';
import { DEFAULT_AGENT_TUNING } from '../../ai/AgentTuning';

interface Internals {
  roomManager: RoomManager;
  botAgents: Map<string, { tuning: Record<string, unknown> }>;
  botKnights: Map<string, string>;
  applyOpponentProfile: (room: Room) => unknown;
}

async function waitFor<T>(predicate: () => T | null | undefined | false, label: string, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = predicate();
    if (v !== null && v !== undefined && v !== false) return v as T;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

describe('game:add-bot with a knight id', () => {
  let httpServer: HttpServer;
  let io: SocketIOServer;
  const sockets: ClientSocket[] = [];

  afterEach(async () => {
    for (const s of sockets.splice(0)) if (s.connected) s.disconnect();
    await new Promise<void>((resolve) => io.close(() => httpServer.close(() => resolve())));
  });

  it('names, backward compatibility, fallback and the knight switches at game start', async () => {
    httpServer = createServer();
    io = new SocketIOServer(httpServer, { cors: { origin: true, credentials: true } });
    io.use(authenticateSocket);
    const gameServer = new GameServer(io, { botDelayScale: 0.02, practiceReportSink: null });
    gameServer.start();
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
    const port = (httpServer.address() as AddressInfo).port;
    const internals = gameServer as unknown as Internals;

    const host = ioClient(`http://127.0.0.1:${port}`, {
      transports: ['websocket'], reconnection: false, auth: { token: JSON.stringify({ uid: 'knight-host', displayName: 'Host' }) },
    });
    sockets.push(host);
    await new Promise<void>((resolve, reject) => { host.once('connect', () => resolve()); host.once('connect_error', reject); });
    let latest: Room | null = null;
    host.on('game:state-updated', (r: Room) => { latest = r; });
    host.on('game:room-created', (r: Room) => { latest = r; });
    host.emit('game:create-room', 'Host');
    const room0 = await waitFor(() => latest, 'room created');
    const roomId = room0.id;
    const room = internals.roomManager.getRoom(roomId)!;
    const botNames = (): string[] => Object.values(room.players).filter((p) => p.isBot).map((p) => p.name);

    host.emit('game:add-bot', roomId);                                   // old client: no 2nd argument
    host.emit('game:add-bot', roomId, 'hard');                           // old client: legacy difficulty string
    host.emit('game:add-bot', roomId, { knightId: 'knight-ed-01' });
    host.emit('game:add-bot', roomId, { knightId: 'knight-ed-01' });
    const before = knightFallbackCounter.unknown;
    host.emit('game:add-bot', roomId, { knightId: 'no-such-knight' });
    await waitFor(() => botNames().length === 5, 'five bots');
    expect(botNames()).toEqual(['AI', 'AI', 'AI騎士_ED_01', 'AI騎士_ED_02', 'AI騎士_百科_01']);
    expect(knightFallbackCounter.unknown).toBe(before + 1);
    // The client sees the knight names in the room state.
    await waitFor(() => latest && Object.values(latest.players).filter((p) => p.isBot).length === 5, 'client state');
    expect(Object.values(latest!.players).map((p) => p.name)).toContain('AI騎士_ED_02');

    // Removing a knight frees its serial; the next one takes the smallest free number.
    const ed1 = Object.keys(room.players).find((id) => room.players[id].name === 'AI騎士_ED_01')!;
    host.emit('game:remove-bot', roomId, ed1);
    await waitFor(() => !room.players[ed1], 'bot removed');
    expect(internals.botKnights.has(ed1)).toBe(false);
    host.emit('game:add-bot', roomId, { knightId: 'knight-ed-01' });
    await waitFor(() => botNames().includes('AI騎士_ED_01'), 'serial reused');

    // Game start: deal roles by hand, then the same step handleStartGame runs.
    const ids = Object.keys(room.players);
    const roles: Array<[string, 'good' | 'evil']> = [['loyal', 'good'], ['merlin', 'good'], ['morgana', 'evil'], ['assassin', 'evil'], ['percival', 'good'], ['loyal', 'good']];
    expect(ids.map((id) => room.players[id].name)).toEqual(['Host', 'AI', 'AI', 'AI騎士_ED_02', 'AI騎士_百科_01', 'AI騎士_ED_01']);
    ids.forEach((id, i) => { room.players[id].role = roles[i][0] as never; room.players[id].team = roles[i][1]; });
    internals.applyOpponentProfile(room);
    for (const id of ids) {
      const p = room.players[id];
      if (!p.isBot) continue;
      const tuning = internals.botAgents.get(id)!.tuning;
      if (p.name.startsWith('AI騎士_ED')) {
        if (p.team === 'evil') expect(tuning.redR1Teammate).toBe(false);
        if (p.role === 'merlin') expect(tuning.merlinCover77).toBe(1);
        if (p.role === 'loyal') expect(tuning.goodBayesBad).toBe(0.99);
      } else if (p.team === 'evil') {
        expect(tuning.redR1Teammate).toBe(DEFAULT_AGENT_TUNING.redR1Teammate);
      }
    }
  }, 30000);
});
