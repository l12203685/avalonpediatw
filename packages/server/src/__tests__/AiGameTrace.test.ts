/**
 * 百科AI 對局紀錄（Edward 2026-11-05）：從一局虛構的遊玩頁對局組 trace、合併多個百科AI、DC 訊息拆段、文字格式。
 * 名字都是編的（測試玩家N、百科AI_21…）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HeuristicAgent } from '../ai/HeuristicAgent';
import {
  buildObservation, historyFromRecord, lobbyRolesOf, readKnowledge, type PlatformRecord, type SMyself, type SUser, type Snap,
} from '../../scripts/signageAdapter';
import {
  AiTraceHub, actionOf, buildAiGameTrace, campOfRoleName, draftDecision, type AiGameCollector, type DraftDecision, type EndCapture,
} from '../../scripts/signageAiTrace';
import {
  AI_GAME_FORMAT, AI_GAME_MAX_FOLLOWUPS, DISCORD_MESSAGE_MAX, aiGameFollowups, aiGameSummary, aiGameText, aiGameThreadName,
  decisionWhere, formatFlagReply, parseAiGameTrace, roundBlocks, splitMessages, type AiGameTrace,
} from '../services/aiGameTrace';

// 標準 10 人：1 梅林、2 刺客、3 派西維爾、4 雜魚1、5 莫甘娜、6 雜魚2、7 莫德雷德、8 雜魚3、9 雜魚4、10 奧伯倫
const STD = ['梅林', '刺客', '派西維爾', '雜魚1', '莫甘娜', '雜魚2', '莫德雷德', '雜魚3', '雜魚4', '奧伯倫'];
const LOBBY = lobbyRolesOf(STD)!;
const NAMES: Record<number, string> = { 2: '百科AI_22', 3: '百科AI_21' };
const nameOf = (set: number): string => NAMES[set] ?? `測試玩家${set}`;

function user(set: number, extra: Partial<SUser> = {}): SUser {
  return { id: `u${set}`, name: nameOf(set), master: set === 1, role: 'unknown', set, crown: false, tick: false,
    vote_bag: null, lake: null, is_robot: false, dead: false, ...extra };
}
function me(set: number, role: string, isGood: boolean): SMyself {
  return { id: `u${set}`, name: nameOf(set), master: false, role, is_good: isGood, set, vote_bag: null,
    can_dispatch_ticks: false, can_to_mission: false, can_vote: false, can_start_vote: false, can_lake_to: false,
    can_select_lake_result: false, can_assassin_to: false, can_verify: false };
}
/** 坐 `seat` 的百科AI 畫面：view＝看到的別人身分字串；crown＝隊長；ticks＝隊伍。 */
function snap(seat: number, view: Record<number, string>, extra: Partial<Snap> = {}, crown = 1, ticks: number[] = []): Snap {
  const role = STD[seat - 1];
  const users = Array.from({ length: 10 }, (_, i) => user(i + 1, {
    role: i + 1 === seat ? role : (view[i + 1] ?? 'unknown'), crown: i + 1 === crown, tick: ticks.includes(i + 1),
  }));
  return { gaming: true, status: '派票', myself: me(seat, role, !['刺客', '莫甘娜', '莫德雷德', '奧伯倫'].includes(role)), users,
    free_ticks: 0, missions: [], lake_result: [], game_roles: STD, enable_sword: false, ...extra };
}

const R1 = { ticks_set: [1, 3, 4], white_ball_set: [1, 3, 4, 6, 8, 9], captain_set: 1 };
const R2a = { ticks_set: [2, 3, 5, 6], white_ball_set: [2, 5, 7], captain_set: 2 };
const R2b = { ticks_set: [1, 3, 4, 6], white_ball_set: [1, 3, 4, 6, 8, 9, 10], captain_set: 3 };
const R3 = { ticks_set: [1, 3, 4, 6], white_ball_set: [1, 3, 4, 6, 8, 9], captain_set: 4 };
const RECORD: PlatformRecord = {
  round_1: { meetings: [R1], mission_history: { member: [1, 3, 4], result: [true, true, true] } },
  round_2: { meetings: [R2a, R2b], mission_history: { member: [1, 3, 4, 6], result: [true, true, true, true] } },
  round_3: { meetings: [R3], mission_history: { member: [1, 3, 4, 6], result: [true, true, true, true] } },
};
const PERCIVAL_VIEW = { 1: '梅莫', 5: '梅莫' };
const ASSASSIN_VIEW = { 5: 'bad', 7: 'bad' };
const agent = new HeuristicAgent('test');

