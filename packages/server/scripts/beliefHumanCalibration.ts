/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 信念校準（第 26 回合，Edward 2026-11-04：讀人的模型改了就要量「在真人局讀得準不準」）。
 *
 *   cd packages/server && nice npx tsx scripts/beliefHumanCalibration.ts [--selfplay sp.json] [--variant 名稱=開關,開關 ...] [--json out.json]
 *   cd packages/server && npx tsx scripts/beliefHumanCalibration.ts --merge a.json b.json
 *
 * 資料：`games_cache.json`（`datasetReplay` 嚴格重播；`--selfplay` 改讀 `strongSelfPlay.ts` 的自我對打局）。每局一個忠臣座位（局 id 雜湊挑；
 * `--all-loyal` = 每個忠臣座位），每一次非強制、票型可信的提議的投票點，只給那個座位當時知道的東西（`buildReplayObservation`）。
 * 變體（每個都是一組 `BayesOptions`）：
 *   - `決策`（現行預設 `bayesOptionsOf(DEFAULT_AGENT_TUNING)`，投票門檻、派隊用的）、`金字塔`（推理畫面上「每人紅的機率」用的：
 *     `bayesOptionsOf(beliefOptionsFrom(預設))`；`beliefUnified` 打開時和決策相同）、`均分`（L1* 世界均分，不讀動作）；
 *   - `--variant 名稱=a=1,b`：預設再套這些開關之後的決策後驗。
 * 指標（每個變體）：
 *   - P(W*) = 後驗放在真紅組上的機率（= P(真藍的其他人都不是紅)），平均與 log2 平均；
 *   - 真紅／真藍的平均紅機率（P(true reds)：真紅 − 真藍 = 分離度）、前 4 名剛好是真紅（top4）、每人紅機率的 Brier；
 *   - 尾家（第 1–4 次提議時，強制局的隊長）是紅的機率：Brier、log2 損失、分箱校準（`strong_metrics.md` 第 4 節）。
 * 分回合（R1…R5）另外列 P(W*) 與 log2 P(W*)。
 */
import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_AGENT_TUNING, parseTuningFlag, type AgentTuning } from '../src/ai/AgentTuning';
import { bayesOptionsOf, bayesRedShare, bayesTeamClean, type BayesOptions } from '../src/ai/belief/BayesBelief';
import { beliefOptionsFrom } from '../src/ai/belief/BeliefOptions';
import { buildCertainty } from '../src/ai/belief/Certainty';
import { buildReplayObservation, seatId } from '../src/ai/benchmark/replayObservation';
import { campOf, type ReplayGame } from '../src/ai/benchmark/sheetsReplay';
import { replayGamesFromDataset, type DatasetHeader, type DatasetTuple } from '../src/ai/benchmark/datasetReplay';
import type { PlayerObservation } from '../src/ai/types';

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const has = (name: string): boolean => argv.includes(name);

function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

/** 累加器：key → [總和, 次數]。 */
type Store = Record<string, [number, number]>;
const add = (st: Store, key: string, v: number): void => { const c = (st[key] ??= [0, 0]); c[0] += v; c[1] += 1; };
const mean = (st: Store, key: string): number => { const c = st[key]; return c && c[1] > 0 ? c[0] / c[1] : NaN; };

interface Variant { name: string; opts: BayesOptions | 'uniform' }

function variantsFrom(): Variant[] {
  const base: AgentTuning = { ...DEFAULT_AGENT_TUNING };
  const out: Variant[] = [
    { name: '決策', opts: bayesOptionsOf(base) },
    { name: '金字塔', opts: bayesOptionsOf(beliefOptionsFrom(base).bayesTuning ?? beliefOptionsFrom(base)) },
    { name: '均分', opts: 'uniform' },
  ];
  argv.forEach((a, i) => {
    if (a !== '--variant') return;
    const spec = argv[i + 1];
    const eq = spec.indexOf('=');
    const name = spec.slice(0, eq);
    const t: AgentTuning = { ...base };
    for (const f of spec.slice(eq + 1).split(',').filter(Boolean)) Object.assign(t, parseTuningFlag(f));
    out.push({ name, opts: bayesOptionsOf(t) });
  });
  return out;
}

