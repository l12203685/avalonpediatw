/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 機器人 vs 強者真人的投票差距（Edward 2026-11-04 第 2 點；src/ai/infl/gap.ts、docs/ai/strong_metrics.md）。
 *
 *   cd packages/server && nice npx tsx scripts/strongGap.ts --selfplay sp.json [--replay-votes votes.json] [--top 10] [--camp 紅]
 *
 * 1. 強者的票：每一局、投票分面前 5 的座位（忠臣、派西 → 藍方任務王；梅林 → 梅林存活王；紅方 → 紅方任務王）的每一張可信的票；
 *    機器人的票：自我對打（`strongSelfPlay.ts`）每個座位的每一張票。
 * 2. 兩組各擬合一個 INFL 策略模型（`fitPolicyModel`：每個角色類別一組邏輯迴歸；特徵 = j 座位在真相世界裡的 INFL 特徵，
 *    不含殘差與貝氏視角）。
 * 3. 在強者的決策點上比較兩個模型的 P(贊成)：每個處境的平均 |Δp|、KL(強者 ‖ 機器人)，強者實際贊成率、
 *    機器人重播在同一點的贊成率（`--replay-votes`，strongLoopMetrics 的輸出）。另外在自我對打的決策點上算一次（機器人會走到、
 *    強者少走到的處境）。前 N 名 = n × 平均 |Δp| 最大（預期不同的票數）＝下一回合的線索；另列經驗版
 *    （n × |強者實際贊成率 − 機器人重播贊成率|，不靠模型），兩份都出現的處境最可信。
 */
import * as fs from 'fs';
import type { ReplayGame } from '../src/ai/benchmark/sheetsReplay';
import type { DatasetHeader, DatasetTuple } from '../src/ai/benchmark/datasetReplay';
import { flowOfGame } from '../src/ai/infl/flow';
import { FlowFeatures, ROLE_CLASSES, type RoleClass } from '../src/ai/infl/voteFeatures';
import { fitPolicyModel, policyVoteProb, truthOf, type PolicyModel, type TrainingSet } from '../src/ai/infl/policyModel';
import { coarseSituation, GapTable, situationOf } from '../src/ai/infl/gap';
import { fmtNum, fmtPct, table } from '../src/ai/infl/acc';
import { inFacetTop } from '../src/ai/infl/strongCohort';
import { humanGamesFromDataset } from '../src/ai/infl/strongData';
import { loadStrongCohorts } from './strongCohort';

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

interface Sample { cls: RoleClass; x: Float32Array; y: number; key?: string }

function emptySet(): TrainingSet {
  const mk = <T>(): Record<RoleClass, T[]> => Object.fromEntries(ROLE_CLASSES.map((c) => [c, [] as T[]])) as Record<RoleClass, T[]>;
  return { xs: mk<Float32Array>(), ys: mk<number>(), game: mk<number>() };
}

/** 一局（只取 `seats` 的座位；缺 = 全部）每一張可信的票的特徵。 */
function samplesOf(game: ReplayGame, seats: ReadonlySet<number> | null, gi: number, set: TrainingSet, out: Sample[] | null): void {
  const features = new FlowFeatures(flowOfGame(game));
  const flow = features.flow;
  const truth = truthOf(game, flow);
  flow.votes.forEach((v, i) => {
    if (!features.reliable(i)) return;
    flow.ids.forEach((j, k) => {
      if (seats && !seats.has(k + 1)) return;
      const vote = v.votes[j];
      if (vote === undefined) return;
      const cls = truth.cls[k];
      const x = Float32Array.from(features.full(i, j, truth.w, cls, truth.mordredBit));
      set.xs[cls].push(x);
      set.ys[cls].push(vote ? 1 : 0);
      set.game[cls].push(gi);
      out?.push({ cls, x, y: vote ? 1 : 0, key: `${game.id}|${i}|${k + 1}` });
    });
  });
}

