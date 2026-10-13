/**
 * 網站「與機器人練習」— end-to-end practice games over real sockets.
 *
 * A scripted human socket client plays complete 10-seat practice games
 * against 9 bots (bot delays scaled down). Checks:
 *   - forced seat / role land where the player asked;
 *   - every bot decision (proposal, vote, quest card, lake target and
 *     declaration, assassination) is traced exactly once, with a reason;
 *   - no trace data reaches the client before `game:ended`;
 *   - practice rooms are never persisted (Supabase / Firestore / GitHub
 *     archive / stats spies stay untouched), unlisted, unjoinable, unwatchable;
 *   - 「這步怪怪的」 flags reach the sink with the server-side reason;
 *   - a bot's private lake result never reaches the human's client;
 *   - nobody can (re)start a practice room; the server never plays for a
 *     disconnected practice player; cleanup frees bots even when the room
 *     was removed by another path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, Server as HttpServer } from 'http';
import { AddressInfo } from 'net';
import { Server as SocketIOServer } from 'socket.io';
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';
import { AVALON_CONFIG, Room } from '@avalon/shared';

vi.mock('../../services/supabase', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    saveRoom: vi.fn(async () => true),
    updateRoomState: vi.fn(async () => true),
    saveGameRecords: vi.fn(async () => true),
    saveGameEvents: vi.fn(async () => true),
    awardBadges: vi.fn(async () => undefined),
    getUserElo: vi.fn(async () => 1000),
  };
});
// The scripted human acts faster than a person; keep only the practice-create limit real.
vi.mock('../../middleware/rateLimit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../middleware/rateLimit')>();
  class FastSocketRateLimiter extends actual.SocketRateLimiter {
    isAllowed(identifier: string): boolean {
      return identifier.endsWith(':practice-create') ? super.isAllowed(identifier) : true;
    }
  }
  return { ...actual, SocketRateLimiter: FastSocketRateLimiter };
});
vi.mock('../../services/GitHubGameArchive', () => ({
  archiveGameRecordToGitHub: vi.fn(async () => undefined),
}));
vi.mock('../../services/liveGameToV2', () => ({
  buildV2RecordFromRoom: vi.fn(() => ({})),
}));

import * as supabase from '../../services/supabase';
import { archiveGameRecordToGitHub } from '../../services/GitHubGameArchive';
import { buildV2RecordFromRoom } from '../../services/liveGameToV2';
import { GameHistoryRepository } from '../../services/GameHistoryRepository';
import { GameHistoryRepositoryV2 } from '../../services/GameHistoryRepositoryV2';
import { ComputedStatsRepositoryV2 } from '../../services/ComputedStatsRepositoryV2';
import { GameServer } from '../../socket/GameServer';
import type { RoomManager } from '../../game/RoomManager';
import { authenticateSocket } from '../../middleware/auth';
import type { PracticeFlagRow, PracticeFlagSink } from '../../practice/PracticeReportWriter';
import type { PracticeTracePayload, PracticeTraceEntry, PracticeFlagResult } from '../../practice/types';

const BOT_DELAY_SCALE = 0.02;

interface EventLogItem {
  name: string;
  json: string;
  at: number;
}

interface Human {
  uid: string;
  socket: ClientSocket;
  latest: Room | null;
  started: Room | null;
  ended: Room | null;
  trace: PracticeTracePayload | null;
  events: EventLogItem[];
  errors: string[];
  /** Quest card the human played per round. */
  myCards: Record<number, 'success' | 'fail'>;
  stop: () => void;
}

async function waitFor<T>(
  predicate: () => T | null | undefined | false,
  { timeoutMs = 20000, stepMs = 20, label = 'condition' } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = predicate();
    if (v !== null && v !== undefined && v !== false) return v as T;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

function connect(port: number, uid: string, name: string): Promise<ClientSocket> {
  const socket = ioClient(`http://127.0.0.1:${port}`, {
    transports: ['websocket'],
    reconnection: false,
    auth: { token: JSON.stringify({ uid, displayName: name }) },
  });
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
    setTimeout(() => reject(new Error(`connect timeout ${name}`)), 4000);
  });
}

function emitAck<T>(socket: ClientSocket, event: string, ...args: unknown[]): Promise<T> {
  return new Promise((resolve, reject) => {
    socket.timeout(4000).emit(event, ...args, (err: Error | null, res: T) => (err ? reject(err) : resolve(res)));
  });
}

