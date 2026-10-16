/**
 * GET /api/analysis/games（複合篩選，Edward 2026-10-14；r9 設計 §1.7）：每局資料集 + context，兩檔同一批才給，
 * 第一次被要求時跑一次不篩選的引擎與快取逐欄比（engineCheck），預先壓縮、強 ETag / 304。
 *
 * 用虛構局的 fixture（fixtures/stats_parity/invented）組一份同批的 analysis_cache.json（Python 的參考答案 +
 * overview.gamesKey），經 AVALON_ANALYSIS_CACHE / AVALON_GAMES_DATASET 給伺服器讀。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import express from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../middleware/rateLimit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware/rateLimit')>();
  return {
    ...actual,
    createHttpRateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  };
});

import { analysisRouter } from '../routes/analysis';
import { ENV_ANALYSIS_CACHE, invalidateCache } from '../services/sheetsAnalysis';
import {
  ENV_GAMES_DATASET,
  ENV_STATS_ENGINE_CHECK,
  GAMES_ENGINE_FAILED,
  GAMES_MISMATCH,
  GAMES_NOT_GENERATED,
  invalidateGamesPayload,
  pickEncoding,
} from '../services/gamesDataset';

const FIXTURE = path.resolve(__dirname, 'fixtures', 'stats_parity', 'invented');
const dataset = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'games.json'), 'utf-8')) as { key: string; players: string[]; games: unknown[] };
type Row = Record<string, unknown> & { name: string; roleWinRates: Record<string, number>; finalWinRate: number };
interface RefSections {
  overview: Record<string, unknown>;
  players: { players: Row[] } & Record<string, unknown>;
  missions: Record<string, unknown>;
  rounds: Record<string, unknown>;
  captainAnalysis: Record<string, unknown>;
  leaderboard: { config: Record<string, unknown> } & Record<string, unknown>;
  lake: Record<string, unknown>;
  seatOrder: Record<string, unknown>;
  lakeClaim: Record<string, unknown>;
  pairs: { outcomePair: Record<string, unknown> };
}
const refs = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(FIXTURE, 'refs.json.gz'))).toString('utf-8')) as Record<
  string, { sections: RefSections }
>;
const context = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'context.json'), 'utf-8'));
const asOf = context.asOf as string;

function cacheOf(reference: RefSections): Record<string, unknown> {
  const sections = JSON.parse(JSON.stringify(reference)) as RefSections; // the tests edit their copy
  const players = sections.players;
  const playerDetails: Record<string, unknown> = {};
  for (const row of players.players) {
    const { seatOutcomes: _s, ...player } = row;
    void _s;
    playerDetails[row.name] = { player, radar: { ...row.roleWinRates } };
  }
  const empty = { players: [], rowLabels: [], values: [] };
  const sample = sections.lakeClaim.sampleSize as { games: number; links: number };
  return {
    overview: sections.overview,
    players: sections.players,
    playerDetails,
    chemistry: { coWin: { ...empty, ...context.chemistryRoster }, coLose: empty, winCorr: empty, coWinMinusLose: empty,
      outcomePair: sections.pairs.outcomePair },
    missions: sections.missions,
    lake: sections.lake,
    seatOrder: sections.seatOrder,
    featureStudies: { generatedAt: asOf, sampleSize: { games: sample.games, lakeLinks: sample.links },
      features: [sections.lakeClaim] },
    rounds: sections.rounds,
    captainAnalysis: sections.captainAnalysis,
    leaderboard: sections.leaderboard,
  };
}

const app = express();
app.use('/api/analysis', analysisRouter);

let dir: string;
let cacheFile: string;
let datasetFile: string;
const saved: Record<string, string | undefined> = {};

function writeCache(cache: Record<string, unknown>): void {
  fs.writeFileSync(cacheFile, JSON.stringify(cache), 'utf-8');
  invalidateCache();
  invalidateGamesPayload();
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avalon-games-'));
  cacheFile = path.join(dir, 'analysis_cache.json');
  datasetFile = path.join(dir, 'games_cache.json');
  for (const k of [ENV_ANALYSIS_CACHE, ENV_GAMES_DATASET, ENV_STATS_ENGINE_CHECK]) saved[k] = process.env[k];
});

beforeEach(() => {
  process.env[ENV_ANALYSIS_CACHE] = cacheFile;
  process.env[ENV_GAMES_DATASET] = datasetFile;
  delete process.env[ENV_STATS_ENGINE_CHECK];
  fs.copyFileSync(path.join(FIXTURE, 'games.json'), datasetFile);
  writeCache(cacheOf(refs.none.sections));
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  invalidateCache();
  invalidateGamesPayload();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('GET /api/analysis/games', () => {
  it('serves the dataset with its context once the engine reproduces the cache', async () => {
    const res = await request(app).get('/api/analysis/games').set('Accept-Encoding', 'identity');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.headers['cache-control']).toBe('public, max-age=300, stale-while-revalidate=3600');
    expect(res.headers.vary).toBe('Accept-Encoding');
    expect(res.headers.etag).toMatch(/^"[0-9a-f]{40}"$/);
    expect(res.body.success).toBe(true);
    expect(res.body.data.dataset.key).toBe(dataset.key);
    expect(res.body.data.dataset.games).toHaveLength(dataset.games.length);
    expect(res.body.data.context).toEqual({
      gamesKey: dataset.key,
      asOf,
      leaderboardConfig: refs.none.sections.leaderboard.config,
      schemaVersion: 4,
      aliases: context.aliases,
      chemistryRoster: context.chemistryRoster,
      unfiltered: { totalGames: dataset.games.length, totalPlayers: dataset.players.length },
      engineCheck: 'passed',
    });
  });

  it('compresses with brotli or gzip and answers 304 to a matching If-None-Match', async () => {
    const plain = await request(app).get('/api/analysis/games').set('Accept-Encoding', 'identity');
    for (const encoding of ['br', 'gzip'] as const) {
      const res = await request(app)
        .get('/api/analysis/games')
        .set('Accept-Encoding', encoding === 'br' ? 'gzip, deflate, br' : 'gzip')
        .buffer(true)
        .parse((r, done) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () => done(null, Buffer.concat(chunks)));
        });
      expect(res.status).toBe(200);
      expect(res.headers['content-encoding']).toBe(encoding);
      expect(res.headers.etag).toBe(plain.headers.etag);
    }
    const again = await request(app).get('/api/analysis/games').set('If-None-Match', plain.headers.etag);
    expect(again.status).toBe(304);
    expect(again.text).toBeFalsy();
  });

  it('turns the filters off (503) when the two files are not one batch', async () => {
    const cache = cacheOf(refs.none.sections);
    (cache.overview as Record<string, unknown>).gamesKey = '0000000000000000';
    writeCache(cache);
    const res = await request(app).get('/api/analysis/games');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ success: false, error: GAMES_MISMATCH });

    const old = cacheOf(refs.none.sections);
    delete (old.overview as Record<string, unknown>).gamesKey; // a cache written before the dataset existed
    writeCache(old);
    expect((await request(app).get('/api/analysis/games')).body.error).toBe(GAMES_MISMATCH);
  });

  it('says so when the dataset has not been generated', async () => {
    fs.rmSync(datasetFile);
    invalidateGamesPayload();
    const res = await request(app).get('/api/analysis/games');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe(GAMES_NOT_GENERATED);
  });

  it('refuses when the engine does not reproduce the cache, naming nobody in the log', async () => {
    const cache = cacheOf(refs.none.sections);
    const players = (cache.players as { players: Row[] }).players;
    players[0].finalWinRate += 0.1;
    writeCache(cache);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await request(app).get('/api/analysis/games');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe(GAMES_ENGINE_FAILED);
    const logged = errors.mock.calls.flat().join(' ');
    expect(logged).toContain('1');
    expect(logged).not.toContain('players.players[0].finalWinRate');
    for (const name of dataset.players) expect(logged).not.toContain(name);

    process.env[ENV_STATS_ENGINE_CHECK] = 'off';
    invalidateGamesPayload();
    const skipped = await request(app).get('/api/analysis/games').set('Accept-Encoding', 'identity');
    expect(skipped.status).toBe(200);
    expect(skipped.body.data.context.engineCheck).toBe('skipped');
  });

  it('picks the encoding from Accept-Encoding', () => {
    expect(pickEncoding('gzip, deflate, br')).toBe('br');
    expect(pickEncoding('gzip;q=1.0, br;q=0')).toBe('gzip');
    expect(pickEncoding('deflate')).toBe('identity');
    expect(pickEncoding(undefined)).toBe('identity');
  });
});

describe('GET /api/analysis/games with the committed files', () => {
  it('serves them when they are one batch, else says they are not (until the daily refresh writes both)', async () => {
    const server = path.resolve(__dirname, '..', '..');
    process.env[ENV_ANALYSIS_CACHE] = path.join(server, 'analysis_cache.json');
    process.env[ENV_GAMES_DATASET] = path.join(server, 'games_cache.json');
    invalidateCache();
    invalidateGamesPayload();
    const cache = JSON.parse(fs.readFileSync(path.join(server, 'analysis_cache.json'), 'utf-8'));
    const datasetPath = path.join(server, 'games_cache.json');
    const committed = fs.existsSync(datasetPath) ? JSON.parse(fs.readFileSync(datasetPath, 'utf-8')) : null;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await request(app).get('/api/analysis/games').set('Accept-Encoding', 'identity');
    if (committed && cache.overview.gamesKey === committed.key) {
      expect(res.status).toBe(200);
      expect(res.body.data.context.engineCheck).toBe('passed');
    } else {
      expect(res.status).toBe(503);
      expect(res.body.error).toBe(committed ? GAMES_MISMATCH : GAMES_NOT_GENERATED);
    }
  });
});
