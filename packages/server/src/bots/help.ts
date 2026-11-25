/**
 * 機器人的說明（Edward 2026-11-17：「我覺得機器人最基本的說明就是 /help 剩下可以再靠後面打指令細查 比如 /help 模擬 這樣」）。
 *
 *   /help            最基本的說明：每個功能一行，最後一行「/help 主題 看細節」
 *   /help 模擬       模擬瓦的全部指令（同 /模擬 說明）
 *   /help 戰績       /戰績 /排行 /默契
 *   /help 補位｜待修正｜回報｜更正｜意見｜每日一題
 *   /help 規則｜角色  遊戲規則、角色介紹（bots/rules.ts）
 *   /說明［主題］    同 /help（2026-11-25：群組裡都打中文，/說明 跟 /help 一樣）
 *   /規則、/角色     同 /help 規則、/help 角色（2026-11-25 第二批：兩邊同一個打法；Discord 的 /rules、/roles 照舊可以用）
 *
 * LINE 打字：/help、/說明（全形斜線「／」也可以，主題前的空白可有可無）；舊的 /指令 照舊回完整的指令清單（stats/statsReplies.formatStatsHelp）。
 * Discord：slash /help 主題:模擬、/說明 主題:模擬（選項，見 discord/client.ts）；2026-11-25 起沒選主題時跟 LINE 回同一份
 * 「每個功能一行」的文字（之前是一大張中英夾雜的 embed）。
 * 看不懂的主題就回最基本的說明。純函式（範圍文字 scope 由呼叫的人讀快取後傳進來）。
 */

import { CLAIM_HELP_TEXT, CLAIM_USAGE, REPORT_HELP_TEXT, REPORT_USAGE } from './reports/commands';
import { CORRECTION_HELP_TEXT, CORRECTION_USAGE } from './recordCorrection/commands';
import { PAIPU_FIX_HELP_TEXT, PAIPU_FIX_USAGE } from './paipuFix/commands';
import { SEAT_FILLER_ALIAS_TEXT, SEAT_FILLER_HELP_TEXT, SEAT_FILLER_LIMITS_TEXT, SEAT_FILLER_USAGE } from './seatFiller/commands';
import { SIM_CONFIG } from './simulation/config';
import { simHelpText } from './simulation/replies';
import { STATS_COMMAND_USAGE, STATS_PAGE_URL_TEXT } from './stats/statsReplies';
import { DAILY_QUESTION_HELP_TEXT, DAILY_QUESTION_USAGE, DAILY_QUESTION_YESTERDAY_HELP_TEXT, DAILY_QUESTION_YESTERDAY_USAGE } from './dailyQuestion/usage';
import { RULES_USAGE, playPlatformLine, rolesText, rulesText } from './rules';

export type HelpPlatform = 'line' | 'discord';

export const HELP_TOPICS = ['模擬', '每日一題', '戰績', '補位', '待修正', '回報', '更正', '意見', '規則', '角色'] as const;
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
  每日一題: '每日一題', 今日一題: '每日一題', 每日一题: '每日一題', 今日一题: '每日一題', 一題: '每日一題',
  規則: '規則', 规则: '規則', rules: '規則',
  角色: '角色', 角色介紹: '角色', roles: '角色',
};

/** 主題字 → 主題；看不懂 → null。 */
export function helpTopicOf(word: string): HelpTopic | null {
  const w = word.normalize('NFKC').trim().toLowerCase();
  return TOPIC_ALIASES[w] ?? null;
}

const HELP_RE = /^[/／]\s*help(?![a-z])(.*)$/isu;
/** /說明（2026-11-25）：跟 /help 一樣。 */
const HELP_ZH_RE = /^[/／]\s*(?:說明|说明)(.*)$/su;
/**
 * /規則、/角色（2026-11-25 第二批）：整句只有這個指令才算，所以「/角色扮演」「/規則 是什麼」還是一般聊天。
 */
const RULES_ROLES_RE = /^[/／]\s*(規則|规则|角色|角色介紹|角色介绍)$/u;

/**
 * /help、/help 模擬、/說明、/說明 模擬 → { topic }（topic 沒寫或看不懂是 null）；不是說明指令 → null。
 * /說明 後面直接接字（沒有空白）時要是認得的主題才算（`/說明模擬` 算、`/說明書在哪` 是聊天）。
 * /規則、/角色 → 那個主題。
 */
