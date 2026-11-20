/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 會玩的真人桌的結果組成（第 1A-2 節的參考目標；Edward 2026-10-29：「勝率偏高的一群人玩，遊戲很難三紅作收；藍勝:紅勝約 36%:64%」）。
 *
 * 第 1G 節（2026-11-20，站長「整個系統要完全同步同來源」）起，桌的強弱照網站數據分析「陣容強度」的 S 分層算：
 * 資料 = games_cache.json（`decodeGamesDataset`，百科AI 局不算，同網站），S = 桌上 10 人開打前 PR 的平均，
 * 分層 = S_TIERS（偏弱 < 38、一般 38–55、偏強 55–65、高強度 ≥ 65）＋高端桌（S ≥ 分組的 S 上切點，預設 55）。
 * 每列和網站「陣容強度 › 依 S 分層」同一個 computeStrengthReport 的計數。
 * 舊版（同桌玩家超額勝率的四等分，sheets_cache.json，1,503 局）停用：定義和網站不同。
 *
 *   cd packages/server && npx tsx scripts/strongTableOutcomes.ts [--games games_cache.json]
 */
import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_COHORT_CUTS, computeStrengthReport, decodeGamesDataset, type OutcomeTally } from '@avalon/shared/stats';

export interface TierOutcomeRow {
  label: string;
  range: string;
  n: number;
  red3: number;
  blueDead: number;
  blueAlive: number;
}

/** 每列：局數、三紅／三藍死／三藍活、任務三藍、刺中率、藍勝（%）。 */
export function tierOutcomeRows(report: { tiers: Array<OutcomeTally & { label: string; range: string; id: string }>; overall: OutcomeTally; points: Array<{ s: number; outcome: string }> }, sHi: number = DEFAULT_COHORT_CUTS.sHi): TierOutcomeRow[] {
  const fromTally = (label: string, range: string, t: OutcomeTally): TierOutcomeRow => ({ label, range, n: t.n, red3: t.threeRed, blueDead: t.blueDead, blueAlive: t.blueAlive });
  const hiPts = report.points.filter((p) => p.s >= sHi);
  const count = (o: string): number => hiPts.filter((p) => p.outcome === o).length;
  const high: TierOutcomeRow = { label: '高端桌', range: `S ≥ ${sHi}`, n: 0, red3: count('三紅'), blueDead: count('三藍死'), blueAlive: count('三藍活') };
  high.n = high.red3 + high.blueDead + high.blueAlive;
  const tiers = [...report.tiers].reverse().map((t) => fromTally(t.label, t.range, t)); // 偏弱 → 高強度
  return [...tiers, high, fromTally('全部', '有陣容強度的局', report.overall)];
}

const pct = (a: number, b: number): string => (b ? `${((100 * a) / b).toFixed(1)}%` : '—');

export function renderTierTable(rows: readonly TierOutcomeRow[]): string {
  const L = ['| 桌別（S） | 局數 | 三紅 | 三藍死 | 三藍活 | 任務勝率（三藍） | 刺中率 | 藍勝 |', '|---|---|---|---|---|---|---|---|'];
  for (const r of rows) {
    L.push(`| ${r.label} ${r.range} | ${r.n} | ${pct(r.red3, r.n)} | ${pct(r.blueDead, r.n)} | ${pct(r.blueAlive, r.n)} | ${pct(r.blueDead + r.blueAlive, r.n)} | ${pct(r.blueDead, r.blueDead + r.blueAlive)} | ${pct(r.blueAlive, r.n)} |`);
  }
  return L.join('\n');
}

function main(): void {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--games');
  const file = i >= 0 ? argv[i + 1] : path.resolve(__dirname, '../games_cache.json');
  const decoded = decodeGamesDataset(JSON.parse(fs.readFileSync(file, 'utf8')));
  const rows = tierOutcomeRows(computeStrengthReport(decoded.games, { kind: 'tier' }));
  console.log(`網站數據分析的局 ${decoded.games.length} 局（百科AI 局不算）；有陣容強度 S 的 ${rows[rows.length - 1].n} 局`);
  console.log(renderTierTable(rows));
}

if (require.main === module) main();
