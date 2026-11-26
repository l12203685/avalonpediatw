import * as fs from 'fs';
import { describe, expect, it } from 'vitest';
import { buildKnightsFile, GENERATED_KNIGHTS_PATH, serializeKnightsFile } from '../knightsFile';
import {
  buildKnightRegistry, DEFAULT_KNIGHT_ID, KNIGHT_MIX_ID, knightBaseName, knightFallbackCounter, knightsForSeats,
  knightTuningOverrides, listKnights, listKnightSummaries, nextKnightSeatName, resolveKnightId,
} from '../knights';

describe('knights.generated.json', () => {
  it('matches community-bots/_knights/ (run `pnpm --filter @avalon/server knights:generate` after changing a knight)', () => {
    const { file, rejected } = buildKnightsFile();
    expect(rejected).toEqual([]);
    expect(fs.readFileSync(GENERATED_KNIGHTS_PATH, 'utf8')).toBe(serializeKnightsFile(file));
  });
});

describe('knight registry', () => {
  it('百科 first, then every official knight; ids and names unique; names without a seat serial', () => {
    const knights = listKnights();
    expect(knights[0]).toMatchObject({ id: DEFAULT_KNIGHT_ID, baseName: 'AI騎士_百科', profile: null });
    expect(knights.length).toBeGreaterThan(10);
    expect(new Set(knights.map((k) => k.id)).size).toBe(knights.length);
    expect(new Set(knights.map((k) => k.baseName.toLowerCase())).size).toBe(knights.length);
    for (const k of knights) {
      expect(k.baseName.startsWith('AI騎士_')).toBe(true);
      expect(k.baseName).not.toMatch(/_\d+$/);
    }
    expect(knights.find((k) => k.id === 'knight-ed-01')?.baseName).toBe('AI騎士_ED');
    const summaries = listKnightSummaries();
    expect(summaries.map((s) => s.id)).toEqual(knights.map((k) => k.id));
    expect(summaries.every((s) => typeof s.style === 'string' && s.style.length > 0)).toBe(true);
  });

  it('rejects profiles that fail the official check, duplicate ids and duplicate names', () => {
    const good = { schema: 1, name: 'AI騎士_甲_01', author: 'AI騎士團', official: true, style: '測試', overrides: { goodCleanVote: 0.5 } };
    const built = buildKnightRegistry({
      knights: [
        { id: 'knight-a-01', profile: good },
        { id: 'knight-a-01', profile: { ...good, name: 'AI騎士_乙_01' } },
        { id: 'knight-c-01', profile: { ...good, name: 'AI騎士_甲_02' } },
        { id: 'knight-d-01', profile: { ...good, name: 'AI騎士_丁_01', author: 'someone' } },
        { id: 'Bad Id', profile: { ...good, name: 'AI騎士_戊_01' } },
        { id: 'baike', profile: { ...good, name: 'AI騎士_己_01' } },
      ],
    });
    expect(built.knights.map((k) => k.id)).toEqual(['baike', 'knight-a-01']);
    expect(built.rejected).toEqual(['knight-a-01', 'knight-c-01', 'knight-d-01', 'Bad Id', 'baike']);
    expect(buildKnightRegistry(null).knights.map((k) => k.id)).toEqual(['baike']);
  });

  it('knightBaseName strips the serial only', () => {
    expect(knightBaseName('AI騎士_ED_01')).toBe('AI騎士_ED');
    expect(knightBaseName('AI騎士_百科')).toBe('AI騎士_百科');
    expect(knightBaseName(' AI騎士_C5_12 ')).toBe('AI騎士_C5');
  });
});

describe('resolveKnightId', () => {
  it('nothing sent → null (old behaviour); registry id → itself; anything else → 百科, counted', () => {
    const before = knightFallbackCounter.unknown;
    expect(resolveKnightId(undefined)).toBeNull();
    expect(resolveKnightId(null)).toBeNull();
    expect(resolveKnightId('')).toBeNull();
    expect(resolveKnightId('knight-ed-01')).toBe('knight-ed-01');
    expect(resolveKnightId('baike')).toBe('baike');
    expect(knightFallbackCounter.unknown).toBe(before);
    expect(resolveKnightId('no-such-knight')).toBe(DEFAULT_KNIGHT_ID);
    expect(resolveKnightId(42)).toBe(DEFAULT_KNIGHT_ID);
    expect(resolveKnightId(KNIGHT_MIX_ID)).toBe(DEFAULT_KNIGHT_ID);
    expect(knightFallbackCounter.unknown).toBe(before + 3);
    expect(resolveKnightId(KNIGHT_MIX_ID, { allowMix: true })).toBe(KNIGHT_MIX_ID);
  });
});

describe('knightTuningOverrides', () => {
  it('layers overrides → sides[team] → roles[role]; 百科 / unknown → nothing', () => {
    expect(knightTuningOverrides('knight-ed-01', 'assassin', 'evil')).toEqual({ redR1Teammate: false });
    expect(knightTuningOverrides('knight-ed-01', 'merlin', 'good')).toEqual({ merlinCover77: 1 });
    expect(knightTuningOverrides('knight-ed-01', 'loyal', 'good')).toMatchObject({ goodBayesBad: 0.99, goodBayesGood: 0.5 });
    expect(knightTuningOverrides('knight-ed-01', 'oberon', 'evil')).toEqual({ redR1Teammate: false, oberonR1AlwaysFail64: 1 });
    expect(knightTuningOverrides('knight-ed-01', null, null)).toEqual({});
    expect(knightTuningOverrides(DEFAULT_KNIGHT_ID, 'merlin', 'good')).toEqual({});
    expect(knightTuningOverrides('no-such-knight', 'merlin', 'good')).toEqual({});
  });
});

describe('seat names and practice seats', () => {
  it('nextKnightSeatName takes the smallest free serial in the room', () => {
    expect(nextKnightSeatName('AI騎士_ED', [])).toBe('AI騎士_ED_01');
    expect(nextKnightSeatName('AI騎士_ED', ['AI騎士_ED_01', 'AI', 'AI騎士_百科_02'])).toBe('AI騎士_ED_02');
    expect(nextKnightSeatName('AI騎士_ED', ['ai騎士_ed_01', 'AI騎士_ED_03'])).toBe('AI騎士_ED_02');
    expect(nextKnightSeatName('AI騎士_X', Array.from({ length: 9 }, (_, i) => `AI騎士_X_0${i + 1}`))).toBe('AI騎士_X_10');
  });

  it('knightsForSeats: one knight for all, or a shuffled mix without repeats while the roster lasts', () => {
    expect(knightsForSeats('knight-ed-01', 3)).toEqual(['knight-ed-01', 'knight-ed-01', 'knight-ed-01']);
    expect(knightsForSeats('nope', 2)).toEqual(['baike', 'baike']);
    let x = 0.123;
    const rand = (): number => { x = (x * 9301 + 49297) % 233280 / 233280; return x; };
    const mix = knightsForSeats(KNIGHT_MIX_ID, 9, rand);
    const ids = new Set(listKnights().map((k) => k.id));
    expect(mix).toHaveLength(9);
    expect(new Set(mix).size).toBe(9);
    expect(mix.every((id) => ids.has(id))).toBe(true);
    const long = knightsForSeats(KNIGHT_MIX_ID, ids.size + 3, rand);
    expect(new Set(long.slice(0, ids.size)).size).toBe(ids.size);
  });
});
