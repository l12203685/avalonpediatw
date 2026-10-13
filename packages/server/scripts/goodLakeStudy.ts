/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * Good Lady-of-the-Lake study — whom do human blue holders inspect?
 *
 *   pnpm --filter @avalon/server exec tsx scripts/goodLakeStudy.ts \
 *     [--player ED --player Sin] [--json out.json] [--cache PATH]
 *
 * Reads `sheets_cache.json` → `牌譜` with the strict replay parser of the
 * agreement benchmark (`parseReplayGame`, games whose lake chain is valid)
 * and, for every lake held by a good seat (Merlin / Percival / loyal),
 * describes the target against the legal candidates:
 *   - had been on a mission (any / a failed one / a successful one / only
 *     successful ones) before the lake;
 *   - public-suspicion rank among the legal candidates
 *     (`estimateSuspicionFromHistory`: most / least suspicious, percentile);
 *   - turned out good;
 *   - inside the role avoid-set (Merlin: a red he sees; Percival: a thumb);
 *   - `goodLakeInfoMax` model diagnostics: the target is the candidate the
 *     holder's belief rates most likely good, and the model's own pick.
 * Split by mission score at the lake (blue : red), lake index and holder
 * role. Every rate has n and a Wilson 95% interval; "chance" is the
 * expectation of a uniform pick among the same legal candidates.
 *
 * It also prints how often each agent rule and each trust-term form of
 * the model (`TRUST_VARIANTS`, scored on the same model analysis) picks the
 * human's target — overall and per score — and a paired comparison of
 * `goodLakeTargetMostSuspicious` vs `goodLakeInfoMax` on the same lakes
 * (discordant counts, exact two-sided McNemar p). The variants were
 * compared on these same logs, so their agreement rates are in-sample.
 *
 * Output is aggregate only; `--player NAME` adds per-player cohorts (the
 * public docs only use the ED / Sin cohort labels).
 *
 * Edward 2026-10-13: the good holder's principle is to make the blues'
 * shared picture clearer (maximise common information); preferred targets
 * went on missions and are most likely good / most informative.
 */

import * as fs from 'fs';
import * as path from 'path';
import { rowsFromSheet, parseReplayGame, campOf, type ReplayGame } from '../src/ai/benchmark/sheetsReplay';
import { buildReplayObservation, seatId, validLakeTargetSeats } from '../src/ai/benchmark/replayObservation';
import { computeTopPerformers, cohortKey } from '../src/ai/benchmark/cohorts';
import { estimateSuspicionFromHistory, pickLakeTargetForTeam } from '../src/ai/LakePolicy';
import { AVALON_CONFIG } from '@avalon/shared';
import { analyzeGoodLake, pickGoodLakeTargetInfoMax, type GoodLakeInfoAnalysis } from '../src/ai/GoodLakeInfo';
import { LEGACY_AGENT_TUNING, type AgentTuning } from '../src/ai/AgentTuning';
import type { PlayerObservation } from '../src/ai/types';

/** Agent rules profiled next to the human picks (same legal candidates). */
const AGENT_RULES: ReadonlyArray<[string, AgentTuning]> = [
  ['legacy (首湖藍)', { ...LEGACY_AGENT_TUNING }],
  ['goodLakeTargetMostSuspicious', { ...LEGACY_AGENT_TUNING, goodLakeTargetMostSuspicious: true }],
  ['goodLakeInfoMax', { ...LEGACY_AGENT_TUNING, goodLakeInfoMax: true }],
];

/**
 * Trust-term forms of the `goodLakeInfoMax` model, all scored on the same
 * `analyzeGoodLake` output: score(c) = ΔH(c) + trust(c), V = max(0, best
 * ΔH), on = the model's own score-state rule (another lake follows and red
 * has not won two). The final form λ·(1 − 2p)·V with λ = 1 equals a weight
 * of 2 on P(good)·V (the −λV part is common to every candidate), so the
 * "weight 2" row must match the model pick exactly — checked below.
 */
