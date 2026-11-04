/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 資訊流（INFL）研究：信念在真人局的準度、以策略為本的投票概似原型（2026-11-04；docs/ai/infl_research.md）。
 *
 *   cd packages/server && nice -n 10 npx tsx scripts/inflBeliefAccuracy.ts [--only-folds 0,1,2] [--json out.json]
 *   cd packages/server && npx tsx scripts/inflBeliefAccuracy.ts --merge a.json b.json   # 合併子行程的結果並印表
 *
 * 選項：
 *   --cache PATH       牌譜快取（預設 ./sheets_cache.json；10 人局、嚴格重播 `sheetsReplay`）
 *   --limit N          只用前 N 局（測試用）
 *   --folds K          交叉擬合折數（預設 5；依局 id 雜湊分折）
 *   --only-folds a,b   只評估這幾折（分子行程跑；訓練一律用其他所有折）
 *   --bayes-view       投票特徵加「j 座位的貝氏信念」（較貴）
 *   --every K          每 K 個決策點評估一次後驗（預設 1 = 全部）
 *   --min-games N      角色王的門檻（預設 30 場）
 *   --json PATH        輸出可合併的累加器
 *
 * 量的東西（全部用留出折：模型與格子只用其他折擬合）：
 *   1. 票：每張可信的真人票，在真相世界下的對數概似（nats）、命中率；異常票（內黑＝在隊上反對、外白＝不在隊上贊成）
 *      的命中率與概似；「紅藍分離」= 真紅的票 log P(票|紅)/P(票|藍) 的平均 − 真藍的。模型：真人格子（訓練折重數）、
 *      現行預設的票格（機器人表＋關鍵局＋隊友格）、策略模型 (a)（INFL 特徵，角色依先驗混合）、(a)+殘差（再加真相「隊上有紅」）。
 *   2. 信念：一個忠臣座位（每局固定、雜湊挑）在每次提議的投票點，後驗放在真紅組的機率 P(W*)、log2 P(W*)、真紅／真藍的
 *      平均紅機率、前 4 名剛好是真紅（top4）、前 4 名命中幾個、莫德雷德的紅機率與名次。變體：現行預設（`bayesOptionsOf(預設)`，
 *      投票門檻與派隊用的）、金字塔（推理畫面上「每人紅的機率」用的：只有真人表）、L1* 均分、骨架＋不讀票／格子／策略。
 *      梅林座位只看莫德雷德。
 *   3. 真人對照：忠臣當隊長（任何忠臣座位）派的隊全藍的比例 vs 機器人在同一點用各信念挑的「最乾淨的隊」全藍的比例。
 * 群組：全部；角色王（每個角色勝率前 5、該角色 ≥ 門檻場數）在場的局／投票者／隊長（輸出只寫「角色王」，不寫名字）。
 */
import * as fs from 'fs';
import * as path from 'path';
import { rowsFromSheet, parseReplayGame, campOf, type ReplayGame } from '../src/ai/benchmark/sheetsReplay';
import { buildReplayObservation, seatId } from '../src/ai/benchmark/replayObservation';
import { buildCertainty } from '../src/ai/belief/Certainty';
import { bayesOptionsOf, bayesRedShare, bayesTeamClean } from '../src/ai/belief/BayesBelief';
import { DEFAULT_AGENT_TUNING } from '../src/ai/AgentTuning';
import { beliefOptionsFrom } from '../src/ai/belief/BeliefOptions';
import { flowOfGame, maskOf, popcount } from '../src/ai/infl/flow';
import { FlowFeatures, N_BASE, RED_CLASSES, type RoleClass } from '../src/ai/infl/voteFeatures';
import { collectTraining, fitPolicyModel, PolicyVoteReader, policyVoteProb, truthOf, type PolicyModel } from '../src/ai/infl/policyModel';
import { cellVoteProb, defaultVoteProb, fitCellTables, type CellTables } from '../src/ai/infl/cellTables';
import { bestTeamMask, sharesOf, skeletonPosterior, teamCleanOf, type WorldPosterior } from '../src/ai/infl/posterior';
import { roleKings, isRoleKing, type RoleKingCohort } from '../src/ai/infl/roleKings';
import { Acc, fmtNum, fmtPct, table, type AccStore } from '../src/ai/infl/acc';

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const has = (name: string): boolean => argv.includes(name);

