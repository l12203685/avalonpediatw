/**
 * 玩家雷達「兩紅之後的派隊」（@avalon/shared stats/twoRed.ts）：紅方剛好兩勝時藍方隊長派出的隊，依隊長角色、第幾局、
 * 第幾次提議分，分類互斥（第 3、5 局：全好／全沒拇指但派到莫德雷德／派到至少一根拇指；第 4 局：全好／全沒拇指但
 * 派到莫德雷德／只含一拇指／含兩壞以上）。虛構的局，名字 P1..P10。
 * 配置 123456：1 刺客、2 莫甘娜、3 莫德雷德、4 奧伯倫（紅）；5 派西維爾、6 梅林、7 8 9 0 忠臣（藍）。
 */
import { describe, expect, it } from 'vitest';
import {
  MERLIN_VISIBLE_REDS, TWO_RED_CATEGORIES, TWO_RED_ROLES, TWO_RED_ROUNDS, TWO_RED_TOTAL_INDEX,
  computeTwoRedReport, contiguousProposals, decodeConfig, decodeGamesDataset, deriveLeaderSeats, redWinsBefore, teamReds, twoRedCategory,
  twoRedProposals, twoRedShare, twoRedTable, type VotingProposal,
} from '@avalon/shared/stats';
import { makeDataset, type GameSpec } from './datasetBuilder';

const NAMES = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
const ROLES = decodeConfig('123456');

/** [第幾局, 第幾次, 隊伍]；贊成座位不影響這個統計，寫成隊伍本身。 */
const v = (round: number, attempt: number, team: string): VotingProposal => [round, attempt, team, attempt === 5 ? '' : team];

// A：前兩局都紅 → 第 3 局是兩紅。隊長從 1 號開始輪：第 1 局 1、2；第 2 局 3、4；第 3 局 5、6、7、8、9（第 5 次 = 尾派）。
const GAME_A: VotingProposal[] = [
  v(1, 1, '156'), v(1, 2, '257'),
  v(2, 1, '3570'), v(2, 2, '4590'),
  v(3, 1, '5678'), // 派西維爾：全好
  v(3, 2, '6378'), // 梅林：只有莫德雷德 → 全沒拇指但派到莫德雷德
  v(3, 3, '7348'), // 忠臣：莫德雷德＋奧伯倫 → 有拇指（奧伯倫梅林看得到）
  v(3, 4, '8490'), // 忠臣：奧伯倫 → 有拇指
  v(3, 5, '9078'), // 忠臣，尾派：全好
];

// B：紅藍紅 → 第 4 局是兩紅。隊長從 2 號開始輪：第 1 局 2；第 2 局 3；第 3 局 4；第 4 局 5、6、7、8、9。
const GAME_B: VotingProposal[] = [
  v(1, 1, '271'), v(2, 1, '3107'), v(3, 1, '4015'),
  v(4, 1, '57986'), // 派西維爾：全好
  v(4, 2, '63079'), // 梅林：唯一的紅是莫德雷德
  v(4, 3, '74960'), // 忠臣：只有奧伯倫 → 只含一拇指
  v(4, 4, '83160'), // 忠臣：莫德雷德＋刺客 → 兩壞以上（莫德雷德也算）
  v(4, 5, '91287'), // 忠臣，尾派：刺客＋莫甘娜 → 兩壞以上
];

// C：藍紅藍紅 → 第 5 局二比二。隊長從 6 號開始輪：6、7、8、9（第 1～4 局各一次），第 5 局 0、1、2。
const GAME_C: VotingProposal[] = [
  v(1, 1, '678'), v(2, 1, '7890'), v(3, 1, '8905'), v(4, 1, '90567'),
  v(5, 1, '03789'), // 忠臣：只有莫德雷德
  v(5, 2, '15678'), // 刺客當隊長：不算
  v(5, 3, '25678'), // 莫甘娜當隊長：不算
];

// D：藍藍紅紅 → 第 4 局紅方一勝（不算）、第 5 局二比二（算）。隊長從 3 號開始輪。
const GAME_D: VotingProposal[] = [
  v(1, 1, '318'), v(2, 1, '4029'), v(3, 1, '5627'),
  v(4, 1, '67850'), v(4, 2, '74539'), // 第 4 局開始前紅方一勝：不算
  v(5, 1, '83190'), // 忠臣：莫德雷德＋刺客 → 有拇指（第 5 局不分一拇指／兩壞）
  v(5, 2, '90568'), // 忠臣：全好
];

// I：紀錄裡沒有第 2 局。照紀錄的順序輪替會推出 1、2、3、4、5、6、7 號（每隊都含那位，過得了門檻），
// 但第 3 局真正的隊長是缺口之後錯開兩位的人，所以這局不能算。
const GAME_I: VotingProposal[] = [
  v(1, 1, '156'), v(1, 2, '257'),
  v(3, 1, '3410'), v(3, 2, '4310'), v(3, 3, '5340'), v(3, 4, '6340'), v(3, 5, '7340'),
];

