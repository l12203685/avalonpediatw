/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 每個角色 × 百科AI 的逐決策點比對：把網站真人局的**每一個座位**都重播一次（站長 2026-11-25：
 * 「百科AI 藍方忠臣的做法 也同樣去對所有角色做一樣的事情」）。輸出沒有玩家名字（只有局號與座位）。
 *
 *   cd packages/server
 *   npx tsx scripts/roleSpots.ts replay   --out DIR [--workers 2] [--limit N]     # 慢：機器人逐點重播 → DIR/raw.<k>.jsonl
 *   npx tsx scripts/roleSpots.ts annotate --out DIR                               # 快：補上局面欄位 → DIR/spots.jsonl、games.json
 *
 * replay：同 `playerAgreement.ts` 的重播（`agreement.replaySeat`：機器人坐在那個座位、只看當時的公開紀錄＋自己角色的資訊），
 *   真人桌策略層（agent）與基準線（agentAi）各跑一次，合成一筆。另外開 `openQuestCards`：紅方出任務但牌譜看不出
 *   是誰出失敗的那幾張，也記機器人會出什麼（`questOpen`，真人那一欄 = 失敗張數 ÷ 隊上紅方人數）。
 *   局的排除同 `playerAgreement.ts`（百科AI 局、badGame、總庫的錯誤／重複局、無法嚴格重播的局）。
 * annotate：不跑機器人，只用牌譜替每個決策點補 `spotContext.ts` 的欄位（比數、隊伍組成、這個座位認得的紅方、
 *   湖中對象、刺殺對象的角色……），所以欄位要改時不用重跑 replay。games.json = 每局的角色、結果、刺殺（給分析用）。
 * 後續：`roleBreakdown.py`（選各角色的強者、分情境比較、線索表）。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { execSync, fork } from 'child_process';
import { replaySeat, type DecisionOutcome } from '../src/ai/benchmark/agreement';
import { replayGameFromDataset, type DatasetReplayGame } from '../src/ai/benchmark/datasetReplay';
import { excludedDatasetKeys, type GameDbCorrection, type GameDbRow, type Profile } from '../src/ai/benchmark/playerAgreement';
import { spotContext } from '../src/ai/benchmark/spotContext';
import { loadJson, makeAgentFor, opponentOf, type Dataset } from './playerAgreement';

const SERVER = path.resolve(__dirname, '..');

interface Args {
  mode: string;
  out: string;
  dataset: string;
  gameDb: string;
  corrections: string;
  workers: number;
  limit?: number;
  shard?: [number, number];
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    mode: argv[0] ?? '',
    out: '',
    dataset: path.join(SERVER, 'games_cache.json'),
    gameDb: path.join(SERVER, 'game_db.json'),
    corrections: path.join(SERVER, 'game_db_corrections.json'),
    workers: Math.max(1, Math.min(2, os.cpus().length)),
  };
  for (let i = 1; i < argv.length; i++) {
    const k = argv[i];
    const next = (): string => { const v = argv[++i]; if (v === undefined) throw new Error(`${k} needs a value`); return v; };
    switch (k) {
      case '--out': a.out = path.resolve(next()); break;
      case '--dataset': a.dataset = path.resolve(next()); break;
      case '--game-db': a.gameDb = path.resolve(next()); break;
      case '--corrections': a.corrections = path.resolve(next()); break;
      case '--workers': a.workers = Math.max(1, Number.parseInt(next(), 10)); break;
      case '--limit': a.limit = Number.parseInt(next(), 10); break;
      case '--shard': { const [x, n] = next().split('/').map((v) => Number.parseInt(v, 10)); a.shard = [x, n]; break; }
      case '--help': case '-h': console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]); process.exit(0); break;
      default: throw new Error(`unknown argument ${k}`);
    }
  }
  if (!['replay', 'annotate'].includes(a.mode)) throw new Error('first argument: replay | annotate');
  if (!a.out) throw new Error('--out DIR is required');
  return a;
}