/**
 * Scripted human: re-evaluates the latest state every 25 ms and acts when it
 * is their turn (each action is re-sent at most every few hundred ms).
 */
function makeHuman(socket: ClientSocket, uid: string, evilCard: 'success' | 'fail'): Human {
  const h: Human = {
    uid, socket, latest: null, started: null, ended: null, trace: null,
    events: [], errors: [], myCards: {}, stop: () => undefined,
  };
  socket.onAny((name: string, ...args: unknown[]) => {
    h.events.push({ name, json: JSON.stringify(args), at: Date.now() });
  });
  socket.on('game:state-updated', (room: Room) => { h.latest = room; });
  socket.on('game:started', (room: Room) => { h.started = room; h.latest = room; });
  socket.on('game:ended', (room: Room) => { h.ended = room; h.latest = room; });
  socket.on('practice:trace', (payload: PracticeTracePayload) => { h.trace = payload; });
  socket.on('error', (msg: string) => { h.errors.push(msg); });

  const lastSent: Record<string, number> = {};
  const once = (key: string, gapMs: number, fn: () => void): void => {
    const now = Date.now();
    if (lastSent[key] !== undefined && now - lastSent[key] < gapMs) return;
    lastSent[key] = now;
    fn();
  };

  const tick = (): void => {
    const room = h.latest;
    if (!room || room.state === 'ended' || room.state === 'lobby') return;
    const ids = Object.keys(room.players);
    const me = room.players[uid];
    const leaderId = ids[room.leaderIndex % ids.length];
    const round = room.currentRound;
    if (room.state === 'voting' && room.questTeam.length === 0 && leaderId === uid) {
      const size = AVALON_CONFIG[ids.length].questTeams[round - 1];
      const team = [uid, ...ids.filter((id) => id !== uid)].slice(0, size);
      once(`team-${round}-${room.failCount}`, 1500, () => socket.emit('game:select-quest-team', room.id, team));
    } else if (room.state === 'voting' && room.questTeam.length > 0 && !(uid in room.votes)) {
      // Approve when on the team, otherwise reject — the "normal" vote.
      once(`vote-${round}-${room.failCount}`, 400, () => socket.emit('game:vote', room.id, uid, room.questTeam.includes(uid)));
    } else if (room.state === 'quest' && room.questTeam.includes(uid) && h.myCards[round] === undefined) {
      const card = me?.team === 'evil' ? evilCard : 'success';
      h.myCards[round] = card;
      socket.emit('game:submit-quest-vote', room.id, uid, card);
    } else if (room.state === 'lady_of_the_lake') {
      const hist = room.ladyOfTheLakeHistory ?? [];
      const last = hist[hist.length - 1];
      // Pick only before this phase's inspection (the token moves to the
      // target at inspection, while the inspector still has to declare).
      if (room.ladyOfTheLakeHolder === uid && !room.ladyOfTheLakeTarget) {
        const used = room.ladyOfTheLakeUsed ?? [];
        const target = ids.find((id) => id !== uid && !used.includes(id));
        if (target) once(`lake-${round}`, 2000, () => socket.emit('game:lady-of-the-lake', room.id, uid, target));
      } else if (last && last.holderId === uid && last.round === round && !last.declared && room.ladyOfTheLakeResult) {
        once(`declare-${round}`, 2000, () => socket.emit('game:declare-lake-result', room.id, room.ladyOfTheLakeResult));
      }
    } else if (room.state === 'discussion' && me?.role === 'assassin') {
      const target = ids.find((id) => id !== uid && room.players[id].team !== 'evil');
      if (target) once('assassinate', 3000, () => socket.emit('game:assassinate', room.id, uid, target));
    }
  };
  const timer = setInterval(tick, 25);
  h.stop = () => clearInterval(timer);
  return h;
}

function seatOf(room: Room, id: string): number {
  return Object.keys(room.players).indexOf(id) + 1;
}

