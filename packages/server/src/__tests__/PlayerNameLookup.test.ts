/**
 * Nickname lookup (players' report 2026-10-13): a player's usual nickname is
 * part of his registered name and looking him up found nothing. The rules live
 * in @avalon/shared (playerNameMatch.ts) and are used by /戰績 /默契 (LINE +
 * Discord), the website's player search (玩家雷達) and the stats API:
 * exact → the same player (playerNameKey, generate_cache.py's player_name_key:
 * case / width / zero-width / spacing ignored) → ignoring separators → unique
 * substring or ≤ 5 candidates, one per player → none with "did you mean"
 * suggestions. Made-up names only.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_NAME_CANDIDATES,
  aliasTarget,
  cleanNameQuery,
  compactName,
  findSamePlayerName,
  findTypedPlayerName,
  matchPlayerName,
  normalizeName,
  playerIdentityKey,
  playerNameKey,
} from '@avalon/shared';

// Priority order = most games first, like the bots and the site pass them.
const NAMES = ['阿明明', '大熊貓', 'Quill Fen', 'Quilla', 'Mia_Chen', '小雨', '小雨點', 'Bob', 'bob', 'Zed'];

const fixture = vi.hoisted(() => {
  const row = (name: string, totalGames: number) => ({
    name, totalGames, winRate: 50, roleTheory: 50, positionTheory: 0, redWin: 50, blueWin: 50,
    red3Red: 0, redMerlinDead: 0, redMerlinAlive: 0, blue3Red: 0, blueMerlinDead: 0, blueMerlinAlive: 0,
    roleWinRates: {}, roleDistribution: {}, redRoleRate: 0, blueRoleRate: 0, seatWinRates: {},
    seatRedWinRates: {}, seatBlueWinRates: {}, rawRoleGames: {}, rawRedWins: 0, rawBlueWins: 0, rawTotalWins: 0,
    rawRedGames: 5, rawBlueGames: 5, finalWinRate: 50, finalRedWinRate: 60, finalBlueWinRate: 40, missionWinRate: 50,
  });
  return {
    players: [
      row('阿明明', 300), row('大熊貓', 200), row('小雨', 120), row('小雨點', 90), row('小虎', 80),
      row('小魚', 70), row('小柚', 60), row('小咪', 50), row('Novak', 45), row('Quill Fen', 40), row('Ilse Marr', 35),
      row('Nova', 2),
    ],
    // players.aliases (player_aliases.json): two old names of Ilse Marr, merged into her row.
    aliases: { 'Tovo Wren': 'Ilse Marr', Orlapike: 'Ilse Marr' } as Record<string, string>,
    // /默契: the matrix holds NOVAK (upper-cased label) but not Nova.
    chemistry: {
      coWin: { players: ['阿明明', 'NOVAK', 'QUILL FEN'], rowLabels: ['阿明明', 'NOVAK', 'QUILL FEN'], values: [[150, 12, 9], [12, 25, 4], [9, 4, 20]] },
      coLose: { players: ['阿明明', 'NOVAK', 'QUILL FEN'], rowLabels: ['阿明明', 'NOVAK', 'QUILL FEN'], values: [[150, 8, 7], [8, 20, 3], [7, 3, 20]] },
      winCorr: { players: ['阿明明', 'NOVAK', 'QUILL FEN'], values: [] },
      coWinMinusLose: { players: ['阿明明', 'NOVAK', 'QUILL FEN'], values: [] },
    },
  };
});

vi.mock('../services/sheetsAnalysis', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/sheetsAnalysis')>()),
  getAllPlayerStats: async () => fixture.players,
  getPlayerAliases: async () => fixture.aliases,
  getPlayerByName: async (name: string) => fixture.players.find((p) => p.name === name) ?? null,
  getLeaderboard: async () => null,
  getChemistry: async () => fixture.chemistry,
  getPlayerArchetype: async () => null,
  getPlayerStrength: async () => null,
  getPlayerPlaystyle: async () => null,
}));

import { answerStatsTextCommand } from '../bots/stats/textCommands';
import { cachePlayerAliases, findPlayerKey, playerNameKey as serverPlayerNameKey } from '../services/sheetsAnalysis';

/** Shared with test_generate_cache.py: generate_cache.player_name_key must give the same keys. */
const NAME_KEY_FIXTURE = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'player_name_keys.json'), 'utf-8'),
) as {
  cases: Array<{ input: string; key: string }>;
  /** player_aliases.json-style map; generate_cache.player_identity_key must give the same identity keys. */
  aliases: Record<string, string>;
  aliasCases: Array<{ input: string; identityKey: string; official: string | null }>;
};
const NAME_KEY_CASES = NAME_KEY_FIXTURE.cases;

