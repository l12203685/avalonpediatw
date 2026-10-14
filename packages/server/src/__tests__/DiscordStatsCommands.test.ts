/**
 * Discord stats slash commands (2026-10-10): /戰績 /排行 /默契.
 *
 * The analysis cache is mocked with a small fixture so the assertions do not
 * depend on the real sheet (which is regenerated independently). The
 * interaction is a hand-rolled mock — no discord.js runtime.
 */
import { describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => {
  const base = {
    positionTheory: 0, red3Red: 0, redMerlinDead: 0, redMerlinAlive: 0, blue3Red: 0, blueMerlinDead: 0,
    blueMerlinAlive: 0, roleWinRates: {}, roleDistribution: {}, redRoleRate: 0, blueRoleRate: 0, seatWinRates: {},
    seatRedWinRates: {}, seatBlueWinRates: {}, rawRoleGames: {}, rawRedWins: 0, rawBlueWins: 0, rawTotalWins: 0,
  };
  // Players as served by sheetsAnalysis: the two-stage fields (finalWinRate …) are already filled in.
  const p = (name: string, totalGames: number, winRate: number, roleTheory: number, finalWinRate: number, excessWinRate: number | null) => ({
    ...base, name, totalGames, winRate, roleTheory, redWin: winRate - 2, blueWin: winRate + 1,
    rawRedGames: Math.round(totalGames * 0.4), rawBlueGames: totalGames - Math.round(totalGames * 0.4),
    finalWinRate, excessWinRate, expectedFinalWinRate: excessWinRate === null ? null : finalWinRate - excessWinRate,
    finalRedWinRate: finalWinRate + 30, finalBlueWinRate: finalWinRate - 8, missionWinRate: winRate, merlinSurvivalRate: 55, rawBlueThreeBlue: 10,
  });
  // players[].theory (schemaVersion 3): 角色理論／位置理論／最終勝率 per window of the player's own games.
  const tw = (window: number, games: number, roleTheory: number, positionTheory: number, finalWinRate: number) => ({
    window, games, roleTheory, positionTheory, finalWinRate, from: '2026-05-01', to: '2026-10-10', sparseRoles: 0, sparseSeats: 0,
  });
  // A schemaVersion-4 row (2026-10-14; invented name): roleWindows (10 per special role, 40 as 忠臣),
  // last100, career, the per-side raw outcome counts and roleOutcomes.
  const roleWindows = {
    roleTheory: 53.4, fullWindows: true, games: 100, sparseRoles: 0, from: '2026-05-01', to: '2026-10-10',
    roles: Object.fromEntries(['刺客', '莫甘娜', '莫德雷德', '奧伯倫', '派西維爾', '梅林', '忠臣'].map((r) => [r, { games: r === '忠臣' ? 40 : 10, wins: 5, window: r === '忠臣' ? 40 : 10, rate: 50 }])),
  };
  const tovo = {
    ...p('Tovo Wren', 420, 55, 55.1, 44.3, 1.1),
    rawRedThreeRed: 80, rawRedMerlinDead: 40, rawRedMerlinAlive: 48, rawBlueThreeRed: 110, rawBlueMerlinDead: 60, rawBlueMerlinAlive: 82,
    roleOutcomes: { 刺客: { 三紅: 20, 三藍死: 10, 三藍活: 12 } },
    theory: { roleWindows, last100: tw(100, 100, 50.2, 51.7, 47), career: tw(0, 420, 49.9, 48.8, 44.3) },
  };
  // A schemaVersion-4 newcomer (invented name): 24 games, role windows not full, ranked on the 新人榜.
  const ilse = {
    ...p('Ilse Marr', 24, 50, 50, 45.8, null),
    rawRedThreeRed: 4, rawRedMerlinDead: 3, rawRedMerlinAlive: 3, rawBlueThreeRed: 6, rawBlueMerlinDead: 3, rawBlueMerlinAlive: 5,
    theory: { roleWindows: { ...roleWindows, roleTheory: 47, fullWindows: false, games: 21 }, last100: tw(100, 24, 46, 47.5, 45.8), career: tw(0, 24, 47, 47.5, 45.8) },
  };
  const players = [
    p('Sin', 1080, 51.4, 51.3, 31.2, -1.4), { ...p('HAO', 1013, 59, 59.1, 38.5, 6.3), theory: { last100: tw(100, 100, 52.3, 50.8, 49), last50: tw(50, 50, 55.1, 53.2, 52), career: tw(0, 1013, 47.9, 47.2, 38.5) } },
    p('尼克', 873, 47.3, 47.5, 30.1, -2), p('SIN', 3, 33.3, 30, 33.3, null), p('sin', 1, 0, 0, 0, null), p('溫', 31, 64.5, 64.6, 45.2, 12.1), tovo, ilse,
  ];
  const labels = ['SIN', 'HAO', '尼克'];
  // As generate_cache.py writes the theory boards: the qualifier, then the legend after a "；".
  const LEGEND = '角色理論 = Σ 抽到該角色的機率（忠臣 4/10、其他角色各 1/10）× 本人該角色的最終勝率；位置理論 = Σ 1/10 × 本人該位置的最終勝率；不到 3 場的角色或位置，用全體的最終勝率補到 3 場';
  const row = (rank: number, name: string, roleTheory: number, positionTheory: number, finalWinRate: number, careerGames: number) => ({
    rank, name, value: roleTheory, roleTheory, positionTheory, finalWinRate, games: 100, careerGames, from: '2026-05-01', to: '2026-10-10', sparseRoles: 0, sparseSeats: 0,
  });
  return {
    players,
    overview: {
      totalGames: 2228, totalPlayers: 221, redWinRate: 45.5, blueWinRate: 54.5, merlinKillRate: 43.9,
      outcomeBreakdown: { threeRed: 1013, threeBlueDead: 533, threeBlueAlive: 682, threeRedPct: 45.5, threeBlueDeadPct: 23.9, threeBlueAlivePct: 30.6 },
      topPlayersByTheory: [
        { name: '溫', roleTheory: 64.6, winRate: 64.5, games: 31 },
        { name: 'HAO', roleTheory: 59.1, winRate: 59, games: 1013 },
        { name: 'Sin', roleTheory: 51.3, winRate: 51.4, games: 1080 },
      ],
      topPlayersByGames: [], seatPositionWinRates: [], schemaVersion: 3,
    },
    // The cache's precomputed boards (generate_cache.py LEADERBOARD_CONFIG) — what /排行 leads with.
    leaderboard: {
      asOf: '2026-10-12',
      boards: [
        {
          id: 'main', metric: 'roleTheory', title: '角色理論勝率排行', period: '各人最近 100 場', windowGames: 100, minGames: 100,
          note: `近 90 天內有出賽、生涯至少 100 場；${LEGEND}`,
          rows: [row(1, 'HAO', 52.3, 50.8, 49, 1013), row(2, 'Sin', 48.4, 47.1, 46, 1080), row(3, '尼克', 46, 49.5, 44, 873)],
        },
        {
          id: 'improved', metric: 'roleTheoryDelta', title: '進步榜', period: '各人最近 50 場 vs 再之前 50 場', windowGames: 50, minGames: 100,
          note: `近 90 天內有出賽、生涯至少 100 場；最近 50 場的角色理論勝率 − 再之前 50 場的，只列有進步的人；${LEGEND}`,
          rows: [{ rank: 1, name: 'HAO', value: 4.2, recentRoleTheory: 55.1, priorRoleTheory: 50.9, games: 50, careerGames: 1013 }],
        },
        {
          id: 'newcomers', metric: 'roleTheory', title: '新人榜', period: '2026-07-15 ～ 2026-10-12 首次出賽', windowDays: 90, allGames: true, minGames: 10,
          note: `首次出賽在近 90 天內、至少 10 場；${LEGEND}`,
          rows: [{ ...row(1, 'Ilse Marr', 47, 47.5, 45.8, 24), games: 21, overallTheory: 47, firstPlayed: '2026-08-01' }],
        },
      ],
    },
    chemistry: {
      coWin: { players: labels, rowLabels: labels, values: [[452, 108, 111], [108, 467, 120], [111, 120, 337]] },
      coLose: { players: labels, rowLabels: labels, values: [[503, 131, 140], [131, 414, 120], [140, 120, 404]] },
      winCorr: { players: labels, values: [] },
      coWinMinusLose: { players: labels, values: [] },
    },
  };
});

