import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { loadBot, loadHuman } from './botGap';

const FIXTURE_DB = path.resolve(__dirname, '../test_fixtures/console_export/game_db.json');
// 網站數據分析的資料集（repo 裡的 games_cache.json；console_export 的 fixture 是舊格式）與同一份 game_db.json
const REPO_GAMES = path.resolve(__dirname, '../games_cache.json');
const REPO_DB = path.resolve(__dirname, '../game_db.json');

// 捏造的整局紀錄（sp.ts detail=1 的 'g' 欄）：三藍、刺中 1 家梅林。
const DETAIL = {
  c: '608731',
  r: [
    { p: [['128', '128'], ['280', '280'], ['382', '238'], ['420', '240'], ['528', '']], m: 'oox', f: '8' },
    { p: [['6120', '1260'], ['7102', '1270'], ['8170', '1780'], ['9120', '1290'], ['0129', '']], m: 'ooox', f: '0' },
    { p: [['1238', '18'], ['2380', '2380'], ['3289', '389'], ['4280', '24890'], ['5123', '']], m: 'oooo', f: '' },
    { p: [['68012', '6780'], ['71238', '7'], ['86012', '6780'], ['91235', '123459']], m: 'ooooo', f: '' },
    { p: [['01238', '780'], ['12359', '123459']], m: 'ooooo', f: '' },
  ],
  l: [['0', '8', 'o']],
  a: '1',
};

describe('botGap loaders', () => {
  it('reads selfplay results with and without the detail column', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'botgap-'));
    try {
      const cols = ['i', 'blueWon', 'threeBlue', 'merlinKilled', 'r1Failed', 'failedMissions', 'h', 'leaderRole', 't11', 'ok11', 'red5', 'red0', 'lake0', 'redLake', 'g'];
      fs.writeFileSync(path.join(dir, 'DT_1_0.json'), JSON.stringify({ meta: {}, cols, rows: [[0, 0, 1, 1, 1, 2, 'h', 'merlin', '128', 0, 0, 1, '0', 1, JSON.stringify(DETAIL)]] }));
      const cols2 = cols.slice(0, -1);
      fs.writeFileSync(path.join(dir, 'DT_1_1.json'), JSON.stringify({ meta: {}, cols: cols2, rows: [[1, 0, 0, 0, 1, 3, 'h', 'loyal', '128', 0, 1, 1, '0', 1]] }));
      fs.writeFileSync(path.join(dir, 'OTHER_1_0.json'), JSON.stringify({ meta: {}, cols: cols2, rows: [[2, 1, 1, 0, 0, 1, 'h', 'loyal', '128', 0, 0, 0, '0', 0]] }));
      const all = loadBot(dir);
      expect(all.files).toBe(3);
      expect(all.total.n).toBe(3);
      expect(all.partial).toBe(2);
      expect(all.tally.get('50')?.get('5藍0紅')?.blueDead).toBe(1);
      expect(all.tally.get('50')?.get('5紅0紅')?.red3).toBe(1);
      expect(all.tally.get('forced:R1')?.get('隊長藍·隊上有紅')?.n).toBe(1); // 只有整局紀錄進強制局格
      const dt = loadBot(dir, 'DT_');
      expect(dt.total.n).toBe(2);
      expect(dt.tally.get('50')?.get('5藍0藍')).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('site reference: the stats pages games (games_cache), details from game_db, S from the lineup', () => {
    const site = loadHuman({ ref: 'site', gamesFile: REPO_GAMES, humanFile: REPO_DB, strongS: 55 });
    expect(site.note).toContain('網站數據分析的局');
    // 網站的局幾乎都對得到可讀的牌譜（對不到的寫在 note）
    expect(site.human.length).toBeGreaterThan(2000);
    expect(site.strong.length).toBeGreaterThan(200);
    expect(site.strong.every((g) => g.s !== null && g.s >= 55)).toBe(true);
    expect(site.strong.length).toBe(site.human.filter((g) => g.s !== null && g.s >= 55).length);
  });

  it('legacy reference (--ref game_db): only readable real games from game_db, strong tables by S', () => {
    const { human, strong } = loadHuman({ ref: 'game_db', gamesFile: REPO_GAMES, humanFile: FIXTURE_DB, strongS: 45 });
    // fixture：real ok 6 局 + real warn 5 局；error／unreadable／sim 不算
    // （S178 原本是 LAKE error，#136 湖中鏈自動更正後變 ok，所以 10 → 11）
    expect(human.length).toBe(11);
    expect(strong.length).toBe(human.filter((g) => g.s !== null && g.s >= 45).length);
    expect(strong.length).toBeGreaterThan(0);
    expect(strong.length).toBeLessThan(human.length);
    expect(new Set(human.map((g) => g.outcome))).toEqual(new Set(['red3', 'blueDead', 'blueAlive']));
  });
});