describe('playerNameKey — the rule generate_cache.py merges players by', () => {
  it.each(NAME_KEY_CASES.map((c) => [c.input, c.key]))('%j → %j (same as player_name_key)', (input, key) => {
    expect(playerNameKey(input)).toBe(key);
    expect(normalizeName(input)).toBe(key);
  });

  it('the server (sheetsAnalysis) and the matcher use this one function', () => {
    expect(serverPlayerNameKey).toBe(playerNameKey);
    expect(NAME_KEY_CASES.length).toBeGreaterThan(20);
  });
});

describe('playerIdentityKey / aliasTarget — player_aliases.json, the rule generate_cache.py merges by', () => {
  it.each(NAME_KEY_FIXTURE.aliasCases.map((c) => [c.input, c.identityKey, c.official]))(
    '%j → %j (official name %j, same as player_identity_key)',
    (input, identityKey, official) => {
      expect(playerIdentityKey(input as string, NAME_KEY_FIXTURE.aliases)).toBe(identityKey);
      expect(aliasTarget(input as string, NAME_KEY_FIXTURE.aliases) ?? null).toBe(official);
    },
  );

  it('two old names of one player; no map = playerNameKey', () => {
    expect(new Set(Object.values(NAME_KEY_FIXTURE.aliases)).size).toBe(1);
    expect(Object.keys(NAME_KEY_FIXTURE.aliases).length).toBe(2);
    expect(playerIdentityKey('Tovo Wren')).toBe('tovo wren');
    expect(aliasTarget('Tovo Wren', null)).toBeUndefined();
  });
});

describe('old names (players.aliases): the official name answers', () => {
  // Made-up names: Tovo Wren and Orlapike are old names of Ilse Marr.
  const ALIASES = { 'Tovo Wren': 'Ilse Marr', Orlapike: 'Ilse Marr' };
  const WITH_ILSE = [...NAMES, 'Ilse Marr'];

  it('typed any way the matcher accepts a name, an old name finds the official one', () => {
    for (const q of ['Tovo Wren', 'tovo wren', 'ＴＯＶＯ　ＷＲＥＮ', '@Tovo Wren', '「tovo  wren」？']) {
      expect(matchPlayerName(q, WITH_ILSE, ALIASES)).toEqual({
        kind: 'found', name: 'Ilse Marr', caseVariants: [], alias: 'Tovo Wren',
      });
    }
    expect(matchPlayerName('ORLAPIKE', WITH_ILSE, ALIASES)).toEqual({
      kind: 'found', name: 'Ilse Marr', caseVariants: [], alias: 'Orlapike',
    });
    expect(findTypedPlayerName('@tovo wren', WITH_ILSE, undefined, ALIASES)).toBe('Ilse Marr');
    expect(findSamePlayerName('ｔｏｖｏ ｗｒｅｎ', WITH_ILSE, undefined, ALIASES)).toBe('Ilse Marr');
    expect(findSamePlayerName('@Tovo Wren', WITH_ILSE, undefined, ALIASES)).toBeUndefined(); // data: not cleaned
  });

  it('the official name itself, part of it, or no map: no alias', () => {
    expect(matchPlayerName('ilse marr', WITH_ILSE, ALIASES)).toEqual({ kind: 'found', name: 'Ilse Marr', caseVariants: [] });
    expect(matchPlayerName('Ilse', WITH_ILSE, ALIASES)).toEqual({ kind: 'found', name: 'Ilse Marr', caseVariants: [] });
    expect(matchPlayerName('Tovo', WITH_ILSE, ALIASES)).toMatchObject({ kind: 'none' }); // part of an old name
    expect(matchPlayerName('Tovo Wren', WITH_ILSE)).toMatchObject({ kind: 'none' });
    expect(findSamePlayerName('Tovo Wren', NAMES, undefined, ALIASES)).toBeUndefined(); // official name not listed
  });

  it('a row under the old name itself wins (a cache written before the alias)', () => {
    expect(matchPlayerName('Tovo Wren', [...WITH_ILSE, 'Tovo Wren'], ALIASES)).toEqual({
      kind: 'found', name: 'Tovo Wren', caseVariants: [],
    });
  });

  it('findPlayerKey (players/:name, profile/:name/*) and the cache map', () => {
    expect(findPlayerKey({ 'Ilse Marr': 1 }, 'tovo wren', undefined, ALIASES)).toBe('Ilse Marr');
    expect(findPlayerKey({ 'Ilse Marr': 1 }, 'tovo wren')).toBeUndefined();
    expect(cachePlayerAliases({ aliases: { 'Tovo Wren': 'Ilse Marr', Bad: 3, '': 'x', Empty: '' } })).toEqual({
      'Tovo Wren': 'Ilse Marr',
    });
    expect(cachePlayerAliases({})).toEqual({});
    expect(cachePlayerAliases({ aliases: ['Tovo Wren'] })).toEqual({});
    expect(cachePlayerAliases(undefined)).toEqual({});
  });
});