export function parseHelpCommand(text: string): { topic: HelpTopic | null; raw: string } | null {
  const t = (text ?? '').normalize('NFKC').trim();
  const m = HELP_RE.exec(t);
  if (m) {
    const raw = m[1].trim();
    return { topic: raw ? helpTopicOf(raw) : null, raw };
  }
  const direct = RULES_ROLES_RE.exec(t);
  if (direct) return { topic: direct[1].startsWith('角色') ? '角色' : '規則', raw: direct[1] };
  const zh = HELP_ZH_RE.exec(t);
  if (!zh) return null;
  const raw = zh[1].trim();
  const topic = raw ? helpTopicOf(raw) : null;
  if (raw && !topic && !/^\s/u.test(zh[1])) return null;
  return { topic, raw };
}

/** 最基本的說明：每個功能一行。 */
export function basicHelpText(platform: HelpPlatform): string {
  const helpCmd = platform === 'discord' ? '/help 主題:模擬' : '/help 模擬';
  const lines = ['📖 阿瓦隆百科機器人'];
  if (SIM_CONFIG.commandsEnabled) lines.push('/模擬\u3000模擬瓦：真人牌譜停在派票的當下，換你派');
  lines.push(`${DAILY_QUESTION_USAGE}\u3000今天的每日一題：題目、牌譜連結、怎麼在這裡作答（${DAILY_QUESTION_YESTERDAY_USAGE[platform]} 看昨天的答案）`);
  lines.push(`${STATS_COMMAND_USAGE.player}\u3000個人戰績（還有 /排行 /默契）`);
  lines.push(`${SEAT_FILLER_USAGE[platform]}\u3000叫百科AI 進房補位`);
  lines.push(`${PAIPU_FIX_USAGE[platform]}\u3000待修正的牌譜（${CORRECTION_USAGE[platform]} 查一局、送更正）`);
  lines.push(`${REPORT_USAGE[platform]}\u3000回報網站或文章的問題（${CLAIM_USAGE[platform]} 合併 ID）`);
  lines.push(`${STATS_COMMAND_USAGE.feedback}\u3000給管理者的建議`);
  lines.push(`${RULES_USAGE}\u3000遊戲規則、角色介紹`);
  lines.push(playPlatformLine(platform));
  lines.push(`/help 主題 看細節（例：${helpCmd}；打 /說明 也一樣）`);
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
      return [`🤖 ${SEAT_FILLER_USAGE[platform]}`, SEAT_FILLER_HELP_TEXT, SEAT_FILLER_LIMITS_TEXT, SEAT_FILLER_ALIAS_TEXT].join('\n');
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
    case '每日一題':
      return [
        `📌 ${DAILY_QUESTION_USAGE}\u3000${DAILY_QUESTION_HELP_TEXT}`,
        `${DAILY_QUESTION_YESTERDAY_USAGE[platform]}\u3000${DAILY_QUESTION_YESTERDAY_HELP_TEXT}`,
        '題目跟當天 Threads／IG 的「阿瓦隆每日一題」同一題（每天換；/今日一題 也可以）。',
        SIM_CONFIG.commandsEnabled ? '回覆裡附的 /模擬 題號 可以直接在這裡作答，/公布 對答案。' : '',
      ].filter(Boolean).join('\n');
    case '規則':
      return rulesText();
    case '角色':
      return rolesText();
  }
}

/** /help［主題］的回覆：主題看不懂或沒寫 → 最基本的說明。 */
export function helpText(topic: HelpTopic | null, platform: HelpPlatform, scope: string | null = null): string {
  return topic ? topicHelpText(topic, platform, scope) : basicHelpText(platform);
}

/**
 * 看不懂的斜線指令的回覆（2026-11-25）：LINE 1 對 1 裡打錯字（/戰積、/模似）之前完全沒有回應。
 * 固定文字，絕不回顯使用者打的字。群組裡不用它（「/笑死」這種聊天不該被機器人回）。
 */
export const UNKNOWN_COMMAND_HINT = '看不懂這個指令。打 /help 看有哪些指令（例：/戰績 名字、/模擬、/每日一題）。';

/** 斜線開頭、後面緊接著字（`/戰積 小明`、`／模似`）→ 提示；其他（一般聊天、只有一個斜線）→ null。 */
export function unknownCommandHint(text: string): string | null {
  return /^\/\S/u.test((text ?? '').normalize('NFKC').trim()) ? UNKNOWN_COMMAND_HINT : null;
}