function uniformShares(obs: PlayerObservation): { share: Map<string, number>; clean: (team: readonly string[]) => number } {
  const view = buildCertainty(obs);
  const worlds = view.worlds('L1*');
  const share = new Map<string, number>();
  for (const id of obs.allPlayerIds) share.set(id, worlds.length ? view.uniformRedShare(id) : 0.5);
  return { share, clean: (team) => { if (!worlds.length) return 0; const m = view.maskOf(team); return worlds.filter((w) => (w & m) === 0).length / worlds.length; } };
}

const TAIL_BINS = 10;

function evalGame(game: ReplayGame, variants: readonly Variant[], st: Store, allLoyal: boolean): void {
  const loyalSeats = game.seatRoles.map((r, k) => (r === 'loyal' ? k + 1 : 0)).filter((s) => s > 0);
  if (loyalSeats.length === 0) return;
  const seats = allLoyal ? loyalSeats : [loyalSeats[fnv(game.id) % loyalSeats.length]];
  const red = (seat: number): boolean => campOf(game.seatRoles[seat - 1]) === 'evil';
  for (const seat of seats) {
    const me = seatId(seat);
    const blues = game.seatRoles.map((_, k) => k + 1).filter((s) => s !== seat && !red(s)).map(seatId);
    const reds = new Set(game.seatRoles.map((_, k) => k + 1).filter(red).map(seatId));
    game.proposals.forEach((p, i) => {
      if (p.forced || !p.votesReliable) return;
      const obs = buildReplayObservation(game, seat, { kind: 'team_vote', proposal: i });
      if (obs.myRole !== 'loyal') return;
      const ids = obs.allPlayerIds;
      const lead = ids.indexOf(obs.currentLeader ?? '');
      const tail = lead >= 0 && (obs.failCount ?? 0) < 4 ? ids[(lead + 4 - (obs.failCount ?? 0)) % ids.length] : null;
      for (const v of variants) {
        let share: Map<string, number>;
        let pw: number;
        if (v.opts === 'uniform') {
          const u = uniformShares(obs);
          share = u.share;
          pw = u.clean(blues);
        } else {
          share = bayesRedShare(obs, v.opts);
          pw = bayesTeamClean(obs, blues, v.opts) ?? 0;
        }
        const lg = Math.log2(Math.max(pw, 1e-9));
        for (const scope of ['全部', `R${p.round}`]) {
          add(st, `${v.name}|${scope}|pw`, pw);
          add(st, `${v.name}|${scope}|lg`, lg);
        }
        let sr = 0; let sb = 0; let brier = 0;
        const others = ids.filter((id) => id !== me);
        for (const id of others) {
          const x = share.get(id) ?? 0.5;
          const y = reds.has(id) ? 1 : 0;
          brier += (x - y) ** 2;
          if (y) sr += x; else sb += x;
        }
        add(st, `${v.name}|全部|red`, sr / Math.max(1, reds.size));
        add(st, `${v.name}|全部|blue`, sb / Math.max(1, others.length - reds.size));
        add(st, `${v.name}|全部|brier`, brier / others.length);
        const top = [...others].sort((a, b) => (share.get(b) ?? 0) - (share.get(a) ?? 0)).slice(0, reds.size);
        add(st, `${v.name}|全部|top4`, top.every((id) => reds.has(id)) ? 1 : 0);
        add(st, `${v.name}|R${p.round}|top4`, top.every((id) => reds.has(id)) ? 1 : 0);
        if (tail && tail !== me) {
          const x = Math.min(Math.max(share.get(tail) ?? 0.5, 1e-6), 1 - 1e-6);
          const y = reds.has(tail) ? 1 : 0;
          add(st, `${v.name}|tail|brier`, (x - y) ** 2);
          add(st, `${v.name}|tail|lg`, -(y ? Math.log2(x) : Math.log2(1 - x)));
          add(st, `${v.name}|tail|base`, y);
          const b = Math.min(TAIL_BINS - 1, Math.floor(x * TAIL_BINS));
          add(st, `${v.name}|tailbin${b}|p`, x);
          add(st, `${v.name}|tailbin${b}|y`, y);
        }
      }
    });
  }
}

const fmt = (x: number, d = 1): string => (Number.isFinite(x) ? (100 * x).toFixed(d) : '—');

