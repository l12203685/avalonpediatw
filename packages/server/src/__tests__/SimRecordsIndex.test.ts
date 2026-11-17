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
