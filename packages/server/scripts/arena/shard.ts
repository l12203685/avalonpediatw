/* eslint-disable no-console -- CLI helper */
/**
 * AI 擂台的 CLI 共用：把 N 局分給幾個子行程跑（`--workers`），結果跟只用一個行程完全一樣
 * （每局的座位、角色、亂數只由 (seed, 局號) 決定）。子行程是同一支腳本加上 `--shard i/k --shard-out 檔案`。
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

interface Shard { index: number; count: number; out: string }

function readShard(argv: readonly string[]): Shard | null {
  const i = argv.indexOf('--shard');
  const o = argv.indexOf('--shard-out');
  if (i < 0 || o < 0) return null;
  const [index, count] = String(argv[i + 1]).split('/').map(Number);
  return { index, count, out: String(argv[o + 1]) };
}

/** 去掉 `--shard`、`--shard-out` 兩組參數（給腳本自己的參數解析用）。 */
export function stripShardArgs(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--shard' || argv[i] === '--shard-out') { i++; continue; }
    out.push(argv[i]);
  }
  return out;
}

export function defaultWorkers(): number {
  return Math.max(1, Math.min(2, os.cpus().length - 1));
}

/**
 * 跑第 0..n-1 局，回傳依局號排好的結果。在子行程裡呼叫時只跑自己那一份、寫檔後結束行程（不會回傳）。
 */
export async function runSharded<T>(n: number, play: (i: number) => Promise<T>, workers: number, label: string): Promise<T[]> {
  const shard = readShard(process.argv);
  const started = Date.now();
  const runRange = async (indices: number[]): Promise<Map<number, T>> => {
    const out = new Map<number, T>();
    let done = 0;
    for (const i of indices) {
      out.set(i, await play(i));
      done++;
      if (done % 50 === 0 || done === indices.length) {
        process.stderr.write(`[${label}${shard ? ` ${shard.index + 1}/${shard.count}` : ''}] ${done}/${indices.length}, ${((Date.now() - started) / 1000).toFixed(0)}s\n`);
      }
    }
    return out;
  };
  if (shard) {
    const mine = Array.from({ length: n }, (_, i) => i).filter((i) => i % shard.count === shard.index);
    const res = await runRange(mine);
    fs.writeFileSync(shard.out, JSON.stringify([...res.entries()]));
    process.exit(0);
  }
  const all = Array.from({ length: n }, (_, i) => i);
  if (workers <= 1 || n < 2) {
    const res = await runRange(all);
    return all.map((i) => res.get(i)!);
  }
  const k = Math.min(workers, n);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-'));
  const files = Array.from({ length: k }, (_, w) => path.join(dir, `shard-${w}.json`));
  const script = process.argv[1];
  const args = stripShardArgs(process.argv.slice(2));
  await Promise.all(files.map((file, w) => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [...process.execArgv, script, ...args, '--shard', `${w}/${k}`, '--shard-out', file], {
      stdio: ['ignore', 'ignore', 'inherit'],
      env: process.env,
    });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${label}: worker ${w + 1}/${k} exited with ${code}`))));
  })));
  const merged = new Map<number, T>();
  for (const file of files) {
    for (const [i, v] of JSON.parse(fs.readFileSync(file, 'utf8')) as [number, T][]) merged.set(i, v);
    fs.unlinkSync(file);
  }
  fs.rmdirSync(dir);
  return all.map((i) => {
    const v = merged.get(i);
    if (v === undefined) throw new Error(`${label}: game ${i} missing from the workers' output`);
    return v;
  });
}
