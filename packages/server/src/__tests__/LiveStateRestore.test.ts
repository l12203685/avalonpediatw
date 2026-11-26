/**
 * 伺服器更新時保存進度（站長 2026-11-26：「…或是會影響就會儲存進度」）。
 *
 * 這裡確認：
 *   - 存檔（services/liveStateStore.ts）：加密、切段、讀回來一樣；金鑰不對讀不出來；版本衝突；清空；
 *   - 對局房間每個階段（派隊、投票、任務、湖中選人、湖中宣告、刺殺）拍照 → 存檔 → 另一台伺服器接回來：房間、引擎、
 *     機器人、計時器剩下的時間都在，接著打得下去；練習房；重複接不會接兩次；太舊的不接；
 *   - 關機：先寫掉回饋、跟房間說一聲、不再收動作；
 *   - 模擬瓦的題目存在同一個地方（SheetsSimBackend），重啟後接著做。
 * 不連網路：試算表是假的（FakeSheets），玩家是編的。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import type { Room } from '@avalon/shared';
import { GameServer } from '../socket/GameServer';
import type { GameEngine } from '../game/GameEngine';
import type { RoomManager } from '../game/RoomManager';
import type { PracticeSessions } from '../practice/PracticeSessions';
import { HeuristicAgent } from '../ai/HeuristicAgent';
import type { AvalonAgent } from '../ai/types';
import type { SheetTab, CellValue } from '../bots/digest/sheets';
import {
  LIVE_STATE_MAX_CHARS,
  LiveStateStore,
  LiveStateUnreadableError,
  createLiveStateStore,
  deriveLiveStateKey,
  openJson,
  sealJson,
  type LiveStateSheets,
} from '../services/liveStateStore';
import {
  LIVE_RESTORED_TEXT,
  LIVE_RESUME_FLOOR_MS,
  LIVE_SAVING_TEXT,
  LIVE_SNAPSHOT_MAX_AGE_MS,
  LiveRestore,
  parseLiveSnapshot,
  type LiveSnapshotFile,
} from '../socket/liveSnapshot';
import { SheetsSimBackend, SimPersistence } from '../bots/simulation/persist';
import { SimEngine, type SimRequest } from '../bots/simulation/session';
import { fixtureBankWithMid } from './fixtures/simGames';

// ─── 假的試算表 ─────────────────────────────────────────────────────────────

class FakeSheets implements LiveStateSheets {
  tabs: SheetTab[] = [];
  rows = new Map<number, CellValue[]>();
  adds = 0;
  reads = 0;
  writes = 0;
  fail = false;

  async listTabs(): Promise<SheetTab[]> {
    if (this.fail) throw new Error('503');
    return this.tabs;
  }

  async addTab(title: string): Promise<number> {
    this.adds += 1;
    this.tabs.push({ sheetId: 7, title, index: this.tabs.length });
    return 7;
  }

  async readValues(range: string): Promise<unknown[][]> {
    this.reads += 1;
    if (this.fail) throw new Error('503');
    const row = this.rows.get(rowOf(range));
    if (!row) return [];
    const trimmed = [...row];
    while (trimmed.length && trimmed[trimmed.length - 1] === '') trimmed.pop();
    return trimmed.length ? [trimmed] : [];
  }

  async updateValues(range: string, values: CellValue[][]): Promise<void> {
    this.writes += 1;
    if (this.fail) throw new Error('503');
    this.rows.set(rowOf(range), [...values[0]]);
  }

  /** 試算表裡所有看得到的字（確認沒有明文）。 */
  allText(): string {
    return [...this.rows.values()].flat().join('|');
  }
}

function rowOf(range: string): number {
  const m = /!A(\d+)/.exec(range);
  if (!m) throw new Error(`bad range ${range}`);
  return Number(m[1]);
}

const KEY = deriveLiveStateKey('test-jwt-secret');

function newStore(sheets = new FakeSheets(), key = KEY): { sheets: FakeSheets; store: LiveStateStore } {
  return { sheets, store: new LiveStateStore(sheets, key, { now: () => Date.UTC(2026, 10, 26, 2, 0) }) };
}

// ─── 存檔 ───────────────────────────────────────────────────────────────────

