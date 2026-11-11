/**
 * 數據排行「關鍵外白／內黑」（@avalon/shared stats/decisiveVotes.ts）：真的決定了提議過不過的藍方投票（剛好 6 票過關時投白、
 * 剛好 5 票沒過時投黑），依（場內／場外）×（白／黑）×（對／錯）分八格，第 4 局單紅的隊是中性。虛構的局，名字 P1..P10。
 * 配置 123456：1 刺客、2 莫甘娜、3 莫德雷德、4 奧伯倫（紅）；5 派西維爾、6 梅林、7 8 9 0 忠臣（藍）。
 */
import { describe, expect, it } from 'vitest';
import {
  DECISIVE_GROUPS, DECISIVE_SHRINK_K,
  decisiveBaselines, decisiveGroup, decisiveOutcome, decisiveQuality, decisiveRate, decisiveReport, decisiveShrunk, decodeGamesDataset,
  scanDecisiveVotes, sortDecisiveRows, sumDecisive,
  type DecisiveCell, type DecisiveGrid, type DecisivePlayerRow, type VotingProposal,
} from '@avalon/shared/stats';
import { makeDataset, type GameSpec } from './datasetBuilder';

const NAMES = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
const v = (round: number, attempt: number, team: string, approved: string): VotingProposal => [round, attempt, team, approved];

// A：前兩局都紅 → 第 3 局是兩紅之後。
const GAME_A: VotingProposal[] = [
  v(1, 1, '156', '1234567'), // 7 票過：沒有關鍵票
  v(2, 1, '2567', '12345678'),
  // 會失敗的隊（刺客），剛好 5 票沒過：投黑的藍方都是關鍵、都對。7、8 在隊上 = 場內黑對；6、9、0 = 場外黑對。
  // 5 號（派西維爾）投白但沒過，不是關鍵。
  v(3, 1, '1578', '12345'),
  // 全好的隊，剛好 5 票沒過：投黑的藍方只有 8 號（場外）= 場外黑錯。
  v(3, 2, '5679', '56790'),
  // 全好的隊，剛好 6 票過關（該局最後一次、有任務結果）：5、6、8 = 場內白對；0 = 場外白對（關鍵外白）。
  v(3, 3, '5689', '125680'),
];

// B：前兩局都紅 → 第 3 局是兩紅之後。
const GAME_B: VotingProposal[] = [
  v(1, 1, '156', '1234567'),
  v(2, 1, '2567', '12345678'),
  // 全好的隊，剛好 5 票沒過：6、7、9 在隊上 = 場內黑錯；8、0 = 場外黑錯。
  v(3, 1, '5679', '12345'),
  // 會失敗的隊（刺客），剛好 6 票過關：7、8、9 = 場內白錯；0 = 場外白錯。
  v(3, 2, '1789', '127890'),
];

// C：紅藍紅 → 第 4 局是兩紅之後；第 3 局紅方一勝（只在第 3～5 局的範圍）。
const GAME_C: VotingProposal[] = [
  // 第 1 局：會失敗的隊，剛好 5 票沒過 → 6 場內黑對、7 8 9 0 場外黑對（只在第 1～2 局的範圍）
  v(1, 1, '156', '12345'),
  v(1, 2, '567', '1234567'),
  v(2, 1, '5678', '1234567890'),
  v(3, 1, '1567', '12345678'), // 8 票過：沒有關鍵票
  // 第 4 局只有莫德雷德一個紅方 → 中性：6 7 8 場內黑中性、9 0 場外黑中性
  v(4, 1, '35678', '12345'),
  // 6 票贊成卻不是該局最後一次（紀錄說沒出任務）→ 票數和結果對不上，不算
  v(4, 2, '13567', '135670'),
  v(4, 3, '56789', '1234'), // 4 票：沒有關鍵票
  v(4, 4, '56780', '1234'),
  // 第 5 次強制出發：就算寫了 6 票贊成也不算
  v(4, 5, '56789', '567890'),
];

// D：藍藍 → 第 3 局紅方零勝（不是兩紅之後，只在第 3～5 局的範圍）。隊上唯一的紅方是莫德雷德 → 會失敗（莫德雷德也算紅）。
// 剛好 6 票過關：5 6 7 場內白錯（6 = 梅林，只含莫德雷德）；8、9 場外白錯（9 號沒寫名字）。
const GAME_D: VotingProposal[] = [
  v(1, 1, '567', '1567890'),
  v(2, 1, '5678', '1234567890'),
  v(3, 1, '3567', '356789'),
];

