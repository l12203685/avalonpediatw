/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * AI 擂台：所有登記的機器人一起打，產生排行榜（arena/leaderboard.json）。
 *
 *   pnpm --filter @avalon/server arena:tournament [--games N] [--players 10|5-10] [--seed S] [--workers 2]
 *        [--extra profiles.json] [--no-examples] [--out ../../arena/leaderboard.json]
 *
 * 參賽：百科AI（參考點，1500 分）＋ community-bots/_examples 的示範對手 ＋ community-bots/<id>/ 的社群機器人
 * ＋ `--extra` 外部清單（格式 {"profiles":[{"id","title","profile"}]}，例如之後網站上的「代理騎士」）。
 * 每局隨機人數（`--players`）、每個座位隨機抽一隻（可重複），所以每隻都會坐到紅藍兩邊、和各種隊友同桌。
 * 預設局數 = max(600, 150 × 參賽數)。只跑百科AI 的引擎與 profile 開關，不執行任何社群程式碼。
 */
import * as fs from 'fs';
import * as path from 'path';
import { SelfPlayEngine } from '../src/ai/SelfPlayEngine';
import { loadRoster, parseExtraProfiles, type RegisteredBot } from '../src/arena/registry';
import { buildLeaderboard, parseSizes, tournamentSeating } from '../src/arena/report';
import { playTable, quietly, type Entrant, type TableResult } from '../src/arena/table';
import { defaultWorkers, runSharded, stripShardArgs } from './arena/shard';

const REPO_ROOT = path.resolve(__dirname, '../../..');

async function main(): Promise<void> {
  const argv = stripShardArgs(process.argv.slice(2));
  let games: number | undefined;
  let sizes = [10];
  let seed = `arena-${new Date().toISOString().slice(0, 10)}`;
  let workers = defaultWorkers();
  let extraFile: string | undefined;
  let includeExamples = true;
  let out = path.join(REPO_ROOT, 'arena', 'leaderboard.json');
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => { const v = argv[++i]; if (v === undefined) throw new Error(`${a} 需要一個值`); return v; };
    switch (a) {
      case '--games': games = Number.parseInt(next(), 10); break;
      case '--players': sizes = parseSizes(next()); break;
      case '--seed': seed = next(); break;
      case '--workers': workers = Number.parseInt(next(), 10); break;
      case '--extra': extraFile = next(); break;
      case '--no-examples': includeExamples = false; break;
      case '--out': out = path.resolve(process.env.INIT_CWD ?? process.cwd(), next()); break;
      case '--help': case '-h': console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]); return;
      default: throw new Error(`不認得的參數 ${a}`);
    }
  }
  let extra: RegisteredBot[] = [];
  const extraRejected: { id: string; errors: string[] }[] = [];
  if (extraFile) {
    const parsed = parseExtraProfiles(JSON.parse(fs.readFileSync(path.resolve(process.env.INIT_CWD ?? process.cwd(), extraFile), 'utf8')));
    extra = parsed.bots;
    extraRejected.push(...parsed.rejected);
  }
  const roster = loadRoster({ extra, includeExamples });
  const ids = roster.bots.map((b) => b.id);
  const n = games ?? Math.max(600, 150 * ids.length);
  if (!Number.isFinite(n) || n <= 0) throw new Error('--games 要是正整數');
  const entrants = new Map<string, Entrant>(roster.bots.map((b) => [b.id, { id: b.id, profile: b.profile }]));
  // 只在主行程印（子行程的 stdout 被丟掉）。
  console.log(`參賽 ${ids.length} 隻：${roster.bots.map((b) => b.profile?.name ?? '百科AI').join('、')}；${n} 局；人數 ${sizes.join('/')}；seed ${seed}`);
  for (const r of [...roster.rejected, ...extraRejected]) console.log(`未收：${r.id}：${r.errors.join('；')}`);
  const engine = new SelfPlayEngine();
  const tables = await runSharded<TableResult>(n, (i) => quietly(async () => {
    const { seats } = tournamentSeating(seed, i, ids, sizes);
    return playTable(engine, seats.map((id) => entrants.get(id)!), `${seed}|${i}`);
  }), workers, 'arena:tournament');
  const board = buildLeaderboard({
    bots: roster.bots,
    tables,
    seed,
    sizes,
    generatedAt: new Date().toISOString(),
    // 社群資料夾沒收的只列 id 與原因（外部清單的不公開）。
    rejected: roster.rejected,
  });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(board, null, 2)}\n`);
  console.log('');
  console.log('| 名次 | 機器人 | 總分 [95%] | 紅方分 | 藍方分 | 紅方勝率 | 藍方勝率 | 座位數 |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const b of board.bots) {
    const r = b.rating;
    console.log(`| ${b.rank} | ${b.name}${b.author ? `（${b.author}）` : ''} | ${r.overall.rating.toFixed(0)} [${r.overall.low.toFixed(0)}, ${r.overall.high.toFixed(0)}] | ${r.red.rating.toFixed(0)} | ${r.blue.rating.toFixed(0)} | ${(b.red.winRate * 100).toFixed(1)}% | ${(b.blue.winRate * 100).toFixed(1)}% | ${b.seats} |`);
  }
  console.log(`\n寫入 ${out}`);
}

main().then(() => process.exit(0), (err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
