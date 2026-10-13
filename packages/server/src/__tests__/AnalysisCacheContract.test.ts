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
 *
 * Two-stage outcome contract (docs/stats/two_stage_outcome.md, 2026-10-12):
 * once `overview.schemaVersion >= 2` the new overview / player fields and the
 * `leaderboard` section are REQUIRED; on an older cache they are checked only
 * when present, and the server's fallback (withFinalFields) must still turn
 * the raw three-outcome counts into the final-outcome rates.
 *
 * Theory win rates (schemaVersion 3, Edward 2026-10-13): players[].theory,
 * overview.seatFinalWinRates / topPlayersByRoleTheory and boards with `metric`
 * are REQUIRED from version 3 on, checked only when present before that.
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
import { rnd1, withFinalFields } from '../services/sheetsAnalysis';
import type { PlayerStats } from '../services/sheetsAnalysis';

const CACHE_PATH = path.resolve(__dirname, '..', '..', 'analysis_cache.json');
const committedCache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8')) as {
  overview: { schemaVersion?: unknown };
  players: { players: Array<{ name: string; totalGames: number }> };
  playerDetails: Record<string, unknown>;
  leaderboard?: unknown;
};
const playerNames = committedCache.players.players.map((p) => p.name);
/** Cache written under the two-stage contract → its new fields are mandatory. */
const V2 = typeof committedCache.overview.schemaVersion === 'number' && committedCache.overview.schemaVersion >= 2;
/** Cache written with the theory win rates (players[].theory, theory boards) → mandatory too. */
const V3 = typeof committedCache.overview.schemaVersion === 'number' && committedCache.overview.schemaVersion >= 3;

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
/** Required on a schemaVersion-2 cache; on an older cache checked only when present. */
function v2Field(v: unknown, check: () => void): void {
  if (V2 || v !== undefined) check();
}
/** Required on a schemaVersion-3 cache; on an older cache checked only when present. */
function v3Field(v: unknown, check: () => void): void {
  if (V3 || v !== undefined) check();
}

const THEORY_WINDOW_NUMS = ['window', 'games', 'roleTheory', 'positionTheory', 'finalWinRate', 'sparseRoles', 'sparseSeats'];

/** players[].theory: last100 / last50 / career windows (PlayerRadarChart, /戰績). */
function theoryBlock(p: Problems, v: unknown, totalGames: unknown, at: string): void {
  const t = obj(p, v, at);
  for (const key of ['last100', 'last50', 'career']) {
    const w = obj(p, t[key], `${at}.${key}`);
    for (const k of THEORY_WINDOW_NUMS) num(p, w[k], `${at}.${key}.${k}`);
    for (const k of ['from', 'to']) str(p, w[k], `${at}.${key}.${k}`);
    for (const k of ['roleTheory', 'positionTheory', 'finalWinRate']) {
      if (typeof w[k] === 'number' && ((w[k] as number) < 0 || (w[k] as number) > 100)) p.push(`${at}.${key}.${k}: ${show(w[k])} out of 0..100`);
    }
  }
  const career = (t.career ?? {}) as Json;
  if (typeof career.games === 'number' && career.games !== totalGames) {
    p.push(`${at}.career.games ${show(career.games)} ≠ totalGames ${show(totalGames)}`);
  }
}

const PLAYER_FINAL_RATES = ['finalWinRate', 'finalRedWinRate', 'finalBlueWinRate', 'missionWinRate', 'merlinSurvivalRate'];