describe('LiveStateStore', () => {
  it('seal/open round trip; another key cannot read it; garbage is unreadable', () => {
    const v = { a: 1, b: ['角色', 'merlin'], c: { d: null } };
    const text = sealJson(v, KEY);
    expect(text.startsWith('v1.')).toBe(true);
    expect(text).not.toContain('merlin');
    expect(openJson(text, KEY)).toEqual(v);
    expect(() => openJson(text, deriveLiveStateKey('other'))).toThrow(LiveStateUnreadableError);
    expect(() => openJson('v1.AAAA', KEY)).toThrow(LiveStateUnreadableError);
    expect(() => openJson('plain', KEY)).toThrow(LiveStateUnreadableError);
  });

  it('write → read gives the same JSON; the tab is created once with a header; nothing readable in the sheet', async () => {
    const { sheets, store } = newStore();
    expect(await store.read('rooms')).toBeNull();
    const res = await store.write('rooms', { name: '小明', role: 'assassin' });
    expect(res.ok).toBe(true);
    const got = await store.read('rooms');
    expect(got?.json).toEqual({ name: '小明', role: 'assassin' });
    expect(got?.version).toBe(res.ok ? res.version : 'x');
    expect(sheets.adds).toBe(1);
    expect(sheets.rows.get(1)?.[0]).toBe('用途');
    expect(sheets.allText()).not.toMatch(/小明|assassin/);
    expect(sheets.rows.get(2)?.[2]).toBe('2026-11-26 10:00:00');
  });

  it('big payloads are split over several cells (each under 50,000 characters) and read back', async () => {
    const { sheets, store } = newStore();
    // 隨機字串壓不太小 → 一定要切好幾段
    const big = Array.from({ length: 3000 }, (_, i) => `${i}:${Math.random().toString(36).repeat(4)}`);
    expect((await store.write('rooms', { big })).ok).toBe(true);
    const row = sheets.rows.get(2)!;
    expect(Number(row[3])).toBeGreaterThan(1);
    for (const c of row) expect(String(c).length).toBeLessThan(50_000);
    expect((await store.read('rooms'))?.json).toEqual({ big });
    expect(LIVE_STATE_MAX_CHARS).toBeGreaterThan(2_000_000);
  });

  it('expectVersion: matching version writes; a different one is a conflict; null clears the row', async () => {
    const { store } = newStore();
    const first = await store.write('sim', { n: 1 }, null);
    expect(first.ok).toBe(true);
    expect(await store.write('sim', { n: 2 }, null)).toEqual({ ok: false, conflict: true });
    const v1 = first.ok ? first.version : null;
    const second = await store.write('sim', { n: 2 }, v1);
    expect(second.ok).toBe(true);
    expect((await store.read('sim'))?.json).toEqual({ n: 2 });
    expect(await store.write('sim', null, 'stale')).toEqual({ ok: false, conflict: true });
    expect((await store.write('sim', null, second.ok ? second.version : null)).ok).toBe(true);
    expect(await store.read('sim')).toBeNull();
    // rooms 與 sim 各自一列，互不影響
    await store.write('rooms', { r: 1 });
    expect(await store.read('sim')).toBeNull();
  });

  it('a different JWT_SECRET reads nothing usable (unreadable, not a crash)', async () => {
    const sheets = new FakeSheets();
    await newStore(sheets).store.write('rooms', { x: 1 });
    await expect(newStore(sheets, deriveLiveStateKey('rotated')).store.read('rooms')).rejects.toBeInstanceOf(LiveStateUnreadableError);
  });

  it('createLiveStateStore: needs the service account and JWT_SECRET; off disables; defaults to the practice sheet', () => {
    expect(createLiveStateStore({ JWT_SECRET: 's' }).status).toBe('no-credentials');
    expect(createLiveStateStore({ GOOGLE_SERVICE_ACCOUNT_JSON: '{}' }).status).toBe('no-secret');
    expect(createLiveStateStore({ LIVE_STATE_SHEET_ID: 'off', JWT_SECRET: 's' }).status).toBe('disabled');
    expect(createLiveStateStore({ JWT_SECRET: 's', GOOGLE_SERVICE_ACCOUNT_JSON: 'not json' }).status).toBe('bad-credentials');
  });
});

