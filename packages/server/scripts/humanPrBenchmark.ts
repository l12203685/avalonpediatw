/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 人類 PR 量尺 — 機器人相當於人類的 PR 多少（2026-11-03；docs/ai/optimization_loop.md「人類 PR 量尺」）。
 *
 *   cd packages/server && npx tsx scripts/humanPrBenchmark.ts [--workers 4] [--bot-cache PATH] [--json out.json]
 *
 * 選項：
 *   --dataset PATH     每局資料集（預設 ./games_cache.json，v3：每個座位開打前的時間相對 PR）
 *   --workers N        平行的子行程數（預設 min(4, CPU 數)）；1 = 不分
 *   --limit N          只用前 N 局可重播的局（測試用）
 *   --bot-cache PATH   機器人決策的快取：檔案存在且 tuning 相同就直接讀，否則重播後寫入
 *   --boot B           局的集群自助法次數（預設 300；0 = 不算區間）
 *   --shrink M         優勢表的收縮強度（預設 30 個樣本）
 *   --json PATH        完整結果寫成 JSON
 *   --flag NAME[=V]    AgentTuning 開關（可重複；同 agreementBenchmark）
 *   --legacy           從全關的舊表開始再套 --flag
 *
 * 做法（細節見 src/ai/benchmark/humanPr.ts）：資料集每一局（嚴格解析，`datasetReplay.ts`）每一個座位都換成機器人
 * 重播（`agreement.replayGame`，和 agreementBenchmark 相同的觀察重建：只看那個座位當時知道的事），記下機器人在
 * 每個決策點的選擇。人類資料估每個選擇的優勢（5 折交叉擬合、陣容強度殘差化、分層收縮），依人類座位 PR 分 10 組，
 * 每組比「人類自己的選擇」和「機器人在同一批決策點的選擇」，Δ = 0 的 PR 就是機器人的等效 PR。刺殺直接比刺中率。
 * 總 PR 用「一個座位一局所有決策的優勢加總」（刺殺的單位是勝率，刺中 = 紅方贏）。人類斜率（每 +10 PR）的 95% 區間含 0 的項目
 * 標「不可靠」。最後列幾個用真相打分數的對照（忠臣／派西投票對不對、派的隊乾淨、藍方湖驗到紅、刺中梅林）。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fork } from 'child_process';
import { HeuristicAgent } from '../src/ai/HeuristicAgent';
import {
  LEGACY_AGENT_TUNING,
  describeAgentTuning,
  parseTuningFlag,
  resolveAgentTuning,
  type AgentTuning,
} from '../src/ai/AgentTuning';
import { getForwardTelemetry } from '../src/ai/forward/ForwardAgent';
import { evilLakeHumanOptionsFromEnv, setEvilLakeHumanOptions } from '../src/ai/LakePolicy';
import { setVouchFollowUpOptions, vouchFollowUpOptionsFromEnv } from '../src/ai/RedLakeFollowUp';
import { goodVouchOptionsFromEnv, setGoodVouchOptions } from '../src/ai/GoodLakeFollowUp';
import { setTeamReuseOptions, teamReuseOptionsFromEnv } from '../src/ai/TeamReuse';
import { redR1TeammateOptionsFromEnv, setRedR1TeammateOptions } from '../src/ai/RedR1Teammate';
import { replayGamesFromDataset, type DatasetReplayGame } from '../src/ai/benchmark/datasetReplay';
import { pinnedQuestCard, replayGame } from '../src/ai/benchmark/agreement';
import { BENCHMARK_ROLES } from '../src/ai/benchmark/cohorts';
import { campOf } from '../src/ai/benchmark/sheetsReplay';
import {
  PR_BUCKETS,
  advantage,
  equivalentPr,
  fitAdvantageTable,
  fitLogistic,
  foldOf,
  humanSlopePer10,
  lakeClaimKeys,
  lakeTargetKeys,
  parseSeatList,
  prBucket,
  questKeys,
  teamKeys,
  voteKeys,
  type AdvantageSample,
  type AdvantageTable,
  type BucketDelta,
  type HumanPrDecision,
  type KeyedAction,
} from '../src/ai/benchmark/humanPr';

