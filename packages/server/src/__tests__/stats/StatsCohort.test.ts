/**
 * 分組統計（九宮格，@avalon/shared stats/cohort.ts）：玩家依那一局開打前的 PR 分 強者／一般人／新手（預設 80／20），
 * 桌依 S 分 高端／普通／歡樂（預設 55／38），沒有 PR／S = 未評分；cohortGrid 給 3×3＋列合計＋欄合計＋全體，每格有人數。
 * 以及兩個用到它的統計：兩紅之後的派隊（twoRed.ts）與關鍵外白／內黑＋全部投票（decisiveVotes.ts）。
 * 虛構的局，名字 P1..P10，PR 是手寫的固定值。配置 123456：1 刺客、2 莫甘娜、3 莫德雷德、4 奧伯倫（紅）；5 派西維爾、6 梅林、7 8 9 0 忠臣。
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COHORT_CUTS, TWO_RED_CATEGORY_ORDER, TWO_RED_ROLES, TWO_RED_ROUNDS, TWO_RED_TOTAL_INDEX,
  cohortGrid, cohortHistogram, decisiveCohortData, decisiveCohortGrid, decisiveGridOf, decisiveReport, decisiveSeatRecords,
  decodeCohortCuts, decodeGamesDataset, encodeCohortCuts, histogramSplit, histogramTerciles, isDefaultCohortCuts, latestPlayerPr,
  playerTier, scanDecisiveVotes, sumDecisive, tableTier, twoRedCohortData, twoRedCohortGrid, twoRedProposals, twoRedTable,
  twoRedTierTables, validCohortCuts,
  type CohortRecord, type LineupTuple, type VotingProposal,
} from '@avalon/shared/stats';
import { makeDataset, type GameSpec } from './datasetBuilder';

const NAMES = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);

/** 陣容強度欄：座位 1..9、0 的 PR、暫定座位（SEATS 的索引）；S = 平均。 */
function lineup(prs: number[], provisional: number[] = []): LineupTuple {
  const s = prs.reduce((a, b) => a + b, 0) / prs.length;
  return [80, Math.round(s * 10), prs, provisional.reduce((m, i) => m | (1 << i), 0)];
}

describe('cohort: tiers and cut points', () => {
  it('player tiers by PR: lower bound inclusive, upper exclusive; no PR = unrated', () => {
    expect(DEFAULT_COHORT_CUTS).toEqual({ prHi: 80, prLo: 20, sHi: 55, sLo: 38 });
    expect([100, 80, 79, 20, 19, 0].map((pr) => playerTier(pr))).toEqual(['strong', 'strong', 'regular', 'regular', 'novice', 'novice']);
    expect(playerTier(null)).toBe('unrated');
    expect(playerTier(undefined)).toBe('unrated');
    expect(playerTier(70, { prHi: 70, prLo: 30, sHi: 55, sLo: 38 })).toBe('strong');
  });

  it('table tiers by S (one decimal): 55 high, 54.9 normal, 38 normal, 37.9 casual; no S = unrated', () => {
    expect([65, 55, 54.9, 38, 37.9, 10].map((s) => tableTier(s))).toEqual(['high', 'high', 'normal', 'normal', 'casual', 'casual']);
    expect(tableTier(null)).toBe('unrated');
    expect(tableTier(49.3, { prHi: 80, prLo: 20, sHi: 49.3, sLo: 40.9 })).toBe('high');
  });

  it('validation, defaults and the share-link form', () => {
    expect(validCohortCuts({ prHi: 80, prLo: 20, sHi: 55, sLo: 38 })).toBe(true);
    expect(validCohortCuts({ prHi: 20, prLo: 20, sHi: 55, sLo: 38 })).toBe(false); // 上 = 下
    expect(validCohortCuts({ prHi: 80, prLo: 20, sHi: 30, sLo: 38 })).toBe(false); // 上 < 下
    expect(validCohortCuts({ prHi: 80.5, prLo: 20, sHi: 55, sLo: 38 })).toBe(false); // PR 要整數
    expect(validCohortCuts({ prHi: 80, prLo: 20, sHi: 55.25, sLo: 38 })).toBe(false); // S 最多一位小數
    expect(validCohortCuts({ prHi: 100, prLo: 20, sHi: 55, sLo: 38 })).toBe(false); // 1–99
    expect(validCohortCuts({ prHi: 80, prLo: 0, sHi: 55, sLo: 38 })).toBe(false);
    expect(validCohortCuts(null)).toBe(false);
    expect(isDefaultCohortCuts(DEFAULT_COHORT_CUTS)).toBe(true);
    expect(encodeCohortCuts({ prHi: 69, prLo: 31, sHi: 49.3, sLo: 40.9 })).toBe('69-31-49.3-40.9');
    expect(decodeCohortCuts('69-31-49.3-40.9')).toEqual({ prHi: 69, prLo: 31, sHi: 49.3, sLo: 40.9 });
    expect(decodeCohortCuts('20-80-55-38')).toBeNull();
    expect(decodeCohortCuts('80-20-55')).toBeNull();
    expect(decodeCohortCuts('80-20-55-3x')).toBeNull();
    expect(decodeCohortCuts(null)).toBeNull();
  });
});

