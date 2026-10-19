/**
 * 複合篩選的子句、玩家條件（PR）、隱藏、排行的近期出賽規則、分享連結（Edward 2026-10-14「我希望所有數據都有
 * 可以複合篩選的功能 … 線瓦/面瓦、娛樂局、排除某些條件玩家（角色理論勝率/位置理論勝率/整體理論勝率 大於 小於
 * PR XX）」；r9 設計 §3）。小型合成資料集，名字全是虛構的。
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  PRESETS,
  applyFilter,
  canonicalFilterKey,
  computeStats,
  decodeFilter,
  decodeGamesDataset,
  effectiveAsOf,
  encodeFilter,
  GamesDatasetError,
  percentileRank,
  presetFilter,
  resolvePlayerName,
  sanitizeFilter,
  selectPlayers,
  sortByKey,
  trioOrder,
  type Clause,
  type GameFilter,
  type PlayerRow,
  type PlayerSelector,
} from '@avalon/shared/stats';
import { TEN, TEST_LEADERBOARD_CONFIG, makeDataset, type GameSpec } from './datasetBuilder';

const AS_OF = '2026-10-14';
const NINE_AND_QUILL = [...TEN.slice(0, 9), 'Quill'];

// 配置 123456：1 刺客、2 莫甘娜、3 莫德雷德、4 奧伯倫、5 派西維爾、6 梅林、7..10 忠臣（虛構甲..癸 依座位）。
const SPECS: GameSpec[] = [
  { id: 'a', cat: '線瓦', date: '2026-01-05', slot: 1, note: ['season:S2'], outcome: '三紅', claims: '71x', captains: '12' },
  { id: 'b', cat: '面瓦', date: '2026-01-10', slot: 5, note: ['venue:古亭', 'flag:incident'], outcome: '三藍活', kill: '7', claims: '71o', captains: '7?' },
  { id: 'c', cat: '娛樂', outcome: '三藍死', kill: '6', names: [...TEN.slice(0, 9), null], claims: '71-' },
  { id: 'd', cat: '', date: '2025-12-31', outcome: '', config: '654321', names: [TEN[0], null, null, null, null, null, null, null, null, null] },
  {
    id: 'e', cat: '其他', date: '2026-02-01', outcome: '三藍活', names: NINE_AND_QUILL,
    missions: 'ooo|oooo|oooo|ooxo|', rounds: 'BBBB-', state: '藍藍藍', lakes: '7126--',
  },
];
const decoded = decodeGamesDataset(makeDataset(SPECS));

function ids(...clauses: Clause[]): string[] {
  return applyFilter(decoded, { asOf: AS_OF }, { v: 1, clauses }).games.map((g) => g.id);
}

describe('game clauses', () => {
  it('category (未分類 = blank, 其他 = anything else), source, gameId', () => {
    expect(ids({ kind: 'category', in: ['線瓦'] })).toEqual(['a']);
    expect(ids({ kind: 'category', in: ['未分類'] })).toEqual(['d']);
    expect(ids({ kind: 'category', in: ['其他', '面瓦'] })).toEqual(['b', 'e']);
    expect(ids({ kind: 'category', in: ['娛樂'], not: true })).toEqual(['a', 'b', 'd', 'e']); // 排除娛樂局
    expect(ids({ kind: 'source', in: ['discord'] })).toEqual([]);
    expect(ids({ kind: 'gameId', in: ['c', 'e'] })).toEqual(['c', 'e']);
  });

  it('date range (both ends included), undated games, weekday, 場次', () => {
    expect(ids({ kind: 'date', from: '2026-01-01', to: '2026-01-31' })).toEqual(['a', 'b']);
    expect(ids({ kind: 'date', from: '2026-01-01', to: '2026-01-31', undated: 'include' })).toEqual(['a', 'b', 'c']);
    expect(ids({ kind: 'date', to: '2025-12-31' })).toEqual(['d']);
    expect(ids({ kind: 'weekday', in: [6, 7] })).toEqual(['b', 'e']); // 2026-01-10 Sat, 2026-02-01 Sun
    expect(ids({ kind: 'sessionIndex', min: 2 })).toEqual(['b']);
    expect(ids({ kind: 'sessionIndex', max: 1 })).toEqual(['a']); // no 場次 = no match
  });

  it('note tags: season, venue, flags, none', () => {
    expect(ids({ kind: 'season', in: ['S2'] })).toEqual(['a']);
    expect(ids({ kind: 'season', in: ['none'] })).toEqual(['b', 'c', 'd', 'e']);
    expect(ids({ kind: 'venue', in: ['古亭'] })).toEqual(['b']);
    expect(ids({ kind: 'noteFlag', any: ['incident', 'badGame'] })).toEqual(['b']);
  });

  it('names written, outcome, final winner', () => {
    expect(ids({ kind: 'namedSeats', min: 10 })).toEqual(['a', 'b', 'e']);
    expect(ids({ kind: 'namedSeats', max: 9 })).toEqual(['c', 'd']);
    expect(ids({ kind: 'outcome', in: ['other'] })).toEqual(['d']);
    expect(ids({ kind: 'outcome', in: ['三藍死', '三藍活'] })).toEqual(['b', 'c', 'e']);
    expect(ids({ kind: 'finalWinner', is: 'red' })).toEqual(['a', 'c']); // 三紅 + 三藍死
    expect(ids({ kind: 'finalWinner', is: 'blue' })).toEqual(['b', 'e']);
  });

  it('missions, 局勢, 1-1, lakes, claims', () => {
    expect(ids({ kind: 'missionCount', in: [4] })).toEqual(['e']);
    expect(ids({ kind: 'mission', round: 2, result: 'pass' })).toEqual(['e']);
    expect(ids({ kind: 'mission', round: 4, minFails: 1 })).toEqual(['e']); // one fail on the 4th: still "fail"
    expect(ids({ kind: 'gameState', in: ['藍藍藍'] })).toEqual(['e']);
    expect(ids({ kind: 'firstTeam', hasMerlin: true })).toEqual(['d']); // 654321: seat 1 is 梅林
    expect(ids({ kind: 'firstTeam', redCount: [1], hasPercival: true })).toEqual(['a', 'b', 'c', 'e']);
    expect(ids({ kind: 'lakeCount', in: [2] })).toEqual(['e']);
    expect(ids({ kind: 'lake', index: 1, targetSide: 'blue' })).toEqual(['d']);
    expect(ids({ kind: 'lake', index: 1, holderRole: ['忠臣'], targetRole: ['刺客'] })).toEqual(['a', 'b', 'c', 'e']);
    expect(ids({ kind: 'lake', index: 1, claim: ['red'] })).toEqual(['a']);
    expect(ids({ kind: 'lake', index: 1, claim: ['none'] })).toEqual(['c']);
    expect(ids({ kind: 'lake', index: 2, holderSide: 'red' })).toEqual(['e']); // 2>6: 莫甘娜 holds
  });

  it('assassination target, role seats, 派梅娜 order, captains', () => {
    expect(ids({ kind: 'assassination', target: ['忠臣'] })).toEqual(['b']);
    expect(ids({ kind: 'assassination', target: ['梅林'] })).toEqual(['c']);
    expect(ids({ kind: 'assassination', target: ['none'] })).toEqual(['e']);
    expect(ids({ kind: 'roleSeat', role: '梅林', seats: [1] })).toEqual(['d']);
    expect(ids({ kind: 'roleSeat', role: '忠臣', seats: [10] })).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(trioOrder(decoded.games[0])).toBe('娜派梅');
    expect(ids({ kind: 'trioOrder', in: ['梅派娜'] })).toEqual(['d']);
    expect(ids({ kind: 'captain', round: 1, side: 'red' })).toEqual(['a']);
    expect(ids({ kind: 'captain', round: 2, side: 'blue' })).toEqual(['b']); // "?" (not a seat) counts as 忠臣
  });

  it('players in the game: role, side, seat, result, not; any; pairs', () => {
    const merlin = TEN[5]; // seat 6
    expect(ids({ kind: 'withPlayer', player: merlin })).toEqual(['a', 'b', 'c', 'e']);
    expect(ids({ kind: 'withPlayer', player: merlin, role: ['梅林'], result: 'win' })).toEqual(['b', 'e']); // final: 三藍活 only
    expect(ids({ kind: 'withPlayer', player: merlin, result: 'win', resultRule: 'mission' })).toEqual(['b', 'c', 'e']);
    expect(ids({ kind: 'withPlayer', player: merlin, not: true })).toEqual(['d']);
    expect(ids({ kind: 'withPlayer', player: TEN[0], seat: [1], side: 'blue' })).toEqual(['d']); // 梅林 in d
    expect(ids({ kind: 'withPlayer', player: 'QUILL' })).toEqual(['e']); // case / width do not matter
    expect(ids({ kind: 'withAnyPlayer', players: ['Quill', TEN[9]] })).toEqual(['a', 'b', 'e']);
    expect(ids({ kind: 'withPlayers', players: [TEN[0], merlin], relation: 'together' })).toEqual(['a', 'b', 'c', 'e']);
    expect(ids({ kind: 'withPlayers', players: [TEN[0], merlin], relation: 'sameTeam' })).toEqual([]);
    expect(ids({ kind: 'withPlayers', players: [TEN[0], merlin], relation: 'opposingTeams' })).toEqual(['a', 'b', 'c', 'e']);
    expect(ids({ kind: 'withPlayers', players: [TEN[6], TEN[9]], relation: 'sameTeam' })).toEqual(['a', 'b']);
  });

  it('clauses are ANDed; an unknown player disables the clause instead of emptying the result', () => {
    expect(ids({ kind: 'category', in: ['線瓦', '面瓦'] }, { kind: 'finalWinner', is: 'red' })).toEqual(['a']);
    const app = applyFilter(decoded, { asOf: AS_OF }, { v: 1, clauses: [{ kind: 'withPlayer', player: '沒有這個人' }] });
    expect(app.games).toHaveLength(5);
    expect(app.meta.unresolvedNames).toEqual(['沒有這個人']);
    expect(app.meta.clauses[0].inactive).toBe('unresolved player name');
    expect(app.meta.clauses[0].unresolved).toEqual(['沒有這個人']);
  });

  it('player names resolve by key and through the alias table', () => {
    expect(resolvePlayerName('quill', decoded.dataset.players)).toBe('Quill');
    expect(resolvePlayerName('舊名字', decoded.dataset.players, { 舊名字: 'Quill' })).toBe('Quill');
    expect(resolvePlayerName('Qui', decoded.dataset.players)).toBeUndefined(); // never a partial name
  });
});

describe('excluding players', () => {
  it('by name: drop their games or only hide them; everyone but; incomplete games', () => {
    const drop = applyFilter(decoded, { asOf: AS_OF }, { v: 1, clauses: [{ kind: 'excludePlayers', scope: 'dropGames', who: { by: 'names', names: ['quill'] } }] });
    expect(drop.games.map((g) => g.id)).toEqual(['a', 'b', 'c', 'd']);
    expect([...drop.dropped]).toEqual(['Quill']);
    const hide = applyFilter(decoded, { asOf: AS_OF }, { v: 1, clauses: [{ kind: 'excludePlayers', scope: 'hideFromLists', who: { by: 'names', names: ['Quill'] } }] });
    expect(hide.games).toHaveLength(5);
    expect([...hide.hidden]).toEqual(['Quill']);
    const only = applyFilter(decoded, { asOf: AS_OF }, { v: 1, clauses: [{ kind: 'excludePlayers', scope: 'hideFromLists', who: { by: 'names', names: [TEN[0]], invert: true } }] });
    expect(only.hidden.has(TEN[0])).toBe(false);
    expect(only.hidden.size).toBe(decoded.dataset.players.length - 1);
    const strict = applyFilter(decoded, { asOf: AS_OF }, {
      v: 1, clauses: [{ kind: 'excludePlayers', scope: 'dropGames', dropIncompleteGames: true, who: { by: 'names', names: ['Quill'] } }],
    });
    expect(strict.games.map((g) => g.id)).toEqual(['a', 'b']);
  });

  function row(name: string, roleTheory: number, fullWindows: boolean, totalGames = 120): PlayerRow {
    const window = { window: 0, games: totalGames, roleTheory, positionTheory: roleTheory, finalWinRate: 50, from: '', to: '', sparseRoles: 0, sparseSeats: 0 };
    return {
      name, totalGames, finalWinRate: 50, winRate: 50, excessWinRate: 0, rawBlueThreeBlue: 40, merlinSurvivalRate: 50,
      roleFinalWinRates: {}, rawRoleGames: {}, firstPlayed: '2025-01-01', lastPlayed: '2026-10-01',
      theory: { roleWindows: { roleTheory, fullWindows, games: 100, sparseRoles: 0, from: '', to: '', roles: {} }, last100: window, career: window },
    } as unknown as PlayerRow;
  }
  const set = {
    rows: [row('p1', 50, true), row('p2', 45, true, 90), row('p3', 45, true, 90), row('p4', 40, true, 90), row('p5', 60, false, 150)],
    ctx: { config: decoded.config, asOf: AS_OF, timelines: new Map() },
  };
  const pick = (who: Partial<PlayerSelector>): string[] =>
    [...selectPlayers({ by: 'metric', metric: 'roleTheory', op: 'gt', ...who } as PlayerSelector, set, []).selected].sort();

  it('percentile rank: (below + half the ties) / n among the eligible, one decimal', () => {
    expect(percentileRank(50, [50, 45, 45, 40])).toBe(87.5);
    expect(percentileRank(45, [50, 45, 45, 40])).toBe(50);
    expect(percentileRank(40, [50, 45, 45, 40])).toBe(12.5);
    expect(percentileRank(1, [1, 2, 3])).toBe(16.7);
    expect(percentileRank(3, [1, 2, 3])).toBe(83.3);
    expect(percentileRank(7, [7])).toBe(50);
  });

  it('by metric: value or PR, ineligible kept or selected, invert, minGames', () => {
    expect(pick({ pr: 80 })).toEqual(['p1']); // p5 的角色視窗未滿，不參與比較。
    expect(pick({ op: 'ge', pr: 50 })).toEqual(['p1', 'p2', 'p3']); // 同分者一起選取。
    expect(pick({ op: 'lt', value: 45 })).toEqual(['p4']);
    expect(pick({ pr: 80, invert: true })).toEqual(['p2', 'p3', 'p4']);
    expect(pick({ pr: 80, ineligible: 'select' })).toEqual(['p1', 'p5']);
    expect(pick({ op: 'ge', pr: 75, minGames: 100 })).toEqual([]); // 只有 p1 合格，PR 為 50；p5 仍未打滿角色窗。
    expect(pick({ op: 'ge', pr: 50, minGames: 100 })).toEqual(['p1']);
    const result = selectPlayers({ by: 'metric', metric: 'roleTheory', op: 'gt' } as PlayerSelector, set, []);
    expect(result.problem).toBe('no value or pr to compare with');
  });

  it('owner example: 線瓦 only, without the games of role theory PR > 90 players (judged on all games)', () => {
    const fixture = path.resolve(__dirname, '..', 'fixtures', 'stats_parity', 'invented');
    const inv = decodeGamesDataset(JSON.parse(fs.readFileSync(path.join(fixture, 'games.json'), 'utf-8')));
    const filter: GameFilter = {
      v: 1,
      clauses: [
        { kind: 'category', in: ['線瓦'] },
        { kind: 'excludePlayers', scope: 'dropGames', who: { by: 'metric', metric: 'roleTheory', op: 'gt', pr: 90 } },
      ],
    };
    const result = computeStats(inv, { asOf: '2026-02-28' }, filter);
    // 以全部對局的快取數字判斷；角色視窗全滿才有資格。
    const everyone = computeStats(inv, { asOf: '2026-02-28' }, null).players.players;
    const full = everyone.filter((p) => p.theory.roleWindows.fullWindows).map((p) => p.theory.roleWindows.roleTheory);
    const top = everyone.filter((p) => p.theory.roleWindows.fullWindows && percentileRank(p.theory.roleWindows.roleTheory, full) > 90);
    expect(top.length).toBeGreaterThan(0);
    expect(result.meta.clauses[1]).toMatchObject({ kind: 'excludePlayers', evaluatedOn: 'unfiltered', selected: top.length, eligible: full.length });
    const dropped = applyFilter(inv, { asOf: '2026-02-28' }, filter).dropped;
    for (const g of applyFilter(inv, { asOf: '2026-02-28' }, filter).games) {
      expect(g.category).toBe('線瓦');
      expect(g.seatPlayers.some((n) => n !== null && dropped.has(n))).toBe(false);
    }
    expect(result.players.players.some((p) => dropped.has(p.name))).toBe(false);
  });
});

describe('hiding players never changes anyone else', () => {
  const fixture = path.resolve(__dirname, '..', 'fixtures', 'stats_parity', 'invented');
  const inv = decodeGamesDataset(JSON.parse(fs.readFileSync(path.join(fixture, 'games.json'), 'utf-8')));
  const base = computeStats(inv, { asOf: '2026-02-28' }, null);
  const main = base.leaderboard.boards.find((b) => b.id === 'main');
  const top = main?.rows[0].name as string;
  const hidden = computeStats(inv, { asOf: '2026-02-28' }, {
    v: 1, clauses: [{ kind: 'excludePlayers', scope: 'hideFromLists', who: { by: 'names', names: [top] } }],
  });

  it('lists lose the hidden player, keep everyone else as they were, and are refilled', () => {
    expect(hidden.meta.hiddenPlayers).toBe(1);
    expect(hidden.overview.totalPlayers).toBe(base.overview.totalPlayers);
    expect(hidden.players.players.map((p) => p.name)).toEqual(base.players.players.map((p) => p.name).filter((n) => n !== top));
    for (const p of hidden.players.players) expect(p).toEqual(base.players.players.find((q) => q.name === p.name));
    expect(Object.keys(hidden.playerDetails)).not.toContain(top);
    const strip = <T extends { rank?: number }>(rows: T[]): Array<Omit<T, 'rank'>> => rows.map(({ rank: _rank, ...r }) => r);
    for (const board of hidden.leaderboard.boards) {
      const before = base.leaderboard.boards.find((b) => b.id === board.id);
      expect(board.rows.some((r) => r.name === top)).toBe(false);
      expect(board.rows.map((r) => r.rank)).toEqual(board.rows.map((_, i) => i + 1));
      if (board.id !== 'roleTitles' && before) {
        const kept = strip(before.rows).filter((r) => r.name !== top);
        expect(strip(board.rows).slice(0, kept.length)).toEqual(kept);
        expect(board.rows.length).toBeGreaterThanOrEqual(Math.min(TEST_LEADERBOARD_CONFIG.topN, kept.length));
      }
    }
    // 總覽排名移除隱藏玩家後依序補滿十名。
    const ranking = sortByKey(
      base.players.players.filter((p) => p.theory.roleWindows.fullWindows),
      (p) => [-p.theory.roleWindows.roleTheory, -p.totalGames, p.name],
    ).map((p) => p.name);
    expect(hidden.overview.topPlayersByRoleTheory.map((r) => r.name)).toEqual(ranking.filter((n) => n !== top).slice(0, 10));
    expect(base.overview.topPlayersByRoleTheory.map((r) => r.name)).toEqual(ranking.slice(0, 10));
    expect(hidden.overview.roleFinalWinRates).toEqual(base.overview.roleFinalWinRates);
  });
});

describe('as-of day and who counts as active on the boards', () => {
  const fixture = path.resolve(__dirname, '..', 'fixtures', 'stats_parity', 'invented');
  const inv = decodeGamesDataset(JSON.parse(fs.readFileSync(path.join(fixture, 'games.json'), 'utf-8')));

  it('a date range ending in the past moves the as-of day there', () => {
    expect(effectiveAsOf({ v: 1, clauses: [{ kind: 'date', to: '2024-12-31' }] }, '2026-02-28')).toBe('2024-12-31');
    expect(effectiveAsOf({ v: 1, clauses: [{ kind: 'date', to: '2024-12-31', not: true }] }, '2026-02-28')).toBe('2026-02-28');
    expect(effectiveAsOf({ v: 1, clauses: [], options: { asOf: '2025-06-30' } }, '2026-02-28')).toBe('2025-06-30');
    const result = computeStats(inv, { asOf: '2026-02-28' }, { v: 1, clauses: [{ kind: 'date', from: '2024-01-01', to: '2024-12-31' }] });
    expect(result.leaderboard.asOf).toBe('2024-12-31');
    expect(result.meta.asOf).toBe('2024-12-31');
  });

  it("activity 'none' ranks everyone with games and has no newcomers board; 'all' judges activity on all games", () => {
    const offline: Clause = { kind: 'category', in: ['面瓦'] };
    const filtered = computeStats(inv, { asOf: '2026-02-28' }, { v: 1, clauses: [offline] });
    const all = computeStats(inv, { asOf: '2026-02-28' }, { v: 1, clauses: [offline], options: { activity: 'all' } });
    const none = computeStats(inv, { asOf: '2026-02-28' }, { v: 1, clauses: [offline], options: { activity: 'none' } });
    const rows = (r: typeof filtered, id: string): number => r.leaderboard.boards.find((b) => b.id === id)?.rows.length ?? 0;
    expect(rows(none, 'position')).toBeGreaterThanOrEqual(rows(all, 'position'));
    expect(rows(all, 'position')).toBeGreaterThanOrEqual(rows(filtered, 'position'));
    expect(none.leaderboard.boards.some((b) => b.id === 'newcomers')).toBe(false);
    expect(all.meta.activity).toBe('all');
    // 活躍規則只決定上榜資格，不改同一位玩家的位置理論數字。
    const position = (r: typeof filtered): Map<string, unknown> =>
      new Map((r.leaderboard.boards.find((b) => b.id === 'position')?.rows ?? []).map((x) => [x.name, x.value]));
    for (const [name, value] of position(filtered)) expect(position(none).get(name)).toBe(value);
  });
});

describe('dataset checks', () => {
  const ok = makeDataset(SPECS);
  it('refuses another format, version, batch or rule set', () => {
    expect(() => decodeGamesDataset({ ...ok, format: 'x' })).toThrow(GamesDatasetError);
    expect(() => decodeGamesDataset({ ...ok, version: 999 })).toThrow(GamesDatasetError);
    expect(() => decodeGamesDataset(ok, 'another0key00000')).toThrow(/does not match/);
    expect(() => decodeGamesDataset({ ...ok, constants: { ...ok.constants, roleDealTenths: { ...ok.constants.roleDealTenths, 忠臣: 3 } } })).toThrow(/roleDealTenths/);
    expect(decodeGamesDataset(ok, ok.key).games).toHaveLength(5);
  });

  it('timeline dates are fixed over all the games', () => {
    const d = decodeGamesDataset(makeDataset([{ date: '' }, { date: '2026-01-02' }, { date: '' }, { date: '2025-12-01' }, { date: '' }]));
    expect(d.games.map((g) => g.timelineDate)).toEqual(['', '2026-01-02', '2026-01-02', '2025-12-01', '2025-12-01']);
  });
});

describe('filter links, validation, presets', () => {
  const filter: GameFilter = {
    v: 1,
    clauses: [
      { kind: 'category', in: ['線瓦'] },
      { kind: 'withPlayer', player: '測試😀', role: ['梅林'] },
      { kind: 'excludePlayers', scope: 'dropGames', who: { by: 'metric', metric: 'positionTheory', op: 'lt', pr: 10 } },
    ],
    options: { activity: 'all' },
  };

  it('encodes to a URL-safe string and back', () => {
    const text = encodeFilter(filter);
    expect(text).toMatch(/^1\.[A-Za-z0-9_-]+$/);
    expect(decodeFilter(text)).toEqual({ filter, warnings: [] });
    expect(decodeFilter('2.abc').filter).toBeNull();
    expect(decodeFilter('1.!!!').filter).toBeNull();
  });

  it('drops unknown or malformed clauses and says which', () => {
    const { filter: clean, warnings } = sanitizeFilter({
      v: 1,
      clauses: [
        { kind: 'category', in: ['線瓦'], extra: 'dropped' },
        { kind: 'teleport' },
        { kind: 'mission', round: 9 },
        { kind: 'excludePlayers', scope: 'dropGames', who: { by: 'metric', metric: 'roleTheory', op: 'gt', value: 50, pr: 90 } },
        { kind: 'roleSeat', role: '梅林', seats: [11] },
        { kind: 'date', from: '2024/01/01' },
      ],
      options: { activity: 'sometimes', asOf: '2025-01-01' },
    });
    expect(clean).toEqual({ v: 1, clauses: [{ kind: 'category', in: ['線瓦'] }], options: { asOf: '2025-01-01' } });
    expect(warnings).toEqual([
      'clauses[1]: unknown kind', 'clauses[2].round', 'clauses[3]: excludePlayers.who: give value or pr',
      'clauses[4].seats', 'clauses[5].from',
    ]);
    expect(sanitizeFilter({ v: 2, clauses: [] }).filter).toBeNull();
  });

  it('canonical key ignores clause and list order and default options', () => {
    const a: GameFilter = { v: 1, clauses: [{ kind: 'category', in: ['面瓦', '線瓦'] }, { kind: 'namedSeats', min: 10 }] };
    const b: GameFilter = { v: 1, clauses: [{ kind: 'namedSeats', min: 10 }, { kind: 'category', in: ['線瓦', '面瓦'] }], options: { activity: 'filtered', asOf: 'auto' } };
    expect(canonicalFilterKey(a)).toBe(canonicalFilterKey(b));
    expect(canonicalFilterKey({ v: 1, clauses: [] })).toBe('');
    expect(canonicalFilterKey(null)).toBe('');
    expect(canonicalFilterKey({ ...a, options: { activity: 'none' } })).not.toBe(canonicalFilterKey(a));
  });

  it('presets', () => {
    expect(PRESETS.map((p) => p.id)).toEqual(['online', 'offline', 'noCasual', 'fullNames', 'lastYear']);
    expect(presetFilter('lastYear', '2026-10-14')).toEqual({ v: 1, clauses: [{ kind: 'date', from: '2025-10-15', to: '2026-10-14' }] });
    expect(presetFilter('noCasual', AS_OF)).toEqual({ v: 1, clauses: [{ kind: 'category', in: ['娛樂'], not: true }] });
    expect(presetFilter('nope', AS_OF)).toBeNull();
    for (const p of PRESETS) expect(sanitizeFilter(p.build(AS_OF)).warnings).toEqual([]);
  });
});
