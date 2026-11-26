/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * AI 擂台：檢查機器人資料夾（格式、開關白名單、範圍、名字規則）。
 *
 *   pnpm --filter @avalon/server arena:check ../../community-bots/my-bot
 *   pnpm --filter @avalon/server arena:check --all            # 整個名冊（含「名字不重複」「一人一隻」）
 *   pnpm --filter @avalon/server arena:check --all --pr-author <GitHub 帳號> 資料夾...
 *
 * 路徑可以是相對於目前目錄或 repo 根目錄。有錯就 exit 1；在 GitHub Actions 裡另印 ::error 註記。
 * `--pr-author`：PR 作者和 profile.json 的 author 不同時印警告（不擋）。
 */
import * as fs from 'fs';
import * as path from 'path';
import { checkBotFolder, defaultCommunityDir, loadRoster } from '../src/arena/registry';

const REPO_ROOT = path.resolve(__dirname, '../../..');

function resolveFolder(p: string): string {
  const candidates = [path.resolve(p), path.resolve(REPO_ROOT, p), path.resolve(process.env.INIT_CWD ?? process.cwd(), p)];
  return candidates.find((c) => fs.existsSync(c)) ?? candidates[0];
}

function annotate(level: 'error' | 'warning', file: string, msg: string): void {
  if (process.env.GITHUB_ACTIONS === 'true') {
    const rel = path.relative(REPO_ROOT, file).split(path.sep).join('/');
    console.log(`::${level} file=${rel}::${msg.replace(/\r?\n/g, ' ')}`);
  }
}

function main(): number {
  const argv = process.argv.slice(2);
  let all = false;
  let prAuthor: string | undefined;
  const folders: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') all = true;
    else if (a === '--pr-author') prAuthor = argv[++i];
    else if (a === '--help' || a === '-h') { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]); return 0; }
    else folders.push(a);
  }
  if (!all && folders.length === 0) {
    console.log('用法：arena:check <機器人資料夾> [...]  或  arena:check --all');
    return 2;
  }
  let failed = 0;
  for (const f of folders) {
    const folder = resolveFolder(f);
    const c = checkBotFolder(folder);
    const file = path.join(folder, 'profile.json');
    if (c.ok) console.log(`✓ ${c.id}${c.profile ? `：「${c.profile.name}」（作者 ${c.profile.author}）` : ''}`);
    else { failed++; console.log(`✗ ${c.id}`); }
    for (const e of c.errors) { console.log(`  錯誤：${e}`); annotate('error', file, e); }
    for (const w of c.warnings) { console.log(`  提醒：${w}`); annotate('warning', file, w); }
    if (prAuthor && c.profile && !c.id.startsWith('_') && c.profile.author.toLowerCase() !== prAuthor.toLowerCase()) {
      const msg = `author「${c.profile.author}」和開 PR 的帳號「${prAuthor}」不同；請確認這是你本人公開的帳號`;
      console.log(`  提醒：${msg}`);
      annotate('warning', file, msg);
    }
  }
  if (all) {
    const dir = defaultCommunityDir();
    const roster = loadRoster({ dir });
    const community = roster.bots.filter((b) => b.source === 'community');
    const examples = roster.bots.filter((b) => b.source === 'example');
    console.log(`名冊：${community.length} 隻社群機器人、${examples.length} 隻示範對手、百科AI 1 隻`);
    for (const r of roster.rejected) {
      failed++;
      console.log(`✗ ${r.id}`);
      for (const e of r.errors) {
        console.log(`  錯誤：${e}`);
        annotate('error', path.join(dir, r.id, 'profile.json'), e);
      }
    }
  }
  console.log(failed === 0 ? '全部通過。' : `${failed} 個有錯。`);
  return failed === 0 ? 0 : 1;
}

process.exit(main());