interface Args {
  dataset: string;
  workers: number;
  limit?: number;
  botCache?: string;
  boot: number;
  shrink: number;
  json?: string;
  flags: Partial<AgentTuning>;
  rawFlags: string[];
  legacy: boolean;
  shard?: [number, number];
  out?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    dataset: path.resolve(__dirname, '..', 'games_cache.json'),
    workers: Math.max(1, Math.min(4, os.cpus().length)),
    boot: 300,
    shrink: 30,
    flags: {},
    rawFlags: [],
    legacy: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case '--dataset': args.dataset = path.resolve(next()); break;
      case '--workers': args.workers = Math.max(1, Number.parseInt(next(), 10)); break;
      case '--limit': args.limit = Number.parseInt(next(), 10); break;
      case '--bot-cache': args.botCache = path.resolve(next()); break;
      case '--boot': args.boot = Number.parseInt(next(), 10); break;
      case '--shrink': args.shrink = Number.parseFloat(next()); break;
      case '--json': args.json = path.resolve(next()); break;
      case '--flag': {
        const v = next();
        args.rawFlags.push(v);
        Object.assign(args.flags, parseTuningFlag(v));
        break;
      }
      case '--legacy': args.legacy = true; break;
      case '--shard': {
        const [k, n] = next().split('/').map((x) => Number.parseInt(x, 10));
        args.shard = [k, n];
        break;
      }
      case '--out': args.out = next(); break;
      case '--help': case '-h':
        console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
        process.exit(0);
        break;
      default: throw new Error(`unknown argument ${a}`);
    }
  }
  return args;
}

const TYPES: readonly HumanPrDecision[] = ['team', 'vote', 'quest', 'lakeTarget', 'lakeClaim', 'assassinate'];

/** 機器人一個決策：[局序號, 座位, 種類, 索引（提議／局／湖）, 機器人的選擇]。 */
type BotRecord = [number, number, number, number, string];

function applyEnvOptions(): void {
  setEvilLakeHumanOptions(evilLakeHumanOptionsFromEnv());
  setVouchFollowUpOptions(vouchFollowUpOptionsFromEnv());
  setGoodVouchOptions(goodVouchOptionsFromEnv());
  setTeamReuseOptions(teamReuseOptionsFromEnv());
  setRedR1TeammateOptions(redR1TeammateOptionsFromEnv());
}

function loadGames(args: Args): { games: DatasetReplayGame[]; skipped: Record<string, number>; total: number } {
  const raw = JSON.parse(fs.readFileSync(args.dataset, 'utf8'));
  const { games, skipped } = replayGamesFromDataset(raw);
  return { games: args.limit !== undefined ? games.slice(0, args.limit) : games, skipped, total: raw.games.length };
}

/** 重播 games 裡 gi % n === k 的局，回傳機器人的決策。 */
function replayShard(games: readonly DatasetReplayGame[], tuning: AgentTuning, k: number, n: number): BotRecord[] {
  const out: BotRecord[] = [];
  for (let gi = k; gi < games.length; gi += n) {
    const g = games[gi].game;
    const seats = Array.from({ length: g.playerCount }, (_, i) => i + 1);
    const outcomes = replayGame(g, seats, { makeAgent: (id) => new HeuristicAgent(id, undefined, undefined, tuning) });
    for (const o of outcomes) {
      const t = TYPES.indexOf(o.type);
      let idx = 0;
      if (o.type === 'team' || o.type === 'vote') idx = g.proposals.findIndex((p) => p.round === o.round && p.attempt === o.attempt);
      else if (o.type === 'quest') idx = o.round;
      else if (o.type === 'lakeTarget' || o.type === 'lakeClaim') idx = g.lakes.findIndex((l) => l.round === o.round);
      out.push([gi, o.seat, t, idx, o.agent]);
    }
  }
  return out;
}

