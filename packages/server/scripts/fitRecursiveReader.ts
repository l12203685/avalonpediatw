/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 遞迴讀人（第 33 回合，`AgentTuning.beliefRecursive`；`src/ai/infl/recursiveRead.ts`、docs/ai/infl_research.md 第 8 節）的模型擬合。
 *
 *   cd packages/server && nice npx tsx scripts/fitRecursiveReader.ts [--k 50] [--limit N] [--out src/ai/infl/recursive_strong.json]
 *
 * 資料：`games_cache.json`（`datasetReplay` 嚴格重播、標準 10 人配置）。j 的特徵用「j 座位的第 0 層後驗」（現行預設的貝氏後驗，
 * 站在 j 的座位、只看那次提議之前的公開紀錄＋j 在真相世界裡湖到的結果）。
 *   - 投票：`voteFeatures.ts` 全部欄位（含 j 後驗的 b* 欄、不含殘差），角色類別各一組邏輯迴歸；
 *   - 派隊：條件 logit（`recursiveRead.ts`：log P_j(乾淨)、在不在隊上、照派；紅方加隊友數、能不能失敗），類別 藍／紅／奧伯倫（梅林不擬合）。
 * 兩段（和 `fitPolicyVotes.ts` 相同）：全體真人（L2 λ = 2）→ 強者分面前 5（投票 → 投票分面、派隊 → 派隊分面）向全體收縮（λ = `--k`）。
 * 另外印 5 折交叉擬合的強者動作對數概似。輸出只有係數與彙總（沒有名字、沒有單局紀錄）。
 */
import * as fs from 'fs';
import * as path from 'path';
import { loadStrongCohorts } from './strongCohort';
import { humanGamesFromDataset } from '../src/ai/infl/strongData';
import { inFacetTop } from '../src/ai/infl/strongCohort';
import { flowOfGame } from '../src/ai/infl/flow';
import { FEATURE_NAMES, FlowFeatures, N_BASE, ROLE_CLASSES, type RoleClass } from '../src/ai/infl/voteFeatures';
import { truthOf, featureColumns, policyVoteProb, type PolicyModel } from '../src/ai/infl/policyModel';
import POLICY0 from '../src/ai/infl/policy_strong.json';
import { fitLogisticRegression } from '../src/ai/infl/logistic';
import {
  N_PROP, PROPOSAL_CLASSES, PROPOSAL_COLS, PROPOSAL_FEATURES, mixProposalClassOf, mixVoteVector, proposalCandidates, proposalClassOf,
  proposalFeatures, proposalLogProb, mixClass, type ProposalCandidates, type ProposalClass,
} from '../src/ai/infl/recursiveRead';
import { bitOf } from '../src/ai/infl/flow';
import { DEFAULT_AGENT_TUNING } from '../src/ai/AgentTuning';
import { bayesOptionsOf } from '../src/ai/belief/BayesBelief';
import type { ReplayGame } from '../src/ai/benchmark/sheetsReplay';

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const STD = 'assassin,loyal,loyal,loyal,loyal,merlin,mordred,morgana,oberon,percival';

interface VoteSample { x: Float32Array; y: number; game: number; strong: boolean }
interface PropSample { c: ProposalCandidates; w: number; game: number; strong: boolean; d: number; th: number }

function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