const SPECS: GameSpec[] = [
  { id: 'A', names: NAMES, rounds: 'RRB--', missions: 'oox|ooxo|oooo||', votes: GAME_A },
  { id: 'B', names: NAMES, rounds: 'RRR--', missions: 'oox|ooxo|ooxo||', votes: GAME_B },
  { id: 'C', names: NAMES, rounds: 'RBRB-', outcome: '三藍活', missions: 'oox|oooo|ooox|ooooo|', votes: GAME_C },
  { id: 'D', names: [...NAMES.slice(0, 8), null, 'P10'], rounds: 'BBR--', missions: 'ooo|oooo|ooox||', votes: GAME_D },
  // E：配置不完整（有重複的數字）→ 整局不算
  { id: 'E', names: NAMES, config: '123455', rounds: 'RRB--', missions: 'oox|ooxo|oooo||', votes: GAME_A },
];

const decoded = decodeGamesDataset(makeDataset(SPECS));
const scan = scanDecisiveVotes(decoded.games);
const twoRed = decisiveReport(scan, 'twoRed');
const r35 = decisiveReport(scan, 'r35');
const r12 = decisiveReport(scan, 'r12');

const cell = (right: number, wrong: number, neutral = 0): DecisiveCell => ({ right, wrong, neutral });
const grid = (g: Partial<DecisiveGrid>): DecisiveGrid => ({
  onYes: cell(0, 0), onNo: cell(0, 0), offYes: cell(0, 0), offNo: cell(0, 0), ...g,
});
const player = (report: typeof twoRed, name: string): DecisivePlayerRow | undefined => report.players.find((p) => p.name === name);

describe('decisive votes: definitions', () => {
  it('team quality: no red = good, round 4 one red = neutral, otherwise bad', () => {
    expect(decisiveQuality(3, 0)).toBe('good');
    expect(decisiveQuality(3, 1)).toBe('bad');
    expect(decisiveQuality(4, 1)).toBe('neutral');
    expect(decisiveQuality(4, 2)).toBe('bad');
    expect(decisiveQuality(5, 1)).toBe('bad');
    expect(decisiveQuality(1, 1)).toBe('bad');
  });

  it('group and outcome: approve good / reject bad = right; neutral is its own class', () => {
    expect(decisiveGroup(true, true)).toBe('onYes');
    expect(decisiveGroup(true, false)).toBe('onNo');
    expect(decisiveGroup(false, true)).toBe('offYes');
    expect(decisiveGroup(false, false)).toBe('offNo');
    expect(decisiveOutcome(true, 'good')).toBe('right');
    expect(decisiveOutcome(true, 'bad')).toBe('wrong');
    expect(decisiveOutcome(false, 'bad')).toBe('right');
    expect(decisiveOutcome(false, 'good')).toBe('wrong');
    expect(decisiveOutcome(true, 'neutral')).toBe('neutral');
    expect(decisiveOutcome(false, 'neutral')).toBe('neutral');
  });

  it('rate and shrinkage', () => {
    expect(decisiveRate(cell(0, 0))).toBeNull();
    expect(decisiveRate(cell(3, 1, 9))).toBe(0.75);
    expect(decisiveShrunk(cell(3, 1), null)).toBe(0.75);
    expect(decisiveShrunk(cell(0, 0), 0.6)).toBeCloseTo(0.6, 12);
    expect(decisiveShrunk(cell(30, 0), 0.5, 30)).toBeCloseTo((30 + 15) / 60, 12);
    expect(DECISIVE_SHRINK_K).toBe(150);
  });
});

