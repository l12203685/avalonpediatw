import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { computeStrengthReport, decodeGamesDataset } from '@avalon/shared/stats';
import { renderTierTable, tierOutcomeRows } from './strongTableOutcomes';

describe('strongTableOutcomes（第 1A-2 節，照網站的 S 分層）', () => {
  it('合成資料：分層、高端桌、全部', () => {
    const tally = (n: number, a: number, b: number, c: number) => ({ n, threeRed: a, blueDead: b, blueAlive: c });
    const report = {
      tiers: [
        { id: 'high', label: '高強度', range: 'S ≥ 65', ...tally(2, 1, 0, 1) },
        { id: 'strong', label: '偏強', range: '55 ≤ S < 65', ...tally(1, 0, 1, 0) },
        { id: 'normal', label: '一般', range: '38 ≤ S < 55', ...tally(0, 0, 0, 0) },
        { id: 'weak', label: '偏弱', range: 'S < 38', ...tally(1, 1, 0, 0) },
      ],
      overall: tally(4, 2, 1, 1),
      points: [{ s: 70, outcome: '三紅' }, { s: 66, outcome: '三藍活' }, { s: 60, outcome: '三藍死' }, { s: 20, outcome: '三紅' }],
    };
    const rows = tierOutcomeRows(report);
    expect(rows.map((r) => [r.label, r.n])).toEqual([['偏弱', 1], ['一般', 0], ['偏強', 1], ['高強度', 2], ['高端桌', 3], ['全部', 4]]);
    expect(rows[4]).toMatchObject({ range: 'S ≥ 55', red3: 1, blueDead: 1, blueAlive: 1 });
    const md = renderTierTable(rows);
    expect(md).toContain('| 高端桌 S ≥ 55 | 3 | 33.3% | 33.3% | 33.3% | 66.7% | 50.0% | 33.3% |');
    expect(md).toContain('| 一般 38 ≤ S < 55 | 0 | — |');
  });

  it('repo 的 games_cache.json：高端桌 = 偏強 + 高強度，全部 = 陣容強度的「全部」', () => {
    const decoded = decodeGamesDataset(JSON.parse(fs.readFileSync(path.resolve(__dirname, '../games_cache.json'), 'utf8')));
    const report = computeStrengthReport(decoded.games, { kind: 'tier' });
    const rows = tierOutcomeRows(report);
    const by = (l: string) => rows.find((r) => r.label === l)!;
    expect(by('高端桌').n).toBe(by('偏強').n + by('高強度').n);
    expect(by('全部').n).toBe(report.overall.n);
  });
});
