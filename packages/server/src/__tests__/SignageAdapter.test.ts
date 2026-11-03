import { describe, expect, it } from 'vitest';
import {
  NO_BOT_RE, buildObservation, lobbyRolesLoose, evilRolesAtAssassination, historyFromRecord, lakeHistoryFromSnap, lobbyCandidate,
  lobbyRolesOf, missionCard, myLakeFromSnap, nextTeamAction, pendingDecision, pendingLakeDeclaration, readKnowledge,
  roleOf, seatsCandidate, shortRooms, unsupportedReason, validLakeTargets,
  type SMyself, type SUser, type Snap,
} from '../../scripts/signageAdapter';

const STD = ['梅林', '刺客', '派西維爾', '雜魚1', '莫甘娜', '雜魚2', '莫德雷德', '雜魚3', '雜魚4', '奧伯倫'];
const LOBBY = lobbyRolesOf(STD)!;

function user(set: number, extra: Partial<SUser> = {}): SUser {
  return { id: `u${set}`, name: `玩家${set}`, master: set === 1, role: 'unknown', set, crown: false, tick: false,
    vote_bag: null, lake: null, is_robot: false, dead: false, ...extra };
}
function me(set: number, role: string, isGood: boolean, extra: Partial<SMyself> = {}): SMyself {
  return { id: `u${set}`, name: `玩家${set}`, master: false, role, is_good: isGood, set, vote_bag: null,
    can_dispatch_ticks: false, can_to_mission: false, can_vote: false, can_start_vote: false, can_lake_to: false,
    can_select_lake_result: false, can_assassin_to: false, can_verify: false, ...extra };
}
/** 我坐 `seat`、角色 `role`；`view` 是我畫面上看到的別人身分字串。 */
function snap(seat: number, role: string, isGood: boolean, view: Record<number, string> = {}, extra: Partial<Snap> = {}, my: Partial<SMyself> = {}): Snap {
  const users = Array.from({ length: 10 }, (_, i) => user(i + 1, { role: i + 1 === seat ? role : (view[i + 1] ?? 'unknown') }));
  return { gaming: true, status: '派票', myself: me(seat, role, isGood, my), users, free_ticks: 0, missions: [], lake_result: [],
    game_roles: STD, enable_sword: false, ...extra };
}

describe('角色與房間設定', () => {
  it('練習台角色名對應', () => {
    expect(roleOf('梅林')).toBe('merlin');
    expect(roleOf('雜魚3')).toBe('loyal');
    expect(roleOf('爪牙1')).toBe('minion');
    expect(roleOf('正蘭斯')).toBeNull();
  });
  it('標準 10 人設定可以打；蘭斯洛特、不是 10 人、王者之劍不行', () => {
    expect(LOBBY.filter((r) => r === 'loyal')).toHaveLength(4);
    expect(unsupportedReason({ game_roles: STD, enable_sword: false })).toBeNull();
    expect(unsupportedReason({ game_roles: [...STD.slice(0, 9), '邪蘭斯'], enable_sword: false })).toMatch(/不支援/);
    expect(unsupportedReason({ game_roles: STD.slice(0, 8), enable_sword: false })).toMatch(/8 人/);
    expect(unsupportedReason({ game_roles: STD, enable_sword: true })).toMatch(/王者之劍/);
  });
});

