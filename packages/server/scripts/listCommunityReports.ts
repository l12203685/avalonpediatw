/**
 * 每日例行作業：列出 DC 同步閒聊裡 bot 發的【ID認領】／【百科回報…】與處理狀態（src/services/communityReportsList.ts）。
 * 只在本機跑（輸出有暱稱，不要放進 GitHub Actions 或任何公開 log）。
 *
 *   DISCORD_BOT_TOKEN=… ADMIN_DISCORD_IDS=… pnpm --filter @avalon/server exec tsx scripts/listCommunityReports.ts [--days 7] [--channel ID]
 *   … scripts/listCommunityReports.ts --mark-merged <訊息 id>       把那則【ID認領】改成結尾「（已合併）」
 *   … scripts/listCommunityReports.ts --mark-processed <訊息 id>    把那則【百科回報】改成結尾「（已處理）」
 *   … scripts/listCommunityReports.ts --mark-processed <訊息 id> --note "已修正：…" --link https://github.com/…/pull/N
 *   … scripts/listCommunityReports.ts --mark-processed <訊息 id> --status 不處理 --note "原因…"
 *       那則【百科回報】最後換上狀態行「【處理・已修正】說明｜<網址>（已處理）」（src/services/reportStatus.ts），
 *       網站「回報與修正」頁（#reports）會顯示狀態、說明與連結。--status 預設 已修正；也可以 處理中、收到、隱藏（不上網站）。
 *
 * stdout：JSON（列表，或 {"messageId": …, "result": "edited|already|not_found|failed|too_long"}）；stderr：只有數量與狀態碼。
 * 頻道預設 COMMUNITY_REPORT_DISCORD_CHANNEL_ID ＞ LOBBY_MIRROR_DISCORD_CHANNEL_ID ＞ #同步閒聊。
 * 核准＝群組擁有者或 ADMIN_DISCORD_IDS（逗號或空白隔開的 Discord 使用者 id）在【ID認領】那則按 ✅。
 */
import { listCommunityItems, markCommunityItem, parseAdminIds, parseCliArgs } from '../src/services/communityReportsList';

async function main(): Promise<number> {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.cmd === 'error') {
    console.error(args.message);
    return 2;
  }
  const token = (process.env.DISCORD_BOT_TOKEN ?? '').trim();
  if (!token) {
    console.error('需要 DISCORD_BOT_TOKEN');
    return 2;
  }
  if (args.cmd === 'mark') {
    const result = await markCommunityItem({ token, channelId: args.channelId, messageId: args.messageId, mark: args.mark, status: args.status });
    process.stdout.write(`${JSON.stringify({ messageId: args.messageId, result, ...(args.status ? { status: args.status.status } : {}) })}\n`);
    return result === 'edited' || result === 'already' ? 0 : 1;
  }
  const listing = await listCommunityItems({ token, channelId: args.channelId, days: args.days, adminIds: parseAdminIds(process.env.ADMIN_DISCORD_IDS) });
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