/** 一個決策點（兩個策略層合成一筆；沒有名字）。 */
export interface RoleSpot {
  gameId: string;
  seat: number;
  role: string;
  side: 'good' | 'evil';
  type: DecisionOutcome['type'];
  round: number;
  attempt?: number;
  human: string;
  /** 真人桌策略層的選擇。 */
  agent: string;
  /** 基準線的選擇。 */
  agentAi: string;
  /** questOpen：失敗張數 ÷ 隊上紅方人數。 */
  humanFailShare?: number;
  tier: string;
}

/** 可以重播的真人局（排除同 playerAgreement.ts）。 */
function eligibleGames(a: Args, ds: Dataset): Array<{ id: string; g: DatasetReplayGame }> {
  const iId = ds.fields.indexOf('id');
  const iSrc = ds.fields.indexOf('src');
  const iCat = ds.fields.indexOf('cat');
  const iNote = ds.fields.indexOf('note');
  const dbRows = fs.existsSync(a.gameDb) ? loadJson<{ games: GameDbRow[] }>(a.gameDb).games : [];
  const corrections = fs.existsSync(a.corrections) ? loadJson<{ corrections: Record<string, GameDbCorrection> }>(a.corrections).corrections : {};
  const excluded = excludedDatasetKeys(dbRows, corrections);
  const out: Array<{ id: string; g: DatasetReplayGame }> = [];
  for (const row of ds.games) {
    const gid = String(row[iId]);
    const notes = ((row[iNote] as number[] | undefined) ?? []).map((i) => ds.vocab.noteTags[i]);
    if (ds.vocab.category?.[row[iCat] as number] === '百科AI') continue;
    if (excluded.get(`${row[iSrc]}|${gid}`) || notes.includes('flag:badGame')) continue;
    const res = replayGameFromDataset(row, ds);
    if (!res.ok) continue;
    out.push({ id: gid, g: res.value });
    if (a.limit !== undefined && out.length >= a.limit) break;
  }
  return out;
}

function replayOne(g: DatasetReplayGame): RoleSpot[] {
  const opp = opponentOf(g);
  const out: RoleSpot[] = [];
  const run = (seat: number, profile: Profile): DecisionOutcome[] =>
    replaySeat(g.game, seat, { makeAgent: makeAgentFor(profile, opp), openQuestCards: true });
  for (let seat = 1; seat <= g.game.playerCount; seat++) {
    const h = run(seat, 'human');
    const b = run(seat, 'ai');
    if (h.length !== b.length) throw new Error(`game ${g.game.id} seat ${seat}: the two layers disagree on the decision points`);
    h.forEach((o, i) => {
      const x = b[i];
      if (x.type !== o.type || x.round !== o.round || x.attempt !== o.attempt || x.human !== o.human) {
        throw new Error(`game ${g.game.id} seat ${seat}: decision point ${i} differs between the two layers`);
      }
      out.push({
        gameId: o.gameId, seat: o.seat, role: o.role, side: o.side, type: o.type, round: o.round,
        ...(o.attempt !== undefined ? { attempt: o.attempt } : {}),
        human: o.human, agent: o.agent, agentAi: x.agent,
        ...(o.humanFailShare !== undefined ? { humanFailShare: o.humanFailShare } : {}),
        tier: opp,
      });
    });
  }
  return out;
}

function runShard(a: Args): void {
  const ds = loadJson<Dataset>(a.dataset);
  const games = eligibleGames(a, ds);
  const [k, n] = a.shard!;
  const file = path.join(a.out, `raw.${k}.jsonl`);
  const fd = fs.openSync(file, 'w');
  const started = Date.now();
  let done = 0;
  for (let j = k; j < games.length; j += n) {
    fs.writeSync(fd, replayOne(games[j].g).map((s) => JSON.stringify(s)).join('\n') + '\n');
    done += 1;
    if (done % 50 === 0) console.error(`shard ${k}: ${done}/${Math.ceil((games.length - k) / n)} games, ${((Date.now() - started) / 1000).toFixed(0)}s`);
  }
  fs.closeSync(fd);
  fs.writeFileSync(path.join(a.out, `raw.${k}.done`), String(done));
}

