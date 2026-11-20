/**
 * 開打時的桌上強度 S（`tableStrength.ts`）→ 弱／一般／強真人桌。名字都是編的。
 */
import { describe, expect, it } from 'vitest';
import { Server as SocketIOServer } from 'socket.io';
import { createServer } from 'http';
import type { Player, Room } from '@avalon/shared';
import { HeuristicAgent } from './HeuristicAgent';
import type { AvalonAgent } from './types';
import {
  UNKNOWN_PLAYER_PR, buildPlayerPrIndex, livePlayerPrIndex, liveTableS, opponentTypeOfHumans, percentileRank, tableStrengthOf,
} from './tableStrength';
import { GameServer, humanNamesOfRoom } from '../socket/GameServer';
import { signageHumanNames, signageOpponent } from '../../scripts/signagePlayer';

type Row = { name: string; elo: number; games: number; lastPlayed?: string };
const row = (r: Row) => ({ rank: 0, sigma: 0, modelTheory: 0, provisional: r.games < 30, firstPlayed: null, lastPlayed: r.lastPlayed ?? null, ...r });
const CFG = { lineupMinGames: 30, lineupActiveDays: null, lineupMinPool: 4, lineupProvisionalCap: 50 };
// 池子（≥ 30 場）：Elo 1400 / 1450 / 1500 / 1550 / 1600 → PR 10 / 30 / 50 / 70 / 90
const ROWS: Row[] = [
  { name: 'Quartz', elo: 1400, games: 40 },
  { name: 'Birch', elo: 1450, games: 80 },
  { name: 'Cobalt', elo: 1500, games: 35 },
  { name: 'Delta', elo: 1550, games: 200 },
  { name: 'Ember', elo: 1600, games: 300 },
  { name: 'Fennel', elo: 1650, games: 12 }, // 暫定：PR 封頂 50
];
const rating = (rows: Row[] = ROWS, config: Record<string, unknown> = CFG, dataThrough: string | null = '2026-01-31') =>
  ({ players: rows.map(row), config, dataThrough });

describe('player PR (same rule as the site lineup S)', () => {
  it('percentile rank uses the mid-rank for ties, like generate_cache._percentile_rank', () => {
    expect(percentileRank([1, 2, 3, 4], 3)).toBe(62.5);
    expect(percentileRank([1, 2, 2, 4], 2)).toBe(50);
    expect(percentileRank([1, 2, 3, 4], 9)).toBe(100);
  });
  it('pool = players with enough games; provisional players are capped; unknown names are null', () => {
    const idx = buildPlayerPrIndex(rating())!;
    expect(idx.pool).toBe(5);
    expect(idx.prOf('Quartz')?.pr).toBe(10);
    expect(idx.prOf('Ember')?.pr).toBe(90);
    expect(idx.prOf('Fennel')).toEqual({ name: 'Fennel', pr: 50, provisional: true });
    expect(idx.prOf('Nobody')).toBeNull();
    expect(idx.prOf('')).toBeNull();
  });
  it('names match like the site: case / width, then player_aliases (old name → official name)', () => {
    const idx = buildPlayerPrIndex(rating(), { OldEmber: 'Ember' })!;
    expect(idx.prOf('ember')?.name).toBe('Ember');
    expect(idx.prOf('ＥＭＢＥＲ')?.name).toBe('Ember');
    expect(idx.prOf('OldEmber')?.pr).toBe(90);
  });
  it('too small a pool → not rated; lineupActiveDays limits the pool when set', () => {
    expect(buildPlayerPrIndex(rating(ROWS, { ...CFG, lineupMinPool: 6 }))).toBeNull();
    const dated = ROWS.map((r, i) => ({ ...r, lastPlayed: i === 0 ? '2025-01-01' : '2026-01-30' }));
    const idx = buildPlayerPrIndex(rating(dated, { ...CFG, lineupActiveDays: 90 }))!;
    expect(idx.pool).toBe(4); // Quartz is out of the active pool
    expect(idx.prOf('Birch')?.pr).toBe(13); // 1450 is now the lowest of four → 12.5 → 13
  });
});