describe('cohort: the 3x3 grid', () => {
  // 一筆 = 一次事件；counts = [命中, 沒命中]
  const rec = (player: string | null, game: number, pr: number | null, s: number | null, hit: boolean): CohortRecord => ({
    player, game, pr, s, n: 1, counts: hit ? [1, 0] : [0, 1],
  });
  const records: CohortRecord[] = [
    rec('P1', 1, 90, 60, true), // 強者 × 高端
    rec('P1', 2, 85, 40, false), // 強者 × 普通
    rec('P2', 1, 80, 60, true), // 強者 × 高端（PR 80 = 強者）
    rec('P3', 1, 50, 60, false), // 一般人 × 高端
    rec('P4', 3, 10, 30, true), // 新手 × 歡樂
    rec('P5', 3, null, 30, true), // 未評分 × 歡樂
    rec(null, 4, 40, null, false), // 一般人 × 未評分（沒寫名字：不算人數）
  ];
  const grid = cohortGrid(records, DEFAULT_COHORT_CUTS, 2);

  it('cells hold the events, counts, distinct players and games', () => {
    expect(grid.cells.strong.high).toEqual({ n: 2, counts: [2, 0], players: 2, games: 1 });
    expect(grid.cells.strong.normal).toEqual({ n: 1, counts: [0, 1], players: 1, games: 1 });
    expect(grid.cells.regular.high).toEqual({ n: 1, counts: [0, 1], players: 1, games: 1 });
    expect(grid.cells.novice.casual).toEqual({ n: 1, counts: [1, 0], players: 1, games: 1 });
    expect(grid.cells.unrated.casual).toEqual({ n: 1, counts: [1, 0], players: 1, games: 1 });
    expect(grid.cells.regular.unrated).toEqual({ n: 1, counts: [0, 1], players: 0, games: 1 });
    expect(grid.cells.novice.high.n).toBe(0);
  });

  it('row totals by player tier, column totals by table tier, and everyone (unrated only in totals)', () => {
    expect(grid.rows.strong).toEqual({ n: 3, counts: [2, 1], players: 2, games: 2 });
    expect(grid.rows.regular).toEqual({ n: 2, counts: [0, 2], players: 1, games: 2 });
    expect(grid.rows.unrated).toEqual({ n: 1, counts: [1, 0], players: 1, games: 1 });
    expect(grid.cols.high).toEqual({ n: 3, counts: [2, 1], players: 3, games: 1 });
    expect(grid.cols.casual).toEqual({ n: 2, counts: [2, 0], players: 2, games: 1 });
    expect(grid.cols.unrated).toEqual({ n: 1, counts: [0, 1], players: 0, games: 1 });
    expect(grid.all).toEqual({ n: 7, counts: [4, 3], players: 5, games: 4 });
  });

  it('moving a cut point moves the boundary players', () => {
    const g = cohortGrid(records, { prHi: 81, prLo: 20, sHi: 61, sLo: 38 }, 2);
    expect(g.cells.strong.normal.n).toBe(2); // P1 的兩次（S 60 不再是高端）
    expect(g.cells.regular.normal.n).toBe(2); // P2（PR 80 不再是強者）、P3
    expect(g.cells.strong.high.n).toBe(0);
  });
});

describe('cohort: distributions', () => {
  it('histogram split and terciles', () => {
    const hist = new Array(101).fill(0);
    [10, 20, 30, 40, 50, 60, 70, 80, 90].forEach((pr) => { hist[pr] += 1; });
    expect(histogramSplit(hist, 80, 20)).toEqual({ hi: 2, mid: 6, lo: 1, total: 9 });
    expect(histogramTerciles(hist)).toEqual({ lo: 31, hi: 61 }); // < 31 有 3 個、< 61 有 6 個
    const s = new Array(1001).fill(0);
    s[550] = 1; s[549] = 1; s[380] = 1; s[379] = 1; // S 55.0、54.9、38.0、37.9
    expect(histogramSplit(s, 55, 38, 10)).toEqual({ hi: 1, mid: 2, lo: 1, total: 4 });
    expect(histogramTerciles(new Array(101).fill(0))).toBeNull();
  });
});

