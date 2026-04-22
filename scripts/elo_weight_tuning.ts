/**
 * elo_weight_tuning.ts — #54 Phase 3 logistic / grid-search weight search
 *
 * Grid-searches the four per-event attribution weights against a fixed
 * dataset of GameRecord and ranks each weight combination by a scoring
 * function. Weights that maximise the score are the candidates to hot-
 * reload via `/admin/elo-config` before flipping attributionMode=per_event.
 *
 * Score function (configurable, default "stability + outcome signal"):
 *   stability  = -avg(per-player ELO std dev)        // lower volatility wins
 *   signal     = avg |winner-side delta| - avg |loser-side delta|
 *   combined   = α * stability + β * signal
 *
 * Default grid:
 *   proposal             ∈ {1.0, 1.5, 2.0, 2.5, 3.0}
 *   outerWhiteInnerBlack ∈ {2.0, 3.0, 4.0}
 *   information          ∈ {0.5, 1.0, 1.5, 2.0}
 *   misdirection         ∈ {0.5, 1.0, 1.5, 2.0}
 *   = 240 combinations. Seat-order multiplier held constant at ON.
 *
 * ── Usage ────────────────────────────────────────────────────────────────
 *
 *   npx tsx scripts/elo_weight_tuning.ts --input games.json
 *   npx tsx scripts/elo_weight_tuning.ts --synthetic 300
 *   npx tsx scripts/elo_weight_tuning.ts --input games.json --output best_weights.json
 *
 * Output: JSON with `rankedCombinations: [{weights, score, breakdown}]`,
 * sorted descending by score. Top 10 printed to stdout.
 */

import * as fs from 'fs';
import * as path from 'path';
import { setEloConfig, DEFAULT_ELO_CONFIG } from '../packages/server/src/services/EloConfig';
import { replay, generateSyntheticRecords } from './elo_backtest';
import type { ReplayOutput } from './elo_backtest';
import type { GameRecord } from '../packages/server/src/services/GameHistoryRepository';

// ---------------------------------------------------------------------------
// Grid definition
// ---------------------------------------------------------------------------

interface WeightCombo {
  proposal: number;
  outerWhiteInnerBlack: number;
  information: number;
  misdirection: number;
}

interface ScoredCombo {
  weights: WeightCombo;
  score: number;
  breakdown: {
    stability: number;
    signal: number;
    avgAbsDelta: number;
    winnerDelta: number;
    loserDelta: number;
  };
}

const DEFAULT_GRID: Record<keyof WeightCombo, number[]> = {
  proposal: [1.0, 1.5, 2.0, 2.5, 3.0],
  outerWhiteInnerBlack: [2.0, 3.0, 4.0],
  information: [0.5, 1.0, 1.5, 2.0],
  misdirection: [0.5, 1.0, 1.5, 2.0],
};

