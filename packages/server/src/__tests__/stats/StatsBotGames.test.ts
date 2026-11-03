/**
 * 百科AI 局另外算（Edward 2026-11-03「有百科AI的另外算」）：分類「百科AI」的局預設不算進任何數字
 * （不篩選、not 子句、玩家條件的評估集、基準列、名單），篩選明確勾選「百科AI」分類才看得到。名字全是虛構的。
 */
import { describe, expect, it } from 'vitest';
import {
  BOT_GAME_CATEGORY,
  applyFilter,
  computeStats,
  decodeFilter,
  decodeGamesDataset,
  encodeFilter,
  filterIncludesBotGames,
  isBotGame,
  sanitizeFilter,
  withBotGames,
  type DecodedDataset,
  type GameFilter,
} from '@avalon/shared/stats';
import { replayGamesFromDataset, SKIP_BOT_GAME, type DatasetHeader, type DatasetTuple } from '../../ai/benchmark/datasetReplay';
import { isBotPaipuRow, rowsFromSheet } from '../../ai/benchmark/sheetsReplay';
import { TEN, makeDataset, type GameSpec } from './datasetBuilder';

const AS_OF = '2026-10-31';
const OUTCOMES = ['三紅', '三藍死', '三藍活'];
const KILLS = ['', '6', '7'];
const CATS = ['線瓦', '面瓦', '娛樂'];

// 40 局人類局（虛構甲..癸 輪流換座位）＋ 6 局百科AI 局（百科AI 坐 1 號，10 號是只在百科AI 局出現的虛構子）
const HUMAN: GameSpec[] = Array.from({ length: 40 }, (_, i) => ({
  id: `h${i}`, cat: CATS[i % 3], date: `2026-10-${String(1 + (i % 28)).padStart(2, '0')}`, outcome: OUTCOMES[i % 3],
  kill: KILLS[i % 3], names: TEN.map((_, s) => TEN[(s + i) % 10]),
}));
const BOTS: GameSpec[] = Array.from({ length: 6 }, (_, i) => ({
  id: `b${i}`, cat: BOT_GAME_CATEGORY, date: '2026-10-20', outcome: OUTCOMES[i % 3], kill: KILLS[i % 3],
  names: ['百科AI', ...TEN.slice(1, 9), '虛構子'],
}));
const human = decodeGamesDataset(makeDataset(HUMAN));
const mixed = decodeGamesDataset(makeDataset([...HUMAN, ...BOTS]));
const CTX = { asOf: AS_OF };
const stats = (d: DecodedDataset, f: GameFilter | null): string => JSON.stringify(computeStats(d, CTX, f));
const filter = (...clauses: GameFilter['clauses']): GameFilter => ({ v: 1, clauses });

