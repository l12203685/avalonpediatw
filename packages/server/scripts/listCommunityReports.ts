/**
 * 每日例行作業：列出 DC 同步閒聊裡 bot 發的【ID認領】／【百科回報…】與處理狀態（src/services/communityReportsList.ts）。
 * 只在本機跑（輸出有暱稱，不要放進 GitHub Actions 或任何公開 log）。
 *
 *   DISCORD_BOT_TOKEN=… ADMIN_DISCORD_IDS=… pnpm --filter @avalon/server exec tsx scripts/listCommunityReports.ts [--days 7] [--channel ID]
 *   … scripts/listCommunityReports.ts --mark-merged <訊息 id>       把那則【ID認領】改成結尾「（已合併）」
 *   … scripts/listCommunityReports.ts --mark-processed <訊息 id>    把那則【百科回報】改成結尾「（已處理）」
 *
 * stdout：JSON（列表，或 {"messageId": …, "result": "edited|already|not_found|failed"}）；stderr：只有數量與狀態碼。
 * 頻道預設 COMMUNITY_REPORT_DISCORD_CHANNEL_ID ＞ LOBBY_MIRROR_DISCORD_CHANNEL_ID ＞ #同步閒聊。
 * 核准＝群組擁有者或 ADMIN_DISCORD_IDS（逗號或空白隔開的 Discord 使用者 id）在【ID認領】那則按 ✅。
 */
import { listCommunityItems, markCommunityItem, parseAdminIds } from '../src/services/communityReportsList';

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
  const channelId = arg('--channel');
  const merged = arg('--mark-merged');
  const processed = arg('--mark-processed');
  const target = merged ?? processed;
  if (target !== undefined) {
    if (!/^\d{15,22}$/.test(target)) {
      console.error('訊息 id 要是數字');
      return 2;
    }
    const result = await markCommunityItem({ token, channelId, messageId: target, mark: merged ? 'merged' : 'processed' });
    process.stdout.write(`${JSON.stringify({ messageId: target, result })}\n`);
    return result === 'edited' || result === 'already' ? 0 : 1;
  }
  const days = Number(arg('--days') ?? '7');
  if (!Number.isFinite(days) || days <= 0 || days > 90) {
    console.error('--days 要是 1–90');
    return 2;
  }
  const listing = await listCommunityItems({ token, channelId, days, adminIds: parseAdminIds(process.env.ADMIN_DISCORD_IDS) });
  process.stdout.write(`${JSON.stringify(listing, null, 2)}\n`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : 'error');
    process.exit(1);
  },
);