describe('cleanNameQuery / compactName', () => {
  it.each([
    ['@明明', '明明'], ['＠明明', '明明'], ['@@ 明明 ', '明明'], ['「明明」', '明明'], ['"明明"', '明明'],
    ['（明明）', '明明'], ['明明？', '明明'], ['明明!!', '明明'], ['明明。', '明明'], ['「@明明」？', '明明'],
    ['​明明​', '明明'], ['Quill   Fen', 'Quill Fen'], ['', ''], ['   ', ''], ['@', ''],
  ])('%j → %j', (raw, cleaned) => {
    expect(cleanNameQuery(raw)).toBe(cleaned);
  });

  it('compares names without spaces, separators, case or width', () => {
    expect(compactName('Quill Fen')).toBe('quillfen');
    expect(compactName('Mia_Chen')).toBe('miachen');
    expect(compactName('Ｍｉａ・Ｃｈｅｎ')).toBe('miachen');
  });
});

describe('matchPlayerName — nicknames', () => {
  it('a nickname that is part of the registered name finds him (unique substring)', () => {
    expect(matchPlayerName('明明', NAMES)).toEqual({ kind: 'found', name: '阿明明', caseVariants: [] });
    expect(matchPlayerName('熊貓', NAMES)).toEqual({ kind: 'found', name: '大熊貓', caseVariants: [] });
    expect(matchPlayerName('雨點', NAMES)).toEqual({ kind: 'found', name: '小雨點', caseVariants: [] });
    expect(matchPlayerName('chen', NAMES)).toEqual({ kind: 'found', name: 'Mia_Chen', caseVariants: [] });
  });

  it('also when typed as a mention, in brackets or with punctuation', () => {
    for (const q of ['@明明', '＠明明', '「明明」', '明明？', ' 明明 ', '(明明)']) {
      expect(matchPlayerName(q, NAMES)).toMatchObject({ kind: 'found', name: '阿明明' });
    }
  });

  it('ignores spaces and separators', () => {
    expect(matchPlayerName('quillfen', NAMES)).toMatchObject({ kind: 'found', name: 'Quill Fen' });
    expect(matchPlayerName('QUILL FEN', NAMES)).toMatchObject({ kind: 'found', name: 'Quill Fen' });
    expect(matchPlayerName('mia chen', NAMES)).toMatchObject({ kind: 'found', name: 'Mia_Chen' });
    expect(matchPlayerName('llfen', NAMES)).toMatchObject({ kind: 'found', name: 'Quill Fen' });
  });

  it('an exact (or case-insensitive) name still wins over a longer name containing it', () => {
    expect(matchPlayerName('小雨', NAMES)).toEqual({ kind: 'found', name: '小雨', caseVariants: [] });
    expect(matchPlayerName('Bob', NAMES)).toEqual({ kind: 'found', name: 'Bob', caseVariants: ['bob'] });
    expect(matchPlayerName('zed', NAMES)).toEqual({ kind: 'found', name: 'Zed', caseVariants: [] });
  });

  it('names that differ only by case / width are one player (an old cache lists Bob and bob): the first answers', () => {
    expect(matchPlayerName('BOB', NAMES)).toEqual({ kind: 'found', name: 'Bob', caseVariants: ['bob'] });
    expect(matchPlayerName('ｂｏｂ', NAMES)).toEqual({ kind: 'found', name: 'Bob', caseVariants: ['bob'] }); // full-width: not exact
    expect(matchPlayerName('bob', NAMES)).toEqual({ kind: 'found', name: 'bob', caseVariants: ['Bob'] }); // exact spelling
    expect(matchPlayerName('「ＢＯＢ」', NAMES)).toEqual({ kind: 'found', name: 'Bob', caseVariants: ['bob'] });
    // A substring hit on two spellings of one player is that player, not a choice between "two".
    expect(matchPlayerName('bo', ['Bob', 'bob', 'Zed'])).toEqual({ kind: 'found', name: 'Bob', caseVariants: ['bob'] });
  });

  it('names that genuinely differ stay a candidate list, one entry per player', () => {
    // "Quill Fen" and "quillfen" are two players for the cache (the space is part of the name).
    expect(matchPlayerName('quill-fen', ['Quill Fen', 'quillfen'])).toEqual({
      kind: 'ambiguous', query: 'quill-fen', candidates: ['Quill Fen', 'quillfen'], total: 2,
    });
    expect(matchPlayerName('QUILLFEN', ['Quill Fen', 'quillfen'])).toEqual({ kind: 'found', name: 'quillfen', caseVariants: [] });
    expect(matchPlayerName('o', ['Bob', 'BOB', 'bob', 'Zed', 'Orca'])).toEqual({
      kind: 'ambiguous', query: 'o', candidates: ['Bob', 'Orca'], total: 2,
    });
    const many = ['小一', '小一', '小二', '小三', '小四', '小五', '小六'];
    expect(matchPlayerName('小', many)).toMatchObject({ kind: 'ambiguous', candidates: ['小一', '小二', '小三', '小四', '小五'], total: 6 });
  });

  it('several hits: up to 5 candidates in the given order, with the total', () => {
    expect(matchPlayerName('quil', NAMES)).toEqual({ kind: 'ambiguous', query: 'quil', candidates: ['Quill Fen', 'Quilla'], total: 2 });
    const many = ['小一', '小二', '小三', '小四', '小五', '小六', '小七'];
    const m = matchPlayerName('小', many);
    expect(m).toEqual({ kind: 'ambiguous', query: '小', candidates: many.slice(0, MAX_NAME_CANDIDATES), total: 7 });
  });

  it('nothing contains it: none, with names holding its characters in order as suggestions', () => {
    expect(matchPlayerName('大貓', NAMES)).toEqual({ kind: 'none', query: '大貓', suggestions: ['大熊貓'] });
    expect(matchPlayerName('無名氏', NAMES)).toEqual({ kind: 'none', query: '無名氏' });
    expect(matchPlayerName('貓', NAMES)).toMatchObject({ kind: 'found', name: '大熊貓' });
    expect(matchPlayerName('x', NAMES)).toEqual({ kind: 'none', query: 'x' }); // one character: no suggestions
  });
});

