/**
 * Threads 選局（2026-11-17，Edward：「看到未來一週 甚至一個月的文章安排 並且我可以自己選擇牌譜…盡量是S高一點的優先」）：
 *   - strength.ts：games_cache.json 的陣容強度 S 用指紋對上題庫的局；
 *   - generate.ts（pickOverride，跟自動發佈 #48 同一條路）：站長選的題號蓋過計畫、存下來（已發出）的草稿優先、
 *     已經貼出去的（11/17 36AKW-2-5）鎖住、週三選連著的局週四自動接、主題不合的選擇不用並寫進 warnings；
 *   - candidates.ts：每天的候選照 S 由高到低、只列藍方視角（刺殺題是刺客）、過去的日子鎖住；
 *   - picksFile.ts：threads_picks.json（#48 格式）與選局頁匯出、只留今天之後。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeAll, describe, expect, it, vi } from 'vitest';

// 整個題庫建池子、排 8 週：單獨跑 1–2 秒，整套測試平行跑時 CI 上會超過預設的 5 秒。
vi.setConfig({ testTimeout: 60_000 });
import { buildSimBank, readSimBankFile, type SimBank } from '../bots/simulation/bank';
import { readRecordPosts } from '../bots/simulation/recordsIndex';
import { byStrength, planDays } from '../bots/threads/candidates';
import type { ThreadsDraft } from '../bots/threads/draft';
import { ThreadsGenerator } from '../bots/threads/generate';
import { readPicksFile, savedDraftReader } from '../bots/threads/inputs';
import { futurePicks, parsePicks, pickOverrideOf, picksFileBody } from '../bots/threads/picksFile';
import { THREADS_POSTED, exerciseIdOfPick } from '../bots/threads/plan';
import { HIGH_LINEUP_S, cacheGameFingerprint, lineupIndex, lineupOf } from '../bots/threads/strength';

const serverRoot = path.resolve(__dirname, '..', '..');
let bank: SimBank;
let lineup: Map<string, number>;

beforeAll(() => {
  const file = readSimBankFile([path.join(serverRoot, 'sim_bank.json')]);
  if (!file) throw new Error('sim_bank.json missing');
  bank = buildSimBank(file, readRecordPosts([path.join(serverRoot, 'records_cache.json')]));
  lineup = lineupIndex(JSON.parse(fs.readFileSync(path.join(serverRoot, 'games_cache.json'), 'utf8')));
});

const gen = (picks: Map<string, string> = new Map(), saved: Record<string, ThreadsDraft> = {}) =>
  new ThreadsGenerator({ bank, titles: new Map(), readSaved: (d) => saved[d] ?? null, pickOverride: pickOverrideOf(picks) });

const idOn = (g: ThreadsGenerator, date: string): string | null => {
  const p = g.pickFor(date);
  const gg = p ? g.gameOf(p.gameId) : null;
  return p && gg ? exerciseIdOfPick(p, gg.game) : null;
};

describe('strength (S)', () => {
  it('cache fingerprints sort teams with 0 last and missions as o…x', () => {
    expect(cacheGameFingerprint('453968', [[1, 1, '0160', '9'], [1, 2, '962', '']], 'xo|oo|')).toBe('453968|1600,269|ox,oo');
  });

  it('most bank games get an S from games_cache.json, within 0–100', () => {
    const ss = bank.games.map((g) => lineupOf(g, lineup)).filter((s): s is number => s !== null);
    expect(ss.length).toBeGreaterThan(bank.games.length / 2);
    expect(Math.min(...ss)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...ss)).toBeLessThanOrEqual(100);
    expect(ss.some((s) => s >= HIGH_LINEUP_S)).toBe(true);
  });
});

describe('overrides', () => {
  it('the posted first puzzle stays locked even when a pick or a saved draft says otherwise', () => {
    const other = gen().optionsFor('2026-11-17').find((o) => o.exerciseId !== THREADS_POSTED['2026-11-17']);
    expect(other).toBeDefined();
    const g = gen(new Map([['2026-11-17', other!.exerciseId]]));
    expect(idOn(g, '2026-11-17')).toBe('36AKW-2-5');
  });

  it('a chosen Wednesday game that chains makes Thursday continue the same game', () => {
    const opt = gen().optionsFor('2026-11-25').find((o) => o.chained);
    expect(opt).toBeDefined();
    const g = gen(new Map([['2026-11-25', opt!.exerciseId]]));
    expect(idOn(g, '2026-11-25')).toBe(opt!.exerciseId);
    expect(idOn(g, '2026-11-26')).toBe(opt!.nextExerciseId);
    expect(g.pickFor('2026-11-26')?.continues).toBe(true);
  });

  it('a saved (already posted) draft beats a pick; a pick that does not fit the theme is ignored with a warning', () => {
    const base = gen();
    const auto = idOn(base, '2026-11-24');
    const choice = base.optionsFor('2026-11-24').find((o) => o.exerciseId !== auto)!;
    expect(idOn(gen(new Map([['2026-11-24', choice.exerciseId]])), '2026-11-24')).toBe(choice.exerciseId);
    const savedPick = base.pickFor('2026-11-24')!;
    const g = gen(new Map([['2026-11-24', choice.exerciseId]]), { '2026-11-24': { pick: savedPick } as ThreadsDraft });
    expect(idOn(g, '2026-11-24')).toBe(auto);

    const wedId = base.optionsFor('2026-11-25')[0].exerciseId; // a 1-5 puzzle on a Tuesday (派西) does not fit
    const bad = gen(new Map([['2026-11-24', wedId]]));
    expect(idOn(bad, '2026-11-24')).toBe(auto);
    expect(bad.warnings.join('\n')).toContain(wedId);
  });

  it('every listed option is accepted by pickOverride for that day', () => {
    for (const date of ['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27', '2026-11-28', '2026-11-29']) {
      for (const o of gen().optionsFor(date).slice(0, 5)) expect(idOn(gen(new Map([[date, o.exerciseId]])), date)).toBe(o.exerciseId);
    }
  });
});

describe('candidates', () => {
  it('each day lists blue viewpoints sorted by S (high first), locks today and the posted day, and labels the source', () => {
    const picked = new Map([['2026-11-24', gen().optionsFor('2026-11-24')[3].exerciseId]]);
    const plan = planDays({ gen: gen(picked), lineup, today: '2026-11-18', picked }, '2026-11-17', 14);
    expect(plan).toHaveLength(14);
    expect(plan[0]).toMatchObject({ date: '2026-11-17', source: 'posted', locked: true });
    expect(plan[1].locked).toBe(true); // 11/18 = today
    expect(plan[2].locked).toBe(false);
    expect(plan[2].source).toBe('chain'); // Thursday continues Wednesday
    expect(plan[7].source).toBe('picked');
    for (const day of plan) {
      expect(day.candidates.length).toBeGreaterThan(0);
      const roles = new Set(day.candidates.map((c) => c.role));
      if (day.weekday === 1) expect([...roles]).toEqual(['刺客']);
      else for (const r of roles) expect(['忠臣', '派西維爾', '梅林']).toContain(r);
      const top = day.candidates.slice(0, 15);
      for (let i = 1; i < top.length; i++) expect(byStrength(top[i - 1], top[i])).toBeLessThanOrEqual(0);
      for (const c of day.candidates) expect(c.high).toBe(c.s !== null && c.s >= HIGH_LINEUP_S);
      expect(JSON.stringify(day)).not.toMatch(/10\s*[家號]/);
    }
  });
});

describe('picks file', () => {
  it('reads the committed threads_picks.json format and writes it back the same way', () => {
    const m = parsePicks({ version: 1, picks: { '2026-11-19': 'K7Q2M-3-5', '2026-11-18': 'ABCDE-1-5' } });
    expect([...m]).toEqual([['2026-11-19', 'K7Q2M-3-5'], ['2026-11-18', 'ABCDE-1-5']]);
    expect(JSON.parse(picksFileBody(m))).toEqual({ version: 1, picks: { '2026-11-18': 'ABCDE-1-5', '2026-11-19': 'K7Q2M-3-5' } });
    expect(pickOverrideOf(m)('2026-11-17')).toBe('36AKW-2-5');
  });

  it('reads both shapes, drops junk, keeps only days after today', () => {
    const a = parsePicks({ '2026-11-19': 'K7Q2M-3-5', bad: 'K7Q2M-3-5', '2026-11-20': '<x>' });
    expect([...a]).toEqual([['2026-11-19', 'K7Q2M-3-5']]);
    const b = parsePicks([{ date: '2026-11-18', exerciseId: 'ABCDE-1-5' }, { id: '2026-11-23', data: { exerciseId: 'ABCDE-A' } }]);
    expect([...b]).toEqual([['2026-11-18', 'ABCDE-1-5'], ['2026-11-23', 'ABCDE-A']]);
    expect([...futurePicks(b, '2026-11-18')]).toEqual([['2026-11-23', 'ABCDE-A']]);
  });
});

describe('script inputs (threads:draft and threads:candidates read the same picks and saved drafts)', () => {
  const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'threads-inputs-'));
  const genFrom = (picksFile: string, drafts: string) =>
    new ThreadsGenerator({ bank, titles: new Map(), readSaved: savedDraftReader(drafts), pickOverride: pickOverrideOf(readPicksFile(picksFile)) });

  it("keeps a pick for today (made the day before) when there is no saved draft; a saved draft still protects what was posted", () => {
    const date = '2026-11-24';
    const base = gen();
    const auto = idOn(base, date);
    const choice = base.optionsFor(date).find((o) => o.exerciseId !== auto)!;
    const dir = tmp();
    const picksFile = path.join(dir, 'threads_picks.json');
    fs.writeFileSync(picksFile, picksFileBody(new Map([[date, choice.exerciseId]])));
    const drafts = path.join(dir, 'drafts');
    fs.mkdirSync(drafts);
    // 不論今天是哪一天（含 11/24 當天和之後），站長選的都用
    expect(readPicksFile(picksFile).get(date)).toBe(choice.exerciseId);
    expect(idOn(genFrom(picksFile, drafts), date)).toBe(choice.exerciseId);
    // 已經照自動的題目發出去（存下來了）：選擇不蓋過它
    fs.writeFileSync(path.join(drafts, `${date}.json`), JSON.stringify({ pick: base.pickFor(date) }));
    expect(idOn(genFrom(picksFile, drafts), date)).toBe(auto);
    expect(readPicksFile('')).toEqual(new Map());
  });

  it('the candidates calendar continues Thursday from the saved (published) Wednesday game, not the automatic one', () => {
    const base = gen();
    const auto = idOn(base, '2026-11-25');
    const chained = base.optionsFor('2026-11-25').find((o) => o.chained && o.exerciseId !== auto)!;
    expect(chained).toBeDefined();
    const dir = tmp();
    fs.writeFileSync(path.join(dir, '2026-11-25.json'), JSON.stringify({ pick: chained.pick }));
    const g = genFrom('', dir);
    const plan = planDays({ gen: g, lineup, today: '2026-11-25' }, '2026-11-25', 2);
    expect(plan[0].current?.exerciseId).toBe(chained.exerciseId);
    expect(plan[1]).toMatchObject({ source: 'chain', current: { exerciseId: chained.nextExerciseId } });
  });
});

describe('games table', () => {
  it('one row per bank game, S high first, mission results per round, roles per seat, Percival thumbs, puzzle types with weekdays', async () => {
    const { gamesTable } = await import('../bots/threads/gamesTable');
    const g = gen();
    const rows = gamesTable(g, lineup, '2026-11-17');
    expect(rows).toHaveLength(bank.games.length);
    const withS = rows.filter((r) => r.s !== null);
    for (let i = 1; i < withS.length; i++) expect((withS[i - 1].s as number) >= (withS[i].s as number)).toBe(true);
    for (const r of rows.slice(0, 200)) {
      expect(r.m).toHaveLength(5);
      for (const m of r.m) expect(m).toMatch(/^(o*x*)$/);
      expect(r.roles).toHaveLength(10);
      expect(['三紅', '三藍死', '三藍活']).toContain(r.res);
      const merlin = r.roles.indexOf('梅') + 1;
      const morgana = r.roles.indexOf('娜') + 1;
      const thumbs = [merlin, morgana].filter((x) => x > 0).map((x) => (x === 10 ? '0' : String(x)));
      expect(r.thumbs.split(' ').sort()).toEqual(thumbs.sort());
      for (const t of r.types) {
        expect(t.exerciseId.startsWith(r.id + '-')).toBe(true);
        expect(g.optionFor(['2026-11-22', '2026-11-23', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21'][t.weekday], t.exerciseId)).not.toBeNull();
      }
    }
    expect(JSON.stringify(rows.slice(0, 50))).not.toMatch(/10\s*[家號]/);
  });
});
