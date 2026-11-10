/**
 * 理論勝率走勢 (Edward 2026-11-10「除了歷史ELO 走勢 可以也建立每個玩家的 角色 位置 整體 理論勝率 的走勢圖嗎」):
 * generate_cache.py compute_theory_trend writes theoryTrend.series[name] = [date, games, 角色理論, 位置理論, 整體理論,
 * roleFull]; GET /api/analysis/theory-trend/:name serves one player's points plus where the curves end today
 * (players[].theory). A temp cache with made-up names, served through AVALON_ANALYSIS_CACHE.
 */
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { analysisRouter } from '../routes/analysis';
import { ENV_ANALYSIS_CACHE, getPlayerTheoryTrend, invalidateCache } from '../services/sheetsAnalysis';

const CONFIG = {
  theoryMinCellGames: 5,
  roleWindowGames: { 刺客: 10, 莫甘娜: 10, 莫德雷德: 10, 奧伯倫: 10, 派西維爾: 10, 梅林: 10, 忠臣: 40 },
  positionGames: 100,
  overallMinGames: 100,
};

function row(name: string, games: number): Record<string, unknown> {
  return {
    name,
    totalGames: games,
    theory: {
      roleWindows: { roleTheory: 47.3, fullWindows: true, games: 100, sparseRoles: 0, from: '', to: '', roles: {} },
      last100: { window: 100, games: Math.min(games, 100), roleTheory: 46, positionTheory: 48.8, finalWinRate: 50,
        from: '', to: '', sparseRoles: 0, sparseSeats: 0 },
      career: { window: 0, games, roleTheory: 46, positionTheory: 48, finalWinRate: 50, from: '', to: '',
        sparseRoles: 0, sparseSeats: 0, overallTheory: 45.1, sparseCells: 12, populationShare: 8.2 },
    },
  };
}

const PLAYERS = [row('Ilse Marr', 130), row('Nova', 3)];
const SERIES = {
  'Ilse Marr': [['2026-05-01', 2, 44.1, 45.2, 46.3, 0], ['2026-05-03', 130, 47.0, 48.6, 45.0, 1]],
  Nova: [['2026-05-03', 3, 40.0, 41.0, 42.0, 0]],
};

function cache(withTrend: boolean): Record<string, unknown> {
  return {
    overview: { totalGames: 133, totalPlayers: 2 },
    players: { players: PLAYERS, total: 2, seatOutcomesSource: 'games', aliases: { 'Tovo Wren': 'Ilse Marr' } },
    playerDetails: Object.fromEntries(PLAYERS.map((p) => [p.name, { player: p, radar: {} }])),
    chemistry: { coWin: { players: [], values: [] } },
    leaderboard: { asOf: '2026-05-04', boards: [] },
    ...(withTrend
      ? { theoryTrend: { schemaVersion: 1, config: CONFIG, fields: ['date', 'games', 'roleTheory', 'positionTheory',
        'overallTheory', 'roleFull'], dataThrough: '2026-05-03', series: SERIES } }
      : {}),
  };
}

let dir = '';
let file = '';
let previous: string | undefined;
let server: http.Server;

function serve(withTrend: boolean): void {
  fs.writeFileSync(file, JSON.stringify(cache(withTrend)), 'utf-8');
  invalidateCache();
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avalon-theory-trend-'));
  file = path.join(dir, 'analysis_cache.json');
  previous = process.env[ENV_ANALYSIS_CACHE];
  process.env[ENV_ANALYSIS_CACHE] = file;
  serve(true);
  const app = express();
  app.use('/api/analysis', analysisRouter);
  server = http.createServer(app);
});

afterAll(() => {
  server?.close();
  if (previous === undefined) delete process.env[ENV_ANALYSIS_CACHE];
  else process.env[ENV_ANALYSIS_CACHE] = previous;
  invalidateCache();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('GET /api/analysis/theory-trend/:name', () => {
  it('serves the points, the current rates and the window sizes', async () => {
    const res = await request(server).get(`/api/analysis/theory-trend/${encodeURIComponent('Ilse Marr')}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      name: 'Ilse Marr',
      series: SERIES['Ilse Marr'],
      current: { games: 130, roleTheory: 47.3, roleFull: true, positionTheory: 48.8, overallTheory: 45.1 },
      config: CONFIG,
      dataThrough: '2026-05-03',
      asOf: '2026-05-04',
    });
  });

  it('matches names like the other player routes (case / width, aliases)', async () => {
    for (const typed of ['ilse marr', 'ＩＬＳＥ　ＭＡＲＲ', 'Tovo Wren', 'tovo wren']) {
      expect((await getPlayerTheoryTrend(typed))?.name, typed).toBe('Ilse Marr');
    }
    expect((await getPlayerTheoryTrend('nova'))?.series).toEqual(SERIES.Nova);
  });

  it('404 for an unknown name (and never an Object.prototype member), 503 before the section exists', async () => {
    expect((await request(server).get('/api/analysis/theory-trend/Nobody')).status).toBe(404);
    expect((await request(server).get('/api/analysis/theory-trend/__proto__')).status).toBe(404);
    expect((await request(server).get('/api/analysis/theory-trend/constructor')).status).toBe(404);
    serve(false);
    try {
      const res = await request(server).get('/api/analysis/theory-trend/Nova');
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ success: false, error: 'Theory trend not yet generated' });
    } finally {
      serve(true);
    }
  });

  it('current is null when the players row has no theory block', async () => {
    const c = cache(true) as { playerDetails: Record<string, { player: Record<string, unknown> }> };
    delete c.playerDetails.Nova.player.theory;
    fs.writeFileSync(file, JSON.stringify(c), 'utf-8');
    invalidateCache();
    try {
      expect((await getPlayerTheoryTrend('Nova'))?.current).toBeNull();
    } finally {
      serve(true);
    }
  });
});