/** 條件 logit 的牛頓法（L2 向 prior 收縮）；`cols` = 用到的欄。 */
function fitConditionalLogit(samples: readonly PropSample[], cls: ProposalClass, cols: readonly number[], lambda: number, prior?: Float64Array): Float64Array {
  const d = N_PROP;
  const beta = new Float64Array(d);
  if (prior) beta.set(prior);
  const x = new Float64Array(d);
  for (let iter = 0; iter < 40; iter++) {
    const g = new Float64Array(d);
    const h = new Float64Array(d * d);
    for (const s of samples) {
      const n = s.c.teams.length;
      const z = new Float64Array(n);
      let mx = -Infinity;
      for (let t = 0; t < n; t++) {
        proposalFeatures(s.c, t, s.w, cls, x, s.d, s.th);
        let v = 0;
        for (const k of cols) v += beta[k] * x[k];
        z[t] = v;
        if (v > mx) mx = v;
      }
      let tot = 0;
      for (let t = 0; t < n; t++) { z[t] = Math.exp(z[t] - mx); tot += z[t]; }
      const ex = new Float64Array(d);
      const exx = new Float64Array(d * d);
      for (let t = 0; t < n; t++) {
        const p = z[t] / tot;
        if (p < 1e-12) continue;
        proposalFeatures(s.c, t, s.w, cls, x, s.d, s.th);
        for (const a of cols) { ex[a] += p * x[a]; for (const b of cols) exx[a * d + b] += p * x[a] * x[b]; }
      }
      proposalFeatures(s.c, s.c.chosen, s.w, cls, x, s.d, s.th);
      for (const a of cols) { g[a] += x[a] - ex[a]; for (const b of cols) h[a * d + b] += exx[a * d + b] - ex[a] * ex[b]; }
    }
    for (const a of cols) { g[a] -= lambda * (beta[a] - (prior?.[a] ?? 0)); h[a * d + a] += lambda; }
    // 解 h · step = g（只在 cols 上；小矩陣高斯消去）。
    const m = cols.length;
    const A = cols.map((a) => [...cols.map((b) => h[a * d + b]), g[a]]);
    for (let p = 0; p < m; p++) {
      let piv = p;
      for (let r = p + 1; r < m; r++) if (Math.abs(A[r][p]) > Math.abs(A[piv][p])) piv = r;
      [A[p], A[piv]] = [A[piv], A[p]];
      for (let r = 0; r < m; r++) {
        if (r === p || A[p][p] === 0) continue;
        const f = A[r][p] / A[p][p];
        for (let c = p; c <= m; c++) A[r][c] -= f * A[p][c];
      }
    }
    // 步長截在 ±1（條件 logit 在接近分離的欄上，未截斷的牛頓步會發散）。
    let maxStep = 0;
    cols.forEach((a, k) => { const st = Math.max(-1, Math.min(1, A[k][m] / A[k][k])); beta[a] += st; maxStep = Math.max(maxStep, Math.abs(st)); });
    if (maxStep < 1e-6) break;
  }
  return beta;
}

