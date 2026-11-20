/**
 * 模擬瓦 — 題庫的局 → 網站牌譜紀錄那一篇（2026-11-16，Edward：「模擬瓦公布沒辦法知道原本的完整牌譜，還要自己找」
 * 「給牌局連結就好」）。指紋跟 generate_cache.record_fingerprint／discord_records_export.entry_fingerprint 同一個定義：
 * 隊伍的座位排序（0 最後）、任務 o 在前 x 在後、空的任務不算；id 當不透明字串。只用編的對局，沒有真實玩家。
 */
import { describe, expect, it } from 'vitest';
import { recordFingerprint } from '../bots/simulation/bankCodec';
import { buildSimBank } from '../bots/simulation/bank';
import { fingerprintIndex, isSimulatedPost, linkRecords, postFingerprint, readRecordPosts, recordUrl } from '../bots/simulation/recordsIndex';
import { bankEntryFor } from '../bots/simulation/bankCodec';
import { gameIdIndex, linkSeatNames, normalizeSplitGameId, parseSeatNameRules, readSeatNameSources, resolveSeatNames, tidySeatName } from '../bots/simulation/seatNames';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fixtureBank, parsedGame, shortRow, wikiRow, GAME_WIKI_CFG } from './fixtures/simGames';

/** 百科那局寫成牌譜紀錄的一篇（discord_records_export 的形狀；隊伍故意不排序、任務 x 在前）。 */
function wikiPost(id: string): { id: string; game: unknown } {
  return {
    id,
    game: {
      config: GAME_WIKI_CFG,
      rounds: [
        { proposals: [{ team: '064', votes: ['1+'] }, { team: '927' }, { team: '073' }, { team: '946' }, { team: '751' }], mission: 'xoo' },
        { proposals: [{ team: '6421' }, { team: '9753' }, { team: '8642' }, { team: '9864' }, { team: '0641' }], mission: 'oooo' },
        { proposals: [{ team: '1246' }, { team: '1257' }, { team: '3579' }, { team: '1468' }], mission: 'OOOO' },
        { proposals: [{ team: '13579' }, { team: '12468' }], mission: 'ooooo' },
        { proposals: [], mission: '' },
      ],
      lakes: [],
      assassination: '1',
      outcome: '三藍死',
    },
  };
}

