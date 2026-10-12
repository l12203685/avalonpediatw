/**
 * Stats replies (2026-10-10, two-stage outcome + excess ranking 2026-10-12) —
 * the pure formatter shared by the Discord and LINE bots
 * (bots/stats/statsReplies.ts), the LINE text-command parser, and a smoke
 * pass over the real analysis_cache.json through statsQueries.ts.
 *
 * Win-rate semantics follow docs/stats/two_stage_outcome.md: the card leads
 * with the FINAL win rate (藍勝 = 三藍且梅林活) and the excess over the
 * role-expected rate; the ranking is by excess win rate.
 */
import { describe, expect, it } from 'vitest';
import type { LeaderboardBoard, LeaderboardSection, OverviewData, PlayerStats } from '../services/sheetsAnalysis';
import { getAllPlayerStats } from '../services/sheetsAnalysis';
import {
  DIGEST_RECENT_SIZE,
  LEADERBOARD_FALLBACK_MIN_GAMES,
  LEADERBOARD_SHRINK_K,
  MAX_NAME_CANDIDATES,
  STATS_REPLY_MAX_CHARS,
  STATS_SITE_URL,
  boardView,
  clampReply,
  findBoard,
  formatChemistry,
  formatLeaderboard,
  formatNameProblem,
  formatPlayerCard,
  formatStatsHelp,
  leaderboardLines,
  lookupPair,
  matchPlayerName,
  overviewTotalsLine,
  roleTitlesLine,
  selectLeaderboard,
  shrunkExcess,
  signed,
} from '../bots/stats/statsReplies';
import { parseStatsCommand } from '../bots/stats/textCommands';
import { chemistryReply, leaderboardReply, playerCardReply, weeklyDigestText } from '../bots/stats/statsQueries';

const DISCORD_MAX = 2000;

function player(name: string, totalGames: number, extra: Partial<PlayerStats> = {}): PlayerStats {
  return {
    name,
    totalGames,
    winRate: 55,
    roleTheory: 54.5,
    positionTheory: 0,
    redWin: 50.2,
    blueWin: 58,
    red3Red: 0,
    redMerlinDead: 0,
    redMerlinAlive: 0,
    blue3Red: 0,
    blueMerlinDead: 0,
    blueMerlinAlive: 0,
    roleWinRates: {},
    roleDistribution: {},
    redRoleRate: 40,
    blueRoleRate: 60,
    seatWinRates: {},
    seatRedWinRates: {},
    seatBlueWinRates: {},
    rawRoleGames: {},
    rawRedWins: 0,
    rawBlueWins: 0,
    rawTotalWins: 0,
    rawRedGames: Math.round(totalGames * 0.4),
    rawBlueGames: totalGames - Math.round(totalGames * 0.4),
    ...extra,
  };
}

/** A player as served by sheetsAnalysis (two-stage fields filled in). */
function contractPlayer(name: string, totalGames: number, finalWinRate: number, excessWinRate: number | null, extra: Partial<PlayerStats> = {}): PlayerStats {
  return player(name, totalGames, {
    finalWinRate,
    excessWinRate,
    expectedFinalWinRate: excessWinRate === null ? null : finalWinRate - excessWinRate,
    finalRedWinRate: 70.1,
    finalBlueWinRate: 30,
    missionWinRate: 59,
    merlinSurvivalRate: 56,
    rawBlueThreeBlue: 300,
    ...extra,
  });
}

// The real sheet has names that differ only by case (Sin / SIN / sin).
const NAMES = ['Sin', 'HAO', '尼克', '海月', 'Alan', 'Amy', 'Andrew', 'Arth', 'Kay', 'Sam', 'SIN', 'Hao', 'sin', 'hao', '小向', '小背包'];

