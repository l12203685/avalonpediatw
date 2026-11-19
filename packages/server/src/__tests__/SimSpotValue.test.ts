/**
 * 模擬瓦 spot 篩選與自動選 spot（2026-11-19，Edward：「你再給題目的時候 至少要篩選」「沒指定情境(spot)的話 就抽選一局
 * ……判斷出 該局最有價值最值得思考出題的幾個 spot」）。對局都是編的（fixtures/simGames.ts），沒有真實玩家。
 */
import { describe, expect, it } from 'vitest';
import { seededRandom } from '../ai/benchmark/agreement';
import { bankEntryFor } from '../bots/simulation/bankCodec';
import { buildSimBank } from '../bots/simulation/bank';
import { parseSimCommand } from '../bots/simulation/commands';
import { simCommandFromInteraction } from '../bots/simulation/discordCommand';
import {
  isThreePlusOne,
  midDecision,
  round2TailWorthy,
  round3TailWorthy,
  round4LoyalDecisions,
  selectExercise,
  type SimGame,
} from '../bots/simulation/scenario';
import {
  SPOT_NEUTRAL,
  SPOT_WEIGHTS,
  bestPerKind,
  enumerateSpots,
  isBareStart,
  rankSpots,
  scoreSpot,
  selectStart,
  selectValueSpot,
} from '../bots/simulation/spotValue';
import { buildCandidates } from '../bots/threads/plan';
import { GAME_MID_TEXT, GAME_WIKI_CFG, midRow, parsedGame, simRow, wikiRow } from './fixtures/simGames';

/** GAME_MID 的第 2 局前三次換成三加一（第 1 局任務隊 1 5 7 ＋1 人），只剩 4689 不是 → 2-5 不出。 */
const THREE_PLUS_ONE_TEXT = GAME_MID_TEXT.replace(
  ['1246', '3579', '2468', '4689'].join('\n'),
  ['1257', '1357', '1567', '4689'].join('\n'),
);
/** 同上但只換兩次：還有兩個隊長不是派三加一 → 2-5 照出。 */
const TWO_NOT_TEXT = GAME_MID_TEXT.replace(['1246', '3579'].join('\n'), ['1257', '1357'].join('\n'));

const MID: SimGame = parsedGame(midRow());
const WIKI: SimGame = parsedGame(wikiRow());
const TPO: SimGame = parsedGame(simRow('T-0101', THREE_PLUS_ONE_TEXT, GAME_WIKI_CFG, '1', '三藍死'));
const TWO: SimGame = parsedGame(simRow('T-0102', TWO_NOT_TEXT, GAME_WIKI_CFG, '1', '三藍死'));

function bankOf(games: Array<[SimGame, string]>) {
  return buildSimBank({ version: 1, builtFrom: 'test', games: games.map(([g, id]) => ({ ...bankEntryFor({ ...g, names: [] }, 'X'), id })) });
}

describe('filters (2-5, 3-5, round 4)', () => {
  it('三加一 = the round-1 mission team plus one seat', () => {
    expect(isThreePlusOne(MID, [1, 5, 7, 2])).toBe(true);
    expect(isThreePlusOne(MID, [1, 5, 2, 4])).toBe(false);
    expect(isThreePlusOne(MID, [1, 5, 7])).toBe(false);
  });

  it('2-5: round 1 failed → yes; succeeded → only when at least two of 2-1..2-4 are not 三加一', () => {
    expect(WIKI.quests[0].failed).toBe(true);
    expect(round2TailWorthy(WIKI)).toBe(true);
    expect(midDecision(WIKI, 2)).not.toBeNull();

    expect(MID.quests[0].failed).toBe(false);
    expect(round2TailWorthy(MID)).toBe(true); // none of 1246 3579 2468 4689 is 三加一
    expect(round2TailWorthy(TWO)).toBe(true); // 1257 1357 are, 2468 4689 are not
    expect(round2TailWorthy(TPO)).toBe(false); // 1257 1357 1567 are, only 4689 is not
    expect(midDecision(TPO, 2)).toBeNull();
    // The explicit id still works (stageDecision does not filter).
    const bank = bankOf([[TPO, 'TPO01']]);
    expect(selectExercise(bank, { exerciseId: 'TPO01-2-5' }, () => 0)).toMatchObject({ ok: true, stage: { round: 2, attempt: 5 } });
    expect(selectExercise(bank, { midRound: 2 }, () => 0)).toEqual({ ok: false, reason: 'no-mid', round: 2 });
  });

  it('3-5 stays limited to games whose round-2 mission failed', () => {
    expect(round3TailWorthy(MID)).toBe(true);
    expect(round3TailWorthy(WIKI)).toBe(false);
    expect(midDecision(MID, 3)).not.toBeNull();
  });

  it('round 4: every proposal led by a loyal; /模擬 4局 (no role) draws only those, 4-5 unchanged', () => {
    const loyal = round4LoyalDecisions(MID);
    expect(loyal.length).toBeGreaterThan(0);
    for (const d of loyal) {
      expect(MID.proposals[d].round).toBe(4);
      expect(MID.seatRoles[MID.proposals[d].leaderSeat - 1]).toBe('loyal');
    }
    const bank = bankOf([[MID, 'MID01'], [WIKI, 'WIK01']]);
    for (const x of [0, 0.3, 0.6, 0.99]) {
      const r = selectExercise(bank, { midRound: 4, anyAttempt: true }, () => x);
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      const p = bank.games[r.game].proposals[r.decision];
      expect(p.round).toBe(4);
      expect(bank.games[r.game].seatRoles[r.seat - 1]).toBe('loyal');
    }
    expect(selectExercise(bank, { midRound: 4 }, () => 0)).toEqual({ ok: false, reason: 'no-mid', round: 4 });
  });

  it('commands: /模擬 4局, 第四局, + role/seat; Discord 局面:4局; 4-5 still the tail', () => {
    expect(parseSimCommand('/模擬 4局')).toEqual({ kind: 'start', midRound: 4, anyAttempt: true });
    expect(parseSimCommand('/模擬 第四局 6')).toEqual({ kind: 'start', seat: 6, midRound: 4, anyAttempt: true });
    expect(parseSimCommand('/模擬 4-5')).toEqual({ kind: 'start', midRound: 4 });
    expect(parseSimCommand('/模擬 5局')).toEqual({ kind: 'start', midRound: 5 });
    const discord = (stage: string) =>
      simCommandFromInteraction({
        commandName: '模擬',
        options: { getString: (n: string) => (n === '局面' ? stage : null), getInteger: () => null, getBoolean: () => false },
      } as never);
    expect(discord('4局')).toEqual({ kind: 'start', midRound: 4, anyAttempt: true });
    expect(discord('4-5')).toEqual({ kind: 'start', midRound: 4 });
  });

  it('Threads uses the same filter: a 2-5 that fails it is not a Friday candidate', () => {
    const c = buildCandidates({ games: [TPO, MID] });
    expect(c.fri.map((x) => x.picks[0].gameId)).toEqual([MID.id]);
    expect(c.friSat.some((x) => x.picks[0].gameId === TPO.id)).toBe(false);
  });
});