describe('records index', () => {
  it('the post fingerprint equals the bank fingerprint of the same game (team order, 0 last, o before x, empty missions)', () => {
    const game = parsedGame(wikiRow());
    expect(postFingerprint(wikiPost('1').game as never)).toBe(recordFingerprint(game));
    expect(recordFingerprint(game)).toBe('753921|460,279,370,469,157,1246,3579,2468,4689,1460,1246,1257,3579,1468,13579,12468|oox,oooo,oooo,ooooo');
  });

  it('links bank games to post ids; the first post of a duplicate wins; opaque ids pass, junk ids do not', () => {
    const bank = fixtureBank(2);
    const idx = fingerprintIndex([wikiPost('1397438863340998720'), wikiPost('2222222222222222222'), { id: '<script>', game: {} }, { id: 'S9ABC' }]);
    expect([...idx.values()]).toEqual(['1397438863340998720']);
    const links = linkRecords(bank.games, idx);
    expect([...links.entries()]).toEqual([[0, '1397438863340998720'], [1, '1397438863340998720']]); // both W copies are the same game
    expect(fingerprintIndex([wikiPost('S01ABC')]).get(recordFingerprint(parsedGame(wikiRow())))).toBe('S01ABC');
  });

  it('posts flagged 模擬 (category, tag or flag) are never linked: exercises and links use real games only', () => {
    const base = wikiPost('S01ABC');
    for (const flagged of [
      { ...base, simulated: true },
      { ...base, sim: true }, // records_cache 的模擬條目（沒有標籤也要認得）
      { ...base, game: { ...(base.game as object), sim: true } },
      { ...base, tags: ['覆盤', '模擬'] },
      { ...base, category: '模擬' },
      { ...base, game: { ...(base.game as object), category: '模擬' } },
    ]) {
      expect(isSimulatedPost(flagged)).toBe(true);
      expect(fingerprintIndex([flagged]).size).toBe(0);
    }
    expect(isSimulatedPost(base)).toBe(false);
  });

  it('buildSimBank with posts fills bank.records (and the status count); without posts it is empty (no restriction)', () => {
    const entry = bankEntryFor(parsedGame(wikiRow()), 'W0000');
    const short = bankEntryFor(parsedGame(shortRow()), 'S0000');
    const file = { version: 1, builtFrom: 'test', games: [entry, short] };
    expect(buildSimBank(file).records.size).toBe(0);
    const bank = buildSimBank(file, [wikiPost('S01ABC')]);
    expect([...bank.records.entries()]).toEqual([[0, 'S01ABC']]);
  });

  it('a missing records file → null (the bank still loads; /公布 falls back to the text record)', () => {
    expect(readRecordPosts(['/nonexistent/records_cache.json'])).toBeNull();
    expect(recordUrl('S9 A')).toBe('https://avalon-game-platform.web.app/#records=S9%20A');
  });

  it('the committed sim_bank.json links to the committed records_cache.json for a good share of games', async () => {
    const { readSimBankFile, defaultSimBankPaths } = await import('../bots/simulation/bank');
    const file = readSimBankFile(defaultSimBankPaths());
    const posts = readRecordPosts();
    if (!file || !posts) return; // either file absent in this checkout
    const bank = buildSimBank(file, posts);
    expect(bank.records.size).toBeGreaterThan(300);
    expect(bank.records.size).toBeLessThanOrEqual(bank.games.length);
  });
});

/** 編的名字（不是真的玩家）。 */
const NAMES = ['甲蟲', '乙鳥', 'Nova', '丁香', '戊己', '庚辛', '壬癸', '子丑', '寅卯', '辰巳'];