const FULL_OPTS = bayesOptionsOf(DEFAULT_AGENT_TUNING);
// 金字塔（ForwardAgent 的嫌疑分數、推理畫面）是用 BeliefOptions 呼叫 bayesOptionsOf：沒有機器人表、關鍵局格、隊友格。
const PYRAMID_OPTS = bayesOptionsOf(beliefOptionsFrom(DEFAULT_AGENT_TUNING) as never);

function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

function loadGames(cache: string, limit?: number): ReplayGame[] {
  const data = JSON.parse(fs.readFileSync(cache, 'utf8')) as Record<string, string[][]>;
  const out: ReplayGame[] = [];
  for (const row of rowsFromSheet(data['牌譜'] ?? [])) {
    if (!(row['文字記錄'] ?? '').trim()) continue;
    const r = parseReplayGame(row);
    if (!r.ok || r.game.playerCount !== 10) continue;
    const roles = [...r.game.seatRoles].sort().join(',');
    if (roles !== 'assassin,loyal,loyal,loyal,loyal,merlin,mordred,morgana,oberon,percival') continue;
    out.push(r.game);
  }
  return limit !== undefined ? out.slice(0, limit) : out;
}

const bucketOf = (round: number): string => (round <= 2 ? 'R12' : 'R3+');

// ── 1. 票 ─────────────────────────────────────────────────────

interface VoteModels { cells: CellTables; a: PolicyModel; aRes: PolicyModel; aBayes?: PolicyModel }

function blueMarginal(m: PolicyModel, ff: FlowFeatures, i: number, j: string, w: number, mordredBit: number, approve: boolean): number {
  const pb = policyVoteProb(m, 'blue', ff.full(i, j, w, 'blue'), approve);
  const pm = policyVoteProb(m, 'merlin', ff.full(i, j, w, 'merlin', mordredBit), approve);
  return (5 / 6) * pb + (1 / 6) * pm;
}
function redMarginal(m: PolicyModel, ff: FlowFeatures, i: number, j: string, w: number, approve: boolean): number {
  let s = 0;
  for (const c of RED_CLASSES) s += policyVoteProb(m, c, ff.full(i, j, w, c), approve);
  return s / RED_CLASSES.length;
}

function scoreVotes(acc: Acc, game: ReplayGame, ff: FlowFeatures, models: VoteModels, kings: RoleKingCohort): void {
  const flow = ff.flow;
  const truth = truthOf(game, flow);
  const keyRoundOf = (round: number): boolean => game.quests.filter((q) => q.round < round && q.failed).length >= 2;
  flow.votes.forEach((v, i) => {
    if (!ff.reliable(i)) return;
    const teamMask = ff.teamMask(i);
    const hasRed = (truth.w & teamMask) !== 0;
    flow.ids.forEach((j, k) => {
      const vote = v.votes[j];
      if (vote === undefined) return;
      const red = campOf(game.seatRoles[k]) === 'evil';
      const on = v.team.includes(j);
      const abnormal = vote !== on;
      const subset = abnormal ? (on ? '內黑' : '外白') : '正常';
      const cls = truth.cls[k] as RoleClass;
      const king = isRoleKing(kings, game.names[k] ?? '', game.seatRoles[k]);
      const cohorts = king ? ['all', 'king'] : ['all'];
      // 「如果 j 是紅／藍」的假設世界（只為了紅藍分離這個診斷；p 用真相世界）。
      const jb = 1 << k;
      const wRed = truth.w | jb;
      const wBlue = truth.w & ~jb;
      const hasRedIf = (w: number): boolean => (w & teamMask) !== 0;
      const aloneIf = (w: number): boolean => popcount(w & teamMask) === 1;
      const kr = keyRoundOf(v.round);
      const probs: Record<string, { p: number; pr: number; pb: number }> = {};
      probs.humanCell = {
        p: cellVoteProb(models.cells, red, on, hasRed, v.round, vote),
        pr: cellVoteProb(models.cells, true, on, hasRedIf(wRed), v.round, vote),
        pb: cellVoteProb(models.cells, false, on, hasRedIf(wBlue), v.round, vote),
      };
      probs.defaultCell = {
        p: defaultVoteProb(red, on, hasRed, v.round, kr, red && aloneIf(truth.w), vote),
        pr: defaultVoteProb(true, on, hasRedIf(wRed), v.round, kr, aloneIf(wRed), vote),
        pb: defaultVoteProb(false, on, hasRedIf(wBlue), v.round, kr, false, vote),
      };
      const mordredBit = truth.mordredBit === jb ? 0 : truth.mordredBit;
      const policies: [string, PolicyModel | undefined][] = [['policyA', models.a], ['policyA+res', models.aRes], ['policyA+bayes', models.aBayes]];
      for (const [name, m] of policies) {
        if (!m) continue;
        const pr = redMarginal(m, ff, i, j, wRed, vote);
        const pb = blueMarginal(m, ff, i, j, wBlue, mordredBit, vote);
        const pTrue = red ? redMarginal(m, ff, i, j, truth.w, vote) : blueMarginal(m, ff, i, j, truth.w, truth.mordredBit, vote);
        probs[name] = { p: pTrue, pr, pb };
        probs[`${name}/role`] = { p: policyVoteProb(m, cls, ff.full(i, j, truth.w, cls, truth.mordredBit), vote), pr, pb };
      }
      for (const [name, x] of Object.entries(probs)) {
        const llr = Math.log(x.pr) - Math.log(x.pb);
        const metrics = { ll: Math.log(x.p), hit: x.p > 0.5 ? 1 : 0, llrRed: red ? llr : null, llrBlue: red ? null : llr };
        const keys: string[] = [];
        for (const c of cohorts) for (const b of [bucketOf(v.round), 'all']) for (const s of [subset, abnormal ? '異常' : '正常', 'all']) keys.push(`vote|${name}|${s}|${b}|${c}`);
        acc.add([...new Set(keys)], metrics);
      }
    });
  });
}