describe('spot value', () => {
  it('enumerates the spots of a game in a fixed order, each id once', () => {
    const spots = enumerateSpots(MID);
    expect(spots.map((s) => s.kind)).toEqual(['1-5', '2-5', '3-5', 'round4', 'percival', 'round5', 'assassin']);
    expect(spots.map((s) => s.exerciseId.slice(MID.id.length))).toEqual(['-1-5', '-2-5', '-3-5', '-4-1', '-3-2', '-5-1', '-A']);
    expect(MID.seatRoles[spots[4].seat - 1]).toBe('percival');
    expect(new Set(spots.map((s) => s.exerciseId)).size).toBe(spots.length);
    // TPO: its 2-5 is filtered out.
    expect(enumerateSpots(TPO).map((s) => s.kind)).not.toContain('2-5');
  });

  it('scores are in [0,1], the total is the weighted sum, stakes and info follow the rules', () => {
    const spots = enumerateSpots(MID);
    for (const s of spots) {
      const sc = scoreSpot(MID, s);
      for (const v of [sc.info, sc.difficulty, sc.stakes, sc.divergence, sc.total]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
      const w = SPOT_WEIGHTS;
      expect(sc.total).toBeCloseTo(w.info * sc.info + w.difficulty * sc.difficulty + w.stakes * sc.stakes + w.divergence * sc.divergence, 2);
    }
    const by = Object.fromEntries(spots.map((s) => [s.kind, scoreSpot(MID, s)]));
    expect(by['1-5']).toMatchObject({ info: 0.2, stakes: 0.5 }); // 4 proposals seen, nothing decided yet, forced
    expect(by['1-5']).toMatchObject({ difficulty: SPOT_NEUTRAL, divergence: SPOT_NEUTRAL }); // a morgana leads 1-5: fixed
    expect(by.round4.stakes).toBe(0.7); // two fails already (decisive) × not forced
    expect(by.round5.stakes).toBe(1);
    expect(by.assassin.stakes).toBe(1);
    expect(by.assassin.info).toBe(1);
  });

  it('ranking is deterministic and sorted; bestPerKind keeps one per kind', () => {
    const a = rankSpots(MID);
    expect(rankSpots(MID)).toEqual(a);
    for (let i = 1; i < a.length; i++) expect(a[i - 1].score.total).toBeGreaterThanOrEqual(a[i].score.total);
    const best = bestPerKind(a);
    expect(new Set(best.map((r) => r.spot.kind)).size).toBe(best.length);
  });

  it('a bare /模擬 starts at the top spot of the drawn game and names up to two more (other kinds); linked games first', () => {
    const bank = bankOf([[MID, 'MID01'], [WIKI, 'WIK01']]);
    const r = selectValueSpot(bank, () => 0);
    expect(r?.ok).toBe(true);
    if (!r || !r.ok) return;
    const top = bestPerKind(rankSpots(bank.games[0]));
    expect(r.game).toBe(0);
    expect(r.seat).toBe(top[0].spot.seat);
    expect(r.alsoWorth?.map((x) => x.exerciseId)).toEqual(top.slice(1, 3).map((x) => x.spot.exerciseId));
    // Seeded rng: same seed, same pick.
    expect(selectValueSpot(bank, seededRandom('k'))).toEqual(selectValueSpot(bank, seededRandom('k')));
    // With a records index, only linked games are drawn.
    const linked = { ...bank, records: new Map([[1, 'S9ABC']]) };
    for (const seed of ['a', 'b', 'c', 'd']) expect(selectValueSpot(linked, seededRandom(seed))).toMatchObject({ ok: true, game: 1 });
  });

  it('only a bare request is auto-picked; role/seat/spot/id/special behave as before', () => {
    const bank = bankOf([[MID, 'MID01'], [WIKI, 'WIK01']]);
    expect(isBareStart({})).toBe(true);
    for (const req of [{ role: 'loyal' as const }, { seat: 4 }, { midRound: 3 }, { exerciseId: 'MID01-4' }, { special: 'assassin' as const }]) {
      expect(isBareStart(req)).toBe(false);
      expect(selectStart(bank, req, () => 0.42)).toEqual(selectExercise(bank, req, () => 0.42));
    }
    expect(selectStart(bank, {}, () => 0)).toEqual(selectValueSpot(bank, () => 0));
  });
});