describe('matchPlayerName', () => {
  it('exact match wins, and reports other spellings that differ only by case', () => {
    expect(matchPlayerName('Sin', NAMES)).toEqual({ kind: 'found', name: 'Sin', caseVariants: ['SIN', 'sin'] });
    expect(matchPlayerName('sin', NAMES)).toEqual({ kind: 'found', name: 'sin', caseVariants: ['Sin', 'SIN'] });
    expect(matchPlayerName('尼克', NAMES)).toEqual({ kind: 'found', name: '尼克', caseVariants: [] });
  });

  it('falls back to a unique case-insensitive match', () => {
    expect(matchPlayerName('ALAN', NAMES)).toEqual({ kind: 'found', name: 'Alan', caseVariants: [] });
    // Full-width letters are folded (NFKC) before comparing.
    expect(matchPlayerName('ａｌａｎ', NAMES)).toEqual({ kind: 'found', name: 'Alan', caseVariants: [] });
  });

  it('several case-insensitive hits are ambiguous (listed in the given order)', () => {
    expect(matchPlayerName('SIn', NAMES)).toEqual({
      kind: 'ambiguous',
      query: 'SIn',
      candidates: ['Sin', 'SIN', 'sin'],
      total: 3,
    });
  });

  it('then a unique substring', () => {
    expect(matchPlayerName('海', NAMES)).toEqual({ kind: 'found', name: '海月', caseVariants: [] });
    expect(matchPlayerName('drew', NAMES)).toEqual({ kind: 'found', name: 'Andrew', caseVariants: [] });
  });

  it('several substring hits are ambiguous and capped at 5 candidates', () => {
    const m = matchPlayerName('a', NAMES);
    expect(m.kind).toBe('ambiguous');
    if (m.kind !== 'ambiguous') return;
    expect(m.total).toBeGreaterThan(MAX_NAME_CANDIDATES);
    expect(m.candidates).toHaveLength(MAX_NAME_CANDIDATES);
    expect(m.candidates).toEqual(['HAO', 'Alan', 'Amy', 'Andrew', 'Arth']);

    expect(matchPlayerName('小', NAMES)).toMatchObject({ kind: 'ambiguous', candidates: ['小向', '小背包'], total: 2 });
  });

  it('no hit (or empty input) is none', () => {
    expect(matchPlayerName('不存在', NAMES)).toEqual({ kind: 'none', query: '不存在' });
    expect(matchPlayerName('   ', NAMES)).toEqual({ kind: 'none', query: '' });
  });
});

describe('formatNameProblem', () => {
  it('ambiguous: lists the candidates and how many matched', () => {
    const text = formatNameProblem({ kind: 'ambiguous', query: 'a', candidates: ['HAO', 'Alan', 'Amy', 'Andrew', 'Arth'], total: 9 });
    expect(text).toContain('「a」符合 9 位玩家');
    expect(text).toContain('HAO、Alan、Amy、Andrew、Arth 等 9 位');
  });

  it('none: says so and suggests the lookup command', () => {
    const text = formatNameProblem({ kind: 'none', query: '路人甲' });
    expect(text).toContain('找不到玩家「路人甲」');
    expect(text).toContain('/戰績 名字');
  });

  it('echoes at most 20 characters of what the user typed', () => {
    const text = formatNameProblem({ kind: 'none', query: 'x'.repeat(500) });
    expect(text).toContain(`「${'x'.repeat(20)}…」`);
    expect(text.length).toBeLessThan(200);
  });
});

describe('signed', () => {
  it.each([
    [6.3, '+6.3'],
    [0.04, '0.0'],
    [-0.04, '0.0'],
    [0, '0.0'],
    [-2.06, '-2.1'],
    [-12, '-12.0'],
    [null, '—'],
    [undefined, '—'],
    [Number.NaN, '—'],
  ])('%s → %s', (value, expected) => {
    expect(signed(value as number | null | undefined)).toBe(expected);
  });
});