/** 一個百科AI 的決定：照真的流程用畫面＋派票紀錄組觀察再寫理由。 */
function decide(seat: number, view: Record<number, string>, s: Snap, rec: PlatformRecord, phase: Parameters<typeof buildObservation>[4],
  input: Parameters<typeof draftDecision>[0], round: number, attempt: number, at: number, extra = {}): DraftDecision {
  const k = readKnowledge({ ...s, users: s.users.map((u) => (u.set === seat || view[u.set] ? u : { ...u, role: 'unknown' })) }, LOBBY);
  const obs = buildObservation(k, s, historyFromRecord(rec, s), [], phase, LOBBY, extra);
  return draftDecision(input, { obs, seat, nick: nameOf(seat), role: k.role, team: k.team, round, attempt, source: 'agent', agent, at });
}

function syntheticGame(): { decisions: DraftDecision[]; end: EndCapture } {
  const decisions: DraftDecision[] = [];
  // 第 1 局第 1 次：1 家派 1、3、4；3 家（派西）贊成、2 家（刺客）反對
  const s1 = snap(3, PERCIVAL_VIEW, {}, 1, [1, 3, 4]);
  decisions.push(decide(3, PERCIVAL_VIEW, s1, {}, 'team_vote', { kind: 'vote', vote: true, team: ['S1', 'S3', 'S4'] }, 1, 1, 1000));
  decisions.push(decide(2, ASSASSIN_VIEW, snap(2, ASSASSIN_VIEW, {}, 1, [1, 3, 4]), {}, 'team_vote', { kind: 'vote', vote: false, team: ['S1', 'S3', 'S4'] }, 1, 1, 1001));
  const rec1 = { round_1: { meetings: [R1] } } as PlatformRecord;
  decisions.push(decide(3, PERCIVAL_VIEW, snap(3, PERCIVAL_VIEW, {}, 1, [1, 3, 4]), rec1, 'quest_vote', { kind: 'mission', card: 'success' }, 1, 1, 1500));
  // 第 2 局第 2 次：3 家當隊長派 1、3、4、6
  const rec2 = { round_1: RECORD.round_1, round_2: { meetings: [R2a] } } as PlatformRecord;
  decisions.push(decide(3, PERCIVAL_VIEW, snap(3, PERCIVAL_VIEW, { missions: [true] }, 3), rec2, 'team_select', { kind: 'team', teamIds: ['S1', 'S3', 'S4', 'S6'] }, 2, 2, 2000));
  // 刺殺：2 家（刺客）刺 1 家
  const sEnd = snap(2, ASSASSIN_VIEW, { missions: [true, true, true], status: '刺殺' });
  decisions.push(decide(2, ASSASSIN_VIEW, sEnd, RECORD, 'assassination', { kind: 'assassinate', targetId: 'S1' }, 3, 0, 4000,
    { allEvilIds: ['S2', 'S5', 'S7', 'S10'], allEvilRoles: { S2: 'assassin', S5: 'morgana', S7: 'mordred', S10: 'oberon' } }));
  const end: EndCapture = {
    users: STD.map((role, i) => ({ set: i + 1, name: nameOf(i + 1), role, dead: i === 0 })),
    missions: [true, true, true],
    lake: [{ from: 10, to: 3, result: true }],
    record: RECORD,
    logs: ['刺客背刺 1家 梅林', '壞人獲勝'],
    endedAt: '2026-11-05T13:40:00.000Z',
  };
  return { decisions, end };
}

function syntheticTrace(): AiGameTrace {
  const { decisions, end } = syntheticGame();
  return buildAiGameTrace({
    room: 'Room-1460', title: '週四練習團', startedAt: '2026-11-05T13:05:00.000Z', end, decisions,
    ai: [
      { seat: 3, nick: '百科AI_21', roleName: '派西維爾', role: 'percival', team: 'good' },
      { seat: 2, nick: '百科AI_22', roleName: '刺客', role: 'assassin', team: 'evil' },
    ],
  });
}

