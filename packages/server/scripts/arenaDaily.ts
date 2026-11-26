/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * AI 擂台每日大賽（.github/workflows/arena-tournament.yml 用；docs/BOTS.md〈AI 擂台〉）。兩個子指令：
 *
 *   arena:daily shard --date YYYY-MM-DD --kind daily|push|manual|smoke [--run-id N] [--seed S]
 *                     --games 總局數 --slice i/k [--players 10] [--workers 4] --out shard.json
 *     跑第 i 片（從 0 數，共 k 片）負責的連續局號，寫成精簡的分片結果檔。第 n 局只由 (seed, n) 決定，
 *     所以切幾片、每片幾個行程都不影響結果；每日排程的 seed = arena-<日期>。
 *
 *   arena:daily aggregate --in 分片資料夾 [--arena ../../arena] [--summary 檔案]
 *     合併所有分片 → 擬合分數（分紅藍、95% 區間）→ 寫 arena/leaderboard.json、
 *     arena/history/<日期>.json（當天快照；超過 60 天的併成每週 arena/history/YYYY-Www.json）。
 *     `--summary` 會附加一段 Markdown（GitHub job summary 用）。
 *
 * 只跑百科AI 的引擎與 profile 開關，不執行任何社群程式碼，也不用任何 token。
 */
import * as fs from 'fs';
import * as path from 'path';
import { SelfPlayEngine } from '../src/ai/SelfPlayEngine';
import { loadRoster, type RegisteredBot } from '../src/arena/registry';
import { buildLeaderboard, parseSizes, tournamentSeating } from '../src/arena/report';
import { playTable, quietly, type Entrant, type TableResult } from '../src/arena/table';
import {
  applyRunToDay, buildTrend, makeShardFile, mergeShards, parseSlice, parseSnapshot, planRollup, rosterHash, runSeed,
  sliceRange, totalGames, type HistorySnapshot, type RunKind, type ShardFile,
} from '../src/arena/daily';
import { defaultWorkers, runSharded, stripShardArgs } from './arena/shard';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const KINDS: RunKind[] = ['daily', 'push', 'manual', 'smoke'];

function resolveArg(p: string): string {
  return path.resolve(process.env.INIT_CWD ?? process.cwd(), p);
}

