import { describe, expect, it } from 'vitest';
import { fitRatings, invert, wilson, pairedMean, ELO_BASE, ELO_SCALE } from '../rating';
import { buildLeaderboard, localBotMask, localReport, parseSizes, tournamentSeating, type LocalPair } from '../report';
import { seededRandom } from '../../ai/benchmark/agreement';
import type { TableResult, SeatResult } from '../table';

/** 合成對局：10 人、4 紅 6 藍；紅方勝率照真模型 logit = c + mean(red) − mean(blue)。 */
function synthTables(n: number, skills: Record<string, { red: number; blue: number }>, c = 0.2, seed = 'synth'): TableResult[] {
  const ids = Object.keys(skills);
  const rnd = seededRandom(seed);
  const out: TableResult[] = [];
  for (let i = 0; i < n; i++) {
    const seats: SeatResult[] = [];
    for (let s = 0; s < 10; s++) {
      const id = ids[Math.floor(rnd() * ids.length)];
      seats.push({ entrant: id, role: s < 4 ? 'assassin' : 'loyal', team: s < 4 ? 'evil' : 'good', won: false });
    }
    const red = seats.filter((x) => x.team === 'evil');
    const blue = seats.filter((x) => x.team === 'good');
    const eta = c + red.reduce((a, x) => a + skills[x.entrant].red, 0) / red.length - blue.reduce((a, x) => a + skills[x.entrant].blue, 0) / blue.length;
    const p = 1 / (1 + Math.exp(-eta));
    const winner = rnd() < p ? 'evil' : 'good';
    for (const x of seats) x.won = x.team === winner;
    out.push({ gameSeed: `${seed}|${i}`, playerCount: 10, winner, outcome: winner === 'evil' ? 'threeRed' : 'threeBlue', seats, fingerprint: '' });
  }
  return out;
}

describe('rating fit', () => {
  it('inverts a small matrix', () => {
    const inv = invert([[4, 1], [1, 3]]);
    expect(inv[0][0]).toBeCloseTo(3 / 11, 10);
    expect(inv[0][1]).toBeCloseTo(-1 / 11, 10);
  });

  it('recovers per-side skills with intervals that cover the truth', () => {
    const truth = { baike: { red: 0, blue: 0 }, strongRed: { red: 1.0, blue: 0 }, strongBlue: { red: 0, blue: 0.8 }, weak: { red: -0.6, blue: -0.6 } };
    const tables = synthTables(6000, truth);
    const fit = fitRatings(tables, Object.keys(truth), 'baike');
    expect(fit.converged).toBe(true);
    for (const r of fit.ratings) {
      const t = truth[r.id as keyof typeof truth];
      for (const [side, val] of [['red', t.red], ['blue', t.blue]] as const) {
        const elo = ELO_BASE + ELO_SCALE * val;
        expect(r[side].low).toBeLessThanOrEqual(elo + 1);
        expect(r[side].high).toBeGreaterThanOrEqual(elo - 1);
      }
    }
    const byId = Object.fromEntries(fit.ratings.map((r) => [r.id, r]));
    expect(byId.baike.overall.rating).toBe(1500);
    expect(byId.strongRed.red.rating).toBeGreaterThan(byId.strongBlue.red.rating);
    expect(byId.strongBlue.blue.rating).toBeGreaterThan(byId.strongRed.blue.rating);
    expect(byId.weak.overall.rating).toBeLessThan(1500);
  });

  it('is independent of game order', () => {
    const truth = { baike: { red: 0, blue: 0 }, x: { red: 0.5, blue: -0.2 } };
    const tables = synthTables(800, truth);
    const a = fitRatings(tables, ['baike', 'x'], 'baike').ratings[1];
    const b = fitRatings([...tables].reverse(), ['baike', 'x'], 'baike').ratings[1];
    expect(a.overall.rating).toBeCloseTo(b.overall.rating, 6);
  });
});

describe('small stats', () => {
  it('wilson and paired means', () => {
    const w = wilson(50, 100);
    expect(w.rate).toBe(0.5);
    expect(w.low).toBeCloseTo(0.404, 2);
    expect(wilson(0, 0).n).toBe(0);
    expect(pairedMean([1, -1, 0, 0]).mean).toBe(0);
  });
});

