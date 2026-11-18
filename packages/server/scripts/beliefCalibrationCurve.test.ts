import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { summarize } from '../src/ai/benchmark/calibration';
import { evalGame, loadHuman, newStore, pick, variants } from './beliefCalibrationCurve';

const FIXTURE = path.resolve(__dirname, '../test_fixtures/console_export/games_cache.json');

describe('belief calibration curve on fixture games', () => {
  it('collects one point per (blue seat, vote point, other seat) for every variant', () => {
    const games = loadHuman(FIXTURE);
    expect(games.length).toBeGreaterThan(0);
    const vs = variants();
    expect(vs.map((v) => v.name)).toEqual(['預設', '均分']);
    const st = newStore();
    for (const g of games) evalGame(g.game, false, vs, new Set(['loyal', 'percival', 'merlin']), st);
    expect(st.games).toBe(games.length);
    expect(st.points).toBeGreaterThan(0);
    for (const v of ['預設', '均分']) {
      const all = pick(st, (vv) => vv === v);
      const n = all.n.reduce((a, b) => a + b, 0);
      expect(n).toBe(st.points * 9); // 每個點對另外 9 人
      const s = summarize(pick(st, (vv, _w, _r, _s, c) => vv === v && c === 'u'));
      expect(s.meanP).toBeGreaterThan(0);
      expect(s.meanP).toBeLessThan(1);
    }
    // 梅林看得到莫德雷德以外的紅：一定有確定點
    const certain = pick(st, (vv, w, _r, _s, c) => vv === '預設' && w === 'merlin' && c === 'c');
    if (games.some((g) => g.game.seatRoles.includes('merlin'))) expect(certain.n.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    for (const k of Object.keys(st.certainWrongConvention)) expect(st.certainWrongConvention[k]).toBeLessThanOrEqual(st.certainWrong[k]);
  });

  it('only uses the requested viewers', () => {
    const games = loadHuman(FIXTURE);
    const st = newStore();
    for (const g of games) evalGame(g.game, true, variants(), new Set(['loyal']), st);
    expect(Object.keys(st.acc).every((k) => k.split('|')[1] === 'loyal' && k.split('|')[3] === 'S')).toBe(true);
  });
});