// Only the cache readers are mocked; the real helpers (rnd1, used by the bots' shrunk ordering) stay.
vi.mock('../services/sheetsAnalysis', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/sheetsAnalysis')>()),
  getAllPlayerStats: async () => fixture.players,
  getPlayerByName: async (name: string) => fixture.players.find((pl) => pl.name === name) ?? null,
  getOverview: async () => fixture.overview,
  getLeaderboard: async () => fixture.leaderboard,
  getChemistry: async () => fixture.chemistry,
  getPlayerArchetype: async () => null,
  getPlayerStrength: async () => null,
  getPlayerPlaystyle: async () => null,
}));

import { COMMANDS, STATS_OPTIONS } from '../bots/discord/config';
import {
  handleChemistryCommand,
  handleHelpCommand,
  handleLeaderboardCommand,
  handleStatsCommand,
} from '../bots/discord/commands';
import { buildSlashCommands } from '../bots/discord/client';
import { STATS_REPLY_MAX_CHARS, STATS_SITE_URL } from '../bots/stats/statsReplies';

function makeInteraction(commandName: string, options: Record<string, string> = {}) {
  const fake = {
    commandName,
    user: { id: 'u-1', username: 'user-1' },
    deferred: false,
    replied: false,
    deferReply: vi.fn(async (_opts?: unknown) => {
      fake.deferred = true;
    }),
    editReply: vi.fn(async (_payload: unknown) => {}),
    reply: vi.fn(async (_payload: unknown) => {
      fake.replied = true;
    }),
    followUp: vi.fn(async (_payload: unknown) => {}),
    options: {
      getString: vi.fn((name: string, required?: boolean) => {
        const v = options[name];
        if (v === undefined && required) throw new Error(`missing option ${name}`);
        return v ?? null;
      }),
    },
  };
  return fake;
}

