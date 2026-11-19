/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 第 53 回合：隊長視角讀法（`Viewpoint53`）的 q（好人隊長「知道一些」的比例）與 r（紅隊長帶隊友的比例），真人局最大概似（只輸出彙總數字）。
 * 每一次提議：P(T | w, 好人) / P_L(T) = (1 − q) ＋ q·[T 在真實 w 乾淨]/Z_w；紅：(1 − r) ＋ r·[T 有別的紅]/Y_w。
 *
 *   cd packages/server && npx tsx scripts/fitRound53.ts [--strong-s 55] [--limit N] [--boot 100] [--json out.json]
 */
import * as fs from 'fs';
import { buildReplayObservation, seatId } from '../src/ai/benchmark/replayObservation';
import { campOf } from '../src/ai/benchmark/sheetsReplay';
import { hideLobbyOrder } from '../src/bots/simulation/aiRead';
import { BETA_TEAM_50, proposalReads50 } from '../src/ai/Round50';
import { loadHuman } from './beliefCalibrationCurve';

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

/** One proposal: a = the indicator over Z (q / r term is a·x), i.e. log((1 − q) + q·x) with x = [clean]/Z (good) or [mate]/Y (red). */
interface Pt { g: number; strong: boolean; x: number; group: string[] }

function ll(pts: readonly Pt[], q: number): number {
  let s = 0;
  for (const p of pts) s += Math.log(Math.max((1 - q) + q * p.x, 1e-300));
  return s;
}
function fit(pts: readonly Pt[]): number {
  let best = 0;
  let bl = ll(pts, 0);
  for (let q = 0.005; q < 0.9951; q += 0.005) { const v = ll(pts, q); if (v > bl) { bl = v; best = q; } }
  // refine
  for (let q = Math.max(0, best - 0.005); q <= Math.min(0.999, best + 0.005); q += 0.0005) { const v = ll(pts, q); if (v > bl) { bl = v; best = q; } }
  return best;
}
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}
function boot(pts: readonly Pt[], n: number): [number, number, number] {
  const q0 = fit(pts);
  const by = new Map<number, Pt[]>();
  for (const p of pts) { const l = by.get(p.g) ?? []; l.push(p); by.set(p.g, l); }
  const games = [...by.keys()];
  const rnd = seeded(53);
  const qs: number[] = [];
  for (let k = 0; k < n; k++) {
    const sample: Pt[] = [];
    for (let j = 0; j < games.length; j++) sample.push(...by.get(games[Math.floor(rnd() * games.length)])!);
    qs.push(fit(sample));
  }
  qs.sort((a, b) => a - b);
  return [q0, qs[Math.floor(0.025 * n)] ?? q0, qs[Math.ceil(0.975 * n) - 1] ?? q0];
}

function main(): void {
  const strongS = Number(arg('--strong-s') ?? 55);
  const limit = Number(arg('--limit') ?? 0);
  const nb = Number(arg('--boot') ?? 100);
  const beta = Number(arg('--beta') ?? BETA_TEAM_50);
  const games = loadHuman();
  const good: Pt[] = [];
  const red: Pt[] = [];
  const started = Date.now();
  for (const [gi, { game, s }] of games.entries()) {
    if (limit && gi >= limit) break;
    const strong = s !== null && s >= strongS;
    const full = hideLobbyOrder(buildReplayObservation(game, 1, { kind: 'assassination' }));
    const reads = proposalReads50(full);
    reads.forEach((r) => {
      if (!r) return;
      const ls = Number(r.leader.replace(/\D/g, ''));
      let w = 0;
      for (let t = 1; t <= game.playerCount; t++) if (campOf(game.seatRoles[t - 1]) === 'evil') w |= r.bitOf(seatId(t));
      let mx = -Infinity;
      for (const x of r.logp) if (x > mx) mx = x;
      const e = Array.from(r.logp, (x) => Math.exp(beta * (x - mx)));
      const tot = e.reduce((a, b) => a + b, 0);
      const pl = e.map((x) => x / tot);
      const role = game.seatRoles[ls - 1];
      const group = [`R${r.round}`, r.forced ? 'forced' : 'talk', role];
      if ((w & r.bitOf(r.leader)) === 0) {
        let z = 0;
        r.masks.forEach((m, k) => { if ((w & m) === 0) z += pl[k]; });
        const clean = (w & r.actualMask) === 0;
        good.push({ g: gi, strong, x: clean && z > 0 ? 1 / z : 0, group });
      } else {
        const others = w & ~r.bitOf(r.leader);
        let y = 0;
        r.masks.forEach((m, k) => { if ((others & m) !== 0) y += pl[k]; });
        const mate = (others & r.actualMask) !== 0;
        red.push({ g: gi, strong, x: mate && y > 0 ? 1 / y : 0, group });
      }
    });
    if ((gi + 1) % 400 === 0) process.stderr.write(`${gi + 1}/${games.length} ${((Date.now() - started) / 1000).toFixed(0)}s\n`);
  }
  const out: Record<string, unknown> = { beta, games: games.length };
  const rows: [string, Pt[]][] = [
    ['q 好人隊長（全部）', good], ['q 好人隊長（強者桌）', good.filter((p) => p.strong)],
    ['q 忠臣', good.filter((p) => p.group[2] === 'loyal')], ['q 派西', good.filter((p) => p.group[2] === 'percival')], ['q 梅林', good.filter((p) => p.group[2] === 'merlin')],
    ['q 非強制', good.filter((p) => p.group[1] === 'talk')], ['q 強制', good.filter((p) => p.group[1] === 'forced')],
    ...[1, 2, 3, 4, 5].map((k) => [`q 第 ${k} 局`, good.filter((p) => p.group[0] === `R${k}`)] as [string, Pt[]]),
    ['r 紅隊長（全部）', red], ['r 紅隊長（強者桌）', red.filter((p) => p.strong)],
    ['r 非強制', red.filter((p) => p.group[1] === 'talk')], ['r 強制', red.filter((p) => p.group[1] === 'forced')],
    ...[1, 2, 3, 4, 5].map((k) => [`r 第 ${k} 局`, red.filter((p) => p.group[0] === `R${k}`)] as [string, Pt[]]),
  ];
  for (const [name, pts] of rows) {
    const [q, lo, hi] = boot(pts, nb);
    const gain = ll(pts, q) - ll(pts, 0);
    out[name] = { n: pts.length, est: q, lo, hi, llGain: gain };
    console.log(`${name}: n ${pts.length}  ${q.toFixed(3)} [${lo.toFixed(3)}, ${hi.toFixed(3)}]  對數概似 +${gain.toFixed(1)}`);
  }
  const js = arg('--json');
  if (js) fs.writeFileSync(js, JSON.stringify(out, null, 1));
}
main();