describe('findSamePlayerName — the stats API lookup (exact, then the same playerNameKey)', () => {
  it('exact, else the same player ignoring case / width / spacing; never part of a name', () => {
    expect(findSamePlayerName('Quill Fen', NAMES)).toBe('Quill Fen');
    expect(findSamePlayerName('ＱＵＩＬＬ　ｆｅｎ', NAMES)).toBe('Quill Fen');
    expect(findSamePlayerName(' quill  fen ', NAMES)).toBe('Quill Fen');
    expect(findSamePlayerName('zed', NAMES)).toBe('Zed');
    expect(findSamePlayerName('明明', NAMES)).toBeUndefined(); // a nickname is the bots' business, not the API's
    expect(findSamePlayerName('quillfen', NAMES)).toBeUndefined(); // another player's name for the cache
    expect(findSamePlayerName('', NAMES)).toBeUndefined();
  });

  it('takes the name as given: @, brackets and punctuation make another name (as for generate_cache.py)', () => {
    // An account called "(Zed)" must not get the 牌譜 player Zed's record as its profile.
    for (const other of ['@Zed', '(Zed)', 'Zed!', '「Zed」', 'Zed?']) {
      expect(findSamePlayerName(other, NAMES)).toBeUndefined();
      expect(playerNameKey(other)).not.toBe(playerNameKey('Zed'));
    }
    const record = { Zed: 1 };
    expect(findPlayerKey(record, '(Zed)')).toBeUndefined();
    expect(findPlayerKey(record, '@zed')).toBeUndefined();
  });

  it('findTypedPlayerName (stages 1–2 of matchPlayerName, for typed queries) does clean them', () => {
    expect(findTypedPlayerName('@quill  fen', NAMES)).toBe('Quill Fen'); // a mention typed by hand
    expect(findTypedPlayerName('「ＺＥＤ」？', NAMES)).toBe('Zed');
    expect(findTypedPlayerName('明明', NAMES)).toBeUndefined(); // never part of a name
    expect(findTypedPlayerName('bob', NAMES)).toBe('bob'); // an exact spelling of an old split cache
    expect(findTypedPlayerName('@BOB', NAMES)).toBe('Bob'); // else the first (most games)
  });

  it('several spellings of one player (an old cache): the highest rank, else the first', () => {
    const games: Record<string, number> = { NOVA: 7, Nova: 40, nova: 3 };
    const names = Object.keys(games);
    expect(findSamePlayerName('nova', names)).toBe('nova'); // that exact spelling exists
    expect(findSamePlayerName('ｎｏｖａ', names, (n) => games[n])).toBe('Nova');
    expect(findSamePlayerName('NoVa', names)).toBe('NOVA');
  });

  it('sheetsAnalysis.findPlayerKey (players/:name, profile/:name/*) goes through it', () => {
    const record = { Nova: 1, 'Quill Fen': 2 };
    expect(findPlayerKey(record, 'ｎｏｖａ')).toBe('Nova');
    expect(findPlayerKey(record, 'quill fen')).toBe('Quill Fen');
    expect(findPlayerKey(record, 'Quill')).toBeUndefined();
    expect(findPlayerKey(record, 'toString')).toBeUndefined();
  });
});