/** The single public reply a stats handler produced. */
function publicReply(interaction: ReturnType<typeof makeInteraction>): { content: string; allowedMentions?: unknown; flags?: unknown } {
  expect(interaction.deferReply).toHaveBeenCalledTimes(1);
  // Deferred without the ephemeral flag → the channel sees the answer.
  const deferArg = interaction.deferReply.mock.calls[0][0] as { flags?: unknown; ephemeral?: boolean } | undefined;
  expect(deferArg?.flags).toBeUndefined();
  expect(deferArg?.ephemeral).toBeFalsy();
  expect(interaction.editReply).toHaveBeenCalledTimes(1);
  expect(interaction.reply).not.toHaveBeenCalled();
  const payload = interaction.editReply.mock.calls[0][0] as { content: string; allowedMentions?: unknown; flags?: unknown };
  expect(payload.flags).toBeUndefined();
  expect(payload.allowedMentions).toEqual({ parse: [] });
  expect(payload.content.length).toBeLessThanOrEqual(STATS_REPLY_MAX_CHARS);
  return payload;
}

describe('slash command registration', () => {
  it('registers /戰績 /排行 /默契 next to the existing commands and passes discord.js validation', () => {
    const json = buildSlashCommands().map((c) => c.toJSON());
    const names = json.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining([COMMANDS.HELP, COMMANDS.RULES, COMMANDS.ROLES, '戰績', '排行', '默契']));
    for (const c of json) {
      // Discord naming rule: 1–32 chars, lowercase where the script has case.
      expect(c.name.length).toBeGreaterThanOrEqual(1);
      expect(c.name.length).toBeLessThanOrEqual(32);
      expect(c.name).toBe(c.name.toLowerCase());
      expect(c.description.length).toBeLessThanOrEqual(100);
    }
    const stats = json.find((c) => c.name === COMMANDS.STATS);
    expect(stats?.options).toEqual([expect.objectContaining({ name: STATS_OPTIONS.NAME, required: true })]);
    const chem = json.find((c) => c.name === COMMANDS.CHEMISTRY);
    expect(chem?.options?.map((o) => o.name)).toEqual([STATS_OPTIONS.PLAYER_A, STATS_OPTIONS.PLAYER_B]);
  });
});

