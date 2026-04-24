import { describe, expect, it } from 'vitest';
import {
  parseSheetsGameCell,
  __internal,
} from '../services/sheetsGameRecordParser';

const {
  charToSeat,
  parseSeatToken,
  parseAnomalyToken,
  parseProposalLine,
  parseLadyLine,
  parseQuestLine,
  parseRoleCode,
  buildVotes,
  deriveWinner,
  isQuestLine,
  isLadyLine,
} = __internal;

// ---------------------------------------------------------------------------
// 低階解析單元測
// ---------------------------------------------------------------------------

describe('sheetsGameRecordParser — low-level helpers', () => {
  it('charToSeat maps digits 1-9 + 0 correctly', () => {
    expect(charToSeat('1')).toBe(1);
    expect(charToSeat('9')).toBe(9);
    expect(charToSeat('0')).toBe(10);
  });

  it('parseSeatToken splits each char as a seat', () => {
    expect(parseSeatToken('138')).toEqual([1, 3, 8]);
    expect(parseSeatToken('2458')).toEqual([2, 4, 5, 8]);
    expect(parseSeatToken('0')).toEqual([10]);
    expect(parseSeatToken('12568')).toEqual([1, 2, 5, 6, 8]);
  });

  it('parseAnomalyToken handles single and multi-seat plus/minus', () => {
    expect(parseAnomalyToken('6+')).toEqual([{ seat: 6, kind: 'plus' }]);
    expect(parseAnomalyToken('0-')).toEqual([{ seat: 10, kind: 'minus' }]);
    expect(parseAnomalyToken('70+')).toEqual([
      { seat: 7, kind: 'plus' },
      { seat: 10, kind: 'plus' },
    ]);
    expect(parseAnomalyToken('17-')).toEqual([
      { seat: 1, kind: 'minus' },
      { seat: 7, kind: 'minus' },
    ]);
    expect(parseAnomalyToken('390+')).toEqual([
      { seat: 3, kind: 'plus' },
      { seat: 9, kind: 'plus' },
      { seat: 10, kind: 'plus' },
    ]);
  });

  it('parseProposalLine extracts team + anomalies', () => {
    expect(parseProposalLine('138')).toEqual({
      teamSeats: [1, 3, 8],
      anomalies: [],
    });
    expect(parseProposalLine('2458 6+')).toEqual({
      teamSeats: [2, 4, 5, 8],
      anomalies: [{ seat: 6, kind: 'plus' }],
    });
    expect(parseProposalLine('2580 0- 7+')).toEqual({
      teamSeats: [2, 5, 8, 10],
      anomalies: [
        { seat: 10, kind: 'minus' },
        { seat: 7, kind: 'plus' },
      ],
    });
    expect(parseProposalLine('14678 17- 0+')).toEqual({
      teamSeats: [1, 4, 6, 7, 8],
      anomalies: [
        { seat: 1, kind: 'minus' },
        { seat: 7, kind: 'minus' },
        { seat: 10, kind: 'plus' },
      ],
    });
  });

  it('parseLadyLine extracts holder/target/declaration', () => {
    expect(parseLadyLine('0>1 o', 2)).toEqual({
      round: 2,
      holderSeat: 10,
      targetSeat: 1,
      declaration: 'good',
    });
    expect(parseLadyLine('8>6 o', 4)).toEqual({
      round: 4,
      holderSeat: 8,
      targetSeat: 6,
      declaration: 'good',
    });
  });

  it('parseQuestLine counts o/x', () => {
    expect(parseQuestLine('ooo', 1, 8)).toEqual({
      successCount: 3,
      failCount: 0,
      success: true,
    });
    expect(parseQuestLine('ooxx', 2, 8)).toEqual({
      successCount: 2,
      failCount: 2,
      success: false,
    });
    expect(parseQuestLine('ooox', 3, 8)).toEqual({
      successCount: 3,
      failCount: 1,
      success: false,
    });
    expect(parseQuestLine('ooooo', 4, 8)).toEqual({
      successCount: 5,
      failCount: 0,
      success: true,
    });
    expect(parseQuestLine('oooox', 5, 8)).toEqual({
      successCount: 4,
      failCount: 1,
      success: false,
    });
  });

  it('parseQuestLine: 7+ player round 4 needs 2 fails to fail', () => {
    // 8 人第 4 回合 1 fail 仍算成功
    expect(parseQuestLine('ooox', 4, 8).success).toBe(true);
    expect(parseQuestLine('ooxx', 4, 8).success).toBe(false);
    // 8 人第 3 回合 1 fail 就失敗
    expect(parseQuestLine('ooox', 3, 8).success).toBe(false);
  });

  it('parseRoleCode extracts roles in 刺娜德奧派梅 order', () => {
    // Edward 2139 場：701498
    // 刺 7 / 娜 0(10) / 德 1 / 奧 4 / 派 9 / 梅 8
    expect(parseRoleCode('701498')).toEqual({
      assassin: 7,
      morgana: 10,
      mordred: 1,
      oberon: 4,
      percival: 9,
      merlin: 8,
    });
  });

  it('buildVotes normal case — no anomalies', () => {
    // 8 人局，隊伍 [1,3,8]，無異常票
    const { votes, approveCount, rejectCount } = buildVotes([1, 3, 8], [], 8);
    expect(votes).toEqual([
      'approve', // seat 1 in team
      'reject',  // seat 2 not in team
      'approve', // seat 3 in team
      'reject',  // seat 4
      'reject',  // seat 5
      'reject',  // seat 6
      'reject',  // seat 7
      'approve', // seat 8 in team
    ]);
    expect(approveCount).toBe(3);
    expect(rejectCount).toBe(5);
  });

  it('buildVotes with场外白 (+)', () => {
    // 隊 [2,4,5,8]，座 6 場外白（未在隊伍但 approve）
    const { votes, approveCount, rejectCount } = buildVotes(
      [2, 4, 5, 8],
      [{ seat: 6, kind: 'plus' }],
      8,
    );
    expect(votes[5]).toBe('approve'); // seat 6 overriden
    expect(approveCount).toBe(5); // 2,4,5,8 + 6
    expect(rejectCount).toBe(3);  // 1,3,7
  });

  it('buildVotes with 場內黑 (-) — 10 人局', () => {
    // 隊 [2,5,8,10]，座 10 場內黑，座 7 場外白
    const { votes, approveCount, rejectCount } = buildVotes(
      [2, 5, 8, 10],
      [
        { seat: 10, kind: 'minus' },
        { seat: 7, kind: 'plus' },
      ],
      10,
    );
    expect(votes[1]).toBe('approve'); // seat 2 in team
    expect(votes[4]).toBe('approve'); // seat 5 in team
    expect(votes[7]).toBe('approve'); // seat 8 in team
    expect(votes[6]).toBe('approve'); // seat 7 場外白
    expect(votes[9]).toBe('reject');  // seat 10 場內黑（覆寫 approve → reject）
    expect(votes).toHaveLength(10);
    expect(approveCount).toBe(4); // 2,5,7,8
    expect(rejectCount).toBe(6);  // 1,3,4,6,9,10
  });

  it('deriveWinner: 3 red = evil threeRed', () => {
    expect(deriveWinner(['blue', 'red', 'red', 'blue', 'red'])).toEqual({
      winnerCamp: 'evil',
      winReason: 'threeRed',
    });
  });

  it('deriveWinner: 3 blue = good threeBlue (刺殺細節 Phase 2c 才補)', () => {
    expect(deriveWinner(['blue', 'blue', 'red', 'blue'])).toEqual({
      winnerCamp: 'good',
      winReason: 'threeBlue_merlinAlive',
    });
  });

  it('isQuestLine matches only o/x sequences', () => {
    expect(isQuestLine('ooo')).toBe(true);
    expect(isQuestLine('ooxx')).toBe(true);
    expect(isQuestLine('oooox')).toBe(true);
    expect(isQuestLine('138')).toBe(false);
    expect(isQuestLine('0>1 o')).toBe(false);
  });

  it('isLadyLine matches X>Y o/x', () => {
    expect(isLadyLine('0>1 o')).toBe(true);
    expect(isLadyLine('8>6 o')).toBe(true);
    expect(isLadyLine('1>8 x')).toBe(true);
    expect(isLadyLine('138')).toBe(false);
    expect(isLadyLine('ooo')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Edward 第 2139 場 fixture
// ---------------------------------------------------------------------------

const FIXTURE_2139_TEXT = `138
267
370
248
258
ooo
2458 6+
2580 0- 7+
1258
2589
3490
ooxx
0>1 o
1458 0+
2458 70+
ooox
1>8 o
12358 1- 0+
14678 17- 0+
12568 390+
ooooo
8>6 o
1256 1- 370+
oooox`;

describe('parseSheetsGameCell — Edward 第 2139 場 fixture', () => {
  const parsed = parseSheetsGameCell({
    gameText: FIXTURE_2139_TEXT,
    roleCode: '701498',
    locationCode: '面瓦',
    playedAtStr: '2026/02/27',
    gameNumInDay: 16,
    playerNames: ['HAO', '雪怪', '尼克', 'Dean', '池', 'JOY', 'Ray', '海月', 'Lori', 'C5'],
  });

  it('schemaVersion = 2 and gameId contains date + num', () => {
    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.gameId).toBe('sheets-2026-02-27-16');
  });

  it('playedAt is 2026-02-27 00:00 +08', () => {
    // +08 時區 = UTC 2026-02-26 16:00
    const d = new Date(parsed.playedAt);
    expect(d.getUTCFullYear()).toBe(2026);
    expect(d.getUTCMonth()).toBe(1); // Feb
    expect(d.getUTCDate()).toBe(26);
    expect(d.getUTCHours()).toBe(16);
  });

  it('playerSeats use sheets: prefix when no UID callback', () => {
    expect(parsed.playerSeats[0]).toBe('sheets:HAO');
    expect(parsed.playerSeats[1]).toBe('sheets:雪怪');
    expect(parsed.playerSeats[4]).toBe('sheets:池');
    expect(parsed.playerSeats[9]).toBe('sheets:C5');
  });

  it('roles decoded from 701498 (刺娜德奧派梅)', () => {
    expect(parsed.finalResult.roles).toEqual({
      assassin: 7,
      morgana: 10, // 0
      mordred: 1,
      oberon: 4,
      percival: 9,
      merlin: 8,
    });
  });

  it('5 回合任務結果：blue / red / red / blue / red', () => {
    // 用 missions[].questResult.success 重算
    const quests = parsed.missions.filter((m) => m.questResult);
    expect(quests).toHaveLength(5);
    const outcomes = quests.map((m) => (m.questResult!.success ? 'blue' : 'red'));
    expect(outcomes).toEqual(['blue', 'red', 'red', 'blue', 'red']);
  });

  it('winner = evil + threeRed', () => {
    expect(parsed.finalResult.winnerCamp).toBe('evil');
    expect(parsed.finalResult.winReason).toBe('threeRed');
  });

  it('round 1 has 5 proposals (first 4 rejected, 5th forced = passed)', () => {
    const r1 = parsed.missions.filter((m) => m.round === 1);
    expect(r1).toHaveLength(5);
    expect(r1[0].teamSeats).toEqual([1, 3, 8]);
    expect(r1[1].teamSeats).toEqual([2, 6, 7]);
    expect(r1[2].teamSeats).toEqual([3, 7, 10]); // "370"
    expect(r1[3].teamSeats).toEqual([2, 4, 8]);
    expect(r1[4].teamSeats).toEqual([2, 5, 8]);
    // 前 4 被否 / 第 5 通過並開牌
    expect(r1[0].passed).toBe(false);
    expect(r1[4].passed).toBe(true);
    expect(r1[4].questResult).toEqual({
      successCount: 3,
      failCount: 0,
      success: true,
    });
  });

  it('round 2 has 5 proposals — 1st has 場外白 (6+), 2nd has 場內黑 + 場外白', () => {
    const r2 = parsed.missions.filter((m) => m.round === 2);
    expect(r2).toHaveLength(5);
    // 第 1 提議：[2,4,5,8] + 6+（10 人局）
    expect(r2[0].teamSeats).toEqual([2, 4, 5, 8]);
    expect(r2[0].approveCount).toBe(5); // 2,4,5,8,6
    expect(r2[0].rejectCount).toBe(5);  // 1,3,7,9,10

    // 第 2 提議：[2,5,8,10] + 0- + 7+
    expect(r2[1].teamSeats).toEqual([2, 5, 8, 10]);
    // 座 10 場內黑覆寫 reject；座 7 場外白 approve
    // approve: 2,5,7,8 = 4；reject: 1,3,4,6,9,10 = 6
    expect(r2[1].approveCount).toBe(4);
    expect(r2[1].rejectCount).toBe(6);

    // 任務結果
    expect(r2[4].questResult).toEqual({
      successCount: 2,
      failCount: 2,
      success: false,
    });
  });

  it('round 4 has 3 proposals ending ooooo (5 成功，8 人第 4 回合)', () => {
    const r4 = parsed.missions.filter((m) => m.round === 4);
    expect(r4).toHaveLength(3);
    expect(r4[0].teamSeats).toEqual([1, 2, 3, 5, 8]);
    expect(r4[1].teamSeats).toEqual([1, 4, 6, 7, 8]);
    expect(r4[2].teamSeats).toEqual([1, 2, 5, 6, 8]);
    expect(r4[2].questResult).toEqual({
      successCount: 5,
      failCount: 0,
      success: true,
    });
  });

  it('round 5 has 1 proposal ending oooox (4/5 成功，1 fail → 失敗)', () => {
    const r5 = parsed.missions.filter((m) => m.round === 5);
    expect(r5).toHaveLength(1);
    expect(r5[0].teamSeats).toEqual([1, 2, 5, 6]);
    expect(r5[0].questResult).toEqual({
      successCount: 4,
      failCount: 1,
      success: false,
    });
  });

  it('ladyChain has 3 entries', () => {
    expect(parsed.ladyChain).toBeDefined();
    expect(parsed.ladyChain).toHaveLength(3);
    // 0>1 o → 第 2 回合結束後，座 10 查座 1
    expect(parsed.ladyChain![0]).toMatchObject({
      round: 2,
      holderSeat: 10,
      targetSeat: 1,
      declaration: 'good',
    });
    // 1>8 o → 第 3 回合結束後
    expect(parsed.ladyChain![1]).toMatchObject({
      round: 3,
      holderSeat: 1,
      targetSeat: 8,
      declaration: 'good',
    });
    // 8>6 o → 第 4 回合結束後 (座 8 = 梅林 查座 6 = 平民)
    expect(parsed.ladyChain![2]).toMatchObject({
      round: 4,
      holderSeat: 8,
      targetSeat: 6,
      declaration: 'good',
    });
  });

  it('lady actual camp derived from roles — 1>8 declares good, seat 8 = merlin = good (truthful)', () => {
    const link = parsed.ladyChain![1];
    expect(link.actual).toBe('good'); // seat 8 = merlin
    expect(link.truthful).toBe(true);
  });

  it('lady actual camp — 8>6 declares good, seat 6 is loyal (not assassin/morgana/mordred/oberon) → good (truthful)', () => {
    const link = parsed.ladyChain![2];
    expect(link.actual).toBe('good');
    expect(link.truthful).toBe(true);
  });

  it('all 5 quests recorded in outcomes (missions count ≥ 5)', () => {
    // 總提議數 = 5(R1) + 5(R2) + 2(R3) + 3(R4) + 1(R5) = 16
    expect(parsed.missions).toHaveLength(16);
    const passedMissions = parsed.missions.filter((m) => m.passed);
    expect(passedMissions).toHaveLength(5); // 每回合最後一個通過
  });

  it('playerNameToUid callback maps registered players to UUID', () => {
    const registry: Record<string, string> = {
      HAO: 'uid-hao-12345',
      雪怪: 'uid-snow-67890',
    };
    const withUids = parseSheetsGameCell({
      gameText: FIXTURE_2139_TEXT,
      roleCode: '701498',
      locationCode: '面瓦',
      playedAtStr: '2026/02/27',
      gameNumInDay: 16,
      playerNames: ['HAO', '雪怪', '尼克', 'Dean', '池', 'JOY', 'Ray', '海月', 'Lori', 'C5'],
      playerNameToUid: (name) => registry[name] ?? null,
    });
    expect(withUids.playerSeats[0]).toBe('uid-hao-12345');
    expect(withUids.playerSeats[1]).toBe('uid-snow-67890');
    expect(withUids.playerSeats[2]).toBe('sheets:尼克'); // fallback
  });
});