describe('/戰績 end to end (LINE text command; Discord uses the same reply)', () => {
  it('nickname → that player\'s card', async () => {
    const text = await answerStatsTextCommand('/戰績 明明', 'line');
    expect(text).toContain('📊 阿明明 的戰績');
  });

  it('mention-style nickname → card', async () => {
    const text = await answerStatsTextCommand('/戰績 @熊貓', 'discord');
    expect(text).toContain('📊 大熊貓 的戰績');
  });

  it('several matches → at most 5 candidate names and the total', async () => {
    const text = (await answerStatsTextCommand('/戰績 小', 'line')) ?? '';
    expect(text).toContain('「小」符合 6 位玩家');
    expect(text).toContain('小雨、小雨點、小虎、小魚、小柚 等 6 位');
    expect(text).not.toContain('小咪');
  });

  it('no match → "did you mean"', async () => {
    const text = (await answerStatsTextCommand('/戰績 大貓', 'line')) ?? '';
    expect(text).toContain('找不到玩家「大貓」');
    expect(text).toContain('你是不是要找：大熊貓？');
  });

  it('an old name (players.aliases) → the official name\'s card, with one line saying so', async () => {
    const text = (await answerStatsTextCommand('/戰績 tovo wren', 'discord')) ?? '';
    expect(text).toContain('📊 Ilse Marr 的戰績');
    expect(text).toContain('ℹ️ 「Tovo Wren」現在統一顯示為「Ilse Marr」（同一位玩家，戰績已合併）');
    const own = (await answerStatsTextCommand('/戰績 Ilse Marr', 'line')) ?? '';
    expect(own).toContain('📊 Ilse Marr 的戰績');
    expect(own).not.toContain('統一顯示為');
  });
});

describe('/默契 — a player\'s own name before part of a name in the matrix', () => {
  it('a player outside the matrix is not swapped for one inside whose name contains his', async () => {
    // /戰績 Nova opens Nova; /默契 must not answer for NOVAK.
    expect(await answerStatsTextCommand('/戰績 Nova', 'line')).toContain('📊 Nova 的戰績');
    for (const typed of ['Nova', 'nova', '@Nova', 'ＮＯＶＡ']) {
      const text = (await answerStatsTextCommand(`/默契 ${typed} 明明`, 'line')) ?? '';
      expect(text).toContain('「Nova」不在默契矩陣裡');
      expect(text).not.toContain('Novak');
    }
  });

  it('the player\'s own name maps onto his (upper-cased) matrix label', async () => {
    const text = (await answerStatsTextCommand('/默契 novak 明明', 'line')) ?? '';
    expect(text).toContain('🤝 Novak × 阿明明 默契');
    expect(text).toContain('同隊 20 場：一起贏 12、一起輸 8');
  });

  it('an old name (players.aliases) is the official name\'s player', async () => {
    const text = (await answerStatsTextCommand('/默契 orlapike 明明', 'line')) ?? '';
    expect(text).toContain('「Ilse Marr」不在默契矩陣裡');
  });

  it('part of a name still searches the matrix', async () => {
    const text = (await answerStatsTextCommand('/默契 quill 明明', 'line')) ?? '';
    expect(text).toContain('🤝 Quill Fen × 阿明明 默契');
  });
});
