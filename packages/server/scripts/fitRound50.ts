/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 第 50 回合：`Round50` 的公開視角忠臣評分在真人局的擬合（只輸出彙總用的數字，沒有玩家名）。
 *
 *   1. 藍方殘差（`loyalRationality50` 的 `W50`）：每個忠臣座位、第 2–5 局第 1 次提議的投票點，對另外 9 人記
 *      [預設後驗 p、不合理度（提議／強制局／湖）、是不是紅] → `--out rows.csv`，擬合在 `fitRound50.py`（logistic＋局的集群自助法）。
 *   2. 派隊溫度 β（`BETA_TEAM_50`）：真人忠臣隊長、自己在隊上的每一次提議，P(隊) ∝ exp(β·log P(乾淨))，最大概似＋自助法區間。
 *   3. 湖的溫度 β（`BETA_LAKE_50`）：真人忠臣持湖者，P(目標) ∝ exp(β·湖中分數)。
 *   4. 刺殺的倍數 λ（`LAMBDA_ASSASSIN_50`）：真人刺殺點，P(候選 = 梅林) ∝ exp(預設刺殺分數 ＋ λ·對數概似比)（條件 logit；mode 1 先扣掉派票讀法）。
 *   另外報同一批決策點的不合理度分布：真紅 vs 真藍。
 *
 *   cd packages/server && npx tsx scripts/fitRound50.ts --out rows.csv [--strong-s 55] [--limit N] [--boot 200]
 */
import * as fs from 'fs';
import { DEFAULT_AGENT_TUNING } from '../src/ai/AgentTuning';
import { bayesOptionsOf, bayesRedShare } from '../src/ai/belief/BayesBelief';
import { buildReplayObservation, seatId } from '../src/ai/benchmark/replayObservation';
import { campOf } from '../src/ai/benchmark/sheetsReplay';
import { hideLobbyOrder } from '../src/bots/simulation/aiRead';
import { BETA_TEAM_50, derivabilityLogRatio50, lakeReads50, loyalLakePolicy50, proposalReads50, rationalityFeatures50, reuseSkip50 } from '../src/ai/Round50';
import { HeuristicAgent } from '../src/ai/HeuristicAgent';
import { loadHuman } from './beliefCalibrationCurve';

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

interface Choice { g: number; strong: boolean; xs: number[]; chosen: number; off?: number[] }

/** Conditional logit with one coefficient: Σ log softmax(off + b·x)[chosen]; Newton on b. */
function fitOne(cs: readonly Choice[], start = 1): number {
  let b = start;
  for (let it = 0; it < 60; it++) {
    let g = 0;
    let h = 0;
    for (const c of cs) {
      const u = c.xs.map((x, k) => (c.off ? c.off[k] : 0) + b * x);
      const mx = Math.max(...u);
      const e = u.map((v) => Math.exp(v - mx));
      const z = e.reduce((a, v) => a + v, 0);
      const p = e.map((v) => v / z);
      const m1 = p.reduce((a, v, k) => a + v * c.xs[k], 0);
      const m2 = p.reduce((a, v, k) => a + v * c.xs[k] * c.xs[k], 0);
      g += c.xs[c.chosen] - m1;
      h -= m2 - m1 * m1;
    }
    if (h >= 0) break;
    const step = g / h;
    b -= Math.max(-5, Math.min(5, step));
    if (Math.abs(step) < 1e-6) break;
  }
  return b;
}

function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

function bootCI(cs: readonly Choice[], start: number, boots: number): [number, number, number] {
  const b0 = fitOne(cs, start);
  const games = [...new Set(cs.map((c) => c.g))];
  const by = new Map<number, Choice[]>();
  for (const c of cs) { const l = by.get(c.g) ?? []; l.push(c); by.set(c.g, l); }
  const rnd = seeded(50);
  const bs: number[] = [];
  for (let k = 0; k < boots; k++) {
    const sample: Choice[] = [];
    for (let j = 0; j < games.length; j++) sample.push(...(by.get(games[Math.floor(rnd() * games.length)]) ?? []));
    bs.push(fitOne(sample, b0));
  }
  bs.sort((a, b) => a - b);
  return [b0, bs[Math.floor(0.025 * boots)] ?? b0, bs[Math.ceil(0.975 * boots) - 1] ?? b0];
}