const SPECS: GameSpec[] = [
  { id: 'A', names: NAMES, rounds: 'RRR--', missions: 'oox|ooox|ooox||', votes: GAME_A },
  { id: 'B', names: NAMES, rounds: 'RBRR-', missions: 'oox|oooo|ooox|oooxx|', votes: GAME_B },
  { id: 'C', names: NAMES, rounds: 'BRBRB', outcome: '三藍活', missions: 'ooo|ooox|oooo|oooxx|ooooo', votes: GAME_C },
  { id: 'D', names: NAMES, rounds: 'BBRRR', missions: 'ooo|oooo|ooox|oooxx|oooox', votes: GAME_D },
  // F：第 2 局沒有結果 → 比分不知道，不算
  { id: 'F', names: NAMES, rounds: 'R?R--', votes: [v(1, 1, '156'), v(2, 1, '2567'), v(3, 1, '3567'), v(4, 1, '45678'), v(4, 2, '56789')] },
  // G：兩紅但隊長推不出來（隊長不在隊上）→ 記為略過
  { id: 'G', names: NAMES, rounds: 'RR---', votes: [v(1, 1, '789'), v(2, 1, '7890'), v(3, 1, '7890'), v(3, 2, '1234')] },
  // I：兩紅、但提議紀錄缺了整個第 2 局 → 輪替在缺口之後錯位（照輪替推得出隊長，但不可信）→ 記為略過
  { id: 'I', names: NAMES, rounds: 'RR---', votes: GAME_I },
  // H：配置不完整（有重複的數字）→ 不算
  { id: 'H', names: NAMES, config: '123455', rounds: 'RR---', votes: GAME_A },
];

const decoded = decodeGamesDataset(makeDataset(SPECS));
const games = decoded.games;
const data = twoRedProposals(games);

describe('two reds: categories', () => {
  it('thumbs are the reds Merlin sees: Mordred is not one, Oberon is', () => {
    expect([...MERLIN_VISIBLE_REDS].sort()).toEqual(['刺客', '奧伯倫', '莫甘娜'].sort());
    expect(teamReds('3', ROLES)).toEqual({ reds: 1, thumbs: 0 });
    expect(teamReds('4', ROLES)).toEqual({ reds: 1, thumbs: 1 });
    expect(teamReds('1234', ROLES)).toEqual({ reds: 4, thumbs: 3 });
    expect(teamReds('5678', ROLES)).toEqual({ reds: 0, thumbs: 0 });
  });

  it('missions 3 and 5: all good / no thumb but Mordred / at least one thumb', () => {
    for (const round of [3, 5] as const) {
      expect(twoRedCategory(round, 0, 0)).toBe('allGood');
      expect(twoRedCategory(round, 1, 0)).toBe('mordred');
      expect(twoRedCategory(round, 1, 1)).toBe('thumb');
      expect(twoRedCategory(round, 2, 1)).toBe('thumb'); // 拇指＋莫德雷德
      expect(twoRedCategory(round, 3, 3)).toBe('thumb');
    }
  });

  it('mission 4: all good / Mordred the only red / exactly one thumb / two or more reds', () => {
    expect(twoRedCategory(4, 0, 0)).toBe('allGood');
    expect(twoRedCategory(4, 1, 0)).toBe('mordred');
    expect(twoRedCategory(4, 1, 1)).toBe('oneThumb');
    expect(twoRedCategory(4, 2, 1)).toBe('twoPlusRed'); // 莫德雷德＋一拇指
    expect(twoRedCategory(4, 2, 2)).toBe('twoPlusRed');
  });

  it('every round lists its categories in table order', () => {
    expect(TWO_RED_CATEGORIES).toEqual({
      3: ['allGood', 'mordred', 'thumb'],
      4: ['allGood', 'mordred', 'oneThumb', 'twoPlusRed'],
      5: ['allGood', 'mordred', 'thumb'],
    });
  });
});

