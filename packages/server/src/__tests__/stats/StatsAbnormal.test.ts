/**
 * 異常票（內黑／外白）的分組統計（@avalon/shared stats/abnormalVotes.ts，站長 2026-11-12 的定義）：
 * 情境（兩紅之後、第三局・兩紅、第三局・一藍一紅、第四局・兩紅、第五局）× 全部／關鍵 × 內黑率、內黑正確率、外白率、外白正確率。
 * 虛構的局，名字 P1..P10。配置 123456：1 刺客、2 莫甘娜、3 莫德雷德、4 奧伯倫（紅）；5 派西維爾、6 梅林、7 8 9 0 忠臣（藍）。
 */
import { describe, expect, it } from 'vitest';
import {
  ABNORMAL_SITUATIONS, DEFAULT_COHORT_CUTS,
  abnormalCohortGrid, abnormalCounts, abnormalRatio, abnormalRecords, abnormalSlot, decodeGamesDataset, inAbnormalSituation,
  scanAbnormalVotes, sumAbnormal,
  type AbnormalRecord, type LineupTuple, type VotingProposal,
} from '@avalon/shared/stats';
import { makeDataset } from './datasetBuilder';

const NAMES = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
const v = (round: number, attempt: number, team: string, approved: string): VotingProposal => [round, attempt, team, approved];
function lineup(prs: number[]): LineupTuple {
  const s = prs.reduce((a, b) => a + b, 0) / prs.length;
  return [80, Math.round(s * 10), prs, 0];
}

// G1：紅紅 → 第 3 局 0:2（第三局・兩紅）。站長的例子一：7 張白，3 張是場外白（紅方 1 號、藍方 9、0 號）→ 9、0 都是關鍵外白。
const G1: VotingProposal[] = [
  v(1, 1, '156', '1234567'), // 第 1～2 局不在任何情境
  v(2, 1, '2567', '12345678'),
  // 會失敗（刺客），剛好 5 張白沒過：在隊上的 7 投黑 = 內黑對、也是關鍵內黑（差一張白）；5、6 在隊上投白；
  // 場外 9 投白 = 外白錯（沒過，不是關鍵）；8、0 場外黑
  v(3, 1, '1567', '12569'),
  // 全好，7 張白過關（該局最後一次）：場外的白 = 1（紅方，不算）、9、0 → 關鍵外白 ×2（都對）
  v(3, 2, '5678', '1567890'),
];

// G2：紅藍紅藍 → 第 5 局 2:2（第五局）。站長的例子二：5 張白 = 場內 3（1、5、6）+ 場外 2（2、3），場內的黑 7、8 → 都是關鍵內黑。
const G2: VotingProposal[] = [
  v(5, 1, '15678', '12356'),
  // 會失敗，10 張白過關：場外 8、0 投白 = 關鍵外白錯
  v(5, 2, '15679', '1234567890'),
];

// G3：紅藍 → 第 3 局 1:1（第三局・一藍一紅）；第 4 局 2:1 不算。
const G3: VotingProposal[] = [
  // 隊上唯一的紅方是莫德雷德（也算紅）：5 張白沒過 → 6（梅林）、7 在隊上投黑 = 關鍵內黑對；場外 8 9 0 投白 = 外白錯
  v(3, 1, '3567', '35890'),
  // 全好，3 張白：8 在隊上投黑 = 內黑錯（不是關鍵：差三張）
  v(3, 2, '5678', '567'),
  // 全好，7 張白過關：場外 0 投白 = 關鍵外白對、8 場外黑
  v(3, 3, '5679', '1256790'),
  // 第 4 局 2:1：不算
  v(4, 1, '15678', '1'),
  v(4, 2, '56789', '1234567890'),
];

// G4：藍藍 → 第 3 局 2:0：不算。
const G4: VotingProposal[] = [
  v(3, 1, '1567', '12569'),
  v(3, 2, '5678', '1567890'),
];

// G5：紅紅藍 → 第 4 局 1:2（第四局・兩紅）。
const G5: VotingProposal[] = [
  // 只有莫德雷德、第 4 局單紅：內黑照樣算對（黑到至少一壞，沒有中性）；5 張白沒過 → 6 7 8 都是關鍵內黑對（5 號在隊上投白）
  v(4, 1, '35678', '12345'),
  // 全好，4 張白：9 在隊上投黑 = 內黑錯（不是關鍵）
  v(4, 2, '56789', '5678'),
  // 第 5 次強制出發：不算（算了場外 0 號會多一張關鍵外白）
  v(4, 5, '56780', '567890'),
];

