/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 第 56b 回合 C（站長 2026-11-20「真人桌另一套」）：真人桌的讀法用真人局的準確度判——分角色、分對手強度。
 *
 *   cd packages/server && npx tsx scripts/humanProfileStudy.ts [--shard k/n] [--raw out.json] [--variant 名稱:開關=值,開關=值 ...]
 *   cd packages/server && npx tsx scripts/humanProfileStudy.ts --merge s0.json s1.json ... [--json out.json] [--md out.md]
 *
 * 資料與決策點同 `beliefCalibrationCurve.ts`（games_cache.json 真人局、datasetReplay 嚴格重播、10 人局；每個藍方座位在每一次非強制提議的投票點，
 * 對另外 9 人說的紅機率 p = `bayesRedShare`）。差別：(1) 一次量好幾個變體（同一批點）；(2) 桌分成網站「陣容強度」的三層——
 * 弱（S < 38）、一般（38 ≤ S < 55）、強（S ≥ 55，= 高端桌），S 不知道的局另外一格，和 `humanProfile.ts` 挑真人桌讀法用的切點同一組
 * （`DEFAULT_COHORT_CUTS` 的 sLo／sHi）。
 * 預設變體：`ai`（現行預設）、`CD75`（copyDiscount55=0.75）、`CD100`（=1）、`REP`（copyRepeat55b=1）、`FR`（copyRepeat55b=1＋copyFreq55b=1）。
 *
 * 第 57 回合（分強度層的真人桌讀法）加上：
 * - `--split train|test|all`：train = 偶數號的局（擬合用）、test = 奇數號的局（驗證用；同 `beliefCalibrationCurve.ts` 第 48 回合的切法）。`--limit N` 只用前 N 局。
 * - 每個（變體 × 角色 × 強度層）的 ΔBrier 對第一個變體的**以局為單位的標準誤**（同一局的點彼此相關，所以用局當集群：
 *   Δ = Σ_g d_g ／ Σ_g n_g，Var ≈ G／(G−1) · Σ_g (d_g − Δ n_g)² ／ (Σ n_g)²），表格多一節「ΔBrier ± 標準誤」，`--json` 也有。
 * 第 64 回合：`--tier strong`（或 weak／avg／unknown）只算這一層的局（強真人桌的候選省時間；切分照舊用全部局的序號）。
 * 第 74 回合：`--roles percival`（逗號分隔）只算這些角色的座位（只改一個角色讀法的候選省時間；不給＝忠臣、派西、梅林都算）。
 */
import * as fs from 'fs';
import { DEFAULT_AGENT_TUNING, parseTuningFlag, type AgentTuning } from '../src/ai/AgentTuning';
import { bayesOptionsOf, bayesRedShare, type BayesOptions } from '../src/ai/belief/BayesBelief';
import { buildReplayObservation, seatId } from '../src/ai/benchmark/replayObservation';
import { campOf, type ReplayGame } from '../src/ai/benchmark/sheetsReplay';
import { addPoint, mergeAcc, newAcc, summarize, type CalAcc } from '../src/ai/benchmark/calibration';
import { hideLobbyOrder } from '../src/bots/simulation/aiRead';
import { strengthTierOfS, type StrengthTier } from '../src/ai/humanProfile';
import { loadHuman } from './beliefCalibrationCurve';

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const CERTAIN = 1e-9;
const ONLY_ROLES = arg('--roles')?.split(',').map((x) => x.trim()).filter(Boolean);
const ROLES = ['loyal', 'percival', 'merlin'] as const;
const ROLE_LABEL: Record<string, string> = { loyal: '忠臣', percival: '派西', merlin: '梅林' };
const TIERS: readonly (StrengthTier | 'unknown')[] = ['weak', 'avg', 'strong', 'unknown'];
const TIER_LABEL: Record<string, string> = { weak: '弱（S<38）', avg: '一般（38–55）', strong: '強（S≥55）', unknown: 'S 不明' };

interface Variant { name: string; flags: string[]; opts: BayesOptions }

