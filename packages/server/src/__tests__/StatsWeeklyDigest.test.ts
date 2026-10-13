/**
 * Weekly stats digest (2026-10-10): Monday 12:00 +08, posting window
 * 12:00–12:10, in-memory once-per-week guard, host-TZ independent.
 *
 * Plus the digest TEXT (statsQueries.weeklyDigestText, 2026-10-13): the main
 * board (角色理論, each player's last 100 games) Top 10 + 進步榜 Top 5 + 角色王 +
 * 新人榜, against a mocked analysis cache.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DigestDestination,
  WeeklyDigestScheduler,
  digestDateLabel,
  digestWeekKey,
  isDigestWindow,
  taipeiClock,
} from '../bots/stats/weeklyDigest';
import { weeklyDigestText } from '../bots/stats/statsQueries';
import { STATS_REPLY_MAX_CHARS } from '../bots/stats/statsReplies';
import type { LeaderboardBoard, LeaderboardRow } from '../services/sheetsAnalysis';

// ─── Mocked cache for the digest text ────────────────────────────────────

const cache = vi.hoisted(() => {
  // Boards as generate_cache.py (compute_leaderboard, asOf 2026-10-12) writes them since 2026-10-13: each
  // carries `metric`, the theory boards' notes end with the legend after a "；", and the rows hold the
  // numbers of each player's own last-N-games window.
  const LEGEND = '角色理論 = Σ 抽到該角色的機率（忠臣 4/10、其他角色各 1/10）× 本人該角色的最終勝率；位置理論 = Σ 1/10 × 本人該位置的最終勝率；不到 3 場的角色或位置，用全體的最終勝率補到 3 場';
  const theoryRow = (rank: number, name: string, roleTheory: number, games: number): LeaderboardRow => ({
    rank, name, value: roleTheory, roleTheory, positionTheory: roleTheory - 1, finalWinRate: roleTheory + 2, games, careerGames: 300 + rank,
    from: '2026-05-01', to: '2026-10-10', sparseRoles: 0, sparseSeats: 0,
  });
  const rows = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => theoryRow(i + 1, `${prefix}${i + 1}`, 55 - i, 100));
  const improvedRow = (rank: number, name: string, recent: number, prior: number): LeaderboardRow => ({
    rank, name, value: Math.round((recent - prior) * 10) / 10, recentRoleTheory: recent, priorRoleTheory: prior,
    recentFinalWinRate: recent, priorFinalWinRate: prior, recentGames: 50, priorGames: 50, games: 50, careerGames: 200,
  });
  const titleRow = (rank: number, role: string, name: string, value: number, wins: number): LeaderboardRow => ({
    rank, role, name, value, games: 20, wins, careerRoleGames: 40,
  });
  const boards = (): LeaderboardBoard[] => [
    { id: 'main', metric: 'roleTheory', title: '角色理論勝率排行', period: '各人最近 100 場', windowGames: 100, minGames: 100, note: `近 90 天內有出賽、生涯至少 100 場；${LEGEND}`, rows: rows('M', 12) },
    { id: 'last50', metric: 'roleTheory', title: '近 50 場角色理論勝率', period: '各人最近 50 場', windowGames: 50, minGames: 50, note: `近 90 天內有出賽、生涯至少 50 場；${LEGEND}`, rows: rows('L', 12) },
    {
      id: 'improved', metric: 'roleTheoryDelta', title: '進步榜', period: '各人最近 50 場 vs 再之前 50 場', windowGames: 50, minGames: 100,
      note: `近 90 天內有出賽、生涯至少 100 場；最近 50 場的角色理論勝率 − 再之前 50 場的，只列有進步的人；${LEGEND}`,
      rows: Array.from({ length: 7 }, (_, i) => improvedRow(i + 1, `I${i + 1}`, 50, 40 + i)),
    },
    {
      id: 'assassin', metric: 'hitRate', title: '刺客刺中率', period: '各人最近 20 次刺殺', windowGames: 20, minGames: 10,
      note: '近 90 天內有出賽、至少 10 次刺殺；刺中率 = 三藍死 /（三藍死 + 三藍活）',
      rows: [{ rank: 1, name: 'A1', value: 60, hits: 12, attempts: 20, games: 20, careerGames: 400 }],
    },
    {
      id: 'newcomers', metric: 'roleTheory', title: '新人榜', period: '2026-07-15 ～ 2026-10-12 首次出賽', windowDays: 90, allGames: true, minGames: 10,
      note: `首次出賽在近 90 天內、至少 10 場；例外：新人場數少，用他的全部場次；${LEGEND}`,
      rows: [{ ...theoryRow(1, 'N1', 47, 13), firstPlayed: '2026-08-01' }, { ...theoryRow(2, 'N2', 45.5, 11), firstPlayed: '2026-09-01' }],
    },
    {
      id: 'roleTitles', metric: 'finalWinRate', title: '角色王', period: '各人該角色最近 20 場', windowGames: 20, minGames: 20,
      note: '近 90 天內有出賽、生涯該角色至少 20 場；比各人該角色最近 20 場的最終勝率',
      rows: [titleRow(1, '刺客', 'HAO', 90, 18), titleRow(2, '梅林', 'Sin', 55, 11)],
    },
  ];
  return {
    overview: {
      totalGames: 2228, totalPlayers: 221, redWinRate: 45.5, blueWinRate: 54.5, merlinKillRate: 43.9,
      outcomeBreakdown: { threeRed: 1013, threeBlueDead: 533, threeBlueAlive: 682, threeRedPct: 45.5, threeBlueDeadPct: 23.9, threeBlueAlivePct: 30.6 },
      topPlayersByTheory: [{ name: 'T1', roleTheory: 60, winRate: 59, games: 100 }],
      topPlayersByGames: [], seatPositionWinRates: [],
    } as Record<string, unknown>,
    leaderboard: { asOf: '2026-10-12', boards: boards() } as { asOf: string; boards: ReturnType<typeof boards> } | null,
    boards,
    players: [] as unknown[],
  };
});

// Only the cache readers are mocked; the real helpers (rnd1, used by the bots' shrunk ordering) stay.
vi.mock('../services/sheetsAnalysis', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/sheetsAnalysis')>()),
  getOverview: async () => cache.overview,
  getLeaderboard: async () => cache.leaderboard,
  getAllPlayerStats: async () => cache.players,
}));

/** Epoch ms for a +08 wall-clock time (month is 1-based). */
const tpe = (y: number, mo: number, d: number, h: number, mi = 0, s = 0) => Date.UTC(y, mo - 1, d, h - 8, mi, s);