describe('百科AI games are counted separately', () => {
  it('decode keeps them out of games and out of the player list', () => {
    expect(mixed.games).toHaveLength(40);
    expect(mixed.botGames?.map((g) => g.id)).toEqual(BOTS.map((s) => s.id));
    expect(mixed.botGames?.every(isBotGame)).toBe(true);
    expect(mixed.dataset.players).toEqual(human.dataset.players);
    expect(mixed.dataset.players).not.toContain('百科AI');
    expect(human.botGames).toBeUndefined();
  });

  it('no filter, a "not" category clause and player conditions give the human-only numbers', () => {
    expect(stats(mixed, null)).toBe(stats(human, null));
    const noCasual = filter({ kind: 'category', in: ['娛樂'], not: true });
    expect(stats(mixed, noCasual)).toBe(stats(human, noCasual));
    const online = filter({ kind: 'category', in: ['線瓦', '面瓦'] });
    expect(stats(mixed, online)).toBe(stats(human, online));
    const byPr = filter({ kind: 'excludePlayers', scope: 'dropGames', who: { by: 'metric', metric: 'roleTheory', op: 'gt', pr: 80 } });
    expect(stats(mixed, byPr)).toBe(stats(human, byPr));
    const invert = filter({ kind: 'excludePlayers', scope: 'hideFromLists', who: { by: 'names', names: [TEN[0]], invert: true } });
    expect(stats(mixed, invert)).toBe(stats(human, invert));
    // 只出現在百科AI 局的名字：預設找不到
    const withBot = applyFilter(mixed, CTX, filter({ kind: 'withPlayer', player: '百科AI' }));
    expect(withBot.meta.unresolvedNames).toEqual(['百科AI']);
    expect(withBot.games).toHaveLength(40);
  });

  it('ticking the 百科AI category brings them in', () => {
    const only = filter({ kind: 'category', in: ['百科AI'] });
    expect(filterIncludesBotGames(only)).toBe(true);
    const app = applyFilter(mixed, CTX, only);
    expect(app.games.map((g) => g.id)).toEqual(BOTS.map((s) => s.id));
    expect(app.meta.totalGames).toBe(46);
    const result = computeStats(mixed, CTX, only);
    expect(result.players.players.map((p) => p.name)).toContain('百科AI');
    expect(result.overview.totalGames).toBe(6);
    const all = filter({ kind: 'category', in: ['線瓦', '面瓦', '娛樂', '未分類', '其他', '百科AI'] });
    expect(applyFilter(mixed, CTX, all).games).toHaveLength(46);
    // 百科AI 局在原本的位置（資料集最後）、名單含只在百科AI 局出現的人
    expect(withBotGames(mixed).games.map((g) => g.seq)).toEqual([...Array(46).keys()]);
    expect(withBotGames(mixed).dataset.players).toContain('虛構子');
    expect(withBotGames(mixed)).toBe(withBotGames(mixed));
    expect(withBotGames(human)).toBe(human);
    const withNewcomer = filter({ kind: 'category', in: ['百科AI'] }, { kind: 'withPlayer', player: '虛構子' });
    expect(applyFilter(mixed, CTX, withNewcomer).games).toHaveLength(6);
  });

  it('only a listed (not negated) 百科AI category opts in', () => {
    expect(filterIncludesBotGames(null)).toBe(false);
    expect(filterIncludesBotGames(filter({ kind: 'category', in: ['百科AI'], not: true }))).toBe(false);
    expect(filterIncludesBotGames(filter({ kind: 'category', in: ['娛樂'], not: true }))).toBe(false);
    expect(applyFilter(mixed, CTX, filter({ kind: 'category', in: ['百科AI'], not: true })).games).toHaveLength(40);
  });

  it('share links keep the 百科AI category', () => {
    const f = filter({ kind: 'category', in: ['線瓦', '百科AI'] });
    expect(sanitizeFilter(f).filter).toEqual(f);
    expect(decodeFilter(encodeFilter(f)).filter).toEqual(f);
  });
});

describe('bot training / benchmark readers skip 百科AI games', () => {
  it('the human PR replay (games_cache.json) skips them', () => {
    const ds = makeDataset([...HUMAN.slice(0, 2), ...BOTS.slice(0, 1)]);
    const { skipped } = replayGamesFromDataset(ds as unknown as DatasetHeader & { games: readonly DatasetTuple[] });
    expect(skipped[SKIP_BOT_GAME]).toBe(1);
  });

  it('sheets_cache.json rows: 分類 百科AI or a 百科AI seat', () => {
    const header = ['流水號', '分類', '玩1', '玩2', '玩3', '玩4', '玩5', '玩6', '玩7', '玩8', '玩9', '玩0'];
    const table = [
      header,
      ['1', '線瓦', ...TEN],
      ['2', BOT_GAME_CATEGORY, ...TEN],
      ['3', '線瓦', '百科AI_3', ...TEN.slice(1)],
      ['4', '面瓦', ...TEN.slice(0, 9), '百科機器人A'],
      ['5', '線瓦', 'ＡＢＣ', ...TEN.slice(1)],
    ];
    expect(rowsFromSheet(table).map((r) => r['流水號'])).toEqual(['1', '5']);
    expect(isBotPaipuRow({ 分類: '', 玩1: '百科ＡＩ_1' })).toBe(true);
    expect(isBotPaipuRow({ 分類: '', 玩1: '阿瓦隆百科' })).toBe(false);
  });
});
