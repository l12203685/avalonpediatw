/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 官方 AI騎士 名冊 → 伺服器內建的一份 JSON（`src/arena/knights.generated.json`）。
 *
 *   pnpm --filter @avalon/server knights:generate            # 重寫那份 JSON
 *   pnpm --filter @avalon/server knights:generate --check    # 只比對：和資料夾不一樣就 exit 1（CI 用）
 *
 * 為什麼要另存一份：`community-bots/` 在 repo 最上層、不在 Render 的 buildFilter 裡，改了不會重新部署；
 * 練習台、房間裡「指定哪一位 AI騎士」要在正式機上讀得到，所以伺服器帶自己的一份。
 * 改 AI騎士（`community-bots/_knights/<id>/profile.json`）之後跑一次這支、一起提交：一位騎士的改動就是一次明確的伺服器改動。
 */
import * as fs from 'fs';
import * as path from 'path';
import { buildKnightsFile, GENERATED_KNIGHTS_PATH, serializeKnightsFile } from '../src/arena/knightsFile';

function main(): number {
  const check = process.argv.includes('--check');
  const { file, rejected } = buildKnightsFile();
  if (rejected.length > 0) {
    for (const r of rejected) console.log(`✗ ${r.id}：${r.errors.join('；')}`);
    console.log('有 AI騎士 的資料夾沒過檢查（先跑 arena:check --all）；沒過的不會寫進去。');
    return 1;
  }
  const text = serializeKnightsFile(file);
  const target = GENERATED_KNIGHTS_PATH;
  const rel = path.relative(path.resolve(__dirname, '../../..'), target).split(path.sep).join('/');
  if (check) {
    const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
    if (current !== text) {
      console.log(`✗ ${rel} 和 community-bots/_knights/ 不一樣：跑 pnpm --filter @avalon/server knights:generate 再一起提交。`);
      if (process.env.GITHUB_ACTIONS === 'true') console.log(`::error file=${rel}::和 community-bots/_knights/ 不一樣；跑 knights:generate 再提交`);
      return 1;
    }
    console.log(`✓ ${rel} 和資料夾一致（${file.knights.length} 位 AI騎士）`);
    return 0;
  }
  fs.writeFileSync(target, text);
  console.log(`✓ 寫好 ${rel}（${file.knights.length} 位 AI騎士）`);
  return 0;
}

process.exit(main());