async function botDecisions(args: Args, games: readonly DatasetReplayGame[], tuning: AgentTuning): Promise<{ records: BotRecord[]; forward: number }> {
  const key = `${describeAgentTuning(tuning)}|${games.length}|${games.map((g) => g.game.id).join(',').length}`;
  if (args.botCache && fs.existsSync(args.botCache)) {
    const cached = JSON.parse(fs.readFileSync(args.botCache, 'utf8')) as { key: string; records: BotRecord[]; forward: number };
    if (cached.key === key) {
      console.error(`bot decisions: read ${cached.records.length} from ${args.botCache}`);
      return { records: cached.records, forward: cached.forward };
    }
    console.error('bot cache key differs (tuning or dataset changed) — replaying');
  }
  const started = Date.now();
  let records: BotRecord[] = [];
  let forward = 0;
  if (args.workers <= 1) {
    records = replayShard(games, tuning, 0, 1);
    forward = getForwardTelemetry().totalDecisions;
  } else {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'humanpr-'));
    const passthrough = [
      '--dataset', args.dataset,
      ...(args.limit !== undefined ? ['--limit', String(args.limit)] : []),
      ...args.rawFlags.flatMap((f) => ['--flag', f]),
      ...(args.legacy ? ['--legacy'] : []),
    ];
    const jobs = Array.from({ length: args.workers }, (_, k) => new Promise<void>((resolve, reject) => {
      const out = path.join(dir, `shard${k}.json`);
      const child = fork(process.argv[1], [...passthrough, '--shard', `${k}/${args.workers}`, '--out', out], {
        execArgv: process.execArgv,
        stdio: 'inherit',
      });
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`shard ${k} exited ${code}`))));
    }));
    await Promise.all(jobs);
    for (let k = 0; k < args.workers; k++) {
      const shard = JSON.parse(fs.readFileSync(path.join(dir, `shard${k}.json`), 'utf8')) as { records: BotRecord[]; forward: number };
      records = records.concat(shard.records);
      forward += shard.forward;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.error(`bot decisions: ${records.length} in ${((Date.now() - started) / 1000).toFixed(0)}s (${args.workers} workers)`);
  if (args.botCache) fs.writeFileSync(args.botCache, JSON.stringify({ key, records, forward }));
  return { records, forward };
}

// ── 評分 ─────────────────────────────────────────────────

interface Scored {
  gi: number;
  seat: number;
  type: HumanPrDecision;
  role: string;
  bucket: number | null;
  human: number;
  bot: number;
  agree: boolean;
}

/** 一個決策點的人類與機器人選擇 → 兩組鍵（刺殺另外算）。 */
function decisionKeys(d: DatasetReplayGame, rec: BotRecord): { human: KeyedAction; bot: KeyedAction; agree: boolean } | null {
  const g = d.game;
  const [, seat, t, idx, agent] = rec;
  const type = TYPES[t];
  switch (type) {
    case 'team': {
      const human = g.proposals[idx].teamSeats;
      const bot = parseSeatList(agent);
      if (bot.length !== human.length) return null;
      const agree = [...human].sort((a, b) => a - b).join() === [...bot].sort((a, b) => a - b).join();
      return { human: teamKeys(g, idx, human), bot: teamKeys(g, idx, bot), agree };
    }
    case 'vote': {
      const human = g.proposals[idx].votes[seat - 1];
      const bot = agent === 'approve';
      return { human: voteKeys(g, idx, seat, human), bot: voteKeys(g, idx, seat, bot), agree: human === bot };
    }
    case 'quest': {
      const pinned = pinnedQuestCard(g, idx, seat);
      if (pinned === null) return null;
      return { human: questKeys(g, idx, seat, pinned === 'fail'), bot: questKeys(g, idx, seat, agent === 'fail'), agree: pinned === agent };
    }
    case 'lakeTarget': {
      const human = g.lakes[idx].targetSeat;
      const bot = Number.parseInt(agent, 10);
      if (!Number.isFinite(bot)) return null;
      return { human: lakeTargetKeys(g, idx, human), bot: lakeTargetKeys(g, idx, bot), agree: human === bot };
    }
    case 'lakeClaim': {
      const human = g.lakes[idx].claim;
      if (human === null) return null;
      const bot = agent === 'good' || agent === 'evil' ? agent : 'none';
      return { human: lakeClaimKeys(g, idx, human), bot: lakeClaimKeys(g, idx, bot), agree: human === bot };
    }
    default:
      return null;
  }
}