async function replay(a: Args): Promise<void> {
  fs.mkdirSync(a.out, { recursive: true });
  const started = Date.now();
  const pass = ['--out', a.out, '--dataset', a.dataset, '--game-db', a.gameDb, '--corrections', a.corrections, ...(a.limit !== undefined ? ['--limit', String(a.limit)] : [])];
  await Promise.all(Array.from({ length: a.workers }, (_, k) => new Promise<void>((resolve, reject) => {
    const child = fork(process.argv[1], ['replay', ...pass, '--shard', `${k}/${a.workers}`], { execArgv: process.execArgv, stdio: 'inherit' });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`shard ${k} exited ${code}`))));
  })));
  let gitSha = '';
  try { gitSha = execSync('git rev-parse HEAD', { cwd: SERVER }).toString().trim(); } catch { /* not a checkout */ }
  fs.writeFileSync(path.join(a.out, 'raw.meta.json'), JSON.stringify({ generatedAt: new Date().toISOString(), gitSha, workers: a.workers, dataset: path.basename(a.dataset) }));
  console.error(`replay done in ${((Date.now() - started) / 1000).toFixed(0)}s (${a.workers} workers) → ${a.out}/raw.*.jsonl`);
}

async function annotate(a: Args): Promise<void> {
  const ds = loadJson<Dataset>(a.dataset);
  const games = new Map(eligibleGames(a, ds).map((x) => [x.id, x.g]));
  const meta = fs.existsSync(path.join(a.out, 'raw.meta.json')) ? loadJson<Record<string, unknown>>(path.join(a.out, 'raw.meta.json')) : {};
  const files = fs.readdirSync(a.out).filter((f) => /^raw\.\d+\.jsonl$/.test(f)).sort();
  if (files.length === 0) throw new Error(`no raw.<k>.jsonl in ${a.out} (run replay first)`);
  const fd = fs.openSync(path.join(a.out, 'spots.jsonl'), 'w');
  const seen = new Set<string>();
  let n = 0;
  for (const f of files) {
    const rl = readline.createInterface({ input: fs.createReadStream(path.join(a.out, f)), crlfDelay: Infinity });
    let buf: string[] = [];
    for await (const line of rl) {
      if (!line) continue;
      const s = JSON.parse(line) as RoleSpot;
      const g = games.get(s.gameId);
      if (!g) continue;
      seen.add(s.gameId);
      const ctx = spotContext(g.game, s);
      const ctxAi = s.agentAi !== s.agent ? spotContext(g.game, { ...s, agent: s.agentAi }) : null;
      buf.push(JSON.stringify({ ...s, ...(ctx ? { ctx } : {}), ...(ctxAi ? { ctxAi } : {}) }));
      n += 1;
      if (buf.length >= 2000) { fs.writeSync(fd, buf.join('\n') + '\n'); buf = []; }
    }
    if (buf.length) fs.writeSync(fd, buf.join('\n') + '\n');
  }
  fs.closeSync(fd);
  const gamesOut = [...seen].map((id) => {
    const g = games.get(id)!;
    const q = g.game.quests;
    const blue = q.filter((x) => !x.failed).length;
    return {
      id, date: g.date, source: g.source, tableS: g.s, tier: opponentOf(g),
      roles: g.game.seatRoles,
      missions: q.map((x) => (x.failed ? 'R' : 'B')).join(''),
      blueWins: blue, redWins: q.length - blue,
      assassinTargetSeat: g.game.assassinTargetSeat ?? null,
      lakes: g.game.lakes.length,
    };
  });
  fs.writeFileSync(path.join(a.out, 'games.json'), JSON.stringify({ meta, games: gamesOut }));
  console.error(`annotated ${n} decision points of ${seen.size} games → ${a.out}/spots.jsonl, games.json`);
}

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  if (a.mode === 'replay') { if (a.shard) runShard(a); else await replay(a); return; }
  await annotate(a);
}

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