function variants(): Variant[] {
  const specs = argv.flatMap((a, i) => (a === '--variant' ? [argv[i + 1]] : []));
  const list = specs.length ? specs : ['ai:', 'CD75:copyDiscount55=0.75', 'CD100:copyDiscount55=1', 'REP:copyRepeat55b=1', 'FR:copyRepeat55b=1,copyFreq55b=1'];
  return list.map((spec) => {
    const [name, rest = ''] = spec.split(':');
    const flags = rest.split(',').filter(Boolean);
    const t: AgentTuning = { ...DEFAULT_AGENT_TUNING };
    for (const f of flags) Object.assign(t, parseTuningFlag(f));
    return { name, flags, opts: bayesOptionsOf(t) };
  });
}

/** 以局為集群的配對差：Σd、Σn、Σd²、Σd·n、Σn²、局數（d = 這一局這一格 變體 − 第一個變體 的 Brier 加總，n = 點數）。 */
interface PairAcc { sd: number; sn: number; sdd: number; sdn: number; snn: number; g: number }
const newPair = (): PairAcc => ({ sd: 0, sn: 0, sdd: 0, sdn: 0, snn: 0, g: 0 });
function addPair(a: PairAcc, d: number, n: number): void { a.sd += d; a.sn += n; a.sdd += d * d; a.sdn += d * n; a.snn += n * n; a.g += 1; }
function mergePair(...as: readonly PairAcc[]): PairAcc {
  const o = newPair();
  for (const a of as) { o.sd += a.sd; o.sn += a.sn; o.sdd += a.sdd; o.sdn += a.sdn; o.snn += a.snn; o.g += a.g; }
  return o;
}
/** Δ（點的平均差）與以局為集群的標準誤。 */
export function pairDelta(a: PairAcc): { delta: number; se: number; games: number } {
  if (!(a.sn > 0)) return { delta: 0, se: 0, games: 0 };
  const delta = a.sd / a.sn;
  const ss = a.sdd - 2 * delta * a.sdn + delta * delta * a.snn;
  const se = a.g > 1 ? Math.sqrt(Math.max(0, ss) * (a.g / (a.g - 1))) / a.sn : 0;
  return { delta, se, games: a.g };
}

/** key = 變體|視角|強度層|R回合|u(不確定)/c(確定)；pair 的 key = 變體|視角|強度層。 */
interface Store { acc: Record<string, CalAcc>; pair?: Record<string, PairAcc>; games: number; points: number; variants: { name: string; flags: string[] }[] }

function evalGame(game: ReplayGame, tier: string, vs: readonly Variant[], st: Store): void {
  const red = (seat: number): boolean => campOf(game.seatRoles[seat - 1]) === 'evil';
  const pair = (st.pair ??= {});
  // 這一局：角色 → 每個變體的 Brier 加總、點數
  const gameSum = new Map<string, { b: number[]; n: number }>();
  for (let seat = 1; seat <= game.playerCount; seat++) {
    const role = game.seatRoles[seat - 1];
    if (!(ROLES as readonly string[]).includes(role)) continue;
    if (ONLY_ROLES && !ONLY_ROLES.includes(role)) continue;
    const me = seatId(seat);
    game.proposals.forEach((p, i) => {
      if (p.forced) return;
      const obs = hideLobbyOrder(buildReplayObservation(game, seat, { kind: 'team_vote', proposal: i }));
      st.points++;
      const gs = gameSum.get(role) ?? { b: vs.map(() => 0), n: 0 };
      gameSum.set(role, gs);
      vs.forEach((v, vi) => {
        const sh = bayesRedShare(obs, v.opts);
        for (let t = 1; t <= game.playerCount; t++) {
          const id = seatId(t);
          if (id === me) continue;
          const x = sh.get(id) ?? 0.5;
          const y = red(t) ? 1 : 0;
          const certain = x <= CERTAIN || x >= 1 - CERTAIN;
          addPoint((st.acc[`${v.name}|${role}|${tier}|R${p.round}|${certain ? 'c' : 'u'}`] ??= newAcc()), x, y);
          const q = Math.min(1, Math.max(0, x));
          gs.b[vi] += (q - y) * (q - y);
          if (vi === 0) gs.n += 1;
        }
      });
    });
  }
  for (const [role, gs] of gameSum) {
    for (let vi = 1; vi < vs.length; vi++) addPair((pair[`${vs[vi].name}|${role}|${tier}`] ??= newPair()), gs.b[vi] - gs.b[0], gs.n);
  }
  // 全部角色合在一起的那一格（同一局的三個角色合成一個集群）
  for (let vi = 1; vi < vs.length; vi++) {
    let d = 0;
    let n = 0;
    for (const gs of gameSum.values()) { d += gs.b[vi] - gs.b[0]; n += gs.n; }
    if (n > 0) addPair((pair[`${vs[vi].name}|all|${tier}`] ??= newPair()), d, n);
  }
  st.games++;
}