describe('夜晚資訊（依角色）', () => {
  it('梅林：看到的紅方（莫德雷德除外，3 人）→ knownEvils', () => {
    const k = readKnowledge(snap(5, '梅林', true, { 2: 'bad', 7: 'bad', 9: 'bad' }), LOBBY);
    expect(k).toMatchObject({ me: 'S5', role: 'merlin', team: 'good', knownEvils: ['S2', 'S7', 'S9'], knownWizards: undefined, mismatch: null });
  });
  it('派西維爾：大拇指（梅林＋莫甘娜）→ knownWizards，不算紅', () => {
    const k = readKnowledge(snap(3, '派西維爾', true, { 4: '梅莫', 8: '梅莫' }), LOBBY);
    expect(k.knownWizards).toEqual(['S4', 'S8']);
    expect(k.knownEvils).toEqual([]);
    expect(k.mismatch).toBeNull();
  });
  it('刺客／莫甘娜／莫德雷德：看到隊友（奧伯倫除外，2 人）', () => {
    for (const r of ['刺客', '莫甘娜', '莫德雷德']) {
      const k = readKnowledge(snap(1, r, false, { 6: 'bad', 10: 'bad' }), LOBBY);
      expect(k.team).toBe('evil');
      expect(k.knownEvils).toEqual(['S6', 'S10']);
      expect(k.mismatch).toBeNull();
    }
  });
  it('奧伯倫、忠臣：什麼都不知道', () => {
    expect(readKnowledge(snap(4, '奧伯倫', false), LOBBY)).toMatchObject({ role: 'oberon', knownEvils: [], mismatch: null });
    expect(readKnowledge(snap(4, '雜魚2', true), LOBBY)).toMatchObject({ role: 'loyal', team: 'good', knownEvils: [], mismatch: null });
  });
  it('看到的人數和規則不符時記下來（仍以畫面為準）', () => {
    const k = readKnowledge(snap(5, '梅林', true, { 2: 'bad' }), LOBBY);
    expect(k.knownEvils).toEqual(['S2']);
    expect(k.mismatch).toMatch(/看到 1 人，規則應為 3 人/);
  });
  it('不支援的角色不丟錯：照陣營當忠臣／爪牙，不用夜晚資訊', () => {
    expect(readKnowledge(snap(5, '正蘭斯', true, { 2: 'bad' }), LOBBY)).toMatchObject({ role: 'loyal', team: 'good', knownEvils: [], mismatch: null });
    expect(readKnowledge(snap(5, '邪蘭斯', false, { 2: 'bad' }), LOBBY)).toMatchObject({ role: 'minion', team: 'evil', knownEvils: [] });
    expect(lobbyRolesLoose([...STD.slice(0, 8), '正蘭斯', '邪蘭斯'], 10).slice(8)).toEqual(['loyal', 'minion']);
    expect(lobbyRolesLoose(['梅林'], 10)).toHaveLength(10);
  });
  it('不是 10 人的桌（指定房間）：座位、投票過半、可湖的人都照實際人數', () => {
    const s = snap(1, '雜魚1', true, {}, { status: '派票', missions: [], game_roles: STD.slice(0, 7) });
    s.users = s.users.slice(0, 7);
    s.users[1].crown = true;
    const h = historyFromRecord({ round_1: { meetings: [{ ticks_set: [1, 2], white_ball_set: [1, 2, 3, 4], captain_set: 1 }] } }, s);
    expect(h.votes[0].approved).toBe(true); // 7 人 4 白過半
    expect(Object.keys(h.votes[0].votes)).toHaveLength(7);
    expect(unsupportedReason(s, 7)).toBeNull();
    const o = buildObservation(readKnowledge(s, lobbyRolesOf(s.game_roles)), s, h, [], 'team_select', lobbyRolesOf(s.game_roles)!);
    expect(o.playerCount).toBe(7);
    expect(o.allPlayerIds).toEqual(['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7']);
  });
});