// P5 90、P6 85、P9 95 = 強者；P7 50、P8 30 = 一般人；P10 10 = 新手（預設 80／20）；S 64 → 高端
const PRS_G1 = [70, 70, 70, 70, 90, 85, 50, 30, 95, 10];

const games = decodeGamesDataset(makeDataset([
  { id: 'G1', names: NAMES, rounds: 'RRB--', missions: 'oox|ooxo|oooo||', votes: G1, lineup: lineup(PRS_G1) },
  { id: 'G2', names: NAMES, rounds: 'RBRBR', missions: 'oox|oooo|ooxo|ooooo|ooxoo', votes: G2 },
  { id: 'G3', names: NAMES, rounds: 'RBBR-', outcome: '三藍活', missions: 'oox|oooo|oooo|ooxox|', votes: G3 },
  { id: 'G4', names: NAMES, rounds: 'BBR--', missions: 'ooo|oooo|ooxo||', votes: G4 },
  { id: 'G5', names: NAMES, rounds: 'RRBB-', outcome: '三藍活', missions: 'oox|ooxo|oooo|ooooo|', votes: G5 },
  // 配置不完整：整局不算
  { id: 'G6', names: NAMES, config: '123455', rounds: 'RRB--', missions: 'oox|ooxo|oooo||', votes: G1 },
])).games;
const scan = scanAbnormalVotes(games);
const gameSeq = (id: string): number => games.find((g) => g.id === id)!.seq;
const seatRec = (id: string, seat: string): AbnormalRecord | undefined =>
  scan.records.find((r) => r.game === gameSeq(id) && r.seat === seat);
const ratios = (records: readonly AbnormalRecord[], mode: 'all' | 'key'): Record<string, [number, number]> => {
  const c = sumAbnormal(records);
  const out: Record<string, [number, number]> = {};
  for (const m of ['inBlack', 'inBlackRight', 'outWhite', 'outWhiteRight'] as const) {
    const { k, n } = abnormalRatio(c, m, mode);
    out[m] = [k, n];
  }
  return out;
};

describe('abnormal votes: situations', () => {
  it('score before the round → situation (round 3 at 2:0 and round 4 at 2:1 are not counted)', () => {
    expect(abnormalSlot(3, 0, 2)).toBe('r3TwoRed');
    expect(abnormalSlot(3, 1, 1)).toBe('r3Even');
    expect(abnormalSlot(3, 2, 0)).toBeNull();
    expect(abnormalSlot(4, 1, 2)).toBe('r4TwoRed');
    expect(abnormalSlot(4, 2, 1)).toBeNull();
    expect(abnormalSlot(5, 2, 2)).toBe('r5');
    expect(abnormalSlot(2, 0, 1)).toBeNull();
    expect(abnormalSlot(1, 0, 0)).toBeNull();
  });

  it('兩紅之後 = 第三局・兩紅 + 第四局・兩紅 + 第五局', () => {
    expect(ABNORMAL_SITUATIONS).toEqual(['twoRed', 'r3TwoRed', 'r3Even', 'r4TwoRed', 'r5']);
    expect(inAbnormalSituation('r3TwoRed', 'twoRed')).toBe(true);
    expect(inAbnormalSituation('r4TwoRed', 'twoRed')).toBe(true);
    expect(inAbnormalSituation('r5', 'twoRed')).toBe(true);
    expect(inAbnormalSituation('r3Even', 'twoRed')).toBe(false);
    expect(inAbnormalSituation('r3Even', 'r3Even')).toBe(true);
  });

  it('proposals per situation: forced, 2:0 round 3, 2:1 round 4, rounds 1–2 and incomplete configs are excluded', () => {
    expect(scan.proposals).toEqual({ twoRed: 6, r3TwoRed: 2, r3Even: 3, r4TwoRed: 2, r5: 2 });
    expect(scan.games).toEqual({ twoRed: 3, r3TwoRed: 1, r3Even: 1, r4TwoRed: 1, r5: 1 });
    expect(scan.inconsistent).toEqual({ twoRed: 0, r3TwoRed: 0, r3Even: 0, r4TwoRed: 0, r5: 0 });
    expect(scan.records.some((r) => r.game === gameSeq('G4'))).toBe(false);
    expect(scan.records.some((r) => r.game === gameSeq('G6'))).toBe(false);
    expect(scan.records.filter((r) => r.game === gameSeq('G3')).every((r) => r.slot === 'r3Even')).toBe(true);
  });

  it('only blue voters: one record per blue seat per game and situation, red seats never appear', () => {
    expect(scan.records.every((r) => !['1', '2', '3', '4'].includes(r.seat))).toBe(true);
    expect(scan.records).toHaveLength(6 * 4);
    // 票數 = 藍方 6 人 × 算進來的提議
    expect(scan.records.reduce((s, r) => s + r.n, 0)).toBe(6 * (2 + 2 + 3 + 2));
  });

  it('a proposal whose votes contradict the result is excluded', () => {
    const bad = decodeGamesDataset(makeDataset([
      { id: 'X', names: NAMES, rounds: 'RRB--', missions: 'oox|ooxo|oooo||', votes: [v(3, 1, '5678', '1567890'), v(3, 2, '5678', '1567890')] },
    ])).games;
    const s = scanAbnormalVotes(bad);
    expect(s.inconsistent).toEqual({ twoRed: 1, r3TwoRed: 1, r3Even: 0, r4TwoRed: 0, r5: 0 });
    expect(s.proposals.r3TwoRed).toBe(1);
  });
});