// ─── 對局房間 ───────────────────────────────────────────────────────────────

interface Internals {
  roomManager: RoomManager;
  gameEngines: Map<string, GameEngine>;
  botAgents: Map<string, AvalonAgent>;
  practice: PracticeSessions;
  roomStartTimes: Map<string, number>;
  restoredGreeting: Map<string, Set<string>>;
  frozen: boolean;
  addBotToRoom(room: Room): string;
  createGameEngine(roomId: string, room: Room): GameEngine;
  handleJoinRoom(socket: unknown, roomId: string, user: unknown, password?: string): void;
}

const servers: Internals[] = [];
const HUMAN = 'human-1';

function makeServer(): { server: GameServer; s: Internals; io: SocketIOServer } {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const io = new SocketIOServer(createServer());
  // 機器人延遲放大到很久：測試期間機器人不會自己動。
  const server = new GameServer(io, { practiceReportSink: null, botDelayScale: 10_000 });
  const s = server as unknown as Internals;
  servers.push(s);
  return { server, s, io };
}

afterEach(() => {
  for (const s of servers.splice(0)) for (const e of s.gameEngines.values()) e.cleanup();
  vi.restoreAllMocks();
});

function setupGame(s: Internals, roomId: string, seats: number, opts: { practice?: boolean } = {}): { room: Room; engine: GameEngine } {
  const room = s.roomManager.createRoom(roomId, '真人', HUMAN);
  const botIds: string[] = [];
  while (Object.keys(room.players).length < seats) botIds.push(s.addBotToRoom(room));
  const engine = s.createGameEngine(roomId, room);
  s.gameEngines.set(roomId, engine);
  if (opts.practice) {
    s.practice.create(roomId, HUMAN, { seat: null, role: null }, botIds);
    engine.configurePractice({ playerId: HUMAN, quietEventLog: true });
  }
  engine.startGame();
  s.roomStartTimes.set(roomId, 1_700_000_000_000);
  return { room: s.roomManager.getRoom(roomId)!, engine };
}

function teamFor(room: Room, engine: GameEngine): string[] {
  const size = engine.getEffectiveQuestSizes()[room.currentRound - 1];
  return Object.keys(room.players).slice(0, size);
}

function propose(room: Room, engine: GameEngine): void {
  engine.selectQuestTeam(teamFor(room, engine));
}

function approveAll(room: Room, engine: GameEngine): void {
  for (const id of Object.keys(room.players)) engine.submitVote(id, true);
}

function succeed(room: Room, engine: GameEngine): void {
  for (const id of [...room.questTeam]) engine.submitQuestVote(id, 'success');
}

function playRound(room: Room, engine: GameEngine): void {
  propose(room, engine);
  approveAll(room, engine);
  succeed(room, engine);
}

type Phase = 'proposal' | 'vote' | 'quest' | 'lake-pick' | 'lake-declare' | 'assassination';

function reach(phase: Phase, s: Internals, roomId: string): { room: Room; engine: GameEngine } {
  const lake = phase === 'lake-pick' || phase === 'lake-declare';
  const { room, engine } = setupGame(s, roomId, lake ? 7 : 5);
  if (phase === 'vote' || phase === 'quest') propose(room, engine);
  if (phase === 'quest') approveAll(room, engine);
  if (lake) {
    playRound(room, engine);
    playRound(room, engine);
    expect(room.state).toBe('lady_of_the_lake');
    if (phase === 'lake-declare') {
      const holder = room.ladyOfTheLakeHolder!;
      const target = Object.keys(room.players).find((id) => id !== holder && !room.ladyOfTheLakeUsed?.includes(id))!;
      engine.submitLadyOfTheLakeTarget(holder, target);
    }
  }
  if (phase === 'assassination') {
    playRound(room, engine);
    playRound(room, engine);
    playRound(room, engine);
  }
  return { room, engine };
}

const EXPECT_STATE: Record<Phase, Room['state']> = {
  proposal: 'voting',
  vote: 'voting',
  quest: 'quest',
  'lake-pick': 'lady_of_the_lake',
  'lake-declare': 'lady_of_the_lake',
  assassination: 'discussion',
};

