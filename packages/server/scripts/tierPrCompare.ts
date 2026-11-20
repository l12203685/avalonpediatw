/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 第 57 回合：人類 PR 量尺（`humanPrBenchmark.ts --dump`）的兩份逐決策紀錄，分強度層 × 角色比較機器人的優勢。
 *
 *   cd packages/server && npx tsx scripts/humanPrBenchmark.ts --flag … --dump a.jsonl   （對照）
 *   cd packages/server && npx tsx scripts/humanPrBenchmark.ts --flag … --dump b.jsonl   （候選）
 *   cd packages/server && npx tsx scripts/tierPrCompare.ts a.jsonl b.jsonl [--dataset games_cache.json] [--split train|test|all]
 *
 * 每個（局, 座位）把所有決策的優勢加總（= 量尺的「總 PR」單位，勝率 pp）；Δ = 候選 − 對照（同一批決策點、同一份優勢表，人類那一邊相同），
 * 以局為集群的標準誤。另列忠臣／派西投票正確率（乾淨的隊贊成、有紅的隊反對）。強度層同 `humanProfile.ts`（S < 38／38–55／≥ 55／不明）。
 * `--split`：train = 10 人局裡偶數號的局、test = 奇數號（同 `humanProfileStudy.ts --split` 的切法）。
 * 只輸出彙總。
 */
import * as fs from 'fs';
import * as path from 'path';
import { replayGamesFromDataset } from '../src/ai/benchmark/datasetReplay';
import { campOf } from '../src/ai/benchmark/sheetsReplay';
import { strengthTierOfS } from '../src/ai/humanProfile';

interface Item { gi: number; seat: number; type: string; role: string; human: number; bot: number; idx?: number; botAction?: string }

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const files = argv.filter((a, i) => a.endsWith('.jsonl') && !(i > 0 && argv[i - 1] === '--dataset'));
const read = (f: string): Item[] => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Item);

function main(): void {
  const dataset = arg('--dataset') ?? path.resolve(__dirname, '..', 'games_cache.json');
  const games = replayGamesFromDataset(JSON.parse(fs.readFileSync(dataset, 'utf8'))).games;
  const tierOf = (gi: number): string => { const s = games[gi]?.s ?? null; return s === null ? 'unknown' : strengthTierOfS(s); };
  // 10 人局的序號（humanProfileStudy 的 loadHuman 同一個順序）→ 偶／奇數切分
  const tenIx = new Map<number, number>();
  games.forEach((g, gi) => { if (g.game.playerCount === 10) tenIx.set(gi, tenIx.size); });
  const split = arg('--split') ?? 'all';
  const keepGi = (gi: number): boolean => {
    const ix = tenIx.get(gi);
    if (ix === undefined) return false;
    return split === 'train' ? ix % 2 === 0 : split === 'test' ? ix % 2 === 1 : true;
  };
  const [a, b] = files.map(read);
  const seatSum = (xs: Item[]): Map<string, { bot: number; role: string; gi: number }> => {
    const m = new Map<string, { bot: number; role: string; gi: number }>();
    for (const x of xs) {
      if (!keepGi(x.gi)) continue;
      const k = `${x.gi}|${x.seat}`;
      const o = m.get(k) ?? { bot: 0, role: x.role, gi: x.gi };
      o.bot += x.bot;
      m.set(k, o);
    }
    return m;
  };
  const sa = seatSum(a);
  const sb = seatSum(b);
  // 局 → 格 → (Σd, n)
  const perGame = new Map<string, Map<number, { d: number; n: number }>>();
  for (const [k, va] of sa) {
    const vb = sb.get(k);
    if (!vb) continue;
    for (const cell of [`${tierOf(va.gi)}|${va.role}`, `all|${va.role}`, `${tierOf(va.gi)}|blue`, `all|blue`]) {
      if (cell.endsWith('|blue') && campOf(va.role as never) !== 'good') continue;
      const g = perGame.get(cell) ?? new Map<number, { d: number; n: number }>();
      const o = g.get(va.gi) ?? { d: 0, n: 0 };
      o.d += vb.bot - va.bot;
      o.n += 1;
      g.set(va.gi, o);
      perGame.set(cell, g);
    }
  }
  const stat = (g: Map<number, { d: number; n: number }> | undefined): { delta: number; se: number; n: number } => {
    if (!g) return { delta: 0, se: 0, n: 0 };
    const xs = [...g.values()];
    const N = xs.reduce((s, x) => s + x.n, 0);
    const D = xs.reduce((s, x) => s + x.d, 0);
    const delta = D / N;
    const ss = xs.reduce((s, x) => s + (x.d - delta * x.n) ** 2, 0);
    return { delta, se: xs.length > 1 ? Math.sqrt(ss * xs.length / (xs.length - 1)) / N : 0, n: N };
  };
  // 投票正確率（忠臣／派西）
  const voteOk = (xs: Item[]): Map<string, { ok: number; n: number }> => {
    const m = new Map<string, { ok: number; n: number }>();
    for (const x of xs) {
      if (x.type !== 'vote' || (x.role !== 'loyal' && x.role !== 'percival') || x.idx === undefined) continue;
      const g = games[x.gi]?.game;
      if (!g || !keepGi(x.gi)) continue;
      const clean = g.proposals[x.idx].teamSeats.every((s) => campOf(g.seatRoles[s - 1]) === 'good');
      const ok = (x.botAction === 'approve') === clean;
      for (const cell of [`${tierOf(x.gi)}|${x.role}`, `all|${x.role}`]) {
        const o = m.get(cell) ?? { ok: 0, n: 0 };
        o.ok += ok ? 1 : 0;
        o.n += 1;
        m.set(cell, o);
      }
    }
    return m;
  };
  const va = voteOk(a);
  const vb = voteOk(b);
  console.log(`# 人類 PR 量尺分強度層：${path.basename(files[1])} − ${path.basename(files[0])}（${split}）`, '\n');
  console.log('| 強度層 | 角色 | 座位局 | Δ 機器人優勢（pp／座位局）± 標準誤 | 忠臣／派西投票正確（對照 → 候選） |');
  console.log('|---|---|---|---|---|');
  for (const t of ['weak', 'avg', 'strong', 'unknown', 'all']) {
    for (const r of ['loyal', 'percival', 'merlin', 'blue']) {
      const s = stat(perGame.get(`${t}|${r}`));
      if (!s.n) continue;
      const x = va.get(`${t}|${r}`);
      const y = vb.get(`${t}|${r}`);
      const v = x && y ? `${((100 * x.ok) / x.n).toFixed(1)}% → ${((100 * y.ok) / y.n).toFixed(1)}%（${x.n}）` : '';
      console.log(`| ${t} | ${r} | ${s.n} | ${(100 * s.delta).toFixed(2)} ± ${(100 * s.se).toFixed(2)} | ${v} |`);
    }
  }
}

if (require.main === module) main();
