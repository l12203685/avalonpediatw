/**
 * 「現在合併會不會打斷人？」（站長 2026-11-26）：/api/bots/status → live 的數字與 safeToDeploy。
 * 假資料，不連任何外部服務。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Player, Room } from '@avalon/shared';
import { GameServer } from '../socket/GameServer';
import { RoomManager } from '../game/RoomManager';
import { PracticeSessions } from '../practice/PracticeSessions';
import { InGameChatCapture } from '../inGameFeedback/capture';
import {
  BLOCKING_REASONS,
  MINOR_REASONS,
  evaluateDeploySafety,
  readLiveRoomCounts,
  setLiveRestartStatusSource,
  setLiveRoomCountsSource,
  type DeployLiveInput,
  type LiveRoomCounts,
} from '../services/deploySafety';
import { buildBotStatus } from '../bots';

const ZERO: LiveRoomCounts = {
  roomsInGame: 0,
  roomsInGameWithHumans: 0,
  roomsInGameHumansAway: 0,
  roomsInGameBotsOnly: 0,
  roomsInLobbyWithHumans: 0,
  practiceInGame: 0,
  redTalkWaits: 0,
  practiceExploitPending: 0,
};

function input(over: Partial<DeployLiveInput> = {}, rooms: Partial<LiveRoomCounts> = {}): DeployLiveInput {
  return {
    rooms: { ...ZERO, ...rooms },
    simSessionsActive: 0,
    simSessionsPersisted: false,
    pendingFeedbackRows: 0,
    lineReplyQueue: 0,
    ...over,
  };
}

afterEach(() => {
  setLiveRoomCountsSource(null);
  vi.restoreAllMocks();
});

describe('evaluateDeploySafety', () => {
  it('nothing going on → safe, no reasons', () => {
    const s = evaluateDeploySafety(input());
    expect(s.safeToDeploy).toBe(true);
    expect(s.reasons).toEqual([]);
    expect(s.blocking).toEqual([]);
  });

  it('bot-only rooms, lobby with humans, LINE queue, saved 模擬瓦 → still safe but listed', () => {
    const s = evaluateDeploySafety(input(
      { simSessionsActive: 2, simSessionsPersisted: true, lineReplyQueue: 3 },
      { roomsInGame: 1, roomsInGameBotsOnly: 1, roomsInLobbyWithHumans: 1 },
    ));
    expect(s.safeToDeploy).toBe(true);
    expect(s.blocking).toEqual([]);
    expect(new Set(s.reasons)).toEqual(new Set(['lobby_with_humans', 'line_reply_queue', 'sim_sessions_saved', 'bot_only_rooms']));
  });

  it.each([
    [{}, { roomsInGame: 1, roomsInGameWithHumans: 1 }, 'rooms_in_game_with_humans'],
    [{}, { roomsInGame: 1, roomsInGameHumansAway: 1 }, 'rooms_in_game_humans_away'],
    [{}, { practiceInGame: 1 }, 'practice_in_game'],
    [{}, { redTalkWaits: 1 }, 'red_talk_waits'],
    [{ simSessionsActive: 1, simSessionsPersisted: false }, {}, 'sim_sessions_unsaved'],
    [{ pendingFeedbackRows: 2 }, {}, 'feedback_unsaved'],
    [{}, { practiceExploitPending: 1 }, 'practice_exploit_pending'],
  ] as const)('blocks: %j %j → %s', (over, rooms, code) => {
    const s = evaluateDeploySafety(input(over, rooms));
    expect(s.safeToDeploy).toBe(false);
    expect(s.blocking).toEqual([code]);
    expect(s.reasons[0]).toBe(code);
  });

  it('room counts not wired → unsafe (unknown is not safe)', () => {
    const s = evaluateDeploySafety(input({ rooms: null }));
    expect(s.safeToDeploy).toBe(false);
    expect(s.blocking).toEqual(['live_counts_unavailable']);
  });

  it('blocking reasons come before minor ones; every code is a known code', () => {
    const s = evaluateDeploySafety(input(
      { lineReplyQueue: 1, pendingFeedbackRows: 1 },
      { roomsInLobbyWithHumans: 1, roomsInGame: 1, roomsInGameWithHumans: 1 },
    ));
    expect(s.reasons).toEqual(['rooms_in_game_with_humans', 'feedback_unsaved', 'lobby_with_humans', 'line_reply_queue']);
    const known = new Set<string>([...BLOCKING_REASONS, ...MINOR_REASONS]);
    for (const r of s.reasons) expect(known.has(r)).toBe(true);
  });

  it('a counts source that throws reads as unavailable', () => {
    setLiveRoomCountsSource(() => { throw new Error('boom'); });
    expect(readLiveRoomCounts()).toBeNull();
  });
});

// ─── GameServer.liveCounts() ────────────────────────────────────────────────

function player(id: string, isBot: boolean, status: Player['status'] = 'active'): Player {
  return { id, name: `名${id}`, role: null, team: null, status, createdAt: 0, isBot };
}

function room(id: string, state: Room['state'], players: Player[]): Room {
  return {
    id, name: 't', host: players[0]?.id ?? 'x', state, players: Object.fromEntries(players.map((p) => [p.id, p])),
    maxPlayers: 10, currentRound: 1, maxRounds: 5, votes: {}, questTeam: [], questResults: [], failCount: 0, evilWins: null,
    leaderIndex: 0, voteHistory: [], questHistory: [], questVotedCount: 0,
    roleOptions: { percival: true, morgana: true, oberon: true, mordred: true }, readyPlayerIds: [], createdAt: 0, updatedAt: 0,
  };
}

function serverWith(rooms: Room[], opts: { practiceIds?: string[]; exploitPending?: string[]; redTalkWaiting?: number; redTalkDone?: number } = {}): GameServer {
  const rm = new RoomManager();
  rm.destroy();
  rm.rehydrate(rooms);
  const practice = new PracticeSessions();
  for (const id of opts.practiceIds ?? []) {
    const r = rooms.find((x) => x.id === id)!;
    const s = practice.create(id, r.host, { seat: null, role: null });
    if (opts.exploitPending?.includes(id)) (s as { exploit: unknown }).exploit = { pending: { at: 0 } };
  }
  const redTalk = new Map<string, unknown>();
  for (let i = 0; i < (opts.redTalkWaiting ?? 0); i += 1) redTalk.set(`w${i}`, { wait: { done: false } });
  for (let i = 0; i < (opts.redTalkDone ?? 0); i += 1) redTalk.set(`d${i}`, { wait: { done: true } });
  const server = Object.create(GameServer.prototype) as GameServer;
  Object.assign(server, { roomManager: rm, practice, redTalk });
  return server;
}

describe('GameServer.liveCounts', () => {
  it('sorts rooms into humans / humans away / bots only / lobby / practice; ended rooms ignored', () => {
    const server = serverWith([
      room('a', 'voting', [player('h1', false), player('b1', true)]),
      room('b', 'quest', [player('h2', false, 'disconnected'), player('b2', true)]),
      room('c', 'discussion', [player('b3', true), player('b4', true)]),
      room('d', 'lobby', [player('h3', false)]),
      room('e', 'lobby', [player('h4', false, 'disconnected')]),
      room('f', 'ended', [player('h5', false)]),
      room('g', 'lady_of_the_lake', [player('h6', false), player('b5', true)]),
      room('p', 'voting', [player('h7', false), player('b6', true)]),
    ], { practiceIds: ['p'], exploitPending: ['p'], redTalkWaiting: 1, redTalkDone: 2 });
    expect(server.liveCounts()).toEqual({
      roomsInGame: 4,
      roomsInGameWithHumans: 2,
      roomsInGameHumansAway: 1,
      roomsInGameBotsOnly: 1,
      roomsInLobbyWithHumans: 1,
      practiceInGame: 1,
      redTalkWaits: 1,
      practiceExploitPending: 1,
    });
  });

  it('empty server → all zero, safe', () => {
    const server = serverWith([]);
    expect(server.liveCounts()).toEqual(ZERO);
    expect(evaluateDeploySafety(input({ rooms: server.liveCounts() })).safeToDeploy).toBe(true);
  });
});

// ─── 遊戲內回饋還沒寫的句數 ──────────────────────────────────────────────────

describe('InGameChatCapture.heldFeedbackRows', () => {
  const line = { seat: 4, text: '3家為什麼這樣派', phase: 'voting', round: 3, proposal: 1, leaderIsBot: true } as const;
  const make = (sheet: boolean): InGameChatCapture => new InGameChatCapture({
    sink: sheet ? { appendRows: () => Promise.resolve() } : null,
    enabled: () => true,
    forward: () => Promise.resolve('sent'),
    logger: { warn: () => undefined },
  });

  it('counts flagged lines of open games; back to 0 once the game is written', async () => {
    const cap = make(true);
    cap.startGame('r', { botSeats: [3], seatCount: 7 });
    expect(cap.heldFeedbackRows()).toBe(0);
    expect(cap.onChat('r', { ...line })).not.toBeNull();
    expect(cap.heldFeedbackRows()).toBe(1);
    await cap.closeGame('r');
    expect(cap.heldFeedbackRows()).toBe(0);
  });

  it('no sheet configured → nothing would be written anyway → 0', () => {
    const cap = make(false);
    cap.startGame('r', { botSeats: [3], seatCount: 7 });
    cap.onChat('r', { ...line });
    expect(cap.heldFeedbackRows()).toBe(0);
  });
});

// ─── /api/bots/status → live ────────────────────────────────────────────────

describe('buildBotStatus().live', () => {
  it('numbers and codes only; follows the wired GameServer counts', () => {
    setLiveRoomCountsSource(() => ({ ...ZERO, roomsInGame: 1, roomsInGameWithHumans: 1 }));
    const live = buildBotStatus().live;
    expect(live.safeToDeploy).toBe(false);
    expect(live.blocking).toContain('rooms_in_game_with_humans');
    for (const [k, v] of Object.entries(live)) {
      if (k === 'restart') expect(v === null || typeof v === 'object').toBe(true);
      else if (k === 'reasons' || k === 'blocking') expect(Array.isArray(v)).toBe(true);
      else if (k === 'safeToDeploy') expect(typeof v).toBe('boolean');
      else expect(typeof v).toBe('number');
    }
    setLiveRoomCountsSource(() => ZERO);
    expect(buildBotStatus().live.safeToDeploy).toBe(true);
    // 伺服器更新時保存進度的狀態：只有數字和固定字
    expect(buildBotStatus().live.restart).toBeNull();
    setLiveRestartStatusSource(() => ({ configured: true, restoredRooms: 2, lastRead: 'restored', savedRooms: 0, saveFailures: 0 }));
    expect(buildBotStatus().live.restart).toEqual({ configured: true, restoredRooms: 2, lastRead: 'restored', savedRooms: 0, saveFailures: 0 });
    setLiveRestartStatusSource(null);
  });
});

// ─── scripts/deployGate.mjs（合併前跑的閘門） ────────────────────────────────

describe('scripts/deployGate.mjs decide()', () => {
  type Decision = { safe: boolean; blocking: string[]; minor: string[]; numbers: Record<string, number> };
  type GateModule = {
    decide: (status: unknown, allow?: Set<string>) => Decision;
    parseArgs: (argv: string[]) => { waitMinutes: number; allow: Set<string>; url: string };
    REASON_TEXT: Record<string, string>;
  };
  const load = async (): Promise<GateModule> => (await import('../../../../scripts/deployGate.mjs')) as unknown as GateModule;

  it('safe live block → safe; minor reasons listed, not blocking', async () => {
    const { decide } = await load();
    const live = evaluateDeploySafety(input({ lineReplyQueue: 2 }, { roomsInLobbyWithHumans: 1 }));
    const d = decide({ live });
    expect(d.safe).toBe(true);
    expect(d.blocking).toEqual([]);
    expect(d.minor).toEqual(['lobby_with_humans', 'line_reply_queue']);
    expect(d.numbers.lineReplyQueue).toBe(2);
  });

  it('blocking live block → not safe; --allow turns a code into non-blocking', async () => {
    const { decide } = await load();
    const live = evaluateDeploySafety(input({}, { roomsInGame: 1, roomsInGameHumansAway: 1 }));
    expect(decide({ live })).toMatchObject({ safe: false, blocking: ['rooms_in_game_humans_away'] });
    expect(decide({ live }, new Set(['rooms_in_game_humans_away']))).toMatchObject({ safe: true, blocking: [] });
  });

  it('old server without live, garbage, null → not safe', async () => {
    const { decide } = await load();
    for (const s of [{}, null, 'x', { live: { reasons: [] } }]) expect(decide(s)).toMatchObject({ safe: false, blocking: ['live_missing'] });
  });

  it('every server reason code has a plain-words line; args parse', async () => {
    const { REASON_TEXT, parseArgs } = await load();
    for (const c of [...BLOCKING_REASONS, ...MINOR_REASONS]) expect(REASON_TEXT[c]).toBeTruthy();
    const a = parseArgs(['--wait', '30', '--allow', 'a,b', '--url', 'http://x/']);
    expect(a.waitMinutes).toBe(30);
    expect([...a.allow]).toEqual(['a', 'b']);
    expect(a.url).toBe('http://x');
  });
});