function report(st: Store, names: readonly string[], meta: Record<string, unknown>): void {
  console.log(`\n# 信念校準（${String(meta.source)}；${String(meta.points ?? '')}）`);
  console.log('| 變體 | P(W*) R1 / R2 / R3 / R4 / R5 / 全部 | log2 P(W*) 全部（R3 / R4 / R5） | 真紅 / 真藍 平均紅機率（分離） | top4（R5） | Brier（每人） | 尾家 Brier / log2 損失（常數 Brier） |');
  console.log('|---|---|---|---|---|---|---|');
  for (const v of names) {
    const pw = ['R1', 'R2', 'R3', 'R4', 'R5', '全部'].map((s) => fmt(mean(st, `${v}|${s}|pw`))).join(' / ');
    const lg = `${mean(st, `${v}|全部|lg`).toFixed(2)}（${['R3', 'R4', 'R5'].map((s) => mean(st, `${v}|${s}|lg`).toFixed(2)).join(' / ')}）`;
    const r = mean(st, `${v}|全部|red`); const b = mean(st, `${v}|全部|blue`);
    const base = mean(st, `${v}|tail|base`);
    console.log(`| ${v} | ${pw}% | ${lg} | ${fmt(r)} / ${fmt(b)}%（${(r - b).toFixed(3)}） | ${fmt(mean(st, `${v}|全部|top4`))}%（${fmt(mean(st, `${v}|R5|top4`))}%） | ${mean(st, `${v}|全部|brier`).toFixed(4)} | ${mean(st, `${v}|tail|brier`).toFixed(4)} / ${mean(st, `${v}|tail|lg`).toFixed(3)}（${(base * (1 - base)).toFixed(4)}） |`);
  }
  console.log('\n尾家校準（P 格：平均 P → 真的是紅，n）');
  for (const v of names) {
    const cells: string[] = [];
    for (let k = 0; k < TAIL_BINS; k++) {
      const c = st[`${v}|tailbin${k}|p`];
      if (!c || c[1] === 0) continue;
      cells.push(`${(k / TAIL_BINS).toFixed(1)}: ${fmt(mean(st, `${v}|tailbin${k}|p`), 0)}→${fmt(mean(st, `${v}|tailbin${k}|y`), 0)}%（${c[1]}）`);
    }
    console.log(`- ${v}：${cells.join('、')}`);
  }
}

function loadHuman(limit?: number): ReplayGame[] {
  const root = path.resolve(__dirname, '..');
  const dataset = JSON.parse(fs.readFileSync(arg('--dataset') ?? path.join(root, 'games_cache.json'), 'utf8')) as DatasetHeader & { games: readonly DatasetTuple[] };
  const games = replayGamesFromDataset(dataset).games.map((g) => g.game).filter((g) => g.playerCount === 10);
  return limit !== undefined ? games.slice(0, limit) : games;
}

function main(): void {
  const mergeAt = argv.indexOf('--merge');
  if (mergeAt >= 0) {
    const st: Store = {};
    let meta: Record<string, unknown> = {};
    let names: string[] = [];
    for (const f of argv.slice(mergeAt + 1).filter((x) => !x.startsWith('--'))) {
      const j = JSON.parse(fs.readFileSync(f, 'utf8')) as { st: Store; names: string[]; meta: Record<string, unknown> };
      for (const [k, [s, n]] of Object.entries(j.st)) { const c = (st[k] ??= [0, 0]); c[0] += s; c[1] += n; }
      meta = j.meta; names = j.names;
    }
    report(st, names, meta);
    return;
  }
  const variants = variantsFrom();
  const sp = arg('--selfplay');
  const limit = arg('--limit') !== undefined ? Number(arg('--limit')) : undefined;
  const games: ReplayGame[] = sp ? (JSON.parse(fs.readFileSync(sp, 'utf8')) as { games: ReplayGame[] }).games.slice(0, limit) : loadHuman(limit);
  const [k, n] = (arg('--shard') ?? '0/1').split('/').map(Number);
  const st: Store = {};
  const started = Date.now();
  let done = 0;
  games.forEach((g, gi) => {
    if (gi % n !== k) return;
    evalGame(g, variants, st, has('--all-loyal'));
    done++;
    if (done % 200 === 0) process.stderr.write(`[calib] ${done} games, ${((Date.now() - started) / 1000).toFixed(0)}s\n`);
  });
  const meta = { source: sp ? `自我對打 ${path.basename(sp)}` : 'games_cache.json 真人局', games: done, points: `${st['決策|全部|pw']?.[1] ?? 0} 個決策點`, seconds: Math.round((Date.now() - started) / 1000) };
  report(st, variants.map((v) => v.name), meta);
  const out = arg('--json');
  if (out) fs.writeFileSync(out, JSON.stringify({ st, names: variants.map((v) => v.name), meta }));
}

main();