describe('abnormal votes: the owner examples', () => {
  it('example 1: 7 approvals, 3 off-team (a red and blues 9, 0) → 9 and 0 are both 關鍵外白, the red is not counted', () => {
    const r9 = abnormalCounts(seatRec('G1', '9')!);
    const r0 = abnormalCounts(seatRec('G1', '0')!);
    expect([r9.keyOffYesRight, r9.keyOffYesWrong, r9.keyOffChance]).toEqual([1, 0, 1]);
    expect([r0.keyOffYesRight, r0.keyOffYesWrong, r0.keyOffChance]).toEqual([1, 0, 1]);
    // 同一局：9 在沒過的提議上投白 = 外白（錯），但不是關鍵
    expect([r9.offYesRight, r9.offYesWrong]).toEqual([1, 1]);
    expect(seatRec('G1', '1')).toBeUndefined();
    // 在隊上的人不是關鍵外白的機會
    expect(abnormalCounts(seatRec('G1', '5')!).keyOffChance).toBe(0);
  });

  it('example 2: 5 approvals = 3 on-team + 2 off-team → on-team rejecters 7 and 8 are both 關鍵內黑 (correct: the team has a red)', () => {
    for (const seat of ['7', '8']) {
      const c = abnormalCounts(seatRec('G2', seat)!);
      expect([c.keyOnNoRight, c.keyOnNoWrong, c.keyOnChance]).toEqual([1, 0, 1]);
      expect(c.onNoRight).toBe(1);
    }
    // 在隊上投白的 5、6：有機會、不是關鍵內黑
    const c5 = abnormalCounts(seatRec('G2', '5')!);
    expect([c5.keyOnNoRight + c5.keyOnNoWrong, c5.keyOnChance]).toEqual([0, 1]);
    // 場外投黑的 9、0：不是內黑的機會
    expect(abnormalCounts(seatRec('G2', '9')!).keyOnChance).toBe(0);
  });
});