/** 所有人類決策（不只機器人重播到的）→ 優勢樣本，依種類分。 */
function humanSamples(games: readonly DatasetReplayGame[], residual: (gi: number, seat: number) => number): Map<HumanPrDecision, Array<AdvantageSample & { fold: number }>> {
  const out = new Map<HumanPrDecision, Array<AdvantageSample & { fold: number }>>(TYPES.map((t) => [t, []]));
  games.forEach((d, gi) => {
    const g = d.game;
    const fold = foldOf(g.id);
    g.proposals.forEach((p, pi) => {
      out.get('team')!.push({ keys: teamKeys(g, pi, p.teamSeats), residual: residual(gi, p.leaderSeat), fold });
      if (!p.forced && p.votesReliable) {
        for (let seat = 1; seat <= g.playerCount; seat++) {
          out.get('vote')!.push({ keys: voteKeys(g, pi, seat, p.votes[seat - 1]), residual: residual(gi, seat), fold });
        }
      }
    });
    for (const q of g.quests) {
      for (const seat of q.teamSeats) {
        const pinned = pinnedQuestCard(g, q.round, seat);
        if (pinned !== null) out.get('quest')!.push({ keys: questKeys(g, q.round, seat, pinned === 'fail'), residual: residual(gi, seat), fold });
      }
    }
    if (g.lakeChainValid) {
      g.lakes.forEach((l, li) => {
        out.get('lakeTarget')!.push({ keys: lakeTargetKeys(g, li, l.targetSeat), residual: residual(gi, l.holderSeat), fold });
        if (l.claim !== null) out.get('lakeClaim')!.push({ keys: lakeClaimKeys(g, li, l.claim), residual: residual(gi, l.holderSeat), fold });
      });
    }
  });
  return out;
}

// ── 彙總 ─────────────────────────────────────────────────

interface Acc { n: number; human: number; bot: number; agree: number }

function bucketRows(items: ReadonlyArray<{ bucket: number | null; human: number; bot: number; agree?: boolean }>, weights?: Float64Array, gis?: readonly number[]): Array<BucketDelta & { agree: number }> {
  const acc = new Map<number, Acc>(PR_BUCKETS.map((b) => [b, { n: 0, human: 0, bot: 0, agree: 0 }]));
  items.forEach((it, i) => {
    if (it.bucket === null) return;
    const w = weights && gis ? weights[gis[i]] : 1;
    if (w === 0) return;
    const a = acc.get(it.bucket)!;
    a.n += w; a.human += w * it.human; a.bot += w * it.bot; a.agree += w * (it.agree ? 1 : 0);
  });
  return PR_BUCKETS.map((b) => {
    const a = acc.get(b)!;
    return { bucket: b, n: a.n, human: a.n ? a.human / a.n : 0, bot: a.n ? a.bot / a.n : 0, agree: a.n ? a.agree / a.n : 0 };
  });
}

interface Boot {
  /** 等效 PR 的 2.5／97.5 百分位（一半以上的重抽沒有梯度 = null）。 */
  pr: [number, number] | null;
  /** 人類每 +10 PR 的斜率的 2.5／97.5 百分位。 */
  slope: [number, number];
}

/** 局集群自助法（Poisson(1) 權重）：等效 PR 與人類斜率的 95% 區間。 */
function bootstrapPr(
  items: ReadonlyArray<{ bucket: number | null; human: number; bot: number }>,
  gis: readonly number[],
  nGames: number,
  reps: number,
  seed: number,
): Boot | null {
  if (reps <= 0) return null;
  let s = seed >>> 0;
  const rand = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const poisson1 = (): number => {
    const L = Math.exp(-1);
    let k = 0;
    let p = 1;
    do { k++; p *= rand(); } while (p > L);
    return k - 1;
  };
  const prs: number[] = [];
  const slopes: number[] = [];
  const w = new Float64Array(nGames);
  for (let r = 0; r < reps; r++) {
    for (let i = 0; i < nGames; i++) w[i] = poisson1();
    const rows = bucketRows(items, w, gis);
    prs.push(equivalentPr(rows).pr ?? Number.NaN);
    slopes.push(humanSlopePer10(rows));
  }
  const pct = (xs: number[]): [number, number] => [xs[Math.floor(xs.length * 0.025)], xs[Math.min(xs.length - 1, Math.floor(xs.length * 0.975))]];
  const ok = prs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return { pr: ok.length >= reps * 0.5 ? pct(ok) : null, slope: pct(slopes.sort((a, b) => a - b)) };
}