// ── 2. 信念 ───────────────────────────────────────────────────

function beliefMetrics(shares: readonly number[], pTrue: number, viewerIdx: number, redIdx: readonly number[], mordredIdx: number): Record<string, number> {
  const others = shares.map((p, k) => ({ p, k })).filter((x) => x.k !== viewerIdx);
  const sorted = [...others].sort((a, b) => b.p - a.p || a.k - b.k);
  const top4 = new Set(sorted.slice(0, 4).map((x) => x.k));
  const hits = redIdx.filter((k) => top4.has(k)).length;
  const redMean = redIdx.reduce((a, k) => a + shares[k], 0) / redIdx.length;
  const blues = others.filter((x) => !redIdx.includes(x.k));
  const blueMean = blues.reduce((a, x) => a + x.p, 0) / Math.max(1, blues.length);
  return {
    pTrue,
    log2pTrue: Math.log2(Math.max(pTrue, 1e-9)),
    redMean,
    blueMean,
    gap: redMean - blueMean,
    top4exact: hits === 4 ? 1 : 0,
    top4hits: hits / 4,
    mordredP: shares[mordredIdx],
    mordredRank: 1 + sorted.findIndex((x) => x.k === mordredIdx),
  };
}

function pointKeys(prefix: string, round: number, attempt: number, cohorts: readonly string[]): string[] {
  const out: string[] = [];
  for (const c of cohorts) for (const pt of [`R${round}-${attempt}`, `R${round}`, 'all']) out.push(`${prefix}|${pt}|${c}`);
  return out;
}

function uniformPosterior(obs: ReturnType<typeof buildReplayObservation>): WorldPosterior {
  const worlds = buildCertainty(obs).worlds('L1*');
  return { ids: obs.allPlayerIds, worlds, wts: worlds.map(() => 1 / worlds.length) };
}

interface Skeletons { none: WorldPosterior; cells: WorldPosterior; policyA: WorldPosterior; 'policyA+res': WorldPosterior; 'policyA+bayes'?: WorldPosterior }

function skeletons(obs: ReturnType<typeof buildReplayObservation>, models: VoteModels, readers: Record<string, PolicyVoteReader>): Skeletons {
  const out: Skeletons = {
    none: skeletonPosterior(obs, models.cells, { kind: 'none' }),
    cells: skeletonPosterior(obs, models.cells, { kind: 'cells' }),
    policyA: skeletonPosterior(obs, models.cells, { kind: 'policy', reader: readers.policyA }),
    'policyA+res': skeletonPosterior(obs, models.cells, { kind: 'policy', reader: readers['policyA+res'] }),
  };
  if (readers['policyA+bayes']) out['policyA+bayes'] = skeletonPosterior(obs, models.cells, { kind: 'policy', reader: readers['policyA+bayes'] });
  return out;
}