// ── 兩紅之後的派隊 ─────────────────────────────────────────────────────

/** [第幾局, 第幾次, 隊伍]；贊成座位不影響這個統計。 */
const tv = (round: number, attempt: number, team: string): VotingProposal => [round, attempt, team, attempt === 5 ? '' : team];

// A：第 3 局兩紅，隊長 5..9（第 5 次 = 尾派）。S = 55.0（高端，剛好在切點上）。
const TR_A: VotingProposal[] = [
  tv(1, 1, '156'), tv(1, 2, '257'), tv(2, 1, '3570'), tv(2, 2, '4590'),
  tv(3, 1, '5678'), tv(3, 2, '6378'), tv(3, 3, '7348'), tv(3, 4, '8490'), tv(3, 5, '9078'),
];
// B：第 4 局兩紅，隊長 5..9。S = 37.9（歡樂）；8 號暫定（沒有 PR）。
const TR_B: VotingProposal[] = [
  tv(1, 1, '271'), tv(2, 1, '3107'), tv(3, 1, '4015'),
  tv(4, 1, '57986'), tv(4, 2, '63079'), tv(4, 3, '74960'), tv(4, 4, '83160'), tv(4, 5, '91287'),
];
// C：第 5 局二比二，隊長 10 號（忠臣，只有莫德雷德），之後刺客、莫甘娜當隊長（不算）；沒評分的局。
const TR_C: VotingProposal[] = [
  tv(1, 1, '678'), tv(2, 1, '7890'), tv(3, 1, '8905'), tv(4, 1, '90567'), tv(5, 1, '03789'), tv(5, 2, '15678'), tv(5, 3, '25678'),
];
// D：第 5 局二比二，隊長 8、9 號；每個人 PR 45（一般人）、S = 45（普通）。
const TR_D: VotingProposal[] = [
  tv(1, 1, '318'), tv(2, 1, '4029'), tv(3, 1, '5627'), tv(4, 1, '67850'), tv(4, 2, '74539'), tv(5, 1, '83190'), tv(5, 2, '90568'),
];

const PRS_A = [90, 85, 70, 60, 50, 20, 19, 5, 80, 71]; // 平均 55.0
const PRS_B = [30, 30, 30, 30, 50, 20, 19, 50, 80, 40]; // 平均 37.9

const TR_SPECS: GameSpec[] = [
  { id: 'A', names: NAMES, rounds: 'RRR--', missions: 'oox|ooox|ooox||', votes: TR_A, lineup: lineup(PRS_A) },
  { id: 'B', names: NAMES, rounds: 'RBRR-', missions: 'oox|oooo|ooox|oooxx|', votes: TR_B, lineup: lineup(PRS_B, [7]) },
  { id: 'C', names: NAMES, rounds: 'BRBRB', outcome: '三藍活', missions: 'ooo|ooox|oooo|oooxx|ooooo', votes: TR_C },
  { id: 'D', names: NAMES, rounds: 'BBRRR', missions: 'ooo|oooo|ooox|oooxx|oooox', votes: TR_D, lineup: lineup(new Array(10).fill(45)) },
];

const trGames = decodeGamesDataset(makeDataset(TR_SPECS)).games;
const trData = twoRedProposals(trGames);

