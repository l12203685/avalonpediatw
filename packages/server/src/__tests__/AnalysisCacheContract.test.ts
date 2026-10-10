/**
 * Analysis cache contract (2026-10-10).
 *
 * Serves the real, committed packages/server/analysis_cache.json through the
 * same routers the web calls (/api/analysis/* and /api/leaderboard/v3) and
 * checks every field the web UI dereferences — `.map`, `.toFixed`, nested
 * access, `Object.entries` — against what actually comes back. A cache
 * rebuild that drops or reshapes one of those fields fails here, instead of
 * white-screening a panel in production (8376a44: missions lost
 * `missionOutcomeCorrelation`; rounds lost every `outcomes`).
 *
 * Optional fields mirror the web types in packages/web/src/services/api.ts:
 * when the UI has a fallback for a missing field the contract only checks
 * the field's shape if it is present.
 */
import fs from 'fs';
import http from 'http';
import path from 'path';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// 60 req/min per IP would trip on the per-player sweeps below.
vi.mock('../middleware/rateLimit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware/rateLimit')>();
  return {
    ...actual,
    createHttpRateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  };
});

import { analysisRouter } from '../routes/analysis';
import { apiRouter } from '../routes/api';

const CACHE_PATH = path.resolve(__dirname, '..', '..', 'analysis_cache.json');
const committedCache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8')) as {
  players: { players: Array<{ name: string; totalGames: number }> };
  playerDetails: Record<string, unknown>;
};
const playerNames = committedCache.players.players.map((p) => p.name);

// ---------------------------------------------------------------------------
// Tiny shape checker — collects every problem so a failing rebuild reports
// all missing fields at once, each with its JSON path.
// ---------------------------------------------------------------------------

type Problems = string[];
type Json = Record<string, unknown>;

const show = (v: unknown): string => (v === undefined ? 'undefined' : JSON.stringify(v)?.slice(0, 80) ?? String(v));

function num(p: Problems, v: unknown, at: string): void {
  if (typeof v !== 'number' || !Number.isFinite(v)) p.push(`${at}: expected number, got ${show(v)}`);
}
function numOrNull(p: Problems, v: unknown, at: string): void {
  if (v !== null) num(p, v, at);
}
function str(p: Problems, v: unknown, at: string): void {
  if (typeof v !== 'string') p.push(`${at}: expected string, got ${show(v)}`);
}
function bool(p: Problems, v: unknown, at: string): void {
  if (typeof v !== 'boolean') p.push(`${at}: expected boolean, got ${show(v)}`);
}
function obj(p: Problems, v: unknown, at: string): Json {
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    p.push(`${at}: expected object, got ${show(v)}`);
    return {};
  }
  return v as Json;
}
function arr(p: Problems, v: unknown, at: string, { nonEmpty = false } = {}): Json[] {
  if (!Array.isArray(v)) {
    p.push(`${at}: expected array, got ${show(v)}`);
    return [];
  }
  if (nonEmpty && v.length === 0) p.push(`${at}: expected a non-empty array`);
  return v as Json[];
}
function numRecord(p: Problems, v: unknown, at: string): void {
  for (const [k, x] of Object.entries(obj(p, v, at))) num(p, x, `${at}.${k}`);
}
function strArray(p: Problems, v: unknown, at: string): void {
  arr(p, v, at).forEach((x, i) => str(p, x, `${at}[${i}]`));
}

const OUTCOME_KEYS = ['threeRed', 'threeBlueDead', 'threeBlueAlive', 'threeRedPct', 'threeBlueDeadPct', 'threeBlueAlivePct'];

/** OutcomeBar reads every one of these; a missing object throws. */
function outcomes(p: Problems, v: unknown, at: string): void {
  const o = obj(p, v, at);
  for (const k of OUTCOME_KEYS) num(p, o[k], `${at}.${k}`);
}
function optionalOutcomes(p: Problems, v: unknown, at: string): void {
  if (v !== undefined) outcomes(p, v, at);
}

// ---------------------------------------------------------------------------
// App wiring — mounted in the same order as src/index.ts.
// ---------------------------------------------------------------------------

let server: http.Server;