/** 存檔 → 另一台伺服器接回來。 */
async function handOver(a: Internals & GameServer, b: GameServer): Promise<{ store: LiveStateStore; sheets: FakeSheets; restored: number; lr: LiveRestore }> {
  const { store, sheets } = newStore();
  const old = new LiveRestore(a, store, { logger: { info: () => undefined, warn: () => undefined } });
  expect(await old.saveOnShutdown()).toBeGreaterThan(0);
  const lr = new LiveRestore(b, store, { logger: { info: () => undefined, warn: () => undefined } });
  const restored = await lr.tryRestore();
  return { store, sheets, restored, lr };
}

/** 比較用：真人的連線狀態、updatedAt 不算。 */
function comparableRoom(room: Room): unknown {
  const r = JSON.parse(JSON.stringify(room)) as Room;
  for (const p of Object.values(r.players)) p.status = 'active';
  return { ...r, updatedAt: 0 };
}

describe('對局房間：每個階段存下來、另一台接回來', () => {
  for (const phase of Object.keys(EXPECT_STATE) as Phase[]) {
    it(`${phase}：房間、引擎、機器人、計時器都接回來，接著打得下去`, async () => {
      const A = makeServer();
      const { room, engine } = reach(phase, A.s, `R-${phase}`);
      expect(room.state).toBe(EXPECT_STATE[phase]);
      const remainingBefore = engine.getTimerRemainingMs();
      expect(remainingBefore).not.toBeNull();
      const roomBefore = comparableRoom(room);
      const engineBefore = JSON.parse(JSON.stringify(engine.serialize()));

      const B = makeServer();
      const { restored, store } = await handOver(A.server as Internals & GameServer, B.server);
      expect(restored).toBe(1);

      const r2 = B.s.roomManager.getRoom(room.id)!;
      const e2 = B.s.gameEngines.get(room.id)!;
      expect(comparableRoom(r2)).toEqual(roomBefore);
      expect(JSON.parse(JSON.stringify(e2.serialize()))).toEqual(engineBefore);
      // 真人還沒連回來；機器人都在、是同一套策略
      expect(r2.players[HUMAN].status).toBe('disconnected');
      for (const p of Object.values(r2.players).filter((x) => x.isBot)) expect(B.s.botAgents.get(p.id)).toBeInstanceOf(HeuristicAgent);
      expect(B.s.roomStartTimes.get(room.id)).toBe(1_700_000_000_000);
      // 計時器重新開始跑：至少留給玩家連回來的時間
      const after = e2.getTimerRemainingMs();
      expect(after).not.toBeNull();
      expect(after!).toBeGreaterThanOrEqual(Math.min(LIVE_RESUME_FLOOR_MS, remainingBefore!) - 1000);
      // 狀態頁：一間有真人（暫時斷線）的對局
      expect(B.server.liveCounts()).toMatchObject({ roomsInGame: 1, roomsInGameHumansAway: 1 });
      // 存檔讀過就清空
      expect(await store.read('rooms')).toBeNull();

      // 接著打
      if (phase === 'proposal') { propose(r2, e2); expect(r2.questTeam.length).toBeGreaterThan(0); }
      if (phase === 'vote') { approveAll(r2, e2); expect(r2.state).toBe('quest'); }
      if (phase === 'quest') { succeed(r2, e2); expect(r2.questResults).toEqual(['success']); }
      if (phase === 'lake-pick') {
        const holder = r2.ladyOfTheLakeHolder!;
        const target = Object.keys(r2.players).find((id) => id !== holder && !r2.ladyOfTheLakeUsed?.includes(id))!;
        e2.submitLadyOfTheLakeTarget(holder, target);
        expect(r2.ladyOfTheLakeTarget).toBe(target);
      }
      if (phase === 'lake-declare') {
        e2.skipLakeDeclaration(r2.ladyOfTheLakeHistory!.at(-1)!.holderId);
        expect(r2.state).toBe('voting');
        expect(r2.currentRound).toBe(3);
      }
      if (phase === 'assassination') {
        const assassin = Object.values(r2.players).find((p) => p.role === 'assassin' || p.role === 'mordred')!;
        const target = Object.values(r2.players).find((p) => p.team === 'good')!;
        e2.submitAssassination(assassin.id, target.id);
        expect(r2.state).toBe('ended');
      }
    });
  }

  it('計時器：照存檔時剩下的時間；太短的至少留 45 秒；無限思考時間不開計時器', async () => {
    const A = makeServer();
    const { room } = reach('vote', A.s, 'R-timer');
    const snap = A.server.buildLiveSnapshot(Date.now());
    const B = makeServer();
    const long = { ...snap, rooms: [{ ...snap.rooms[0], timerRemainingMs: 100_000 }] };
    expect(B.server.restoreLiveSnapshot(JSON.parse(JSON.stringify(long)) as LiveSnapshotFile)).toBe(1);
    const left = B.s.gameEngines.get(room.id)!.getTimerRemainingMs()!;
    expect(left).toBeGreaterThan(98_000);
    expect(left).toBeLessThanOrEqual(100_000);

    const C = makeServer();
    const short = { ...snap, rooms: [{ ...snap.rooms[0], timerRemainingMs: 3_000 }] };
    C.server.restoreLiveSnapshot(JSON.parse(JSON.stringify(short)) as LiveSnapshotFile);
    expect(C.s.gameEngines.get(room.id)!.getTimerRemainingMs()!).toBeGreaterThan(LIVE_RESUME_FLOOR_MS - 1000);

    const D = makeServer();
    const unlimited = JSON.parse(JSON.stringify(snap)) as LiveSnapshotFile;
    unlimited.rooms[0].room.timerConfig = { multiplier: null };
    unlimited.rooms[0].timerRemainingMs = null;
    D.server.restoreLiveSnapshot(unlimited);
    expect(D.s.gameEngines.get(room.id)!.getTimerRemainingMs()).toBeNull();
  });

  it('重複接不會接兩次；同一份存檔第二次讀到會跳過', async () => {
    const A = makeServer();
    reach('quest', A.s, 'R-idem');
    const snap = A.server.buildLiveSnapshot(Date.now());
    const B = makeServer();
    const copy = (): LiveSnapshotFile => JSON.parse(JSON.stringify(snap)) as LiveSnapshotFile;
    expect(B.server.restoreLiveSnapshot(copy())).toBe(1);
    const engine = B.s.gameEngines.get('R-idem');
    expect(B.server.restoreLiveSnapshot(copy())).toBe(0);
    expect(B.s.gameEngines.get('R-idem')).toBe(engine);

    const { store } = newStore();
    await store.write('rooms', copy());
    const lr = new LiveRestore(B.server, store, { logger: { info: () => undefined, warn: () => undefined } });
    expect(await lr.tryRestore()).toBe(0); // 房間已經在
    expect(await lr.tryRestore()).toBe(0); // 清空了
    expect(lr.status()).toMatchObject({ configured: true, lastRead: 'empty' });
  });

  it('只有機器人的房間、已經結束的房間不存；大廳裡有人等的房間存（沒有引擎狀態）', () => {
    const A = makeServer();
    const botsOnly = A.s.roomManager.createRoom('R-bots', 'x', 'BOT-HOST');
    botsOnly.players['BOT-HOST'].isBot = true;
    botsOnly.state = 'voting';
    const ended = A.s.roomManager.createRoom('R-ended', '真人', HUMAN);
    ended.state = 'ended';
    A.s.roomManager.createRoom('R-lobby', '真人', 'human-2');
    A.s.roomManager.setRoomPassword('R-lobby', 'pw');
    const snap = A.server.buildLiveSnapshot(Date.now());
    expect(snap.rooms.map((r) => r.room.id)).toEqual(['R-lobby']);
    expect(snap.rooms[0]).toMatchObject({ engine: null, password: 'pw', timerRemainingMs: null });
    const B = makeServer();
    expect(B.server.restoreLiveSnapshot(snap)).toBe(1);
    expect(B.s.roomManager.checkRoomPassword('R-lobby', 'pw')).toBe(true);
    expect(B.s.roomManager.checkRoomPassword('R-lobby', 'nope')).toBe(false);
    expect(B.s.gameEngines.has('R-lobby')).toBe(true);
  });

  it('練習房：練習紀錄、練習設定一起接回來，還是練習房', async () => {
    const A = makeServer();
    const { room } = setupGame(A.s, 'P-1', 5, { practice: true });
    A.s.practice.record('P-1', { round: 1, attempt: 1, botId: 'b', botSeat: 2, botRole: 'loyal', kind: 'vote', decision: '贊成', reason: 'r' } as never);
    propose(room, A.s.gameEngines.get('P-1')!);
    const B = makeServer();
    const { restored } = await handOver(A.server as Internals & GameServer, B.server);
    expect(restored).toBe(1);
    expect(B.s.practice.has('P-1')).toBe(true);
    expect(B.s.practice.get('P-1')?.ownerId).toBe(HUMAN);
    expect(B.s.practice.get('P-1')?.entries).toHaveLength(1);
    expect(B.s.gameEngines.get('P-1')!.isPractice()).toBe(true);
    expect(B.server.liveCounts()).toMatchObject({ practiceInGame: 1, roomsInGame: 0 });
  });

  it('真人連回來：回到同一間、同一個座位，私下收到「伺服器更新完成，已恢復進度」（只收一次）', async () => {
    const A = makeServer();
    const { room } = reach('vote', A.s, 'R-join');
    const seatBefore = Object.keys(room.players).indexOf(HUMAN);
    const B = makeServer();
    await handOver(A.server as Internals & GameServer, B.server);
    const emits: Array<[string, unknown]> = [];
    const socket = { id: 'sock-1', data: {}, join: vi.fn(), emit: (e: string, m: unknown) => { emits.push([e, m]); } };
    B.s.handleJoinRoom(socket, 'R-join', { uid: HUMAN, displayName: '真人' });
    const r2 = B.s.roomManager.getRoom('R-join')!;
    expect(r2.players[HUMAN].status).toBe('active');
    expect(Object.keys(r2.players).indexOf(HUMAN)).toBe(seatBefore);
    await vi.waitFor(() => {
      expect(emits.some(([e, m]) => e === 'chat:message-received' && (m as { message: string }).message === LIVE_RESTORED_TEXT)).toBe(true);
    }, { timeout: 3000 });
    const count = (): number => emits.filter(([e, m]) => e === 'chat:message-received' && (m as { message: string }).message === LIVE_RESTORED_TEXT).length;
    B.s.handleJoinRoom({ ...socket, id: 'sock-2' }, 'R-join', { uid: HUMAN, displayName: '真人' });
    await new Promise((r) => setTimeout(r, 1700));
    expect(count()).toBe(1);
  });

  it('剛開機、玩家要進的房間還不在：先看一次存檔（舊的那台剛存好）', async () => {
    const A = makeServer();
    reach('quest', A.s, 'R-late');
    const { store } = newStore();
    const B = makeServer();
    const lr = new LiveRestore(B.server, store, { logger: { info: () => undefined, warn: () => undefined } });
    expect(await lr.ensureRoom('R-late')).toBe(false); // 舊的那台還沒存
    await new LiveRestore(A.server, store, { logger: { info: () => undefined, warn: () => undefined } }).saveOnShutdown();
    expect(await lr.ensureRoom('R-late')).toBe(true);
    // 開機太久之後就不看了
    const late = new LiveRestore(B.server, store, { handoverMs: 0, logger: { info: () => undefined, warn: () => undefined } });
    expect(late.inHandover()).toBe(false);
    expect(await late.ensureRoom('R-none')).toBe(false);
  });

  it('超過 15 分鐘的存檔不接（也清掉）；版本不同不接', async () => {
    const A = makeServer();
    reach('quest', A.s, 'R-old');
    const snap = A.server.buildLiveSnapshot(Date.now() - LIVE_SNAPSHOT_MAX_AGE_MS - 1000);
    const { store } = newStore();
    await store.write('rooms', snap);
    const B = makeServer();
    const lr = new LiveRestore(B.server, store, { logger: { info: () => undefined, warn: () => undefined } });
    expect(await lr.tryRestore()).toBe(0);
    expect(lr.status().lastRead).toBe('stale');
    expect(await store.read('rooms')).toBeNull();
    expect(parseLiveSnapshot({ ...snap, savedAt: Date.now(), version: 99 }, Date.now()).file).toBeNull();
    expect(parseLiveSnapshot({ ...snap, savedAt: Date.now() }, Date.now()).file?.rooms).toHaveLength(1);
  });

  it('關機：先寫掉待寫的、跟房間說一聲、之後不再收動作、機器人不再動；沒有存檔的地方也不會出錯', async () => {
    const A = makeServer();
    reach('vote', A.s, 'R-bye');
    const said: string[] = [];
    const io = (A.server as unknown as { io: { to: (r: string) => { emit: (e: string, m: { message: string }) => void } } }).io;
    vi.spyOn(io, 'to').mockImplementation(() => ({ emit: (_e: string, m: { message: string }) => { said.push(m.message); } }));
    const flush = vi.spyOn(A.server, 'flushPendingWrites');
    const { store, sheets } = newStore();
    expect(await new LiveRestore(A.server, store, { logger: { info: () => undefined, warn: () => undefined } }).saveOnShutdown()).toBe(1);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(said).toContain(LIVE_SAVING_TEXT);
    expect(A.s.frozen).toBe(true);
    expect(sheets.allText()).not.toContain('真人');

    const C = makeServer();
    reach('vote', C.s, 'R-nostore');
    expect(await new LiveRestore(C.server, null).saveOnShutdown()).toBe(0);
    expect(C.s.frozen).toBe(true);

    const D = makeServer();
    reach('vote', D.s, 'R-fail');
    const broken = newStore();
    broken.sheets.fail = true;
    const lr = new LiveRestore(D.server, broken.store, { logger: { info: () => undefined, warn: () => undefined } });
    expect(await lr.saveOnShutdown()).toBe(0);
    expect(lr.status().saveFailures).toBe(1);
  });
});

