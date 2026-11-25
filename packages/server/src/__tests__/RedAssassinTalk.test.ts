/**
 * 刺殺階段紅方討論（站長 2026-11-25，`src/ai/redAssassinTalk.ts`）：「/刺殺 N」的解析、只聽紅方隊友、最新一則算數、
 * 時間到刺自己的第一人選、訊息寫 N家／0家；自己網站（GameServer）上紅方全是機器人時照舊、有真人紅方時說看法並等指令。
 * 不連任何外部服務。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Player, Role, Room, VoteRecord } from '@avalon/shared';
import {
  ASSASSIN_ASK_TEXT, AssassinCommandWait, RED_TALK_NO_TIMER_WAIT_MS, RED_TALK_SAFETY_MARGIN_MS, RED_TALK_SUBMIT_DELAY_MS,
  assassinWaitDeadline, parseAssassinCommand, redAssassinView, redTalkEnabled, redViewMessage, seatLabel,
} from '../ai/redAssassinTalk';
import { HeuristicAgent } from '../ai/HeuristicAgent';
import type { PlayerObservation } from '../ai/types';
import { GameServer } from '../socket/GameServer';
import { assassinationPhase, humanRedSeats } from '../../scripts/signagePlayer';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('parseAssassinCommand', () => {
  it.each([
    ['/刺殺 3', 3], ['/刺殺3', 3], ['／刺殺 3', 3], ['/刺殺 ３', 3], ['／刺殺３家', 3], [' /刺殺 7家 ', 7],
    ['/刺殺 0', 10], ['/刺殺 10', 10], ['/刺殺 １０', 10], ['/刺殺 0家', 10], ['/ 刺殺 9', 9], ['/刺殺　5', 5],
  ])('%s → %d', (text, seat) => {
    expect(parseAssassinCommand(text)).toBe(seat);
  });
  it.each(['刺殺 3', '/刺殺', '/刺殺 11', '/刺殺 3 7', '我覺得 /刺殺 3', '/刺殺 三', '/刺殺 -1', '/刺 3', ''])('不是指令：%s', (text) => {
    expect(parseAssassinCommand(text)).toBeNull();
  });
});

describe('seatLabel / redTalkEnabled', () => {
  it('第 10 位寫 0家', () => {
    expect(seatLabel(3)).toBe('3家');
    expect(seatLabel(10)).toBe('0家');
  });
  it('RED_ASSASSIN_TALK=off 關掉，預設開', () => {
    expect(redTalkEnabled({})).toBe(true);
    expect(redTalkEnabled({ RED_ASSASSIN_TALK: 'on' })).toBe(true);
    for (const v of ['off', 'OFF', 'false', '0', 'no']) expect(redTalkEnabled({ RED_ASSASSIN_TALK: v })).toBe(false);
  });
});

describe('AssassinCommandWait', () => {
  // 紅方 7、8、9、0家；刺客機器人坐 7家；第一人選 1家
  const make = (deadlineAt = 100_000): AssassinCommandWait => new AssassinCommandWait({
    mySeat: 7, redSeats: new Set([7, 8, 9, 10]), tableSeats: new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), fallbackSeat: 1, deadlineAt,
  });

  it('只聽紅方隊友：藍方、自己、格式不對的都不理', () => {
    const w = make();
    expect(w.onChat(2, '/刺殺 3', 0)).toBeNull();
    expect(w.onChat(7, '/刺殺 3', 0)).toBeNull();
    expect(w.onChat(8, '刺 3 吧', 0)).toBeNull();
    expect(w.pendingSeat).toBeNull();
    expect(w.poll(10_000)).toBeNull();
    expect(w.onChat(8, '/刺殺 3', 10_000)).toBeNull();
    expect(w.pendingSeat).toBe(3);
  });

  it('最新一則有效的指令算數，收到後等幾秒才刺', () => {
    const w = make();
    w.onChat(8, '/刺殺 3', 1000);
    w.onChat(10, '/刺殺 5家', 3000); // 0家的隊友改口
    expect(w.poll(3000 + RED_TALK_SUBMIT_DELAY_MS - 1)).toBeNull();
    const step = w.poll(3000 + RED_TALK_SUBMIT_DELAY_MS);
    expect(step).toEqual({ seat: 5, source: 'command', reply: '收到，刺殺 5家' });
    expect(w.done).toBe(true);
    expect(w.poll(999_999)).toBeNull();
    expect(w.onChat(8, '/刺殺 2', 999_999)).toBeNull();
  });

  it('不能刺紅方、桌上沒有的座位：回一句，不改目前的指令', () => {
    const w = make();
    w.onChat(8, '/刺殺 2', 0);
    expect(w.onChat(9, '/刺殺 0', 1000)).toBe('0家 是紅方，不能刺，請改選別人（/刺殺 座位號碼）。');
    expect(w.pendingSeat).toBe(2);
    const small = new AssassinCommandWait({ mySeat: 5, redSeats: new Set([4, 5]), tableSeats: new Set([1, 2, 3, 4, 5, 6, 7]), fallbackSeat: 1, deadlineAt: 1e9 });
    expect(small.onChat(4, '/刺殺 9', 0)).toBe('桌上沒有 9家，請重新輸入 /刺殺 座位號碼。');
    expect(small.pendingSeat).toBeNull();
  });

  it('時間到還沒收到指令：刺自己的第一人選並說一句', () => {
    const w = make(60_000);
    w.onChat(3, '/刺殺 4', 100); // 藍方的不算
    expect(w.poll(59_999)).toBeNull();
    expect(w.poll(60_000)).toEqual({
      seat: 1, source: 'timeout', reply: '沒有收到紅方隊友的 /刺殺 指令，時間快到了，我照自己的判斷刺 1家',
    });
  });

  it('時間到時有剛收到的指令：直接照指令刺', () => {
    const w = make(60_000);
    w.onChat(8, '/刺殺 6', 58_000);
    expect(w.poll(60_000)?.seat).toBe(6);
  });

  it('等多久：有倒數留安全時間，沒有倒數約 3 分鐘', () => {
    expect(assassinWaitDeadline(1000, null)).toBe(1000 + RED_TALK_NO_TIMER_WAIT_MS);
    expect(assassinWaitDeadline(0, 180_000)).toBe(180_000 - RED_TALK_SAFETY_MARGIN_MS);
    expect(assassinWaitDeadline(0, 30_000)).toBe(15_000);
    expect(assassinWaitDeadline(0, 3_600_000)).toBe(RED_TALK_NO_TIMER_WAIT_MS);
  });
});

// ── 一局 10 人：紅方 7 刺客、8 莫甘娜、9 莫德雷德、10 奧伯倫；梅林 1、派西 2 ──────────────────
const IDS = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9', 'p10'];
const ROLES: Role[] = ['merlin', 'percival', 'loyal', 'loyal', 'loyal', 'loyal', 'assassin', 'morgana', 'mordred', 'oberon'];
const REDS = ['p7', 'p8', 'p9', 'p10'];
const allYes = (except: string[] = []): Record<string, boolean> => Object.fromEntries(IDS.map((id) => [id, !except.includes(id)]));
const VOTES: VoteRecord[] = [
  { round: 1, attempt: 1, leader: 'p1', team: ['p1', 'p3', 'p4'], approved: true, votes: allYes(['p8']) },
  { round: 2, attempt: 1, leader: 'p2', team: ['p2', 'p7', 'p5', 'p6'], approved: false, votes: allYes(['p1', 'p3', 'p4', 'p5', 'p6', 'p9']) },
  { round: 2, attempt: 2, leader: 'p3', team: ['p3', 'p1', 'p4', 'p5'], approved: true, votes: allYes() },
  { round: 3, attempt: 1, leader: 'p4', team: ['p4', 'p8', 'p10', 'p3'], approved: false, votes: allYes(['p1', 'p3', 'p5', 'p6']) },
  { round: 3, attempt: 2, leader: 'p5', team: ['p5', 'p1', 'p3', 'p6'], approved: true, votes: allYes() },
];
const QUESTS = [
  { round: 1, team: ['p1', 'p3', 'p4'], result: 'success' as const, failCount: 0 },
  { round: 2, team: ['p3', 'p1', 'p4', 'p5'], result: 'success' as const, failCount: 0 },
  { round: 3, team: ['p5', 'p1', 'p3', 'p6'], result: 'success' as const, failCount: 0 },
];

function obsFor(me: string): PlayerObservation {
  return {
    myPlayerId: me, myRole: ROLES[IDS.indexOf(me)], myTeam: 'evil', playerCount: 10, allPlayerIds: IDS,
    knownEvils: REDS.filter((id) => id !== me), allEvilIds: REDS,
    allEvilRoles: Object.fromEntries(REDS.map((id) => [id, ROLES[IDS.indexOf(id)]])),
    currentRound: 4, currentLeader: 'p6', failCount: 0, questResults: ['success', 'success', 'success'], gamePhase: 'assassination',
    voteHistory: VOTES, questHistory: QUESTS, proposedTeam: [], lakeHistory: [], myLakeResults: [], evilCount: 4, lobbyRoles: ROLES,
  };
}
const seatOf = (id: string): number => IDS.indexOf(id) + 1;

describe('redAssassinView / redViewMessage', () => {
  it('任何紅方角色都說：第一人選＝刺客會刺的人、第二人選、1–3 個理由，座位寫 N家', () => {
    for (const me of REDS) {
      const agent = new HeuristicAgent(me);
      const view = redAssassinView(agent, obsFor(me), seatOf)!;
      expect(view).not.toBeNull();
      expect(REDS).not.toContain(view.pick);
      expect(view.second).not.toBeNull();
      expect(view.second).not.toBe(view.pick);
      expect(view.reasons.length).toBeGreaterThanOrEqual(1);
      expect(view.reasons.length).toBeLessThanOrEqual(3);
      const msg = redViewMessage(view, seatOf);
      expect(msg).toMatch(/^我覺得梅林是 [0-9]家（第二人選 [0-9]家）：.+。$/);
      expect(msg).not.toMatch(/10家|S\d/);
    }
    // 刺客自己的第一人選和它真的會刺的人一樣
    const assassinObs = obsFor('p7');
    const act = new HeuristicAgent('p7').act(assassinObs);
    expect(redAssassinView(new HeuristicAgent('p7'), assassinObs, seatOf)!.pick).toBe(act.type === 'assassinate' ? act.targetId : '');
  });

  it('第 10 位寫 0家', () => {
    expect(redViewMessage({ pick: 'p10', second: 'p3', reasons: ['0家 當隊長派的 1 隊都沒有梅林看得到的紅'] }, seatOf))
      .toBe('我覺得梅林是 0家（第二人選 3家）：0家 當隊長派的 1 隊都沒有梅林看得到的紅。');
  });
});

describe('練習台補位：刺殺階段與真人紅方', () => {
  it('三個任務成功、還沒結束 = 刺殺階段', () => {
    expect(assassinationPhase({ gaming: true, status: '刺殺', missions: [true, false, true, true] })).toBe(true);
    expect(assassinationPhase({ gaming: true, status: '派票', missions: [true, true] })).toBe(false);
    expect(assassinationPhase({ gaming: true, status: '遊戲結束', missions: [true, true, true] })).toBe(false);
  });
  it('真人紅方：練習台內建機器人、百科AI、自己都不算', () => {
    const u = (set: number, name: string, is_robot = false) => ({ set, name, is_robot }) as never;
    const s = { myself: { set: 7 }, users: [u(7, '百科AI_0'), u(8, '甲'), u(9, '百科AI_21'), u(10, '機器人', true), u(1, '乙')] } as never;
    expect(humanRedSeats(s, [7, 8, 9, 10])).toEqual([8]);
    expect(humanRedSeats(s, [7, 9, 10])).toEqual([]);
  });
});

// ── 自己網站：GameServer 的刺殺階段 ─────────────────────────────────────────────────────
function serverWith(humans: string[], timerMs: number | null = 180_000) {
  vi.useFakeTimers();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const players: Record<string, Player> = Object.fromEntries(IDS.map((id, i) => [id, {
    id, name: `名${i + 1}`, role: ROLES[i], team: REDS.includes(id) ? 'evil' : 'good', status: 'active', createdAt: 0, isBot: !humans.includes(id),
  } as Player]));
  const room = {
    id: 'r1', state: 'discussion', players, currentRound: 4, questTeam: [], questResults: ['success', 'success', 'success'],
    failCount: 0, voteHistory: VOTES, questHistory: QUESTS, votes: {},
  } as unknown as Room;
  const engine = {
    getCurrentLeaderId: () => 'p6',
    getAssassinationTimeoutMs: () => timerMs,
    submitAssassination: vi.fn((_a: string, t: string) => { if (players[t].team === 'evil') throw new Error('red'); room.state = 'ended'; }),
  };
  const chat: { playerId: string; message: string }[] = [];
  const io = { to: () => ({ emit: (_e: string, m: { playerId: string; message: string }) => chat.push({ playerId: m.playerId, message: m.message }) }) };
  const server = Object.create(GameServer.prototype) as GameServer;
  const onGameEnded = vi.fn();
  Object.assign(server, {
    io,
    roomManager: { getRoom: () => room },
    gameEngines: new Map([['r1', engine]]),
    botAgents: new Map(IDS.filter((id) => !humans.includes(id)).map((id) => [id, new HeuristicAgent(id)])),
    botDelayScale: 0,
    redTalkWaitScale: 1,
    redTalk: new Map(),
    isPracticeRoom: () => false,
    broadcastRoomState: vi.fn(),
    commitPracticeTrace: vi.fn(),
    onGameEnded,
  });
  const s = server as unknown as { scheduleBotActions(id: string): void; handleChatMessage(sock: unknown, roomId: string, msg: string): void };
  const say = (playerId: string, msg: string): void => s.handleChatMessage({ id: `sock-${playerId}-${Math.random()}`, data: { playerId }, emit: vi.fn() }, 'r1', msg);
  return { room, engine, chat, onGameEnded, schedule: () => s.scheduleBotActions('r1'), say };
}
const botLines = (chat: { playerId: string; message: string }[]) => chat.filter((c) => c.playerId !== 'system' && IDS.includes(c.playerId) && !c.message.startsWith('/'));

describe('GameServer 刺殺階段紅方討論', () => {
  it('紅方全是機器人：照舊直接刺，不說話、不等', async () => {
    const t = serverWith(['p1', 'p3']); // 真人都是藍方
    t.schedule();
    await vi.advanceTimersByTimeAsync(10);
    expect(t.engine.submitAssassination).toHaveBeenCalledTimes(1);
    expect(t.engine.submitAssassination.mock.calls[0][0]).toBe('p7');
    expect(botLines(t.chat)).toEqual([]);
  });

  it('紅方有真人、刺客是機器人：每個紅方機器人說看法、刺客請隊友下指令，照紅方隊友最新的 /刺殺 刺', async () => {
    const t = serverWith(['p8', 'p2']); // 莫甘娜與派西是真人
    t.schedule();
    await vi.advanceTimersByTimeAsync(10);
    const lines = botLines(t.chat);
    expect(lines.filter((c) => c.message.startsWith('我覺得梅林是')).map((c) => c.playerId)).toEqual(['p7', 'p9', 'p10']);
    expect(lines.at(-1)).toEqual({ playerId: 'p7', message: ASSASSIN_ASK_TEXT });
    expect(t.engine.submitAssassination).not.toHaveBeenCalled();
    // 再排一次（畫面更新時常會這樣）也不會重說或自己刺
    t.schedule();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(botLines(t.chat)).toHaveLength(lines.length);
    expect(t.engine.submitAssassination).not.toHaveBeenCalled();
    t.say('p2', '/刺殺 4'); // 藍方：不理
    t.say('p8', '/刺殺 9'); // 紅方：回一句
    expect(botLines(t.chat).at(-1)?.message).toBe('9家 是紅方，不能刺，請改選別人（/刺殺 座位號碼）。');
    await vi.advanceTimersByTimeAsync(1100);
    t.say('p8', '／刺殺 ３');
    await vi.advanceTimersByTimeAsync(2000);
    t.say('p8', '/刺殺 5家'); // 改口
    await vi.advanceTimersByTimeAsync(RED_TALK_SUBMIT_DELAY_MS + 1000);
    expect(t.engine.submitAssassination).toHaveBeenCalledTimes(1);
    expect(t.engine.submitAssassination).toHaveBeenCalledWith('p7', 'p5');
    expect(t.chat.some((c) => c.playerId === 'p7' && c.message === '收到，刺殺 5家')).toBe(true);
    expect(t.chat.some((c) => c.playerId === 'system' && c.message === '系統: 7 刺殺 5')).toBe(true);
    expect(t.onGameEnded).toHaveBeenCalledTimes(1);
  });

  it('沒人下指令：在刺殺倒數結束前刺自己的第一人選', async () => {
    const t = serverWith(['p9'], 180_000);
    t.schedule();
    await vi.advanceTimersByTimeAsync(10);
    const view = botLines(t.chat).find((c) => c.playerId === 'p7' && c.message.startsWith('我覺得梅林是'))!;
    const pickSeat = Number(/^我覺得梅林是 (\d)家/.exec(view.message)![1]);
    await vi.advanceTimersByTimeAsync(180_000 - RED_TALK_SAFETY_MARGIN_MS - 2000);
    expect(t.engine.submitAssassination).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3000);
    expect(t.engine.submitAssassination).toHaveBeenCalledWith('p7', IDS[(pickSeat || 10) - 1]);
    expect(t.chat.some((c) => c.playerId === 'p7' && c.message.startsWith('沒有收到紅方隊友的 /刺殺 指令'))).toBe(true);
  });

  it('沒有倒數的房間：約 3 分鐘後刺', async () => {
    const t = serverWith(['p9'], null);
    t.schedule();
    await vi.advanceTimersByTimeAsync(RED_TALK_NO_TIMER_WAIT_MS - 2000);
    expect(t.engine.submitAssassination).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3000);
    expect(t.engine.submitAssassination).toHaveBeenCalledTimes(1);
  });

  it('真人是刺客：紅方機器人只說看法，不替他刺', async () => {
    const t = serverWith(['p7']);
    t.schedule();
    await vi.advanceTimersByTimeAsync(RED_TALK_NO_TIMER_WAIT_MS + 5000);
    expect(botLines(t.chat).map((c) => c.playerId)).toEqual(['p8', 'p9', 'p10']);
    expect(botLines(t.chat).every((c) => c.message.startsWith('我覺得梅林是'))).toBe(true);
    expect(t.engine.submitAssassination).not.toHaveBeenCalled();
  });

  it('RED_ASSASSIN_TALK=off：有真人紅方也照舊直接刺', async () => {
    vi.stubEnv('RED_ASSASSIN_TALK', 'off');
    try {
      const t = serverWith(['p8']);
      t.schedule();
      await vi.advanceTimersByTimeAsync(10);
      expect(t.engine.submitAssassination).toHaveBeenCalledTimes(1);
      expect(botLines(t.chat)).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