beforeAll(() => {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  app.use('/api/analysis', analysisRouter);
  server = app.listen(0);
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

/** GET an /api/analysis endpoint and unwrap the `{ success, data }` envelope like analysisApiFetch does. */
async function analysis(pathname: string): Promise<Json> {
  const res = await request(server).get(`/api/analysis${pathname}`);
  expect(res.status, `GET /api/analysis${pathname} → ${res.status} ${JSON.stringify(res.body)}`).toBe(200);
  expect(res.body.success).toBe(true);
  expect(res.body.data).toBeTruthy();
  return res.body.data as Json;
}

const enc = encodeURIComponent;

// ---------------------------------------------------------------------------

describe('analysis_cache.json → web contract', () => {
  it('the committed cache is what the routes serve', async () => {
    const data = await analysis('/players');
    expect(data.total).toBe(playerNames.length);
    expect((data.players as Json[]).map((x) => x.name)).toEqual(playerNames);
    // Every listed player resolves by name (PlayerRadarChart clicks a name from the list).
    expect(Object.keys(committedCache.playerDetails).sort()).toEqual([...playerNames].sort());
  });

  it('GET /overview — OverviewPanel', async () => {
    const p: Problems = [];
    const d = await analysis('/overview');
    num(p, d.totalGames, 'totalGames');
    num(p, d.totalPlayers, 'totalPlayers');
    num(p, d.merlinKillRate, 'merlinKillRate');
    outcomes(p, d.outcomeBreakdown, 'outcomeBreakdown');
    arr(p, d.topPlayersByTheory, 'topPlayersByTheory', { nonEmpty: true }).forEach((x, i) => {
      str(p, x.name, `topPlayersByTheory[${i}].name`);
      num(p, x.roleTheory, `topPlayersByTheory[${i}].roleTheory`);
    });
    arr(p, d.topPlayersByGames, 'topPlayersByGames', { nonEmpty: true }).forEach((x, i) => {
      str(p, x.name, `topPlayersByGames[${i}].name`);
      num(p, x.games, `topPlayersByGames[${i}].games`);
    });
    arr(p, d.seatPositionWinRates, 'seatPositionWinRates').forEach((s, i) => {
      const at = `seatPositionWinRates[${i}]`;
      str(p, s.seat, `${at}.seat`);
      num(p, s.overallWinRate, `${at}.overallWinRate`);
      num(p, s.totalGames, `${at}.totalGames`);
      optionalOutcomes(p, s.outcomes, `${at}.outcomes`);
      arr(p, s.roles, `${at}.roles`).forEach((r, j) => {
        str(p, r.role, `${at}.roles[${j}].role`);
        num(p, r.winRate, `${at}.roles[${j}].winRate`);
        num(p, r.games, `${at}.roles[${j}].games`);
        optionalOutcomes(p, r.outcomes, `${at}.roles[${j}].outcomes`);
      });
    });
    expect(p).toEqual([]);
  });

  it('GET /players — SeatHeatmap, PlayerRadarChart list, LeaderboardV3 input', async () => {
    const p: Problems = [];
    const d = await analysis('/players');
    arr(p, d.players, 'players', { nonEmpty: true }).forEach((pl) => {
      const at = `players[${show(pl.name)}]`;
      str(p, pl.name, `${at}.name`);
      for (const k of ['totalGames', 'winRate', 'roleTheory', 'rawRedGames', 'rawBlueGames']) num(p, pl[k], `${at}.${k}`);
      for (const k of ['seatWinRates', 'seatRedWinRates', 'seatBlueWinRates', 'roleWinRates', 'rawRoleGames']) {
        numRecord(p, pl[k], `${at}.${k}`);
      }
      if (pl.seatOutcomes !== undefined) {
        for (const [seat, o] of Object.entries(obj(p, pl.seatOutcomes, `${at}.seatOutcomes`))) {
          outcomes(p, o, `${at}.seatOutcomes.${seat}`);
        }
      }
    });
    expect(p).toEqual([]);
  });

  it('GET /players/:name — PlayerRadarChart detail, for every player (incl. 1-game, CJK and case-variant names)', async () => {
    const p: Problems = [];
    for (const name of playerNames) {
      const res = await request(server).get(`/api/analysis/players/${enc(name)}`);
      if (res.status !== 200) {
        p.push(`players/${name}: HTTP ${res.status}`);
        continue;
      }
      const d = res.body.data as Json;
      const pl = obj(p, d.player, `${name}.player`);
      if (pl.name !== name) p.push(`${name}.player.name: got ${show(pl.name)}`);
      for (const k of ['totalGames', 'winRate', 'roleTheory', 'positionTheory', 'redWin', 'blueWin', 'red3Red', 'redMerlinDead', 'blueMerlinAlive']) {
        num(p, pl[k], `${name}.player.${k}`);
      }
      numRecord(p, pl.roleWinRates, `${name}.player.roleWinRates`);
      const radar = obj(p, d.radar, `${name}.radar`);
      for (const k of ['winRate', 'redWinRate', 'blueMerlinProtect', 'roleTheory', 'positionTheory', 'redMerlinKillRate', 'experience']) {
        num(p, radar[k], `${name}.radar.${k}`);
      }
    }
    expect(p).toEqual([]);
  });

  it('GET /chemistry — ChemistryMatrix', async () => {
    const p: Problems = [];
    const d = await analysis('/chemistry');
    const checkMatrix = (key: string, required: boolean): void => {
      if (!required && d[key] === undefined) return;
      const m = obj(p, d[key], key);
      const players = arr(p, m.players, `${key}.players`, { nonEmpty: true });
      strArray(p, m.players, `${key}.players`);
      const rowLabels = m.rowLabels === undefined ? players : arr(p, m.rowLabels, `${key}.rowLabels`);
      if (m.rowLabels !== undefined) strArray(p, m.rowLabels, `${key}.rowLabels`);
      const grids = ['values', 'threeBlueDeadPct', 'threeBlueAlivePct'] as const;
      for (const g of grids) {
        if (g !== 'values' && m[g] === undefined) continue;
        const rows = arr(p, m[g], `${key}.${g}`);
        if (rows.length !== rowLabels.length) p.push(`${key}.${g}: ${rows.length} rows for ${rowLabels.length} row labels`);
        rows.forEach((row, ri) => {
          const cells = arr(p, row, `${key}.${g}[${ri}]`) as unknown[];
          if (cells.length !== players.length) p.push(`${key}.${g}[${ri}]: ${cells.length} cells for ${players.length} players`);
          cells.forEach((c, ci) => numOrNull(p, c, `${key}.${g}[${ri}][${ci}]`));
        });
      }
    };
    for (const k of ['coWin', 'coLose', 'winCorr', 'coWinMinusLose']) checkMatrix(k, true);
    checkMatrix('outcomePair', false);
    expect(p).toEqual([]);
  });

  it('GET /missions — MissionAnalysis', async () => {
    const p: Problems = [];
    const d = await analysis('/missions');
    arr(p, d.missionPassRates, 'missionPassRates', { nonEmpty: true }).forEach((m, i) => {
      for (const k of ['round', 'passRate', 'totalGames']) num(p, m[k], `missionPassRates[${i}].${k}`);
    });
    arr(p, d.missionOutcomeByRound, 'missionOutcomeByRound', { nonEmpty: true }).forEach((m, i) => {
      for (const k of ['round', 'allPass', 'oneFail', 'twoFail', 'total']) num(p, m[k], `missionOutcomeByRound[${i}].${k}`);
      if (!((m.total as number) > 0)) p.push(`missionOutcomeByRound[${i}].total: must be > 0 (UI divides by it)`);
    });
    if (d.missionOutcomeCorrelation !== undefined) {
      arr(p, d.missionOutcomeCorrelation, 'missionOutcomeCorrelation').forEach((c, i) => {
        const at = `missionOutcomeCorrelation[${i}]`;
        for (const k of ['round', 'passedGames', 'failedGames']) num(p, c[k], `${at}.${k}`);
        outcomes(p, c.passedOutcomes, `${at}.passedOutcomes`);
        outcomes(p, c.failedOutcomes, `${at}.failedOutcomes`);
      });
    }
    expect(p).toEqual([]);
  });

  it('GET /rounds — RoundsAnalysis (outcomes optional, redWinRate is the fallback)', async () => {
    const p: Problems = [];
    const d = await analysis('/rounds');
    const vision = obj(p, d.visionStats, 'visionStats');
    for (const k of ['merlinInTeam', 'merlinNotInTeam', 'percivalInTeam', 'percivalNotInTeam']) {
      const v = obj(p, vision[k], `visionStats.${k}`);
      for (const f of ['games', 'mission1PassRate', 'redWinRate']) num(p, v[f], `visionStats.${k}.${f}`);
      optionalOutcomes(p, v.outcomes, `visionStats.${k}.outcomes`);
    }
    for (const [round, v] of Object.entries(obj(p, d.roundProgression, 'roundProgression'))) {
      const r = obj(p, v, `roundProgression.${round}`);
      for (const f of ['bluePct', 'redPct', 'total']) num(p, r[f], `roundProgression.${round}.${f}`);
    }
    arr(p, d.redInR11, 'redInR11').forEach((r, i) => {
      for (const f of ['redCount', 'games', 'redWinRate']) num(p, r[f], `redInR11[${i}].${f}`);
      optionalOutcomes(p, r.outcomes, `redInR11[${i}].outcomes`);
    });
    arr(p, d.mission1Branch, 'mission1Branch').forEach((b, i) => {
      bool(p, b.passed, `mission1Branch[${i}].passed`);
      for (const f of ['games', 'redWinRate']) num(p, b[f], `mission1Branch[${i}].${f}`);
      optionalOutcomes(p, b.outcomes, `mission1Branch[${i}].outcomes`);
    });
    arr(p, d.gameStates, 'gameStates').forEach((s, i) => {
      str(p, s.state, `gameStates[${i}].state`);
      for (const f of ['games', 'redWinRate']) num(p, s[f], `gameStates[${i}].${f}`);
      optionalOutcomes(p, s.outcomes, `gameStates[${i}].outcomes`);
    });
    expect(p).toEqual([]);
  });

  it('GET /lake — LakeAnalysis', async () => {
    const p: Problems = [];
    const d = await analysis('/lake');
    const roleRows = (v: unknown, at: string): void => {
      arr(p, v, at).forEach((r, i) => {
        str(p, r.role, `${at}[${i}].role`);
        num(p, r.games, `${at}[${i}].games`);
        outcomes(p, r.outcomes, `${at}[${i}].outcomes`);
      });
    };
    arr(p, d.perLake, 'perLake', { nonEmpty: true }).forEach((l, i) => {
      const at = `perLake[${i}]`;
      str(p, l.lake, `${at}.lake`);
      num(p, l.totalGames, `${at}.totalGames`);
      arr(p, l.holderStats, `${at}.holderStats`).forEach((h, j) => {
        str(p, h.faction, `${at}.holderStats[${j}].faction`);
        num(p, h.games, `${at}.holderStats[${j}].games`);
        outcomes(p, h.outcomes, `${at}.holderStats[${j}].outcomes`);
      });
      arr(p, l.comboStats, `${at}.comboStats`).forEach((c, j) => {
        str(p, c.holderFaction, `${at}.comboStats[${j}].holderFaction`);
        str(p, c.targetFaction, `${at}.comboStats[${j}].targetFaction`);
        num(p, c.games, `${at}.comboStats[${j}].games`);
        outcomes(p, c.outcomes, `${at}.comboStats[${j}].outcomes`);
      });
    });
    // `data.allLakeRoleStats[selectedLake]` is dereferenced unguarded.
    arr(p, d.allLakeRoleStats, 'allLakeRoleStats').forEach((l, i) => {
      const at = `allLakeRoleStats[${i}]`;
      roleRows(l.holderRoleStats, `${at}.holderRoleStats`);
      roleRows(l.targetRoleStats, `${at}.targetRoleStats`);
      for (const side of ['sameFaction', 'diffFaction']) {
        const s = obj(p, l[side], `${at}.${side}`);
        num(p, s.games, `${at}.${side}.games`);
        outcomes(p, s.outcomes, `${at}.${side}.outcomes`);
      }
    });
    expect(p).toEqual([]);
  });

  it('GET /seat-order — SeatOrderAnalysis gets the pct fields, whatever the cache stores', async () => {
    const p: Problems = [];
    const d = await analysis('/seat-order');
    num(p, d.totalGames, 'totalGames');
    num(p, d.overallRedWinRate, 'overallRedWinRate');
    arr(p, d.permutations, 'permutations').forEach((perm, i) => {
      const at = `permutations[${i}]`;
      str(p, perm.order, `${at}.order`);
      for (const k of ['total', '三紅pct', '三藍梅死pct', '三藍梅活pct', '穿插任務', '穿插率', 'redWinRate']) num(p, perm[k], `${at}.${k}`);
      for (const k of ['穿插紅勝率', '無穿插紅勝率']) if (perm[k] !== undefined) num(p, perm[k], `${at}.${k}`);
      const sum = (perm['三紅pct'] as number) + (perm['三藍梅死pct'] as number) + (perm['三藍梅活pct'] as number);
      if ((perm.total as number) > 0 && Math.abs(sum - 100) > 0.5) p.push(`${at}: outcome pcts sum to ${sum}`);
    });
    expect(p).toEqual([]);
  });

  it('GET /captain — CaptainAnalysis', async () => {
    const p: Problems = [];
    const d = await analysis('/captain');
    arr(p, d.perMission, 'perMission').forEach((m, i) => {
      for (const k of ['mission', 'redCaptainRate', 'blueCaptainRate', 'games']) num(p, m[k], `perMission[${i}].${k}`);
    });
    arr(p, d.captainFactionVsOutcome, 'captainFactionVsOutcome').forEach((r, i) => {
      str(p, r.captainFaction, `captainFactionVsOutcome[${i}].captainFaction`);
      str(p, r.missionResult, `captainFactionVsOutcome[${i}].missionResult`);
      for (const k of ['count', 'percentage']) num(p, r[k], `captainFactionVsOutcome[${i}].${k}`);
    });
    arr(p, d.captainMissionGameWinRates, 'captainMissionGameWinRates').forEach((r, i) => {
      const at = `captainMissionGameWinRates[${i}]`;
      str(p, r.captainFaction, `${at}.captainFaction`);
      str(p, r.missionResult, `${at}.missionResult`);
      num(p, r.totalMissions, `${at}.totalMissions`);
      outcomes(p, r.outcomes, `${at}.outcomes`);
    });
    expect(p).toEqual([]);
  });

  it('GET /feature-studies — FeatureStudiesPanel', async () => {
    const p: Problems = [];
    const d = await analysis('/feature-studies');
    str(p, d.generatedAt, 'generatedAt');
    num(p, obj(p, d.sampleSize, 'sampleSize').games, 'sampleSize.games');
    arr(p, d.features, 'features', { nonEmpty: true }).forEach((f, i) => {
      const at = `features[${i}]`;
      for (const k of ['loopId', 'title', 'titleEn', 'oneLineHook', 'oneLineHookEn', 'takeaway', 'takeawayEn']) str(p, f[k], `${at}.${k}`);
      num(p, obj(p, f.sampleSize, `${at}.sampleSize`).games, `${at}.sampleSize.games`);
      const data = obj(p, f.data, `${at}.data`);
      const rows = (key: string, fields: { n?: string[]; s?: string[] }): void => {
        arr(p, data[key], `${at}.data.${key}`).forEach((r, j) => {
          for (const k of fields.n ?? []) num(p, r[k], `${at}.data.${key}[${j}].${k}`);
          for (const k of fields.s ?? []) str(p, r[k], `${at}.data.${key}[${j}].${k}`);
        });
      };
      switch (f.visualType) {
        case 'bar':
          if (Array.isArray(data.leaderTierRows)) {
            rows('leaderTierRows', { n: ['hitRate', 'n'], s: ['tierEn', 'tierZh'] });
            if (data.topSeatRows !== undefined) rows('topSeatRows', { n: ['seat', 'n', 'hitRate'] });
          } else {
            rows('rows', { n: ['lieRate', 'total'], s: ['role', 'roleEn', 'camp'] });
          }
          break;
        case 'table':
          rows('rows', { n: ['consistencyRate', 'total', 'consistent', 'inconsistent'], s: ['role', 'roleEn', 'camp'] });
          if (data.highEvCells !== undefined) rows('highEvCells', { n: ['n', 'deltaThreeRed'], s: ['label'] });
          break;
        case 'divergent':
          rows('rows', { n: ['signedEv', 'totalChances'], s: ['role', 'roleEn', 'camp'] });
          break;
        case 'line':
          rows('rows', { n: ['n', 'deltaThreeRed', 'deltaThreeBlueAlive', 'deltaThreeBlueDead'], s: ['round'] });
          break;
        default:
          p.push(`${at}.visualType: unknown ${show(f.visualType)}`);
      }
    });
    expect(p).toEqual([]);
  });

  it('GET /profile/:name/{archetype,strength,playstyle} — profile panels, for every player', async () => {
    const p: Problems = [];
    const AXES = ['honesty', 'consistency', 'stickiness', 'flip'];
    const COLORS = ['high', 'neutral', 'low', 'insufficient'];
    for (const name of playerNames) {
      const get = async (panel: string): Promise<Json | null> => {
        const res = await request(server).get(`/api/analysis/profile/${enc(name)}/${panel}`);
        if (res.status !== 200) {
          p.push(`profile/${name}/${panel}: HTTP ${res.status}`);
          return null;
        }
        const d = res.body.data as Json;
        const pl = obj(p, d.player, `${name}/${panel}.player`);
        if (pl.name !== name) p.push(`${name}/${panel}.player.name: got ${show(pl.name)}`);
        num(p, pl.totalGames, `${name}/${panel}.player.totalGames`);
        return d;
      };

      const a = await get('archetype');
      if (a) {
        const at = `${name}/archetype`;
        const data = obj(p, a.data, `${at}.data`);
        bool(p, data.hasData, `${at}.data.hasData`);
        num(p, data.sampleSize, `${at}.data.sampleSize`);
        if (data.hasData) {
          for (const k of AXES) {
            num(p, obj(p, data.axes, `${at}.data.axes`)[k], `${at}.data.axes.${k}`);
            num(p, obj(p, data.percentiles, `${at}.data.percentiles`)[k], `${at}.data.percentiles.${k}`);
            str(p, obj(p, a.axisHelp, `${at}.axisHelp`)[k], `${at}.axisHelp.${k}`);
          }
          num(p, obj(p, a.cohort, `${at}.cohort`).n, `${at}.cohort.n`);
        }
      }

      const s = await get('strength');
      if (s) {
        const at = `${name}/strength`;
        const data = obj(p, s.data, `${at}.data`);
        bool(p, data.hasData, `${at}.data.hasData`);
        strArray(p, data.topRoles, `${at}.data.topRoles`);
        strArray(p, data.bottomRoles, `${at}.data.bottomRoles`);
        arr(p, data.roles, `${at}.data.roles`).forEach((r, i) => {
          str(p, r.role, `${at}.data.roles[${i}].role`);
          num(p, r.sampleSize, `${at}.data.roles[${i}].sampleSize`);
          numOrNull(p, r.winRate, `${at}.data.roles[${i}].winRate`);
          numOrNull(p, r.zScore, `${at}.data.roles[${i}].zScore`);
          if (!COLORS.includes(r.color as string)) p.push(`${at}.data.roles[${i}].color: ${show(r.color)}`);
        });
        num(p, obj(p, s.cohort, `${at}.cohort`).minRoleSample, `${at}.cohort.minRoleSample`);
      }

      const ps = await get('playstyle');
      if (ps) {
        const at = `${name}/playstyle`;
        const data = obj(p, ps.data, `${at}.data`);
        bool(p, data.hasData, `${at}.data.hasData`);
        // `x !== null ? x.toFixed()` / formatPctile(x): undefined would throw, so null-or-number strictly.
        for (const split of ['r3RejectRate', 'r3RejectPercentile']) {
          const o = obj(p, data[split], `${at}.data.${split}`);
          numOrNull(p, o.red, `${at}.data.${split}.red`);
          numOrNull(p, o.blue, `${at}.data.${split}.blue`);
        }
        numOrNull(p, data.captainStickiness, `${at}.data.captainStickiness`);
        numOrNull(p, data.captainStickinessPercentile, `${at}.data.captainStickinessPercentile`);
        num(p, data.assassinAttempts, `${at}.data.assassinAttempts`);
        if (data.assassinTopSeats !== null) {
          arr(p, data.assassinTopSeats, `${at}.data.assassinTopSeats`).forEach((x, i) => num(p, x, `${at}.data.assassinTopSeats[${i}]`));
        }
        const th = obj(p, ps.thresholds, `${at}.thresholds`);
        for (const k of ['r3MinVotes', 'assassinMinAttempts']) num(p, th[k], `${at}.thresholds.${k}`);
        const labels = obj(p, ps.labels, `${at}.labels`);
        for (const k of ['r3RejectRedLabel', 'r3RejectBlueLabel', 'assassinTargetLabel', 'captainStickinessLabel']) {
          str(p, labels[k], `${at}.labels.${k}`);
        }
        const cohort = obj(p, ps.cohort, `${at}.cohort`);
        for (const k of ['r3Red', 'r3Blue', 'captainStickiness', 'assassinAttempts']) {
          num(p, obj(p, cohort[k], `${at}.cohort.${k}`).n, `${at}.cohort.${k}.n`);
        }
      }
    }
    expect(p).toEqual([]);
  });

  it('a 1-game player gets the "資料不足" path, not an error', async () => {
    const oneGame = committedCache.players.players.find((x) => x.totalGames === 1);
    expect(oneGame).toBeDefined();
    const name = oneGame!.name;
    const a = await analysis(`/profile/${enc(name)}/archetype`);
    expect((a.data as Json).hasData).toBe(false);
    expect((a.player as Json).totalGames).toBe(1);
    const radar = await analysis(`/players/${enc(name)}`);
    expect((radar.player as Json).totalGames).toBe(1);
  });

  it.each([
    ['a name with a space', 'nobody here'],
    ['a CJK name', '不存在的玩家'],
    ['an emoji name', '🦄 unicorn'],
    ['a name containing %', '100%'],
    ['constructor', 'constructor'],
    ['__proto__', '__proto__'],
    ['toString', 'toString'],
  ])('unknown player (%s) → 404 on every per-player route, never 500', async (_label, name) => {
    for (const route of [`/players/${enc(name)}`, ...['archetype', 'strength', 'playstyle'].map((x) => `/profile/${enc(name)}/${x}`)]) {
      const res = await request(server).get(`/api/analysis${route}`);
      expect(res.status, `GET /api/analysis${route}`).toBe(404);
      expect(res.body.success).toBe(false);
    }
  });

  it('GET /api/leaderboard/v3 — LeaderboardV3Table', async () => {
    const res = await request(server).get('/api/leaderboard/v3');
    expect(res.status).toBe(200);
    const p: Problems = [];
    const d = res.body as Json;
    const METRICS = ['threeRedOnRed', 'threeBlueDeadOnRed', 'threeBlueAliveOnBlue', 'redWinOnRed', 'blueWinOnBlue', 'threeBlueOnBlue', 'missionWin', 'expectedWin'];
    arr(p, d.entries, 'entries', { nonEmpty: true }).forEach((e) => {
      const at = `entries[${show(e.playerId)}]`;
      str(p, e.playerId, `${at}.playerId`);
      str(p, e.displayName, `${at}.displayName`);
      for (const k of ['totalGames', 'redGames', 'blueGames', 'cellsCovered']) num(p, e[k], `${at}.${k}`);
      numOrNull(p, e.precisionWinRate, `${at}.precisionWinRate`);
      for (const side of ['raw', 'shrunk']) {
        const m = obj(p, e[side], `${at}.${side}`);
        for (const k of METRICS) num(p, m[k], `${at}.${side}.${k}`);
      }
    });
    const gm = obj(p, d.globalMeans, 'globalMeans');
    for (const k of ['threeRedOnRed', 'threeBlueDeadOnRed', 'threeBlueAliveOnBlue', 'cellMean']) num(p, gm[k], `globalMeans.${k}`);
    const meta = obj(p, d.meta, 'meta');
    for (const k of ['eligiblePlayers', 'totalPlayers']) num(p, meta[k], `meta.${k}`);
    expect(meta.totalPlayers).toBe(playerNames.length);
    expect(p).toEqual([]);
  });
});