/** 人類斜率的 95% 區間整個在 0 以上 = 這個決策的量尺有梯度（等效 PR 才有意義）。 */
function reliable(boot: Boot | null): boolean {
  return boot !== null && boot.slope[0] > 0;
}

function fmt(x: number, d = 1): string {
  return Number.isFinite(x) ? x.toFixed(d) : '—';
}

function prText(rows: readonly BucketDelta[], boot: Boot | null): string {
  const e = equivalentPr(rows);
  if (e.pr === null) {
    const used = rows.filter((r) => r.n > 0);
    if (used.length > 0 && used.every((r) => r.bot < r.human)) return '低於每一組人類（人類沒有隨 PR 的梯度）';
    if (used.length > 0 && used.every((r) => r.bot > r.human)) return '高於每一組人類（人類沒有隨 PR 的梯度）';
    return 'n/a（人類沒有隨 PR 的梯度）';
  }
  const ci = boot?.pr;
  const flag = boot && !reliable(boot) ? '（人類斜率含 0，不可靠）' : '';
  return `${fmt(e.pr, 0)}${e.clamped ? '（超出範圍，夾住）' : ''}${ci ? ` [${fmt(ci[0], 0)}, ${fmt(ci[1], 0)}]` : ''}${flag}`;
}

function table(rows: ReadonlyArray<BucketDelta & { agree?: number }>, scale: number, unit: string): string {
  const head = ['PR', 'n', `人類${unit}`, `機器人${unit}`, 'Δ', '一致'];
  const body = rows.map((r) => [
    `${r.bucket}–${r.bucket === 90 ? 100 : r.bucket + 9}`, String(Math.round(r.n)),
    fmt(r.human * scale, 2), fmt(r.bot * scale, 2), fmt((r.bot - r.human) * scale, 2),
    r.agree !== undefined ? `${fmt(r.agree * 100, 1)}%` : '',
  ]);
  const all = [head, ...body];
  const widths = head.map((_, i) => Math.max(...all.map((x) => x[i].length)));
  return all.map((x) => x.map((c, i) => c.padEnd(widths[i])).join('  ')).join('\n');
}

