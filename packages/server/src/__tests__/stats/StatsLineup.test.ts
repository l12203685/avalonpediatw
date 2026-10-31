/**
 * 陣容強度（Edward 2026-10-31）：games_cache 第 3 版的 lineup 欄解碼、共用判斷 matchesLineup、複合篩選的 lineup 子句。
 * 小型合成資料集，名字全是虛構的。
 */
import { describe, expect, it } from 'vitest';
import {
  GAMES_DATASET_FIELDS_V2,
  applyFilter,
  countStrongSeats,
  decodeGamesDataset,
  decodeLineup,
  matchesLineup,
  sanitizeFilter,
  type LineupClause,
} from '@avalon/shared/stats';
import { makeDataset, type GameSpec } from './datasetBuilder';

// S 70.0：七個 PR ≥ 70，第 10 座暫定（PR 50）；S 52.0：三個 PR ≥ 70；沒評分。
const HIGH = [80, 75, 72, 71, 70, 70, 70, 60, 52, 50];
const MID = [90, 80, 70, 50, 45, 40, 40, 40, 35, 30];
const SPECS: GameSpec[] = [
  { id: 'high', date: '2026-10-01', lineup: [33, 700, HIGH, 1 << 9] },
  { id: 'mid', date: '2026-10-02', lineup: [33, 520, MID, 0] },
  { id: 'none', date: '2026-10-03' },
];
const decoded = decodeGamesDataset(makeDataset(SPECS));

function ids(clause: LineupClause): string[] {
  return applyFilter(decoded, { asOf: '2026-10-31' }, { v: 1, clauses: [clause] }).games.map((g) => g.id);
}

describe('lineup field', () => {
  it('decodes [pool, S×10, PRs, provisional bits]; [] is not scored', () => {
    const [high, mid, none] = decoded.games;
    expect(high.lineup).toEqual({ pool: 33, s: 70, prs: HIGH, prov: [...Array(9).fill(false), true], elos: null });
    expect(mid.lineup?.s).toBe(52);
    expect(none.lineup).toBeNull();
    expect(decodeLineup([])).toBeNull();
    expect(decodeLineup(undefined)).toBeNull();
  });

  it('a version 2 dataset (no lineup column) still reads, every lineup null', () => {
    const v3 = makeDataset(SPECS);
    const v2 = { ...v3, version: 2, fields: [...GAMES_DATASET_FIELDS_V2], games: v3.games.map((row) => row.slice(0, 18)) };
    const d = decodeGamesDataset(v2 as unknown as typeof v3);
    expect(d.games.map((g) => g.lineup)).toEqual([null, null, null]);
    expect(() => decodeGamesDataset({ ...v3, version: 2 })).toThrow(/fields/);
  });

  it('strong seats: PR at least X, provisional seats never count', () => {
    const high = decoded.games[0].lineup!;
    expect(countStrongSeats(high, 70)).toBe(7);
    expect(countStrongSeats(high, 50)).toBe(9); // seat 10 has 50 but is provisional
    expect(countStrongSeats(high, 0)).toBe(9);
  });
});

describe('matchesLineup', () => {
  const high = decoded.games[0].lineup;
  const mid = decoded.games[1].lineup;
  it('S, PR X with at least Y, and / or, unscored', () => {
    expect(matchesLineup(high, {})).toBe(true);
    expect(matchesLineup(null, {})).toBe(true); // no condition: no filter
    expect(matchesLineup(high, { sMin: 65 })).toBe(true);
    expect(matchesLineup(mid, { sMin: 65 })).toBe(false);
    expect(matchesLineup(mid, { strongPr: 70, strongCount: 3 })).toBe(true);
    expect(matchesLineup(mid, { strongPr: 70, strongCount: 4 })).toBe(false);
    expect(matchesLineup(mid, { sMin: 65, strongPr: 70, strongCount: 3 })).toBe(false); // and
    expect(matchesLineup(mid, { sMin: 65, strongPr: 70, strongCount: 3, combine: 'or' })).toBe(true);
    expect(matchesLineup(null, { sMin: 0 })).toBe(false);
    expect(matchesLineup(null, { sMin: 0, includeUnscored: true })).toBe(true);
    expect(matchesLineup(high, { strongPr: 70 })).toBe(true); // half a condition = off
  });
});

describe('lineup clause', () => {
  it('filters the games and can be negated', () => {
    expect(ids({ kind: 'lineup', sMin: 60 })).toEqual(['high']);
    expect(ids({ kind: 'lineup', strongPr: 70, strongCount: 3 })).toEqual(['high', 'mid']);
    expect(ids({ kind: 'lineup', sMin: 60, strongPr: 90, strongCount: 1, combine: 'or' })).toEqual(['high', 'mid']);
    expect(ids({ kind: 'lineup', sMin: 60, includeUnscored: true })).toEqual(['high', 'none']);
    expect(ids({ kind: 'lineup', sMin: 60, not: true })).toEqual(['mid', 'none']);
  });

  it('links keep only valid fields', () => {
    const { filter, warnings } = sanitizeFilter({
      v: 1,
      clauses: [
        { kind: 'lineup', sMin: 65, strongPr: 70, strongCount: 6, combine: 'or', includeUnscored: true },
        { kind: 'lineup', strongCount: 11 },
        { kind: 'lineup', combine: 'xor' },
      ],
    });
    expect(filter?.clauses).toEqual([{ kind: 'lineup', sMin: 65, strongPr: 70, strongCount: 6, combine: 'or', includeUnscored: true }]);
    expect(warnings).toEqual(['clauses[1].strongCount', 'clauses[2].combine']);
  });
});
