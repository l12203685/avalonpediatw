/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * Assassin target model — train + evaluate the conditional-logit model in
 * `src/ai/assassin/AssassinModel.ts` on the logged 10-player games.
 *
 *   pnpm --filter @avalon/server exec tsx scripts/assassinModel.ts \
 *     [--write] [--json out.json] [--cache PATH] [--train-share 0.7] \
 *     [--l2 auto|VALUE] [--folds 5] [--iters 3000]
 *
 * Data: every replayable game (`parseReplayGame`) that reached three blue
 * and has a recorded assassination target. Label = the real Merlin seat;
 * inputs = the assassin's own observation at the assassination phase
 * (`buildReplayObservation`), i.e. public history + the assassin's known
 * allies + the full evil roster (used only to exclude candidates).
 *
 * Split: game id hashed (FNV-1a) mod 100 < 70·share → train, else test.
 * Fixed, so every run sees the same split.
 *
 * Model: P(c = Merlin) ∝ exp(w · x_c) over the good candidates of a game.
 * Features are standardised on the training rows; w is fitted by
 * full-batch Adam on the mean negative log-likelihood + (λ/2)‖w‖²; λ is
 * chosen by k-fold cross-validation on the training games (log-lik).
 * The standardisation is folded into the stored weights.
 *
 * Baselines on the same test games: random (1 / #candidates), the rule
 * baseline of the agreement benchmark, the current HeuristicAgent (legacy
 * tuning, replayed exactly as the agreement benchmark does), the agent
 * with `assassinModel` on and the freshly fitted weights injected (so the
 * line tracks this run's fit, not the weights file on disk), and the human
 * assassin. `--write` regenerates `src/ai/assassin/assassinModelWeights.ts`.
 */

import * as fs from 'fs';
import * as path from 'path';
import { HeuristicAgent } from '../src/ai/HeuristicAgent';
import { LEGACY_AGENT_TUNING } from '../src/ai/AgentTuning';
import {
  ASSASSIN_FEATURE_NAMES,
  assassinCandidateFeatures,
  pickAssassinTargetByModel,
  type AssassinModelWeights,
} from '../src/ai/assassin/AssassinModel';
import { replaySeat, ruleAssassinate } from '../src/ai/benchmark/agreement';
import { buildReplayObservation, seatId, seatOfId } from '../src/ai/benchmark/replayObservation';
import { campOf, parseReplayGame, rowsFromSheet, type ReplayGame } from '../src/ai/benchmark/sheetsReplay';

interface Args {
  write: boolean;
  json?: string;
  cache: string;
  trainShare: number;
  l2: number | 'auto';
  folds: number;
  iters: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    write: false,
    cache: path.resolve(__dirname, '..', 'sheets_cache.json'),
    trainShare: 0.7,
    l2: 'auto',
    folds: 5,
    iters: 3000,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case '--write': args.write = true; break;
      case '--json': args.json = next(); break;
      case '--cache': args.cache = path.resolve(next()); break;
      case '--train-share': args.trainShare = Number.parseFloat(next()); break;
      case '--l2': { const v = next(); args.l2 = v === 'auto' ? 'auto' : Number.parseFloat(v); break; }
      case '--folds': args.folds = Number.parseInt(next(), 10); break;
      case '--iters': args.iters = Number.parseInt(next(), 10); break;
      case '--help': case '-h':
        console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
        process.exit(0);
        break;
      default: throw new Error(`unknown argument ${a}`);
    }
  }
  return args;
}

// ── Data ───────────────────────────────────────────────────────

function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

interface Example {
  game: ReplayGame;
  assassinSeat: number;
  merlinSeat: number;
  humanSeat: number;
  /** Candidate ids (good seats), seat order. */
  candidates: string[];
  /** rows[i] = features of candidates[i]. */
  rows: number[][];
  /** Index of Merlin in `candidates`. */
  label: number;
  bucket: number;
}

function buildExample(game: ReplayGame): Example | null {
  if (game.assassinTargetSeat === undefined) return null;
  const assassinSeat = game.seatRoles.indexOf('assassin') + 1;
  const merlinSeat = game.seatRoles.indexOf('merlin') + 1;
  if (assassinSeat === 0 || merlinSeat === 0) return null;
  const obs = buildReplayObservation(game, assassinSeat, { kind: 'assassination' });
  const candidates = game.seatRoles
    .map((r, i) => ({ r, id: seatId(i + 1) }))
    .filter(({ r }) => campOf(r) === 'good')
    .map(({ id }) => id);
  const rows = candidates.map((id) => assassinCandidateFeatures(obs, id));
  return {
    game,
    assassinSeat,
    merlinSeat,
    humanSeat: game.assassinTargetSeat,
    candidates,
    rows,
    label: candidates.indexOf(seatId(merlinSeat)),
    bucket: fnv1a(`assassin|${game.id}`) % 100,
  };
}

