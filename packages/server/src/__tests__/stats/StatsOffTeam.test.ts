/**
 * 場外藍票的外白率／外黑率（@avalon/shared stats/decisiveVotes.ts offTeamCounts／offTeamRatio／offTeamCohortGrid）：
 * 不在隊上的藍方票，依贊成／反對 × 隊伍品質（全好／會失敗／第 4 局單紅中性），分組（強者／一般人／新手 × 高端／普通／歡樂）。
 * 虛構的局，名字 P1..P10。配置 123456：1 刺客、2 莫甘娜、3 莫德雷德、4 奧伯倫（紅）；5 派西維爾、6 梅林、7 8 9 0 忠臣（藍）。
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COHORT_CUTS, OFF_TEAM_MEASURES,
  decisiveCohortData, decodeGamesDataset, offTeamCohortGrid, offTeamCounts, offTeamRatio, scanDecisiveVotes,
  type DecisiveSeatRecord, type LineupTuple, type OffTeamCounts, type VotingProposal,
} from '@avalon/shared/stats';
import { makeDataset } from './datasetBuilder';

const NAMES = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
const v = (round: number, attempt: number, team: string, approved: string): VotingProposal => [round, attempt, team, approved];
function lineup(prs: number[]): LineupTuple {
  const s = prs.reduce((a, b) => a + b, 0) / prs.length;
  return [80, Math.round(s * 10), prs, 0];
}
// P5 90、P6 85 = 強者；P7 50、P10 30 = 一般人；P8 10、P9 10 = 新手（預設 80／20）
const PRS_X = [50, 50, 50, 50, 90, 85, 50, 10, 10, 30]; // S 47.5 → 普通
const PRS_Y = [70, 70, 70, 70, 90, 85, 50, 10, 10, 30]; // S 55.5 → 高端

// X：前兩局都紅 → 第 3 局是兩紅之後。紅方（1–4）不在隊上時也常投白：不算（只看藍方）。
const GAME_X: VotingProposal[] = [
  v(1, 1, '156', '1234567'),
  v(2, 1, '2567', '12345678'),
  v(3, 1, '1578', '12345'), // 會失敗，5 票沒過：場外藍 6 9 0 都反對（反對會失敗 ×3，都是關鍵）；5 在隊上投白不算
  v(3, 2, '5679', '56790'), // 全好，5 票沒過：場外 8 反對（反對全好、關鍵）、0 贊成（贊成全好、不是關鍵）
  v(3, 3, '5689', '125680'), // 全好，6 票過關：場外 7 反對（不是關鍵）、0 贊成（贊成全好、關鍵）
];

// Y：紅藍紅 → 第 3 局紅方一勝（只在第 3～5 局）、第 4 局是兩紅之後。
const GAME_Y: VotingProposal[] = [
  v(1, 1, '156', '1234567'),
  v(2, 1, '5678', '1234567890'),
  v(3, 1, '1567', '12345678'), // 會失敗、過關：場外 8 贊成（贊成會失敗）、9 0 反對
  v(4, 1, '35678', '12345'), // 第 4 局只有莫德雷德 → 中性；場外 9 0 反對（關鍵）
  v(4, 2, '13567', '1234'), // 兩個紅 → 會失敗；場外 8 9 0 反對
  v(4, 3, '45678', '45679'), // 只有奧伯倫 → 中性；場外 9 贊成、0 反對（關鍵）
  v(4, 4, '56789', '1234'), // 全好；場外 0 反對
  v(4, 5, '56780', '567890'), // 第 5 次強制出發：不算（算了 9 號會多一張贊成全好）
];

const games = decodeGamesDataset(makeDataset([
  { id: 'X', names: NAMES, rounds: 'RRB--', missions: 'oox|ooxo|oooo||', votes: GAME_X, lineup: lineup(PRS_X) },
  { id: 'Y', names: NAMES, rounds: 'RBRB-', outcome: '三藍活', missions: 'oox|oooo|ooox|ooooo|', votes: GAME_Y, lineup: lineup(PRS_Y) },
])).games;
const scan = scanDecisiveVotes(games, { allVotes: true });
const twoRed = decisiveCohortData(scan, 'twoRed', games);
const r35 = decisiveCohortData(scan, 'r35', games);

const total = (records: readonly DecisiveSeatRecord[]): OffTeamCounts => {
  const out: OffTeamCounts = { yesGood: 0, yesBad: 0, yesNeutral: 0, noGood: 0, noBad: 0, noNeutral: 0 };
  for (const r of records) {
    const c = offTeamCounts(r);
    for (const k of Object.keys(out) as (keyof OffTeamCounts)[]) out[k] += c[k];
  }
  return out;
};
const rate = (records: readonly DecisiveSeatRecord[], m: (typeof OFF_TEAM_MEASURES)[number]): { k: number; n: number } => offTeamRatio(total(records), m);

describe('off-team blue votes: definitions', () => {
  const c: OffTeamCounts = { yesGood: 6, yesBad: 2, yesNeutral: 1, noGood: 4, noBad: 8, noNeutral: 3 };
  it('外白率 + 外黑率 = 100% of the off-team votes', () => {
    expect(offTeamRatio(c, 'yes')).toEqual({ k: 9, n: 24 });
    expect(offTeamRatio(c, 'no')).toEqual({ k: 15, n: 24 });
  });
  it('by team quality: approvals (or rejections) of all-good / failing / round-4 one-red teams', () => {
    expect(offTeamRatio(c, 'yesGood')).toEqual({ k: 6, n: 10 });
    expect(offTeamRatio(c, 'noGood')).toEqual({ k: 4, n: 10 });
    expect(offTeamRatio(c, 'yesBad')).toEqual({ k: 2, n: 10 });
    expect(offTeamRatio(c, 'noBad')).toEqual({ k: 8, n: 10 });
    expect(offTeamRatio(c, 'yesNeutral')).toEqual({ k: 1, n: 4 });
    expect(offTeamRatio(c, 'noNeutral')).toEqual({ k: 3, n: 4 });
  });
  it('外白對率 / 外黑對率 leave the neutral class out (same as the 場外白 / 場外黑 cells)', () => {
    expect(offTeamRatio(c, 'yesRight')).toEqual({ k: 6, n: 8 });
    expect(offTeamRatio(c, 'noRight')).toEqual({ k: 8, n: 12 });
  });
  it('maps the decisive record counts: 場外白 對/錯/中性 = approve good/bad/neutral, 場外黑 對/錯/中性 = reject bad/good/neutral', () => {
    // DECISIVE_COHORT_ORDER：onYes(0-2) onNo(3-5) offYes(6-8) offNo(9-11)，各 對／錯／中性
    const counts = [100, 100, 100, 100, 100, 100, 1, 2, 3, 4, 5, 6];
    expect(offTeamCounts({ counts })).toEqual({ yesGood: 1, yesBad: 2, yesNeutral: 3, noBad: 4, noGood: 5, noNeutral: 6 });
  });
});

describe('off-team blue votes: hand-built games', () => {
  it('after two reds, all votes: on-team, red and forced votes are excluded', () => {
    // X 第 3 局：贊成全好 2、反對全好 2、反對會失敗 3；Y 第 4 局：贊成中性 1、反對中性 3、反對會失敗 3、反對全好 1
    expect(total(twoRed.all)).toEqual({ yesGood: 2, yesBad: 0, yesNeutral: 1, noGood: 3, noBad: 6, noNeutral: 3 });
    expect(rate(twoRed.all, 'yes')).toEqual({ k: 3, n: 15 });
    expect(rate(twoRed.all, 'no')).toEqual({ k: 12, n: 15 });
    expect(rate(twoRed.all, 'yesGood')).toEqual({ k: 2, n: 5 });
    expect(rate(twoRed.all, 'noBad')).toEqual({ k: 6, n: 6 });
    expect(rate(twoRed.all, 'yesNeutral')).toEqual({ k: 1, n: 4 });
    expect(rate(twoRed.all, 'yesRight')).toEqual({ k: 2, n: 2 });
    expect(rate(twoRed.all, 'noRight')).toEqual({ k: 6, n: 9 });
    // 在隊上的票：派西維爾（5 號）兩紅之後每一次都在隊上 → 沒有場外票
    expect(total(twoRed.all.filter((r) => r.role === '派西維爾'))).toEqual({ yesGood: 0, yesBad: 0, yesNeutral: 0, noGood: 0, noBad: 0, noNeutral: 0 });
  });

  it('decisive votes only', () => {
    // X：3-1 反對會失敗 ×3、3-2 反對全好（8）、3-3 贊成全好（0）；Y：4-1 反對中性 ×2、4-3 反對中性（0）
    expect(total(twoRed.decisive)).toEqual({ yesGood: 1, yesBad: 0, yesNeutral: 0, noGood: 1, noBad: 3, noNeutral: 3 });
    expect(rate(twoRed.decisive, 'yes')).toEqual({ k: 1, n: 8 });
    expect(rate(twoRed.decisive, 'noRight')).toEqual({ k: 3, n: 4 });
  });

  it('scope switch: rounds 3-5 adds Y round 3 (red had one win)', () => {
    expect(total(r35.all)).toEqual({ yesGood: 2, yesBad: 1, yesNeutral: 1, noGood: 3, noBad: 8, noNeutral: 3 });
    expect(rate(r35.all, 'yesBad')).toEqual({ k: 1, n: 9 });
    expect(rate(r35.all, 'yesRight')).toEqual({ k: 2, n: 3 });
  });

  it('the grid: player tier x table tier, players = those with votes in the measure', () => {
    const cuts = DEFAULT_COHORT_CUTS;
    const yes = offTeamCohortGrid(twoRed.all, cuts, 'yes');
    const ratio = (cell: { counts: readonly number[] }): { k: number; n: number } => offTeamRatio(offTeamCounts(cell), 'yes');
    expect(ratio(yes.all)).toEqual({ k: 3, n: 15 });
    expect(ratio(yes.rows.strong)).toEqual({ k: 0, n: 1 }); // 梅林 P6，X 3-1
    expect(yes.rows.strong.players).toBe(1);
    expect(ratio(yes.rows.regular)).toEqual({ k: 2, n: 8 }); // P7、P10
    expect(ratio(yes.rows.novice)).toEqual({ k: 1, n: 6 }); // P8、P9
    expect(ratio(yes.cells.novice.high)).toEqual({ k: 1, n: 4 }); // Y：P9 贊成中性；P8、P9 反對會失敗；P9 反對中性
    expect(yes.cells.novice.high.players).toBe(2);
    expect(ratio(yes.cols.normal)).toEqual({ k: 2, n: 7 }); // X
    expect(ratio(yes.cols.high)).toEqual({ k: 1, n: 8 }); // Y
    // 全好的隊上的外白率：強者沒有這種票 → 不在格子裡（0 人）
    const good = offTeamCohortGrid(twoRed.all, cuts, 'yesGood');
    const goodRatio = (cell: { counts: readonly number[] }): { k: number; n: number } => offTeamRatio(offTeamCounts(cell), 'yesGood');
    expect(goodRatio(good.rows.regular)).toEqual({ k: 2, n: 4 });
    expect(good.rows.regular.players).toBe(2);
    expect(goodRatio(good.rows.novice)).toEqual({ k: 0, n: 1 });
    expect(good.rows.strong.players).toBe(0);
    // 第 4 局單紅（中性）只出現在 Y（高端桌）
    const neutral = offTeamCohortGrid(twoRed.all, cuts, 'noNeutral');
    expect(offTeamRatio(offTeamCounts(neutral.cols.high), 'noNeutral')).toEqual({ k: 3, n: 4 });
    expect(neutral.cols.normal.n).toBe(0);
  });

  it('the role filter and adjustable cuts', () => {
    const merlin = offTeamCohortGrid(twoRed.all, DEFAULT_COHORT_CUTS, 'no', '梅林');
    expect(offTeamRatio(offTeamCounts(merlin.all), 'no')).toEqual({ k: 1, n: 1 });
    expect(offTeamCohortGrid(twoRed.all, DEFAULT_COHORT_CUTS, 'yes', '派西維爾').all.n).toBe(0);
    const loyal = offTeamCohortGrid(twoRed.all, DEFAULT_COHORT_CUTS, 'yes', '忠臣');
    expect(offTeamRatio(offTeamCounts(loyal.all), 'yes')).toEqual({ k: 3, n: 14 });
    // 新手的切點改成 10：P8、P9（PR 10）變成一般人
    const moved = offTeamCohortGrid(twoRed.all, { ...DEFAULT_COHORT_CUTS, prLo: 10 }, 'yes');
    expect(offTeamRatio(offTeamCounts(moved.rows.novice), 'yes').n).toBe(0);
    expect(offTeamRatio(offTeamCounts(moved.rows.regular), 'yes')).toEqual({ k: 3, n: 14 });
  });
});
