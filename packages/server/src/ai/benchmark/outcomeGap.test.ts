import { describe, expect, it } from 'vitest';
import {
  addGame,
  buildGapReport,
  compareReports,
  FAMILIES,
  forcedCell,
  gameFromBotDetail,
  gameFromBotSummary,
  gameFromDb,
  lake1Cell,
  missionFailed,
  newTally,
  parseConfig,
  renderMarkdown,
  scoreCell,
  tallyGames,
  totals,
  tvDistance,
  tvNoise,
  wilson,
  type BotDetail,
  type DbGame,
  type GapGame,
  type Outcome,
} from './outcomeGap';

// 機器人整局紀錄（sp.ts detail=1 的 'g' 欄格式；座位、隊伍是捏造的）。
const BOT: BotDetail = {
  c: '608731', // 刺客 6、莫甘娜 0、莫德雷德 8、奧伯倫 7、派西 3、梅林 1
  r: [
    { p: [['128', '128'], ['280', '280'], ['382', '238'], ['420', '240'], ['528', '']], m: 'oox', f: '8' },
    { p: [['6120', '1260'], ['7102', '1270'], ['8170', '1780'], ['9120', '1290'], ['0129', '']], m: 'ooox', f: '0' },
    { p: [['1238', '18'], ['2380', '2380'], ['3289', '389'], ['4280', '24890'], ['5123', '']], m: 'oooo', f: '' },
    { p: [['68012', '6780'], ['71238', '7'], ['86012', '6780'], ['91235', '123459']], m: 'ooooo', f: '' },
    { p: [['01238', '780'], ['12359', '123459']], m: 'ooooo', f: '' },
  ],
  l: [['0', '8', 'o'], ['8', '6', ''], ['6', '2', 'o']],
  a: '1',
};

// game_db 實戰局（捏造的座位與隊伍）。
const DB: DbGame = {
  kind: 'real', status: 'ok', s: 60,
  game: {
    config: '430567', // 刺客 4、莫甘娜 3、莫德雷德 0、奧伯倫 5、派西 6、梅林 7
    rounds: [
      { proposals: [{ team: '160' }], mission: 'oox' },
      { proposals: [{ team: '2356' }], mission: 'ooxx' },
      { proposals: [{ team: '1369' }], mission: 'ooox' },
    ],
    lakes: [{ after: 2, holder: '0', target: '5', claim: 'o' }],
    assassination: '',
    outcome: '三紅',
  },
};

function fake(outcome: Outcome, red5: boolean, red0: boolean, s: number | null = null): GapGame {
  return { outcome, s, red5, red0, roles: null, rounds: null, lake1: null };
}