describe('two reds by group', () => {
  it("each proposal carries the leader's pre-game PR and the game's S", () => {
    expect(trData.proposals.map((p) => [trGames[p.seq].id, p.player, p.pr, p.s, p.category])).toEqual([
      ['A', 'P5', 50, 55, 'allGood'],
      ['A', 'P6', 20, 55, 'mordred'],
      ['A', 'P7', 19, 55, 'thumb'],
      ['A', 'P8', 5, 55, 'thumb'],
      ['A', 'P9', 80, 55, 'allGood'],
      ['B', 'P5', 50, 37.9, 'allGood'],
      ['B', 'P6', 20, 37.9, 'mordred'],
      ['B', 'P7', 19, 37.9, 'oneThumb'],
      ['B', 'P8', null, 37.9, 'twoPlusRed'], // 暫定 → 沒有 PR
      ['B', 'P9', 80, 37.9, 'twoPlusRed'],
      ['C', 'P10', null, null, 'mordred'], // 沒評分的局
      ['D', 'P8', 45, 45, 'thumb'],
      ['D', 'P9', 45, 45, 'allGood'],
    ]);
  });

  it('a 3x3 grid for one role / round / proposal', () => {
    const g = twoRedCohortGrid(trData.proposals, DEFAULT_COHORT_CUTS, { role: '忠臣', round: 3, slot: 'total' });
    const thumb = TWO_RED_CATEGORY_ORDER.indexOf('thumb');
    const allGood = TWO_RED_CATEGORY_ORDER.indexOf('allGood');
    expect(g.cells.novice.high.n).toBe(2); // P7（19）、P8（5）
    expect(g.cells.novice.high.counts[thumb]).toBe(2);
    expect(g.cells.novice.high.players).toBe(2);
    expect(g.cells.strong.high.counts[allGood]).toBe(1); // P9 的尾派（PR 80 = 強者）
    expect(g.all.n).toBe(3);
    const forced = twoRedCohortGrid(trData.proposals, DEFAULT_COHORT_CUTS, { role: '忠臣', round: 3, slot: 5 });
    expect(forced.all.n).toBe(1);
    expect(forced.rows.strong.n).toBe(1);
  });

  it('tier tables: each group, everyone = the plain table, and group sizes', () => {
    const tiers = twoRedTierTables(trData.proposals, DEFAULT_COHORT_CUTS);
    const plain = twoRedTable(trData.proposals);
    for (const role of TWO_RED_ROLES) {
      for (const round of TWO_RED_ROUNDS) {
        tiers.tables.all[role][round].forEach((c, i) => {
          const { players: _players, ...counts } = c;
          void _players;
          expect(counts).toEqual(plain[role][round][i]);
        });
      }
    }
    expect(tiers.tables.novice['忠臣'][3][TWO_RED_TOTAL_INDEX]).toMatchObject({ n: 2, thumb: 2, players: 2 });
    expect(tiers.tables.regular['梅林'][4][TWO_RED_TOTAL_INDEX]).toMatchObject({ n: 1, mordred: 1 }); // P6 PR 20 = 一般人
    expect(tiers.tables.unrated['忠臣'][4][3]).toMatchObject({ n: 1, twoPlusRed: 1 }); // B 的 P8（暫定）第 4 次
    expect(tiers.proposals).toEqual({ strong: 2, regular: 6, novice: 3, unrated: 2, all: 13 });
    expect(tiers.players).toEqual({ strong: 1, regular: 4, novice: 2, unrated: 2, all: 6 });
    // 切點改成 81：P9（80）變成一般人
    const moved = twoRedTierTables(trData.proposals, { ...DEFAULT_COHORT_CUTS, prHi: 81 });
    expect(moved.proposals.strong).toBe(0);
    expect(moved.proposals.regular).toBe(8);
  });

  it("data for the site: compact proposals, each player's latest PR, distributions", () => {
    const d = twoRedCohortData(trGames);
    expect(d.proposals).toHaveLength(13);
    expect(Object.keys(d.proposals[0]).sort()).toEqual(['category', 'player', 'pr', 'role', 'round', 's', 'seq', 'slot']);
    // 最近一局有 PR 的 PR：D（全部 45）是最後一局；P8 在 B 是暫定、在 D 是 45
    expect(d.playerPr).toEqual(Object.fromEntries(NAMES.map((n) => [n, 45])));
    expect(latestPlayerPr(trGames.slice(0, 2)).get('P8')).toBe(5);
    expect(d.histogram.gameUnrated).toBe(1);
    expect(d.histogram.gameS[550]).toBe(1);
    expect(d.histogram.gameS[379]).toBe(1);
    expect(d.histogram.seatUnrated).toBe(11); // C 的 10 個座位 + B 的 8 號
    expect(d.histogram.seatPr[45]).toBe(10);
    expect(d.histogram.playerPr[45]).toBe(10);
    expect(cohortHistogram([]).playerUnrated).toBe(0);
  });
});

// ── 關鍵外白／內黑＋全部投票 ─────────────────────────────────────────────

const dv = (round: number, attempt: number, team: string, approved: string): VotingProposal => [round, attempt, team, approved];