function main(): void {
  const k = Number(arg('--k') ?? 50);
  const limit = arg('--limit') !== undefined ? Number(arg('--limit')) : Infinity;
  const out = arg('--out') ?? path.resolve(__dirname, '../src/ai/infl/recursive_strong.json');
  const level0 = { ...bayesOptionsOf({ ...DEFAULT_AGENT_TUNING, beliefRecursive: 0 }) };
  const { cohorts, dataset } = loadStrongCohorts({});
  const { games: hg } = humanGamesFromDataset(dataset as never, cohorts.threshold);
  const games: ReplayGame[] = hg.map((h) => h.game).filter((g) => g.playerCount === 10 && [...g.seatRoles].sort().join(',') === STD).slice(0, limit);
  const votes = Object.fromEntries(ROLE_CLASSES.map((c) => [c, [] as VoteSample[]])) as Record<RoleClass, VoteSample[]>;
  const props = Object.fromEntries(PROPOSAL_CLASSES.map((c) => [c, [] as PropSample[]])) as Record<ProposalClass, PropSample[]>;
  // 第 34 回合：角色混合的投票樣本（忠臣、派西分開；派西的拇指＝梅林＋莫甘娜）。其他角色和第 33 回合同一份樣本。
  const mixVotes = { loyal: [] as VoteSample[], percival: [] as VoteSample[] };
  const started = Date.now();
  games.forEach((g, gi) => {
    const ff = new FlowFeatures(flowOfGame(g), { useBayesView: true, bayesViewOptions: level0 });
    const flow = ff.flow;
    const truth = truthOf(g, flow);
    const strongVote = g.seatRoles.map((r, s) => inFacetTop(cohorts, r, 'vote', g.names?.[s] ?? '', 5));
    const strongTeam = g.seatRoles.map((r, s) => inFacetTop(cohorts, r, 'team', g.names?.[s] ?? '', 5));
    const merlinSeat = g.seatRoles.indexOf('merlin');
    const morganaSeat = g.seatRoles.indexOf('morgana');
    const thumbs = (merlinSeat >= 0 ? bitOf(flow, flow.ids[merlinSeat]) : 0) | (morganaSeat >= 0 ? bitOf(flow, flow.ids[morganaSeat]) : 0);
    flow.votes.forEach((v, i) => {
      const ls = flow.ids.indexOf(v.leader);
      const pc = ls >= 0 ? proposalClassOf(g.seatRoles[ls]) : null;
      const mc = ls >= 0 ? mixProposalClassOf(g.seatRoles[ls]) : null;
      if (pc || mc) {
        const c = proposalCandidates(ff, i, truth.w);
        if (c) {
          const smp = { c, w: truth.w, game: gi, strong: strongTeam[ls], d: truth.mordredBit, th: thumbs };
          if (pc) props[pc].push(smp);
          if (mc && mc !== pc && (mc === 'loyal' || mc === 'percival' || mc === 'merlin')) props[mc].push(smp);
          if (mc) props[mixClass(mc, true)].push(smp);
        }
      }
      if (!ff.reliable(i)) return;
      flow.ids.forEach((j, s) => {
        const vote = v.votes[j];
        if (vote === undefined) return;
        const cls = truth.cls[s];
        votes[cls].push({ x: Float32Array.from(ff.full(i, j, truth.w, cls, truth.mordredBit)), y: vote ? 1 : 0, game: gi, strong: strongVote[s] });
        const role = g.seatRoles[s];
        if (role === 'loyal' || role === 'percival') {
          mixVotes[role].push({ x: Float32Array.from(mixVoteVector(ff, i, j, truth.w, role, truth.mordredBit, thumbs)), y: vote ? 1 : 0, game: gi, strong: strongVote[s] });
        }
      });
    });
    if ((gi + 1) % 100 === 0) process.stderr.write(`[fitRecursiveReader] ${gi + 1}/${games.length} games, ${((Date.now() - started) / 1000).toFixed(0)}s\n`);
  });
  const fold = games.map((g) => fnv(g.id) % 5);

  // ── 投票 ──
  const cols = featureColumns({ residual: false, useBayesView: true });
  const fitV = (keep: (s: VoteSample) => boolean, prior?: Record<RoleClass, Float64Array>, lambda = 2): Record<RoleClass, Float64Array> => {
    const beta = {} as Record<RoleClass, Float64Array>;
    for (const c of ROLE_CLASSES) {
      const xs = votes[c].filter(keep);
      beta[c] = fitLogisticRegression(xs.map((s) => s.x), xs.map((s) => s.y), { lambda, iters: 15, cols, prior: prior?.[c] });
    }
    return beta;
  };
  const llV = (beta: Record<RoleClass, Float64Array>, keep: (s: VoteSample) => boolean): { ll: number; n: number } => {
    const m: PolicyModel = { beta, residual: false, useBayesView: true };
    let sum = 0; let n = 0;
    for (const c of ROLE_CLASSES) for (const s of votes[c]) if (keep(s)) { sum += Math.log(policyVoteProb(m, c, s.x, s.y === 1)); n++; }
    return { ll: sum / Math.max(1, n), n };
  };
  const p0 = POLICY0 as unknown as { beta: Record<string, number[]> };
  const beta0 = Object.fromEntries(ROLE_CLASSES.map((c) => [c, Float64Array.from(p0.beta[c])])) as Record<RoleClass, Float64Array>;
  let cvV = 0; let cvV0 = 0; let cvN = 0;
  for (let f = 0; f < 5; f++) {
    const train = (s: VoteSample): boolean => fold[s.game] !== f;
    const bAll = fitV(train);
    const bStrong = fitV((s) => train(s) && s.strong, bAll, k);
    const test = (s: VoteSample): boolean => fold[s.game] === f && s.strong;
    const a = llV(bStrong, test); const b = llV(beta0, test);
    cvV += a.ll * a.n; cvV0 += b.ll * b.n; cvN += a.n;
  }
  console.log(`投票 5 折交叉擬合：強者票 ${cvN} 張，LL（nats/票）遞迴（j 後驗特徵）${(cvV / cvN).toFixed(4)}；第 26 回合的讀票模型（不含 j 後驗、全樣本擬合，參考）${(cvV0 / cvN).toFixed(4)}`);
  const bvAll = fitV(() => true);
  const bvStrong = fitV((s) => s.strong, bvAll, k);
  // 第 34 回合：忠臣、派西分開（派西的拇指欄）。交叉擬合比較：強者忠臣＋派西的票，藍方合一類 vs 分開。
  const fitMixV = (keep: (s: VoteSample) => boolean, prior?: Record<'loyal' | 'percival', Float64Array>, lambda = 2): Record<'loyal' | 'percival', Float64Array> => {
    const out = {} as Record<'loyal' | 'percival', Float64Array>;
    for (const c of ['loyal', 'percival'] as const) {
      const xs = mixVotes[c].filter(keep);
      out[c] = fitLogisticRegression(xs.map((s) => s.x), xs.map((s) => s.y), { lambda, iters: 15, cols, prior: prior?.[c] });
    }
    return out;
  };
  let cvBlue = 0; let cvMix = 0; let cvMN = 0;
  for (let f = 0; f < 5; f++) {
    const train = (s: VoteSample): boolean => fold[s.game] !== f;
    const test = (s: VoteSample): boolean => fold[s.game] === f && s.strong;
    const bAll = fitV(train);
    const bStrong = fitV((s) => train(s) && s.strong, bAll, k);
    const mAll = fitMixV(train);
    const mStrong = fitMixV((s) => train(s) && s.strong, mAll, k);
    const blueM: PolicyModel = { beta: bStrong, residual: false, useBayesView: true };
    for (const c of ['loyal', 'percival'] as const) {
      const mm: PolicyModel = { beta: { ...bStrong, blue: mStrong[c] }, residual: false, useBayesView: true };
      for (const s of mixVotes[c]) if (test(s)) {
        cvMix += Math.log(policyVoteProb(mm, 'blue', s.x, s.y === 1));
        // 合一類：藍方係數在同一張票的藍方特徵上（派西的拇指欄不用）。
        const xb = Float32Array.from(s.x); if (c === 'percival') { xb[N_BASE + 5] = 0; xb[N_BASE + 6] = 0; }
        cvBlue += Math.log(policyVoteProb(blueM, 'blue', xb, s.y === 1)); cvMN++;
      }
    }
  }
  console.log(`投票（角色分開，第 34 回合）5 折：強者忠臣＋派西票 ${cvMN} 張，LL 藍方合一類 ${(cvBlue / cvMN).toFixed(4)} → 忠臣／派西分開 ${(cvMix / cvMN).toFixed(4)}`);
  const mvAll = fitMixV(() => true);
  const mvStrong = fitMixV((s) => s.strong, mvAll, k);

  // ── 派隊 ──
  const colsOf = (c: ProposalClass): number[] => [...PROPOSAL_COLS[c]];
  const THREE: readonly ProposalClass[] = ['blue', 'evil', 'oberon'];
  const fitP = (keep: (s: PropSample) => boolean, prior?: Record<ProposalClass, Float64Array>, lambda = 2): Record<ProposalClass, Float64Array> => {
    const beta = {} as Record<ProposalClass, Float64Array>;
    for (const c of PROPOSAL_CLASSES) beta[c] = fitConditionalLogit(props[c].filter(keep), c, colsOf(c), lambda, prior?.[c]);
    return beta;
  };
  const llP = (beta: Record<ProposalClass, Float64Array>, keep: (s: PropSample) => boolean): { ll: number; uni: number; n: number } => {
    let sum = 0; let uni = 0; let n = 0;
    const scratch = new Float64Array(256);
    for (const c of THREE) for (const s of props[c]) if (keep(s)) { sum += proposalLogProb(beta[c], s.c, s.w, c, scratch); uni -= Math.log(s.c.teams.length); n++; }
    return { ll: sum / Math.max(1, n), uni: uni / Math.max(1, n), n };
  };
  let cvP = 0; let cvU = 0; let cvPN = 0;
  for (let f = 0; f < 5; f++) {
    const train = (s: PropSample): boolean => fold[s.game] !== f;
    const bAll = fitP(train);
    const bStrong = fitP((s) => train(s) && s.strong, bAll, k);
    const r = llP(bStrong, (s) => fold[s.game] === f && s.strong);
    cvP += r.ll * r.n; cvU += r.uni * r.n; cvPN += r.n;
  }
  console.log(`派隊 5 折交叉擬合：強者提議 ${cvPN} 次，LL（nats/次）條件 logit ${(cvP / cvPN).toFixed(4)}、均勻 ${(cvU / cvPN).toFixed(4)}`);
  // 第 34 回合：藍方隊長照自己的角色讀（忠臣、派西的拇指、梅林看得到的紅）vs 第 33 回合的「藍＝看不到」。
  {
    const acc: Record<string, [number, number, number]> = {};
    const scratch = new Float64Array(256);
    for (let f = 0; f < 5; f++) {
      const train = (s: PropSample): boolean => fold[s.game] !== f;
      const bAll = fitP(train);
      const bStrong = fitP((s) => train(s) && s.strong, bAll, k);
      for (const c of ['loyal', 'percival', 'merlin'] as const) {
        for (const s of props[c]) {
          if (fold[s.game] !== f || !s.strong) continue;
          const a = (acc[c] ??= [0, 0, 0]);
          a[0] += proposalLogProb(bStrong.blue, s.c, s.w, 'blue', scratch); a[1] += proposalLogProb(bStrong[c], s.c, s.w, c, scratch, s.d, s.th); a[2]++;
        }
      }
    }
    let t0 = 0; let t1 = 0; let tn = 0;
    for (const [c, a] of Object.entries(acc)) { console.log(`  派隊（角色分開）強者 ${c} ${a[2]} 次：LL 藍＝看不到 ${(a[0] / a[2]).toFixed(4)} → 照角色 ${(a[1] / a[2]).toFixed(4)}`); t0 += a[0]; t1 += a[1]; tn += a[2]; }
    console.log(`  派隊（角色分開）強者藍方隊長合計 ${tn} 次：${(t0 / tn).toFixed(4)} → ${(t1 / tn).toFixed(4)}`);
  }
  // 第 34 回合：相對於資訊流的特徵（同一個角色，加不加那五欄）。
  {
    const acc: Record<string, [number, number, number]> = {};
    const scratch = new Float64Array(256);
    for (let f = 0; f < 5; f++) {
      const train = (s: PropSample): boolean => fold[s.game] !== f;
      const bAll = fitP(train);
      const bStrong = fitP((s) => train(s) && s.strong, bAll, k);
      for (const c of ['loyal', 'percival', 'merlin', 'evil', 'oberon'] as const) {
        const cf = mixClass(c, true);
        for (const s of props[cf]) {
          if (fold[s.game] !== f || !s.strong) continue;
          const a = (acc[c] ??= [0, 0, 0]);
          a[0] += proposalLogProb(bStrong[c], s.c, s.w, c, scratch, s.d, s.th); a[1] += proposalLogProb(bStrong[cf], s.c, s.w, cf, scratch, s.d, s.th); a[2]++;
        }
      }
    }
    for (const [c, a] of Object.entries(acc)) console.log(`  派隊（資訊流特徵）強者 ${c} ${a[2]} 次：LL 角色 ${(a[0] / a[2]).toFixed(4)} → 角色＋資訊流 ${(a[1] / a[2]).toFixed(4)}`);
  }
  const bpAll = fitP(() => true);
  const bpStrong = fitP((s) => s.strong, bpAll, k);
  for (const c of PROPOSAL_CLASSES) console.log(`  派隊 ${c}（${props[c].length} 次、強者 ${props[c].filter((s) => s.strong).length}）：${PROPOSAL_FEATURES.map((f, i) => `${f} ${bpStrong[c][i].toFixed(3)}`).join('、')}`);

  const round = (b: Float64Array): number[] => Array.from(b, (x) => Number(x.toFixed(5)));
  const file = {
    source: `games_cache.json 強者分面前 5（投票 → 投票分面、派隊 → 派隊分面），向全體真人收縮（λ = ${k}）；j 的特徵 = j 座位的第 0 層後驗（現行預設）`,
    fittedAt: new Date().toISOString().slice(0, 10),
    games: games.length,
    level0: 'bayesOptionsOf(DEFAULT_AGENT_TUNING)',
    vote: {
      votes: ROLE_CLASSES.reduce((a, c) => a + votes[c].length, 0), features: FEATURE_NAMES,
      beta: { ...Object.fromEntries(ROLE_CLASSES.map((c) => [c, round(bvStrong[c])])), loyal: round(mvStrong.loyal), percival: round(mvStrong.percival) },
    },
    proposal: { proposals: PROPOSAL_CLASSES.reduce((a, c) => a + props[c].length, 0), features: PROPOSAL_FEATURES, beta: Object.fromEntries(PROPOSAL_CLASSES.map((c) => [c, round(bpStrong[c])])) },
  };
  fs.writeFileSync(out, JSON.stringify(file) + '\n');
  console.log(`wrote ${out}`);
}

main();