/** Every bot decision visible in the final room must appear exactly once in the trace. */
function assertTraceComplete(room: Room, humanId: string, human: Human, trace: PracticeTracePayload): void {
  const entries = [...trace.entries];
  const take = (pred: (e: PracticeTraceEntry) => boolean, label: string): PracticeTraceEntry => {
    const idx = entries.findIndex(pred);
    expect(idx, `missing trace entry: ${label}`).toBeGreaterThanOrEqual(0);
    return entries.splice(idx, 1)[0];
  };
  const isBot = (id: string): boolean => room.players[id]?.isBot === true;

  for (const v of room.voteHistory) {
    if (isBot(v.leader)) {
      const e = take(
        (x) => x.kind === 'team_propose' && x.round === v.round && x.attempt === v.attempt && x.botSeat === seatOf(room, v.leader),
        `proposal R${v.round}-${v.attempt}`,
      );
      expect(e.detail.team).toEqual(v.team.map((id) => seatOf(room, id)).sort((a, b) => a - b));
    }
    if (v.attempt >= 5) continue; // forced 5th proposal: nobody votes
    for (const [pid, approve] of Object.entries(v.votes)) {
      if (!isBot(pid)) continue;
      const e = take(
        (x) => x.kind === 'team_vote' && x.round === v.round && x.attempt === v.attempt && x.botSeat === seatOf(room, pid),
        `vote R${v.round}-${v.attempt} seat ${seatOf(room, pid)}`,
      );
      expect(e.detail.vote).toBe(approve);
    }
  }
  for (const q of room.questHistory) {
    let botFails = 0;
    for (const pid of q.team) {
      if (!isBot(pid)) continue;
      const e = take((x) => x.kind === 'quest_card' && x.round === q.round && x.botSeat === seatOf(room, pid), `card R${q.round}`);
      if (e.detail.card === 'fail') botFails += 1;
    }
    const humanFail = q.team.includes(humanId) && human.myCards[q.round] === 'fail' ? 1 : 0;
    expect(botFails + humanFail).toBe(q.failCount);
  }
  for (const rec of room.ladyOfTheLakeHistory ?? []) {
    if (!isBot(rec.holderId)) continue;
    take((x) => x.kind === 'lake_target' && x.round === rec.round && x.detail.target === seatOf(room, rec.targetId), `lake R${rec.round}`);
    const d = take((x) => x.kind === 'lake_declare' && x.round === rec.round && x.botSeat === seatOf(room, rec.holderId), `declare R${rec.round}`);
    expect(d.detail.claim ?? null).toBe(rec.declared ? rec.declaredClaim : null);
    expect(d.detail.actual).toBe(rec.result);
  }
  const assassinId = Object.keys(room.players).find((id) => room.players[id].role === 'assassin');
  if (room.assassinTargetId && assassinId && isBot(assassinId)) {
    take((x) => x.kind === 'assassinate' && x.detail.target === seatOf(room, room.assassinTargetId!), 'assassination');
  }
  expect(entries, 'trace has entries that match no decision').toEqual([]);

  for (const e of trace.entries) {
    expect(e.reason.length).toBeGreaterThan(4);
    const seat = trace.seats.find((s) => s.seat === e.botSeat);
    expect(seat?.isBot).toBe(true);
    expect(seat?.role).toBe(e.botRole);
  }
}

/** No state the human received (before the end) shows a bot's private lake result. */
function assertNoLakeLeak(human: Human): void {
  for (const e of human.events) {
    if (e.name !== 'game:state-updated' && e.name !== 'game:started') continue;
    const r = (JSON.parse(e.json) as Room[])[0];
    if (!r || r.state === 'ended' || r.ladyOfTheLakeResult === undefined || r.ladyOfTheLakeResult === null) continue;
    const hist = r.ladyOfTheLakeHistory ?? [];
    expect(hist[hist.length - 1]?.holderId, 'lake result sent to a player who did not inspect').toBe(human.uid);
  }
}

/** Private GameServer parts the cleanup tests look at. */
interface GameServerInternals {
  roomManager: RoomManager;
  botAgents: Map<string, unknown>;
  sweepPracticeRooms: () => void;
}

class FakeSink implements PracticeFlagSink {
  rows: PracticeFlagRow[] = [];
  async appendFlag(row: PracticeFlagRow): Promise<void> {
    this.rows.push(row);
  }
}