const pick = (st: Store, pred: (v: string, role: string, tier: string, r: string, c: string) => boolean): CalAcc =>
  mergeAcc(...Object.entries(st.acc).filter(([k]) => { const [v, w, t, r, c] = k.split('|'); return pred(v, w, t, r, c); }).map(([, a]) => a));

function report(st: Store): { md: string; json: Record<string, unknown> } {
  const names = st.variants.map((v) => v.name);
  const L: string[] = ['# 真人桌讀法：真人局的準確度（分角色 × 對手強度）', ''];
  L.push(`- ${st.games} 局、${st.points} 個（藍方座位 × 非強制投票點）；每格 = 全部點（含 p = 0／1 的確定點，對數損失把 p 夾在 [1e-6, 1 − 1e-6]）。`);
  L.push(`- 變體：${st.variants.map((v) => `${v.name}（${v.flags.join(' ') || '現行預設'}）`).join('、')}。差 = 變體 − ai（Brier、對數損失越小越好；ECE 越小越好）。`, '');
  const json: Record<string, unknown> = {};
  const scopes: { label: string; role?: string; tier?: string }[] = [{ label: '全部' }];
  for (const r of ROLES) scopes.push({ label: ROLE_LABEL[r], role: r });
  for (const t of TIERS) scopes.push({ label: TIER_LABEL[t], tier: t });
  for (const r of ROLES) for (const t of TIERS.slice(0, 3)) scopes.push({ label: `${ROLE_LABEL[r]}・${TIER_LABEL[t]}`, role: r, tier: t });
  L.push(`| 範圍 | 點數 | ai Brier／對數損失／ECE pp | ${names.slice(1).map((n) => `${n} ΔBrier／Δ對數損失／ECE`).join(' | ')} |`);
  L.push(`|---|---|---|${names.slice(1).map(() => '---').join('|')}|`);
  for (const sc of scopes) {
    const sums = names.map((v) => summarize(pick(st, (vv, w, t) => vv === v && (!sc.role || w === sc.role) && (!sc.tier || t === sc.tier))));
    const base = sums[0];
    if (!base.n) continue;
    json[sc.label] = Object.fromEntries(names.map((v, i) => [v, { n: sums[i].n, brier: sums[i].brier, logLoss: sums[i].logLoss, ece: sums[i].ece, platt: sums[i].platt?.b ?? null }]));
    const cell = (i: number): string => `${(1e4 * (sums[i].brier - base.brier)).toFixed(1)}e-4／${(1e3 * (sums[i].logLoss - base.logLoss)).toFixed(1)}e-3／${(100 * sums[i].ece).toFixed(2)}`;
    L.push(`| ${sc.label} | ${base.n} | ${base.brier.toFixed(4)}／${base.logLoss.toFixed(4)}／${(100 * base.ece).toFixed(2)} | ${names.slice(1).map((_, j) => cell(j + 1)).join(' | ')} |`);
  }
  if (st.pair && Object.keys(st.pair).length) {
    const pairOf = (v: string, role: string, tier?: string): PairAcc =>
      mergePair(...Object.entries(st.pair ?? {}).filter(([k]) => { const [vv, w, t] = k.split('|'); return vv === v && w === role && (!tier || t === tier); }).map(([, a]) => a));
    L.push('', '## ΔBrier（×1e-4）± 以局為集群的標準誤（對第一個變體）', '');
    L.push(`| 範圍 | 局數 | ${names.slice(1).join(' | ')} |`);
    L.push(`|---|---|${names.slice(1).map(() => '---').join('|')}|`);
    const pj: Record<string, unknown> = {};
    const roleScopes: { label: string; role: string; tier?: string }[] = [{ label: '全部', role: 'all' }];
    for (const r of ROLES) roleScopes.push({ label: ROLE_LABEL[r], role: r });
    for (const t of TIERS) {
      roleScopes.push({ label: TIER_LABEL[t], role: 'all', tier: t });
      for (const r of ROLES) roleScopes.push({ label: `${ROLE_LABEL[r]}・${TIER_LABEL[t]}`, role: r, tier: t });
    }
    for (const sc of roleScopes) {
      const ds = names.slice(1).map((v) => pairDelta(pairOf(v, sc.role, sc.tier)));
      if (!ds.length || !ds[0].games) continue;
      pj[sc.label] = Object.fromEntries(names.slice(1).map((v, i) => [v, ds[i]]));
      L.push(`| ${sc.label} | ${ds[0].games} | ${ds.map((d) => `${(1e4 * d.delta).toFixed(1)} ± ${(1e4 * d.se).toFixed(1)}`).join(' | ')} |`);
    }
    json.pairedBrier = pj;
  }
  return { md: L.join('\n'), json };
}