describe('/公布 seat names (Edward 2026-11-20: list who sat 1～0 under the seats)', () => {
  const rules = parseSeatNameRules({
    _comment: 'test',
    aliases: { 舊甲蟲: '甲蟲王', ＮＯＶＡ２: 'Nova Two' },
    splits: {
      乙鳥: [{ as: '乙鳥（2）', games: ['D0123456789', 'S0042'] }],
      丁香: [{ as: '丁香（新）', from: '2026-11-01', venue: '線瓦' }],
      戊己: [{ as: '戊己（5）', games: ['1397438863340998720'], seat: 5 }],
      bad: [{ as: '', games: ['S1'] }, { as: 'x', games: ['nope'] }],
    },
  });

  it('parses aliases by name key and keeps only usable split rules (ids normalised like generate_cache)', () => {
    expect([...rules.aliases.entries()]).toEqual([['舊甲蟲', '甲蟲王'], ['nova2', 'Nova Two']]);
    expect(rules.splits.map((r) => [r.key, r.as, [...r.games], r.seat])).toEqual([
      ['乙鳥', '乙鳥（2）', ['D0123456789', 'S42'], ''],
      ['丁香', '丁香（新）', [], ''],
      ['戊己', '戊己（5）', ['1397438863340998720'], '5'],
    ]);
    expect(normalizeSplitGameId('s007')).toBe('S7');
    expect(normalizeSplitGameId('M12')).toBe('');
    expect(parseSeatNameRules(null).splits).toEqual([]);
  });

  it('resolves names the way the site does: splits (ids, filters, seat) first, then aliases; empty seats stay empty', () => {
    const names = ['舊甲蟲', '乙鳥', 'ｎｏｖａ２', '丁香', '戊己', '', null, ' 壬\u200b癸\n', '子丑', '辰巳'];
    const game = { ids: ['1397438863340998720', 'D0123456789'], date: '2026-11-03', venue: '線瓦' };
    expect(resolveSeatNames(names, game, rules)).toEqual(['甲蟲王', '乙鳥（2）', 'Nova Two', '丁香（新）', '戊己（5）', '', '', '壬癸', '子丑', '辰巳']);
    // 別的局：拆分都不挑（日期早於 from、局號不在、戊己不在 5 家）。
    const other = { ids: ['S9'], date: '2026-10-01', venue: '線瓦' };
    expect(resolveSeatNames(['戊己', '乙鳥', '', '丁香', '戊己'], other, rules)).toEqual(['戊己', '乙鳥', '', '丁香', '戊己', '', '', '', '', '']);
    expect(resolveSeatNames(NAMES, other)).toEqual(NAMES);
    expect(tidySeatName('一二三四五六七八九十一二三四五六七八九十一')).toBe('一二三四五六七八九十一二三四五六七八九…');
    expect(tidySeatName(42)).toBe('');
  });

  it('game ids come from game_db (the post id plus every source id of the same game)', () => {
    const idx = gameIdIndex({ games: [{ id: 'S42', sources: [{ src: 'sheet', id: 'S42' }, { src: 'discord', id: '1397438863340998720' }, { src: 'dc_import', id: 'D0123456789' }] }] });
    expect(idx.get('1397438863340998720')).toEqual(['S42', '1397438863340998720', 'D0123456789']);
    expect(gameIdIndex(null).size).toBe(0);
  });

  it('linkSeatNames maps bank games to the linked post names; games whose post has no names are left out', () => {
    const posts = [
      { id: 'S01ABC', date: '2026-11-03', game: { names: ['', '乙鳥'], category: '線瓦' } },
      { id: 'S02ABC', game: { names: ['', '', ''] } },
      { id: 'S03ABC', game: {} },
    ];
    const ids = new Map([['S01ABC', ['S01ABC', 'S42']]]);
    const out = linkSeatNames(new Map([[0, 'S01ABC'], [1, 'S02ABC'], [2, 'S03ABC'], [3, 'S404']]), posts, rules, ids);
    expect([...out.entries()]).toEqual([[0, ['', '乙鳥（2）', '', '', '', '', '', '', '', '']]]);
  });

  it('buildSimBank with posts fills bank.names from the linked post (aliases applied); no posts → none', () => {
    const entry = bankEntryFor(parsedGame(wikiRow()), 'W0000');
    const file = { version: 1, builtFrom: 'test', games: [entry] };
    const post = wikiPost('S01ABC');
    const named = { ...post, game: { ...(post.game as object), names: ['舊甲蟲', ...NAMES.slice(1)] } };
    expect(buildSimBank(file).names.size).toBe(0);
    const bank = buildSimBank(file, [named], { rules, ids: new Map() });
    expect(bank.names.get(0)).toEqual(['甲蟲王', ...NAMES.slice(1)]);
    expect(buildSimBank(file, [post]).names.size).toBe(0);
  });

  it('reads player_aliases.json and only reads game_db.json when a split lists game ids; missing files → no rules', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-names-'));
    const aliasFile = path.join(dir, 'player_aliases.json');
    const dbFile = path.join(dir, 'game_db.json');
    fs.writeFileSync(dbFile, JSON.stringify({ games: [{ id: 'S42', sources: [{ id: 'D0123456789' }] }] }));
    fs.writeFileSync(aliasFile, JSON.stringify({ aliases: { 舊甲蟲: '甲蟲王' } }));
    expect(readSeatNameSources([aliasFile], [dbFile]).ids.size).toBe(0);
    fs.writeFileSync(aliasFile, JSON.stringify({ aliases: {}, splits: { 乙鳥: [{ as: '乙鳥（2）', games: ['S42'] }] } }));
    expect(readSeatNameSources([aliasFile], [dbFile]).ids.get('D0123456789')).toEqual(['S42', 'D0123456789']);
    const none = readSeatNameSources([path.join(dir, 'missing.json')], [dbFile]);
    expect(none.rules.aliases.size).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