describe('two reds: which proposals count', () => {
  it('the fixtures rotate the leader as described', () => {
    expect(deriveLeaderSeats(GAME_A.map((p) => p[2]))).toEqual([...'123456789']);
    expect(deriveLeaderSeats(GAME_B.map((p) => p[2]))).toEqual([...'23456789']);
    expect(deriveLeaderSeats(GAME_C.map((p) => p[2]))).toEqual([...'6789012']);
    expect(deriveLeaderSeats(GAME_D.map((p) => p[2]))).toEqual([...'3456789']);
  });

  it('red wins before a round come from the mission results; an unknown result gives null', () => {
    expect(redWinsBefore({ rounds: ['紅', '紅', '', '', ''] }, 3)).toBe(2);
    expect(redWinsBefore({ rounds: ['紅', '藍', '紅', '', ''] }, 4)).toBe(2);
    expect(redWinsBefore({ rounds: ['藍', '藍', '紅', '紅', ''] }, 4)).toBe(1);
    expect(redWinsBefore({ rounds: ['紅', '紅', '紅', '', ''] }, 4)).toBe(3); // 三紅：遊戲已結束
    expect(redWinsBefore({ rounds: ['紅', '?', '紅', '', ''] }, 4)).toBeNull();
  });

  it('only blue leaders while red has exactly two wins; slot 5 is the forced proposal', () => {
    const rows = data.proposals.map((p) => [games[p.seq].id, p.round, p.slot, p.role, p.player, p.category]);
    expect(rows).toEqual([
      ['A', 3, 1, '派西維爾', 'P5', 'allGood'],
      ['A', 3, 2, '梅林', 'P6', 'mordred'],
      ['A', 3, 3, '忠臣', 'P7', 'thumb'],
      ['A', 3, 4, '忠臣', 'P8', 'thumb'],
      ['A', 3, 5, '忠臣', 'P9', 'allGood'],
      ['B', 4, 1, '派西維爾', 'P5', 'allGood'],
      ['B', 4, 2, '梅林', 'P6', 'mordred'],
      ['B', 4, 3, '忠臣', 'P7', 'oneThumb'],
      ['B', 4, 4, '忠臣', 'P8', 'twoPlusRed'],
      ['B', 4, 5, '忠臣', 'P9', 'twoPlusRed'],
      ['C', 5, 1, '忠臣', 'P10', 'mordred'],
      ['D', 5, 1, '忠臣', 'P8', 'thumb'],
      ['D', 5, 2, '忠臣', 'P9', 'allGood'],
    ]);
    // A、B、C、D、推不出隊長的 G 與提議紀錄有缺的 I 有兩紅局面；F（比分不知道）、H（配置不完整）沒有
    expect(data.twoRedGames).toBe(6);
    expect(data.skippedGames).toBe(2);
  });

  it('a game whose proposal record has a gap is skipped even when the rotation would pass', () => {
    expect(deriveLeaderSeats(GAME_I.map((p) => p[2]))).toEqual([...'1234567']);
    expect(contiguousProposals(GAME_I)).toBe(false);
    for (const g of [GAME_A, GAME_B, GAME_C, GAME_D]) expect(contiguousProposals(g)).toBe(true);
    expect(contiguousProposals([v(1, 2, '156'), v(1, 3, '257')])).toBe(false); // 不是從第 1 次開始
    expect(contiguousProposals([v(1, 1, '156'), v(1, 3, '257')])).toBe(false); // 次數跳號
    expect(contiguousProposals([])).toBe(false);
  });
});

describe('two reds: tables', () => {
  const all = twoRedTable(data.proposals);

  it('each row adds up: the categories of its round sum to n, and the total row sums the slots', () => {
    for (const role of TWO_RED_ROLES) {
      for (const round of TWO_RED_ROUNDS) {
        const rows = all[role][round];
        for (const row of rows) {
          expect(TWO_RED_CATEGORIES[round].reduce((s, c) => s + row[c], 0)).toBe(row.n);
        }
        expect(rows.slice(0, TWO_RED_TOTAL_INDEX).reduce((s, r) => s + r.n, 0)).toBe(rows[TWO_RED_TOTAL_INDEX].n);
      }
    }
  });

  it('loyal, mission 5: the forced row and the total', () => {
    const loyal5 = all['忠臣'][5];
    expect(loyal5[0]).toEqual({ n: 2, allGood: 0, mordred: 1, thumb: 1, oneThumb: 0, twoPlusRed: 0 });
    expect(loyal5[1]).toEqual({ n: 1, allGood: 1, mordred: 0, thumb: 0, oneThumb: 0, twoPlusRed: 0 });
    expect(loyal5[TWO_RED_TOTAL_INDEX].n).toBe(3);
    expect(all['忠臣'][4][4]).toEqual({ n: 1, allGood: 0, mordred: 0, thumb: 0, oneThumb: 0, twoPlusRed: 1 });
    expect(all['忠臣'][3][4]).toEqual({ n: 1, allGood: 1, mordred: 0, thumb: 0, oneThumb: 0, twoPlusRed: 0 });
  });

  it('a player report: only that player, next to everyone', () => {
    const r = computeTwoRedReport(games, 'P8');
    expect(r.playerGames).toBe(3);
    expect(r.player['忠臣'][3][3]).toEqual({ n: 1, allGood: 0, mordred: 0, thumb: 1, oneThumb: 0, twoPlusRed: 0 });
    expect(r.player['忠臣'][4][3].twoPlusRed).toBe(1);
    expect(r.player['忠臣'][5][0]).toEqual({ n: 1, allGood: 0, mordred: 0, thumb: 1, oneThumb: 0, twoPlusRed: 0 });
    expect(r.player['梅林'][3][TWO_RED_TOTAL_INDEX].n).toBe(0);
    expect(r.all).toEqual(all);
    expect(r.twoRedGames).toBe(6);
    expect(r.skippedGames).toBe(2);
    expect(computeTwoRedReport([], 'P8', { data, all })).toEqual(r);
  });

  it('share: one decimal, null for no proposals', () => {
    expect(twoRedShare(1, 3)).toBe(33.3);
    expect(twoRedShare(0, 0)).toBeNull();
  });
});