describe('公開紀錄', () => {
  const rec = {
    set_counts: 10,
    round_1: {
      meetings: [
        { ticks_set: [1, 2, 3], white_ball_set: [1, 2], captain_set: 1 },
        { ticks_set: [2, 4, 5], white_ball_set: [1, 2, 4, 5, 6, 7], captain_set: 2 },
      ],
      mission_history: { member: [2, 4, 5], result: [true, false, true] },
    },
    round_2: { meetings: [{ ticks_set: [3, 4, 6, 7], white_ball_set: [], captain_set: 3 }], mission_history: null },
  };
  it('提議、投票、任務；進行中的提議（目前隊長、還沒投票）不算', () => {
    const s = snap(9, '雜魚1', true, {}, { status: '投票', missions: [false] });
    s.users[2].crown = true; // 3 家是隊長
    const h = historyFromRecord(rec, s);
    expect(h.votes).toHaveLength(2);
    expect(h.votes[0]).toMatchObject({ round: 1, attempt: 1, leader: 'S1', team: ['S1', 'S2', 'S3'], approved: false });
    expect(h.votes[0].votes.S1).toBe(true);
    expect(h.votes[0].votes.S3).toBe(false);
    expect(h.votes[1].approved).toBe(true);
    expect(h.quests).toEqual([{ round: 1, team: ['S2', 'S4', 'S5'], result: 'fail', failCount: 1 }]);
  });
  it('全黑（0 白）而且隊長已換人的提議照算（被否決）', () => {
    const s = snap(9, '雜魚1', true, {}, { status: '派票', missions: [false] });
    s.users[3].crown = true; // 隊長已換到 4 家
    const h = historyFromRecord(rec, s);
    expect(h.votes).toHaveLength(3);
    expect(h.votes[2]).toMatchObject({ round: 2, approved: false });
  });
  it('第 5 次提議（強制局）記成通過', () => {
    const meetings = [1, 2, 3, 4, 5].map((c) => ({ ticks_set: [c, c + 1, c + 2], white_ball_set: c === 5 ? [] : [c], captain_set: c }));
    const s = snap(9, '雜魚1', true, {}, { status: '任務中' });
    s.users[4].crown = true;
    const h = historyFromRecord({ round_1: { meetings } }, s);
    expect(h.votes.map((v) => v.approved)).toEqual([false, false, false, false, true]);
  });
  it('湖：已宣告的照宣告；沒宣告且已過那一輪記 none；還在等宣告的不放', () => {
    const lake = [{ from: 10, to: 3, result: true }, { from: 3, to: 6, result: null }];
    expect(lakeHistoryFromSnap(snap(1, '雜魚1', true, {}, { missions: [true, false, true], lake_result: lake })))
      .toEqual([{ round: 2, holderId: 'S10', targetId: 'S3', declaredClaim: 'good' }]);
    expect(lakeHistoryFromSnap(snap(1, '雜魚1', true, {}, { missions: [true, false, true, true], lake_result: lake }))[1])
      .toEqual({ round: 3, holderId: 'S3', targetId: 'S6', declaredClaim: 'none' });
  });
  it('自己湖到的結果（對方在自己畫面翻成 good／bad）、可湖的人、待宣告', () => {
    const s = snap(10, '雜魚1', true, { 3: 'bad' }, { missions: [true, false], lake_result: [{ from: 10, to: 3, result: null }] },
      { can_select_lake_result: true });
    expect(myLakeFromSnap(s)).toEqual([{ round: 2, targetId: 'S3', result: 'evil' }]);
    expect(pendingLakeDeclaration(s)).toBe(0);
    expect(pendingDecision(s)).toBe('lakeDeclare');
    const t = snap(3, '雜魚1', true, {}, { lake_result: [{ from: 10, to: 3, result: true }] }, { can_lake_to: true });
    expect(validLakeTargets(t)).toEqual(['S1', 'S2', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9']);
  });
  it('刺殺階段：紅方開牌的角色', () => {
    const s = snap(2, '刺客', false, { 5: '莫甘娜', 7: '莫德雷德', 9: '奧伯倫' });
    expect(evilRolesAtAssassination(s, { me: 'S2', role: 'assassin' }))
      .toEqual({ S2: 'assassin', S5: 'morgana', S7: 'mordred', S9: 'oberon' });
  });
  it('觀測：回合、隊長、本輪否決次數、紅方人數', () => {
    const s = snap(9, '梅林', true, { 1: 'bad', 2: 'bad', 5: 'bad' }, { status: '派票', missions: [false] });
    s.users[3].crown = true;
    const k = readKnowledge(s, LOBBY);
    const o = buildObservation(k, s, historyFromRecord(rec, s), [], 'team_select', LOBBY);
    expect(o).toMatchObject({ myPlayerId: 'S9', myRole: 'merlin', currentRound: 2, currentLeader: 'S4', failCount: 1, evilCount: 4,
      questResults: ['fail'], knownEvils: ['S1', 'S2', 'S5'] });
  });
});

describe('動作對應', () => {
  it('現在要做的決定', () => {
    expect(pendingDecision(snap(1, '雜魚1', true, {}, {}, { can_dispatch_ticks: true }))).toBe('team');
    expect(pendingDecision(snap(1, '雜魚1', true, {}, {}, { can_vote: true }))).toBe('vote');
    expect(pendingDecision(snap(1, '雜魚1', true, {}, {}, { can_vote: true, vote_bag: true }))).toBeNull();
    expect(pendingDecision(snap(1, '雜魚1', true, {}, {}, { can_to_mission: true }))).toBe('mission');
    expect(pendingDecision(snap(1, '雜魚1', true, {}, {}, { can_lake_to: true }))).toBe('lakeTarget');
    expect(pendingDecision(snap(1, '刺客', false, {}, {}, { can_assassin_to: true }))).toBe('assassinate');
    expect(pendingDecision(snap(1, '雜魚1', true, {}, {}, { can_verify: true }))).toBe('verify');
    expect(pendingDecision(snap(1, '雜魚1', true, {}, { status: '遊戲結束' }, { can_vote: true }))).toBeNull();
  });
  it('派隊：先收掉不要的兵牌、再補要的人，齊了按開始投票', () => {
    const s = snap(1, '雜魚1', true, {}, { free_ticks: 2 }, { can_dispatch_ticks: true });
    s.users[6].tick = true; // 7 家已派但不要
    expect(nextTeamAction(s, [1, 2, 3])).toEqual({ kind: 'touch', set: 7 });
    s.users[6].tick = false; s.free_ticks = 3;
    expect(nextTeamAction(s, [1, 2, 3])).toEqual({ kind: 'touch', set: 1 });
    for (const i of [0, 1, 2]) s.users[i].tick = true;
    s.free_ticks = 0; s.myself.can_start_vote = true;
    expect(nextTeamAction(s, [1, 2, 3])).toEqual({ kind: 'startVote' });
  });
  it('任務牌：藍方一律成功；紅方照 AI', () => {
    expect(missionCard('good', 'fail')).toBe(true);
    expect(missionCard('evil', 'fail')).toBe(false);
    expect(missionCard('evil', 'success')).toBe(true);
  });
});

describe('補位規則', () => {
  it('大廳條件：野團、等待中、9 人、標題沒說不要機器人', () => {
    const r = { name: 'Room-1', description_title: '歡迎大家來玩', is_publish_room: true, length: 9, gaming: false };
    expect(lobbyCandidate(r)).toBe(true);
    expect(lobbyCandidate({ ...r, is_publish_room: false })).toBe(false);
    expect(lobbyCandidate({ ...r, length: 10 })).toBe(false);
    expect(lobbyCandidate({ ...r, length: 8 })).toBe(false);
    expect(lobbyCandidate({ ...r, gaming: true })).toBe(false);
    for (const t of ['不要機器人', '禁止機器人喔', 'No bots please', '拒絕 機器人']) expect(lobbyCandidate({ ...r, description_title: t })).toBe(false);
    expect(NO_BOT_RE.test('機器人歡迎')).toBe(false);
  });
  it('座位：9 個真人、沒有內建機器人、沒有百科機器人', () => {
    const nine = Array.from({ length: 9 }, (_, i) => ({ name: `玩家${i}`, is_robot: false }));
    expect(seatsCandidate(nine, false)).toBe(true);
    expect(seatsCandidate(nine, true)).toBe(false);
    expect(seatsCandidate([...nine.slice(1), { name: '強化人1號', is_robot: true }], false)).toBe(false);
    expect(seatsCandidate([...nine.slice(1), { name: '百科機器人（測試）', is_robot: false }], false)).toBe(false);
  });
  it('缺人計時：連續符合才累計，中斷就重算', () => {
    const seen = new Map<string, number>();
    expect(shortRooms(seen, ['A', 'B'], 0, 180_000)).toEqual([]);
    expect(shortRooms(seen, ['A'], 120_000, 180_000)).toEqual([]);
    expect(shortRooms(seen, ['A', 'B'], 180_000, 180_000)).toEqual(['A']); // B 中斷過，從 180s 重新計
    expect(shortRooms(seen, ['A', 'B'], 360_000, 180_000)).toEqual(['A', 'B']);
  });
});

describe('中途重連時的夜晚資訊', () => {
  it('湖翻開的 good 不會被梅林當成紅；忠臣不看湖結果', () => {
    const k = readKnowledge(snap(5, '梅林', true, { 2: 'bad', 7: 'bad', 9: 'bad', 4: 'good' }), LOBBY);
    expect(k.knownEvils).toEqual(['S2', 'S7', 'S9']);
    expect(k.mismatch).toBeNull();
    expect(readKnowledge(snap(5, '雜魚1', true, { 4: 'bad' }), LOBBY)).toMatchObject({ knownEvils: [], mismatch: null });
  });
  it('派西維爾只取大拇指', () => {
    expect(readKnowledge(snap(3, '派西維爾', true, { 4: '梅莫', 8: '梅莫', 6: 'bad' }), LOBBY).knownWizards).toEqual(['S4', 'S8']);
  });
});
