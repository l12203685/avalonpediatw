/**
 * Stats replies (2026-10-10) — the pure formatter shared by the Discord and
 * LINE bots (bots/stats/statsReplies.ts), the LINE text-command parser, and a
 * smoke pass over the real analysis_cache.json through statsQueries.ts.
 */
import { describe, expect, it } from 'vitest';
import type { OverviewData, PlayerStats } from '../services/sheetsAnalysis';
import { getAllPlayerStats } from '../services/sheetsAnalysis';
import {
  MAX_NAME_CANDIDATES,
  STATS_REPLY_MAX_CHARS,
  STATS_SITE_URL,
  clampReply,
  formatChemistry,
  formatLeaderboard,
  formatNameProblem,
  formatPlayerCard,
  formatStatsHelp,
  lookupPair,
  matchPlayerName,
  selectLeaderboard,
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

describe('formatPlayerCard', () => {
  it('shows games, win rate, role-theory, strongest roles, archetype and playstyle, plus the site link', () => {
    const text = formatPlayerCard({
      player: player('HAO', 1013, { winRate: 59, roleTheory: 59.1, redWin: 56.6, blueWin: 60.5, rawRedGames: 378, rawBlueGames: 635 }),
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
    expect(text).toContain('📊 HAO 的戰績');
    expect(text).toContain('場次 1013｜勝率 59.0%｜角色理論勝率 59.1%');
    expect(text).toContain('紅方勝率 56.6%（378 場）');
    expect(text).toContain('擅長角色：刺客 62.3%（106 場）、梅林 65.6%（96 場）；較弱：莫甘娜 50.6%（89 場）');
    expect(text).toContain('誠實度 83（PR37）');
    expect(text).toContain('刺客目標座位偏好 5、2、6 號');
    expect(text).toContain('另有大小寫不同的玩家：Hao、hao');
    expect(text).toContain(STATS_SITE_URL);
  });

  it('omits sections the cache has no data for (small sample)', () => {
    const text = formatPlayerCard({
      player: player('新手', 3),
      strength: { roles: [], topRoles: [], bottomRoles: [], hasData: false },
      archetype: null,
      playstyle: null,
    });
    expect(text).toContain('場次 3');
    expect(text).not.toContain('擅長角色');
    expect(text).not.toContain('風格');
  });
});

const OVERVIEW: OverviewData = {
  totalGames: 2146,
  totalPlayers: 198,
  redWinRate: 46.6,
  blueWinRate: 53.4,
  merlinKillRate: 43.5,
  outcomeBreakdown: { threeRed: 0, threeBlueDead: 0, threeBlueAlive: 0, threeRedPct: 0, threeBlueDeadPct: 0, threeBlueAlivePct: 0 },
  topPlayersByTheory: Array.from({ length: 12 }, (_, i) => ({ name: `P${i + 1}`, roleTheory: 60 - i, winRate: 59 - i, games: 100 + i })),
  topPlayersByGames: [],
  seatPositionWinRates: [],
};

describe('leaderboard', () => {
  it('uses the same list as the website (overview.topPlayersByTheory), top 10', () => {
    const rows = selectLeaderboard(OVERVIEW);
    expect(rows.map((r) => r.name)).toEqual(['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10']);
  });

  it('falls back to roleTheory among ≥50-game players only when the cache list is missing', () => {
    const rows = selectLeaderboard({ topPlayersByTheory: [] }, [
      player('small', 20, { roleTheory: 90 }),
      player('b', 60, { roleTheory: 52 }),
      player('a', 300, { roleTheory: 57 }),
    ]);
    expect(rows.map((r) => r.name)).toEqual(['a', 'b']);
  });

  it('formats ranks, totals and red/blue win rates', () => {
    const text = formatLeaderboard(OVERVIEW, selectLeaderboard(OVERVIEW));
    expect(text.split('\n')[0]).toBe('🏆 理論勝率排行 Top 10');
    expect(text).toContain('🥇 P1　60.0%（勝率 59.0%・100 場）');
    expect(text).toContain('10. P10　51.0%');
    expect(text).not.toContain('P11');
    expect(text).toContain('總計 2146 場｜198 位玩家｜紅方勝率 46.6%｜藍方勝率 53.4%');
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

  it('help text exists for both platforms', () => {
    expect(formatStatsHelp('line')).toContain('/指令');
    expect(formatStatsHelp('discord')).not.toContain('/指令');
    expect(formatStatsHelp('discord')).toContain('/默契 名字1 名字2');
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
  it('every player card fits the reply budget', async () => {
    const players = await getAllPlayerStats();
    expect(players.length).toBeGreaterThan(0);
    for (const p of players) {
      const text = await playerCardReply(p.name);
      expect(text, p.name).toContain(`📊 ${p.name} 的戰績`);
      expect(text.length, p.name).toBeLessThanOrEqual(STATS_REPLY_MAX_CHARS);
    }
  });

  it('leaderboard, digest and a chemistry pair fit too', async () => {
    for (const text of [await leaderboardReply(), await weeklyDigestText(Date.UTC(2026, 9, 12, 4, 0))]) {
      expect(text).toContain('Top 10');
      expect(text.length).toBeLessThanOrEqual(STATS_REPLY_MAX_CHARS);
    }
    const players = await getAllPlayerStats();
    const [a, b] = players.slice().sort((x, y) => y.totalGames - x.totalGames);
    const text = await chemistryReply(a.name, b.name);
    expect(text).toContain('默契');
    expect(text.length).toBeLessThanOrEqual(STATS_REPLY_MAX_CHARS);
  });
});