function scoreBelief(acc: Acc, game: ReplayGame, ff: FlowFeatures, models: VoteModels, kings: RoleKingCohort, every: number, timing: Record<string, number>): void {
  const flow = ff.flow;
  const truth = truthOf(game, flow);
  const redIdx = game.seatRoles.map((r, k) => (campOf(r) === 'evil' ? k : -1)).filter((k) => k >= 0);
  const mordredIdx = game.seatRoles.indexOf('mordred');
  const kingReds = redIdx.filter((k) => isRoleKing(kings, game.names[k] ?? '', game.seatRoles[k])).length;
  const cohorts = kingReds > 0 ? ['all', 'kingRed'] : ['all'];
  const loyalSeats = game.seatRoles.map((r, k) => (r === 'loyal' ? k + 1 : 0)).filter((s) => s > 0);
  const viewerSeat = loyalSeats[fnv(game.id) % loyalSeats.length];
  const merlinSeat = game.seatRoles.indexOf('merlin') + 1;
  const readers: Record<string, PolicyVoteReader> = { policyA: new PolicyVoteReader(models.a, ff), 'policyA+res': new PolicyVoteReader(models.aRes, ff) };
  if (models.aBayes) readers['policyA+bayes'] = new PolicyVoteReader(models.aBayes, ff);
  const tick = (name: string, t0: number): void => { timing[name] = (timing[name] ?? 0) + (Date.now() - t0); timing[`${name}#`] = (timing[`${name}#`] ?? 0) + 1; };
  game.proposals.forEach((p, n) => {
    if (n % every !== 0) return;
    // 忠臣座位
    const obs = buildReplayObservation(game, viewerSeat, { kind: 'team_vote', proposal: n });
    const trueBlues = flow.ids.filter((_, k) => !redIdx.includes(k));
    const vIdx = viewerSeat - 1;
    let t0 = Date.now();
    const dShare = bayesRedShare(obs, FULL_OPTS);
    const dTrue = bayesTeamClean(obs, trueBlues, FULL_OPTS) ?? 0;
    tick('default', t0);
    acc.add(pointKeys('belief|loyal|default', p.round, p.attempt, cohorts), beliefMetrics(flow.ids.map((id) => dShare.get(id) ?? 0), dTrue, vIdx, redIdx, mordredIdx));
    t0 = Date.now();
    const yShare = bayesRedShare(obs, PYRAMID_OPTS);
    const yTrue = bayesTeamClean(obs, trueBlues, PYRAMID_OPTS) ?? 0;
    tick('pyramid', t0);
    acc.add(pointKeys('belief|loyal|pyramid', p.round, p.attempt, cohorts), beliefMetrics(flow.ids.map((id) => yShare.get(id) ?? 0), yTrue, vIdx, redIdx, mordredIdx));
    const uni = uniformPosterior(obs);
    acc.add(pointKeys('belief|loyal|uniform', p.round, p.attempt, cohorts), beliefMetrics(sharesOf(uni), teamCleanOf(uni, maskOf(flow, trueBlues)), vIdx, redIdx, mordredIdx));
    t0 = Date.now();
    const sk = skeletons(obs, models, readers);
    tick('skeletons', t0);
    for (const [name, post] of Object.entries(sk) as [string, WorldPosterior][]) {
      acc.add(pointKeys(`belief|loyal|${name}`, p.round, p.attempt, cohorts), beliefMetrics(sharesOf(post), teamCleanOf(post, maskOf(flow, trueBlues)), vIdx, redIdx, mordredIdx));
    }
    // 梅林座位：只看莫德雷德（三個看得到的紅是確定的）
    const mObs = buildReplayObservation(game, merlinSeat, { kind: 'team_vote', proposal: n });
    const unseen = flow.ids.map((_, k) => k).filter((k) => k !== merlinSeat - 1 && !mObs.knownEvils.includes(flow.ids[k]));
    const mordredMetrics = (shares: readonly number[]): Record<string, number> => {
      const sorted = [...unseen].sort((a, b) => shares[b] - shares[a] || a - b);
      return { mordredP: shares[mordredIdx], mordredTop1: sorted[0] === mordredIdx ? 1 : 0, mordredRank: 1 + sorted.indexOf(mordredIdx), log2pMordred: Math.log2(Math.max(shares[mordredIdx], 1e-9)) };
    };
    const md = bayesRedShare(mObs, FULL_OPTS);
    acc.add(pointKeys('belief|merlin|default', p.round, p.attempt, cohorts), mordredMetrics(flow.ids.map((id) => md.get(id) ?? 0)));
    const my = bayesRedShare(mObs, PYRAMID_OPTS);
    acc.add(pointKeys('belief|merlin|pyramid', p.round, p.attempt, cohorts), mordredMetrics(flow.ids.map((id) => my.get(id) ?? 0)));
    acc.add(pointKeys('belief|merlin|uniform', p.round, p.attempt, cohorts), mordredMetrics(sharesOf(uniformPosterior(mObs))));
    const msk = skeletons(mObs, models, readers);
    for (const [name, post] of Object.entries(msk) as [string, WorldPosterior][]) {
      acc.add(pointKeys(`belief|merlin|${name}`, p.round, p.attempt, cohorts), mordredMetrics(sharesOf(post)));
    }
    // 3. 真人對照：忠臣隊長派的隊全藍 vs 機器人最乾淨的隊全藍
    const leaderSeat = p.leaderSeat;
    if (game.seatRoles[leaderSeat - 1] === 'loyal') {
      const lObs = buildReplayObservation(game, leaderSeat, { kind: 'team_select', proposal: n });
      const me = seatId(leaderSeat);
      const size = p.teamSeats.length;
      const humanClean = p.teamSeats.every((s) => campOf(game.seatRoles[s - 1]) === 'good') ? 1 : 0;
      const name = game.names[leaderSeat - 1] ?? '';
      const lc = ['all'];
      if (isRoleKing(kings, name, 'loyal')) lc.push('king');
      if (name === 'ED') lc.push('ED');
      const ids = flow.ids;
      const idsOf = (mask: number): string[] => ids.filter((_, k) => (mask & (1 << k)) !== 0);
      const cleanTruth = (mask: number): number => ((mask & truth.w) === 0 ? 1 : 0);
      const dBest = bestTeamMask((m) => bayesTeamClean(lObs, idsOf(m), FULL_OPTS) ?? 0, ids, me, size);
      const lsk = skeletons(lObs, models, readers);
      const metrics: Record<string, number> = {
        human: humanClean,
        random: choose(5, size - 1) / choose(9, size - 1),
        default: cleanTruth(dBest.mask),
        defaultPredicted: dBest.p,
        humanTeamDefaultP: bayesTeamClean(lObs, p.teamSeats.map(seatId), FULL_OPTS) ?? 0,
        sameAsDefault: dBest.mask === maskOf(flow, p.teamSeats.map(seatId)) ? 1 : 0,
      };
      for (const [nm, post] of Object.entries(lsk) as [string, WorldPosterior][]) {
        const b = bestTeamMask((m) => teamCleanOf(post, m), ids, me, size);
        metrics[nm] = cleanTruth(b.mask);
        metrics[`${nm}Predicted`] = b.p;
      }
      acc.add(pointKeys('leader|loyal', p.round, p.attempt, lc), metrics);
    }
  });
}

