/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 第 48 回合：分回合的信念再校準（`beliefRecalib`）與桌上慣例的顫抖（`beliefConventionTremble`）的擬合工具
 * （docs/ai/methods_backlog.md 第 1、2 項；量具同 `beliefCalibrationCurve.ts`）。
 *
 *   cd packages/server && npx tsx scripts/beliefRecalibFit.ts --split train [--shard k/n] [--raw out.json] [--flag 開關=值 ...]
 *   cd packages/server && npx tsx scripts/beliefRecalibFit.ts --merge s0.json s1.json ...
 *
 * 資料與決策點和 `bot:calibration` 相同（`games_cache.json` 真人 10 人局、藍方座位、每一次非強制提議的投票點、對另外 9 人的紅機率）。
 * `--split train` = 偶數序號的局（擬合用），`--split test` = 奇數序號的局（驗證用），`--split all` = 全部。
 * 基準 = 預設（`--flag` 給了就是預設 + 開關）。每個點同時算三族候選，分回合累加（全部點，含 p = 0／1 的確定點；對數損失把 p 夾在 [1e-6, 1 − 1e-6]）：
 *   - `pow b`：基準後驗的世界權重取 b 次方（`recalibPower`，第 1 種）——直接從基準的世界權重算，不重新算後驗；
 *   - `tem m`：投票、派隊概似的次方再乘 m（`recalibTemper`，第 2 種）；
 *   - `eps ε`：慣例改成軟的（`conventionTremble`）。
 * 回合 r 的點只受回合 r 的係數影響（係數照觀察者當下的回合），所以每個回合各自取最好的值就是分回合的擬合。
 */
import * as fs from 'fs';
import { DEFAULT_AGENT_TUNING, parseTuningFlag, type AgentTuning } from '../src/ai/AgentTuning';
import { bayesOptionsOf, bayesRedShare, bayesWorlds, type BayesOptions } from '../src/ai/belief/BayesBelief';
import { buildReplayObservation, seatId } from '../src/ai/benchmark/replayObservation';
import { campOf, type ReplayGame } from '../src/ai/benchmark/sheetsReplay';
import { addPoint, mergeAcc, newAcc, summarize, type CalAcc } from '../src/ai/benchmark/calibration';
import { hideLobbyOrder } from '../src/bots/simulation/aiRead';
import { loadHuman } from './beliefCalibrationCurve';

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const listArg = (name: string, dflt: number[]): number[] => (arg(name) ? arg(name)!.split(',').map(Number) : dflt);

export const POWERS = [0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1, 1.1];
export const TEMPERS = [0.3, 0.45, 0.6, 0.75, 0.9];
export const EPSILONS = [0.003, 0.01, 0.03, 0.1];

/** key = 候選|R回合|視角 → 累加器。 */
export interface FitStore { acc: Record<string, CalAcc>; games: number; points: number }

export function splitKeep(split: string, gi: number): boolean {
  if (split === 'train') return gi % 2 === 0;
  if (split === 'test') return gi % 2 === 1;
  return true;
}

export function evalGameFit(game: ReplayGame, base: BayesOptions, powers: readonly number[], tempers: readonly number[], eps: readonly number[], st: FitStore): void {
  const red = (seat: number): boolean => campOf(game.seatRoles[seat - 1]) === 'evil';
  for (let seat = 1; seat <= game.playerCount; seat++) {
    const role = game.seatRoles[seat - 1];
    if (role !== 'loyal' && role !== 'percival' && role !== 'merlin') continue;
    const me = seatId(seat);
    game.proposals.forEach((p, i) => {
      if (p.forced) return;
      const obs = hideLobbyOrder(buildReplayObservation(game, seat, { kind: 'team_vote', proposal: i }));
      st.points++;
      const targets = Array.from({ length: game.playerCount }, (_, t) => t + 1).filter((t) => seatId(t) !== me);
      const add = (name: string, share: (id: string) => number): void => {
        for (const t of targets) addPoint((st.acc[`${name}|R${p.round}|${role}`] ??= newAcc()), share(seatId(t)), red(t) ? 1 : 0);
      };
      // pow b: the base posterior's world weights to the power b.
      const bw = bayesWorlds(obs, base);
      const lw = bw.wts.map((x) => (x > 0 ? Math.log(x) : Number.NEGATIVE_INFINITY));
      for (const b of powers) {
        const raw = lw.map((x) => (Number.isFinite(x) ? Math.exp(b * x) : 0));
        const tot = raw.reduce((s, x) => s + x, 0);
        add(`pow ${b}`, (id) => {
          if (!(tot > 0)) return 0.5;
          const bit = bw.bitOf(id);
          let s = 0;
          bw.worlds.forEach((w, k) => { if (w & bit) s += raw[k]; });
          return s / tot;
        });
      }
      for (const m of tempers) {
        const sh = bayesRedShare(obs, { ...base, recalibTemper: [m] });
        add(`tem ${m}`, (id) => sh.get(id) ?? 0.5);
      }
      for (const e of eps) {
        const sh = bayesRedShare(obs, { ...base, conventionTremble: e });
        add(`eps ${e}`, (id) => sh.get(id) ?? 0.5);
      }
    });
  }
  st.games++;
}