describe('formatPlayerCard', () => {
  it('leads with final win rate + excess, walks 任務結算 → 刺殺結算 → 最終, per-side final rates, strongest roles, archetype, playstyle, site link', () => {
    const text = formatPlayerCard({
      player: contractPlayer('HAO', 1013, 38.5, 6.3, {
        winRate: 59,
        roleTheory: 59.1,
        redWin: 56.6,
        blueWin: 60.5,
        rawRedGames: 378,
        rawBlueGames: 635,
        rawRedMerlinDead: 110,
        rawRedMerlinAlive: 140,
      }),
      strength: {
        roles: [
          { role: '刺客', winRate: 62.3, sampleSize: 106, zScore: 0.9, color: 'high' },
          { role: '梅林', winRate: 65.6, sampleSize: 96, zScore: 0.8, color: 'high' },
          { role: '莫甘娜', winRate: 50.6, sampleSize: 89, zScore: -0.2, color: 'neutral' },
        ],
        topRoles: ['刺客', '梅林'],
        bottomRoles: ['莫甘娜'],
        hasData: true,
      },
      archetype: {
        data: {
          axes: { honesty: 83, consistency: 49.8, stickiness: 58.6, flip: 50.2 },
          percentiles: { honesty: 36.5, consistency: 19.3, stickiness: 73.4, flip: 80.7 },
          sampleSize: 1010,
          hasData: true,
        },
        axisLabels: { honesty: '誠實度', consistency: '一致度', stickiness: '專精度', flip: '浮動度' },
      },
      playstyle: {
        data: {
          r3RejectRate: { red: 58.3, blue: 45.2 },
          r3RejectPercentile: { red: 50, blue: 50 },
          assassinTopSeats: [5, 2, 6],
          assassinAttempts: 40,
          captainStickiness: 7.6,
          captainStickinessPercentile: 70,
          sampleSize: 1010,
          hasData: true,
        },
        labels: {
          r3RejectRedLabel: '紅角 R3+ 強硬度',
          r3RejectBlueLabel: '藍角 R3+ 強硬度',
          assassinTargetLabel: '刺客目標座位偏好',
          captainStickinessLabel: '隊長 stickiness',
        },
      },
      caseVariants: ['Hao', 'hao'],
    });
    const lines = text.split('\n');
    expect(lines[0]).toBe('📊 HAO 的戰績');
    expect(lines[1]).toBe('場次 1013｜最終勝率 38.5%｜超額 +6.3');
    // 紅方刺中 = 110 / (110 + 140); 藍方存活 = merlinSurvivalRate.
    expect(lines[2]).toBe('任務結算 59.0% → 刺殺結算（三藍局：紅方刺中 44.0%／藍方存活 56.0%）→ 最終 38.5%');
    expect(lines[3]).toBe('🔴 紅方最終勝率 70.1%（378 場）｜🔵 藍方最終勝率 30.0%（635 場）');
    expect(text).not.toContain('角色理論勝率');
    expect(text).toContain('擅長角色：刺客 62.3%（106 場）、梅林 65.6%（96 場）；較弱：莫甘娜 50.6%（89 場）');
    expect(text).toContain('誠實度 83（PR37）');
    expect(text).toContain('刺客目標座位偏好 5、2、6 號');
    expect(text).toContain('另有大小寫不同的玩家：Hao、hao');
    expect(text).toContain(STATS_SITE_URL);
  });

  it('shows "—" for the excess when the cache cannot provide it, and signs a negative one', () => {
    expect(formatPlayerCard({ player: contractPlayer('A', 40, 31, null) })).toContain('場次 40｜最終勝率 31.0%｜超額 —');
    expect(formatPlayerCard({ player: contractPlayer('B', 40, 31, -2.1) })).toContain('場次 40｜最終勝率 31.0%｜超額 -2.1');
  });

  it('a pre-contract player (no two-stage fields) still gets a card: legacy winRate as 任務結算, "—" elsewhere', () => {
    const text = formatPlayerCard({ player: player('舊', 12, { winRate: 41.7, redMerlinDead: 25, redMerlinAlive: 25, blueMerlinDead: 30, blueMerlinAlive: 20 }) });
    expect(text).toContain('場次 12｜最終勝率 —｜超額 —');
    expect(text).toContain('任務結算 41.7% → 刺殺結算（三藍局：紅方刺中 50.0%／藍方存活 40.0%）→ 最終 —');
    expect(text).toContain('🔴 紅方最終勝率 —（5 場）｜🔵 藍方最終勝率 —（7 場）');
  });

  it('omits the 刺殺結算 detail and other sections the cache has no data for (small sample)', () => {
    const text = formatPlayerCard({
      player: player('新手', 3),
      strength: { roles: [], topRoles: [], bottomRoles: [], hasData: false },
      archetype: null,
      playstyle: null,
    });
    expect(text).toContain('場次 3');
    expect(text).toContain('→ 刺殺結算 → 最終');
    expect(text).not.toContain('擅長角色');
    expect(text).not.toContain('風格');
  });
});

// ─── Leaderboard fixtures ────────────────────────────────────────────────

