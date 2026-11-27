/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 官方 AI騎士 的學習樣本數（站長 2026-11-27：「可以標注在AI騎士旁邊說 學習樣本場次數有多少 依座位/腳色/任務結果/遊戲結果」）。
 * 新擬合的騎士由 `styleKnights.ts --write-knights` 直接寫；這支替已經在 `community-bots/_knights/` 的騎士補寫或重算 `samples`
 * （只有數字，沒有局號、名字；`src/arena/samples.ts`）。選座位的規則和 styleKnights.ts 同一套（selectPlayers：網站真人局、
 * 併過 player_aliases.json 的舊名、紀錄有問題的局不算）。
 *
 *   cd packages/server && npx tsx scripts/knightSamples.ts [--as 騎士名稱=玩家ID ...] [--check]
 *
 *   --as 名稱=ID   騎士名字和玩家 ID 不一樣時（擬合時用過 `--include ID=名稱`）：照這個對（對應只在指令裡，不寫進 repo）
 *   --check        只比對：有騎士的 samples 和算出來的不一樣就 exit 1
 *   --dataset/--game-db/--corrections/--aliases/--analysis  同 styleKnights.ts
 * 對不到玩家的騎士照原樣留著，印一行提醒。
 */
import * as fs from 'fs';
import * as path from 'path';
import { formatKnightProfile } from '../src/arena/styleKnights';
import { knightBaseName } from '../src/arena/knights';
import { validateProfile, type BotProfile } from '../src/arena/profile';
import { samplesFromSeats } from '../src/arena/samples';
import { parseArgs, selectPlayers, type Dataset } from './styleKnights';

const REPO = path.resolve(__dirname, '..', '..', '..');
const KNIGHTS_DIR = path.join(REPO, 'community-bots', '_knights');
const PREFIX = 'AI騎士_';

function main(): void {
  const argv = process.argv.slice(2);
  const as = new Map<string, string>();
  const check = argv.includes('--check');
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--check') continue;
    if (argv[i] === '--as') {
      const [name, id] = String(argv[++i] ?? '').split('=');
      if (!name || !id) throw new Error('--as 要寫成 名稱=玩家ID');
      as.set(name, id);
      continue;
    }
    rest.push(argv[i]);
  }
  const folders = fs.readdirSync(KNIGHTS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  const knights = folders.map((folder) => {
    const file = path.join(KNIGHTS_DIR, folder, 'profile.json');
    const profile = JSON.parse(fs.readFileSync(file, 'utf8')) as BotProfile;
    const style = knightBaseName(profile.name).slice(PREFIX.length);
    return { folder, file, profile, player: as.get(style) ?? style };
  });
  // 每位騎士的玩家都當成 --include（不管場數門檻）；強者分面不用。
  const a = { ...parseArgs(rest), minGames: Number.MAX_SAFE_INTEGER, strongTop: 0 };
  a.include = knights.map((k) => ({ player: k.player, as: k.player }));
  const ds = JSON.parse(fs.readFileSync(a.dataset, 'utf8')) as Dataset;
  const sel = selectPlayers(a, ds);
  let changed = 0;
  for (const k of knights) {
    const pi = sel.selected.findIndex((p) => p.id === k.player);
    if (pi < 0) { console.log(`- ${k.folder}：資料裡對不到這位騎士的玩家，samples 不動`); continue; }
    const samples = samplesFromSeats(
      sel.jobs.filter((j) => j[2] === pi).map((j) => ({ game: sel.replayable.get(j[0])!, seat: j[1] })),
      sel.selected[pi].games,
    );
    if (JSON.stringify(k.profile.samples ?? null) === JSON.stringify(samples)) continue;
    changed++;
    if (check) { console.log(`✗ ${k.folder}：samples 和資料算出來的不一樣`); continue; }
    const v = validateProfile({ ...k.profile, samples }, k.folder, { house: true });
    if (!v.ok) throw new Error(`${k.folder}: ${v.errors.join('; ')}`);
    fs.writeFileSync(k.file, formatKnightProfile({ ...k.profile, samples }));
    console.log(`✓ ${k.folder}：${samples.games} 場、可學的座位 ${samples.seats} 個`);
  }
  if (check && changed) process.exit(1);
  console.log(check ? '✓ samples 都和資料一樣' : `改了 ${changed} 位騎士；改完跑 pnpm --filter @avalon/server knights:generate`);
}

main();
