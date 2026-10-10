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
  const p = (name: string, totalGames: number, winRate: number, roleTheory: number) => ({
    ...base, name, totalGames, winRate, roleTheory, redWin: winRate - 2, blueWin: winRate + 1,
    rawRedGames: Math.round(totalGames * 0.4), rawBlueGames: totalGames - Math.round(totalGames * 0.4),
  });
  const players = [p('Sin', 1080, 51.4, 51.3), p('HAO', 1013, 59, 59.1), p('尼克', 873, 47.3, 47.5), p('SIN', 3, 33.3, 30), p('sin', 1, 0, 0), p('溫', 31, 64.5, 64.6)];
  const labels = ['SIN', 'HAO', '尼克'];
  return {
    players,
    overview: {
      totalGames: 2146, totalPlayers: 198, redWinRate: 46.6, blueWinRate: 53.4, merlinKillRate: 43.5,
      outcomeBreakdown: { threeRed: 0, threeBlueDead: 0, threeBlueAlive: 0, threeRedPct: 0, threeBlueDeadPct: 0, threeBlueAlivePct: 0 },
      topPlayersByTheory: [
        { name: '溫', roleTheory: 64.6, winRate: 64.5, games: 31 },
        { name: 'HAO', roleTheory: 59.1, winRate: 59, games: 1013 },
        { name: 'Sin', roleTheory: 51.3, winRate: 51.4, games: 1080 },
      ],
      topPlayersByGames: [], seatPositionWinRates: [],
    },
    chemistry: {
      coWin: { players: labels, rowLabels: labels, values: [[452, 108, 111], [108, 467, 120], [111, 120, 337]] },
      coLose: { players: labels, rowLabels: labels, values: [[503, 131, 140], [131, 414, 120], [140, 120, 404]] },
      winCorr: { players: labels, values: [] },
      coWinMinusLose: { players: labels, values: [] },
    },
  };
});

vi.mock('../services/sheetsAnalysis', () => ({
  getAllPlayerStats: async () => fixture.players,
  getPlayerByName: async (name: string) => fixture.players.find((pl) => pl.name === name) ?? null,
  getOverview: async () => fixture.overview,
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
    expect(content).toContain('場次 1013｜勝率 59.0%｜角色理論勝率 59.1%');
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
  it('replies publicly with the website ranking and totals', async () => {
    const it1 = makeInteraction(COMMANDS.LEADERBOARD);
    await handleLeaderboardCommand(it1 as never);
    const { content } = publicReply(it1);
    expect(content).toContain('🥇 溫　64.6%');
    expect(content).toContain('🥈 HAO　59.1%');
    expect(content).toContain('總計 2146 場｜198 位玩家｜紅方勝率 46.6%｜藍方勝率 53.4%');
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
    expect(field?.value).toContain('/排行');
    expect(field?.value).toContain('/默契 名字1 名字2');
    expect(field?.value).toContain('每週一 12:00');
  });
});