// 同 StatsDecisive.test.ts 的 A：前兩局都紅 → 第 3 局是兩紅之後。
const DEC_A: VotingProposal[] = [
  dv(1, 1, '156', '1234567'), // 會失敗（刺客），7 票過
  dv(2, 1, '2567', '12345678'), // 會失敗（莫甘娜），8 票過
  dv(3, 1, '1578', '12345'), // 會失敗，5 票沒過：投黑的藍方都是關鍵
  dv(3, 2, '5679', '56790'), // 全好，5 票沒過：8 號場外黑 = 關鍵（錯）
  dv(3, 3, '5689', '125680'), // 全好，6 票過關：投白的藍方都是關鍵
];
const DEC_GAMES = decodeGamesDataset(makeDataset([
  { id: 'A', names: NAMES, rounds: 'RRB--', missions: 'oox|ooxo|oooo||', votes: DEC_A, lineup: lineup(PRS_A) },
])).games;

describe('decisive and all votes by group', () => {
  const scan = scanDecisiveVotes(DEC_GAMES, { allVotes: true });

  it('without the option the scan has no all-vote records; with it, one record per game / seat / scope', () => {
    expect(scanDecisiveVotes(DEC_GAMES).allVotes).toBeUndefined();
    const all = scan.allVotes ?? [];
    // 6 個藍方座位 × 兩個範圍（第 1～2 局、第 3～5 局兩紅之後）
    expect(all).toHaveLength(12);
    expect(all.reduce((s, r) => s + r.n, 0)).toBe(6 * 5);
  });

  it('a hand-counted seat: P8 (PR 5, a loyal servant)', () => {
    const p8 = (scan.allVotes ?? []).filter((r) => r.player === 'P8');
    const r35 = p8.find((r) => r.scope === 'r35');
    const r12 = p8.find((r) => r.scope === 'r12');
    expect(r35).toMatchObject({ pr: 5, s: 55, n: 3, role: '忠臣', twoRed: true });
    // 3-1 在隊上投黑擋下會失敗的隊（場內黑對）、3-2 不在隊上投黑擋下全好的隊（場外黑錯）、3-3 在隊上投白放行全好的隊（場內白對）
    const g35 = decisiveGridOf(r35!);
    expect(g35.onNo).toEqual({ right: 1, wrong: 0, neutral: 0 });
    expect(g35.offNo).toEqual({ right: 0, wrong: 1, neutral: 0 });
    expect(g35.onYes).toEqual({ right: 1, wrong: 0, neutral: 0 });
    // 1-1 不在隊上投黑（對）、2-1 不在隊上投白（錯）
    const g12 = decisiveGridOf(r12!);
    expect(g12.offNo).toEqual({ right: 1, wrong: 0, neutral: 0 });
    expect(g12.offYes).toEqual({ right: 0, wrong: 1, neutral: 0 });
  });

  it('decisive records add up to the existing report; groups follow the PR cuts', () => {
    const data = decisiveCohortData(scan, 'twoRed', DEC_GAMES);
    const grid = decisiveCohortGrid(data.decisive, DEFAULT_COHORT_CUTS);
    expect(decisiveGridOf(grid.all)).toEqual(decisiveReport(scan, 'twoRed').all.grid);
    expect(decisiveSeatRecords(scan.votes).length).toBeGreaterThan(0);
    // 3-3 的關鍵白：5（P5 PR 50）、6（P6 20）、8（P8 5）場內白對；0（P10 71）場外白對
    const yes = (cell: { counts: readonly number[] }): number => decisiveGridOf(cell).onYes.right;
    expect(yes(grid.rows.regular)).toBe(2);
    expect(yes(grid.rows.novice)).toBe(1);
    expect(decisiveGridOf(grid.rows.regular).offYes.right).toBe(1);
    // 全部投票：兩紅之後 6 個座位 × 3 次
    const allGrid = decisiveCohortGrid(data.all, DEFAULT_COHORT_CUTS);
    expect(allGrid.all.n).toBe(18);
    expect(allGrid.all.players).toBe(6);
    expect(allGrid.cols.high.n).toBe(18); // S = 55.0 → 高端
    // 只看梅林（6 號，PR 20 → 一般人）
    const merlin = decisiveCohortGrid(data.all, DEFAULT_COHORT_CUTS, '梅林');
    expect(merlin.all.n).toBe(3);
    expect(merlin.rows.regular.n).toBe(3);
    const tot = sumDecisive(decisiveGridOf(merlin.all));
    expect(tot.right + tot.wrong + tot.neutral).toBe(3);
  });

  it('the r12 scope keeps only rounds 1-2', () => {
    const data = decisiveCohortData(scan, 'r12', DEC_GAMES);
    expect(data.all.every((r) => r.scope === 'r12')).toBe(true);
    expect(data.all.reduce((s, r) => s + r.n, 0)).toBe(12);
  });
});
