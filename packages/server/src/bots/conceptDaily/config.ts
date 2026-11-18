/**
 * 每日「阿瓦隆百科小觀念」（2026-11-18）— 設定。
 *
 * 站長 11/18：「百科觀念卡 我希望能公開出去 並且群組(line & dc) 固定每天早上第一則訊息回覆:
 * [阿瓦隆百科小觀念] 情境: ... 觀念: ... 應用: ... 牌局: ...」
 * 「其他人也可以針對這些觀念做回覆 認為不合理或是不清楚的 你再收下做調整」
 *
 * 預設全部關閉：要在 Render 設環境變數、並列出群組／頻道 id 才會動（docs/BOT_SETUP.md〈每日小觀念〉）。
 * 這裡沒有秘密；每次呼叫都重新讀環境變數（測試可以直接設）。
 */

const ON = ['true', '1', 'yes', 'on'];

function flag(raw: string | undefined): boolean {
  return ON.includes((raw || '').trim().toLowerCase());
}

function idList(raw: string | undefined): Set<string> {
  return new Set((raw || '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean));
}

export type ConceptPlatform = 'line' | 'discord';

/** 每天幾點（台北）以後的第一則訊息會收到小觀念；預設 06:00。 */
export const CONCEPT_DAILY_DEFAULT_START = '06:00';

/** "HH:MM"（台北）→ 一天中的第幾分鐘；格式不對回 null。 */
export function parseStartTime(raw: string | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec((raw || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export interface ConceptDailyConfig {
  lineEnabled: boolean;
  discordEnabled: boolean;
  lineGroupIds: Set<string>;
  discordChannelIds: Set<string>;
  /** 一天中的第幾分鐘（台北）。 */
  startMinute: number;
  /** 回覆小觀念回饋（引用那則或打「觀念回饋」）；預設開（只在上面的群組／頻道）。 */
  feedbackEnabled: boolean;
}

/**
 *   CONCEPT_DAILY_LINE=true             LINE 開
 *   CONCEPT_DAILY_LINE_GROUP_IDS=C…     LINE 群組 id（逗號或空白分隔）；空的就算 LINE 開了也不發
 *   CONCEPT_DAILY_DISCORD=true          Discord 開
 *   CONCEPT_DAILY_DISCORD_CHANNEL_IDS=… Discord 頻道 id（逗號或空白分隔）
 *   CONCEPT_DAILY_START=06:00           每天幾點（台北）以後的第一則訊息
 *   CONCEPT_FEEDBACK=false              關掉觀念回饋（預設開）
 */
export function conceptDailyConfig(env: NodeJS.ProcessEnv = process.env): ConceptDailyConfig {
  return {
    lineEnabled: flag(env.CONCEPT_DAILY_LINE),
    discordEnabled: flag(env.CONCEPT_DAILY_DISCORD),
    lineGroupIds: idList(env.CONCEPT_DAILY_LINE_GROUP_IDS),
    discordChannelIds: idList(env.CONCEPT_DAILY_DISCORD_CHANNEL_IDS),
    startMinute: parseStartTime(env.CONCEPT_DAILY_START) ?? (parseStartTime(CONCEPT_DAILY_DEFAULT_START) as number),
    feedbackEnabled: !['false', '0', 'no', 'off'].includes((env.CONCEPT_FEEDBACK || '').trim().toLowerCase()),
  };
}

/** 這個群組／頻道有開每日小觀念嗎。 */
export function conceptDailyEnabledFor(platform: ConceptPlatform, chatId: string | undefined, cfg: ConceptDailyConfig = conceptDailyConfig()): boolean {
  if (!chatId) return false;
  return platform === 'line' ? cfg.lineEnabled && cfg.lineGroupIds.has(chatId) : cfg.discordEnabled && cfg.discordChannelIds.has(chatId);
}

/** 狀態（GitHub）存放：預設跟帳號庫同一個 private repo 的 bot-state/concept-daily.json。 */
export interface ConceptStateRepoConfig {
  token: string;
  repo: string;
  branch: string;
  path: string;
  api: string;
}

/**
 *   CONCEPT_DAILY_STATE_REPO    "owner/repo"（務必 private）；預設 GITHUB_ACCOUNTS_REPO
 *   CONCEPT_DAILY_STATE_TOKEN   對那個 repo 有 contents:write 的權杖；預設 GITHUB_ACCOUNTS_TOKEN
 *   CONCEPT_DAILY_STATE_BRANCH  預設 GITHUB_ACCOUNTS_BRANCH，再沒有就 main
 *   CONCEPT_DAILY_STATE_PATH    預設 bot-state/concept-daily.json
 * 沒有 token 或 repo → null（狀態只放記憶體，重啟後當天可能再發一次；開機 log 會寫）。
 */
export function conceptStateRepoConfig(env: NodeJS.ProcessEnv = process.env): ConceptStateRepoConfig | null {
  const token = (env.CONCEPT_DAILY_STATE_TOKEN || env.GITHUB_ACCOUNTS_TOKEN || '').trim();
  const repo = (env.CONCEPT_DAILY_STATE_REPO || env.GITHUB_ACCOUNTS_REPO || '').trim();
  if (!token || !/^[^/\s]+\/[^/\s]+$/.test(repo)) return null;
  return {
    token,
    repo,
    branch: (env.CONCEPT_DAILY_STATE_BRANCH || env.GITHUB_ACCOUNTS_BRANCH || 'main').trim(),
    path: (env.CONCEPT_DAILY_STATE_PATH || 'bot-state/concept-daily.json').trim(),
    api: (env.GITHUB_API_BASE || 'https://api.github.com').trim(),
  };
}