/** Two-stage player fields (contract 玩家層), as served by /players and /players/:name. */
function twoStagePlayer(p: Problems, pl: Json, at: string): void {
  for (const k of PLAYER_FINAL_RATES) v2Field(pl[k], () => num(p, pl[k], `${at}.${k}`));
  for (const k of ['expectedFinalWinRate', 'excessWinRate']) v2Field(pl[k], () => numOrNull(p, pl[k], `${at}.${k}`));
  v2Field(pl.rawBlueThreeBlue, () => num(p, pl.rawBlueThreeBlue, `${at}.rawBlueThreeBlue`));
  v2Field(pl.roleFinalWinRates, () => numRecord(p, pl.roleFinalWinRates, `${at}.roleFinalWinRates`));
  for (const k of ['firstPlayed', 'lastPlayed']) v2Field(pl[k], () => str(p, pl[k], `${at}.${k}`));
  // The committed cache carries the raw three-outcome counts, so the served
  // player must have the final rates whatever the schemaVersion (withFinalFields).
  if (typeof pl.rawRedThreeRed === 'number') {
    for (const k of PLAYER_FINAL_RATES) num(p, pl[k], `${at}.${k} (derived from raw counts)`);
    if (pl.excessWinRate === undefined) p.push(`${at}.excessWinRate: expected number or null, got undefined`);
    const [f, r, b] = [pl.finalWinRate, pl.finalRedWinRate, pl.finalBlueWinRate] as number[];
    for (const [k, v] of [['finalWinRate', f], ['finalRedWinRate', r], ['finalBlueWinRate', b]] as const) {
      if (v < 0 || v > 100) p.push(`${at}.${k}: ${v} out of 0..100`);
    }
  }
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
    // Two-stage sections (schemaVersion 2): 任務結算 / 刺殺結算 / 最終 + cohort role final rates + excess ranking.
    if (V2) num(p, d.schemaVersion, 'schemaVersion');
    v2Field(d.missionStage, () => {
      const s = obj(p, d.missionStage, 'missionStage');
      for (const k of ['games', 'threeRed', 'threeBlue', 'redPct', 'bluePct']) num(p, s[k], `missionStage.${k}`);
    });
    v2Field(d.assassinationStage, () => {
      const s = obj(p, d.assassinationStage, 'assassinationStage');
      for (const k of ['games', 'merlinKilled', 'merlinSurvived', 'killPct', 'survivePct']) num(p, s[k], `assassinationStage.${k}`);
    });
    v2Field(d.final, () => {
      const s = obj(p, d.final, 'final');
      for (const k of ['games', 'redWins', 'blueWins', 'redPct', 'bluePct']) num(p, s[k], `final.${k}`);
      if (typeof s.redPct === 'number' && typeof s.bluePct === 'number' && Math.abs(s.redPct + s.bluePct - 100) > 0.5) {
        p.push(`final: redPct + bluePct = ${s.redPct + s.bluePct}`);
      }
    });
    v2Field(d.roleFinalWinRates, () => numRecord(p, d.roleFinalWinRates, 'roleFinalWinRates'));
    v3Field(d.seatFinalWinRates, () => {
      numRecord(p, d.seatFinalWinRates, 'seatFinalWinRates');
      const keys = Object.keys(obj(p, d.seatFinalWinRates, 'seatFinalWinRates'));
      if (keys.join() !== '1,2,3,4,5,6,7,8,9,10') p.push(`seatFinalWinRates keys ${show(keys)}`);
    });
    v3Field(d.topPlayersByRoleTheory, () => {
      // [] is legitimate (nobody with 100 career games); present rows must be complete.
      arr(p, d.topPlayersByRoleTheory, 'topPlayersByRoleTheory').forEach((x, i) => {
        str(p, x.name, `topPlayersByRoleTheory[${i}].name`);
        for (const k of ['roleTheory', 'positionTheory', 'finalWinRate', 'games', 'careerGames']) num(p, x[k], `topPlayersByRoleTheory[${i}].${k}`);
      });
    });
    v2Field(d.topPlayersByExcess, () => {
      arr(p, d.topPlayersByExcess, 'topPlayersByExcess', { nonEmpty: true }).forEach((x, i) => {
        str(p, x.name, `topPlayersByExcess[${i}].name`);
        for (const k of ['excessWinRate', 'finalWinRate', 'games']) num(p, x[k], `topPlayersByExcess[${i}].${k}`);
      });
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
      twoStagePlayer(p, pl, at);
      v3Field(pl.theory, () => theoryBlock(p, pl.theory, pl.totalGames, `${at}.theory`));
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
      twoStagePlayer(p, pl, `${name}.player`);
      v3Field(pl.theory, () => theoryBlock(p, pl.theory, pl.totalGames, `${name}.player.theory`));
      // Radar per the contract: winRate / redWinRate are the FINAL rates, missionWinRate the legacy one,
      // excessWinRate may be null; roleTheory / positionTheory are theory.career's (null before schemaVersion 3,
      // never the legacy player.roleTheory).
      const radar = obj(p, d.radar, `${name}.radar`);
      for (const k of ['winRate', 'redWinRate', 'blueMerlinProtect', 'missionWinRate', 'redMerlinKillRate', 'experience']) {
        num(p, radar[k], `${name}.radar.${k}`);
      }
      numOrNull(p, radar.excessWinRate, `${name}.radar.excessWinRate`);
      const career = ((pl.theory as Json | undefined)?.career ?? null) as Json | null;
      for (const k of ['roleTheory', 'positionTheory']) {
        const expected = career && typeof career[k] === 'number' ? career[k] : null;
        if (radar[k] !== expected) p.push(`${name}.radar.${k}: ${show(radar[k])} ≠ player.theory.career.${k} ${show(expected)}`);
      }
      if (typeof pl.finalWinRate === 'number' && radar.winRate !== pl.finalWinRate) {
        p.push(`${name}.radar.winRate: ${show(radar.winRate)} ≠ player.finalWinRate ${show(pl.finalWinRate)}`);
      }
      if (typeof pl.finalRedWinRate === 'number' && radar.redWinRate !== pl.finalRedWinRate) {
        p.push(`${name}.radar.redWinRate: ${show(radar.redWinRate)} ≠ player.finalRedWinRate ${show(pl.finalRedWinRate)}`);
      }
      if (radar.excessWinRate !== (pl.excessWinRate ?? null)) {
        p.push(`${name}.radar.excessWinRate: ${show(radar.excessWinRate)} ≠ player.excessWinRate ${show(pl.excessWinRate)}`);
      }
    }
    expect(p).toEqual([]);
  });

  it('GET /leaderboard — 排行榜 boards (503 "not yet generated" until the cache carries the section)', async () => {
    const res = await request(server).get('/api/analysis/leaderboard');
    if (res.status === 503) {
      expect(V2, 'a schemaVersion-2 cache must carry the leaderboard section').toBe(false);
      expect(committedCache.leaderboard).toBeUndefined();
      expect(res.body).toEqual({ success: false, error: 'Leaderboard not yet generated' });
      return;
    }
    expect(res.status, JSON.stringify(res.body).slice(0, 200)).toBe(200);
    expect(res.body.success).toBe(true);
    const p: Problems = [];
    const d = res.body.data as Json;
    str(p, d.asOf, 'asOf');
    if (d.dates !== undefined) {
      const dates = obj(p, d.dates, 'dates');
      for (const k of ['parsed', 'unparsed']) num(p, dates[k], `dates.${k}`);
      for (const k of ['earliest', 'latest']) str(p, dates[k], `dates.${k}`);
    }
    if (d.config !== undefined) {
      const cfg = obj(p, d.config, 'config');
      if (V3 || cfg.theoryWindows !== undefined) {
        // The theory generator's LEADERBOARD_CONFIG (2026-10-13).
        for (const k of ['theoryMinCellGames', 'activeDays', 'topN', 'mainGames', 'shortGames', 'improvedGames', 'assassinAttempts', 'newcomerDays', 'roleTitleGames']) {
          num(p, cfg[k], `config.${k}`);
        }
        arr(p, cfg.theoryWindows, 'config.theoryWindows', { nonEmpty: true }).forEach((x, i) => num(p, x, `config.theoryWindows[${i}]`));
      } else {
        for (const k of ['windowDays', 'activeDays', 'minGames', 'shrinkK', 'minBoardRows', 'topN']) num(p, cfg[k], `config.${k}`);
        arr(p, cfg.fallbackWindowDays, 'config.fallbackWindowDays').forEach((x, i) => num(p, x, `config.fallbackWindowDays[${i}]`));
      }
    }
    // The generator omits every board it cannot build (docs/stats/two_stage_outcome.md:
    // 「做不出來的榜就不放」), so `boards` may be empty and `main` is not guaranteed — e.g.
    // when nobody played in the last activeDays. Present boards must be well-formed.
    const boards = arr(p, d.boards, 'boards');
    const ids = boards.map((b) => b.id);
    if (new Set(ids).size !== ids.length) p.push(`boards: duplicate ids ${show(ids)}`);
    boards.forEach((b, i) => {
      const at = `boards[${i}:${show(b.id)}]`;
      for (const k of ['id', 'title', 'period']) str(p, b[k], `${at}.${k}`);
      for (const k of ['windowDays', 'windowGames', 'minGames']) if (b[k] !== undefined) num(p, b[k], `${at}.${k}`);
      if (b.note !== undefined) str(p, b.note, `${at}.note`);
      // Since schemaVersion 3 every board says what its value is; the readers skip boards without it.
      v3Field(b.metric, () => str(p, b.metric, `${at}.metric`));
      // A board the generator could not build is omitted, so a present board has rows.
      arr(p, b.rows, `${at}.rows`, { nonEmpty: true }).forEach((r, j) => {
        const rat = `${at}.rows[${j}]`;
        str(p, r.name, `${rat}.name`);
        for (const k of ['rank', 'value', 'games']) num(p, r[k], `${rat}.${k}`);
        // finalWinRate / expectedFinalWinRate: on the excess boards (main / online / recent /
        // newcomers); improved, assassin and roleTitles rows carry other fields instead.
        for (const k of ['excessWinRate', 'finalWinRate', 'expectedFinalWinRate']) if (r[k] !== undefined) num(p, r[k], `${rat}.${k}`);
        if (b.metric === 'roleTheory') {
          // main / last50 / newcomers: what the site's table and /排行 print.
          for (const k of ['roleTheory', 'positionTheory', 'finalWinRate', 'careerGames']) num(p, r[k], `${rat}.${k}`);
          if (r.value !== r.roleTheory) p.push(`${rat}.value ${show(r.value)} ≠ roleTheory ${show(r.roleTheory)}`);
        } else if (b.metric === 'roleTheoryDelta') {
          for (const k of ['recentRoleTheory', 'priorRoleTheory']) num(p, r[k], `${rat}.${k}`);
        } else if (b.metric === 'hitRate') {
          for (const k of ['hits', 'attempts']) num(p, r[k], `${rat}.${k}`);
        } else if (b.metric === undefined && ['main', 'online', 'recent', 'newcomers'].includes(String(b.id))) {
          // Pre-2026-10-13 excess boards (older caches): the unshrunk excess and the period's final win rate.
          for (const k of ['excessWinRate', 'finalWinRate']) num(p, r[k], `${rat}.${k}`);
        }
        if (r.role !== undefined) str(p, r.role, `${rat}.role`);
      });
    });
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
      // L141 is either the old bar (staging report) or the generator's lakeClaim.
      if (f.loopId === 'L141' && f.visualType !== 'bar' && f.visualType !== 'lakeClaim') {
        p.push(`${at}: L141 must be visualType bar or lakeClaim, got ${show(f.visualType)}`);
      }
      switch (f.visualType) {
        case 'lakeClaim':
          num(p, data.minSample, `${at}.data.minSample`);
          arr(p, data.rows, `${at}.data.rows`, { nonEmpty: true }).forEach((r, j) => {
            const rat = `${at}.data.rows[${j}]`;
            for (const k of ['lake', 'lakeEn', 'declared', 'declaredEn']) str(p, r[k], `${rat}.${k}`);
            for (const k of ['n', 'hitRate', 'ciLow', 'ciHigh']) num(p, r[k], `${rat}.${k}`);
            bool(p, r.lowSample, `${rat}.lowSample`);
            if (typeof r.ciLow === 'number' && typeof r.hitRate === 'number' && typeof r.ciHigh === 'number' && !(r.ciLow <= r.hitRate && r.hitRate <= r.ciHigh)) {
              p.push(`${rat}: hitRate ${r.hitRate} outside [${r.ciLow}, ${r.ciHigh}]`);
            }
          });
          break;
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

// ---------------------------------------------------------------------------
// withFinalFields — the server-side fallback for caches predating schemaVersion 2
// ---------------------------------------------------------------------------

describe('rnd1 — one decimal, ties to even (same as Python round in generate_cache.py)', () => {
  it('rounds exact .x5 ties to the even digit and everything else normally', () => {
    expect(rnd1(56.25)).toBe(56.2); // 9/16 games → the cache stores 56.2
    expect(rnd1(56.35)).toBe(56.4);
    expect(rnd1(26.25)).toBe(26.2);
    expect(rnd1(31.25)).toBe(31.2);
    expect(rnd1(59.14)).toBe(59.1);
    expect(rnd1(59.16)).toBe(59.2);
    expect(rnd1(-2.25)).toBe(-2.2);
    expect(rnd1(0)).toBe(0);
    expect(rnd1((9 / 16) * 100)).toBe(56.2);
  });
});

describe('withFinalFields (two-stage fields from raw counts)', () => {
  const base: PlayerStats = {
    name: 'X', totalGames: 10, winRate: 60, roleTheory: 60, positionTheory: 0, redWin: 50, blueWin: 66.7,
    red3Red: 50, redMerlinDead: 25, redMerlinAlive: 25, blue3Red: 33.3, blueMerlinDead: 33.3, blueMerlinAlive: 33.3,
    roleWinRates: {}, roleDistribution: { '刺客': 60, '梅林': 40 }, redRoleRate: 40, blueRoleRate: 60,
    seatWinRates: {}, seatRedWinRates: {}, seatBlueWinRates: {}, rawRoleGames: { '刺客': 6, '梅林': 4 },
    rawRedWins: 2, rawBlueWins: 4, rawTotalWins: 6, rawRedGames: 4, rawBlueGames: 6,
    // red: 2 三紅, 1 三藍死, 1 三藍活; blue: 2 三紅, 2 三藍死, 2 三藍活
    rawRedThreeRed: 2, rawRedMerlinDead: 1, rawRedMerlinAlive: 1,
    rawBlueThreeRed: 2, rawBlueMerlinDead: 2, rawBlueMerlinAlive: 2,
  };

  it('derives every rate from the raw counts; excess is null without cohort role rates', () => {
    const out = withFinalFields(base);
    expect(out).toMatchObject({
      finalWinRate: 50, // (2 + 1 + 2) / 10
      finalRedWinRate: 75, // (2 + 1) / 4
      finalBlueWinRate: 33.3, // 2 / 6
      missionWinRate: 60, // (2 + 2 + 2) / 10 — the legacy winRate
      merlinSurvivalRate: 50, // 2 / (2 + 2)
      rawBlueThreeBlue: 4,
      expectedFinalWinRate: null,
      excessWinRate: null,
    });
    expect(out.missionWinRate).toBe(base.winRate);
    expect(out).not.toBe(base); // pure
    expect(base.finalWinRate).toBeUndefined();
    expect(out.roleFinalWinRates).toBeUndefined(); // cannot be derived
  });

  it('computes expected / excess with the contract formula: Σ rawRoleGames × cohort roleFinalWinRates / totalGames', () => {
    const rates = { '刺客': 70, '梅林': 30, '忠臣': 30 };
    const out = withFinalFields(base, rates);
    expect(out.expectedFinalWinRate).toBe(54); // (6 × 70 + 4 × 30) / 10
    expect(out.excessWinRate).toBe(-4); // 50 − 54
    // The raw counts win over the 0.1%-rounded roleDistribution.
    expect(withFinalFields({ ...base, roleDistribution: { '刺客': 100 } }, rates).expectedFinalWinRate).toBe(54);
    // Where the two disagree the generator's number (rawRoleGames) is the right one: 5 刺客 + 6 梅林 of
    // 11 games → (5 × 70.1 + 6 × 30.2) / 11 = 48.3, while the rounded shares 45.5 / 54.5 would give 48.4.
    const drift = withFinalFields(
      { ...base, totalGames: 11, rawRoleGames: { '刺客': 5, '梅林': 6 }, roleDistribution: { '刺客': 45.5, '梅林': 54.5 } },
      { '刺客': 70.1, '梅林': 30.2 },
    );
    expect(drift.expectedFinalWinRate).toBe(48.3);
    // Only a player without raw role counts falls back to roleDistribution.
    expect(withFinalFields({ ...base, rawRoleGames: {} }, rates).expectedFinalWinRate).toBe(54); // 0.6 × 70 + 0.4 × 30
    expect(withFinalFields({ ...base, rawRoleGames: {}, roleDistribution: {} }, rates).expectedFinalWinRate).toBeNull();
  });

  it('keeps the fields a schemaVersion-2 cache already carries', () => {
    const given = { ...base, finalWinRate: 51.1, finalRedWinRate: 1, finalBlueWinRate: 2, missionWinRate: 3, merlinSurvivalRate: 4, rawBlueThreeBlue: 9, expectedFinalWinRate: 40, excessWinRate: 11.1, roleFinalWinRates: { '刺客': 100 }, firstPlayed: '2020-01-01', lastPlayed: '' };
    expect(withFinalFields(given, { '刺客': 0 })).toEqual(given);
  });

  it('a side never played gives 0, not NaN; no 三藍 as blue gives survival 0 with rawBlueThreeBlue 0', () => {
    const out = withFinalFields({ ...base, totalGames: 4, rawBlueGames: 0, rawBlueThreeRed: 0, rawBlueMerlinDead: 0, rawBlueMerlinAlive: 0 });
    expect(out).toMatchObject({ finalWinRate: 75, finalRedWinRate: 75, finalBlueWinRate: 0, merlinSurvivalRate: 0, rawBlueThreeBlue: 0 });
    const redless = withFinalFields({ ...base, totalGames: 6, rawRedGames: 0, rawRedThreeRed: 0, rawRedMerlinDead: 0, rawRedMerlinAlive: 0 });
    expect(redless).toMatchObject({ finalWinRate: 33.3, finalRedWinRate: 0, finalBlueWinRate: 33.3 });
  });

  it('without raw counts the rates stay absent and excess is null (nothing fabricated)', () => {
    const old: PlayerStats = { ...base };
    for (const k of ['rawRedThreeRed', 'rawRedMerlinDead', 'rawRedMerlinAlive', 'rawBlueThreeRed', 'rawBlueMerlinDead', 'rawBlueMerlinAlive'] as const) delete old[k];
    const out = withFinalFields(old);
    expect(out.finalWinRate).toBeUndefined();
    expect(out.missionWinRate).toBeUndefined();
    expect(out.excessWinRate).toBeNull();
    expect(out.expectedFinalWinRate).toBeNull();
  });
});