describe('組 trace（虛構的一局）', () => {
  it('那一局的公開紀錄：座位角色、提議投票、任務、湖、刺殺、勝負', () => {
    const t = syntheticTrace();
    expect(t.format).toBe(AI_GAME_FORMAT);
    expect(t.seats).toHaveLength(10);
    expect(t.seats[0]).toEqual({ seat: 1, name: '測試玩家1', role: '梅林', team: 'good', ai: false });
    expect(t.seats.filter((s) => s.ai).map((s) => [s.seat, s.name, s.team])).toEqual([[2, '百科AI_22', 'evil'], [3, '百科AI_21', 'good']]);
    expect(t.proposals.map((p) => [p.round, p.attempt, p.leader, p.approved])).toEqual([[1, 1, 1, true], [2, 1, 2, false], [2, 2, 3, true], [3, 1, 4, true]]);
    expect(t.proposals[1].reject).toEqual([1, 3, 4, 6, 8, 9, 10]);
    expect(t.missions.map((m) => [m.round, m.result, m.fails])).toEqual([[1, 'success', 0], [2, 'success', 0], [3, 'success', 0]]);
    expect(t.lakes).toEqual([{ round: 2, holder: 10, target: 3, claim: 'good' }]);
    expect(t.assassination).toEqual({ target: 1, hit: true });
    expect(t.winner).toBe('evil');
  });

  it('百科AI 的決定：依時間編號、第幾局第幾次、動作與理由（同練習模式的說明）', () => {
    const t = syntheticTrace();
    expect(t.decisions.map((d) => [d.id, d.seat, d.kind, d.round, d.attempt, d.action])).toEqual([
      [1, 3, 'vote', 1, 1, '贊成'],
      [2, 2, 'vote', 1, 1, '反對'],
      [3, 3, 'mission', 1, 1, '出成功'],
      [4, 3, 'team', 2, 2, '派隊 1、3、4、6家'],
      [5, 2, 'assassinate', 3, 0, '刺殺 1家'],
    ]);
    for (const d of t.decisions) {
      expect(d.reason.length).toBeGreaterThan(5);
      expect(d.reason).not.toMatch(/理由產生失敗|沒有可用的觀察/);
      expect(d.source).toBe('agent');
    }
    expect(t.decisions[0].reason).toMatch(/^贊成：/);
    expect(t.decisions[0].knowledge).toMatch(/派西維爾：看到 1、5家/);
    expect(t.decisions[2].rule).toBe('好人只能出成功');
    expect(t.decisions[4].reason).toMatch(/^刺 1家/);
  });

  it('湖與宣告的動作文字；預設動作註明；觀察組不出來也不丟錯', () => {
    expect(actionOf({ kind: 'lake', targetId: 'S10', eligible: [] }).action).toBe('湖 0家');
    expect(actionOf({ kind: 'declare', targetId: 'S4', claim: 'evil', actual: 'good' })).toEqual({
      action: '宣告 4家 是壞人', detail: { target: 4, claim: 'evil', actual: 'good' },
    });
    expect(actionOf({ kind: 'declare', targetId: 'S4', claim: null }).action).toBe('不公開 4家 的湖中結果');
    const d = draftDecision({ kind: 'vote', vote: true, team: ['S1'] }, { obs: null, seat: 3, nick: '百科AI_21', role: 'percival', team: 'good', round: 1, attempt: 1, source: 'fallback' });
    expect(d.reason).toMatch(/預設動作/);
    expect(d.source).toBe('fallback');
  });

  it('派票紀錄抓不到時用房間頁的平面紀錄', () => {
    const { decisions, end } = syntheticGame();
    const flat: EndCapture = {
      ...end, record: null,
      meetings: [R1, R2a, R2b, R3],
      missionHistorys: [
        { member: [1, 3, 4], result: [true, true, true], crown_set: 1 },
        { member: [1, 3, 4, 6], result: [true, true, true, true], crown_set: 3 },
        { member: [1, 3, 4, 6], result: [true, true, true, true], crown_set: 4 },
      ],
    };
    const t = buildAiGameTrace({ room: 'Room-1460', title: '', startedAt: '2026-11-05T13:05:00.000Z', end: flat, decisions, ai: [] });
    expect(t.proposals.map((p) => [p.round, p.attempt])).toEqual([[1, 1], [2, 1], [2, 2], [3, 1]]);
    expect(t.missions).toHaveLength(3);
  });

  it('角色名 → 陣營；沒公開的不猜', () => {
    expect(campOfRoleName('莫德雷德')).toBe('evil');
    expect(campOfRoleName('雜魚3')).toBe('good');
    expect(campOfRoleName('unknown')).toBeNull();
    expect(campOfRoleName('bad')).toBeNull();
  });
});