describe('practice mode — full games over sockets', () => {
  let httpServer: HttpServer;
  let io: SocketIOServer;
  let port: number;
  let sink: FakeSink;
  let gameServer: GameServer;
  const internals = (): GameServerInternals => gameServer as unknown as GameServerInternals;
  const sockets: ClientSocket[] = [];
  const humans: Human[] = [];
  const spies: Array<ReturnType<typeof vi.spyOn>> = [];

  async function boot(practiceReportSink: PracticeFlagSink | null): Promise<void> {
    httpServer = createServer();
    io = new SocketIOServer(httpServer, { cors: { origin: true, credentials: true } });
    io.use(authenticateSocket);
    gameServer = new GameServer(io, { botDelayScale: BOT_DELAY_SCALE, practiceReportSink });
    gameServer.start();
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
    port = (httpServer.address() as AddressInfo).port;
  }

  async function playPractice(
    uid: string,
    options: { seat?: number | null; role?: string | null },
    evilCard: 'success' | 'fail' = 'fail',
  ): Promise<{ human: Human; roomId: string }> {
    const socket = await connect(port, uid, `練習-${uid}`);
    sockets.push(socket);
    const human = makeHuman(socket, uid, evilCard);
    humans.push(human);
    const res = await emitAck<{ ok: boolean; roomId?: string; error?: string }>(socket, 'practice:create', options);
    expect(res.ok).toBe(true);
    const roomId = res.roomId!;
    try {
      await waitFor(() => human.ended, { label: `practice game ${uid} ends`, timeoutMs: 45000 });
    } catch (err) {
      const r = human.latest;
      const ids = r ? Object.keys(r.players) : [];
      console.error('STUCK', JSON.stringify({
        state: r?.state, round: r?.currentRound, failCount: r?.failCount, questTeam: r?.questTeam.map((id) => ids.indexOf(id) + 1),
        leader: r ? ids[r.leaderIndex % ids.length] === uid ? 'me' : ids.indexOf(ids[r.leaderIndex % ids.length]) + 1 : null,
        votes: r?.votes, me: ids.indexOf(uid) + 1, myRole: r?.players[uid]?.role,
        lady: r ? { holder: r.ladyOfTheLakeHolder === uid ? 'me' : ids.indexOf(r.ladyOfTheLakeHolder ?? '') + 1, result: r.ladyOfTheLakeResult, hist: r.ladyOfTheLakeHistory } : null,
        errors: human.errors.slice(-5), lastEvents: human.events.slice(-5).map((e) => e.name),
      }));
      throw err;
    }
    await waitFor(() => human.trace, { label: 'trace after end' });
    human.stop();
    return { human, roomId };
  }

  beforeEach(() => {
    sink = new FakeSink();
    vi.mocked(supabase.saveRoom).mockClear();
    vi.mocked(supabase.updateRoomState).mockClear();
    vi.mocked(supabase.saveGameRecords).mockClear();
    vi.mocked(supabase.saveGameEvents).mockClear();
    vi.mocked(archiveGameRecordToGitHub).mockClear();
    vi.mocked(buildV2RecordFromRoom).mockClear();
    spies.push(
      vi.spyOn(GameHistoryRepository.prototype, 'saveGameRecord').mockResolvedValue(undefined as never),
      vi.spyOn(GameHistoryRepositoryV2.prototype, 'saveV2').mockResolvedValue(undefined as never),
      vi.spyOn(ComputedStatsRepositoryV2.prototype, 'recomputeForGame').mockResolvedValue(undefined as never),
    );
  });

  afterEach(async () => {
    for (const h of humans.splice(0)) h.stop();
    for (const s of sockets.splice(0)) if (s.connected) s.disconnect();
    for (const s of spies.splice(0)) s.mockRestore();
    await new Promise<void>((resolve) => io.close(() => httpServer.close(() => resolve())));
  });

  const CASES: Array<{ seat: number | null; role: string | null; evilCard: 'success' | 'fail' }> = [
    { seat: 3, role: 'merlin', evilCard: 'fail' },
    { seat: 10, role: 'assassin', evilCard: 'fail' },
    { seat: 1, role: 'oberon', evilCard: 'success' },
    { seat: 7, role: 'percival', evilCard: 'fail' },
    { seat: null, role: null, evilCard: 'fail' },
  ];

  it('plays complete practice games: forced seat/role, complete trace, nothing early, nothing recorded', async () => {
    await boot(sink);
    let i = 0;
    for (const c of CASES) {
      i += 1;
      const uid = `practice-human-${i}`;
      const { human, roomId } = await playPractice(uid, { seat: c.seat, role: c.role }, c.evilCard);
      const started = human.started!;
      const room = human.ended!;
      expect(roomId.startsWith('PRACTICE-')).toBe(true);
      expect(Object.keys(started.players)).toHaveLength(10);
      expect(Object.values(started.players).filter((p) => p.isBot)).toHaveLength(9);
      if (c.seat !== null) expect(seatOf(started, uid)).toBe(c.seat);
      if (c.role !== null) expect(started.players[uid].role).toBe(c.role);
      expect(started.timerConfig?.multiplier).toBeNull();
      expect(started.ladyOfTheLakeEnabled).toBe(true);
      // Hidden roles stay hidden in the started snapshot (Merlin sees teams only).
      const others = Object.values(started.players).filter((p) => p.id !== uid);
      expect(others.every((p) => p.role === null)).toBe(true);

      // Trace: sent once, only after game:ended, complete.
      const endedAt = human.events.find((e) => e.name === 'game:ended')!.at;
      const traceEvents = human.events.filter((e) => e.name === 'practice:trace');
      expect(traceEvents).toHaveLength(1);
      expect(traceEvents[0].at).toBeGreaterThanOrEqual(endedAt);
      // No other event (before or after the end) carries trace data.
      for (const e of human.events) {
        if (e.name === 'practice:trace') continue;
        expect(e.json.includes('"botSeat"'), `trace leaked in ${e.name}`).toBe(false);
        expect(e.json.includes('"suspects"'), `trace leaked in ${e.name}`).toBe(false);
      }
      const trace = human.trace!;
      expect(trace.roomId).toBe(roomId);
      expect(trace.ownerId).toBe(uid);
      expect(trace.canFlag).toBe(true);
      expect(trace.winner).toBe(room.evilWins ? 'evil' : 'good');
      expect(trace.seats.find((s) => s.playerId === uid)?.isBot).toBe(false);
      assertTraceComplete(room, uid, human, trace);
      assertNoLakeLeak(human);
      expect(human.errors).toEqual([]);
    }

    // Never recorded anywhere.
    expect(supabase.saveRoom).not.toHaveBeenCalled();
    expect(supabase.updateRoomState).not.toHaveBeenCalled();
    expect(supabase.saveGameRecords).not.toHaveBeenCalled();
    expect(supabase.saveGameEvents).not.toHaveBeenCalled();
    expect(archiveGameRecordToGitHub).not.toHaveBeenCalled();
    expect(buildV2RecordFromRoom).not.toHaveBeenCalled();
    expect(GameHistoryRepository.prototype.saveGameRecord).not.toHaveBeenCalled();
    expect(GameHistoryRepositoryV2.prototype.saveV2).not.toHaveBeenCalled();
    expect(ComputedStatsRepositoryV2.prototype.recomputeForGame).not.toHaveBeenCalled();

    // Control: the same spies do see a normal room (mock wiring is live).
    const host = await connect(port, 'normal-host', 'Host');
    sockets.push(host);
    host.emit('game:create-room', 'Host');
    await waitFor(() => vi.mocked(supabase.saveRoom).mock.calls.length > 0, { label: 'normal room persisted' });
  }, 240000);

  it('practice rooms are unlisted, unjoinable and unwatchable; trace/flags only after the end', async () => {
    await boot(sink);
    const owner = await connect(port, 'owner-1', 'Owner');
    const other = await connect(port, 'intruder-1', 'Intruder');
    sockets.push(owner, other);
    const human = makeHuman(owner, 'owner-1', 'fail');
    humans.push(human);
    const otherErrors: string[] = [];
    other.on('error', (m: string) => otherErrors.push(m));

    const res = await emitAck<{ ok: boolean; roomId: string }>(owner, 'practice:create', { seat: 5, role: 'loyal' });
    const roomId = res.roomId;
    await waitFor(() => human.started, { label: 'started' });

    // Mid-game: no trace, no flags.
    const early = await emitAck<{ ok: boolean; error?: string }>(owner, 'practice:get-trace', roomId);
    expect(early.ok).toBe(false);
    const earlyFlag = await emitAck<PracticeFlagResult>(owner, 'practice:flag', { roomId, entryId: 1, note: 'x' });
    expect(earlyFlag.ok).toBe(false);

    // Nobody (re)starts a practice room: not a stranger, not the owner.
    other.emit('game:start-game', roomId);
    owner.emit('game:start-game', roomId);
    await waitFor(() => otherErrors.includes('練習房請按「再練一局」') && human.errors.includes('練習房請按「再練一局」'), {
      label: 'start-game refused',
    });
    human.errors.splice(0);

    other.emit('game:join-room', roomId);
    other.emit('game:spectate-room', roomId);
    const listed = await new Promise<Array<{ fullId: string }>>((resolve) => {
      other.once('game:rooms-list', resolve);
      other.emit('game:list-rooms');
    });
    expect(listed.some((r) => r.fullId === roomId)).toBe(false);
    await waitFor(() => otherErrors.length >= 2, { label: 'intruder rejected' });
    expect(otherErrors).toContain('練習房不開放加入');
    expect(otherErrors).toContain('練習房不開放觀戰');

    await waitFor(() => human.ended, { label: 'ends', timeoutMs: 45000 });
    await waitFor(() => human.trace, { label: 'trace' });
    human.stop();
    const trace = human.trace!;
    expect(trace.entries.length).toBeGreaterThan(20);
    // Still one game: the mid-game start-game attempts changed nothing.
    assertTraceComplete(human.ended!, 'owner-1', human, trace);
    // After the end too: no second game, no second game:ended.
    owner.emit('game:start-game', roomId);
    await waitFor(() => human.errors.includes('練習房請按「再練一局」'), { label: 'restart after end refused' });
    expect(human.events.filter((e) => e.name === 'game:ended')).toHaveLength(1);

    // Pull again after the end (e.g. after a refresh) — same entries.
    const pulled = await emitAck<{ ok: boolean; payload: PracticeTracePayload }>(owner, 'practice:get-trace', roomId);
    expect(pulled.ok).toBe(true);
    expect(pulled.payload.entries).toHaveLength(trace.entries.length);
    // Not the owner → refused.
    const stolen = await emitAck<{ ok: boolean }>(other, 'practice:get-trace', roomId);
    expect(stolen.ok).toBe(false);

    // Flag a decision: the sink gets the server-side decision + reason + note.
    const target = trace.entries.find((e) => e.kind === 'team_vote') ?? trace.entries[0];
    const ok = await emitAck<PracticeFlagResult>(owner, 'practice:flag', { roomId, entryId: target.id, note: '這票怪怪的' });
    expect(ok).toEqual({ ok: true, flagsLeft: 29 });
    expect(sink.rows).toHaveLength(1);
    expect(sink.rows[0]).toMatchObject({
      roomId,
      round: target.round,
      attempt: target.attempt,
      botSeat: target.botSeat,
      botRole: target.botRole,
      kind: target.kind,
      decision: target.action,
      note: '這票怪怪的',
    });
    expect(sink.rows[0].reason).toContain(target.reason);
    // Same step again → refused; another step right away → rate limited.
    const dup = await emitAck<PracticeFlagResult>(owner, 'practice:flag', { roomId, entryId: target.id });
    expect(dup.ok).toBe(false);
    const other2 = trace.entries.find((e) => e.id !== target.id)!;
    const fast = await emitAck<PracticeFlagResult>(owner, 'practice:flag', { roomId, entryId: other2.id });
    expect(fast).toMatchObject({ ok: false });
    expect(fast.error).toMatch(/太快/);
    // Not the owner → refused.
    const intruderFlag = await emitAck<PracticeFlagResult>(other, 'practice:flag', { roomId, entryId: other2.id });
    expect(intruderFlag.ok).toBe(false);
    expect(sink.rows).toHaveLength(1);

    // Leaving closes the practice room.
    const left = new Promise<void>((resolve) => owner.once('game:left-room', () => resolve()));
    owner.emit('game:leave-room', roomId);
    await left;
    const gone = await emitAck<{ ok: boolean }>(owner, 'practice:get-trace', roomId);
    expect(gone.ok).toBe(false);
  }, 120000);

  it('cleanup: review window counts from the end; a room removed elsewhere still frees its bots', async () => {
    await boot(sink);
    const createdAt = Date.now();
    const { human, roomId } = await playPractice('cleanup-human', { seat: 4, role: 'loyal' });
    const { roomManager, botAgents } = internals();
    const room = roomManager.getRoom(roomId)!;
    // RoomManager's own cleanup deletes ended rooms 30 min after updatedAt.
    expect(room.updatedAt).toBeGreaterThan(createdAt);
    expect(room.updatedAt).toBeGreaterThanOrEqual(human.events.find((e) => e.name === 'game:ended')!.at - 1000);
    const botIds = Object.keys(room.players).filter((id) => room.players[id].isBot);
    expect(botIds).toHaveLength(9);
    expect(botIds.every((id) => botAgents.has(id))).toBe(true);

    // Simulate the general cleanup removing the room first.
    roomManager.deleteRoom(roomId);
    const gone = await emitAck<{ ok: boolean; error?: string }>(human.socket, 'practice:get-trace', roomId);
    expect(gone).toEqual({ ok: false, error: '這個練習房已清除' });
    internals().sweepPracticeRooms();
    expect(botIds.some((id) => botAgents.has(id))).toBe(false);
    const after = await emitAck<{ ok: boolean; error?: string }>(human.socket, 'practice:get-trace', roomId);
    expect(after.error).toMatch(/找不到這個練習房/);
  }, 90000);

  it('a disconnected practice player is never auto-played', async () => {
    await boot(sink);
    const uid = 'afk-human';
    const socket = await connect(port, uid, 'AFK');
    sockets.push(socket);
    // Passive client: never acts, so the game soon waits on this player.
    const res = await emitAck<{ ok: boolean; roomId: string }>(socket, 'practice:create', { seat: 6, role: 'loyal' });
    const roomId = res.roomId;
    const { roomManager } = internals();
    const waitingOnMe = (): boolean => {
      const r = roomManager.getRoom(roomId);
      if (!r || r.state !== 'voting') return false;
      const ids = Object.keys(r.players);
      const leader = ids[r.leaderIndex % ids.length];
      if (r.questTeam.length === 0) return leader === uid;
      return !(uid in r.votes) && Object.keys(r.votes).length === ids.length - 1;
    };
    await waitFor(() => waitingOnMe(), { label: 'game waits on the passive player' });
    const before = JSON.stringify((({ questTeam, votes, voteHistory, leaderIndex }) => ({ questTeam, votes, voteHistory, leaderIndex }))(roomManager.getRoom(roomId)!));
    socket.disconnect();
    await new Promise((r) => setTimeout(r, 3600)); // past the 3 s auto-act delay
    const r = roomManager.getRoom(roomId)!;
    expect(r.players[uid].status).toBe('disconnected');
    expect(JSON.stringify((({ questTeam, votes, voteHistory, leaderIndex }) => ({ questTeam, votes, voteHistory, leaderIndex }))(r))).toBe(before);
  }, 60000);

  it('practice needs the player out of any live room (any tab); only the host starts a normal game', async () => {
    await boot(sink);
    const tabA = await connect(port, 'two-tabs', 'TabA');
    const tabB = await connect(port, 'two-tabs', 'TabB');
    const stranger = await connect(port, 'stranger-2', 'Stranger');
    sockets.push(tabA, tabB, stranger);
    const strangerErrors: string[] = [];
    stranger.on('error', (m: string) => strangerErrors.push(m));
    const created = new Promise<Room>((resolve) => tabA.once('game:state-updated', resolve));
    tabA.emit('game:create-room', 'TabA');
    const normal = await created;
    const refused = await emitAck<{ ok: boolean; error?: string }>(tabB, 'practice:create', { seat: null, role: null });
    expect(refused).toEqual({ ok: false, error: '你目前在其他房間中，請先離開再開始練習' });

    stranger.emit('game:start-game', normal.id);
    await waitFor(() => strangerErrors.length > 0, { label: 'stranger start refused' });
    expect(strangerErrors).toContain('Only the host can start the game');
  }, 30000);

  it('without a report sink the review says saving is unavailable', async () => {
    await boot(null);
    const { human, roomId } = await playPractice('no-sink-human', { seat: 2, role: 'morgana' });
    expect(human.trace!.canFlag).toBe(false);
    expect(human.trace!.flagUnavailableReason).toMatch(/無法儲存/);
    const res = await emitAck<PracticeFlagResult>(human.socket, 'practice:flag', { roomId, entryId: 1, note: 'n' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/無法儲存/);
  }, 90000);
});