// ── Model ──────────────────────────────────────────────────────

interface Standardiser {
  mean: number[];
  std: number[];
}

function fitStandardiser(examples: readonly Example[]): Standardiser {
  const d = ASSASSIN_FEATURE_NAMES.length;
  const mean = new Array<number>(d).fill(0);
  const std = new Array<number>(d).fill(0);
  let n = 0;
  for (const ex of examples) for (const row of ex.rows) {
    n++;
    for (let j = 0; j < d; j++) mean[j] += row[j];
  }
  for (let j = 0; j < d; j++) mean[j] /= Math.max(1, n);
  for (const ex of examples) for (const row of ex.rows) {
    for (let j = 0; j < d; j++) std[j] += (row[j] - mean[j]) ** 2;
  }
  for (let j = 0; j < d; j++) {
    std[j] = Math.sqrt(std[j] / Math.max(1, n - 1));
    if (!(std[j] > 1e-9)) std[j] = 1;
  }
  return { mean, std };
}

function standardise(ex: Example, s: Standardiser): number[][] {
  return ex.rows.map((row) => row.map((v, j) => (v - s.mean[j]) / s.std[j]));
}

function softmax(scores: readonly number[]): number[] {
  const max = Math.max(...scores);
  const exps = scores.map((v) => Math.exp(v - max));
  const z = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / z);
}

function dot(w: readonly number[], x: readonly number[]): number {
  let s = 0;
  for (let i = 0; i < w.length; i++) s += w[i] * x[i];
  return s;
}

/** Conditional logit by full-batch Adam. Returns standardised-scale weights. */
function train(xs: readonly number[][][], labels: readonly number[], l2: number, iters: number): number[] {
  const d = ASSASSIN_FEATURE_NAMES.length;
  const n = xs.length;
  const w = new Array<number>(d).fill(0);
  const m = new Array<number>(d).fill(0);
  const v = new Array<number>(d).fill(0);
  const lr = 0.05, b1 = 0.9, b2 = 0.999, eps = 1e-8;
  for (let t = 1; t <= iters; t++) {
    const grad = new Array<number>(d).fill(0);
    for (let g = 0; g < n; g++) {
      const rows = xs[g];
      const p = softmax(rows.map((row) => dot(w, row)));
      const y = labels[g];
      for (let c = 0; c < rows.length; c++) {
        const coef = (c === y ? 1 : 0) - p[c];
        for (let j = 0; j < d; j++) grad[j] -= coef * rows[c][j];
      }
    }
    for (let j = 0; j < d; j++) {
      const gj = grad[j] / n + l2 * w[j];
      m[j] = b1 * m[j] + (1 - b1) * gj;
      v[j] = b2 * v[j] + (1 - b2) * gj * gj;
      const mh = m[j] / (1 - b1 ** t);
      const vh = v[j] / (1 - b2 ** t);
      w[j] -= (lr * mh) / (Math.sqrt(vh) + eps);
    }
  }
  return w;
}

interface Eval {
  n: number;
  hits: number;
  top2: number;
  /** Mean log P(Merlin). */
  logLik: number;
  wilson: { rate: number; low: number; high: number };
}