describe('abnormal votes: measures', () => {
  it('兩紅之後, 全部 (hand count)', () => {
    // 在隊上 24 張（白 17、黑 7：有紅 6、全好 1）；不在隊上 12 張（黑 7、白 5：全好 2、有紅 3）
    expect(ratios(abnormalRecords(scan.records, 'twoRed'), 'all')).toEqual({
      inBlack: [7, 24], inBlackRight: [6, 7], outWhite: [5, 12], outWhiteRight: [2, 5],
    });
  });

  it('兩紅之後, 關鍵 (hand count)', () => {
    // 關鍵內黑：G1 7 號、G2 7 8 號、G5 6 7 8 號 = 6 張都對；機會 = 剛好 5 張白沒過的提議上在隊上的藍方 3 + 4 + 4
    // 關鍵外白：G1 9 0 號（對）、G2 8 0 號（錯）；機會 = 過關的提議上不在隊上的藍方 2 + 2
    expect(ratios(abnormalRecords(scan.records, 'twoRed'), 'key')).toEqual({
      inBlack: [6, 11], inBlackRight: [6, 6], outWhite: [4, 4], outWhiteRight: [2, 4],
    });
  });

  it('each situation separately', () => {
    expect(ratios(abnormalRecords(scan.records, 'r3TwoRed'), 'all')).toEqual({
      inBlack: [1, 7], inBlackRight: [1, 1], outWhite: [3, 5], outWhiteRight: [2, 3],
    });
    expect(ratios(abnormalRecords(scan.records, 'r5'), 'key')).toEqual({
      inBlack: [2, 4], inBlackRight: [2, 2], outWhite: [2, 2], outWhiteRight: [0, 2],
    });
    // 第四局・兩紅：單紅（莫德雷德）的隊，內黑一樣算對
    expect(ratios(abnormalRecords(scan.records, 'r4TwoRed'), 'all')).toEqual({
      inBlack: [4, 9], inBlackRight: [3, 4], outWhite: [0, 3], outWhiteRight: [0, 0],
    });
    expect(ratios(abnormalRecords(scan.records, 'r4TwoRed'), 'key')).toEqual({
      inBlack: [3, 4], inBlackRight: [3, 3], outWhite: [0, 0], outWhiteRight: [0, 0],
    });
    // 第三局・一藍一紅：莫德雷德的隊上的外白是錯的、內黑是對的
    expect(ratios(abnormalRecords(scan.records, 'r3Even'), 'all')).toEqual({
      inBlack: [3, 11], inBlackRight: [2, 3], outWhite: [4, 7], outWhiteRight: [1, 4],
    });
    expect(ratios(abnormalRecords(scan.records, 'r3Even'), 'key')).toEqual({
      inBlack: [2, 3], inBlackRight: [2, 2], outWhite: [1, 2], outWhiteRight: [1, 1],
    });
  });

  it('全部 counts abnormal votes that 關鍵 does not (rejected proposals for 外白, not one short / passed for 內黑)', () => {
    const all = sumAbnormal(abnormalRecords(scan.records, 'r3Even'));
    // 外白 4 張（3 張投給沒過的提議），關鍵外白只有 1 張；內黑 3 張（8 號那張差三張白），關鍵內黑 2 張
    expect(all.offYesRight + all.offYesWrong).toBe(4);
    expect(all.keyOffYesRight + all.keyOffYesWrong).toBe(1);
    expect(all.onNoRight + all.onNoWrong).toBe(3);
    expect(all.keyOnNoRight + all.keyOnNoWrong).toBe(2);
  });

  it('role filter (梅林, 兩紅之後)', () => {
    const merlin = abnormalRecords(scan.records, 'twoRed', '梅林');
    expect(merlin.every((r) => r.seat === '6')).toBe(true);
    expect(ratios(merlin, 'all').inBlack).toEqual([1, 6]);
    expect(ratios(merlin, 'key').inBlack).toEqual([1, 3]);
    expect(ratios(abnormalRecords(scan.records, 'twoRed', '派西維爾'), 'all').inBlack).toEqual([0, 6]);
    expect(ratios(abnormalRecords(scan.records, 'twoRed', '忠臣'), 'all').inBlack).toEqual([6, 12]);
  });
});

describe('abnormal votes: groups (player tier × table tier)', () => {
  it('關鍵外白率 (兩紅之後) by player tier: only records with a chance are kept', () => {
    const grid = abnormalCohortGrid(scan.records, DEFAULT_COHORT_CUTS, 'twoRed', 'outWhite', 'key');
    const r = (cell: { counts: readonly number[] }): { k: number; n: number } => abnormalRatio(abnormalCounts(cell), 'outWhite', 'key');
    // G1（有 PR）：9 號 PR 95 強者、0 號 PR 10 新手，S 55.5 高端；G2 沒評分：8、0 號
    expect(r(grid.cells.strong.high)).toEqual({ k: 1, n: 1 });
    expect(r(grid.cells.novice.high)).toEqual({ k: 1, n: 1 });
    expect(r(grid.rows.unrated)).toEqual({ k: 2, n: 2 });
    expect(r(grid.all)).toEqual({ k: 4, n: 4 });
    expect(grid.all.players).toBe(3);
    expect(grid.rows.regular.n).toBe(0);
  });

  it('內黑率 (全部, 兩紅之後) grid with a role', () => {
    const grid = abnormalCohortGrid(scan.records, DEFAULT_COHORT_CUTS, 'twoRed', 'inBlack', 'all', '忠臣');
    const r = (cell: { counts: readonly number[] }): { k: number; n: number } => abnormalRatio(abnormalCounts(cell), 'inBlack', 'all');
    // G1 的忠臣：7 號（一般人）在隊上 2 張、1 黑；8 號（一般人）在隊上 1 張；9、0 號沒在隊上（不算進來）
    expect(r(grid.rows.regular)).toEqual({ k: 1, n: 3 });
    expect(grid.rows.regular.players).toBe(2);
    expect(r(grid.all)).toEqual({ k: 6, n: 12 });
  });
});
