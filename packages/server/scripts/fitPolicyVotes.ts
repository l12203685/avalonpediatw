/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 讀票的策略模型（第 26 回合，`AgentTuning.beliefPolicyVotes`；docs/ai/infl_research.md 第 3 節的原型 (a) 接進正式後驗）。
 *
 *   cd packages/server && nice npx tsx scripts/fitPolicyVotes.ts [--k 50] [--out src/ai/infl/policy_strong.json]
 *
 * 資料：`games_cache.json`（`datasetReplay` 嚴格重播、標準 10 人配置），每一張可信的票，特徵 = `voteFeatures.ts`（j 在那次提議當時看得到的 INFL，
 * 不含殘差、不含 j 座位的貝氏信念），角色類別各一組邏輯迴歸。兩段：
 *   1. 全體真人（L2 λ = 2，向 0 收縮）→ β全體；
 *   2. 只用強者分面前 5 的票（`infl/strongCohort.ts`：藍方角色 → 藍方任務王、梅林 → 梅林存活王、紅方角色 → 紅方任務王），
 *      L2 向 β全體 收縮（λ = `--k`）→ β強者（Edward 2026-11-04：一套讀人模型擬合強者，資料不夠的地方後退到全體真人）。
 * 輸出只有係數與彙總（沒有名字、沒有單局紀錄）。另外印 5 折交叉擬合的強者票對數概似（β全體 vs β強者）。
 */
import * as fs from 'fs';
import * as path from 'path';
import { loadStrongCohorts } from './strongCohort';
import { humanGamesFromDataset } from '../src/ai/infl/strongData';
import { inFacetTop } from '../src/ai/infl/strongCohort';
import { flowOfGame } from '../src/ai/infl/flow';
import { FEATURE_NAMES, FlowFeatures, ROLE_CLASSES, type RoleClass } from '../src/ai/infl/voteFeatures';
import { truthOf, featureColumns, policyVoteProb, type PolicyModel } from '../src/ai/infl/policyModel';
import { fitLogisticRegression } from '../src/ai/infl/logistic';
import type { ReplayGame } from '../src/ai/benchmark/sheetsReplay';

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const STD = 'assassin,loyal,loyal,loyal,loyal,merlin,mordred,morgana,oberon,percival';

interface Sample { x: Float32Array; y: number; game: number; strong: boolean }

function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

function main(): void {
  const k = Number(arg('--k') ?? 50);
  const out = arg('--out') ?? path.resolve(__dirname, '../src/ai/infl/policy_strong.json');
  const { cohorts, dataset } = loadStrongCohorts({});
  const { games: hg } = humanGamesFromDataset(dataset as never, cohorts.threshold);
  const games: ReplayGame[] = hg.map((h) => h.game).filter((g) => g.playerCount === 10 && [...g.seatRoles].sort().join(',') === STD);
  const samples = Object.fromEntries(ROLE_CLASSES.map((c) => [c, [] as Sample[]])) as Record<RoleClass, Sample[]>;
  const started = Date.now();
  games.forEach((g, gi) => {
    const ff = new FlowFeatures(flowOfGame(g));
    const flow = ff.flow;
    const truth = truthOf(g, flow);
    const strongSeat = g.seatRoles.map((r, s) => inFacetTop(cohorts, r, 'vote', g.names?.[s] ?? '', 5));
    flow.votes.forEach((v, i) => {
      if (!ff.reliable(i)) return;
      flow.ids.forEach((j, s) => {
        const vote = v.votes[j];
        if (vote === undefined) return;
        const cls = truth.cls[s];
        samples[cls].push({ x: Float32Array.from(ff.full(i, j, truth.w, cls, truth.mordredBit)), y: vote ? 1 : 0, game: gi, strong: strongSeat[s] });
      });
    });
    if ((gi + 1) % 400 === 0) process.stderr.write(`[fitPolicyVotes] ${gi + 1}/${games.length} games, ${((Date.now() - started) / 1000).toFixed(0)}s\n`);
  });
  const cols = featureColumns({ residual: false, useBayesView: false });
  const fit = (keep: (s: Sample) => boolean, prior?: Record<RoleClass, Float64Array>, lambda = 2): Record<RoleClass, Float64Array> => {
    const beta = {} as Record<RoleClass, Float64Array>;
    for (const c of ROLE_CLASSES) {
      const xs = samples[c].filter(keep);
      beta[c] = fitLogisticRegression(xs.map((s) => s.x), xs.map((s) => s.y), { lambda, iters: 15, cols, prior: prior?.[c] });
    }
    return beta;
  };
  const ll = (beta: Record<RoleClass, Float64Array>, keep: (s: Sample) => boolean): { ll: number; n: number } => {
    const m: PolicyModel = { beta, residual: false, useBayesView: false };
    let sum = 0; let n = 0;
    for (const c of ROLE_CLASSES) for (const s of samples[c]) if (keep(s)) { sum += Math.log(policyVoteProb(m, c, s.x, s.y === 1)); n++; }
    return { ll: sum / Math.max(1, n), n };
  };
  // 5 折交叉擬合（依局 id 雜湊）：強者票的對數概似，全體係數 vs 強者係數。
  const fold = games.map((g) => fnv(g.id) % 5);
  let cvAll = 0; let cvStrong = 0; let cvN = 0;
  for (let f = 0; f < 5; f++) {
    const train = (s: Sample): boolean => fold[s.game] !== f;
    const bAll = fit(train);
    const bStrong = fit((s) => train(s) && s.strong, bAll, k);
    const test = (s: Sample): boolean => fold[s.game] === f && s.strong;
    const a = ll(bAll, test); const b = ll(bStrong, test);
    cvAll += a.ll * a.n; cvStrong += b.ll * b.n; cvN += a.n;
  }
  console.log(`5 折交叉擬合：強者票 ${cvN} 張，LL（nats/票）全體係數 ${(cvAll / cvN).toFixed(4)}、強者係數（向全體收縮，λ = ${k}）${(cvStrong / cvN).toFixed(4)}`);
  const bAll = fit(() => true);
  const bStrong = fit((s) => s.strong, bAll, k);
  const nStrong = ROLE_CLASSES.reduce((a, c) => a + samples[c].filter((s) => s.strong).length, 0);
  const nAll = ROLE_CLASSES.reduce((a, c) => a + samples[c].length, 0);
  const round = (b: Float64Array): number[] => Array.from(b, (x) => Number(x.toFixed(5)));
  const file = {
    source: `games_cache.json 強者分面前 5 的票（向全體真人收縮，λ = ${k}）`,
    fittedAt: new Date().toISOString().slice(0, 10),
    games: games.length, votes: nAll, strongVotes: nStrong, lambda: k,
    features: FEATURE_NAMES,
    beta: Object.fromEntries(ROLE_CLASSES.map((c) => [c, round(bStrong[c])])),
  };
  fs.writeFileSync(out, JSON.stringify(file) + '\n');
  console.log(`wrote ${out}: ${games.length} games, ${nAll} votes, strong ${nStrong}`);
}

main();