// 2026-10-12 is a Monday.
const MON_1200 = tpe(2026, 10, 12, 12, 0);

const quiet = { info: vi.fn(), warn: vi.fn() };

function recorder(name: string, result: boolean | 'skip' = true): DigestDestination & { sent: string[] } {
  const sent: string[] = [];
  return {
    name,
    sent,
    send: async (text: string) => {
      sent.push(text);
      return result;
    },
  };
}

function scheduler(dests: DigestDestination[], opts: { enabled?: boolean; buildText?: (now: number) => Promise<string> } = {}) {
  return new WeeklyDigestScheduler({
    buildText: opts.buildText ?? (async (now) => `排行 ${digestDateLabel(now)}`),
    destinations: dests,
    enabled: opts.enabled,
    logger: quiet,
  });
}

const originalTZ = process.env.TZ;
afterEach(() => {
  if (originalTZ === undefined) delete process.env.TZ;
  else process.env.TZ = originalTZ;
});

describe('+08 Monday detection', () => {
  it('Monday 12:00 +08 is Monday 04:00 UTC', () => {
    expect(MON_1200).toBe(Date.UTC(2026, 9, 12, 4, 0));
    expect(taipeiClock(MON_1200)).toEqual({ weekday: 1, hour: 12, minute: 0, date: '2026-10-12' });
  });

  it('uses +08, not UTC, across the date line', () => {
    // Sunday 16:30 UTC = Monday 00:30 +08.
    expect(taipeiClock(Date.UTC(2026, 9, 11, 16, 30))).toMatchObject({ weekday: 1, date: '2026-10-12' });
    // Monday 20:00 UTC = Tuesday 04:00 +08 — not Monday any more.
    expect(taipeiClock(Date.UTC(2026, 9, 12, 20, 0))).toMatchObject({ weekday: 2, date: '2026-10-13' });
    // Monday 12:00 UTC is Monday 20:00 +08 — outside the window.
    expect(isDigestWindow(Date.UTC(2026, 9, 12, 12, 0))).toBe(false);
  });

  it('window is exactly Monday 12:00:00 ≤ t < 12:10:00 +08', () => {
    expect(isDigestWindow(tpe(2026, 10, 12, 11, 59, 59))).toBe(false);
    expect(isDigestWindow(MON_1200)).toBe(true);
    expect(isDigestWindow(tpe(2026, 10, 12, 12, 9, 59))).toBe(true);
    expect(isDigestWindow(tpe(2026, 10, 12, 12, 10, 0))).toBe(false);
    expect(isDigestWindow(tpe(2026, 10, 13, 12, 0))).toBe(false); // Tuesday
    expect(isDigestWindow(tpe(2026, 10, 11, 12, 0))).toBe(false); // Sunday
  });

  it('does not depend on the host TZ', () => {
    const before = [taipeiClock(MON_1200), isDigestWindow(MON_1200), digestWeekKey(MON_1200)];
    for (const tz of ['UTC', 'America/Los_Angeles', 'Asia/Tokyo', 'Pacific/Kiritimati']) {
      process.env.TZ = tz;
      expect([taipeiClock(MON_1200), isDigestWindow(MON_1200), digestWeekKey(MON_1200)]).toEqual(before);
    }
  });

  it('week key is the +08 Monday of that week', () => {
    expect(digestWeekKey(MON_1200)).toBe('2026-10-12');
    expect(digestWeekKey(tpe(2026, 10, 18, 23, 59))).toBe('2026-10-12'); // Sunday night, same week
    expect(digestWeekKey(tpe(2026, 10, 19, 0, 0))).toBe('2026-10-19');
    expect(digestDateLabel(MON_1200)).toBe('10/12');
  });
});