const OVERVIEW: OverviewData = {
  totalGames: 2228,
  totalPlayers: 221,
  redWinRate: 45.5,
  blueWinRate: 54.5,
  merlinKillRate: 43.9,
  outcomeBreakdown: { threeRed: 1013, threeBlueDead: 533, threeBlueAlive: 682, threeRedPct: 45.5, threeBlueDeadPct: 23.9, threeBlueAlivePct: 30.6 },
  topPlayersByTheory: Array.from({ length: 12 }, (_, i) => ({ name: `P${i + 1}`, roleTheory: 60 - i, winRate: 59 - i, games: 100 + i })),
  topPlayersByGames: [],
  seatPositionWinRates: [],
};

function board(id: string, title: string, n: number, extra: Partial<LeaderboardBoard> = {}): LeaderboardBoard {
  return {
    id,
    title,
    period: '2025-10-13 ～ 2026-10-12',
    windowDays: 365,
    minGames: 20,
    note: '近 90 天內有出賽、期間至少 20 場',
    rows: Array.from({ length: n }, (_, i) => {
      const excessWinRate = Math.round((6.3 - i * 0.7) * 10) / 10;
      const games = 48 - i;
      return {
        rank: i + 1,
        name: `${id}${i + 1}`,
        // Sorted by the shrunk value (generate_cache.py); the bots print `excessWinRate`.
        value: shrunkExcess(excessWinRate, games),
        excessWinRate,
        finalWinRate: Math.round((38.5 - i) * 10) / 10,
        expectedFinalWinRate: 32.2,
        games,
      };
    }),
    ...extra,
  };
}

const LEADERBOARD: LeaderboardSection = {
  asOf: '2026-10-12',
  boards: [
    board('main', '超額勝率排行', 12),
    board('recent', '近 90 天', 7, { period: '2026-07-14 ～ 2026-10-12', note: '至少 10 場', windowDays: 90, minGames: 10 }),
    {
      id: 'roleTitles',
      title: '上月角色稱號',
      period: '2026-09',
      // generate_cache.py shape: no finalWinRate / excessWinRate on this board.
      rows: [
        { rank: 1, role: '刺客', name: 'HAO', value: 70, games: 8, wins: 6 },
        { rank: 2, role: '梅林', name: 'Sin', value: 50, games: 6, wins: 3 },
      ],
    },
  ],
};