function enumerateGrid(grid: Record<keyof WeightCombo, number[]>): WeightCombo[] {
  const out: WeightCombo[] = [];
  for (const proposal of grid.proposal)
    for (const owib of grid.outerWhiteInnerBlack)
      for (const info of grid.information)
        for (const misd of grid.misdirection)
          out.push({
            proposal,
            outerWhiteInnerBlack: owib,
            information: info,
            misdirection: misd,
          });
  return out;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance =
    values.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function scoreReplay(
  records: GameRecord[],
  replayResult: ReplayOutput,
  alpha: number,
  beta: number
): ScoredCombo['breakdown'] & { score: number } {
  // Per-player std dev of deltas — lower = more stable rating (stability).
  const byPlayer = new Map<string, number[]>();
  for (const d of replayResult.deltas) {
    const arr = byPlayer.get(d.uid) ?? [];
    arr.push(d.delta);
    byPlayer.set(d.uid, arr);
  }
  const stds: number[] = [];
  for (const arr of byPlayer.values()) {
    if (arr.length >= 3) stds.push(stddev(arr));
  }
  const avgStd = stds.length ? stds.reduce((s, v) => s + v, 0) / stds.length : 0;

  // Winner vs loser absolute delta (signal: factor should reward winners more).
  const gameWinnerMap = new Map<string, Set<string>>();
  for (const rec of records) {
    const winners = new Set(rec.players.filter((p) => p.won).map((p) => p.playerId));
    gameWinnerMap.set(rec.gameId, winners);
  }
  let winnerSum = 0;
  let winnerN = 0;
  let loserSum = 0;
  let loserN = 0;
  let absSum = 0;
  let absN = 0;
  for (const d of replayResult.deltas) {
    const winners = gameWinnerMap.get(d.gameId);
    if (!winners) continue;
    absSum += Math.abs(d.delta);
    absN += 1;
    if (winners.has(d.uid)) {
      winnerSum += Math.abs(d.delta);
      winnerN += 1;
    } else {
      loserSum += Math.abs(d.delta);
      loserN += 1;
    }
  }
  const winnerAvg = winnerN ? winnerSum / winnerN : 0;
  const loserAvg = loserN ? loserSum / loserN : 0;
  const signal = winnerAvg - loserAvg;
  const stability = -avgStd; // negate so higher = better
  const score = alpha * stability + beta * signal;

  return {
    stability,
    signal,
    avgAbsDelta: absN ? absSum / absN : 0,
    winnerDelta: winnerAvg,
    loserDelta: loserAvg,
    score,
  };
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

interface TuningArgs {
  input?: string;
  synthetic?: number;
  limit?: number;
  output?: string;
  alpha: number;
  beta: number;
}

function parseArgs(argv: string[]): TuningArgs {
  const args: TuningArgs = { alpha: 1, beta: 1 };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--input') args.input = argv[++i];
    else if (a === '--synthetic') args.synthetic = Number(argv[++i]);
    else if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--output') args.output = argv[++i];
    else if (a === '--alpha') args.alpha = Number(argv[++i]);
    else if (a === '--beta') args.beta = Number(argv[++i]);
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  let records: GameRecord[];
  if (args.synthetic) records = generateSyntheticRecords(args.synthetic);
  else if (args.input) records = JSON.parse(fs.readFileSync(args.input, 'utf8'));
  else throw new Error('Provide --input <file> or --synthetic <n>');

  if (args.limit && args.limit > 0) records = records.slice(0, args.limit);

  const combos = enumerateGrid(DEFAULT_GRID);
  console.log(`Evaluating ${combos.length} weight combinations over ${records.length} games`);

  const scored: ScoredCombo[] = [];
  for (const combo of combos) {
    setEloConfig({
      attributionMode: 'per_event',
      attributionWeights: {
        ...DEFAULT_ELO_CONFIG.attributionWeights,
        ...combo,
        seatOrderEnabled: true,
      },
    });
    const result = replay(records, 'per_event');
    const breakdown = scoreReplay(records, result, args.alpha, args.beta);
    scored.push({
      weights: combo,
      score: breakdown.score,
      breakdown: {
        stability: breakdown.stability,
        signal: breakdown.signal,
        avgAbsDelta: breakdown.avgAbsDelta,
        winnerDelta: breakdown.winnerDelta,
        loserDelta: breakdown.loserDelta,
      },
    });
  }

  scored.sort((a, b) => b.score - a.score);
  const top10 = scored.slice(0, 10);
  console.log('\nTop 10 weight combinations:');
  for (const s of top10) {
    console.log(
      `  score=${s.score.toFixed(3)} prop=${s.weights.proposal} owib=${s.weights.outerWhiteInnerBlack} info=${s.weights.information} misd=${s.weights.misdirection} signal=${s.breakdown.signal.toFixed(2)} std=${(-s.breakdown.stability).toFixed(2)}`
    );
  }

  const outPath =
    args.output ??
    path.join(
      args.input ? path.dirname(args.input) : process.cwd(),
      `weight_tuning_${Date.now()}.json`
    );
  fs.writeFileSync(
    outPath,
    JSON.stringify({ totalCombos: combos.length, rankedCombinations: scored }, null, 2),
    'utf8'
  );
  console.log(`\nFull report written to ${outPath}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { enumerateGrid, scoreReplay };
export type { WeightCombo, ScoredCombo };