function main(): void {
  const out = arg('--out');
  if (!out) throw new Error('--out PATH');
  const strongS = Number(arg('--strong-s') ?? 55);
  const limit = Number(arg('--limit') ?? 0);
  const boots = Number(arg('--boot') ?? 200);
  const opts = bayesOptionsOf({ ...DEFAULT_AGENT_TUNING });
  const games = loadHuman();
  const lines = ['g,strong,round,p,prop,tail,lake,red'];
  const teamCs: Choice[] = [];
  const lakeCs: Choice[] = [];
  const as1: Choice[] = [];
  const as2: Choice[] = [];
  const dist: Record<string, number[]> = {};
  const push = (k: string, v: number): void => { (dist[k] ??= []).push(v); };
  let n = 0;
  const started = Date.now();
  for (const [gi, { game, s }] of games.entries()) {
    if (limit && gi >= limit) break;
    const strong = s !== null && s >= strongS;
    const red = (seat: number): boolean => campOf(game.seatRoles[seat - 1]) === 'evil';
    // 1. residual rows
    for (let seat = 1; seat <= game.playerCount; seat++) {
      if (game.seatRoles[seat - 1] !== 'loyal') continue;
      for (const round of [2, 3, 4, 5]) {
        const i = game.proposals.findIndex((p) => p.round === round && p.attempt === 1 && !p.forced);
        if (i < 0) continue;
        const obs = hideLobbyOrder(buildReplayObservation(game, seat, { kind: 'team_vote', proposal: i }));
        const sh = bayesRedShare(obs, opts);
        const f = rationalityFeatures50(obs);
        for (let t = 1; t <= game.playerCount; t++) {
          if (t === seat) continue;
          const id = seatId(t);
          const p = sh.get(id);
          if (p === undefined || p <= 1e-9 || p >= 1 - 1e-9) continue;
          const x = f.get(id)!;
          lines.push([gi, strong ? 1 : 0, round, p.toFixed(6), x.prop.toFixed(4), x.tail.toFixed(4), x.lake.toFixed(4), red(t) ? 1 : 0].join(','));
          n++;
        }
      }
    }
    // 2–3. temperatures, from the full public record (each read is prefix-based)
    const full = hideLobbyOrder(buildReplayObservation(game, 1, { kind: 'assassination' }));
    const reads = proposalReads50(full);
    full.voteHistory.forEach((v, i) => {
      const r = reads[i];
      if (!r) return;
      const ls = Number(v.leader.replace(/\D/g, ''));
      push(`${red(ls) ? 'red' : 'blue'}|${r.forced ? 'tail' : 'prop'}`, r.d);
      if (game.seatRoles[ls - 1] !== 'loyal' || !v.team.includes(v.leader)) return;
      const k = r.masks.indexOf(r.actualMask);
      if (k < 0) return;
      teamCs.push({ g: gi, strong, xs: [...r.logp], chosen: k });
    });
    const lreads = lakeReads50(full);
    (full.lakeHistory ?? []).forEach((l, i) => {
      const r = lreads[i];
      if (!r) return;
      const hs = Number(l.holderId.replace(/\D/g, ''));
      push(`${red(hs) ? 'red' : 'blue'}|lake`, r.d);
      if (game.seatRoles[hs - 1] !== 'loyal') return;
      const ids = [...r.scores.keys()];
      lakeCs.push({ g: gi, strong, xs: ids.map((id) => r.scores.get(id)!), chosen: ids.indexOf(l.targetId) });
    });
    // 4. assassination
    if (game.assassinTargetSeat !== undefined) {
      const aSeat = game.seatRoles.findIndex((r) => r === 'assassin') + 1;
      const mSeat = game.seatRoles.findIndex((r) => r === 'merlin') + 1;
      if (aSeat > 0 && mSeat > 0) {
        const obs = hideLobbyOrder(buildReplayObservation(game, aSeat, { kind: 'assassination' }));
        const bot = new HeuristicAgent(seatId(aSeat), undefined, undefined, { ...DEFAULT_AGENT_TUNING });
        bot.onGameStart(obs);
        const ro = bot.assassinationReadout(obs);
        if (ro) {
          const reds = obs.allEvilIds ?? [];
          const cands = ro.candidates;
          const k = cands.indexOf(seatId(mSeat));
          if (k >= 0) {
            const skip = reuseSkip50(obs, (DEFAULT_AGENT_TUNING.assassinReuseRead ?? 0) >= 1);
            const tot = cands.map((id) => ro.scores.get(id) ?? 0);
            const lead = cands.map((id) => ro.terms.get(id)?.lead ?? 0);
            as1.push({ g: gi, strong, xs: cands.map((id) => derivabilityLogRatio50(obs, id, reds, 1, skip)), chosen: k, off: tot.map((x, j) => x - lead[j]) });
            as2.push({ g: gi, strong, xs: cands.map((id) => derivabilityLogRatio50(obs, id, reds, 2, skip)), chosen: k, off: tot });
          }
        }
      }
    }
    if ((gi + 1) % 200 === 0) process.stderr.write(`${gi + 1}/${games.length} ${((Date.now() - started) / 1000).toFixed(0)}s\n`);
  }
  fs.writeFileSync(out, lines.join('\n') + '\n');
  const summary: Record<string, unknown> = { rows: n, games: games.length };
  for (const [name, cs, start] of [['betaTeam', teamCs, BETA_TEAM_50], ['betaLake', lakeCs, 1]] as const) {
    summary[name] = {
      strong: { n: cs.filter((c) => c.strong).length, est: bootCI(cs.filter((c) => c.strong), start, boots) },
      all: { n: cs.length, est: bootCI(cs, start, boots) },
    };
  }
  for (const [name, cs] of [['lambdaAssassin1', as1], ['lambdaAssassin2', as2]] as const) {
    const hit = (c: Choice, b: number): number => {
      const u = c.xs.map((x, k) => (c.off ? c.off[k] : 0) + b * x);
      return u.indexOf(Math.max(...u)) === c.chosen ? 1 : 0;
    };
    const rate = (xs: readonly Choice[], b: number): number => xs.reduce((a, c) => a + hit(c, b), 0) / Math.max(1, xs.length);
    const st = cs.filter((c) => c.strong);
    const fs1 = bootCI(st, 0.5, boots);
    const fa = bootCI(cs, 0.5, boots);
    summary[name] = {
      strong: { n: st.length, est: fs1, hit0: rate(st, 0), hitFit: rate(st, fs1[0]), hit1: rate(st, 1) },
      all: { n: cs.length, est: fa, hit0: rate(cs, 0), hitFit: rate(cs, fa[0]), hit1: rate(cs, 1) },
    };
  }
  const q = (xs: number[], p: number): number => { const a = [...xs].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(p * a.length))] ?? 0; };
  summary.deficit = Object.fromEntries(Object.entries(dist).map(([k, xs]) => [k, { n: xs.length, mean: xs.reduce((a, b) => a + b, 0) / xs.length, zero: xs.filter((x) => x < 1e-9).length / xs.length, p90: q(xs, 0.9) }]));
  void loyalLakePolicy50;
  console.log(JSON.stringify(summary, null, 1));
}
main();