// ── 主程式 ───────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const tuning = resolveAgentTuning(args.flags, args.legacy ? { ...LEGACY_AGENT_TUNING } : undefined);
  applyEnvOptions();
  const { games, skipped, total } = loadGames(args);

  if (args.shard) {
    const [k, n] = args.shard;
    const records = replayShard(games, tuning, k, n);
    fs.writeFileSync(args.out!, JSON.stringify({ records, forward: getForwardTelemetry().totalDecisions }));
    return;
  }

  const started = Date.now();
  const { records, forward } = await botDecisions(args, games, tuning);

  // 陣容強度預期：藍方贏 ~ α + β·(藍方平均 PR − 紅方平均 PR)/100（有 lineup 的局擬合；沒有的局 x = 0）。
  const xs: number[] = [];
  const ys: number[] = [];
  const gx = games.map((d) => {
    if (!d.prs) return 0;
    const blue = d.prs.filter((_, i) => campOf(d.game.seatRoles[i]) === 'good');
    const red = d.prs.filter((_, i) => campOf(d.game.seatRoles[i]) === 'evil');
    const x = (blue.reduce((a, b) => a + b, 0) / blue.length - red.reduce((a, b) => a + b, 0) / red.length) / 100;
    xs.push(x);
    ys.push(d.game.winner === 'good' ? 1 : 0);
    return x;
  });
  const [alpha, beta] = fitLogistic(xs, ys);
  const blueP = (gi: number): number => 1 / (1 + Math.exp(-(alpha + beta * gx[gi])));
  const residual = (gi: number, seat: number): number => {
    const g = games[gi].game;
    const blueWin = g.winner === 'good' ? 1 : 0;
    const r = blueWin - blueP(gi);
    return campOf(g.seatRoles[seat - 1]) === 'good' ? r : -r;
  };

  // 交叉擬合的優勢表：tables[type][fold] 用其他折的人類決策。
  const samples = humanSamples(games, residual);
  const tables = new Map<HumanPrDecision, AdvantageTable[]>();
  for (const t of TYPES) {
    if (t === 'assassinate') continue;
    const all = samples.get(t)!;
    tables.set(t, Array.from({ length: 5 }, (_, f) => fitAdvantageTable(all.filter((x) => x.fold !== f), args.shrink)));
  }

  // 刺殺的基準：人類刺中率（交叉擬合，同折不算）。
  const killFold = Array.from({ length: 5 }, () => ({ n: 0, hit: 0 }));
  games.forEach((d) => {
    const g = d.game;
    if (g.assassinTargetSeat === undefined) return;
    const f = foldOf(g.id);
    killFold[f].n += 1;
    killFold[f].hit += g.seatRoles[g.assassinTargetSeat - 1] === 'merlin' ? 1 : 0;
  });
  const killBase = (f: number): number => {
    const n = killFold.reduce((a, x, i) => a + (i === f ? 0 : x.n), 0);
    const hit = killFold.reduce((a, x, i) => a + (i === f ? 0 : x.hit), 0);
    return n ? hit / n : 0.5;
  };

  const scored: Scored[] = [];
  for (const rec of records) {
    const [gi, seat, t, , agent] = rec;
    const d = games[gi];
    const g = d.game;
    const type = TYPES[t];
    const role = g.seatRoles[seat - 1];
    const bucket = prBucket(d.prs?.[seat - 1], d.prov?.[seat - 1] ?? true);
    if (type === 'assassinate') {
      if (g.assassinTargetSeat === undefined) continue;
      const merlin = g.seatRoles.indexOf('merlin') + 1;
      const base = killBase(foldOf(g.id));
      const humanHit = g.assassinTargetSeat === merlin ? 1 : 0;
      const botHit = Number.parseInt(agent, 10) === merlin ? 1 : 0;
      scored.push({ gi, seat, type, role, bucket, human: humanHit - base, bot: botHit - base, agree: g.assassinTargetSeat === Number.parseInt(agent, 10) });
      continue;
    }
    const keys = decisionKeys(d, rec);
    if (!keys) continue;
    const tab = tables.get(type)![foldOf(g.id)];
    scored.push({ gi, seat, type, role, bucket, human: advantage(tab, keys.human), bot: advantage(tab, keys.bot), agree: keys.agree });
  }

  // 一個座位一局的加總（總 PR）。
  const seatSum = new Map<string, Scored>();
  for (const s of scored) {
    const k = `${s.gi}|${s.seat}`;
    const acc = seatSum.get(k) ?? { ...s, type: 'team' as HumanPrDecision, human: 0, bot: 0, agree: true };
    acc.human += s.human;
    acc.bot += s.bot;
    seatSum.set(k, acc);
  }
  const seatGames = [...seatSum.values()];

  const lineupGames = games.filter((d) => d.prs).length;
  const out: Record<string, unknown> = {};
  console.log(`資料集 ${total} 局；可重播 ${games.length} 局（有 PR ${lineupGames} 局）；跳過 ${Object.entries(skipped).map(([r, n]) => `${r} ${n}`).join('；')}`);
  console.log(`agent tuning: ${describeAgentTuning(tuning)}`);
  console.log(`forward decisions: ${forward}；機器人決策 ${records.length}；評分 ${scored.length}`);
  console.log(`陣容預期：藍勝 = σ(${fmt(alpha, 3)} + ${fmt(beta, 3)}·ΔPR/100)`);

  const report = (label: string, items: Scored[], scale: number, unit: string, seed: number): Record<string, unknown> => {
    const rows = bucketRows(items);
    const gis = items.map((x) => x.gi);
    const boot = bootstrapPr(items, gis, games.length, args.boot, seed);
    const e = equivalentPr(rows);
    const slopeCi = boot ? ` [${fmt(boot.slope[0] * scale, 2)}, ${fmt(boot.slope[1] * scale, 2)}]` : '';
    const W = rows.reduce((a, r) => a + r.n, 0);
    const meanDelta = W ? rows.reduce((a, r) => a + r.n * (r.bot - r.human), 0) / W : 0;
    console.log(`\n## ${label}：機器人 ≈ PR ${prText(rows, boot)} （人類每 +10 PR ${fmt(humanSlopePer10(rows) * scale, 2)}${slopeCi}${unit}；機器人−人類平均 ${fmt(meanDelta * scale, 2)}${unit}）`);
    console.log(table(rows, scale, unit));
    return { pr: e.pr, clamped: e.clamped, ci: boot?.pr ?? null, humanSlopeCi: boot?.slope ?? null, reliable: reliable(boot), meanDelta, slope: e.slope, humanSlopePer10: humanSlopePer10(rows), rows };
  };

  out.overall = report('總 PR（一個座位一局所有決策的優勢加總，單位：勝率 pp）', seatGames, 100, 'pp', 1);
  const byType: Record<string, unknown> = {};
  TYPES.forEach((t, i) => {
    const items = scored.filter((s) => s.type === t);
    const unit = t === 'assassinate' ? 'pp（刺中率−基準）' : 'pp';
    byType[t] = report(`決策：${t}`, items, 100, unit, 10 + i);
  });
  out.byType = byType;

  const byRole: Record<string, unknown> = {};
  const roleSummary: string[] = [];
  BENCHMARK_ROLES.forEach((role, i) => {
    const items = seatGames.filter((s) => s.role === role);
    const rows = bucketRows(items);
    const boot = bootstrapPr(items, items.map((x) => x.gi), games.length, args.boot, 100 + i);
    const e = equivalentPr(rows);
    const W = rows.reduce((a, r) => a + r.n, 0);
    const meanDelta = W ? rows.reduce((a, r) => a + r.n * (r.bot - r.human), 0) / W : 0;
    const typeRows: Record<string, unknown> = {};
    const typeText: string[] = [];
    for (const t of TYPES) {
      const it = scored.filter((s) => s.role === role && s.type === t);
      if (it.length < 50) continue;
      const tr = bucketRows(it);
      const te = equivalentPr(tr);
      typeRows[t] = { pr: te.pr, n: it.length, rows: tr };
      typeText.push(`${t} ${te.pr === null ? 'n/a' : fmt(te.pr, 0)}`);
    }
    byRole[role] = { pr: e.pr, ci: boot?.pr ?? null, reliable: reliable(boot), meanDelta, rows, byType: typeRows };
    roleSummary.push(`${role.padEnd(9)} 機器人−人類 ${fmt(meanDelta * 100, 2)}pp／座位局；總 ${prText(rows, boot)}；${typeText.join('、')}`);
  });
  out.byRole = byRole;
  console.log('\n## 分角色（機器人−人類的優勢差；總 PR [95% 區間]；各決策的等效 PR）');
  for (const line of roleSummary) console.log(line);

  // 刺殺：直接的刺中率。
  const kills = scored.filter((s) => s.type === 'assassinate');
  const killRows = PR_BUCKETS.map((b) => {
    const it = kills.filter((s) => s.bucket === b);
    const base = it.length ? it.reduce((a, s) => a + killBase(foldOf(games[s.gi].game.id)), 0) / it.length : 0;
    return {
      bucket: b,
      n: it.length,
      humanHit: it.length ? it.reduce((a, s) => a + s.human, 0) / it.length + base : 0,
      botHit: it.length ? it.reduce((a, s) => a + s.bot, 0) / it.length + base : 0,
    };
  });
  const allKill = kills.length ? {
    n: kills.length,
    human: kills.reduce((a, s) => a + s.human + killBase(foldOf(games[s.gi].game.id)), 0) / kills.length,
    bot: kills.reduce((a, s) => a + s.bot + killBase(foldOf(games[s.gi].game.id)), 0) / kills.length,
  } : null;
  console.log(`\n## 刺殺的刺中率（全部 ${allKill?.n ?? 0} 次：人類 ${fmt((allKill?.human ?? 0) * 100)}%、機器人 ${fmt((allKill?.bot ?? 0) * 100)}%）`);
  console.log(killRows.map((r) => `PR ${r.bucket}–${r.bucket === 90 ? 100 : r.bucket + 9}: n=${r.n} 人類 ${fmt(r.humanHit * 100)}% 機器人 ${fmt(r.botHit * 100)}%`).join('\n'));
  out.assassination = { all: allKill, rows: killRows };

  // 看得懂的對照（用真相打分數，不估優勢）：忠臣／派西投票對不對（乾淨的隊贊成、有紅的隊反對）、忠臣／派西派的隊乾淨、
  // 藍方湖驗到紅、刺客刺中梅林。同一套 Δ = 0 的換算。
  const diag = new Map<string, Array<{ gi: number; bucket: number | null; human: number; bot: number }>>();
  const push = (k: string, gi: number, bucket: number | null, h: boolean, b: boolean): void => {
    const list = diag.get(k) ?? [];
    list.push({ gi, bucket, human: h ? 1 : 0, bot: b ? 1 : 0 });
    diag.set(k, list);
  };
  for (const [gi, seat, t, idx, agent] of records) {
    const d = games[gi];
    const g = d.game;
    const role = g.seatRoles[seat - 1];
    const bucket = prBucket(d.prs?.[seat - 1], d.prov?.[seat - 1] ?? true);
    const plainGood = role === 'loyal' || role === 'percival';
    const clean = (team: readonly number[]): boolean => team.every((x) => campOf(g.seatRoles[x - 1]) === 'good');
    const type = TYPES[t];
    if (type === 'vote' && plainGood) {
      const ok = clean(g.proposals[idx].teamSeats);
      push('忠臣／派西投票正確（乾淨贊成、有紅反對）', gi, bucket, g.proposals[idx].votes[seat - 1] === ok, (agent === 'approve') === ok);
    } else if (type === 'team' && plainGood) {
      push('忠臣／派西派的隊沒有紅', gi, bucket, clean(g.proposals[idx].teamSeats), clean(parseSeatList(agent)));
    } else if (type === 'lakeTarget' && campOf(role) === 'good') {
      const bt = Number.parseInt(agent, 10);
      push('藍方湖驗到紅', gi, bucket, campOf(g.seatRoles[g.lakes[idx].targetSeat - 1]) === 'evil', Number.isFinite(bt) && campOf(g.seatRoles[bt - 1]) === 'evil');
    } else if (type === 'assassinate' && g.assassinTargetSeat !== undefined) {
      const merlin = g.seatRoles.indexOf('merlin') + 1;
      push('刺客刺中梅林', gi, bucket, g.assassinTargetSeat === merlin, Number.parseInt(agent, 10) === merlin);
    }
  }
  const diagOut: Record<string, unknown> = {};
  console.log('\n## 看得懂的對照（真相打分數；人類% / 機器人% 依 PR 組）');
  [...diag.entries()].forEach(([k, items], i) => {
    const rows = bucketRows(items);
    const boot = bootstrapPr(items, items.map((x) => x.gi), games.length, args.boot, 200 + i);
    const W = rows.reduce((a, r) => a + r.n, 0);
    const h = rows.reduce((a, r) => a + r.n * r.human, 0) / W;
    const b = rows.reduce((a, r) => a + r.n * r.bot, 0) / W;
    console.log(`${k}：人類 ${fmt(h * 100)}%、機器人 ${fmt(b * 100)}% → PR ${prText(rows, boot)}`);
    console.log(`  ${rows.map((r) => `${r.bucket}:${fmt(r.human * 100, 0)}/${fmt(r.bot * 100, 0)}`).join(' ')}`);
    diagOut[k] = { human: h, bot: b, pr: equivalentPr(rows).pr, ci: boot?.pr ?? null, humanSlopeCi: boot?.slope ?? null, reliable: reliable(boot), rows };
  });
  out.diagnostics = diagOut;

  console.log(`\nelapsed ${((Date.now() - started) / 1000).toFixed(1)}s`);
  if (args.json) {
    fs.writeFileSync(args.json, JSON.stringify({
      generatedBy: 'packages/server/scripts/humanPrBenchmark.ts',
      tuning,
      dataset: { total, replayable: games.length, withLineup: lineupGames, skipped },
      baseline: { alpha, beta },
      ...out,
    }, null, 2));
    console.log(`wrote ${args.json}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