function wilson(k: number, n: number): { rate: number; low: number; high: number } {
  if (n === 0) return { rate: 0, low: 0, high: 0 };
  const z = 1.959964;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { rate: p, low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

function evaluate(w: readonly number[], xs: readonly number[][][], labels: readonly number[]): Eval {
  let hits = 0, top2 = 0, logLik = 0;
  for (let g = 0; g < xs.length; g++) {
    const scores = xs[g].map((row) => dot(w, row));
    const p = softmax(scores);
    const y = labels[g];
    logLik += Math.log(Math.max(p[y], 1e-12));
    const order = scores.map((s, i) => ({ s, i })).sort((a, b) => b.s - a.s || a.i - b.i);
    if (order[0].i === y) hits++;
    if (order[0].i === y || order[1]?.i === y) top2++;
  }
  const n = xs.length;
  return { n, hits, top2, logLik: n === 0 ? 0 : logLik / n, wilson: wilson(hits, n) };
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function fmtEval(e: Eval): string {
  return `${pct(e.wilson.rate)} [${pct(e.wilson.low)}, ${pct(e.wilson.high)}] (${e.hits}/${e.n}; top-2 ${pct(e.n === 0 ? 0 : e.top2 / e.n)}; mean log-lik ${e.logLik.toFixed(3)})`;
}

// ── Baselines ──────────────────────────────────────────────────

interface BaselineHits {
  human: number;
  random: number;
  rule: number;
  agentLegacy: number;
  agentModel: number;
}

/**
 * `model` = the weights just fitted in this run; the "model" agent replay
 * injects them into `HeuristicAgent`, so the number does not depend on
 * what `assassinModelWeights.ts` held when the process started.
 */
function baselineHits(examples: readonly Example[], model: AssassinModelWeights): BaselineHits {
  let human = 0, random = 0, rule = 0, agentLegacy = 0, agentModel = 0;
  const variants = [
    ['legacy', { ...LEGACY_AGENT_TUNING }, undefined],
    ['model', { ...LEGACY_AGENT_TUNING, assassinModel: true }, model],
  ] as const;
  for (const ex of examples) {
    if (ex.humanSeat === ex.merlinSeat) human++;
    random += 1 / ex.candidates.length;
    const obs = buildReplayObservation(ex.game, ex.assassinSeat, { kind: 'assassination' });
    if (seatOfId(ruleAssassinate(obs)) === ex.merlinSeat) rule++;
    for (const [variant, tuning, weights] of variants) {
      const outcomes = replaySeat(ex.game, ex.assassinSeat, {
        makeAgent: (id) => new HeuristicAgent(id, undefined, undefined, tuning, weights),
      });
      const shot = outcomes.find((o) => o.type === 'assassinate');
      if (shot?.agentHitMerlin) {
        if (variant === 'legacy') agentLegacy++; else agentModel++;
      }
    }
  }
  return { human, random, rule, agentLegacy, agentModel };
}

// ── Main ───────────────────────────────────────────────────────

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const started = Date.now();
  const data = JSON.parse(fs.readFileSync(args.cache, 'utf8')) as Record<string, string[][]>;
  const rows = rowsFromSheet(data['牌譜'] ?? []);
  let replayable = 0;
  const examples: Example[] = [];
  for (const row of rows) {
    if (!(row['文字記錄'] ?? '').trim()) continue;
    const res = parseReplayGame(row);
    if (!res.ok) continue;
    replayable++;
    const ex = buildExample(res.game);
    if (ex) examples.push(ex);
  }
  const trainCut = Math.round(args.trainShare * 100);
  const trainSet = examples.filter((e) => e.bucket < trainCut);
  const testSet = examples.filter((e) => e.bucket >= trainCut);
  console.log(`replayable games ${replayable}; with assassination ${examples.length}; train ${trainSet.length}; test ${testSet.length}`);

  const scaler = fitStandardiser(trainSet);
  const xTrain = trainSet.map((e) => standardise(e, scaler));
  const yTrain = trainSet.map((e) => e.label);
  const xTest = testSet.map((e) => standardise(e, scaler));
  const yTest = testSet.map((e) => e.label);

  // λ by k-fold CV on the training games (fold = hash bucket).
  let l2 = typeof args.l2 === 'number' ? args.l2 : 0.01;
  const cvRows: Array<{ l2: number; logLik: number; hit: number }> = [];
  if (args.l2 === 'auto') {
    const grid = [0.001, 0.003, 0.01, 0.03, 0.1, 0.3, 1];
    let best = { l2: grid[0], logLik: Number.NEGATIVE_INFINITY };
    for (const lam of grid) {
      let ll = 0, hits = 0, n = 0;
      for (let f = 0; f < args.folds; f++) {
        const foldOf = (e: Example): number => fnv1a(`fold|${e.game.id}`) % args.folds;
        const trIdx: number[] = [];
        const vaIdx: number[] = [];
        trainSet.forEach((e, i) => (foldOf(e) === f ? vaIdx : trIdx).push(i));
        const w = train(trIdx.map((i) => xTrain[i]), trIdx.map((i) => yTrain[i]), lam, args.iters);
        const ev = evaluate(w, vaIdx.map((i) => xTrain[i]), vaIdx.map((i) => yTrain[i]));
        ll += ev.logLik * ev.n;
        hits += ev.hits;
        n += ev.n;
      }
      const row = { l2: lam, logLik: ll / n, hit: hits / n };
      cvRows.push(row);
      console.log(`  cv λ=${lam}: mean log-lik ${row.logLik.toFixed(4)}, hit ${pct(row.hit)}`);
      if (row.logLik > best.logLik) best = { l2: lam, logLik: row.logLik };
    }
    l2 = best.l2;
    console.log(`chosen λ=${l2}`);
  }

  const w = train(xTrain, yTrain, l2, args.iters);
  const trainEval = evaluate(w, xTrain, yTrain);
  const testEval = evaluate(w, xTest, yTest);

  // Fold the standardisation into raw-scale weights (bias cancels in softmax).
  const rawWeights = w.map((wj, j) => wj / scaler.std[j]);
  const model: AssassinModelWeights = {
    version: `2026-10-12 sheets_cache ${examples.length} games (train ${trainSet.length}), λ=${l2}`,
    features: [...ASSASSIN_FEATURE_NAMES],
    weights: rawWeights.map((x) => Number(x.toFixed(6))),
  };
  // Sanity: raw-scale model picks the same target as the standardised one.
  let agreeRaw = 0;
  for (const ex of testSet) {
    const obs = buildReplayObservation(ex.game, ex.assassinSeat, { kind: 'assassination' });
    const target = pickAssassinTargetByModel(obs, ex.candidates, model);
    const scores = standardise(ex, scaler).map((row) => dot(w, row));
    const best = scores.map((s, i) => ({ s, i })).sort((a, b) => b.s - a.s || a.i - b.i)[0].i;
    if (ex.candidates[best] === target) agreeRaw++;
  }

  if (args.write) {
    const file = path.resolve(__dirname, '..', 'src', 'ai', 'assassin', 'assassinModelWeights.ts');
    const body = [
      '/**',
      ' * 刺殺模型權重 — 由 `scripts/assassinModel.ts --write` 產生，請勿手改。',
      ` * ${model.version}`,
      ' * 測試集刺中率等數字見 docs/ai/strength_benchmark.md。',
      ' */',
      "import type { AssassinModelWeights } from './AssassinModel';",
      '',
      'export const ASSASSIN_MODEL_WEIGHTS: AssassinModelWeights = {',
      `  version: ${JSON.stringify(model.version)},`,
      '  features: [',
      ...model.features.map((f) => `    ${JSON.stringify(f)},`),
      '  ],',
      '  weights: [',
      ...model.weights.map((x, i) => `    ${x}, // ${model.features[i]}`),
      '  ],',
      '};',
      '',
    ].join('\n');
    fs.writeFileSync(file, body);
    console.log(`wrote ${file}`);
  }

  // Baselines. The "model" agent replay runs with the weights fitted above
  // injected (not the file on disk — Node's module cache would still hold
  // the old weights after --write), so "agent+model(fresh fit)" is this
  // run's number and should equal `test: model` when the agent's candidate
  // filter agrees with the training candidates.
  const testBase = baselineHits(testSet, model);
  const allBase = baselineHits(examples, model);
  const nTest = testSet.length;
  const nAll = examples.length;

  const weightTable = ASSASSIN_FEATURE_NAMES
    .map((name, j) => ({ name, std: w[j], raw: rawWeights[j] }))
    .sort((a, b) => Math.abs(b.std) - Math.abs(a.std));

  console.log('');
  console.log(`train: model ${fmtEval(trainEval)}`);
  console.log(`test:  model ${fmtEval(testEval)}  (raw-scale argmax agrees with standardised on ${agreeRaw}/${nTest})`);
  console.log(`test baselines (n=${nTest}): human ${pct(testBase.human / nTest)} (${testBase.human}); random ${pct(testBase.random / nTest)}; rule ${pct(testBase.rule / nTest)} (${testBase.rule}); agent legacy ${pct(testBase.agentLegacy / nTest)} (${testBase.agentLegacy}); agent+model(fresh fit) ${pct(testBase.agentModel / nTest)} (${testBase.agentModel})`);
  console.log(`all games (n=${nAll}): human ${pct(allBase.human / nAll)}; random ${pct(allBase.random / nAll)}; rule ${pct(allBase.rule / nAll)}; agent legacy ${pct(allBase.agentLegacy / nAll)}; agent+model(fresh fit) ${pct(allBase.agentModel / nAll)}`);
  console.log('');
  console.log('| 特徵 | 標準化權重 | 原始尺度權重 |');
  console.log('|---|---|---|');
  for (const r of weightTable) console.log(`| ${r.name} | ${r.std.toFixed(3)} | ${r.raw.toFixed(3)} |`);
  console.log(`\nelapsed ${((Date.now() - started) / 1000).toFixed(1)}s`);

  if (args.json) {
    const out = {
      generatedBy: 'packages/server/scripts/assassinModel.ts',
      options: { ...args, cache: path.basename(args.cache) },
      dataset: { replayable, withAssassination: examples.length, train: trainSet.length, test: testSet.length },
      l2,
      cv: cvRows,
      train: trainEval,
      test: testEval,
      baselines: {
        test: { n: nTest, ...testBase },
        all: { n: nAll, ...allBase },
        testRates: {
          human: wilson(testBase.human, nTest),
          rule: wilson(testBase.rule, nTest),
          agentLegacy: wilson(testBase.agentLegacy, nTest),
          agentModel: wilson(testBase.agentModel, nTest),
          random: testBase.random / nTest,
        },
      },
      weights: weightTable,
      model,
    };
    fs.writeFileSync(path.resolve(args.json), JSON.stringify(out, null, 2));
    console.log(`wrote ${path.resolve(args.json)}`);
  }
}

main();