describe('seating and reports', () => {
  it('seat masks and tournament seating are deterministic', () => {
    expect(localBotMask('s', 3, 10)).toEqual(localBotMask('s', 3, 10));
    expect(localBotMask('s', 3, 10).filter(Boolean)).toHaveLength(5);
    expect(localBotMask('s', 3, 7, 2).filter(Boolean)).toHaveLength(2);
    const a = tournamentSeating('s', 9, ['a', 'b', 'c'], [5, 10]);
    expect(a).toEqual(tournamentSeating('s', 9, ['a', 'b', 'c'], [5, 10]));
    expect(a.seats).toHaveLength(a.playerCount);
    expect(parseSizes('5-7')).toEqual([5, 6, 7]);
    expect(() => parseSizes('4-10')).toThrow();
  });

  it('local report pairs bot tables with their control tables', () => {
    const seat = (entrant: string, role: string, team: 'good' | 'evil', winner: 'good' | 'evil', hit?: boolean): SeatResult => {
      const s: SeatResult = { entrant, role, team, won: team === winner };
      if (hit !== undefined) s.assassinHit = hit;
      return s;
    };
    const table = (winner: 'good' | 'evil', bot: boolean, hit?: boolean): TableResult => ({
      gameSeed: 'g', playerCount: 5, winner, outcome: winner === 'evil' ? (hit ? 'merlinKilled' : 'threeRed') : 'threeBlue', fingerprint: '',
      seats: [
        seat(bot ? 'me' : 'baike', 'assassin', 'evil', winner, hit),
        seat('baike', 'morgana', 'evil', winner),
        seat(bot ? 'me' : 'baike', 'merlin', 'good', winner),
        seat('baike', 'percival', 'good', winner),
        seat('baike', 'loyal', 'good', winner),
      ],
    });
    const pairs: LocalPair[] = [
      { bot: table('evil', true, true), control: table('good', false, false) },
      { bot: table('good', true, false), control: table('good', false, false) },
    ];
    const r = localReport(pairs, 'me');
    expect(r.sides.evil.games).toBe(2);
    expect(r.sides.evil.bot.rate).toBe(0.5);
    expect(r.sides.evil.control.rate).toBe(0);
    expect(r.sides.evil.diff.mean).toBe(0.5);
    expect(r.roles.merlin.bot.rate).toBe(0.5);
    expect(r.assassin.bot.k).toBe(1);
    expect(r.assassin.bot.n).toBe(2);
    expect(r.outcomes.bot.merlinKilled).toBe(0.5);
  });

  it('leaderboard ranks bots, keeps the reference at 1500 and publishes authors only for community bots', () => {
    const truth = { baike: { red: 0, blue: 0 }, 'example-x': { red: 0.6, blue: 0.6 }, alpha: { red: -0.5, blue: -0.5 } };
    const tables = synthTables(1500, truth);
    const profile = { schema: 1, name: 'Alpha', author: 'octocat', style: 's', overrides: { goodCleanVote: 0.5 } };
    const board = buildLeaderboard({
      bots: [
        { id: 'baike', source: 'reference', profile: null },
        { id: 'example-x', source: 'example', profile: { ...profile, name: 'X', author: 'avalonpediatw' } },
        { id: 'alpha', source: 'community', profile, title: '騎士' },
      ],
      tables, seed: 's', sizes: [10], generatedAt: '2026-11-26T00:00:00.000Z',
    });
    expect(board.bots.map((b) => b.id)).toEqual(['example-x', 'baike', 'alpha']);
    expect(board.bots.map((b) => b.rank)).toEqual([1, 2, 3]);
    const byId = Object.fromEntries(board.bots.map((b) => [b.id, b]));
    expect(byId.baike.rating.overall.rating).toBe(1500);
    expect(byId.baike.name).toBe('百科AI');
    expect(byId['example-x'].author).toBeNull();
    expect(byId.alpha.author).toBe('octocat');
    expect(byId.alpha.title).toBe('騎士');
    expect(byId.alpha.knobs).toEqual(['goodCleanVote=0.5']);
    expect(byId.alpha.red.seats + byId.alpha.blue.seats).toBe(byId.alpha.seats);
    expect(board.knobCatalog.map((k) => k.key)).toContain('goodCleanVote');
    expect(board.knobCatalog.find((k) => k.key === 'goodCleanVote')?.max).toBe(0.9);
  });
});