describe('多個百科AI 合成一份', () => {
  afterEach(() => { vi.useRealTimers(); });

  const draft = (seat: number, at: number): DraftDecision => ({
    at, round: 1, attempt: 1, kind: 'vote', seat, nick: `百科AI_${seat}`, role: 'loyal', team: 'good', action: '贊成', detail: { vote: true }, reason: '測試', source: 'agent',
  });

  it('同房同一局：兩個座位都報完才送出一次；決定依時間合併；下一局開新的', async () => {
    const sent: AiGameCollector[] = [];
    const hub = new AiTraceHub(async (c) => { sent.push(c); });
    const a = hub.join('Room-1460', 'Room-1460#1');
    const b = hub.join('Room-1460', 'Room-1460#2');
    expect(b).toBe(a);
    a.add(draft(4, 30)); b.add(draft(7, 10)); a.add(draft(4, 20));
    const { end } = syntheticGame();
    a.finish('Room-1460#1', 'ended', end);
    expect(sent).toHaveLength(0);
    // 第 1 個百科AI 已經開下一局：開新的收集器，不混進上一局
    const next = hub.join('Room-1460', 'Room-1460#1');
    expect(next).not.toBe(a);
    b.finish('Room-1460#2', 'ended', end);
    expect(sent).toEqual([a]);
    // 程式結束前 drain：還沒報完的那局（下一局）也送出，但沒打完不組 trace
    await hub.drain(1000);
    expect(sent).toEqual([a, next]);
    expect(next.build('')).toBeNull();
    const t = a.build('週四練習團')!;
    expect(t.decisions.map((d) => [d.id, d.seat, d.at])).toEqual([[1, 7, 10], [2, 4, 20], [3, 4, 30]]);
    expect(t.title).toBe('週四練習團');
  });

  it('沒有打到遊戲結束（角色沒公開）就不組；有座位一直沒報完，寬限時間到也送出', async () => {
    vi.useFakeTimers();
    const sent: AiGameCollector[] = [];
    const hub = new AiTraceHub(async (c) => { sent.push(c); }, 1000);
    const a = hub.join('R', 'R#1');
    hub.join('R', 'R#2');
    a.finish('R#1', 'stalled', null);
    expect(sent).toHaveLength(0);
    vi.advanceTimersByTime(1001);
    expect(sent).toEqual([a]);
    expect(a.build('')).toBeNull();
  });
});

