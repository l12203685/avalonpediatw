/**
 * 每日例行作業：讀「阿瓦隆百科小觀念」的回饋（bot 貼在管理員頻道的【觀念卡回饋】），處理完標記（src/services/conceptFeedbackList.ts）。
 * 只在本機跑：輸出有群友打的原文，不要放進 GitHub Actions、公開 log、issue 或 repo。
 *
 *   DISCORD_BOT_TOKEN=… pnpm --filter @avalon/server exec tsx scripts/conceptFeedback.ts list --since 2026-11-18T00:00:00+08:00 [--all] [--channel ID]
 *   DISCORD_BOT_TOKEN=… pnpm --filter @avalon/server exec tsx scripts/conceptFeedback.ts mark <訊息 id> [<訊息 id> …] [--channel ID]
 *
 * list：stdout 是 JSON {channelId, since, items: [{messageId, cardId, date, platform, groupHash, userHash, createdAt, text, handled}]}，
 *       預設只列沒處理的（--all 連已處理的也列）。
 * mark：把那幾則改成第一行結尾加「（已處理）」；stdout 每一則一行 {"messageId": …, "result": "edited|already|not_found|failed"}。
 * 頻道預設 FEEDBACK_DISCORD_CHANNEL_ID（沒設就是「大劍管理員」）。stderr 只有數量與狀態碼。
 */
import { listConceptFeedback, markConceptFeedback } from '../src/services/conceptFeedbackList';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const token = (process.env.DISCORD_BOT_TOKEN ?? '').trim();
  if (!token) {
    console.error('需要 DISCORD_BOT_TOKEN');
    return 2;
  }
  const [cmd, ...rest] = process.argv.slice(2);
  const channelId = arg('--channel');
  if (cmd === 'list') {
    const since = arg('--since');
    if (!since) {
      console.error('需要 --since，例如 --since 2026-11-18T00:00:00+08:00');
      return 2;
    }
    const listing = await listConceptFeedback({ token, channelId, since, includeHandled: process.argv.includes('--all') });
    process.stdout.write(`${JSON.stringify(listing, null, 2)}\n`);
    console.error(`觀念卡回饋 ${listing.items.length} 則（${listing.items.filter((i) => i.handled).length} 則已處理）`);
    return 0;
  }
  if (cmd === 'mark') {
    const ids = rest.filter((x, i) => /^\d{15,22}$/.test(x) && rest[i - 1] !== '--channel');
    if (ids.length === 0) {
      console.error('mark 後面要接訊息 id（數字）');
      return 2;
    }
    let bad = 0;
    for (const messageId of ids) {
      const result = await markConceptFeedback({ token, channelId, messageId });
      if (result !== 'edited' && result !== 'already') bad += 1;
      process.stdout.write(`${JSON.stringify({ messageId, result })}\n`);
    }
    return bad ? 1 : 0;
  }
  console.error('用法：conceptFeedback.ts list --since <ISO 時間> [--all] | mark <訊息 id> …');
  return 2;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : 'error');
    process.exit(1);
  },
);
