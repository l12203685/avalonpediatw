/**
 * 湖中宣告只打在聊天裡（站長 2026-11-26「因為有時候玩家的湖中宣告會只送文字」）— game/lakeChatDeclare.ts。
 * 假資料：座位、句子都是編的。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Player, Room } from '@avalon/shared';
import { GameEngine } from '../game/GameEngine';
import {
  LakeChatWatcher,
  lakeChatDeclareEnabled,
  openLakeForChat,
  parseLakeChatDeclaration,
  type LakeChatParseContext,
} from '../game/lakeChatDeclare';
import { publicLakeHistory } from '../ai/lakeRecords';

const ctx = (over: Partial<LakeChatParseContext> = {}): LakeChatParseContext => ({
  targetSeat: 3,
  holderSeat: 2,
  firstMessageAfterInspection: false,
  ...over,
});

describe('parseLakeChatDeclaration — accepted forms', () => {
  it.each([
    ['2>3 o', 'good'],
    ['2 > 3 x', 'evil'],
    ['2＞3 O', 'good'],
    ['湖3好', 'good'],
    ['3藍', 'good'],
    ['3是好人', 'good'],
    ['湖到3 紅', 'evil'],
    ['3 黑', 'evil'],
    ['湖中 3 是壞人', 'evil'],
    ['我湖3號好人喔', 'good'],
    ['3家紅方', 'evil'],
    ['3 ○', 'good'],
    ['3 ×', 'evil'],
    ['3不是好人', 'evil'],
    ['3不是壞人', 'good'],
    ['３藍', 'good'], // full-width digit (NFKC)
  ] as const)('%s → %s', (text, want) => {
    expect(parseLakeChatDeclaration(text, ctx())).toBe(want);
  });

  it('seat 10 is written as 0 or 10', () => {
    expect(parseLakeChatDeclaration('0藍', ctx({ targetSeat: 10 }))).toBe('good');
    expect(parseLakeChatDeclaration('10 x', ctx({ targetSeat: 10 }))).toBe('evil');
    expect(parseLakeChatDeclaration('2>0 o', ctx({ targetSeat: 10 }))).toBe('good');
  });

  it('a bare faction word counts only as the first message after the inspection', () => {
    expect(parseLakeChatDeclaration('好人', ctx({ firstMessageAfterInspection: true }))).toBe('good');
    expect(parseLakeChatDeclaration('x', ctx({ firstMessageAfterInspection: true }))).toBe('evil');
    expect(parseLakeChatDeclaration('紅', ctx({ firstMessageAfterInspection: true }))).toBe('evil');
    expect(parseLakeChatDeclaration('好人', ctx())).toBeNull();
    expect(parseLakeChatDeclaration('x', ctx())).toBeNull();
  });
});

describe('parseLakeChatDeclaration — rejected (prefer missing over a wrong parse)', () => {
  it.each([
    '3是好人嗎',
    '3藍?',
    '3藍？',
    '3好人吧',
    '4藍', // another seat
    '3藍 4紅', // two seats / two factions
    '3 好人 壞人',
    '3 o x',
    '1>3 o', // N is not the holder
    '2>4 o', // M is not the target
    '3不好說',
    '3 好像是壞人',
    '我覺得3是好人但不確定',
    '3應該是藍',
    '/湖 3 好',
    '這局好難',
    '好吧',
    '3',
    '',
  ])('%s → null', (text) => {
    expect(parseLakeChatDeclaration(text, ctx({ firstMessageAfterInspection: true }))).toBeNull();
  });

  it('very long messages are not declarations', () => {
    expect(parseLakeChatDeclaration(`3藍${'。'.repeat(40)}`, ctx())).toBeNull();
  });
});

describe('LAKE_CHAT_DECLARE switch', () => {
  it('default on; off / false / 0 / no turn it off', () => {
    expect(lakeChatDeclareEnabled({})).toBe(true);
    expect(lakeChatDeclareEnabled({ LAKE_CHAT_DECLARE: '1' })).toBe(true);
    for (const v of ['off', 'false', '0', 'no', 'OFF']) expect(lakeChatDeclareEnabled({ LAKE_CHAT_DECLARE: v })).toBe(false);
  });
});

// ─── With a real engine ───────────────────────────────────────────────────

function makeLakeRoom(): { engine: GameEngine; room: Room; holderId: string; targetId: string } {
  const players: Record<string, Player> = {};
  for (let i = 1; i <= 7; i += 1) {
    players[`p${i}`] = { id: `p${i}`, name: `P${i}`, role: null, team: null, status: 'active', createdAt: 0 };
  }
  const room: Room = {
    id: 'lake-chat-room', name: 'test', host: 'p1', state: 'lobby', players, maxPlayers: 10,
    currentRound: 0, maxRounds: 5, votes: {}, questTeam: [], questResults: [], failCount: 0, evilWins: null,
    leaderIndex: 0, voteHistory: [], questHistory: [], questVotedCount: 0,
    roleOptions: { percival: true, morgana: true, oberon: true, mordred: true, ladyOfTheLake: true, ladyStart: 'seat0' },
    readyPlayerIds: [], createdAt: 0, updatedAt: 0,
  };
  const engine = new GameEngine(room);
  engine.startGame();
  const holderId = room.ladyOfTheLakeHolder!;
  room.state = 'lady_of_the_lake';
  room.currentRound = 2;
  const targetId = Object.keys(players).find((id) => id !== holderId)!;
  engine.submitLadyOfTheLakeTarget(holderId, targetId);
  return { engine, room, holderId, targetId };
}

const seatOf = (room: Room, id: string): number => Object.keys(room.players).indexOf(id) + 1;

describe('LakeChatWatcher + declareLakeResult (same record as the button)', () => {
  afterEach(() => {
    vi.clearAllTimers();
    delete process.env.LAKE_CHAT_DECLARE;
  });

  it('a chat declaration is recorded like the button, marked declaredVia chat, and the bots see it', () => {
    const { engine, room, holderId, targetId } = makeLakeRoom();
    // The holder skips the button (or the 30 s timer runs out): the bots see the lake as undeclared.
    engine.skipLakeDeclaration(holderId);
    expect(room.state).toBe('voting');
    expect(publicLakeHistory(room).at(-1)?.declaredClaim).toBe('none');

    const w = new LakeChatWatcher();
    const claim = w.claimFor(room.id, room, holderId, `湖${seatOf(room, targetId)}紅`);
    expect(claim).toBe('evil');
    const rec = engine.declareLakeResult(holderId, claim!, { via: 'chat' });
    expect(rec).toMatchObject({ declared: true, declaredClaim: 'evil', declaredVia: 'chat', targetId });
    // The observation the live bot is built from (GameServer.buildBotObservation → publicLakeHistory) now has the claim.
    expect(publicLakeHistory(room).at(-1)).toMatchObject({ holderId, targetId, declaredClaim: 'evil' });
    // The event log / replay carry it too.
    const ev = engine.getEventLog().find((e) => e.event_type === 'lady_of_the_lake_declared');
    expect(ev?.event_data).toMatchObject({ claim: 'evil', via: 'chat' });
    // Already declared: nothing more is read.
    expect(w.claimFor(room.id, room, holderId, `湖${seatOf(room, targetId)}好`)).toBeNull();
  });

  it('during the lake phase a chat declaration ends the phase like the button', () => {
    const { engine, room, holderId, targetId } = makeLakeRoom();
    const w = new LakeChatWatcher();
    const claim = w.claimFor(room.id, room, holderId, `${seatOf(room, holderId)}>${seatOf(room, targetId)} o`);
    expect(claim).toBe('good');
    engine.declareLakeResult(holderId, claim!, { via: 'chat' });
    expect(room.state).toBe('voting');
    expect(room.ladyOfTheLakeHistory?.at(-1)).toMatchObject({ declared: true, declaredClaim: 'good', declaredVia: 'chat' });
  });

  it('the button path does not get the chat marker', () => {
    const { engine, room, holderId } = makeLakeRoom();
    const rec = engine.declareLakeResult(holderId, 'good');
    expect(rec?.declaredVia).toBeUndefined();
    expect(room.ladyOfTheLakeHistory?.at(-1)?.declaredVia).toBeUndefined();
  });

  it('only the holder, only while undeclared, only before the next quest result', () => {
    const { engine, room, holderId, targetId } = makeLakeRoom();
    engine.skipLakeDeclaration(holderId);
    const w = new LakeChatWatcher();
    const text = `${seatOf(room, targetId)}藍`;
    expect(w.claimFor(room.id, room, targetId, text)).toBeNull(); // not the holder
    room.questHistory = [
      { round: 1, team: [], result: 'success', failCount: 0 },
      { round: 2, team: [], result: 'success', failCount: 0 },
      { round: 3, team: [], result: 'fail', failCount: 1 },
    ] as unknown as Room['questHistory'];
    expect(openLakeForChat(room)).toBeNull();
    expect(w.claimFor(room.id, room, holderId, text)).toBeNull(); // the next quest finished
    room.questHistory = room.questHistory.slice(0, 2);
    room.state = 'ended';
    expect(w.claimFor(room.id, room, holderId, text)).toBeNull(); // game over
  });

  it('a bare word counts only as the holder\'s first message after the inspection', () => {
    const { engine, room, holderId } = makeLakeRoom();
    engine.skipLakeDeclaration(holderId);
    const w = new LakeChatWatcher();
    expect(w.claimFor(room.id, room, holderId, '等等')).toBeNull();
    expect(w.claimFor(room.id, room, holderId, '好人')).toBeNull(); // second message
    expect(w.counts.holderMessagesUnread).toBe(2);

    const b = makeLakeRoom();
    b.engine.skipLakeDeclaration(b.holderId);
    const w2 = new LakeChatWatcher();
    expect(w2.claimFor(b.room.id, b.room, b.holderId, '好人')).toBe('good');
  });

  it('LAKE_CHAT_DECLARE=off reads nothing', () => {
    const { room, holderId, targetId } = makeLakeRoom();
    process.env.LAKE_CHAT_DECLARE = 'off';
    expect(new LakeChatWatcher().claimFor(room.id, room, holderId, `湖${seatOf(room, targetId)}好`)).toBeNull();
  });
});