describe('WeeklyDigestScheduler', () => {
  it('posts once inside the window, to every destination', async () => {
    const discord = recorder('discord');
    const line = recorder('line');
    const s = scheduler([discord, line]);
    expect(await s.tick(MON_1200 + 30_000)).toBe('posted');
    expect(discord.sent).toEqual(['排行 10/12']);
    expect(line.sent).toEqual(['排行 10/12']);
    expect(s.getState().lastPostedWeek).toEqual({ discord: '2026-10-12', line: '2026-10-12' });
  });

  it('never posts twice in the same week (every minute of the window)', async () => {
    const discord = recorder('discord');
    const s = scheduler([discord]);
    const results: string[] = [];
    for (let m = 0; m < 10; m++) results.push(await s.tick(MON_1200 + m * 60_000));
    expect(results[0]).toBe('posted');
    expect(results.slice(1).every((r) => r === 'already-posted')).toBe(true);
    expect(discord.sent).toHaveLength(1);
  });

  it('never posts outside the window, including right after a restart', async () => {
    const discord = recorder('discord');
    // A fresh instance has no memory — e.g. Render restarted at 12:15 after posting at 12:00.
    const restarted = scheduler([discord]);
    for (const t of [tpe(2026, 10, 12, 12, 15), tpe(2026, 10, 12, 11, 59), tpe(2026, 10, 13, 12, 0), tpe(2026, 10, 12, 0, 0)]) {
      expect(await restarted.tick(t)).toBe('outside-window');
    }
    expect(discord.sent).toEqual([]);
  });

  it('posts again the following Monday', async () => {
    const discord = recorder('discord');
    const s = scheduler([discord]);
    await s.tick(MON_1200);
    expect(await s.tick(MON_1200 + 7 * 24 * 3600_000)).toBe('posted');
    expect(discord.sent).toEqual(['排行 10/12', '排行 10/19']);
  });

  it('retries an unavailable destination within the window only, without reposting the others', async () => {
    const line = recorder('line');
    let discordReady = false;
    const discordSent: string[] = [];
    const discord: DigestDestination = {
      name: 'discord',
      send: async (text) => {
        if (!discordReady) return false;
        discordSent.push(text);
        return true;
      },
    };
    const s = scheduler([discord, line]);
    expect(await s.tick(MON_1200)).toBe('partial');
    discordReady = true;
    expect(await s.tick(MON_1200 + 60_000)).toBe('posted');
    expect(discordSent).toHaveLength(1);
    expect(line.sent).toHaveLength(1);

    // Discord never ready during the next window → nothing after it closes.
    discordReady = false;
    const nextMon = MON_1200 + 7 * 24 * 3600_000;
    await s.tick(nextMon);
    discordReady = true;
    expect(await s.tick(nextMon + 10 * 60_000)).toBe('outside-window');
    expect(discordSent).toHaveLength(1);
  });

  it("'skip' (destination not configured) counts as done; thrown errors are retried", async () => {
    const skipped = recorder('line', 'skip');
    let calls = 0;
    const flaky: DigestDestination = {
      name: 'discord',
      send: async () => {
        calls += 1;
        if (calls === 1) throw new Error('fetch failed');
        return true;
      },
    };
    const s = scheduler([flaky, skipped]);
    expect(await s.tick(MON_1200)).toBe('partial');
    expect(await s.tick(MON_1200 + 60_000)).toBe('posted');
    expect(skipped.sent).toHaveLength(1);
    expect(calls).toBe(2);
  });

  it('does not post when the text cannot be built (cache unreadable)', async () => {
    const discord = recorder('discord');
    const s = scheduler([discord], { buildText: async () => { throw new Error('no cache'); } });
    expect(await s.tick(MON_1200)).toBe('failed');
    expect(discord.sent).toEqual([]);
  });

  it('concurrent ticks post once', async () => {
    const discord = recorder('discord');
    const s = scheduler([discord]);
    const [a, b] = await Promise.all([s.tick(MON_1200), s.tick(MON_1200)]);
    expect([a, b].sort()).toEqual(['busy', 'posted']);
    expect(discord.sent).toHaveLength(1);
  });

  it('STATS_DIGEST_ENABLED=false (enabled: false) never posts', async () => {
    const discord = recorder('discord');
    const s = scheduler([discord], { enabled: false });
    expect(await s.tick(MON_1200)).toBe('disabled');
    s.start();
    expect(s.getState().running).toBe(false);
    expect(discord.sent).toEqual([]);
  });

  it('start() ticks every minute and stop() clears the timer', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(MON_1200 - 60_000); // 11:59 +08
      const discord = recorder('discord');
      const s = scheduler([discord]);
      s.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(discord.sent).toEqual([]);
      await vi.advanceTimersByTimeAsync(60_000); // 12:00
      expect(discord.sent).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(9 * 60_000);
      expect(discord.sent).toHaveLength(1);
      s.stop();
      expect(s.getState().running).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('weeklyDigestText', () => {
  const MONDAY = Date.UTC(2026, 9, 12, 4, 0); // 2026-10-12 12:00 +08

  afterEach(() => {
    cache.leaderboard = { asOf: '2026-10-12', boards: cache.boards() };
  });

  it('dated header, main Top 10, 進步榜 Top 5, 角色王, 新人榜, totals, how-to line — within the cap', async () => {
    const text = await weeklyDigestText(MONDAY);
    const lines = text.split('\n');
    expect(lines[0]).toBe('📅 每週排行（10/12）');
    // Title: period + the note's qualifier only; the legend after "；" never reaches the digest.
    expect(lines[1]).toBe('🏆 角色理論勝率排行 Top 10（各人最近 100 場，近 90 天內有出賽、生涯至少 100 場）');
    expect(lines[2]).toBe('🥇 M1　角色理論 55.0%｜位置理論 54.0%｜最終 57.0%｜100 場');
    expect(lines[11]).toBe('10. M10　角色理論 46.0%｜位置理論 45.0%｜最終 48.0%｜100 場');
    expect(text).not.toContain('M11');
    expect(text).not.toContain('Σ');
    expect(lines[12]).toBe('🚀 進步榜 Top 5（各人最近 50 場 vs 再之前 50 場，近 90 天內有出賽、生涯至少 100 場）');
    expect(lines[13]).toBe('1. I1　+10.0（角色理論 50.0% ← 40.0%）');
    expect(lines[17]).toBe('5. I5　+6.0（角色理論 50.0% ← 44.0%）');
    expect(text).not.toContain('I6');
    expect(lines[18]).toBe('👑 角色王（各人該角色最近 20 場）：刺客 HAO 90.0%、梅林 Sin 55.0%');
    expect(lines[19]).toBe('🌱 新人榜（2026-07-15 ～ 2026-10-12 首次出賽，新人例外：看全部場次）：N1 角色理論 47.0%（13 場）、N2 角色理論 45.5%（11 場）');
    expect(lines[20]).toBe('📈 總計 2228 場｜221 位玩家｜最終紅勝 69.4%／藍勝 30.6%（任務結算 紅 45.5%／藍 54.5%，三藍局刺中 43.9%）');
    expect(lines[21]).toBe('查個人：/戰績 名字｜兩人默契：/默契 名字1 名字2');
    expect(lines[22]).toContain('🔗 完整圖表');
    expect(lines).toHaveLength(23);
    // Boards the digest does not show stay out.
    expect(text).not.toContain('刺中率');
    expect(text).not.toContain('A1');
    expect(text).not.toContain('L1');
    expect(text).not.toContain('超額');
    expect(text.length).toBeLessThanOrEqual(STATS_REPLY_MAX_CHARS);
  });

  it('drops the 新人榜, then 角色王, then 進步榜 when the text would exceed the cap', async () => {
    const boards = cache.boards();
    const newcomers = boards.find((b) => b.id === 'newcomers')!;
    newcomers.rows = newcomers.rows.map((r) => ({ ...r, name: `${r.name}${'名'.repeat(500)}` }));
    cache.leaderboard = { asOf: '2026-10-12', boards };
    const text = await weeklyDigestText(MONDAY);
    expect(text.length).toBeLessThanOrEqual(STATS_REPLY_MAX_CHARS);
    expect(text).not.toContain('🌱');
    expect(text).toContain('👑 角色王');
    expect(text).toContain('🚀 進步榜 Top 5');
    expect(text).toContain('📈 總計');
    expect(text).toContain('查個人：/戰績 名字');

    const improved = boards.find((b) => b.id === 'improved')!;
    improved.rows = improved.rows.map((r) => ({ ...r, name: `${r.name}${'名'.repeat(300)}` }));
    cache.leaderboard = { asOf: '2026-10-12', boards };
    const again = await weeklyDigestText(MONDAY);
    expect(again.length).toBeLessThanOrEqual(STATS_REPLY_MAX_CHARS);
    expect(again).not.toContain('🚀');
    expect(again).not.toContain('👑');
    expect(again).not.toContain('🌱');
    expect(again).toContain('10. M10');
    expect(again).toContain('📈 總計');
  });

  it('a cache written before the theory boards posts no excess: the overview ranking, else the pending note', async () => {
    // Pre-2026-10-13 boards (no `metric`): never printed.
    cache.leaderboard = { asOf: '2026-10-12', boards: cache.boards().map(({ metric: _m, ...b }) => b) };
    let text = await weeklyDigestText(MONDAY);
    expect(text.split('\n')[0]).toBe('📅 每週排行（10/12）');
    expect(text).toContain('🏆 角色理論勝率排行\n（排行改版中：下次每日更新資料後，會改用「各人最近 100 場」的角色理論勝率排行）');
    expect(text).not.toContain('M1');
    expect(text).not.toContain('🚀');
    expect(text).not.toContain('👑');
    expect(text).not.toContain('T1'); // the legacy roleTheory ranking is not a fallback any more
    expect(text).toContain('查個人：/戰績 名字｜兩人默契：/默契 名字1 名字2');

    cache.leaderboard = null;
    const overview = cache.overview;
    cache.overview = { ...overview, schemaVersion: 3, topPlayersByRoleTheory: [{ name: 'O1', roleTheory: 51.2, positionTheory: 50.1, finalWinRate: 49, games: 100, careerGames: 640 }] };
    try {
      text = await weeklyDigestText(MONDAY);
      expect(text).toContain('🏆 角色理論勝率排行 Top 10（各人最近 100 場，生涯至少 100 場，不限近期出賽）\n🥇 O1　角色理論 51.2%｜位置理論 50.1%｜最終 49.0%｜100 場');
      cache.overview = { ...overview, schemaVersion: 3, topPlayersByRoleTheory: [] };
      text = await weeklyDigestText(MONDAY);
      expect(text).toContain('（目前沒有符合條件的玩家：近 90 天內有出賽、生涯至少 100 場）');
    } finally {
      cache.overview = overview;
    }
  });
});
