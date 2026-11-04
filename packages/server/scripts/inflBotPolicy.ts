/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 資訊流研究原型 (b)：用機器人自己的投票策略（坐在 j 的位置、假設的世界 w 裡）當投票概似（2026-11-04；docs/ai/infl_research.md）。
 *
 *   cd packages/server && nice -n 10 npx tsx scripts/inflBotPolicy.ts [--games 24] [--k 16] [--json out.json]
 *
 * 有界的做法：留出的局（局 id 雜湊第 0 折的前 N 局），一個忠臣座位，第 3、4、5 局第 1 次提議的投票點；
 * 候選世界 = 骨架＋格子後驗的前 K 個（記錄真相在不在裡面）。在同一組候選世界上比四種讀票（重新正規化）：
 * 不讀票、真人格子、策略模型 (a)、機器人策略 (b)。ε 依回合段，用訓練局「真相世界裡機器人和真人同票」的比例估。
 * 也印每次機器人呼叫的耗時——線上能不能用的關鍵。
 */
import * as fs from 'fs';
import * as path from 'path';
import { HeuristicAgent } from '../src/ai/HeuristicAgent';
import { getDefaultAgentTuning } from '../src/ai/AgentTuning';
import { rowsFromSheet, parseReplayGame, campOf, type ReplayGame } from '../src/ai/benchmark/sheetsReplay';
import { buildReplayObservation } from '../src/ai/benchmark/replayObservation';
import { withSeededRandom } from '../src/ai/benchmark/agreement';
import { flowOfGame } from '../src/ai/infl/flow';
import { FlowFeatures } from '../src/ai/infl/voteFeatures';
import { collectTraining, fitPolicyModel, PolicyVoteReader, truthOf } from '../src/ai/infl/policyModel';
import { fitCellTables } from '../src/ai/infl/cellTables';
import { sharesOf, skeletonPosterior, type WorldPosterior } from '../src/ai/infl/posterior';
import { BotVoteOracle } from '../src/ai/infl/botVotePolicy';
import { Acc, fmtNum, fmtPct, table } from '../src/ai/infl/acc';

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

function loadGames(cache: string): ReplayGame[] {
  const data = JSON.parse(fs.readFileSync(cache, 'utf8')) as Record<string, string[][]>;
  const out: ReplayGame[] = [];
  for (const row of rowsFromSheet(data['牌譜'] ?? [])) {
    if (!(row['文字記錄'] ?? '').trim()) continue;
    const r = parseReplayGame(row);
    if (!r.ok || r.game.playerCount !== 10) continue;
    if ([...r.game.seatRoles].sort().join(',') !== 'assassin,loyal,loyal,loyal,loyal,merlin,mordred,morgana,oberon,percival') continue;
    out.push(r.game);
  }
  return out;
}

function restrict(post: WorldPosterior, cand: readonly number[], extra?: (w: number) => number): WorldPosterior {
  const idx = new Map(post.worlds.map((w, i) => [w, i] as const));
  const logs = cand.map((w) => Math.log(Math.max(post.wts[idx.get(w) ?? -1] ?? 0, 1e-300)) + (extra ? extra(w) : 0));
  const mx = Math.max(...logs);
  const raw = logs.map((x) => Math.exp(x - mx));
  const tot = raw.reduce((a, b) => a + b, 0);
  return { ids: post.ids, worlds: cand, wts: raw.map((x) => x / tot) };
}