describe('/戰績', () => {
  it('replies publicly with the player card', async () => {
    const it1 = makeInteraction(COMMANDS.STATS, { [STATS_OPTIONS.NAME]: 'HAO' });
    await handleStatsCommand(it1 as never);
    const { content } = publicReply(it1);
    const lines = content.split('\n');
    expect(lines.slice(0, 4)).toEqual([
      '📊 HAO 的戰績',
      '近 100 場｜角色理論 52.3%｜位置理論 50.8%｜最終 49.0%',
      '近 50 場｜角色理論 55.1%｜位置理論 53.2%｜最終 52.0%',
      '生涯 1013 場｜角色理論 47.9%｜位置理論 47.2%｜最終 38.5%',
    ]);
    expect(content).toContain('任務結算 59.0% → 刺殺結算（三藍局：藍方存活 55.0%）→ 最終 38.5%');
    expect(content).toContain('🔴 紅方最終勝率 68.5%（405 場）｜🔵 藍方最終勝率 30.5%（608 場）');
    expect(content).toContain('※ 角色理論 = Σ 抽到該角色的機率');
    expect(content).not.toContain('超額');
    expect(content).toContain(STATS_SITE_URL);
  });

  it('a schemaVersion-4 player: 角色理論 / 位置理論 / 整體理論 windows, then the 紅方 / 藍方 conditional blocks', async () => {
    const it1 = makeInteraction(COMMANDS.STATS, { [STATS_OPTIONS.NAME]: 'tovo wren' });
    await handleStatsCommand(it1 as never);
    const lines = publicReply(it1).content.split('\n');
    expect(lines.slice(0, 6)).toEqual([
      '📊 Tovo Wren 的戰績',
      '角色理論（各角色近 10 場、忠臣近 40 場）53.4%',
      '位置理論（近 100 場）51.7%｜最終勝率 47.0%',
      '整體理論（生涯 420 場）49.9%｜位置理論 48.8%｜最終勝率 44.3%',
      // red 168: 三紅 80, 三藍死 40, 三藍活 48 → 80 / 168, 40 / 88, 120 / 168.
      '🔴 紅方 168 場｜任務結果 47.6%｜刺殺結果 45.5%（三藍 88 場）｜遊戲結果 71.4%',
      // blue 252: 三紅 110, 三藍死 60, 三藍活 82 → 142 / 252, 82 / 142, 82 / 252.
      '🔵 藍方 252 場｜任務結果 56.3%｜刺殺結果 57.7%（三藍 142 場）｜遊戲結果 32.5%',
    ]);
  });

  it('a newcomer whose role windows are not full is told their 新人榜 rank, not that they are unranked', async () => {
    const it1 = makeInteraction(COMMANDS.STATS, { [STATS_OPTIONS.NAME]: 'ilse marr' });
    await handleStatsCommand(it1 as never);
    const { content } = publicReply(it1);
    expect(content.split('\n')[1]).toBe('角色理論（各角色近 10 場、忠臣近 40 場）47.0%（目前 21 場，還沒有每個角色都打滿，不列入角色理論勝率排行；新人榜第 1 名）');
    expect(content).not.toContain('不列入排行');
  });

  it('resolves a unique substring', async () => {
    const it1 = makeInteraction(COMMANDS.STATS, { [STATS_OPTIONS.NAME]: '尼' });
    await handleStatsCommand(it1 as never);
    expect(publicReply(it1).content).toContain('📊 尼克 的戰績');
  });

  it('a name typed in another case finds the player (an old cache\'s other spellings are a hint)', async () => {
    const it1 = makeInteraction(COMMANDS.STATS, { [STATS_OPTIONS.NAME]: 'sIN' });
    await handleStatsCommand(it1 as never);
    const { content } = publicReply(it1);
    expect(content).toContain('📊 Sin 的戰績');
    expect(content).toContain('大小寫不同的寫法目前另列：SIN、sin');
  });

  it('says so when nobody matches, without pinging anyone it echoes', async () => {
    const it1 = makeInteraction(COMMANDS.STATS, { [STATS_OPTIONS.NAME]: '@everyone' });
    await handleStatsCommand(it1 as never);
    const { content } = publicReply(it1);
    expect(content).toContain('找不到玩家「@everyone」');
    expect(content).toContain('/戰績 名字');
  });
});