// ─── 模擬瓦的題目存在同一個地方 ─────────────────────────────────────────────

describe('模擬瓦：存在私人試算表（SheetsSimBackend），重啟後接著做', () => {
  const BANK = fixtureBankWithMid();
  const DM: SimRequest = { platform: 'line', chatId: 'U-chat', userId: 'U-user' };
  const quiet = { info: (): void => undefined, warn: (): void => undefined };

  function boot(sheets: FakeSheets): { engine: SimEngine; persist: SimPersistence } {
    const persist = new SimPersistence({
      backend: new SheetsSimBackend(new LiveStateStore(sheets, KEY)),
      loadRetryDelaysMs: [1, 1],
      catchUpDelaysMs: [],
      handoverMs: 0,
      debounceMs: 3_600_000,
      firstDelayMs: 3_600_000,
      logger: quiet,
    });
    const engine = new SimEngine({ bank: async () => BANK, random: () => () => 0, persistence: persist });
    return { engine, persist };
  }

  async function say(engine: SimEngine, text: string): Promise<string | null> {
    const r = await engine.handleText(text, DM);
    if (!r) return null;
    r.commit();
    return r.text;
  }

  it('開題、作答 → 關機寫進去 → 新的一台讀回來，後面的回覆跟沒重啟一樣', async () => {
    const steps = ['/模擬 忠臣 4', '/派 469', '/分析', '/公布'];
    const straightSheets = new FakeSheets();
    const straight = boot(straightSheets);
    await straight.persist.restore();
    const expected: (string | null)[] = [];
    for (const t of steps) expected.push(await say(straight.engine, t));
    straight.persist.stop();

    const sheets = new FakeSheets();
    const a = boot(sheets);
    await a.persist.restore();
    expect(await say(a.engine, steps[0])).toBe(expected[0]);
    expect(await say(a.engine, steps[1])).toBe(expected[1]);
    await a.persist.flush();
    a.persist.stop();
    expect(sheets.allText()).not.toContain('U-user');

    const b = boot(sheets);
    await b.persist.restore();
    expect(b.persist.status()).toMatchObject({ configured: true, restored: true, restoredSessions: 1 });
    expect(await say(b.engine, steps[2])).toBe(expected[2]);
    expect(await say(b.engine, steps[3])).toBe(expected[3]);
    b.persist.stop();
  });
});
