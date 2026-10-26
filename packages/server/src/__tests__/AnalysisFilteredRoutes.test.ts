/**
 * 網站的篩選畫面 (packages/web/src/stats/filteredRoutes.ts)：有篩選時，分析各分頁改用瀏覽器端引擎的結果，
 * 組成與 /api/analysis/<path> 相同形狀的 data。不篩選時引擎 = 快取，所以這裡用正式提交的快取與資料集
 * (兩檔同一批時) 比對：每條路徑的回應都要和伺服器路由回的 data 逐欄相同。
 */
import fs from 'fs';
import path from 'path';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { computeStats, decodeGamesDataset, type StatsResult } from '@avalon/shared/stats';

vi.mock('../middleware/rateLimit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware/rateLimit')>();
  return {
    ...actual,
    createHttpRateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  };
});

import { analysisRouter } from '../routes/analysis';
import { ENV_ANALYSIS_CACHE, invalidateCache } from '../services/sheetsAnalysis';
import { FILTERED_PATHS, filteredRoute, withFilteredLakeClaim } from '../../../web/src/stats/filteredRoutes';

const SERVER = path.resolve(__dirname, '..', '..');
const cache = JSON.parse(fs.readFileSync(path.join(SERVER, 'analysis_cache.json'), 'utf-8'));
const datasetPath = path.join(SERVER, 'games_cache.json');
const dataset = fs.existsSync(datasetPath) ? JSON.parse(fs.readFileSync(datasetPath, 'utf-8')) : null;
const oneBatch = Boolean(dataset && cache.overview.gamesKey === dataset.key);

const app = express();
app.use('/api/analysis', analysisRouter);
let saved: string | undefined;
let result: StatsResult;

beforeAll(() => {
  saved = process.env[ENV_ANALYSIS_CACHE];
  process.env[ENV_ANALYSIS_CACHE] = path.join(SERVER, 'analysis_cache.json');
  invalidateCache();
  if (oneBatch) {
    const roster = { players: cache.chemistry.coWin?.players ?? [], rowLabels: cache.chemistry.coWin?.rowLabels };
    result = computeStats(decodeGamesDataset(dataset, cache.overview.gamesKey), {
      asOf: cache.leaderboard.asOf, aliases: cache.players.aliases ?? {}, chemistryRoster: roster,
    }, null);
  }
});

afterAll(() => {
  if (saved === undefined) delete process.env[ENV_ANALYSIS_CACHE];
  else process.env[ENV_ANALYSIS_CACHE] = saved;
  invalidateCache();
});

/** JSON 往返 (路由回的是 JSON；undefined 欄位在 JSON 裡不存在)。 */
const json = (v: unknown): unknown => JSON.parse(JSON.stringify(v));

describe.skipIf(!oneBatch)('filtered analysis routes = the server routes when nothing is filtered', () => {
  it.each(FILTERED_PATHS.filter((p) => p !== '/chemistry'))('%s', async (route) => {
    const res = await request(app).get(`/api/analysis${route}`);
    expect(res.status).toBe(200);
    const mine = filteredRoute(route, result);
    expect(mine?.kind).toBe('data');
    expect(json((mine as { data: unknown }).data)).toEqual(res.body.data);
  });

  it('/chemistry: only the recomputed three-outcome pairs (the sheet matrices cannot be recomputed)', async () => {
    const res = await request(app).get('/api/analysis/chemistry');
    const mine = filteredRoute('/chemistry', result) as { data: Record<string, unknown> };
    expect(Object.keys(mine.data)).toEqual(['outcomePair']);
    expect(json(mine.data.outcomePair)).toEqual(res.body.data.outcomePair);
  });

  it('/players/:name for several players, an old name (alias) and a typed name in other case', async () => {
    const names: string[] = cache.players.players.slice(0, 12).map((p: { name: string }) => p.name);
    const aliases = Object.keys(cache.players.aliases ?? {}).slice(0, 3);
    for (const name of [...names, ...aliases, names[0].toUpperCase(), names[1].toLowerCase()]) {
      const route = `/players/${encodeURIComponent(name)}`;
      const res = await request(app).get(`/api/analysis${route}`);
      const mine = filteredRoute(route, result);
      if (res.status === 404) {
        expect(mine, name).toEqual({ kind: 'notFound' });
        continue;
      }
      expect(mine?.kind, name).toBe('data');
      expect(json((mine as { data: unknown }).data), name).toEqual(res.body.data);
    }
    expect(filteredRoute('/players/%E2%80%94nobody-by-this-name%E2%80%94', result)).toEqual({ kind: 'notFound' });
  });

  it('/feature-studies: L141 is the recomputed one, the others stay', async () => {
    const res = await request(app).get('/api/analysis/feature-studies');
    expect(res.status).toBe(200);
    expect(json(withFilteredLakeClaim(res.body.data, result))).toEqual(res.body.data);
  });

  it('paths that do not follow the filter are left to the API', () => {
    for (const route of ['/feature-studies', '/profile/x/archetype', '/wiki', '/games']) {
      expect(filteredRoute(route, result)).toBeUndefined();
    }
  });
});