describe('parsing', () => {
  it('parses a config into seat roles and rejects bad configs', () => {
    const r = parseConfig('608731');
    expect(r?.['6']).toBe('assassin');
    expect(r?.['1']).toBe('merlin');
    expect(r?.['5']).toBe('loyal');
    expect(parseConfig('608736')).toBeNull();
    expect(parseConfig('60873')).toBeNull();
    expect(parseConfig('6087a1')).toBeNull();
  });

  it('needs two fails on round 4 only', () => {
    expect(missionFailed(4, 'oooox')).toBe(false);
    expect(missionFailed(4, 'oooxx')).toBe(true);
    expect(missionFailed(3, 'ooox')).toBe(true);
    expect(missionFailed(1, 'ooo')).toBe(false);
  });

  it('reads a bot detail record: outcome, 5/0, forced proposals, score, first lake', () => {
    const g = gameFromBotDetail(BOT)!;
    expect(g.outcome).toBe('blueDead'); // 三藍、刺中 1 家梅林
    expect(g.red5).toBe(false);
    expect(g.red0).toBe(true);
    expect(forcedCell(g, 1)).toBe('隊長藍·隊上有紅'); // 5 家忠臣，528 帶莫德雷德
    expect(forcedCell(g, 2)).toBe('隊長紅·隊上有紅'); // 0 家莫甘娜
    expect(forcedCell(g, 3)).toBe('隊長藍·隊上無紅'); // 全局第 15 次提議 = 5 家，5123 乾淨
    expect(forcedCell(g, 4)).toBe('沒走到第5次');
    expect(forcedCell(g, 6)).toBeNull();
    expect(scoreCell(g, 1)).toBe('0:1');
    expect(scoreCell(g, 2)).toBe('0:2');
    expect(scoreCell(g, 3)).toBe('1:2');
    expect(lake1Cell(g)).toBe('持湖紅·驗到紅·說藍');
    expect(lake1Cell(g, false)).toBe('驗到紅·說藍');
  });

  it('marks blue alive when the assassin misses and rejects unfinished games', () => {
    expect(gameFromBotDetail({ ...BOT, a: '2' })!.outcome).toBe('blueAlive');
    expect(gameFromBotDetail({ ...BOT, r: BOT.r.slice(0, 2) })).toBeNull();
    expect(gameFromBotDetail({ ...BOT, c: 'xx' })).toBeNull();
  });

  it('reads a game_db game and filters non-real, external, unreadable and inconsistent ones', () => {
    const g = gameFromDb(DB)!;
    expect(g.outcome).toBe('red3');
    expect(g.s).toBe(60);
    expect(g.red5).toBe(true); // 奧伯倫
    expect(g.red0).toBe(true); // 莫德雷德
    expect(lake1Cell(g)).toBe('持湖紅·驗到紅·說藍');
    expect(forcedCell(g, 1)).toBe('沒走到第5次');
    expect(gameFromDb({ ...DB, kind: 'sim' })).toBeNull();
    expect(gameFromDb({ ...DB, status: 'error' })).toBeNull();
    expect(gameFromDb({ ...DB, external: true })).toBeNull();
    expect(gameFromDb({ ...DB, game: null })).toBeNull();
    expect(gameFromDb({ ...DB, game: { ...DB.game!, outcome: '三藍活' } })).toBeNull();
    expect(gameFromDb({ ...DB, game: { ...DB.game!, lakes: [{ holder: '0', target: '5', claim: '?' }] } })!.lake1?.claim).toBe('');
  });

  it('falls back to the summary columns when a row has no detail', () => {
    const cols = ['i', 'blueWon', 'threeBlue', 'merlinKilled', 'red5', 'red0', 'redLake', 'lkT', 'lkTRed', 'lkClaim'];
    const g = gameFromBotSummary([0, 0, 1, 1, 1, 0, 0, '3', 1, 'x'], cols)!;
    expect(g.outcome).toBe('blueDead');
    expect(g.red5).toBe(true);
    expect(g.roles).toBeNull();
    expect(lake1Cell(g)).toBe('持湖藍·驗到紅·說紅');
    expect(forcedCell(g, 1)).toBeNull();
    expect(gameFromBotSummary([0, 0, 0, 0, 0, 0], ['i', 'blueWon', 'threeBlue', 'merlinKilled', 'red5', 'red0'])!.lake1).toBeNull();
    expect(gameFromBotSummary([0, 1], ['i', 'blueWon'])).toBeNull();
  });
});

describe('statistics', () => {
  it('computes Wilson intervals', () => {
    const r = wilson(5, 10);
    expect(r.rate).toBe(0.5);
    expect(r.lo).toBeCloseTo(0.2366, 3);
    expect(r.hi).toBeCloseTo(0.7634, 3);
    expect(Number.isNaN(wilson(0, 0).rate)).toBe(true);
  });

  it('computes total variation and a noise floor that shrinks with n', () => {
    const a = { n: 4, red3: 2, blueDead: 0, blueAlive: 2 };
    const b = { n: 2, red3: 0, blueDead: 1, blueAlive: 1 };
    expect(tvDistance(a, b)).toBeCloseTo(0.5, 10);
    expect(tvDistance(a, a)).toBe(0);
    expect(Number.isNaN(tvDistance(a, { n: 0, red3: 0, blueDead: 0, blueAlive: 0 }))).toBe(true);
    const small = tvNoise({ n: 50, red3: 25, blueDead: 10, blueAlive: 15 }, { n: 1000, red3: 500, blueDead: 200, blueAlive: 300 });
    const big = tvNoise({ n: 500, red3: 250, blueDead: 100, blueAlive: 150 }, { n: 1000, red3: 500, blueDead: 200, blueAlive: 300 });
    expect(small).toBeGreaterThan(big);
    expect(big).toBeGreaterThan(0);
  });
});

