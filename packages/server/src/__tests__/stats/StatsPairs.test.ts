import { describe, expect, it } from 'vitest';
import { computePairs, decodeGamesDataset } from '@avalon/shared/stats';
import { makeDataset, TEN } from './datasetBuilder';

describe('默契的共同出賽與同陣營勝負', () => {
  const games = decodeGamesDataset(makeDataset([
    { outcome: '三紅' }, { outcome: '三藍死' }, { outcome: '三藍活' }, { outcome: '' },
  ])).games;
  const roster = { players: TEN, rowLabels: [...TEN].reverse() };

  it('三藍死的紅方任務敗、最終勝；兩個分母都是三場同陣營對局', () => {
    const pair = computePairs(games, roster).sameFaction.find((p) => p.players.includes(TEN[0]) && p.players.includes(TEN[1]));
    expect(pair).toMatchObject({ sharedGames: 3, sameFactionGames: 3, missionWins: 1, missionLosses: 2,
      finalWins: 2, finalLosses: 1, missionWinRate: 33.3, finalWinRate: 66.7 });
  });

  it('不同陣營仍算共同出賽，但同陣營分母為零、勝率為空', () => {
    const pair = computePairs(games, roster).sameFaction.find((p) => p.players.includes(TEN[0]) && p.players.includes(TEN[6]));
    expect(pair).toMatchObject({ sharedGames: 3, sameFactionGames: 0, finalWins: 0, missionWinRate: null, finalWinRate: null });
  });

  it('矩陣遵守試算表名單的列順序，隱藏名單不改剩餘配對的數字', () => {
    const all = computePairs(games, roster);
    expect(all.outcomePair.games[9][1]).toBe(3);
    expect(all.outcomePair.values[9][1]).toBe(33.3);
    expect(all.outcomePair.threeBlueDeadPct[9][1]).toBe(33.3);
    expect(all.outcomePair.games[9][0]).toBeNull();
    const hidden = computePairs(games, roster, new Set([TEN[0]]));
    expect(hidden.outcomePair.players).not.toContain(TEN[0]);
    expect(hidden.outcomePair.rowLabels).not.toContain(TEN[0]);
    expect(hidden.sameFaction).toEqual(all.sameFaction.filter((p) => !p.players.includes(TEN[0])));
  });

  it('同名佔兩個不同陣營座位時，每局只算一次共同出賽，不能判定同陣營', () => {
    const names = [...TEN]; names[6] = names[0];
    const duplicate = decodeGamesDataset(makeDataset([{ names }])).games;
    const pair = computePairs(duplicate).sameFaction.find((p) => p.players.includes(TEN[0]) && p.players.includes(TEN[1]));
    expect(pair).toMatchObject({ sharedGames: 1, sameFactionGames: 0 });
  });
});