function logLik(m: PolicyModel, set: TrainingSet): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of ROLE_CLASSES) {
    let s = 0;
    set.xs[c].forEach((x, n) => { s += Math.log(policyVoteProb(m, c, x, set.ys[c][n] === 1)); });
    out[c] = set.xs[c].length > 0 ? `${(s / set.xs[c].length).toFixed(3)}（${set.xs[c].length}）` : '—';
  }
  return out;
}

function printTable(title: string, t: GapTable, keys: string[], withReplay: boolean): void {
  const rows: string[][] = [['處境', 'n', '強者模型 P(贊成)', '機器人模型', '平均|Δp|', 'KL bits', '強者實際', ...(withReplay ? ['機器人重播'] : [])]];
  for (const k of keys) {
    const c = t.cells.get(k);
    if (!c) continue;
    rows.push([k, String(c.n), fmtPct(c.ps / c.n), fmtPct(c.pb / c.n), fmtNum(c.absDiff / c.n, 3), fmtNum(c.kl / c.n, 3), fmtPct(c.human / c.n),
      ...(withReplay ? [c.botReplayN > 0 ? `${fmtPct(c.botReplay / c.botReplayN)}（${c.botReplayN}）` : '—'] : [])]);
  }
  console.log(`\n${title}\n${table(rows)}`);
}