describe('decisive votes: scan', () => {
  it('only blue voters; red seats (P1..P4) never appear', () => {
    expect(scan.votes.length).toBeGreaterThan(0);
    expect(scan.votes.every((x) => ['梅林', '派西維爾', '忠臣'].includes(x.role))).toBe(true);
    expect(scan.votes.some((x) => ['P1', 'P2', 'P3', 'P4'].includes(x.player ?? ''))).toBe(false);
  });

  it('exactly 6 approvals: approvers are decisive, rejectors are not; exactly 5: rejectors are decisive', () => {
    // A 第 3 局第 3 次：6 票過關，投白的藍方 5 6 8 0 是關鍵，投黑的 7 9 不是
    const a3 = scan.votes.filter((x) => x.seq === 0 && x.round === 3 && x.attempt === 3);
    expect(a3.map((x) => x.player).sort()).toEqual(['P10', 'P5', 'P6', 'P8']);
    expect(a3.every((x) => x.approve)).toBe(true);
    // A 第 3 局第 1 次：5 票沒過，投黑的藍方 6 7 8 9 0 是關鍵，投白的 5 號不是
    const a1 = scan.votes.filter((x) => x.seq === 0 && x.round === 3 && x.attempt === 1);
    expect(a1.map((x) => x.player).sort()).toEqual(['P10', 'P6', 'P7', 'P8', 'P9']);
    expect(a1.every((x) => !x.approve)).toBe(true);
  });

  it('non-decisive votes (7+ or 4- approvals) are ignored', () => {
    expect(scan.votes.some((x) => x.seq === 0 && x.round <= 2)).toBe(false); // 7、8 票過
    expect(scan.votes.some((x) => x.seq === 2 && x.round === 3)).toBe(false); // 8 票過
    expect(scan.votes.some((x) => x.seq === 2 && x.round === 4 && (x.attempt === 3 || x.attempt === 4))).toBe(false); // 4 票
  });

  it('forced proposals and proposals whose votes contradict the result are excluded', () => {
    expect(scan.votes.some((x) => x.attempt === 5)).toBe(false);
    expect(scan.votes.some((x) => x.seq === 2 && x.round === 4 && x.attempt === 2)).toBe(false);
    expect(scan.inconsistent).toEqual({ twoRed: 1, r35: 1, r12: 0 });
    // 兩紅之後：A 3 次、B 2 次、C 第 4 局 3 次（第 2 次對不上、第 5 次強制）
    expect(scan.proposals).toEqual({ twoRed: 8, r35: 10, r12: 9 });
    expect(scan.games).toEqual({ twoRed: 3, r35: 4, r12: 4 });
  });

  it('incomplete configuration is skipped', () => {
    expect(scan.votes.some((x) => x.seq === 4)).toBe(false);
  });

  it('voting chances = blue seats × counted proposals', () => {
    expect(scan.opportunities.twoRed).toEqual({ 梅林: 8, 派西維爾: 8, 忠臣: 32 });
    expect(twoRed.all.opportunities).toBe(48);
    expect(r35.all.opportunities).toBe(60);
  });
});

describe('decisive votes: the eight cells (after red has two wins)', () => {
  it('all players', () => {
    expect(twoRed.all.grid).toEqual(grid({
      onYes: cell(3, 3),
      onNo: cell(2, 3, 3),
      offYes: cell(1, 1),
      offNo: cell(3, 3, 2),
    }));
    expect(twoRed.all.p0).toBeCloseTo(9 / 19, 12);
    expect(twoRed.all.unnamed).toBe(0);
  });

  it('fixed-strategy baselines on the same decisive spots (always approve / always reject / usual)', () => {
    // 全好的位置：場內 3 + 3、場外 1 + 3；會失敗的位置：場內 3 + 2、場外 1 + 3（中性不算）。
    expect(twoRed.all.baselines.approve).toBeCloseTo(10 / 19, 12);
    expect(twoRed.all.baselines.reject).toBeCloseTo(9 / 19, 12);
    expect(twoRed.all.baselines.usual).toBeCloseTo(10 / 19, 12); // 場內全好 6 + 場外會失敗 4
    expect(decisiveBaselines(grid({ onYes: cell(2, 0), offNo: cell(0, 1), onNo: cell(0, 0, 5) }))).toEqual({
      approve: 1, reject: 0, usual: 2 / 3,
    });
    expect(decisiveBaselines(grid({}))).toEqual({ approve: null, reject: null, usual: null });
  });

  it('each of the eight cells comes from the hand-built proposals', () => {
    expect(player(twoRed, 'P5')?.grid).toEqual(grid({ onYes: cell(1, 0) })); // 場內白對
    expect(player(twoRed, 'P7')?.grid).toEqual(grid({ onYes: cell(0, 1), onNo: cell(1, 1, 1) })); // 場內白錯、場內黑對／錯／中性
    expect(player(twoRed, 'P10')?.grid).toEqual(grid({ offYes: cell(1, 1), offNo: cell(1, 1, 1) })); // 場外白對／錯、場外黑對／錯／中性
    expect(player(twoRed, 'P8')?.grid).toEqual(grid({ onYes: cell(1, 1), onNo: cell(1, 0, 1), offNo: cell(0, 2) }));
  });

  it('per player totals, raw accuracy, shrunk score and order', () => {
    const p6 = player(twoRed, 'P6');
    expect(p6).toMatchObject({ right: 2, wrong: 1, neutral: 1, n: 3, games: 3 });
    expect(p6?.raw).toBeCloseTo(2 / 3, 12);
    expect(p6?.score).toBeCloseTo((2 + 150 * (9 / 19)) / (3 + 150), 12);
    expect(p6?.byRole['梅林']).toEqual(p6?.grid);
    expect(twoRed.players.map((p) => p.name)).toEqual(['P6', 'P5', 'P10', 'P8', 'P7', 'P9']);
  });

  it('role breakdown: Merlin, Percival, loyal', () => {
    const roleTotal = (role: '梅林' | '派西維爾' | '忠臣'): DecisiveCell => sumDecisive(twoRed.all.byRole[role].grid);
    expect(roleTotal('梅林')).toEqual(cell(2, 1, 1));
    expect(roleTotal('派西維爾')).toEqual(cell(1, 0, 0));
    expect(roleTotal('忠臣')).toEqual(cell(6, 9, 4));
    const sum = DECISIVE_GROUPS.reduce((s, g) => s + twoRed.all.grid[g].right, 0);
    expect(sum).toBe(9);
  });
});