describe('selectLeaderboard', () => {
  it('1. the cache main board, top 10, period + note in the title', () => {
    const view = selectLeaderboard(LEADERBOARD, OVERVIEW);
    expect(view.kind).toBe('excess');
    expect(view.title).toBe('🏆 超額勝率排行 Top 10（2025-10-13 ～ 2026-10-12，近 90 天內有出賽、期間至少 20 場）');
    expect(view.rows.map((r) => r.name)).toEqual(['main1', 'main2', 'main3', 'main4', 'main5', 'main6', 'main7', 'main8', 'main9', 'main10']);
    expect(view.rows[0]).toEqual({ rank: 1, name: 'main1', value: 6.3, winRate: 38.5, games: 48 });
    // The row's `value` is the shrunk sort key (6.3 × 48 / 68 = 4.4); the view carries the unshrunk excess.
    expect(findBoard(LEADERBOARD, 'main')!.rows[0].value).toBe(4.4);
    expect(view.rows.map((r) => r.value)).toEqual([6.3, 5.6, 4.9, 4.2, 3.5, 2.8, 2.1, 1.4, 0.7, 0]);
  });

  it('2a. no section → overview.topPlayersByExcess, titled 全期', () => {
    const view = selectLeaderboard(null, {
      topPlayersByTheory: OVERVIEW.topPlayersByTheory,
      topPlayersByExcess: [{ name: 'HAO', excessWinRate: 7.9, finalWinRate: 38.5, games: 600 }],
    });
    expect(view.kind).toBe('excess');
    expect(view.title).toBe(`🏆 超額勝率排行 Top 10（全期，至少 ${LEADERBOARD_FALLBACK_MIN_GAMES} 場）`);
    expect(view.rows).toEqual([{ rank: 1, name: 'HAO', value: 7.9, winRate: 38.5, games: 600 }]);
  });

  it('2b. no section, no topPlayersByExcess → players ≥30 games ordered like the generator: shrunk excess, then games', () => {
    const players = [
      contractPlayer('small', 20, 60, 30),
      contractPlayer('b', 60, 35, 2.5),
      contractPlayer('a', 300, 38.5, 6.3),
      contractPlayer('c', 100, 36, 2.5),
      contractPlayer('noExcess', 500, 40, null),
      // Highest raw excess but a small sample: shrunk 7 × 30 / 50 = 4.2 < a's 6.3 × 300 / 320 = 5.9.
      contractPlayer('lucky', 30, 50, 7),
    ];
    const view = selectLeaderboard({ boards: [] }, { topPlayersByTheory: OVERVIEW.topPlayersByTheory }, players);
    expect(view.kind).toBe('excess');
    expect(view.title).toContain('全期');
    // Printed value = the raw excess; c (shrunk 2.1) before b (1.9) — more games.
    expect(view.rows.map((r) => [r.rank, r.name, r.value])).toEqual([[1, 'a', 6.3], [2, 'lucky', 7], [3, 'c', 2.5], [4, 'b', 2.5]]);
    expect(shrunkExcess(7, 30)).toBe(4.2);
    expect(shrunkExcess(6.3, 300)).toBe(5.9);
    expect(LEADERBOARD_SHRINK_K).toBe(20); // generate_cache.py LEADERBOARD_CONFIG.shrinkK

    // The section's config.shrinkK is honoured when the cache carries one (K = 0: no shrinking).
    const config = { windowDays: 365, activeDays: 90, minGames: 20, shrinkK: 0, fallbackWindowDays: [730, 0], minBoardRows: 5, topN: 10 };
    expect(selectLeaderboard({ boards: [], config }, { topPlayersByTheory: [] }, players).rows.map((r) => r.name)).toEqual(['lucky', 'a', 'c', 'b']);
  });

  it('3. a pre-contract cache (no excess anywhere) falls back to the roleTheory ranking', () => {
    const view = selectLeaderboard(undefined, OVERVIEW, [player('x', 50, { roleTheory: 90 })]);
    expect(view.kind).toBe('theory');
    expect(view.title).toBe('🏆 理論勝率排行 Top 10');
    expect(view.rows.map((r) => r.name)).toEqual(['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10']);

    const fromPlayers = selectLeaderboard(null, { topPlayersByTheory: [] }, [
      player('small', 20, { roleTheory: 90 }),
      player('b', 60, { roleTheory: 52 }),
      player('a', 300, { roleTheory: 57 }),
    ]);
    expect(fromPlayers.kind).toBe('theory');
    expect(fromPlayers.rows.map((r) => r.name)).toEqual(['a', 'b']);
  });

  it('findBoard ignores boards without rows', () => {
    expect(findBoard({ boards: [{ ...board('main', 'x', 0) }] }, 'main')).toBeNull();
    expect(findBoard(LEADERBOARD, 'recent')?.id).toBe('recent');
    expect(findBoard(LEADERBOARD, 'online')).toBeNull();
    expect(findBoard(null, 'main')).toBeNull();
  });
});

describe('boardView', () => {
  // What generate_cache.py really writes (compute_leaderboard): the qualifier, then the excess legend after "；".
  const LEGEND = '超額勝率 = 期間最終勝率 − 依角色分配算出的預期勝率；排序用縮減值（× 場數 /（場數 + 20）），樣本少的人不會因為幾場好運就衝到前面';

  it('the title keeps only the first clause of the note — the legend is for the site, not a title in brackets', () => {
    const main = boardView(board('main', '超額勝率排行', 3, { note: `近 90 天內有出賽、近 365 天至少 20 場；${LEGEND}` }));
    expect(main.title).toBe('🏆 超額勝率排行 Top 10（2025-10-13 ～ 2026-10-12，近 90 天內有出賽、近 365 天至少 20 場）');
    const recent = boardView(
      board('recent', '近 90 天超額勝率', 2, { period: '2026-07-15 ～ 2026-10-12', note: `期間至少 10 場；${LEGEND}` }),
      DIGEST_RECENT_SIZE,
      '🔥',
    );
    expect(recent.title).toBe('🔥 近 90 天超額勝率 Top 5（2026-07-15 ～ 2026-10-12，期間至少 10 場）');
    expect(boardView(board('main', 'x', 1, { note: undefined })).title).toBe('🏆 x Top 10（2025-10-13 ～ 2026-10-12）');
    expect(boardView(board('main', 'x', 1, { note: `；${LEGEND}` })).title).toBe('🏆 x Top 10（2025-10-13 ～ 2026-10-12）');
  });

  it('prints the unshrunk excessWinRate, falling back to `value` only for a row without it', () => {
    const b = board('main', '超額勝率排行', 2);
    expect(b.rows[0].value).not.toBe(b.rows[0].excessWinRate);
    expect(boardView(b).rows.map((r) => r.value)).toEqual([6.3, 5.6]);
    const withoutExcess = { ...b, rows: [{ rank: 1, name: 'A', value: 2.7, finalWinRate: 40, games: 40 }] };
    expect(boardView(withoutExcess).rows[0]).toEqual({ rank: 1, name: 'A', value: 2.7, winRate: 40, games: 40 });
  });
});