function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

// ── 印表 ─────────────────────────────────────────────────────

function report(acc: Acc, meta: Record<string, unknown>): void {
  console.log(`\n資料：${JSON.stringify(meta)}`);
  const voteModels = ['humanCell', 'defaultCell', 'policyA', 'policyA+res', 'policyA+bayes', 'policyA/role', 'policyA+res/role', 'policyA+bayes/role'];
  for (const cohort of ['all', 'king']) {
    console.log(`\n## 1. 真人票的對數概似（nats/票，越接近 0 越好）與命中率、紅藍分離（群組 ${cohort}）`);
    const rows: string[][] = [['模型', 'n', 'LL 全部', 'LL R12', 'LL R3+', '命中', '異常 LL', '異常命中', '內黑命中', '外白命中', '紅藍分離 全部', '分離 R3+']];
    for (const m of voteModels) {
      const k = (s: string, b: string): string => `vote|${m}|${s}|${b}|${cohort}`;
      if (acc.count(k('all', 'all')) === 0) continue;
      const sep = (b: string): number | null => {
        const r = acc.mean(k('all', b), 'llrRed');
        const bl = acc.mean(k('all', b), 'llrBlue');
        return r === null || bl === null ? null : r - bl;
      };
      rows.push([m, String(acc.count(k('all', 'all'))), fmtNum(acc.mean(k('all', 'all'), 'll')), fmtNum(acc.mean(k('all', 'R12'), 'll')), fmtNum(acc.mean(k('all', 'R3+'), 'll')),
        fmtPct(acc.mean(k('all', 'all'), 'hit')), fmtNum(acc.mean(k('異常', 'all'), 'll')), fmtPct(acc.mean(k('異常', 'all'), 'hit')),
        fmtPct(acc.mean(k('內黑', 'all'), 'hit')), fmtPct(acc.mean(k('外白', 'all'), 'hit')), fmtNum(sep('all')), fmtNum(sep('R3+'))]);
    }
    console.log(table(rows));
  }
  const variants = ['default', 'pyramid', 'uniform', 'none', 'cells', 'policyA', 'policyA+res', 'policyA+bayes'];
  for (const cohort of ['all', 'kingRed']) {
    console.log(`\n## 2. 忠臣座位的信念（群組 ${cohort}）：P(W*) / log2 P(W*) / 真紅平均 − 真藍平均 / top4 全中 / 莫德雷德紅機率`);
    const pts = ['R1', 'R2', 'R3', 'R4', 'R5', 'all'];
    const rows: string[][] = [['變體', ...pts.map((x) => `${x}`)]];
    for (const v of variants) {
      const k = (pt: string): string => `belief|loyal|${v}|${pt}|${cohort}`;
      if (acc.count(k('all')) === 0) continue;
      rows.push([v, ...pts.map((pt) => `${fmtPct(acc.mean(k(pt), 'pTrue'))} ${fmtNum(acc.mean(k(pt), 'log2pTrue'), 2)} ${fmtNum(acc.mean(k(pt), 'gap'), 3)} ${fmtPct(acc.mean(k(pt), 'top4exact'))} ${fmtPct(acc.mean(k(pt), 'mordredP'))}`)]);
    }
    rows.push(['n', ...pts.map((pt) => String(acc.count(`belief|loyal|default|${pt}|${cohort}`)))]);
    console.log(table(rows));
    console.log('\n各次提議（P(W*) / top4 全中；現行預設 vs 策略）：');
    const att: string[][] = [['點', 'n', 'default', 'pyramid', 'cells', 'policyA', 'policyA+res']];
    for (let r = 1; r <= 5; r++) for (let a = 1; a <= 5; a++) {
      const pt = `R${r}-${a}`;
      const n = acc.count(`belief|loyal|default|${pt}|${cohort}`);
      if (n < 20) continue;
      att.push([pt, String(n), ...['default', 'pyramid', 'cells', 'policyA', 'policyA+res'].map((v) => `${fmtPct(acc.mean(`belief|loyal|${v}|${pt}|${cohort}`, 'pTrue'))} ${fmtPct(acc.mean(`belief|loyal|${v}|${pt}|${cohort}`, 'top4exact'))}`)]);
    }
    console.log(table(att));
    console.log(`\n梅林座位（群組 ${cohort}）：莫德雷德紅機率 / 最可疑的就是莫德雷德（top1）/ 名次（6 人中）`);
    const mrows: string[][] = [['變體', ...pts]];
    for (const v of variants) {
      const k = (pt: string): string => `belief|merlin|${v}|${pt}|${cohort}`;
      if (acc.count(k('all')) === 0) continue;
      mrows.push([v, ...pts.map((pt) => `${fmtPct(acc.mean(k(pt), 'mordredP'))} ${fmtPct(acc.mean(k(pt), 'mordredTop1'))} ${fmtNum(acc.mean(k(pt), 'mordredRank'), 2)}`)]);
    }
    console.log(table(mrows));
  }
  for (const cohort of ['all', 'king', 'ED']) {
    console.log(`\n## 3. 忠臣隊長派的隊全藍（群組 ${cohort}）：真人 / 隨機 / 機器人最乾淨的隊（各信念）`);
    const pts = ['R1', 'R2', 'R3', 'R4', 'R5', 'all'];
    const cols = ['human', 'random', 'default', 'defaultPredicted', 'humanTeamDefaultP', 'sameAsDefault', 'cells', 'policyA', 'policyA+res', 'policyA+bayes', 'none'];
    const rows: string[][] = [['點', 'n', ...cols]];
    for (const pt of pts) {
      const k = `leader|loyal|${pt}|${cohort}`;
      if (acc.count(k) === 0) continue;
      rows.push([pt, String(acc.count(k)), ...cols.map((c) => fmtPct(acc.mean(k, c)))]);
    }
    console.log(table(rows));
  }
}

