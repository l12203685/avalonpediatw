/**
 * Player aliases on the server (Edward 2026-10-14: an old name and the official one are the same
 * player, shown under the official name). generate_cache.py merges the old names' games into the
 * official name's row and writes the map as players.aliases (packages/server/player_aliases.json →
 * analysis_cache.json); the stats API, the profile panels and GET /players (the website search)
 * read it from there. A temp cache with made-up names, served through AVALON_ANALYSIS_CACHE.
 */
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { analysisRouter } from '../routes/analysis';
import {
  ENV_ANALYSIS_CACHE,
  getPlayerAliases,
  getPlayerArchetype,
  getPlayerByName,
  invalidateCache,
} from '../services/sheetsAnalysis';

const ALIASES = { 'Tovo Wren': 'Ilse Marr', Orlapike: 'Ilse Marr' };

function row(name: string, totalGames: number): Record<string, unknown> {
  return {
    name, totalGames, winRate: 50, roleTheory: 50, positionTheory: 0, redWin: 50, blueWin: 50,
    red3Red: 0, redMerlinDead: 0, redMerlinAlive: 0, blue3Red: 0, blueMerlinDead: 0, blueMerlinAlive: 0,
    roleWinRates: {}, roleDistribution: {}, redRoleRate: 0, blueRoleRate: 0, seatWinRates: {},
    seatRedWinRates: {}, seatBlueWinRates: {}, rawRoleGames: {}, rawRedWins: 0, rawBlueWins: 0, rawTotalWins: 0,
    rawRedGames: 5, rawBlueGames: 5,
  };
}

const PLAYERS = [row('Ilse Marr', 49), row('Nova', 12)];
const CACHE = {
  overview: { totalGames: 61, totalPlayers: 2 },
  players: { players: PLAYERS, total: 2, seatOutcomesSource: 'games', aliases: ALIASES },
  playerDetails: Object.fromEntries(PLAYERS.map((p) => [p.name, { player: p, radar: {} }])),
  chemistry: { coWin: { players: [], values: [] }, coLose: { players: [], values: [] } },
  archetype: {
    perPlayer: { 'Ilse Marr': { hasData: true, sampleSize: 40, axes: {}, percentiles: {} } },
    cohort: {}, axisLabels: {}, axisHelp: {},
  },
};

let dir = '';
let previous: string | undefined;
let server: http.Server;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avalon-aliases-'));
  const file = path.join(dir, 'analysis_cache.json');
  fs.writeFileSync(file, JSON.stringify(CACHE), 'utf-8');
  previous = process.env[ENV_ANALYSIS_CACHE];
  process.env[ENV_ANALYSIS_CACHE] = file;
  invalidateCache();
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

describe('players.aliases — an old name finds the official name', () => {
  it('getPlayerAliases reads the cache map', async () => {
    expect(await getPlayerAliases()).toEqual(ALIASES);
  });

  it('getPlayerByName / the profile panels: any spelling of an old name is the official row', async () => {
    for (const typed of ['Tovo Wren', 'tovo wren', 'ＴＯＶＯ　ＷＲＥＮ', 'ORLAPIKE']) {
      expect((await getPlayerByName(typed))?.name).toBe('Ilse Marr');
      expect((await getPlayerArchetype(typed))?.player).toEqual({ name: 'Ilse Marr', totalGames: 49 });
    }
    expect(await getPlayerByName('Tovo')).toBeNull(); // never part of an old name
    expect(await getPlayerByName('@Tovo Wren')).toBeNull(); // data, not a typed query: no cleaning
  });

  it('GET /api/analysis/players hands the map to the website; /players/:name follows it', async () => {
    const list = await request(server).get('/api/analysis/players');
    expect(list.status).toBe(200);
    expect(list.body.data.aliases).toEqual(ALIASES);
    expect(list.body.data.players.map((p: { name: string }) => p.name)).toEqual(['Ilse Marr', 'Nova']);
    const one = await request(server).get(`/api/analysis/players/${encodeURIComponent('Tovo Wren')}`);
    expect(one.status).toBe(200);
    expect(one.body.data.player.name).toBe('Ilse Marr');
    expect((await request(server).get('/api/analysis/players/Tovo')).status).toBe(404);
  });
});
