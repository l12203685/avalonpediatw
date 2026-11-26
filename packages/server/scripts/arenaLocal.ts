/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * AI 擂台：在自己電腦上試你的機器人。
 *
 *   pnpm --filter @avalon/server arena:local ../../community-bots/my-bot [--games 300] [--players 10|5-10]
 *        [--bot-seats N] [--workers 2] [--seed arena-local] [--json out.json]
 *
 * 每一局：你的機器人坐一半的座位（隨機；`--bot-seats` 可改），其他座位是百科AI，所以紅藍兩邊都會坐到、隊友有時是百科AI。
 * 同一局再打一次「全部百科AI」當對照（同樣座位、角色、共同亂數），印出：
 *   - 你坐紅方／藍方時那一邊的勝率，對照百科AI，和成對差（百分點、95% 區間）
 *   - 分角色的勝率
 *   - 三種結局的比例：三紅（任務失敗三次）、三藍刺中（刺客刺中梅林）、三藍活（藍方贏）
 *   - 你當刺客時的刺中率
 * 預設 300 局 × 2（含對照）；單核大約每局 0.3–1 秒。
 */
import * as fs from 'fs';
import * as path from 'path';
import { SelfPlayEngine } from '../src/ai/SelfPlayEngine';
import { checkBotFolder, REFERENCE_ID } from '../src/arena/registry';
import { localBotMask, localPlayerCount, localReport, parseSizes, type LocalPair, type LocalReport, type PairedStat } from '../src/arena/report';
import { playTable, quietly, type Entrant } from '../src/arena/table';
import { defaultWorkers, runSharded, stripShardArgs } from './arena/shard';

const REPO_ROOT = path.resolve(__dirname, '../../..');

const ROLE_ZH: Record<string, string> = {
  merlin: '梅林', percival: '派西維爾', loyal: '忠臣', assassin: '刺客', morgana: '莫甘娜', mordred: '莫德雷德', oberon: '奧伯倫',
};


const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const pp = (d: { mean: number; low: number; high: number }): string =>
  `${d.mean >= 0 ? '+' : ''}${(d.mean * 100).toFixed(1)}pp [${(d.low * 100).toFixed(1)}, ${(d.high * 100).toFixed(1)}]`;

function line(label: string, s: PairedStat): string {
  if (s.games === 0) return `${label}：沒有坐到`;
  return `${label}：${pct(s.bot.rate)}（百科AI ${pct(s.control.rate)}）差 ${pp(s.diff)}，${s.games} 局`;
}

export function formatLocalReport(r: LocalReport, name: string): string {
  const out: string[] = [];
  out.push(`「${name}」對百科AI，${r.games} 局（另有同樣 ${r.games} 局全部百科AI 當對照）`);
  out.push('');
  out.push('陣營（你坐這一邊時，這一邊的勝率）');
  out.push(`  ${line('紅方', r.sides.evil)}`);
  out.push(`  ${line('藍方', r.sides.good)}`);
  out.push('');
  out.push('角色');
  for (const [role, s] of Object.entries(r.roles)) out.push(`  ${line(ROLE_ZH[role] ?? role, s)}`);
  out.push('');
  out.push('三種結局（全部局）');
  const o = r.outcomes;
  out.push(`  你的桌：三紅 ${pct(o.bot.threeRed)}／三藍刺中 ${pct(o.bot.merlinKilled)}／三藍活 ${pct(o.bot.threeBlue)}`);
  out.push(`  對照桌：三紅 ${pct(o.control.threeRed)}／三藍刺中 ${pct(o.control.merlinKilled)}／三藍活 ${pct(o.control.threeBlue)}`);
  out.push('');
  const a = r.assassin;
  out.push(a.bot.n === 0
    ? '刺殺：你沒有出手刺殺過'
    : `刺殺：你出手 ${a.bot.n} 次、刺中 ${pct(a.bot.rate)}（同座位的百科AI ${a.control.n} 次、刺中 ${pct(a.control.rate)}）`);
  out.push('');
  out.push('差的區間跨過 0 = 還看不出比百科AI 好或差；想更準就加 --games。');
  return out.join('\n');
}

async function main(): Promise<void> {
  const argv = stripShardArgs(process.argv.slice(2));
  let folder: string | undefined;
  let games = 300;
  let sizes = [10];
  let botSeats: number | undefined;
  let workers = defaultWorkers();
  let seed = 'arena-local';
  let json: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => { const v = argv[++i]; if (v === undefined) throw new Error(`${a} 需要一個值`); return v; };
    switch (a) {
      case '--games': games = Number.parseInt(next(), 10); break;
      case '--players': sizes = parseSizes(next()); break;
      case '--bot-seats': botSeats = Number.parseInt(next(), 10); break;
      case '--workers': workers = Number.parseInt(next(), 10); break;
      case '--seed': seed = next(); break;
      case '--json': json = next(); break;
      case '--help': case '-h': console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]); return;
      default:
        if (a.startsWith('--')) throw new Error(`不認得的參數 ${a}`);
        folder = a;
    }
  }
  if (!folder) throw new Error('用法：arena:local <機器人資料夾> [--games 300]');
  if (!Number.isFinite(games) || games <= 0) throw new Error('--games 要是正整數');
  const resolved = [path.resolve(folder), path.resolve(REPO_ROOT, folder), path.resolve(process.env.INIT_CWD ?? process.cwd(), folder)]
    .find((c) => fs.existsSync(c)) ?? path.resolve(folder);
  const check = checkBotFolder(resolved);
  if (!check.ok || !check.profile) {
    console.error(`✗ ${check.id} 沒通過檢查：\n  ${check.errors.join('\n  ')}`);
    process.exit(1);
  }
  const botId = check.id.startsWith('_') ? 'my-bot' : check.id;
  const bot: Entrant = { id: botId, profile: check.profile };
  const baike: Entrant = { id: REFERENCE_ID, profile: null };
  const engine = new SelfPlayEngine();
  const pairs = await runSharded<LocalPair>(games, (i) => quietly(async () => {
    const n = localPlayerCount(sizes, i);
    const mask = localBotMask(seed, i, n, botSeats);
    const gameSeed = `${seed}|${i}`;
    const botTable = await playTable(engine, mask.map((m) => (m ? bot : baike)), gameSeed);
    const control = await playTable(engine, mask.map(() => baike), gameSeed);
    return { bot: botTable, control };
  }), workers, 'arena:local');
  const report = localReport(pairs, botId);
  console.log(formatLocalReport(report, check.profile.name));
  if (json) {
    fs.writeFileSync(path.resolve(json), JSON.stringify({ seed, sizes, report }, null, 2));
    console.log(`寫入 ${path.resolve(json)}`);
  }
}

main().then(() => process.exit(0), (err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