function main(): void {
  const started = Date.now();
  const cache = path.resolve(arg('--cache') ?? path.resolve(__dirname, '..', 'sheets_cache.json'));
  const nGames = Number(arg('--games') ?? 24);
  const K = Number(arg('--k') ?? 16);
  const nEps = Number(arg('--eps-games') ?? 12);
  const games = loadGames(cache);
  const isEval = (g: ReplayGame): boolean => fnv(`fold|${g.id}`) % 5 === 0;
  const evalGames = games.filter(isEval).slice(0, nGames);
  const trainGames = games.filter((g) => !isEval(g));
  const tuning = getDefaultAgentTuning();
  const makeAgent = (id: string): HeuristicAgent => new HeuristicAgent(id, undefined, undefined, tuning);
  // 對照組（訓練局擬合）
  const items = trainGames.map((game) => ({ game, features: new FlowFeatures(flowOfGame(game)) }));
  const cells = fitCellTables(trainGames);
  const policy = fitPolicyModel(collectTraining(items), { residual: false, useBayesView: false });
  console.log(`train ${trainGames.length} games, eval ${evalGames.length}; fitted in ${((Date.now() - started) / 1000).toFixed(0)}s`);
  // ε：訓練局裡，機器人在真相世界、真人的座位上和真人同票的比例（依回合段）
  const agree: Record<string, [number, number]> = { R12: [0, 0], 'R3+': [0, 0] };
  for (const game of trainGames.slice(0, nEps)) {
    const flow = flowOfGame(game);
    const truth = truthOf(game, flow);
    const oracle = new BotVoteOracle(flow, makeAgent);
    flow.votes.forEach((v, i) => {
      if (!(flow.reliable?.[i] ?? false)) return;
      for (const j of flow.ids) {
        const yes = withSeededRandom(`${game.id}|${i}|${j}`, () => oracle.approves(i, j, truth.w));
        const b = v.round <= 2 ? 'R12' : 'R3+';
        agree[b][1]++;
        if (yes === v.votes[j]) agree[b][0]++;
      }
    });
  }
  const eps = (round: number): number => {
    const [a, n] = agree[round <= 2 ? 'R12' : 'R3+'];
    return Math.max(0.02, 1 - (a + 1) / (n + 2));
  };
  console.log(`ε: R12 ${fmtNum(eps(1))}, R3+ ${fmtNum(eps(3))} (agree ${JSON.stringify(agree)})`);
  const acc = new Acc();
  let calls = 0;
  let ms = 0;
  let points = 0;
  for (const game of evalGames) {
    const flow = flowOfGame(game);
    const ff = new FlowFeatures(flow);
    const reader = new PolicyVoteReader(policy, ff);
    const oracle = new BotVoteOracle(flow, makeAgent);
    const truth = truthOf(game, flow);
    const redIdx = game.seatRoles.map((r, k) => (campOf(r) === 'evil' ? k : -1)).filter((k) => k >= 0);
    const loyalSeats = game.seatRoles.map((r, k) => (r === 'loyal' ? k + 1 : 0)).filter((s) => s > 0);
    const viewerSeat = loyalSeats[fnv(game.id) % loyalSeats.length];
    const viewer = flow.ids[viewerSeat - 1];
    game.proposals.forEach((p, n) => {
      if (p.attempt !== 1 || p.round < 3) return;
      const obs = buildReplayObservation(game, viewerSeat, { kind: 'team_vote', proposal: n });
      const base = skeletonPosterior(obs, cells, { kind: 'cells' });
      const order = base.worlds.map((w, i) => ({ w, p: base.wts[i] })).sort((a, b) => b.p - a.p);
      const cand = order.slice(0, K).map((x) => x.w);
      const none = skeletonPosterior(obs, cells, { kind: 'none' });
      const pol = skeletonPosterior(obs, cells, { kind: 'policy', reader });
      const t0 = Date.now();
      const c0 = oracle.calls;
      const botLog = new Map(cand.map((w) => [w, withSeededRandom(`${game.id}|${n}|${w}`, () => oracle.worldLog(viewer, n, w, eps))] as const));
      ms += Date.now() - t0;
      calls += oracle.calls - c0;
      points++;
      const variants: Record<string, WorldPosterior> = {
        none: restrict(none, cand),
        cells: restrict(base, cand),
        policyA: restrict(pol, cand),
        bot: restrict(none, cand, (w) => botLog.get(w) ?? 0),
      };
      const inSet = cand.includes(truth.w);
      for (const [name, post] of Object.entries(variants)) {
        const sh = sharesOf(post);
        const others = sh.map((x, k) => ({ x, k })).filter((y) => y.k !== viewerSeat - 1).sort((a, b) => b.x - a.x || a.k - b.k);
        const top4 = new Set(others.slice(0, 4).map((y) => y.k));
        const redMean = redIdx.reduce((a, k) => a + sh[k], 0) / 4;
        const blueMean = others.filter((y) => !redIdx.includes(y.k)).reduce((a, y) => a + y.x, 0) / 5;
        const pTrue = inSet ? post.wts[cand.indexOf(truth.w)] : 0;
        acc.add([`${name}|R${p.round}`, `${name}|all`], { pTrue, inSet: inSet ? 1 : 0, top4: redIdx.every((k) => top4.has(k)) ? 1 : 0, gap: redMean - blueMean, mordredP: sh[game.seatRoles.indexOf('mordred')] });
      }
    });
    process.stderr.write(`  ${game.id}: ${oracle.calls} calls, ${(oracle.ms / Math.max(1, oracle.calls)).toFixed(1)} ms/call (${((Date.now() - started) / 60000).toFixed(1)} min)\n`);
  }
  const rows: string[][] = [['讀票', 'n', 'P(W*)（候選內）', 'top4 全中', '真紅−真藍', '莫德雷德紅機率', '真相在候選內']];
  for (const v of ['none', 'cells', 'policyA', 'bot']) {
    for (const pt of ['R3', 'R4', 'R5', 'all']) {
      const k = `${v}|${pt}`;
      if (acc.count(k) === 0) continue;
      rows.push([`${v} ${pt}`, String(acc.count(k)), fmtPct(acc.mean(k, 'pTrue')), fmtPct(acc.mean(k, 'top4')), fmtNum(acc.mean(k, 'gap')), fmtPct(acc.mean(k, 'mordredP')), fmtPct(acc.mean(k, 'inSet'))]);
    }
  }
  console.log(table(rows));
  console.log(`\n機器人呼叫：${calls} 次（${points} 個決策點，每點 ${(calls / Math.max(1, points)).toFixed(0)} 次），平均 ${(ms / Math.max(1, calls)).toFixed(1)} ms/次，每點 ${(ms / Math.max(1, points) / 1000).toFixed(1)} s`);
  console.log(`elapsed ${((Date.now() - started) / 60000).toFixed(1)} min`);
  const out = arg('--json');
  if (out) fs.writeFileSync(out, JSON.stringify({ meta: { K, nGames, eps: { R12: eps(1), R3: eps(3) }, calls, ms, points }, acc: acc.store }));
}

main();