function report(st: FitStore): string {
  const L: string[] = [];
  const names = [...new Set(Object.keys(st.acc).map((k) => k.split('|')[0]))];
  const fam = (n: string): string => n.split(' ')[0];
  L.push(`# 第 48 回合擬合：${st.games} 局、${st.points} 個（座位 × 投票點）`, '');
  L.push('| 候選 | 回合 | 點數 | 對數損失 | Brier | ECE pp（全部點） | Platt 斜率（0<p<1） |', '|---|---|---|---|---|---|---|');
  const best: Record<string, Record<string, { name: string; ll: number }>> = {};
  for (const r of ['R1', 'R2', 'R3', 'R4', 'R5']) {
    for (const n of names) {
      const a = mergeAcc(...Object.entries(st.acc).filter(([k]) => { const [nn, rr] = k.split('|'); return nn === n && rr === r; }).map(([, x]) => x));
      const s = summarize(a);
      if (!s.n) continue;
      // Platt on the uncertain points only (the fine bins 1–98).
      const u = newAcc();
      for (let i = 1; i < 99; i++) for (const k of ['n', 'sp', 'sy', 'spp', 'spy', 'sll'] as const) u[k][i] = a[k][i];
      const su = summarize(u);
      L.push(`| ${n} | ${r} | ${s.n} | ${s.logLoss.toFixed(4)} | ${s.brier.toFixed(4)} | ${(100 * s.ece).toFixed(2)} | ${su.platt ? su.platt.b.toFixed(2) : '—'} |`);
      const f = fam(n);
      ((best[f] ??= {})[r] ??= { name: n, ll: Infinity });
      if (s.logLoss < best[f][r].ll) best[f][r] = { name: n, ll: s.logLoss };
    }
  }
  L.push('', '每族每回合對數損失最小的值：');
  for (const [f, byR] of Object.entries(best)) L.push(`- ${f}：${Object.entries(byR).map(([r, x]) => `${r} ${x.name.split(' ')[1]}（${x.ll.toFixed(4)}）`).join('、')}`);
  return L.join('\n');
}

function main(): void {
  const mergeAt = argv.indexOf('--merge');
  const st: FitStore = { acc: {}, games: 0, points: 0 };
  if (mergeAt >= 0) {
    for (const f of argv.slice(mergeAt + 1).filter((x) => !x.startsWith('--'))) {
      const j = JSON.parse(fs.readFileSync(f, 'utf8')) as FitStore;
      for (const [k, a] of Object.entries(j.acc)) st.acc[k] = st.acc[k] ? mergeAcc(st.acc[k], a) : a;
      st.games += j.games;
      st.points += j.points;
    }
  } else {
    const t: AgentTuning = { ...DEFAULT_AGENT_TUNING };
    argv.forEach((a, i) => { if (a === '--flag') Object.assign(t, parseTuningFlag(argv[i + 1])); });
    const base = bayesOptionsOf(t);
    const split = arg('--split') ?? 'train';
    const [k, n] = (arg('--shard') ?? '0/1').split('/').map(Number);
    const powers = listArg('--powers', POWERS);
    const tempers = listArg('--tempers', TEMPERS);
    const eps = listArg('--eps', EPSILONS);
    const games = loadHuman();
    let j = 0;
    const started = Date.now();
    games.forEach((g, gi) => {
      if (!splitKeep(split, gi)) return;
      if (j++ % n !== k) return;
      evalGameFit(g.game, base, powers, tempers, eps, st);
      if (st.games % 50 === 0) process.stderr.write(`[fit ${k}/${n}] ${st.games} games ${((Date.now() - started) / 1000).toFixed(0)}s\n`);
    });
    const raw = arg('--raw');
    if (raw) fs.writeFileSync(raw, JSON.stringify(st));
  }
  console.log(report(st));
}

if (require.main === module) main();