function parseArgs(argv: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`不認得的參數 ${a}`);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${a} 需要一個值`);
    out.set(a.slice(2), v);
    i++;
  }
  return out;
}

function need(args: Map<string, string>, key: string): string {
  const v = args.get(key);
  if (v === undefined) throw new Error(`缺少 --${key}`);
  return v;
}

async function shard(args: Map<string, string>): Promise<void> {
  const date = need(args, 'date');
  const kind = need(args, 'kind') as RunKind;
  if (!KINDS.includes(kind)) throw new Error(`--kind 要是 ${KINDS.join('/')}`);
  const seed = args.get('seed') ?? runSeed(date, kind, args.get('run-id'));
  const total = Number.parseInt(need(args, 'games'), 10);
  const { index, count } = parseSlice(need(args, 'slice'));
  const sizes = parseSizes(args.get('players') ?? '10');
  const workers = args.has('workers') ? Number.parseInt(args.get('workers')!, 10) : defaultWorkers();
  const out = resolveArg(need(args, 'out'));
  const range = sliceRange(total, index, count);
  const roster = loadRoster({ includeExamples: true });
  const ids = roster.bots.map((b) => b.id);
  const entrants = new Map<string, Entrant>(roster.bots.map((b) => [b.id, { id: b.id, profile: b.profile }]));
  console.log(`第 ${index + 1}/${count} 片：局號 ${range.start}..${range.end - 1}（${range.end - range.start} 局，共 ${total} 局）；參賽 ${ids.length} 隻；seed ${seed}；${workers} 個行程`);
  const engine = new SelfPlayEngine();
  const started = Date.now();
  const tables = await runSharded<TableResult>(range.end - range.start, (k) => quietly(async () => {
    const i = range.start + k;
    const { seats } = tournamentSeating(seed, i, ids, sizes);
    return playTable(engine, seats.map((id) => entrants.get(id)!), `${seed}|${i}`);
  }), workers, `arena:daily ${index + 1}/${count}`);
  const elapsedSec = Math.round((Date.now() - started) / 100) / 10;
  const file = makeShardFile({
    seed, date, kind, totalGames: total, slice: range, sizes, roster: ids, rosterHash: rosterHash(roster.bots),
    elapsedSec, workers, tables,
  });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(file));
  const rate = tables.length / Math.max(elapsedSec, 0.1);
  console.log(`完成 ${tables.length} 局，${elapsedSec} 秒（每秒 ${rate.toFixed(2)} 局，每個行程每秒 ${(rate / workers).toFixed(2)} 局）→ ${out}`);
}

function listJson(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listJson(p));
    else if (e.isFile() && e.name.endsWith('.json')) out.push(p);
  }
  return out.sort();
}

function readHistory(dir: string): HistorySnapshot[] {
  if (!fs.existsSync(dir)) return [];
  const snaps: HistorySnapshot[] = [];
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    try {
      const s = parseSnapshot(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
      if (s && `${s.period}.json` === name) snaps.push(s);
      else console.log(`略過看不懂的歷史檔 ${name}`);
    } catch {
      console.log(`略過壞掉的歷史檔 ${name}`);
    }
  }
  return snaps;
}

function compactJson(s: HistorySnapshot): string {
  // 一隻機器人一行，diff 好讀、檔案也小。
  const bots = Object.entries(s.bots).map(([id, t]) => `    ${JSON.stringify(id)}: ${JSON.stringify(t)}`).join(',\n');
  const head = { schema: s.schema, kind: s.kind, period: s.period, games: s.games, runs: s.runs };
  const headJson = JSON.stringify(head, null, 2).replace(/\n}$/, '');
  return `${headJson},\n  "bots": {\n${bots}\n  }\n}\n`;
}

const KIND_ZH: Record<RunKind, string> = { daily: '每日排程', push: '合併後補跑', manual: '手動', smoke: '試跑' };

async function aggregate(args: Map<string, string>): Promise<void> {
  const inDir = resolveArg(need(args, 'in'));
  const arenaDir = args.has('arena') ? resolveArg(args.get('arena')!) : path.join(REPO_ROOT, 'arena');
  const files = listJson(inDir).map((f) => JSON.parse(fs.readFileSync(f, 'utf8')) as ShardFile);
  const run = mergeShards(files);
  const roster = loadRoster({ includeExamples: true });
  const byId = new Map(roster.bots.map((b) => [b.id, b]));
  const bots: RegisteredBot[] = run.roster.map((id) => {
    const b = byId.get(id);
    if (!b) throw new Error(`分片的名冊有 ${id}，但這份程式碼的名冊裡沒有（分片和合併要用同一個 commit）`);
    return b;
  });
  if (rosterHash(bots) !== run.rosterHash) throw new Error('分片跑的名冊和這份程式碼的名冊不一樣（分片和合併要用同一個 commit）');
  const board = buildLeaderboard({
    bots,
    tables: run.tables,
    seed: run.seed,
    sizes: run.sizes,
    generatedAt: new Date().toISOString(),
    rejected: roster.rejected,
  });

  const histDir = path.join(arenaDir, 'history');
  const existing = readHistory(histDir);
  const prev = existing.find((s) => s.kind === 'day' && s.period === run.date) ?? null;
  const day = applyRunToDay(prev, run.date, run.tables.length, board);
  const snaps = [...existing.filter((s) => s !== prev), day];
  const rollup = planRollup(snaps, run.date);
  fs.mkdirSync(histDir, { recursive: true });
  const final = snaps.filter((s) => !(s.kind === 'day' && rollup.remove.includes(`${s.period}.json`)) && !(s.kind === 'week' && rollup.write.has(`${s.period}.json`)));
  final.push(...rollup.write.values());
  fs.writeFileSync(path.join(histDir, `${day.period}.json`), compactJson(day));
  for (const [name, s] of rollup.write) fs.writeFileSync(path.join(histDir, name), compactJson(s));
  // 只刪這一步自己產生、而且已經併進每週快照的每日檔。
  for (const name of rollup.remove) fs.rmSync(path.join(histDir, name), { force: true });

  const missingGames = run.missing.reduce((a, m) => a + (m.end - m.start), 0);
  board.daily = {
    date: run.date,
    kind: run.kind,
    gamesToday: day.games,
    runsToday: day.runs,
    gamesTotal: totalGames(final),
    shards: run.shards,
    missingGames,
    gamesPerSecPerRunner: run.gamesPerSecPerRunner,
    slowestShardSec: run.slowestShardSec,
  };
  board.trend = buildTrend(final, board.bots.map((b) => b.id));
  fs.writeFileSync(path.join(arenaDir, 'leaderboard.json'), `${JSON.stringify(board, null, 2)}\n`);

  const lines = [
    `### AI 擂台（${KIND_ZH[run.kind]}，${run.date}）`,
    '',
    `這一輪 ${run.tables.length.toLocaleString('en-US')} 局（${run.shards} 片${missingGames ? `，少了 ${missingGames.toLocaleString('en-US')} 局` : ''}）；`
      + `今天 ${day.games.toLocaleString('en-US')} 局（${day.runs} 輪）；累計 ${board.daily.gamesTotal.toLocaleString('en-US')} 局。`,
    `每個 runner 每秒 ${run.gamesPerSecPerRunner} 局；最慢的一片 ${(run.slowestShardSec / 60).toFixed(1)} 分鐘。seed \`${run.seed}\`。`,
    '',
    '| 名次 | 機器人 | 總分 [95%] | 紅方分 | 藍方分 | 紅方勝率 | 藍方勝率 | 座位數 |',
    '|---|---|---|---|---|---|---|---|',
    ...board.bots.map((b) => {
      const r = b.rating;
      return `| ${b.rank} | ${b.name}${b.author ? `（${b.author}）` : ''} | ${r.overall.rating.toFixed(0)} [${r.overall.low.toFixed(0)}, ${r.overall.high.toFixed(0)}] | ${r.red.rating.toFixed(0)} | ${r.blue.rating.toFixed(0)} | ${(b.red.winRate * 100).toFixed(1)}% | ${(b.blue.winRate * 100).toFixed(1)}% | ${b.seats} |`;
    }),
    '',
  ];
  if (rollup.remove.length) lines.push(`併成每週快照：${[...rollup.write.keys()].join('、')}（${rollup.remove.length} 份每日快照）`, '');
  const md = lines.join('\n');
  console.log(md);
  if (args.has('summary')) fs.appendFileSync(resolveArg(args.get('summary')!), `${md}\n`);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = stripShardArgs(process.argv.slice(2));
  if (cmd === 'shard') return shard(parseArgs(rest));
  if (cmd === 'aggregate') return aggregate(parseArgs(rest));
  console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
  if (cmd !== '--help' && cmd !== '-h') throw new Error('要給子指令 shard 或 aggregate');
}

main().then(() => process.exit(0), (err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