describe('table S → opponent type', () => {
  const idx = buildPlayerPrIndex(rating())!;
  it('S = mean PR of the humans; unknown players count as average (PR 50)', () => {
    expect(UNKNOWN_PLAYER_PR).toBe(50);
    expect(tableStrengthOf(['Delta', 'Ember'], idx)).toEqual({ s: 80, known: 2, unknown: 0 });
    expect(tableStrengthOf(['Quartz', 'Guest-1234'], idx)).toEqual({ s: 30, known: 1, unknown: 1 });
    expect(tableStrengthOf([], idx).s).toBeNull();
    expect(tableStrengthOf(['Ember'], null).s).toBeNull();
  });
  it('tiers follow the site cohort cuts (S < 38 weak, ≥ 55 strong); no humans → ai; no S → avgHuman', () => {
    const sOf = (names: readonly string[]) => tableStrengthOf(names, idx).s;
    expect(opponentTypeOfHumans(['Delta', 'Ember'], sOf)).toEqual({ type: 'strongHuman', tableS: 80 });
    expect(opponentTypeOfHumans(['Quartz', 'Birch'], sOf)).toEqual({ type: 'weakHuman', tableS: 20 });
    expect(opponentTypeOfHumans(['Cobalt', 'Someone'], sOf).type).toBe('avgHuman');
    expect(opponentTypeOfHumans(['Guest-1', 'Guest-2'], sOf)).toEqual({ type: 'avgHuman', tableS: 50 });
    expect(opponentTypeOfHumans([], sOf)).toEqual({ type: 'ai', tableS: null });
    expect(opponentTypeOfHumans(['Delta'], () => null)).toEqual({ type: 'avgHuman', tableS: null });
  });
  it('the live index reads the site cache; a name not in the records is an average player', () => {
    const live = livePlayerPrIndex();
    expect(live).not.toBeNull();
    expect(live!.pool).toBeGreaterThan(0);
    expect(liveTableS(['Zz-invented-guest-0001'])).toBe(UNKNOWN_PLAYER_PR);
  });
});

describe('wiring', () => {
  const player = (id: string, name: string, isBot: boolean): Player => ({ id, name, role: null, team: null, status: 'active', isBot } as unknown as Player);
  it('a site room: the bots switch to the profile of the humans’ table S (only human names are looked up)', () => {
    const players: Record<string, Player> = {
      h1: player('h1', 'Delta', false), h2: player('h2', 'Ember', false),
      b1: player('b1', 'AI', true), b2: player('b2', 'AI', true),
    };
    const room = { id: 'r', players } as unknown as Room;
    expect(humanNamesOfRoom(room)).toEqual(['Delta', 'Ember']);
    const idx = buildPlayerPrIndex(rating())!;
    const seen: string[][] = [];
    const server = new GameServer(new SocketIOServer(createServer())) as unknown as {
      botAgents: Map<string, AvalonAgent>; tableStrengthOf: (n: readonly string[]) => number | null; applyOpponentProfile(r: Room): string;
    };
    server.tableStrengthOf = (names) => { seen.push([...names]); return tableStrengthOf(names, idx).s; };
    server.botAgents.set('b1', new HeuristicAgent('b1'));
    server.botAgents.set('b2', new HeuristicAgent('b2'));
    expect(server.applyOpponentProfile(room)).toBe('strongHuman');
    expect(seen).toEqual([['Delta', 'Ember']]);
    players.h1 = player('h1', 'Quartz', false);
    players.h2 = player('h2', 'Birch', false);
    expect(server.applyOpponentProfile(room)).toBe('weakHuman');
  });
  it('the practice site (/補位, nightly): built-in robots and 百科AI are not opponents; --opponent wins', () => {
    const users = [
      { name: 'Delta', is_robot: false }, { name: 'Ember', is_robot: false },
      { name: '百科AI_21', is_robot: false }, { name: '機器人1', is_robot: true },
    ];
    expect(signageHumanNames(users)).toEqual(['Delta', 'Ember']);
    const idx = buildPlayerPrIndex(rating())!;
    const sOf = (names: readonly string[]) => tableStrengthOf(names, idx).s;
    expect(signageOpponent(users, null, sOf)).toEqual({ type: 'strongHuman', tableS: 80 });
    expect(signageOpponent(users, 'weakHuman', sOf)).toEqual({ type: 'weakHuman', tableS: null });
    expect(signageOpponent([{ name: '機器人1', is_robot: true }], null, sOf).type).toBe('ai');
  });
});