interface VariantCtx {
  obs: PlayerObservation;
  analysis: GoodLakeInfoAnalysis;
  /** Score-state rule of the model (λ > 0). */
  on: boolean;
  /** Another lake follows (ignores the 兩紅 rule). */
  nextLake: boolean;
  /** Lakes still to come after this one. */
  remaining: number;
  V: number;
}
type VariantScore = (c: GoodLakeInfoAnalysis['candidates'][number], x: VariantCtx) => number;
const TRUST_VARIANTS: ReadonlyArray<[string, VariantScore | 'mission-goers']> = [
  ['info only (λ = 0)', (c) => c.infoGain],
  ['trust weight 1 on P(good)·V', (c, x) => c.infoGain + (x.on ? 1 : 0) * (1 - c.pEvil) * x.V],
  ['trust weight 2 on P(good)·V (= final λ(1−2p)V, λ = 1)', (c, x) => c.infoGain + (x.on ? 2 : 0) * (1 - c.pEvil) * x.V],
  ['trust weight 4 (λ = 2)', (c, x) => c.infoGain + (x.on ? 4 : 0) * (1 - c.pEvil) * x.V],
  ['final form, trust kept on at 兩紅 (0 at the last lake)', (c, x) => c.infoGain + (x.nextLake ? 1 : 0) * (1 - 2 * c.pEvil) * x.V],
  ['final form × lakes still to come', (c, x) => c.infoGain + (x.on ? x.remaining : 0) * (1 - 2 * c.pEvil) * x.V],
  ['most likely good (holder belief)', (c) => -c.pEvil],
  ['most likely good among mission-goers', 'mission-goers'],
];
const FINAL_VARIANT = 2;

/** argmax with the model's tie rule: |diff| < 1e-9 → seat order. */
function argmaxBySeat(ids: readonly string[], f: (id: string) => number, order: readonly string[]): string | undefined {
  return [...ids].sort((a, b) => {
    const d = f(b) - f(a);
    if (Math.abs(d) > 1e-9) return d;
    return order.indexOf(a) - order.indexOf(b);
  })[0];
}

function variantPicks(obs: PlayerObservation, pool: readonly string[], analysis: GoodLakeInfoAnalysis): string[] {
  const rounds = AVALON_CONFIG[obs.playerCount]?.questTeams.length ?? 5;
  const ctx: VariantCtx = {
    obs,
    analysis,
    on: analysis.trustWeight > 0,
    nextLake: obs.currentRound + 2 <= rounds,
    remaining: Math.max(0, rounds - 1 - obs.currentRound),
    V: Math.max(0, ...analysis.candidates.map((c) => c.infoGain)),
  };
  const byId = new Map(analysis.candidates.map((c) => [c.id, c]));
  return TRUST_VARIANTS.map(([, score]) => {
    if (score === 'mission-goers') {
      const mp = pool.filter((id) => byId.get(id)?.wentOnMission);
      return argmaxBySeat(mp.length > 0 ? mp : pool, (id) => -(byId.get(id)?.pEvil ?? 1), obs.allPlayerIds) ?? '';
    }
    return argmaxBySeat(pool, (id) => { const c = byId.get(id); return c ? score(c, ctx) : -Infinity; }, obs.allPlayerIds) ?? '';
  });
}

/** Exact two-sided McNemar p (binomial ½ on the discordant pairs). */
function mcnemarExact(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  let logC = 0;
  let tail = 0;
  for (let i = 0; i <= k; i++) {
    if (i > 0) logC += Math.log(n - i + 1) - Math.log(i);
    tail += Math.exp(logC - n * Math.LN2);
  }
  return Math.min(1, 2 * tail);
}

function fmtP(p: number): string {
  return p < 1e-4 ? p.toExponential(1) : p.toFixed(4);
}

interface Args {
  players: string[];
  json?: string;
  cache: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { players: [], cache: path.resolve(__dirname, '..', 'sheets_cache.json') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case '--player': args.players.push(...next().split(',').map((s) => s.trim()).filter(Boolean)); break;
      case '--json': args.json = next(); break;
      case '--cache': args.cache = path.resolve(next()); break;
      case '--help': case '-h':
        console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
        process.exit(0);
        break;
      default: throw new Error(`unknown argument ${a}`);
    }
  }
  return args;
}