describe('/排行', () => {
  it('replies publicly with the cache main board (角色理論 of each player\'s last 100 games) and final-outcome totals', async () => {
    const it1 = makeInteraction(COMMANDS.LEADERBOARD);
    await handleLeaderboardCommand(it1 as never);
    const { content } = publicReply(it1);
    const lines = content.split('\n');
    // Period + the note's qualifier; the generator's legend after "；" stays out of the title.
    expect(lines[0]).toBe('🏆 角色理論勝率排行 Top 10（各人最近 100 場，近 90 天內有出賽、生涯至少 100 場）');
    expect(lines[1]).toBe('🥇 HAO　角色理論 52.3%｜位置理論 50.8%｜最終 49.0%｜100 場');
    expect(lines[2]).toBe('🥈 Sin　角色理論 48.4%｜位置理論 47.1%｜最終 46.0%｜100 場');
    expect(lines[3]).toBe('🥉 尼克　角色理論 46.0%｜位置理論 49.5%｜最終 44.0%｜100 場');
    expect(content).not.toContain('Σ');
    expect(content).toContain('📈 總計 2228 場｜221 位玩家｜最終紅勝 69.4%／藍勝 30.6%（任務結算 紅 45.5%／藍 54.5%，三藍局刺中 43.9%）');
    // The 進步榜 is digest-only; excess is never printed.
    expect(content).not.toContain('進步榜');
    expect(content).not.toContain('超額');
  });
});

describe('/默契', () => {
  it('replies publicly with games / win rate together (matrix label SIN shown as Sin)', async () => {
    const it1 = makeInteraction(COMMANDS.CHEMISTRY, { [STATS_OPTIONS.PLAYER_A]: 'sin', [STATS_OPTIONS.PLAYER_B]: 'HAO' });
    await handleChemistryCommand(it1 as never);
    const { content } = publicReply(it1);
    expect(content).toContain('🤝 Sin × HAO 默契');
    expect(content).toContain('同隊 239 場：一起贏 108、一起輸 131');
    expect(content).toContain('同隊勝率 45.2%');
  });

  it('explains when a real player is outside the matrix', async () => {
    const it1 = makeInteraction(COMMANDS.CHEMISTRY, { [STATS_OPTIONS.PLAYER_A]: 'HAO', [STATS_OPTIONS.PLAYER_B]: '溫' });
    await handleChemistryCommand(it1 as never);
    const { content } = publicReply(it1);
    expect(content).toContain('「溫」不在默契矩陣裡');
    expect(content).toContain('/戰績 溫');
  });

  it('rejects the same player twice', async () => {
    const it1 = makeInteraction(COMMANDS.CHEMISTRY, { [STATS_OPTIONS.PLAYER_A]: 'HAO', [STATS_OPTIONS.PLAYER_B]: 'hao' });
    await handleChemistryCommand(it1 as never);
    expect(publicReply(it1).content).toContain('不同');
  });
});

describe('/help', () => {
  const statsField = async (): Promise<string | undefined> => {
    const it1 = makeInteraction(COMMANDS.HELP);
    await handleHelpCommand(it1 as never);
    const json = (it1.editReply.mock.calls[0][0] as { embeds: Array<{ toJSON: () => { fields?: Array<{ name: string; value: string }> } }> }).embeds[0].toJSON();
    return json.fields?.find((f) => f.name.includes('戰績'))?.value;
  };

  it('names the window /排行 ranks by, from the cache (schemaVersion 3 until the first refresh, then 4)', async () => {
    // The fixture's main board is a schemaVersion-3 one: /排行 prints 各人最近 100 場, so does /help.
    expect(await statsField()).toContain('`/排行` 角色理論勝率排行 Top 10（各人最近 100 場）\n');
    const main = fixture.leaderboard.boards[0];
    const period = main.period;
    main.period = '各角色近 10 場、忠臣近 40 場';
    try {
      expect(await statsField()).toContain('`/排行` 角色理論勝率排行 Top 10（各角色近 10 場、忠臣近 40 場）\n');
    } finally {
      main.period = period;
    }
  });

  it('advertises the stats commands', async () => {
    const it1 = makeInteraction(COMMANDS.HELP);
    await handleHelpCommand(it1 as never);
    const json = (it1.editReply.mock.calls[0][0] as { embeds: Array<{ toJSON: () => { fields?: Array<{ name: string; value: string }> } }> }).embeds[0].toJSON();
    const field = json.fields?.find((f) => f.name.includes('戰績'));
    expect(field?.value).toContain('/戰績 名字');
    expect(field?.value).toContain('`/排行` 角色理論勝率排行 Top 10（');
    expect(field?.value).toContain('/默契 名字1 名字2');
    expect(field?.value).toContain('`/意見 文字` 給管理者的建議或回報問題');
    expect(field?.value).not.toContain('超額');
    expect(field?.value).toContain('每週一 12:00');
  });
});
