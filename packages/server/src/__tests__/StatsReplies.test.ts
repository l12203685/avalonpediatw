/**
 * Stats replies (2026-10-10; two-stage outcome 2026-10-12; theory win rates
 * 2026-10-13) — the pure formatter shared by the Discord and LINE bots
 * (bots/stats/statsReplies.ts), the LINE text-command parser, and a smoke
 * pass over the real analysis_cache.json through statsQueries.ts.
 *
 * Semantics follow docs/stats/two_stage_outcome.md: on a schemaVersion-3 cache the card leads
 * with the 角色理論／位置理論／最終勝率 of the player's last 100 / last 50 games and career and
 * the ranking is the 角色理論 of each active player's last 100 games; on a schemaVersion-4 cache
 * (2026-10-14) 角色理論 is over each role's last 10 games (忠臣 40), 位置理論 over the last 100,
 * 整體理論 over the career, and the card shows the 紅方 / 藍方 games in three conditional blocks.
 * The excess win rate is never printed.
 */
import { describe, expect, it } from 'vitest';
import type {
  LeaderboardBoard,
  LeaderboardSection,
  OverviewData,
  PlayerRoleWindows,
  PlayerStats,
  PlayerTheoryWindow,
} from '../services/sheetsAnalysis';
import { getAllPlayerStats } from '../services/sheetsAnalysis';
import {
  DEFAULT_LEADERBOARD_SCOPE,
  DIGEST_IMPROVED_SIZE,
  LEADERBOARD_PENDING_NOTE,
  MAX_NAME_CANDIDATES,
  OUTCOME_BLOCKS_FOOTNOTE,
  ROLE_TITLE_NAMES_MAX,
  STATS_REPLY_MAX_CHARS,
  STATS_SITE_URL,
  boardView,
  clampReply,
  findBoard,
  findTheoryBoard,
  formatChemistry,
  formatLeaderboard,
  formatNameProblem,
  formatPlayerCard,
  formatStatsHelp,
  improvedLines,
  leaderboardLines,
  leaderboardScope,
  lookupPair,
  matchPlayerName,
  normalizeName,
  newcomersLine,
  overviewTotalsLine,
  roleTitlesLine,
  selectLeaderboard,
  signed,
  theoryFootnote,
  theoryLines,
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

function tw(window: number, games: number, roleTheory: number, positionTheory: number, finalWinRate: number): PlayerTheoryWindow {
  return { window, games, roleTheory, positionTheory, finalWinRate, from: '2026-05-01', to: '2026-10-10', sparseRoles: 0, sparseSeats: 0 };
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

  it('several spellings of one player (an old cache): the first in the given order wins, the rest are variants', () => {
    expect(matchPlayerName('SIn', NAMES)).toEqual({ kind: 'found', name: 'Sin', caseVariants: ['SIN', 'sin'] });
  });

  it('case, width, stray spaces and zero-width characters never matter (made-up names)', () => {
    const names = ['Nova', 'Kite', '雪球'];
    for (const typed of ['NOVA', 'nova', ' nOvA ', 'ｎｏｖａ', 'ＮＯＶＡ', 'No\u200bva']) {
      expect(matchPlayerName(typed, names)).toEqual({ kind: 'found', name: 'Nova', caseVariants: [] });
    }
    expect(normalizeName('Ｔｏｖｏ　 Ｗｒｅｎ')).toBe('tovo wren');
    // A substring hit on two spellings of one player is that player, not a choice between "two".
    expect(matchPlayerName('ov', ['Nova', 'NOVA', 'Kite'])).toEqual({ kind: 'found', name: 'Nova', caseVariants: ['NOVA'] });
    expect(matchPlayerName('o', ['Nova', 'NOVA', 'Kite', 'Orca'])).toEqual({
      kind: 'ambiguous', query: 'o', candidates: ['Nova', 'Orca'], total: 2,
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
  it('leads with 角色理論／位置理論／最終 for the last 100 / 50 games and career, then 任務結算 → 刺殺結算 → 最終, per-side final rates, strongest roles, archetype, playstyle, footnote, site link', () => {
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
        theory: { last100: tw(100, 100, 52.3, 50.8, 49), last50: tw(50, 50, 55.1, 53.2, 52), career: tw(0, 1013, 47.9, 47.2, 38.5) },
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
    expect(lines[1]).toBe('近 100 場｜角色理論 52.3%｜位置理論 50.8%｜最終 49.0%');
    expect(lines[2]).toBe('近 50 場｜角色理論 55.1%｜位置理論 53.2%｜最終 52.0%');
    expect(lines[3]).toBe('生涯 1013 場｜角色理論 47.9%｜位置理論 47.2%｜最終 38.5%');
    // 紅方刺中 = 110 / (110 + 140); 藍方存活 = merlinSurvivalRate.
    expect(lines[4]).toBe('任務結算 59.0% → 刺殺結算（三藍局：紅方刺中 44.0%／藍方存活 56.0%）→ 最終 38.5%');
    expect(lines[5]).toBe('🔴 紅方最終勝率 70.1%（378 場）｜🔵 藍方最終勝率 30.0%（635 場）');
    expect(text).not.toContain('超額');
    expect(text).not.toContain('59.1'); // the legacy roleTheory is never shown
    expect(text).toContain('擅長角色：刺客 62.3%（106 場）、梅林 65.6%（96 場）；較弱：莫甘娜 50.6%（89 場）');
    expect(text).toContain('誠實度 83（PR37）');
    expect(text).toContain('刺客目標座位偏好 5、2、6 號');
    expect(text).toContain('大小寫不同的寫法目前另列：Hao、hao（同一人，戰績更新後會合併）');
    expect(lines[lines.length - 2]).toBe(theoryFootnote(3));
    expect(lines[lines.length - 1]).toContain(STATS_SITE_URL);
  });

  it('a last-N line only when the player has more than N games; the footnote follows the cache\'s top-up setting', () => {
    expect(theoryLines({ theory: { last100: tw(100, 72, 50, 49, 48), last50: tw(50, 50, 51, 50, 49), career: tw(0, 72, 50, 49, 48) } })).toEqual([
      '近 50 場｜角色理論 51.0%｜位置理論 50.0%｜最終 49.0%',
      '生涯 72 場｜角色理論 50.0%｜位置理論 49.0%｜最終 48.0%',
    ]);
    expect(theoryLines({ theory: { last100: tw(100, 100, 50, 49, 48), last50: tw(50, 50, 51, 50, 49), career: tw(0, 100, 50, 49, 48) } })![0]).toMatch(/^近 50 場/);
    expect(theoryLines({ theory: { career: tw(0, 12, 47.1, 46, 50) } })).toEqual(['生涯 12 場｜角色理論 47.1%｜位置理論 46.0%｜最終 50.0%']);
    expect(theoryLines({})).toBeNull();
    // Whatever windows the generator wrote (mainGames / shortGames changed to 80 / 30), largest first.
    expect(theoryLines({ theory: { last30: tw(30, 30, 40, 41, 42), last80: tw(80, 80, 45, 46, 47), career: tw(0, 90, 50, 49, 48) } })).toEqual([
      '近 80 場｜角色理論 45.0%｜位置理論 46.0%｜最終 47.0%',
      '近 30 場｜角色理論 40.0%｜位置理論 41.0%｜最終 42.0%',
      '生涯 90 場｜角色理論 50.0%｜位置理論 49.0%｜最終 48.0%',
    ]);
    expect(theoryFootnote(3)).toBe('※ 角色理論 = Σ 抽到該角色的機率（忠臣 4/10、其他各 1/10）× 該角色最終勝率；位置理論 = Σ 1/10 × 該位置最終勝率；不到 3 場的角色或位置用全體勝率補到 3 場');
    expect(theoryFootnote(0)).not.toContain('補');
    const card = formatPlayerCard({ player: contractPlayer('A', 12, 50, 1, { theory: { career: tw(0, 12, 47.1, 46, 50) } }), minCellGames: 5 });
    expect(card).toContain('不到 5 場的角色或位置用全體勝率補到 5 場');
  });

  it('a cache without theory says when it comes; a pre-contract player (no two-stage fields) still gets a card', () => {
    const noTheory = formatPlayerCard({ player: contractPlayer('A', 40, 31, 6) });
    expect(noTheory).toContain('場次 40｜最終勝率 31.0%\n（角色理論／位置理論勝率：下次每日更新資料後提供）');
    expect(noTheory).not.toContain('超額');
    expect(noTheory).not.toContain('※');
    const text = formatPlayerCard({ player: player('舊', 12, { winRate: 41.7, redMerlinDead: 25, redMerlinAlive: 25, blueMerlinDead: 30, blueMerlinAlive: 20 }) });
    expect(text).toContain('場次 12｜最終勝率 —');
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

// ─── schemaVersion 4 (Edward 2026-10-14) ─────────────────────────────────

/** players[].theory.roleWindows: 10 games per special role, 40 as 忠臣 when full. */
function roleWindows(roleTheory: number, games: number, full: boolean): PlayerRoleWindows {
  const roles = Object.fromEntries(['刺客', '莫甘娜', '莫德雷德', '奧伯倫', '派西維爾', '梅林', '忠臣'].map((r) => {
    const window = r === '忠臣' ? 40 : 10;
    return [r, { games: full ? window : Math.min(window, 3), wins: 1, window, rate: 50 }];
  }));
  return { roleTheory, fullWindows: full, games, sparseRoles: 0, from: '2026-05-01', to: '2026-10-10', roles };
}

/**
 * An invented schema-4 player: red 405 games (三紅 180, 三藍死 97, 三藍活 128), blue 608 (三紅 275,
 * 三藍死 150, 三藍活 183).
 */
function schema4Player(extra: Partial<PlayerStats> = {}): PlayerStats {
  return contractPlayer('Tovo Wren', 1013, 38.5, 6.3, {
    rawRedGames: 405, rawBlueGames: 608,
    rawRedThreeRed: 180, rawRedMerlinDead: 97, rawRedMerlinAlive: 128,
    rawBlueThreeRed: 275, rawBlueMerlinDead: 150, rawBlueMerlinAlive: 183,
    roleOutcomes: { 刺客: { 三紅: 50, 三藍死: 30, 三藍活: 20 }, 忠臣: { 三紅: 100, 三藍死: 60, 三藍活: 80 } },
    theory: { roleWindows: roleWindows(52.3, 100, true), last100: tw(100, 100, 44, 50.8, 49), career: tw(0, 1013, 47.9, 47.2, 38.5) },
    ...extra,
  });
}

describe('formatPlayerCard on a schemaVersion-4 cache', () => {
  it('角色理論 (per-role windows) / 位置理論 (last 100) / 整體理論 (career), then the 紅方 / 藍方 conditional blocks', () => {
    const text = formatPlayerCard({ player: schema4Player() });
    const lines = text.split('\n');
    expect(lines.slice(0, 6)).toEqual([
      '📊 Tovo Wren 的戰績',
      '角色理論（各角色近 10 場、忠臣近 40 場）52.3%',
      '位置理論（近 100 場）50.8%｜最終勝率 49.0%',
      '整體理論（生涯 1013 場）47.9%｜位置理論 47.2%｜最終勝率 38.5%',
      // 任務結果 180 / 405; 刺殺結果 97 / (97 + 128) — only the games that reached 三藍; 遊戲結果 (180 + 97) / 405.
      '🔴 紅方 405 場｜任務結果 44.4%｜刺殺結果 43.1%（三藍 225 場）｜遊戲結果 68.4%',
      // 任務結果 (150 + 183) / 608; 刺殺結果 183 / 333; 遊戲結果 183 / 608.
      '🔵 藍方 608 場｜任務結果 54.8%｜刺殺結果 55.0%（三藍 333 場）｜遊戲結果 30.1%',
    ]);
    expect(text).not.toContain('近 50 場');
    expect(text).not.toContain('任務結算'); // the schema-3 walk is replaced by the blocks
    expect(text).toContain(theoryFootnote(3, { special: 10, loyal: 40 }));
    expect(theoryFootnote(3, { special: 10, loyal: 40 })).toContain('每個角色看最近 10 場、忠臣 40 場');
    expect(text).toContain(OUTCOME_BLOCKS_FOOTNOTE);
    expect(text).not.toContain('超額');
    expect(text.length).toBeLessThanOrEqual(STATS_REPLY_MAX_CHARS);
  });

  it('windows not full yet: says how many games and that it is not on the role-theory board; fewer than 100 games: 位置理論（全部 N 場）', () => {
    const lines = theoryLines({
      theory: { roleWindows: roleWindows(49.1, 63, false), last100: tw(100, 72, 44, 50, 48), career: tw(0, 72, 49.1, 50, 48) },
    });
    expect(lines).toEqual([
      // Only the 角色理論勝率排行 needs full windows: the same player may be on the 位置理論 / 整體理論
      // boards or the 新人榜, so the card never says 「不列入排行」.
      '角色理論（各角色近 10 場、忠臣近 40 場）49.1%（目前 63 場，還沒有每個角色都打滿，不列入角色理論勝率排行）',
      '位置理論（全部 72 場）50.0%｜最終勝率 48.0%',
      '整體理論（生涯 72 場）49.1%｜位置理論 50.0%｜最終勝率 48.0%',
    ]);
    // A side never played: "0 場", no rates.
    const card = formatPlayerCard({
      player: schema4Player({ rawRedGames: 0, rawRedThreeRed: 0, rawRedMerlinDead: 0, rawRedMerlinAlive: 0, rawBlueThreeRed: 5, rawBlueMerlinDead: 0, rawBlueMerlinAlive: 0 }),
    });
    expect(card).toContain('🔴 紅方 0 場\n🔵 藍方 5 場｜任務結果 0.0%｜刺殺結果 —（沒有三藍的局）｜遊戲結果 0.0%');
  });

  it('a newcomer on the 新人榜 (windows not full) is told their rank, not that they are unranked', () => {
    const newcomer = schema4Player({
      theory: { roleWindows: roleWindows(47, 21, false), last100: tw(100, 24, 46, 47.5, 45.8), career: tw(0, 24, 47, 47.5, 45.8) },
    });
    const card = formatPlayerCard({ player: newcomer, newcomerRank: 2 });
    expect(card.split('\n')[1]).toBe('角色理論（各角色近 10 場、忠臣近 40 場）47.0%（目前 21 場，還沒有每個角色都打滿，不列入角色理論勝率排行；新人榜第 2 名）');
    expect(card).not.toContain('不列入排行');
    // Full windows: no qualifier, whatever the newcomers board says.
    expect(formatPlayerCard({ player: schema4Player(), newcomerRank: 1 }).split('\n')[1]).toBe('角色理論（各角色近 10 場、忠臣近 40 場）52.3%');
  });

  it('the same player on a schemaVersion-3 cache keeps the 2026-10-13 card', () => {
    const v3 = schema4Player({ roleOutcomes: undefined, theory: { last100: tw(100, 100, 52.3, 50.8, 49), last50: tw(50, 50, 55.1, 53.2, 52), career: tw(0, 1013, 47.9, 47.2, 38.5) } });
    const lines = formatPlayerCard({ player: v3 }).split('\n');
    expect(lines[1]).toBe('近 100 場｜角色理論 52.3%｜位置理論 50.8%｜最終 49.0%');
    expect(lines[4]).toBe('任務結算 59.0% → 刺殺結算（三藍局：紅方刺中 43.1%／藍方存活 56.0%）→ 最終 38.5%');
    expect(lines[5]).toBe('🔴 紅方最終勝率 70.1%（405 場）｜🔵 藍方最終勝率 30.0%（608 場）');
    expect(lines).toContain(theoryFootnote(3));
  });
});

/** The schema-4 main board as generate_cache.py writes it (rows carry overallTheory). */
function schema4Main(n: number): LeaderboardBoard {
  return board('main', '角色理論勝率排行', n, {
    period: '各角色近 10 場、忠臣近 40 場',
    windowGames: undefined,
    roleWindowGames: { 刺客: 10, 莫甘娜: 10, 莫德雷德: 10, 奧伯倫: 10, 派西維爾: 10, 梅林: 10, 忠臣: 40 },
    note: `近 90 天內有出賽、六個特殊角色各至少 10 場、忠臣至少 40 場；位置理論與最終勝率看最近 100 場；${LEGEND}`,
    rows: Array.from({ length: n }, (_, i) => ({
      rank: i + 1, name: `R${i + 1}`, value: 56 - i, roleTheory: 56 - i, positionTheory: 55.2, overallTheory: 54.2,
      finalWinRate: 56, games: 100, careerGames: 1018 - i, from: '2026-05-01', to: '2026-10-10', sparseRoles: 0, sparseSeats: 0,
    })),
  });
}

describe('/排行 on a schemaVersion-4 cache', () => {
  it('the main board: per-role windows in the title, 整體理論 and the career games on every row', () => {
    const lines = leaderboardLines(selectLeaderboard({ boards: [schema4Main(12)] }, OVERVIEW));
    expect(lines[0]).toBe('🏆 角色理論勝率排行 Top 10（各角色近 10 場、忠臣近 40 場，近 90 天內有出賽、六個特殊角色各至少 10 場、忠臣至少 40 場）');
    expect(lines[1]).toBe('🥇 R1　角色理論 56.0%｜位置理論 55.2%｜整體理論 54.2%｜最終 56.0%｜生涯 1018 場');
    expect(lines).toHaveLength(11);
  });

  it('no main board: overview.topPlayersByRoleTheory with the per-role windows; nobody: the per-role qualifier', () => {
    const theoryConfig = {
      theoryMinCellGames: 3, theoryWindows: [100], mainGames: 100, activeDays: 90, positionGames: 100, overallMinGames: 250,
      roleWindowGames: { 刺客: 10, 莫甘娜: 10, 莫德雷德: 10, 奧伯倫: 10, 派西維爾: 10, 梅林: 10, 忠臣: 40 },
    };
    const top = [{ name: 'O1', roleTheory: 51.2, positionTheory: 50.1, overallTheory: 48.8, finalWinRate: 49, games: 100, careerGames: 640 }];
    const view = selectLeaderboard({ boards: [] }, { ...OVERVIEW, schemaVersion: 4, theoryConfig, topPlayersByRoleTheory: top });
    expect(leaderboardLines(view)).toEqual([
      '🏆 角色理論勝率排行 Top 10（各角色近 10 場、忠臣近 40 場，每個角色都打滿，不限近期出賽）',
      '🥇 O1　角色理論 51.2%｜位置理論 50.1%｜整體理論 48.8%｜最終 49.0%｜生涯 640 場',
    ]);
    const empty = selectLeaderboard({ boards: [], config: { roleWindowGames: 5, loyalWindowGames: 20, activeDays: 60 } }, { schemaVersion: 4, topPlayersByRoleTheory: [] });
    expect(empty.emptyNote).toBe('（目前沒有符合條件的玩家：近 60 天內有出賽、六個特殊角色各至少 5 場、忠臣至少 20 場）');
  });

  it("新人榜 line: the newcomer's own games (careerGames, not the role-window games) and the per-role cap", () => {
    // generate_cache.py newcomers row: roleTheory / games over the per-role windows (≤ 10 per special role, ≤ 40 as
    // 忠臣), careerGames = every game of the newcomer. Invented name.
    const newcomers = board('newcomers', '新人榜', 0, {
      period: '2026-07-15 ～ 2026-10-12 首次出賽', windowGames: undefined, allGames: true,
      rows: [{ rank: 1, name: 'Tovo Wren', value: 47, roleTheory: 47, positionTheory: 46, overallTheory: 46.4, finalWinRate: 50, games: 34, careerGames: 41, firstPlayed: '2026-08-01' }],
    });
    expect(newcomersLine(newcomers, undefined, { special: 10, loyal: 40 })).toBe(
      '🌱 新人榜（2026-07-15 ～ 2026-10-12 首次出賽，新人例外：看全部場次，角色理論每個角色最多算近 10 場、忠臣 40 場）：Tovo Wren 角色理論 47.0%（41 場）',
    );
  });

  it('leaderboardScope (/help, /指令): the window /排行 ranks by, from the cache', () => {
    // The main board's period: schemaVersion 4, then the still-live schemaVersion-3 cache.
    expect(leaderboardScope({ boards: [schema4Main(3)] }, OVERVIEW)).toBe('各角色近 10 場、忠臣近 40 場');
    expect(leaderboardScope(LEADERBOARD, OVERVIEW)).toBe('各人最近 100 場');
    // No main board (nobody active qualifies): the cache's settings, like selectLeaderboard's fallback.
    expect(leaderboardScope({ boards: [], config: { roleWindowGames: 10, loyalWindowGames: 40 } }, { schemaVersion: 4, topPlayersByRoleTheory: [] })).toBe('各角色近 10 場、忠臣近 40 場');
    expect(leaderboardScope({ boards: [] }, { schemaVersion: 3, topPlayersByRoleTheory: [], theoryConfig: { mainGames: 80 } as OverviewData['theoryConfig'] })).toBe('各人最近 80 場');
    expect(leaderboardScope(null, OVERVIEW)).toBe('各人最近 100 場');
    // A cache written before the theory rates (an excess main board, no settings): no window to name.
    expect(leaderboardScope({ boards: [OLD_MAIN] }, { schemaVersion: 2 })).toBeNull();
    expect(leaderboardScope(null, null)).toBeNull();
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
  schemaVersion: 3,
  topPlayersByRoleTheory: Array.from({ length: 12 }, (_, i) => ({
    name: `O${i + 1}`, roleTheory: 50 - i / 2, positionTheory: 49, finalWinRate: 48, games: 100, careerGames: 500 - i,
  })),
};

// What generate_cache.py writes since 2026-10-13: the qualifier, then the legend after "；".
const LEGEND = '角色理論 = Σ 抽到該角色的機率（忠臣 4/10、其他角色各 1/10）× 本人該角色的最終勝率；位置理論 = Σ 1/10 × 本人該位置的最終勝率；不到 3 場的角色或位置，用全體的最終勝率補到 3 場';

function board(id: string, title: string, n: number, extra: Partial<LeaderboardBoard> = {}): LeaderboardBoard {
  return {
    id,
    metric: 'roleTheory',
    title,
    period: '各人最近 100 場',
    windowGames: 100,
    minGames: 100,
    note: `近 90 天內有出賽、生涯至少 100 場；${LEGEND}`,
    rows: Array.from({ length: n }, (_, i) => {
      const roleTheory = Math.round((55.2 - i * 0.7) * 10) / 10;
      return {
        rank: i + 1,
        name: `${id}${i + 1}`,
        value: roleTheory,
        roleTheory,
        positionTheory: Math.round((54 - i) * 10) / 10,
        finalWinRate: Math.round((56 - i) * 10) / 10,
        games: 100,
        careerGames: 1000 - i,
        from: '2026-05-01',
        to: '2026-10-10',
        sparseRoles: 0,
        sparseSeats: 0,
      };
    }),
    ...extra,
  };
}

const LEADERBOARD: LeaderboardSection = {
  asOf: '2026-10-12',
  boards: [
    board('main', '角色理論勝率排行', 12),
    board('last50', '近 50 場角色理論勝率', 7, { period: '各人最近 50 場', windowGames: 50, minGames: 50, note: `近 90 天內有出賽、生涯至少 50 場；${LEGEND}` }),
    {
      id: 'improved',
      metric: 'roleTheoryDelta',
      title: '進步榜',
      period: '各人最近 50 場 vs 再之前 50 場',
      minGames: 100,
      note: `近 90 天內有出賽、生涯至少 100 場；最近 50 場的角色理論勝率 − 再之前 50 場的，只列有進步的人；${LEGEND}`,
      rows: Array.from({ length: 7 }, (_, i) => ({
        rank: i + 1, name: `I${i + 1}`, value: 10 - i, recentRoleTheory: 50, priorRoleTheory: 40 + i, games: 50, careerGames: 300,
      })),
    },
    {
      id: 'newcomers',
      metric: 'roleTheory',
      title: '新人榜',
      period: '2026-07-15 ～ 2026-10-12 首次出賽',
      allGames: true,
      rows: [{ rank: 1, name: 'N1', value: 47, roleTheory: 47, positionTheory: 46, finalWinRate: 50, games: 13, careerGames: 13, firstPlayed: '2026-08-01' }],
    },
    {
      id: 'roleTitles',
      metric: 'finalWinRate',
      title: '角色王',
      period: '各人該角色最近 20 場',
      rows: [
        { rank: 1, role: '刺客', name: 'HAO', value: 90, games: 20, wins: 18, careerRoleGames: 106 },
        { rank: 2, role: '梅林', name: 'Sin', value: 55, games: 20, wins: 11, careerRoleGames: 96 },
      ],
    },
  ],
};

/** A board as caches written before 2026-10-13 have it: excess rows, no `metric`. */
const OLD_MAIN: LeaderboardBoard = {
  id: 'main',
  title: '超額勝率排行',
  period: '2025-10-13 ～ 2026-10-12',
  windowDays: 365,
  rows: [{ rank: 1, name: 'old1', value: 4.4, excessWinRate: 6.3, finalWinRate: 38.5, games: 48 }],
};

describe('selectLeaderboard', () => {
  it('1. the cache main board, top 10, period + note qualifier in the title', () => {
    const view = selectLeaderboard(LEADERBOARD, OVERVIEW);
    expect(view.title).toBe('🏆 角色理論勝率排行 Top 10（各人最近 100 場，近 90 天內有出賽、生涯至少 100 場）');
    expect(view.rows.map((r) => r.name)).toEqual(['main1', 'main2', 'main3', 'main4', 'main5', 'main6', 'main7', 'main8', 'main9', 'main10']);
    expect(view.rows[0]).toEqual({ rank: 1, name: 'main1', roleTheory: 55.2, positionTheory: 54, finalWinRate: 56, games: 100 });
  });

  it('2. no theory main board → overview.topPlayersByRoleTheory (≥ 100 career games, any activity)', () => {
    for (const leaderboard of [null, { boards: [] }, { boards: [OLD_MAIN] }]) {
      const view = selectLeaderboard(leaderboard, OVERVIEW);
      expect(view.title).toBe('🏆 角色理論勝率排行 Top 10（各人最近 100 場，生涯至少 100 場，不限近期出賽）');
      expect(view.rows.map((r) => r.name)).toEqual(['O1', 'O2', 'O3', 'O4', 'O5', 'O6', 'O7', 'O8', 'O9', 'O10']);
      expect(view.rows[1]).toEqual({ rank: 2, name: 'O2', roleTheory: 49.5, positionTheory: 49, finalWinRate: 48, games: 100 });
    }
  });

  it('3. nothing to rank: "nobody qualifies" on a current cache, the pending note on an older one — never excess or the legacy roleTheory', () => {
    const empty = selectLeaderboard({ boards: [] }, { schemaVersion: 3, topPlayersByRoleTheory: [] });
    expect(empty.rows).toEqual([]);
    expect(leaderboardLines(empty)).toEqual(['🏆 角色理論勝率排行', '（目前沒有符合條件的玩家：近 90 天內有出賽、生涯至少 100 場）']);
    const old = selectLeaderboard({ boards: [OLD_MAIN] }, { schemaVersion: 2 });
    expect(leaderboardLines(old)).toEqual(['🏆 角色理論勝率排行', LEADERBOARD_PENDING_NOTE]);
    expect(leaderboardLines(selectLeaderboard(undefined, undefined))).toEqual(['🏆 角色理論勝率排行', LEADERBOARD_PENDING_NOTE]);
  });

  it('the fallback title and the empty note follow the generator settings (leaderboard.config, else overview.theoryConfig)', () => {
    const theoryConfig = { theoryMinCellGames: 3, theoryWindows: [80, 50], mainGames: 80, activeDays: 60 };
    const empty = selectLeaderboard({ boards: [] }, { schemaVersion: 3, topPlayersByRoleTheory: [], theoryConfig });
    expect(empty.emptyNote).toBe('（目前沒有符合條件的玩家：近 60 天內有出賽、生涯至少 80 場）');
    const fromConfig = selectLeaderboard({ boards: [], config: { mainGames: 120, activeDays: 30 } }, { ...OVERVIEW, theoryConfig });
    expect(fromConfig.title).toBe('🏆 角色理論勝率排行 Top 10（各人最近 120 場，生涯至少 120 場，不限近期出賽）');
    // A pre-theory config (windowDays, minGames, ...) has no mainGames: the defaults.
    const oldConfig = selectLeaderboard({ boards: [OLD_MAIN], config: { windowDays: 365, activeDays: 90, minGames: 20 } }, OVERVIEW);
    expect(oldConfig.title).toBe('🏆 角色理論勝率排行 Top 10（各人最近 100 場，生涯至少 100 場，不限近期出賽）');
  });

  it('findBoard ignores boards without rows; findTheoryBoard also ignores pre-2026-10-13 boards', () => {
    expect(findBoard({ boards: [{ ...board('main', 'x', 0) }] }, 'main')).toBeNull();
    expect(findBoard(LEADERBOARD, 'last50')?.id).toBe('last50');
    expect(findBoard(LEADERBOARD, 'online')).toBeNull();
    expect(findBoard(null, 'main')).toBeNull();
    expect(findBoard({ boards: [OLD_MAIN] }, 'main')?.id).toBe('main');
    expect(findTheoryBoard({ boards: [OLD_MAIN] }, 'main')).toBeNull();
    expect(findTheoryBoard(LEADERBOARD, 'main')?.id).toBe('main');
  });
});

describe('boardView', () => {
  it('the title keeps only the first clause of the note — the legend is for the site, not a title in brackets', () => {
    expect(boardView(board('main', '角色理論勝率排行', 3)).title).toBe('🏆 角色理論勝率排行 Top 10（各人最近 100 場，近 90 天內有出賽、生涯至少 100 場）');
    expect(boardView(board('main', 'x', 1, { note: undefined })).title).toBe('🏆 x Top 10（各人最近 100 場）');
    expect(boardView(board('main', 'x', 1, { note: `；${LEGEND}` })).title).toBe('🏆 x Top 10（各人最近 100 場）');
  });

  it('falls back to `value` for a row without roleTheory and to "—" for the rest', () => {
    const b = { ...board('main', 'x', 1), rows: [{ rank: 1, name: 'A', value: 47.5, games: 100 }] };
    expect(boardView(b).rows[0]).toEqual({ rank: 1, name: 'A', roleTheory: 47.5, positionTheory: null, finalWinRate: null, games: 100 });
    expect(leaderboardLines(boardView(b))[1]).toBe('🥇 A　角色理論 47.5%｜位置理論 —｜最終 —｜100 場');
  });
});

describe('formatLeaderboard', () => {
  it('rows show rank, name, 角色理論, 位置理論, 最終 and the games of the window — nothing else', () => {
    const text = formatLeaderboard(OVERVIEW, selectLeaderboard(LEADERBOARD, OVERVIEW));
    const lines = text.split('\n');
    expect(lines[0]).toBe('🏆 角色理論勝率排行 Top 10（各人最近 100 場，近 90 天內有出賽、生涯至少 100 場）');
    expect(lines[1]).toBe('🥇 main1　角色理論 55.2%｜位置理論 54.0%｜最終 56.0%｜100 場');
    expect(lines[2]).toBe('🥈 main2　角色理論 54.5%｜位置理論 53.0%｜最終 55.0%｜100 場');
    expect(lines[4]).toBe('4. main4　角色理論 53.1%｜位置理論 51.0%｜最終 53.0%｜100 場');
    expect(lines[10]).toBe('10. main10　角色理論 48.9%｜位置理論 45.0%｜最終 47.0%｜100 場');
    expect(text).not.toContain('main11');
    expect(text).not.toContain('超額');
    expect(text).not.toContain('Σ');
  });

  it('totals line uses the final / mission / assassination stages, derived from outcomeBreakdown on an old cache', () => {
    const noStages = { ...OVERVIEW, missionStage: undefined, assassinationStage: undefined, final: undefined };
    // final red = (1013 + 533) / 2228 = 69.4%, blue = 682 / 2228 = 30.6%.
    expect(overviewTotalsLine(noStages)).toBe(
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

  it('digest sections: 進步榜 Top 5, 角色王 and 新人榜 after the main board, before the totals', () => {
    const improved = improvedLines(findBoard(LEADERBOARD, 'improved'));
    expect(improved[0]).toBe('🚀 進步榜 Top 5（各人最近 50 場 vs 再之前 50 場，近 90 天內有出賽、生涯至少 100 場）');
    expect(improved).toHaveLength(DIGEST_IMPROVED_SIZE + 1);
    expect(improved[1]).toBe('1. I1　+10.0（角色理論 50.0% ← 40.0%）');
    expect(improved[5]).toBe('5. I5　+6.0（角色理論 50.0% ← 44.0%）');
    expect(improvedLines(null)).toEqual([]);
    expect(improvedLines({ ...findBoard(LEADERBOARD, 'improved')!, metric: undefined })).toEqual([]); // a pre-2026-10-13 board

    const titles = roleTitlesLine(findBoard(LEADERBOARD, 'roleTitles'));
    expect(titles).toBe('👑 角色王（各人該角色最近 20 場）：刺客 HAO 90.0%、梅林 Sin 55.0%');
    expect(roleTitlesLine(null)).toBeNull();
    const newcomers = newcomersLine(findBoard(LEADERBOARD, 'newcomers'));
    expect(newcomers).toBe('🌱 新人榜（2026-07-15 ～ 2026-10-12 首次出賽，新人例外：看全部場次）：N1 角色理論 47.0%（13 場）');

    const text = formatLeaderboard(OVERVIEW, selectLeaderboard(LEADERBOARD, OVERVIEW), {
      header: '📅 每週排行（10/12）',
      sections: [improved, [titles!], [newcomers!]],
      footerLines: ['查個人：/戰績 名字'],
    });
    const lines = text.split('\n');
    expect(lines[0]).toBe('📅 每週排行（10/12）');
    expect(lines[1]).toContain('角色理論勝率排行 Top 10');
    expect(lines.indexOf(improved[0])).toBe(12);
    expect(lines.indexOf(titles!)).toBe(18);
    expect(lines.indexOf(newcomers!)).toBe(19);
    expect(lines[20]).toContain('📈 總計');
    expect(lines[21]).toBe('查個人：/戰績 名字');
    expect(lines[22]).toContain(STATS_SITE_URL);
  });

  it('drops the later sections first when the text would exceed the cap; the main board and totals always stay', () => {
    const main = selectLeaderboard(LEADERBOARD, OVERVIEW);
    const improved = improvedLines(findBoard(LEADERBOARD, 'improved'));
    const hugeTitles = `👑 ${'稱號'.repeat(900)}`;
    const withTitlesDropped = formatLeaderboard(OVERVIEW, main, { sections: [improved, [hugeTitles]] });
    expect(withTitlesDropped.length).toBeLessThanOrEqual(STATS_REPLY_MAX_CHARS);
    expect(withTitlesDropped).toContain('🚀 進步榜 Top 5');
    expect(withTitlesDropped).not.toContain('👑');
    expect(withTitlesDropped).toContain('📈 總計');
    expect(withTitlesDropped.endsWith('…')).toBe(false);

    const hugeImproved = [`🚀 ${'進'.repeat(1500)}`];
    const bothDropped = formatLeaderboard(OVERVIEW, main, { sections: [hugeImproved, [hugeTitles]] });
    expect(bothDropped).not.toContain('🚀');
    expect(bothDropped).not.toContain('👑');
    expect(bothDropped).toContain('10. main10');
    expect(bothDropped).toContain('📈 總計');
    expect(bothDropped.length).toBeLessThanOrEqual(STATS_REPLY_MAX_CHARS);
  });

  it('角色王 ties (Edward 2026-10-14「各給」): every holder of a role is named once under it', () => {
    const row = (rank: number, role: string, name: string, value: number) =>
      ({ rank, role, name, value, games: 20, wins: Math.round(value / 5), careerRoleGames: 40 - rank });
    const board: LeaderboardBoard = {
      id: 'roleTitles', metric: 'finalWinRate', title: '角色王', period: '各人該角色最近 20 場',
      rows: [
        row(1, '刺客', 'T1', 90),
        row(2, '莫甘娜', 'T2', 90), row(3, '莫甘娜', 'T3', 90),
        row(4, '梅林', 'T4', 50),
        row(5, '忠臣', 'T5', 45), row(6, '忠臣', 'T6', 45),
      ],
    };
    expect(roleTitlesLine(board)).toBe('👑 角色王（各人該角色最近 20 場）：刺客 T1 90.0%、莫甘娜 T2／T3 90.0%、梅林 T4 50.0%、忠臣 T5／T6 45.0%');
    // Many holders: the first ROLE_TITLE_NAMES_MAX in the cache's order, then how many there are.
    const crowd: LeaderboardBoard = {
      ...board,
      rows: Array.from({ length: ROLE_TITLE_NAMES_MAX + 2 }, (_, i) => row(i + 1, '忠臣', `L${i + 1}`, 50)),
    };
    const names = Array.from({ length: ROLE_TITLE_NAMES_MAX }, (_, i) => `L${i + 1}`).join('／');
    expect(roleTitlesLine(crowd)).toBe(`👑 角色王（各人該角色最近 20 場）：忠臣 ${names} 等 ${ROLE_TITLE_NAMES_MAX + 2} 人 50.0%`);
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

  it('help text exists for both platforms and advertises the role-theory ranking and /意見', () => {
    for (const platform of ['line', 'discord'] as const) {
      const text = formatStatsHelp(platform);
      expect(text).toContain(`/排行\u3000角色理論勝率排行 Top 10（${DEFAULT_LEADERBOARD_SCOPE}）`);
      expect(DEFAULT_LEADERBOARD_SCOPE).toBe('各角色近 10 場、忠臣近 40 場');
      // The window comes from the cache (statsQueries.leaderboardScopeText): a schemaVersion-3 cache still ranks by
      // the last 100 games; unknown (unreadable cache, pre-theory cache) names no window.
      expect(formatStatsHelp(platform, '各人最近 100 場')).toContain('/排行　角色理論勝率排行 Top 10（各人最近 100 場）');
      expect(formatStatsHelp(platform, null)).toContain('/排行　角色理論勝率排行 Top 10\n');
      expect(text).toContain('/意見 文字　給管理者的建議或回報問題');
      expect(text).toContain('/默契 名字1 名字2');
      expect(text).not.toContain('超額');
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

  it('passes the name on as typed (matching then ignores case)', () => {
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
      // schemaVersion 4 prints 整體理論（生涯 N 場）… and the 紅方 / 藍方 blocks; 3 prints 生涯 N 場｜角色理論…;
      // an older one the final win rate and when theory comes. (AVALON_ANALYSIS_CACHE=<a schema-4 build>
      // runs this smoke over that file instead of the committed one.)
      if (p.theory?.roleWindows) {
        expect(text, p.name).toMatch(/整體理論（生涯 \d+ 場）\d+\.\d%｜位置理論 \d+\.\d%｜最終勝率 \d+\.\d%/);
        expect(text, p.name).toMatch(/🔴 紅方 \d+ 場/);
      } else {
        expect(text, p.name).toMatch(p.theory ? /生涯 \d+ 場｜角色理論 \d+\.\d%｜位置理論 \d+\.\d%｜最終 \d+\.\d%/ : /最終勝率 \d+\.\d%/);
      }
      expect(text, p.name).not.toContain('超額');
      expect(text.length, p.name).toBeLessThanOrEqual(STATS_REPLY_MAX_CHARS);
    }
  });

  it('leaderboard, digest and a chemistry pair fit too', async () => {
    for (const text of [await leaderboardReply(), await weeklyDigestText(Date.UTC(2026, 9, 12, 4, 0))]) {
      // The role-theory board once the cache is regenerated (schemaVersion 3); before that the pending note.
      expect(text).toMatch(/角色理論勝率排行 Top 10|排行改版中/);
      expect(text).not.toContain('超額');
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
