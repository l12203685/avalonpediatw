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
  const players = [
    p('Sin', 1080, 51.4, 51.3, 31.2, -1.4), p('HAO', 1013, 59, 59.1, 38.5, 6.3), p('尼克', 873, 47.3, 47.5, 30.1, -2),
    p('SIN', 3, 33.3, 30, 33.3, null), p('sin', 1, 0, 0, 0, null), p('溫', 31, 64.5, 64.6, 45.2, 12.1),
  ];
  const labels = ['SIN', 'HAO', '尼克'];
  // As generate_cache.py writes the excess boards: `value` is the shrunk sort key, `excessWinRate` the number shown,
  // and every excess board's note carries the same legend after a "；".
  const LEGEND = '超額勝率 = 期間最終勝率 − 依角色分配算出的預期勝率；排序用縮減值（× 場數 /（場數 + 20）），樣本少的人不會因為幾場好運就衝到前面';
  const row = (rank: number, name: string, excessWinRate: number, finalWinRate: number, games: number) => ({
    rank, name, value: Math.round(((excessWinRate * games) / (games + 20)) * 10) / 10, excessWinRate, finalWinRate, expectedFinalWinRate: finalWinRate - excessWinRate, games,
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
      topPlayersByGames: [], seatPositionWinRates: [],
    },
    // The cache's precomputed boards (generate_cache.py LEADERBOARD_CONFIG) — what /排行 leads with.
    leaderboard: {
      asOf: '2026-10-12',
      boards: [
        {
          id: 'main', title: '超額勝率排行', period: '2025-10-13 ～ 2026-10-12', windowDays: 365, minGames: 20,
          note: `近 90 天內有出賽、近 365 天至少 20 場；${LEGEND}`,
          rows: [row(1, 'HAO', 6.3, 38.5, 48), row(2, '溫', 4.1, 42, 21), row(3, 'Sin', -0.8, 31.5, 52)],
        },
        { id: 'recent', title: '近 90 天超額勝率', period: '2026-07-15 ～ 2026-10-12', windowDays: 90, minGames: 10, note: `期間至少 10 場；${LEGEND}`, rows: [row(1, '溫', 5.5, 44, 12)] },
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
    expect(content).toContain('📊 HAO 的戰績');
    expect(content).toContain('場次 1013｜最終勝率 38.5%｜超額 +6.3');
    expect(content).toContain('任務結算 59.0% → 刺殺結算（三藍局：藍方存活 55.0%）→ 最終 38.5%');
    expect(content).toContain('🔴 紅方最終勝率 68.5%（405 場）｜🔵 藍方最終勝率 30.5%（608 場）');
    expect(content).not.toContain('角色理論勝率');
    expect(content).toContain(STATS_SITE_URL);
  });

  it('resolves a unique substring', async () => {
    const it1 = makeInteraction(COMMANDS.STATS, { [STATS_OPTIONS.NAME]: '尼' });
    await handleStatsCommand(it1 as never);
    expect(publicReply(it1).content).toContain('📊 尼克 的戰績');
  });

  it('lists candidates when the name is ambiguous', async () => {
    const it1 = makeInteraction(COMMANDS.STATS, { [STATS_OPTIONS.NAME]: 'sIN' });
    await handleStatsCommand(it1 as never);
    const { content } = publicReply(it1);
    expect(content).toContain('符合 3 位玩家');
    expect(content).toContain('Sin、SIN、sin');
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
  it('replies publicly with the cache main board (excess win rate, period in the title) and final-outcome totals', async () => {
    const it1 = makeInteraction(COMMANDS.LEADERBOARD);
    await handleLeaderboardCommand(it1 as never);
    const { content } = publicReply(it1);
    const lines = content.split('\n');
    // Period + the note's qualifier; the generator's legend after "；" stays out of the title.
    expect(lines[0]).toBe('🏆 超額勝率排行 Top 10（2025-10-13 ～ 2026-10-12，近 90 天內有出賽、近 365 天至少 20 場）');
    // The unshrunk excessWinRate (what /戰績 and the site show), not the shrunk sort value (6.3 × 48 / 68 = 4.4).
    expect(lines[1]).toBe('🥇 HAO　超額 +6.3｜最終 38.5%｜48 場');
    expect(lines[2]).toBe('🥈 溫　超額 +4.1｜最終 42.0%｜21 場');
    expect(lines[3]).toBe('🥉 Sin　超額 -0.8｜最終 31.5%｜52 場');
    expect(content).not.toContain('+4.4');
    expect(content).not.toContain('排序用縮減值');
    expect(content).toContain('📈 總計 2228 場｜221 位玩家｜最終紅勝 69.4%／藍勝 30.6%（任務結算 紅 45.5%／藍 54.5%，三藍局刺中 43.9%）');
    // The "近 90 天" board is digest-only.
    expect(content).not.toContain('🔥');
    expect(content).not.toContain('Top 5');
    expect(content).not.toContain('理論勝率');
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
  it('advertises the stats commands', async () => {
    const it1 = makeInteraction(COMMANDS.HELP);
    await handleHelpCommand(it1 as never);
    const json = (it1.editReply.mock.calls[0][0] as { embeds: Array<{ toJSON: () => { fields?: Array<{ name: string; value: string }> } }> }).embeds[0].toJSON();
    const field = json.fields?.find((f) => f.name.includes('戰績'));
    expect(field?.value).toContain('/戰績 名字');
    expect(field?.value).toContain('`/排行` 超額勝率排行 Top 10');
    expect(field?.value).toContain('/默契 名字1 名字2');
    expect(field?.value).toContain('`/意見 文字` 給管理者的建議或回報問題');
    expect(field?.value).not.toContain('理論勝率');
    expect(field?.value).toContain('每週一 12:00');
  });
});