describe('formatLeaderboard', () => {
  it('excess rows show rank, name, signed excess, final win rate and games — nothing else', () => {
    const text = formatLeaderboard(OVERVIEW, selectLeaderboard(LEADERBOARD, OVERVIEW));
    const lines = text.split('\n');
    expect(lines[0]).toBe('🏆 超額勝率排行 Top 10（2025-10-13 ～ 2026-10-12，近 90 天內有出賽、期間至少 20 場）');
    expect(lines[1]).toBe('🥇 main1　超額 +6.3｜最終 38.5%｜48 場');
    expect(lines[2]).toBe('🥈 main2　超額 +5.6｜最終 37.5%｜47 場');
    expect(lines[4]).toBe('4. main4　超額 +4.2｜最終 35.5%｜45 場');
    expect(lines[10]).toBe('10. main10　超額 0.0｜最終 29.5%｜39 場');
    expect(text).not.toContain('main11');
    expect(text).not.toContain('勝率 3'); // no duplicated "(勝率 x%・n 場)"
  });

  it('legacy theory rows keep the old format', () => {
    const text = formatLeaderboard(OVERVIEW, selectLeaderboard(null, OVERVIEW));
    expect(text.split('\n')[0]).toBe('🏆 理論勝率排行 Top 10');
    expect(text).toContain('🥇 P1　60.0%（勝率 59.0%・100 場）');
    expect(text).toContain('10. P10　51.0%');
  });

  it('totals line uses the final / mission / assassination stages, derived from outcomeBreakdown on an old cache', () => {
    // final red = (1013 + 533) / 2228 = 69.4%, blue = 682 / 2228 = 30.6%.
    expect(overviewTotalsLine(OVERVIEW)).toBe(
      '📈 總計 2228 場｜221 位玩家｜最終紅勝 69.4%／藍勝 30.6%（任務結算 紅 45.5%／藍 54.5%，三藍局刺中 43.9%）',
    );
    // schemaVersion 2 sections win over the derived numbers.
    expect(
      overviewTotalsLine({
        ...OVERVIEW,
        missionStage: { games: 2228, threeRed: 1000, threeBlue: 1228, redPct: 44.9, bluePct: 55.1 },
        assassinationStage: { games: 1228, merlinKilled: 540, merlinSurvived: 688, killPct: 44, survivePct: 56 },
        final: { games: 2228, redWins: 1540, blueWins: 688, redPct: 69.1, bluePct: 30.9 },
      }),
    ).toBe('📈 總計 2228 場｜221 位玩家｜最終紅勝 69.1%／藍勝 30.9%（任務結算 紅 44.9%／藍 55.1%，三藍局刺中 44.0%）');
    // An empty breakdown (no games) cannot be divided: "—", never NaN.
    expect(overviewTotalsLine({ ...OVERVIEW, outcomeBreakdown: { threeRed: 0, threeBlueDead: 0, threeBlueAlive: 0, threeRedPct: 0, threeBlueDeadPct: 0, threeBlueAlivePct: 0 } })).toContain('最終紅勝 —／藍勝 —');
    expect(formatLeaderboard(OVERVIEW, selectLeaderboard(LEADERBOARD, OVERVIEW))).toContain('📈 總計 2228 場｜221 位玩家｜最終紅勝 69.4%');
  });

  it('digest sections: "近 90 天" Top 5 and role titles after the main board, before the totals', () => {
    const recent = leaderboardLines(boardView(findBoard(LEADERBOARD, 'recent')!, DIGEST_RECENT_SIZE, '🔥'));
    expect(recent[0]).toBe('🔥 近 90 天 Top 5（2026-07-14 ～ 2026-10-12，至少 10 場）');
    expect(recent).toHaveLength(6);
    expect(recent[5]).toBe('5. recent5　超額 +3.5｜最終 34.5%｜44 場');

    const titles = roleTitlesLine(findBoard(LEADERBOARD, 'roleTitles'));
    expect(titles).toBe('🎖️ 上月角色稱號（2026-09）：刺客 HAO（70.0%・8 場）、梅林 Sin（50.0%・6 場）');
    expect(roleTitlesLine(null)).toBeNull();

    const text = formatLeaderboard(OVERVIEW, selectLeaderboard(LEADERBOARD, OVERVIEW), {
      header: '📅 每週排行（10/12）',
      sections: [recent, [titles!]],
      footerLines: ['查個人：/戰績 名字'],
    });
    const lines = text.split('\n');
    expect(lines[0]).toBe('📅 每週排行（10/12）');
    expect(lines[1]).toContain('超額勝率排行 Top 10');
    expect(lines.indexOf(recent[0])).toBe(12);
    expect(lines.indexOf(titles!)).toBe(18);
    expect(lines[19]).toContain('📈 總計');
    expect(lines[20]).toBe('查個人：/戰績 名字');
    expect(lines[21]).toContain(STATS_SITE_URL);
  });

  it('drops the later sections first when the text would exceed the cap; the main board and totals always stay', () => {
    const main = selectLeaderboard(LEADERBOARD, OVERVIEW);
    const recent = leaderboardLines(boardView(findBoard(LEADERBOARD, 'recent')!, DIGEST_RECENT_SIZE, '🔥'));
    const hugeTitles = `🎖️ ${'稱號'.repeat(900)}`;
    const withTitlesDropped = formatLeaderboard(OVERVIEW, main, { sections: [recent, [hugeTitles]] });
    expect(withTitlesDropped.length).toBeLessThanOrEqual(STATS_REPLY_MAX_CHARS);
    expect(withTitlesDropped).toContain('🔥 近 90 天 Top 5');
    expect(withTitlesDropped).not.toContain('🎖️');
    expect(withTitlesDropped).toContain('📈 總計');
    expect(withTitlesDropped.endsWith('…')).toBe(false);

    const hugeRecent = [`🔥 ${'近'.repeat(1500)}`];
    const bothDropped = formatLeaderboard(OVERVIEW, main, { sections: [hugeRecent, [hugeTitles]] });
    expect(bothDropped).not.toContain('🔥');
    expect(bothDropped).not.toContain('🎖️');
    expect(bothDropped).toContain('10. main10');
    expect(bothDropped).toContain('📈 總計');
    expect(bothDropped.length).toBeLessThanOrEqual(STATS_REPLY_MAX_CHARS);
  });
});

