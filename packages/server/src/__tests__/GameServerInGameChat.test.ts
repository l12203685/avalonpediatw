/**
 * 網站房間聊天（GameServer.handleChatMessage）的兩個新用途（站長 2026-11-26）：
 *   - 湖中宣告只打在聊天裡 → 照按鈕一樣記下（系統訊息「（取自聊天）」）；
 *   - 有百科AI 的局，對它玩法的回饋 → 遊戲內回饋（只算數字、不寫 log）。
 * 假資料，不連任何外部服務。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Player, Room } from '@avalon/shared';
import { GameEngine } from '../game/GameEngine';
import { GameServer } from '../socket/GameServer';
import { publicLakeHistory } from '../ai/lakeRecords';
import { __resetInGameFeedbackForTests, getInGameFeedback } from '../inGameFeedback';
import { __resetFeedbackForTests } from '../bots/feedback/service';

afterEach(() => {
  vi.clearAllTimers();
  vi.restoreAllMocks();
  __resetInGameFeedbackForTests();
  __resetFeedbackForTests();
});

function serverWithLake(botIds: string[] = []) {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const players: Record<string, Player> = {};
  for (let i = 1; i <= 7; i += 1) {
    const id = `p${i}`;
    players[id] = { id, name: `名${i}`, role: null, team: null, status: 'active', createdAt: 0, isBot: botIds.includes(id) };
  }
  const room: Room = {
    id: 'r1', name: 't', host: 'p1', state: 'lobby', players, maxPlayers: 10, currentRound: 0, maxRounds: 5, votes: {},
    questTeam: [], questResults: [], failCount: 0, evilWins: null, leaderIndex: 0, voteHistory: [], questHistory: [],
    questVotedCount: 0,
    roleOptions: { percival: true, morgana: true, oberon: true, mordred: true, ladyOfTheLake: true, ladyStart: 'seat0' },
    readyPlayerIds: [], createdAt: 0, updatedAt: 0,
  };
  const engine = new GameEngine(room);
  engine.startGame();
  const holderId = room.ladyOfTheLakeHolder!;
  room.state = 'lady_of_the_lake';
  room.currentRound = 2;
  const targetId = Object.keys(players).find((id) => id !== holderId && !botIds.includes(id))!;
  engine.submitLadyOfTheLakeTarget(holderId, targetId);
  engine.skipLakeDeclaration(holderId); // the holder did not press the button

  const chat: { playerId: string; message: string }[] = [];
  const io = { to: () => ({ emit: (_e: string, m: { playerId: string; message: string }) => chat.push({ playerId: m.playerId, message: m.message }) }) };
  const server = Object.create(GameServer.prototype) as GameServer;
  Object.assign(server, {
    io,
    roomManager: { getRoom: (id: string) => (id === 'r1' ? room : undefined) },
    gameEngines: new Map([['r1', engine]]),
    redTalk: new Map(),
    isPracticeRoom: () => false,
    broadcastRoomState: vi.fn(),
  });
  const s = server as unknown as { handleChatMessage(sock: unknown, roomId: string, msg: string): void };
  const say = (playerId: string, msg: string): void =>
    s.handleChatMessage({ id: `sock-${playerId}-${Math.random()}`, data: { playerId }, emit: vi.fn() }, 'r1', msg);
  const seat = (id: string): string => { const n = Object.keys(room.players).indexOf(id) + 1; return n === 10 ? '0' : String(n); };
  return { room, engine, chat, say, holderId, targetId, seat };
}

describe('GameServer: lake declaration typed in chat', () => {
  it('the holder types 「湖N紅」: recorded like the button, system line marked 取自聊天, bots see the claim', () => {
    const t = serverWithLake();
    expect(publicLakeHistory(t.room).at(-1)?.declaredClaim).toBe('none');
    t.say(t.holderId, `湖${t.seat(t.targetId)}紅`);
    expect(t.room.ladyOfTheLakeHistory?.at(-1)).toMatchObject({ declared: true, declaredClaim: 'evil', declaredVia: 'chat' });
    expect(publicLakeHistory(t.room).at(-1)?.declaredClaim).toBe('evil');
    expect(t.chat.map((c) => c.message)).toEqual([
      `湖${t.seat(t.targetId)}紅`,
      `系統: ${t.seat(t.holderId)}>${t.seat(t.targetId)} x（取自聊天）`,
    ]);
  });

  it('someone else typing the same thing changes nothing', () => {
    const t = serverWithLake();
    t.say(t.targetId, `湖${t.seat(t.targetId)}紅`);
    expect(t.room.ladyOfTheLakeHistory?.at(-1)?.declared).toBeFalsy();
    expect(t.chat).toHaveLength(1);
  });
});

describe('GameServer: in-game feedback capture', () => {
  it('a game with a bot: chat is captured and a remark about the bot is flagged (numbers only)', () => {
    const t = serverWithLake(['p5']);
    const cap = getInGameFeedback();
    cap.startGame('r1', { botSeats: [5], seatCount: 7 });
    t.say('p2', '大家好');
    t.say('p2', '5家為什麼這樣投');
    t.say('p3', 'AI 好強');
    expect(cap.snapshot()).toMatchObject({ capturedGames: 1, messages: 3, flagged: 2, forwarded: 2 });
  });

  it('a room that is not being captured is ignored', () => {
    const t = serverWithLake();
    t.say('p2', 'AI 好強');
    expect(getInGameFeedback().snapshot()).toMatchObject({ capturedGames: 0, messages: 0 });
  });
});