function main(): void {
  const started = Date.now();
  const spPath = arg('--selfplay');
  if (!spPath) throw new Error('--selfplay PATH（strongSelfPlay.ts 的輸出）');
  const topK = Number(arg('--top') ?? 10);
  const minN = Number(arg('--min-n') ?? 30);
  const { cohorts, dataset } = loadStrongCohorts();
  const { games } = humanGamesFromDataset(dataset as unknown as DatasetHeader & { games: readonly DatasetTuple[]; players: readonly string[] }, cohorts.threshold);
  const limit = arg('--limit') !== undefined ? Number(arg('--limit')) : undefined;
  const humans = limit !== undefined ? games.slice(0, limit) : games;
  // 強者的票
  const strongSet = emptySet();
  const strongSamples: Sample[] = [];
  const hiKeys = new Set<string>();
  humans.forEach(({ game, hi }, gi) => {
    const seats = new Set<number>();
    for (let s = 1; s <= game.playerCount; s++) if (inFacetTop(cohorts, game.seatRoles[s - 1], 'vote', game.names[s - 1], 5)) seats.add(s);
    if (seats.size === 0) return;
    const before = strongSamples.length;
    samplesOf(game, seats, gi, strongSet, strongSamples);
    if (hi) for (let k = before; k < strongSamples.length; k++) hiKeys.add(strongSamples[k].key!);
    if ((gi + 1) % 200 === 0) process.stderr.write(`[strongGap] humans ${gi + 1}/${humans.length}, ${((Date.now() - started) / 1000).toFixed(0)}s\n`);
  });
  // 機器人的票（自我對打）
  const sp = JSON.parse(fs.readFileSync(spPath, 'utf8')) as { games: ReplayGame[] };
  const botSet = emptySet();
  const botSamples: Sample[] = [];
  sp.games.forEach((g, gi) => samplesOf(g, null, gi, botSet, botSamples));
  const opts = { residual: false, useBayesView: false };
  const ms = fitPolicyModel(strongSet, opts);
  const mb = fitPolicyModel(botSet, opts);
  console.log(`強者票 ${strongSamples.length}（高強度局 ${hiKeys.size}）、自我對打票 ${botSamples.length}（${sp.games.length} 局）`);
  console.log(`擬合（樣本內 LL nats/票）強者模型：${JSON.stringify(logLik(ms, strongSet))}`);
  console.log(`機器人模型：${JSON.stringify(logLik(mb, botSet))}`);
  console.log(`交叉：強者的票用機器人模型 ${JSON.stringify(logLik(mb, strongSet))}`);
  console.log(`機器人的票用強者模型 ${JSON.stringify(logLik(ms, botSet))}`);
  // 機器人重播（同一個強者決策點）
  const replay = new Map<string, boolean>();
  const rv = arg('--replay-votes');
  if (rv) for (const [g, p, seat, v] of JSON.parse(fs.readFileSync(rv, 'utf8')) as [string, number, number, number][]) replay.set(`${g}|${p}|${seat}`, v === 1);
  const fine = new GapTable();
  const fineHi = new GapTable();
  const coarse = new GapTable();
  for (const s of strongSamples) {
    const ps = policyVoteProb(ms, s.cls, s.x, true);
    const pb = policyVoteProb(mb, s.cls, s.x, true);
    const br = replay.get(s.key!);
    fine.add(situationOf(s.x, s.cls), ps, pb, s.y === 1, br);
    coarse.add(coarseSituation(s.x, s.cls), ps, pb, s.y === 1, br);
    coarse.add('全部', ps, pb, s.y === 1, br);
    if (hiKeys.has(s.key!)) { fineHi.add(situationOf(s.x, s.cls), ps, pb, s.y === 1, br); coarse.add('全部·高強度', ps, pb, s.y === 1, br); }
  }
  // 自我對打的決策點（機器人實際的票在「強者實際」那一欄）
  const botPts = new GapTable();
  for (const s of botSamples) {
    const ps = policyVoteProb(ms, s.cls, s.x, true);
    const pb = policyVoteProb(mb, s.cls, s.x, true);
    botPts.add(coarseSituation(s.x, s.cls), ps, pb, s.y === 1);
    botPts.add('全部', ps, pb, s.y === 1);
  }
  const withReplay = replay.size > 0;
  // `--camp 紅`（第 27 回合）：前 N 名只列那一個陣營（紅／藍／梅林）的處境。
  const camp = arg('--camp');
  if (camp) {
    for (const t of [fine, fineHi]) for (const k of [...t.cells.keys()]) if (!k.includes(`·${camp}·`)) t.cells.delete(k);
  }
  const coarseKeys = ['全部', '全部·高強度', ...[...coarse.cells.keys()].filter((k) => !k.startsWith('全部')).sort()];
  printTable('粗分類（強者的決策點）', coarse, coarseKeys, withReplay);
  printTable('粗分類（自我對打的決策點；「強者實際」欄 = 機器人實際）', botPts, ['全部', ...[...botPts.cells.keys()].filter((k) => k !== '全部').sort()], false);
  const top = fine.top(topK, minN);
  printTable(`前 ${topK} 名差距處境（強者的決策點，n ≥ ${minN}，依 n × 平均|Δp|）`, fine, top.map(([k]) => k), withReplay);
  if (withReplay) {
    const emp = fine.topEmpirical(topK, minN);
    printTable(`前 ${topK} 名（經驗版：n × |強者實際 − 機器人重播|，不靠模型）`, fine, emp.map(([k]) => k), withReplay);
  }
  const topHi = fineHi.top(topK, Math.max(10, Math.round(minN / 2)));
  printTable(`前 ${topK} 名（只看高強度局，n ≥ ${Math.max(10, Math.round(minN / 2))}）`, fineHi, topHi.map(([k]) => k), withReplay);
  console.log(`\n${((Date.now() - started) / 60000).toFixed(1)} 分鐘`);
  const out = arg('--json');
  if (out) {
    const dump = (t: GapTable, keys: string[]): unknown => keys.map((k) => ({ k, ...t.cells.get(k) }));
    fs.writeFileSync(out, JSON.stringify({ top: dump(fine, top.map(([k]) => k)), topEmpirical: dump(fine, fine.topEmpirical(topK, minN).map(([k]) => k)), topHi: dump(fineHi, topHi.map(([k]) => k)), coarse: dump(coarse, coarseKeys) }));
  }
}

main();