describe('DC 訊息與文字', () => {
  it('討論串標題：百科AI對局 yyyymmdd_HHMM 房間描述／房號（台灣時間）', () => {
    expect(aiGameThreadName(syntheticTrace())).toBe('百科AI對局 20261105_2105 週四練習團／Room-1460');
    expect(aiGameThreadName({ startedAt: '2026-11-05T13:05:00.000Z', endedAt: '', room: 'Room-9', title: '' })).toBe('百科AI對局 20261105_2105 Room-9');
    expect([...aiGameThreadName({ startedAt: '', endedAt: '', room: 'R', title: '長'.repeat(200) })].length).toBeLessThanOrEqual(100);
  });

  it('起始訊息：摘要＋回饋方式（2000 字內）', () => {
    const s = aiGameSummary(syntheticTrace());
    expect(s.length).toBeLessThanOrEqual(2000);
    expect(s).toContain('結果：紅方勝（任務 藍 3：紅 0，刺客刺 1家 刺中梅林）');
    expect(s).toContain('百科AI：2家 刺客（百科AI_22）、3家 派西維爾（百科AI_21）');
    expect(s).toContain('配置：刺 2、娜 5、德 7、奧 0、派 3、梅 1');
    expect(s).toMatch(/第幾局第幾次＋哪一家＋哪個動作＋為什麼怪/);
    expect(s).toContain('trace.json');
  });

  it('依局分組：公開紀錄穿插百科AI 的決定；最後一則附網站網址', () => {
    const t = syntheticTrace();
    const blocks = roundBlocks(t);
    expect(blocks.map((b) => b.split('\n')[0])).toEqual(['**第 1 局**', '**第 2 局**', '**第 3 局**', '**刺殺**']);
    expect(blocks[0]).toContain('第 1 次提議：隊長 1家 → 1、3、4家\u3000贊成 1、3、4、6、8、9家／反對 2、5、7、0家 → 通過');
    expect(blocks[0]).toContain('#1 3家 派西維爾 百科AI_21・投票：贊成');
    expect(blocks[1]).toContain('湖：0家 湖 3家，宣告好人');
    const msgs = aiGameFollowups(t, 'https://avalonpediatw.com/#ai-games=123');
    expect(msgs.every((m) => m.length <= DISCORD_MESSAGE_MAX)).toBe(true);
    expect(msgs[msgs.length - 1]).toContain('#ai-games=123');
    expect(decisionWhere(t.decisions[3])).toBe('第 2 局第 2 次');
  });

  it('trace.txt 含嫌疑與夜晚資訊；trace.json 讀得回來', () => {
    const t = syntheticTrace();
    const txt = aiGameText(t);
    expect(txt).toContain('夜晚資訊：派西維爾');
    expect(txt).not.toContain('**');
    expect(parseAiGameTrace(JSON.parse(JSON.stringify(t)))).toEqual(t);
    expect(parseAiGameTrace({ ...t, format: 'x' })).toBeNull();
    expect(parseAiGameTrace({ ...t, decisions: [{ id: 1 }] })).toBeNull();
  });

  it('拆訊息：段落盡量不拆、太長照行拆、一行太長硬切；內容不漏', () => {
    const blocks = ['a'.repeat(50), 'b'.repeat(50), `${'c'.repeat(80)}\n${'d'.repeat(80)}`, 'e'.repeat(250)];
    const msgs = splitMessages(blocks, 100);
    expect(msgs.every((m) => m.length <= 100)).toBe(true);
    expect(msgs[0]).toBe(`${'a'.repeat(50)}`);
    expect(msgs.join('').replace(/\n/g, '')).toBe(blocks.join('').replace(/\n/g, ''));
    expect(splitMessages([])).toEqual([]);
    // 很多段：每則都在上限內
    const many = Array.from({ length: 40 }, (_, i) => `第 ${i} 段 ${'字'.repeat(300)}`);
    expect(splitMessages(many).every((m) => m.length <= DISCORD_MESSAGE_MAX)).toBe(true);
  });

  it('後續訊息只有對局紀錄；太多時截斷，提示看網站', () => {
    const t = syntheticTrace();
    expect(aiGameFollowups(t).join('\n')).not.toMatch(/理由：/);
    const p0 = t.proposals[0];
    const long = { ...t, proposals: Array.from({ length: 2000 }, (_, i) => ({ ...p0, round: i + 1, attempt: 1 })) };
    const msgs = aiGameFollowups(long);
    expect(msgs).toHaveLength(AI_GAME_MAX_FOLLOWUPS);
    expect(msgs[msgs.length - 1]).toMatch(/請看網站/);
  });

  it('網站回饋的回覆格式：第幾局第幾次、哪一家、哪個決定、原因、暱稱', () => {
    const d = syntheticTrace().decisions[1];
    const reply = formatFlagReply(d, '隊上沒有紅\n為什麼反對', '小_明');
    expect(reply).toContain('**【網站回饋】這步怪怪的** — 小\\_明');
    expect(reply).toContain('第 1 局第 1 次・2家 刺客 百科AI_22・投票：反對（決定 #2）');
    expect(reply).toContain('> 隊上沒有紅\n> 為什麼反對');
    expect(formatFlagReply(d, '', '')).toContain('— 匿名');
  });
});