describe('decisive votes: scope switch', () => {
  it('rounds 3-5 adds round 3 of game D (red had no wins); Mordred counts as red', () => {
    expect(r35.all.grid).toEqual(grid({
      onYes: cell(3, 6),
      onNo: cell(2, 3, 3),
      offYes: cell(1, 3),
      offNo: cell(3, 3, 2),
    }));
    expect(r35.all.unnamed).toBe(1); // D 的 9 號沒寫名字：算進全體、不算個人
    expect(player(r35, 'P5')?.grid).toEqual(grid({ onYes: cell(1, 1) }));
    // 梅林在只含莫德雷德的隊上投白 = 錯（他看不到莫德雷德）
    expect(twoRed.all.byRole['梅林'].mordredOnly).toEqual({ right: 0, wrong: 0 });
    expect(r35.all.byRole['梅林'].mordredOnly).toEqual({ right: 0, wrong: 1 });
    // 忠臣 7、8 與沒寫名字的 9 號；第 4 局只有莫德雷德的隊是中性，不算進只含莫德雷德的會失敗隊
    expect(r35.all.byRole['忠臣'].mordredOnly).toEqual({ right: 0, wrong: 3 });
    expect(twoRed.all.byRole['忠臣'].mordredOnly).toEqual({ right: 0, wrong: 0 });
  });

  it('rounds 1-2 only for analysis', () => {
    expect(r12.all.grid).toEqual(grid({ onNo: cell(1, 0), offNo: cell(4, 0) }));
    expect(player(r12, 'P6')?.grid).toEqual(grid({ onNo: cell(1, 0) }));
  });
});

describe('decisive votes: sorting', () => {
  const row = (name: string, g: Partial<DecisiveGrid>, score: number): DecisivePlayerRow => {
    const gg = grid(g);
    const tot = sumDecisive(gg);
    return {
      name, grid: gg, byRole: { 梅林: grid({}), 派西維爾: grid({}), 忠臣: gg }, right: tot.right, wrong: tot.wrong,
      neutral: tot.neutral, n: tot.right + tot.wrong, raw: decisiveRate(tot), score, games: 1,
    };
  };
  const rows = [
    row('甲', { offYes: cell(3, 0), offNo: cell(10, 10) }, 0.6),
    row('乙', { offYes: cell(4, 2), offNo: cell(20, 4) }, 0.7),
    row('丙', { offYes: cell(5, 5), offNo: cell(30, 0) }, 0.65),
  ];

  it('default by shrunk score', () => {
    expect(sortDecisiveRows(rows, 'score').map((r) => r.name)).toEqual(['乙', '丙', '甲']);
    expect(sortDecisiveRows(rows, 'n').map((r) => r.name)).toEqual(['丙', '乙', '甲']);
  });

  it('a group rate needs enough votes: 3/3 is listed after players with 5+ in that group', () => {
    expect(sortDecisiveRows(rows, 'offYes').map((r) => r.name)).toEqual(['乙', '丙', '甲']);
    expect(sortDecisiveRows(rows, 'no').map((r) => r.name)).toEqual(['丙', '乙', '甲']);
  });
});
