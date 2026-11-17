/**
 * 機器人的說明（Edward 2026-11-17：「我覺得機器人最基本的說明就是 /help 剩下可以再靠後面打指令細查 比如 /help 模擬 這樣」）。
 *
 *   /help            最基本的說明：每個功能一行，最後一行「/help 主題 看細節」
 *   /help 模擬       模擬瓦的全部指令（同 /模擬 說明）
 *   /help 戰績       /戰績 /排行 /默契
 *   /help 補位｜待修正｜回報｜更正｜意見
 *
 * LINE 打字：/help（全形斜線「／」也可以，主題前的空白可有可無）；舊的 /指令 照舊回完整的指令清單（stats/statsReplies.formatStatsHelp）。
 * Discord：slash /help 主題:模擬（選項，見 discord/client.ts）。
 * 看不懂的主題就回最基本的說明。純函式（範圍文字 scope 由呼叫的人讀快取後傳進來）。
 */

import { CLAIM_HELP_TEXT, CLAIM_USAGE, REPORT_HELP_TEXT, REPORT_USAGE } from './reports/commands';
import { CORRECTION_HELP_TEXT, CORRECTION_USAGE } from './recordCorrection/commands';
import { PAIPU_FIX_HELP_TEXT, PAIPU_FIX_USAGE } from './paipuFix/commands';
import { SEAT_FILLER_HELP_TEXT, SEAT_FILLER_LIMITS_TEXT, SEAT_FILLER_USAGE } from './seatFiller/commands';
import { SIM_CONFIG } from './simulation/config';
import { simHelpText } from './simulation/replies';
import { STATS_COMMAND_USAGE, STATS_PAGE_URL_TEXT } from './stats/statsReplies';

export type HelpPlatform = 'line' | 'discord';

export const HELP_TOPICS = ['模擬', '戰績', '補位', '待修正', '回報', '更正', '意見'] as const;
export type HelpTopic = (typeof HELP_TOPICS)[number];

/** 主題的別名（打法不同、同一個主題）。 */
const TOPIC_ALIASES: Readonly<Record<string, HelpTopic>> = {
  模擬: '模擬', 模擬瓦: '模擬', 模拟: '模擬', 模拟瓦: '模擬', sim: '模擬',
  戰績: '戰績', 战绩: '戰績', 排行: '戰績', 排行榜: '戰績', 默契: '戰績', stats: '戰績',
  補位: '補位', 机器人补位: '補位', 機器人補位: '補位', 补位: '補位',
  待修正: '待修正',
  更正: '更正', 牌譜更正: '更正', 牌谱更正: '更正',
  回報: '回報', 回报: '回報', 認領: '回報', 认领: '回報',
  意見: '意見', 意见: '意見',
};

/** 主題字 → 主題；看不懂 → null。 */
export function helpTopicOf(word: string): HelpTopic | null {
  const w = word.normalize('NFKC').trim().toLowerCase();
  return TOPIC_ALIASES[w] ?? null;
}

const HELP_RE = /^[/／]\s*help(?![a-z])(.*)$/isu;

/** /help、/help 模擬 → { topic }（topic 沒寫或看不懂是 null）；不是說明指令 → null。 */
export function parseHelpCommand(text: string): { topic: HelpTopic | null; raw: string } | null {
  const m = HELP_RE.exec((text ?? '').normalize('NFKC').trim());
  if (!m) return null;
  const raw = m[1].trim();
  return { topic: raw ? helpTopicOf(raw) : null, raw };
}

/** 最基本的說明：每個功能一行。 */
export function basicHelpText(platform: HelpPlatform): string {
  const helpCmd = platform === 'discord' ? '/help 主題:模擬' : '/help 模擬';
  const lines = ['📖 阿瓦隆百科機器人'];
  if (SIM_CONFIG.commandsEnabled) lines.push('/模擬\u3000模擬瓦：真人牌譜停在派票的當下，換你派');
  lines.push(`${STATS_COMMAND_USAGE.player}\u3000個人戰績（還有 /排行 /默契）`);
  lines.push(`${SEAT_FILLER_USAGE[platform]}\u3000叫百科AI 進房補位`);
  lines.push(`${PAIPU_FIX_USAGE[platform]}\u3000待修正的牌譜（${CORRECTION_USAGE[platform]} 查一局、送更正）`);
  lines.push(`${REPORT_USAGE[platform]}\u3000回報網站或文章的問題（${CLAIM_USAGE[platform]} 合併 ID）`);
  lines.push(`${STATS_COMMAND_USAGE.feedback}\u3000給管理者的建議`);
  lines.push(`/help 主題 看細節（例：${helpCmd}）`);
  return lines.join('\n');
}

/** 一個主題的細節。`scope` = /排行 的範圍文字（讀不到就 null）。 */
export function topicHelpText(topic: HelpTopic, platform: HelpPlatform, scope: string | null = null): string {
  switch (topic) {
    case '模擬':
      return SIM_CONFIG.commandsEnabled ? simHelpText(platform) : '模擬瓦目前沒有開放。';
    case '戰績':
      return [
        '📊 戰績',
        `${STATS_COMMAND_USAGE.player}\u3000個人戰績（名字可打一部分）`,
        `${STATS_COMMAND_USAGE.leaderboard}\u3000角色理論勝率排行 Top 10${scope ? `（${scope}）` : ''}`,
        `${STATS_COMMAND_USAGE.chemistry}\u3000兩人同隊默契`,
        '每週一 12:00 會自動貼出本週排行。',
        STATS_PAGE_URL_TEXT,
      ].join('\n');
    case '補位':
      return [`🤖 ${SEAT_FILLER_USAGE[platform]}`, SEAT_FILLER_HELP_TEXT, SEAT_FILLER_LIMITS_TEXT].join('\n');
    case '待修正':
      return `📝 ${PAIPU_FIX_USAGE[platform]}\u3000${PAIPU_FIX_HELP_TEXT}（每天凌晨匯入讀不懂的貼文）`;
    case '回報':
      return [`📮 ${REPORT_USAGE[platform]}\u3000${REPORT_HELP_TEXT}`, `${CLAIM_USAGE[platform]}\u3000${CLAIM_HELP_TEXT}`].join('\n');
    case '更正':
      return [
        `✏️ ${CORRECTION_USAGE[platform]}\u3000${CORRECTION_HELP_TEXT}`,
        platform === 'line'
          ? '只打局號：這局的文字牌譜、1家…0家、檢查出來的問題、網站連結。後面加內容（可以多行，整份改好的牌譜或「第一局是 158」）＝送給站長，確認後才會改。'
          : '只填局號：這局的文字牌譜、1家…0家、檢查出來的問題、網站連結。填了內容（例：第一局是 158）＝送給站長，確認後才會改。',
        '局號在網站牌譜頁的網址 #records= 後面（S…、M…、或 DC 貼文 id）。',
      ].join('\n');
    case '意見':
      return `💬 ${STATS_COMMAND_USAGE.feedback}\u3000給管理者的建議或回報問題（只有管理者看得到）`;
  }
}

/** /help［主題］的回覆：主題看不懂或沒寫 → 最基本的說明。 */
export function helpText(topic: HelpTopic | null, platform: HelpPlatform, scope: string | null = null): string {
  return topic ? topicHelpText(topic, platform, scope) : basicHelpText(platform);
}