describe('chemistry', () => {
  const chemistry = {
    coWin: { players: ['SIN', 'HAO', '尼克'], rowLabels: ['SIN', 'HAO', '尼克'], values: [[452, 108, 111], [108, 467, 120], [111, 120, 337]] },
    coLose: { players: ['SIN', 'HAO', '尼克'], rowLabels: ['SIN', 'HAO', '尼克'], values: [[503, 131, 140], [131, 414, 120], [140, 120, 404]] },
  };

  it('together = won together + lost together; win rate = won / together', () => {
    const pair = lookupPair(chemistry, 'SIN', 'HAO');
    expect(pair).toEqual({ coWin: 108, coLose: 131 });
    const text = formatChemistry({ name: 'Sin', winRate: 51.4 }, { name: 'HAO', winRate: 59 }, pair, 3);
    expect(text).toContain('🤝 Sin × HAO 默契');
    expect(text).toContain('同隊 239 場：一起贏 108、一起輸 131');
    expect(text).toContain('同隊勝率 45.2%');
    expect(text).toContain('收錄場次最多的 3 位玩家');
  });

  it('unknown labels give an explicit "no record" line', () => {
    const text = formatChemistry({ name: 'A' }, { name: 'B' }, lookupPair(chemistry, 'A', 'B'), 3);
    expect(text).toContain('沒有這兩位的同隊紀錄');
  });
});