// ── main ─────────────────────────────────────────────────────

function main(): void {
  const mergeAt = argv.indexOf('--merge');
  if (mergeAt >= 0) {
    const acc = new Acc();
    let meta: Record<string, unknown> = {};
    const mergeEnd = argv.findIndex((a, i) => i > mergeAt && a.startsWith('--'));
    for (const f of argv.slice(mergeAt + 1, mergeEnd < 0 ? undefined : mergeEnd)) {
      const j = JSON.parse(fs.readFileSync(f, 'utf8')) as { acc: AccStore; meta: Record<string, unknown> };
      acc.merge(j.acc);
      meta = { ...meta, ...j.meta, folds: [...((meta.folds as number[]) ?? []), ...((j.meta.folds as number[]) ?? [])] };
    }
    report(acc, meta);
    const out = arg('--json');
    if (out) fs.writeFileSync(out, JSON.stringify({ meta, acc: acc.store }));
    return;
  }
  const started = Date.now();
  const cache = path.resolve(arg('--cache') ?? path.resolve(__dirname, '..', 'sheets_cache.json'));
  const limit = arg('--limit') !== undefined ? Number(arg('--limit')) : undefined;
  const K = Number(arg('--folds') ?? 5);
  const onlyFolds = (arg('--only-folds') ?? Array.from({ length: K }, (_, i) => i).join(',')).split(',').map(Number);
  const bayesView = has('--bayes-view');
  const every = Number(arg('--every') ?? 1);
  const minGames = Number(arg('--min-games') ?? 30);
  const games = loadGames(cache, limit);
  const kings = roleKings(loadGames(cache), 5, minGames);
  const foldOf = (g: ReplayGame): number => fnv(`fold|${g.id}`) % K;
  console.log(`games ${games.length}; folds ${K}; evaluating ${onlyFolds.join(',')}; bayesView ${bayesView}`);
  const items = games.map((game) => ({ game, features: new FlowFeatures(flowOfGame(game), { useBayesView: bayesView }) }));
  let t0 = Date.now();
  const train = collectTraining(items);
  console.log(`training samples: ${Object.entries(train.ys).map(([c, y]) => `${c}=${y.length}`).join(' ')} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  const acc = new Acc();
  const timing: Record<string, number> = {};
  const coef: Record<string, Record<string, number[]>> = {};
  for (const fold of onlyFolds) {
    t0 = Date.now();
    const include = (gi: number): boolean => foldOf(items[gi].game) !== fold;
    const trainGames = items.filter((x) => foldOf(x.game) !== fold).map((x) => x.game);
    const models: VoteModels = {
      cells: fitCellTables(trainGames),
      a: fitPolicyModel(train, { residual: false, useBayesView: false, include }),
      aRes: fitPolicyModel(train, { residual: true, useBayesView: false, include }),
      aBayes: bayesView ? fitPolicyModel(train, { residual: false, useBayesView: true, include }) : undefined,
    };
    coef[`fold${fold}`] = Object.fromEntries(Object.entries(models.a.beta).map(([c, b]) => [c, Array.from(b).map((x) => Math.round(x * 1000) / 1000)]));
    console.log(`fold ${fold}: fitted in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    const test = items.filter((x) => foldOf(x.game) === fold);
    let done = 0;
    for (const { game, features } of test) {
      scoreVotes(acc, game, features, models, kings);
      scoreBelief(acc, game, features, models, kings, every, timing);
      if (++done % 50 === 0) process.stderr.write(`  fold ${fold}: ${done}/${test.length} (${((Date.now() - started) / 60000).toFixed(1)} min)\n`);
    }
  }
  const meta = { games: games.length, folds: onlyFolds, K, bayesView, every, minGames, nBase: N_BASE, timingMs: Object.fromEntries(Object.entries(timing).filter(([k]) => !k.endsWith('#')).map(([k, v]) => [k, v / Math.max(1, timing[`${k}#`])])) };
  report(acc, meta);
  console.log(`\n係數（第一折、策略 (a)）：${JSON.stringify(coef[Object.keys(coef)[0]] ?? {})}`);
  console.log(`elapsed ${((Date.now() - started) / 60000).toFixed(1)} min`);
  const out = arg('--json');
  if (out) fs.writeFileSync(out, JSON.stringify({ meta, acc: acc.store, coef }));
}

main();