// ── Statistics ─────────────────────────────────────────────────

interface Rate {
  k: number;
  n: number;
  rate: number;
  low: number;
  high: number;
  /** Expected rate of a uniform pick among the same candidates (when meaningful). */
  chance?: number;
}

function wilsonRate(k: number, n: number): Rate {
  if (n === 0) return { k, n, rate: 0, low: 0, high: 0 };
  const z = 1.959964;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { k, n, rate: p, low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

function fmt(r: Rate): string {
  if (r.n === 0) return '— (n=0)';
  const p = (x: number): string => `${(x * 100).toFixed(1)}%`;
  const chance = r.chance === undefined ? '' : `  (chance ${p(r.chance)})`;
  return `${p(r.rate)} [${p(r.low)}, ${p(r.high)}] ${r.k}/${r.n}${chance}`;
}

// ── Per-lake record ────────────────────────────────────────────

/** Per-candidate flags; the target's flags are `cands[targetIdx]`. */
interface Cand {
  seat: number;
  anyMission: boolean;
  failedMission: boolean;
  successMission: boolean;
  good: boolean;
  avoid: boolean;
  susp: number;
}

export interface GoodLake {
  gameId: string;
  name: string;
  role: string;
  lakeIdx: number;
  round: number;
  goodWins: number;
  evilWins: number;
  cands: Cand[];
  target: Cand;
  /** Suspicion percentile of the target among the legal candidates (0 = most suspicious, 1 = least). */
  suspPercentile: number;
  isMostSuspicious: boolean;
  isLeastSuspicious: boolean;
  chanceMostSuspicious: number;
  chanceLeastSuspicious: number;
  /** Model: target = the non-avoid candidate the holder's belief rates most likely good. */
  modelMostLikelyGood: boolean;
  /** Model: target = most likely good among non-avoid candidates who went on a mission. */
  modelMostLikelyGoodMission: boolean | null;
  /** The `goodLakeInfoMax` pick equals the human target (non-avoid candidates). */
  modelPickMatch: boolean | null;
  /** Holder belief P(target is red). */
  targetPEvil: number | null;
  /** Each agent rule's pick (`AGENT_RULES` order) on the same candidates. */
  agentPicks: Cand[];
  /** Each `TRUST_VARIANTS` pick equals the human target (null: no model analysis). */
  variantMatch: boolean[] | null;
  /** The final-form variant disagrees with `pickGoodLakeTargetInfoMax` (must stay false). */
  variantMismatch: boolean;
}

function collect(games: readonly ReplayGame[]): GoodLake[] {
  const out: GoodLake[] = [];
  for (const game of games) {
    if (!game.lakeChainValid) continue;
    game.lakes.forEach((lake, lakeIdx) => {
      const holder = lake.holderSeat;
      const role = game.seatRoles[holder - 1];
      if (campOf(role) !== 'good') return;
      const obs = buildReplayObservation(game, holder, { kind: 'lake', lake: lakeIdx });
      const valid = validLakeTargetSeats(game, lakeIdx);
      const avoid = new Set([...obs.knownEvils, ...(obs.knownWizards ?? [])]);
      const before = game.quests.filter((q) => q.round <= lake.round);
      const cands: Cand[] = valid.map((s) => ({
        seat: s,
        anyMission: before.some((q) => q.teamSeats.includes(s)),
        failedMission: before.some((q) => q.failed && q.teamSeats.includes(s)),
        successMission: before.some((q) => !q.failed && q.teamSeats.includes(s)),
        good: campOf(game.seatRoles[s - 1]) === 'good',
        avoid: avoid.has(seatId(s)),
        susp: estimateSuspicionFromHistory(seatId(s), obs),
      }));
      const target = cands.find((c) => c.seat === lake.targetSeat);
      if (!target) return;
      const others = cands.filter((c) => c !== target);
      const higher = others.filter((c) => c.susp > target.susp).length;
      const lower = others.filter((c) => c.susp < target.susp).length;
      const ties = others.length - higher - lower;
      const maxS = Math.max(...cands.map((c) => c.susp));
      const minS = Math.min(...cands.map((c) => c.susp));

      const pool = cands.filter((c) => !c.avoid).map((c) => seatId(c.seat));
      const analysis = pool.length > 0 ? analyzeGoodLake(obs, pool) : null;
      let modelMostLikelyGood = false;
      let modelMostLikelyGoodMission: boolean | null = null;
      let modelPickMatch: boolean | null = null;
      let targetPEvil: number | null = null;
      let variantMatch: boolean[] | null = null;
      let variantMismatch = false;
      if (analysis) {
        const pe = new Map(analysis.candidates.map((c) => [c.id, c.pEvil]));
        // Same tie rule as the model (|diff| < 1e-9 → seat order).
        const mostLikelyGood = (ids: readonly string[]): string | undefined =>
          argmaxBySeat(ids, (id) => -(pe.get(id) ?? 1), obs.allPlayerIds);
        const tid = seatId(target.seat);
        modelMostLikelyGood = mostLikelyGood(pool) === tid;
        const missionPool = pool.filter((id) => cands.find((c) => seatId(c.seat) === id)?.anyMission);
        if (missionPool.length > 0) modelMostLikelyGoodMission = mostLikelyGood(missionPool) === tid;
        const modelPick = pickGoodLakeTargetInfoMax(obs, pool);
        modelPickMatch = modelPick === tid;
        targetPEvil = pe.get(tid) ?? null;
        const vp = variantPicks(obs, pool, analysis);
        variantMatch = vp.map((id) => id === tid);
        variantMismatch = vp[FINAL_VARIANT] !== modelPick;
      }
      const agentPicks = AGENT_RULES.map(([, tuning]) => {
        const id = pickLakeTargetForTeam('good', obs, valid.map(seatId), tuning);
        return cands.find((c) => seatId(c.seat) === id) ?? target;
      });

      out.push({
        gameId: game.id,
        name: game.names[holder - 1] ?? '',
        role,
        lakeIdx,
        round: lake.round,
        goodWins: obs.questResults.filter((r) => r === 'success').length,
        evilWins: obs.questResults.filter((r) => r === 'fail').length,
        cands,
        target,
        suspPercentile: others.length === 0 ? 0.5 : (higher + 0.5 * ties) / others.length,
        isMostSuspicious: target.susp === maxS,
        isLeastSuspicious: target.susp === minS,
        chanceMostSuspicious: cands.filter((c) => c.susp === maxS).length / cands.length,
        chanceLeastSuspicious: cands.filter((c) => c.susp === minS).length / cands.length,
        modelMostLikelyGood,
        modelMostLikelyGoodMission,
        modelPickMatch,
        targetPEvil,
        agentPicks,
        variantMatch,
        variantMismatch,
      });
    });
  }
  return out;
}

// ── Report ─────────────────────────────────────────────────────

interface Section {
  title: string;
  rows: Array<{ label: string; rate: Rate }>;
  note?: string;
}

function rateWithChance(items: readonly GoodLake[], pred: (c: Cand) => boolean): Rate {
  const r = wilsonRate(items.filter((l) => pred(l.target)).length, items.length);
  if (items.length > 0) {
    r.chance = items.reduce((a, l) => a + l.cands.filter(pred).length / l.cands.length, 0) / items.length;
  }
  return r;
}

function rateOf(items: readonly GoodLake[], pred: (l: GoodLake) => boolean, chance?: (l: GoodLake) => number): Rate {
  const r = wilsonRate(items.filter(pred).length, items.length);
  if (chance && items.length > 0) r.chance = items.reduce((a, l) => a + chance(l), 0) / items.length;
  return r;
}

function profile(title: string, items: readonly GoodLake[]): Section {
  const meanPct = items.length === 0 ? 0 : items.reduce((a, l) => a + l.suspPercentile, 0) / items.length;
  const withModel = items.filter((l) => l.modelPickMatch !== null);
  const withMissionPool = items.filter((l) => l.modelMostLikelyGoodMission !== null);
  return {
    title: `${title} (n=${items.length})`,
    rows: [
      { label: 'target had been on a mission', rate: rateWithChance(items, (c) => c.anyMission) },
      { label: 'target on a failed mission', rate: rateWithChance(items, (c) => c.failedMission) },
      { label: 'target on a successful mission', rate: rateWithChance(items, (c) => c.successMission) },
      { label: 'target only on successful missions', rate: rateWithChance(items, (c) => c.successMission && !c.failedMission) },
      { label: 'target never on a mission', rate: rateWithChance(items, (c) => !c.anyMission) },
      { label: 'target most suspicious (incl. ties)', rate: rateOf(items, (l) => l.isMostSuspicious, (l) => l.chanceMostSuspicious) },
      { label: 'target least suspicious (incl. ties)', rate: rateOf(items, (l) => l.isLeastSuspicious, (l) => l.chanceLeastSuspicious) },
      { label: 'target turned out good', rate: rateWithChance(items, (c) => c.good) },
      { label: 'target in the role avoid-set', rate: rateWithChance(items, (c) => c.avoid) },
      { label: 'model: target = most likely good', rate: rateOf(withModel, (l) => l.modelMostLikelyGood) },
      { label: 'model: = most likely good among mission-goers', rate: rateOf(withMissionPool, (l) => l.modelMostLikelyGoodMission === true) },
      { label: 'model: goodLakeInfoMax pick = target', rate: rateOf(withModel, (l) => l.modelPickMatch === true) },
    ],
    note: `mean suspicion percentile ${(meanPct * 100).toFixed(1)}% (0 = most suspicious, 100 = least; chance 50%)`,
  };
}

/** Same features for the human target and each agent rule's pick. */
function picksProfile(title: string, items: readonly GoodLake[]): Section {
  const rows: Array<{ label: string; rate: Rate }> = [];
  const pickers: Array<[string, (l: GoodLake) => Cand]> = [
    ['human', (l) => l.target],
    ...AGENT_RULES.map(([name], i) => [name, (l: GoodLake) => l.agentPicks[i]] as [string, (l: GoodLake) => Cand]),
  ];
  const feats: Array<[string, (c: Cand, l: GoodLake) => boolean]> = [
    ['on a mission', (c) => c.anyMission],
    ['on a failed mission', (c) => c.failedMission],
    ['only on successful missions', (c) => c.successMission && !c.failedMission],
    ['turned out good', (c) => c.good],
    ['most suspicious (incl. ties)', (c, l) => c.susp === Math.max(...l.cands.map((x) => x.susp))],
    ['least suspicious (incl. ties)', (c, l) => c.susp === Math.min(...l.cands.map((x) => x.susp))],
  ];
  for (const [fname, f] of feats) {
    for (const [pname, pick] of pickers) {
      rows.push({ label: `${fname} — ${pname}`, rate: wilsonRate(items.filter((l) => f(pick(l), l)).length, items.length) });
    }
  }
  for (const [pname, pick] of pickers.slice(1)) {
    rows.push({ label: `same target as the human — ${pname}`, rate: wilsonRate(items.filter((l) => pick(l) === l.target).length, items.length) });
  }
  return { title: `${title} (n=${items.length})`, rows };
}

/**
 * How often each agent rule (real `LakePolicy` picks) and each trust-term
 * form (`TRUST_VARIANTS`) picks the human's target, plus the paired
 * most-suspicious vs goodLakeInfoMax comparison on the same lakes.
 */
function agreementSection(title: string, items: readonly GoodLake[]): Section {
  const rows: Array<{ label: string; rate: Rate }> = [];
  AGENT_RULES.forEach(([name], i) => {
    rows.push({ label: `agent rule — ${name}`, rate: wilsonRate(items.filter((l) => l.agentPicks[i] === l.target).length, items.length) });
  });
  const withModel = items.filter((l) => l.variantMatch !== null);
  TRUST_VARIANTS.forEach(([name], i) => {
    rows.push({ label: `model form — ${name}`, rate: wilsonRate(withModel.filter((l) => l.variantMatch?.[i]).length, withModel.length) });
  });
  const iDef = AGENT_RULES.findIndex(([name]) => name === 'goodLakeTargetMostSuspicious');
  const iNew = AGENT_RULES.findIndex(([name]) => name === 'goodLakeInfoMax');
  let onlyDefault = 0;
  let onlyNew = 0;
  for (const l of items) {
    const d = l.agentPicks[iDef] === l.target;
    const m = l.agentPicks[iNew] === l.target;
    if (d && !m) onlyDefault++;
    if (m && !d) onlyNew++;
  }
  const mismatch = withModel.filter((l) => l.variantMismatch).length;
  return {
    title: `${title} (n=${items.length})`,
    rows,
    note: `paired, same lakes: only goodLakeTargetMostSuspicious right ${onlyDefault}, only goodLakeInfoMax right ${onlyNew}, `
      + `exact McNemar p = ${fmtP(mcnemarExact(onlyDefault, onlyNew))}; final-form variant ≠ model pick: ${mismatch}`,
  };
}

function scoreLabel(l: GoodLake): string {
  return `blue ${l.goodWins} : red ${l.evilWins}`;
}

const LAKE_LABEL = ['1st lake (after R2)', '2nd lake (after R3)', '3rd lake (after R4, last)'];

export function analyse(all: readonly GoodLake[]): Section[] {
  const sections: Section[] = [profile('all good-held lakes', all), picksProfile('who is laked: human vs agent rules', all)];
  const scores = [...new Set(all.map(scoreLabel))].sort();
  for (const s of scores) sections.push(profile(`score ${s}`, all.filter((l) => scoreLabel(l) === s)));
  for (const s of scores) sections.push(picksProfile(`who is laked, score ${s}`, all.filter((l) => scoreLabel(l) === s)));
  sections.push(agreementSection('same target as the human: agent rules and model forms', all));
  for (const s of scores) sections.push(agreementSection(`same target as the human, score ${s}`, all.filter((l) => scoreLabel(l) === s)));
  for (const i of [0, 1, 2]) sections.push(profile(LAKE_LABEL[i], all.filter((l) => l.lakeIdx === i)));
  for (const r of ['merlin', 'percival', 'loyal']) sections.push(profile(`holder ${r}`, all.filter((l) => l.role === r)));
  return sections;
}

function printSections(label: string, sections: readonly Section[]): void {
  console.log(`\n================ ${label} ================`);
  for (const s of sections) {
    console.log(`\n${s.title}`);
    for (const r of s.rows) console.log(`  ${r.label.padEnd(64)} ${fmt(r.rate)}`);
    if (s.note) console.log(`  (${s.note})`);
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const data = JSON.parse(fs.readFileSync(args.cache, 'utf8')) as Record<string, string[][]>;
  const rows = rowsFromSheet(data['牌譜'] ?? []);
  const games: ReplayGame[] = [];
  for (const row of rows) {
    if (!(row['文字記錄'] ?? '').trim()) continue;
    const res = parseReplayGame(row);
    if (res.ok) games.push(res.game);
  }
  const lakes = collect(games);
  const top = computeTopPerformers(games);
  console.log(`replayable 10p games: ${games.length}; with a valid lake chain: ${games.filter((g) => g.lakeChainValid).length}`);
  console.log(`good-held lakes: ${lakes.length}`);

  const cohorts: Array<[string, GoodLake[]]> = [
    ['population', lakes],
    ['top/role', lakes.filter((l) => top.members.has(cohortKey(l.name, l.role)))],
  ];
  for (const p of args.players) cohorts.push([p, lakes.filter((l) => l.name === p)]);
  const result: Record<string, Section[]> = {};
  for (const [label, items] of cohorts) {
    const sections = analyse(items);
    result[label] = sections;
    printSections(`${label} (good-held lakes n=${items.length})`, sections);
  }
  if (args.json) {
    fs.writeFileSync(path.resolve(args.json), JSON.stringify({
      generatedBy: 'packages/server/scripts/goodLakeStudy.ts',
      games: games.length,
      goodLakes: lakes.length,
      cohorts: result,
    }, null, 2));
    console.log(`wrote ${path.resolve(args.json)}`);
  }
}

main();