describe('length limits', () => {
  it('clampReply cuts at a line break and stays under the cap', () => {
    const long = Array.from({ length: 400 }, (_, i) => `第 ${i} 行 ${'字'.repeat(10)}`).join('\n');
    const out = clampReply(long);
    expect(out.length).toBeLessThanOrEqual(STATS_REPLY_MAX_CHARS);
    expect(out.endsWith('\n…')).toBe(true);
    expect(clampReply('short')).toBe('short');
  });

  it('a card with absurdly long names / labels is still under Discord 2000', () => {
    const huge = '名'.repeat(3000);
    const text = formatPlayerCard({ player: player(huge, 10), caseVariants: [huge, huge, huge] });
    expect(text.length).toBeLessThanOrEqual(STATS_REPLY_MAX_CHARS);
    expect(STATS_REPLY_MAX_CHARS).toBeLessThan(DISCORD_MAX);
  });

  it('help text exists for both platforms and advertises the excess ranking and /意見', () => {
    for (const platform of ['line', 'discord'] as const) {
      const text = formatStatsHelp(platform);
      expect(text).toContain('/排行　超額勝率排行 Top 10');
      expect(text).toContain('/意見 文字　給管理者的建議或回報問題');
      expect(text).toContain('/默契 名字1 名字2');
      expect(text).not.toContain('理論勝率');
    }
    expect(formatStatsHelp('line')).toContain('/指令');
    expect(formatStatsHelp('discord')).not.toContain('/指令');
  });
});

describe('parseStatsCommand (LINE)', () => {
  it.each([
    ['/戰績 HAO', { kind: 'player', query: 'HAO' }],
    ['／戰績ＨＡＯ', { kind: 'player', query: 'ＨＡＯ' }],
    ['/戰績', { kind: 'player', query: '' }],
    ['/战绩 Sin', { kind: 'player', query: 'Sin' }],
    ['/排行', { kind: 'leaderboard' }],
    [' /排行榜 ', { kind: 'leaderboard' }],
    ['/默契 Sin　HAO', { kind: 'chemistry', args: ['Sin', 'HAO'] }],
    ['/指令', { kind: 'help' }],
  ])('%s', (text, expected) => {
    expect(parseStatsCommand(text)).toEqual(expected);
  });

  it.each(['hello', '/help', '/create', '戰績 HAO', 'HAO /戰績', ''])('ignores %j', (text) => {
    expect(parseStatsCommand(text)).toBeNull();
  });

  it('keeps the case of the name (Sin / SIN are different players)', () => {
    expect(parseStatsCommand('/戰績 SIN')).toEqual({ kind: 'player', query: 'SIN' });
  });
});

describe('real analysis_cache.json smoke', () => {
  it('every player card fits the reply budget and shows a final win rate (computed from raw counts on an old cache)', async () => {
    const players = await getAllPlayerStats();
    expect(players.length).toBeGreaterThan(0);
    for (const p of players) {
      const text = await playerCardReply(p.name);
      expect(text, p.name).toContain(`📊 ${p.name} 的戰績`);
      expect(text, p.name).toMatch(/最終勝率 \d+\.\d%/);
      expect(text, p.name).not.toContain('角色理論勝率');
      expect(text.length, p.name).toBeLessThanOrEqual(STATS_REPLY_MAX_CHARS);
    }
  });

  it('leaderboard, digest and a chemistry pair fit too', async () => {
    for (const text of [await leaderboardReply(), await weeklyDigestText(Date.UTC(2026, 9, 12, 4, 0))]) {
      expect(text).toContain('Top 10');
      expect(text).toMatch(/最終紅勝 \d+\.\d%／藍勝 \d+\.\d%/);
      expect(text.length).toBeLessThanOrEqual(STATS_REPLY_MAX_CHARS);
    }
    expect(await weeklyDigestText(Date.UTC(2026, 9, 12, 4, 0))).toContain('📅 每週排行（10/12）');
    const players = await getAllPlayerStats();
    const [a, b] = players.slice().sort((x, y) => y.totalGames - x.totalGames);
    const text = await chemistryReply(a.name, b.name);
    expect(text).toContain('默契');
    expect(text.length).toBeLessThanOrEqual(STATS_REPLY_MAX_CHARS);
  });
});