describe('report', () => {
  const fam50 = FAMILIES.filter((f) => f.id === '50');
  const opts = { minBot: 1, minRef: 1, top: 5 };
  const bot = [fake('red3', false, false), fake('red3', false, false), fake('blueAlive', false, false), fake('blueAlive', false, false), fake('red3', true, true), fake('red3', true, true)];
  const human = [fake('blueAlive', false, false, 70), fake('blueDead', false, false, 40), fake('red3', true, true, 60), fake('red3', true, true, 30)];
  const strong = human.filter((g) => g.s !== null && g.s >= 55);

  function build(b: GapGame[]): ReturnType<typeof buildGapReport> {
    return buildGapReport(
      { bot: tallyGames(b, fam50), human: tallyGames(human, fam50), strong: tallyGames(strong, fam50) },
      { bot: totals(b), human: totals(human), strong: totals(strong) },
      { label: 'fixture', strongS: 55 },
      opts,
      fam50,
    );
  }

  it('weights each cell by its human frequency', () => {
    const r = build(bot);
    const f = r.families[0];
    expect(f.id).toBe('50');
    const blue = f.cells.find((c) => c.cell === '5藍0藍')!;
    const red = f.cells.find((c) => c.cell === '5紅0紅')!;
    expect(blue.bot.n).toBe(4);
    expect(blue.human.n).toBe(2);
    expect(blue.tvHuman).toBeCloseTo(0.5, 10);
    expect(red.tvHuman).toBe(0);
    expect(f.dHuman).toBeCloseTo(0.25, 10); // ½ × 0.5 + ½ × 0
    expect(r.summary.dHuman).toBeCloseTo(0.25, 10);
    expect(blue.metrics.missionBlue.bot.rate).toBe(0.5);
    expect(blue.metrics.missionBlue.human.rate).toBe(1);
    expect(blue.metrics.missionBlue.gapHuman).toBe(-0.5);
    // 強者：5藍0藍 一局三藍活、5紅0紅 一局三紅 → TV 0.5 與 0
    expect(blue.strong.n).toBe(1);
    expect(f.dStrong).toBeCloseTo(0.25, 10);
    expect(r.topHuman[0].cell).toBe('5藍0藍');
    expect(r.topHuman[0].weightedHuman).toBeCloseTo(0.25, 10);
  });

  it('leaves cells the bot never reaches out of the distance and reports them as uncovered', () => {
    const r = build(bot.filter((g) => !g.red5));
    const f = r.families[0];
    expect(f.uncoveredHuman).toBeCloseTo(0.5, 10);
    expect(f.massHuman).toBeCloseTo(0.5, 10);
    expect(f.dHuman).toBeCloseTo(0.5, 10);
  });

  it('gates a candidate against a baseline', () => {
    const base = build(bot);
    const same = compareReports(base, build(bot));
    expect(same.pass).toBe(true);
    expect(same.deltaHuman).toBe(0);
    const better = build([fake('blueAlive', false, false), fake('blueDead', false, false), fake('red3', true, true)]);
    const worse = compareReports(better, base);
    expect(worse.pass).toBe(false);
    expect(worse.deltaHuman).toBeCloseTo(0.25, 10);
    expect(worse.worsened[0].cell).toBe('5藍0藍');
    const md = renderMarkdown(base, { base: better, result: worse });
    expect(md).toContain('## 關卡');
    expect(md).toContain('不過');
    expect(md).toContain('5藍0藍');
  });

  it('tallies every family from a full record', () => {
    const t = newTally();
    addGame(t, gameFromBotDetail(BOT)!);
    expect(t.get('50')?.get('5藍0紅')?.n).toBe(1);
    expect(t.get('forced:R2')?.get('隊長紅·隊上有紅')?.blueDead).toBe(1);
    expect(t.get('role:1')?.get('梅林')?.n).toBe(1);
    expect(t.get('role:0')?.get('莫甘娜')?.n).toBe(1);
    expect(t.get('50×lake1')?.get('5藍0紅·驗到紅·說藍')?.n).toBe(1);
    expect(t.get('50×score:R2')?.get('5藍0紅·0:2')?.n).toBe(1);
  });
});
