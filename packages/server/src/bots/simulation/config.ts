/**
 * 模擬瓦（2026-10-14）— 設定與固定文字。
 *
 * Edward 2026-10-14：「Line bot/dc bot 有辦法支援模擬瓦嗎? 不是練習局
 * 模擬瓦比較像是練習邏輯思考跟派隊資訊的釋放與解讀」。見 docs/SIMULATION.md。
 *
 * 這裡沒有秘密：開關（模組載入時讀一次，測試直接改欄位）、數字上限，以及兩個
 * 「哪裡可以玩」的 id 清單（每次呼叫時讀環境變數，測試可以直接設）。
 */

const OFF = ['false', '0', 'no', 'off'];

export const SIM_CONFIG = {
  /**
   * 模擬指令總開關（LINE 與 Discord 都是）。預設開；
   * SIM_COMMANDS_ENABLED=false / 0 / no / off 關掉（指令變成一般聊天，不回）。
   */
  commandsEnabled: !OFF.includes((process.env.SIM_COMMANDS_ENABLED || '').trim().toLowerCase()),
};

/**
 * 一則回覆的上限，跟戰績的 STATS_REPLY_MAX_CHARS 一樣（Discord 2000、LINE 5000 都放得下）。
 * 不 import 戰績模組：chatExport/rows.ts 會 import 這裡的指令判斷，不能連帶載入快取讀取。
 */
export const SIM_REPLY_MAX_CHARS = 1800;

/** 閒置多久自動結束（分鐘）；SIM_SESSION_TTL_MINUTES 可改（1–240）。 */
export const SIM_SESSION_TTL_MINUTES_DEFAULT = 30;
/** 不論有沒有在動，一題最長 2 小時。 */
export const SIM_SESSION_HARD_CAP_MS = 2 * 60 * 60 * 1000;
/** 記憶體裡最多幾題（超過就結束最久沒動的）。 */
export const SIM_MAX_SESSIONS = 500;
/** 同一個聊天室（群組／頻道）最多幾題。 */
export const SIM_MAX_SESSIONS_PER_CHAT = 30;
/** 每人 10 分鐘最多 30 個模擬指令；超過只提醒一次，之後不回。 */
export const SIM_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
export const SIM_RATE_LIMIT_MAX = 30;
/** 某角色＋座位的題目少於這個數就說題目不夠，列出這個角色有題目的座位。 */
export const SIM_THIN_POOL_MIN = 20;
/** 「同位置真人」少於這個數就註明樣本少。 */
export const SIM_HUMAN_SMALL_SAMPLE = 30;

export function simSessionTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt((env.SIM_SESSION_TTL_MINUTES || '').trim(), 10);
  const minutes = Number.isFinite(raw) && raw >= 1 && raw <= 240 ? raw : SIM_SESSION_TTL_MINUTES_DEFAULT;
  return minutes * 60 * 1000;
}

function idList(raw: string | undefined): Set<string> {
  return new Set((raw || '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean));
}

/**
 * Discord 公開回覆的頻道（SIM_DISCORD_PUBLIC_CHANNEL_IDS，逗號分隔）。
 * 空 = 到處都公開（跟 /戰績 一樣）；有設 = 只有這些頻道公開，其他地方只有本人看得到。
 */
export function simDiscordPublicChannelIds(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return idList(env.SIM_DISCORD_PUBLIC_CHANNEL_IDS);
}

/**
 * 鏡像群以外，也可以玩模擬的 LINE 群（SIM_LINE_GROUP_IDS，逗號分隔；預設沒有）。
 * 在那裡回覆只用自己的 reply_token，不會順便送同步佇列。
 */
export function simLineGroupIds(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return idList(env.SIM_LINE_GROUP_IDS);
}

export type SimBeliefModelId = 'logic' | 'belief';

/**
 * SIM_BELIEF_MODEL=logic|belief。v1 只有 logic（純邏輯）；belief（派票加權，
 * task Z）還沒做，設了也先用 logic，狀態頁會照實寫。
 */
export function simBeliefModelId(env: NodeJS.ProcessEnv = process.env): SimBeliefModelId {
  return (env.SIM_BELIEF_MODEL || '').trim().toLowerCase() === 'belief' ? 'belief' : 'logic';
}