function main(): void {
  const st: Store = { acc: {}, games: 0, points: 0, variants: [] };
  const mergeAt = argv.indexOf('--merge');
  if (mergeAt >= 0) {
    for (const f of argv.slice(mergeAt + 1).filter((x) => !x.startsWith('--') && x.endsWith('.json') && x !== arg('--json'))) {
      const j = JSON.parse(fs.readFileSync(f, 'utf8')) as Store;
      for (const [k, a] of Object.entries(j.acc)) st.acc[k] = st.acc[k] ? mergeAcc(st.acc[k], a) : a;
      for (const [k, a] of Object.entries(j.pair ?? {})) (st.pair ??= {})[k] = st.pair[k] ? mergePair(st.pair[k], a) : a;
      st.games += j.games;
      st.points += j.points;
      st.variants = j.variants;
    }
  } else {
    const vs = variants();
    st.variants = vs.map((v) => ({ name: v.name, flags: v.flags }));
    const [k, n] = (arg('--shard') ?? '0/1').split('/').map(Number);
    const limit = arg('--limit') !== undefined ? Number(arg('--limit')) : undefined;
    const games = loadHuman().slice(0, limit);
    // 第 57 回合：train = 偶數號的局（擬合）、test = 奇數號的局（驗證）
    const split = arg('--split') ?? 'all';
    const onlyTier = arg('--tier');
    const keep = (gi: number): boolean => (split === 'train' ? gi % 2 === 0 : split === 'test' ? gi % 2 === 1 : true);
    const started = Date.now();
    let kept = -1;
    games.forEach((g, gi) => {
      if (!keep(gi)) return;
      kept += 1;
      if (kept % n !== k) return;
      const tier = g.s === null ? 'unknown' : strengthTierOfS(g.s);
      if (onlyTier && tier !== onlyTier) return;
      evalGame(g.game, tier, vs, st);
      if (st.games % 100 === 0) process.stderr.write(`[profile ${k}/${n}] ${st.games} games, ${((Date.now() - started) / 1000).toFixed(0)}s\n`);
    });
    const raw = arg('--raw');
    if (raw) fs.writeFileSync(raw, JSON.stringify(st));
  }
  const { md, json } = report(st);
  console.log(md);
  const out = arg('--json');
  if (out) fs.writeFileSync(out, JSON.stringify(json, null, 1));
  const mdOut = arg('--md');
  if (mdOut) fs.writeFileSync(mdOut, md);
}

if (require.main === module) main();
