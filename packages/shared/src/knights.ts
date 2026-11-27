/**
 * AI騎士的名字（站長 2026-11-26：「以後整個系統裡面的百科AI 都改名成 AI騎士_{風格}_{##} / 如果風格沒指定 就是「百科」
 * 就是目前訓練出來的」）。
 *
 *   - 一隻騎士：`AI騎士_{風格}`（站長 2026-11-27：一位騎士只有一隻，名字不帶數字）；`_{##}` 只在同一桌有好幾個座位是同一位騎士時
 *     加在座位名上（`AI騎士_ED_01`、`AI騎士_ED_02`；補位機器人 `百科AI_3` → `AI騎士_百科_03`）。風格沒指定 = 「百科」（目前訓練出來的引擎）。
 *   - 統稱：「AI騎士」；整個頁面／團隊：「AI騎士團」。
 *   - 舊名字（`百科AI`、`百科AI_n`、`百科AI看房1460`、更早的 `百科機器人…`）還留在舊牌譜、DC 貼文、player_aliases.json 裡：
 *     不改存下來的紀錄，顯示和戰績一律經過這裡換成新名字（knightDisplayName / knightStatsName），同一隻機器人的歷史接得起來。
 *
 * 只換顯示的名字：程式裡的識別字、環境變數、檔名、資料裡的分類值（「百科AI」分類）都不改。
 * Python 那一側（generate_cache.py 的 knight_display_name / knight_stats_name / is_pedia_bot_name）是同一套規則，
 * 兩邊都對 packages/server/src/__tests__/fixtures/knight_names.json 測。
 */

/** 統稱。 */
export const KNIGHT_PREFIX = 'AI騎士';
/** 沒指定風格時的風格（目前訓練出來的引擎）。 */
export const DEFAULT_KNIGHT_STYLE = '百科';
/** 整個 AI騎士 的頁面／團隊名稱。 */
export const KNIGHT_TEAM_NAME = 'AI騎士團';
/** 舊名字的開頭（2026-11-26 以前）。 */
export const LEGACY_BOT_PREFIX = '百科AI';

/** 「百科」風格（目前的引擎）在戰績上的名字：所有 AI騎士_百科_## 和舊的 百科AI_n 都算這一位（同以前「百科AI」）。 */
export const DEFAULT_KNIGHT_STATS_NAME = `${KNIGHT_PREFIX}_${DEFAULT_KNIGHT_STYLE}`;

/** NFKC（全形 ＡＩ → AI）、去掉零寬字元、去頭尾空白：比對用，不改顯示。 */
function tidy(name: string): string {
  return name.normalize('NFKC').replace(/[\u200b-\u200f\u2060-\u2064\ufeff]/g, '').trim();
}

/** 兩位數序號（0–99）；超過 99 照原樣。 */
export function knightSerial(n: number): string {
  return n >= 0 && n < 10 ? `0${n}` : String(n);
}

/** `AI騎士_{風格}_{##}`；沒給序號時 `AI騎士_{風格}`。 */
export function knightName(style: string = DEFAULT_KNIGHT_STYLE, serial?: number): string {
  const s = style.trim() || DEFAULT_KNIGHT_STYLE;
  return serial === undefined ? `${KNIGHT_PREFIX}_${s}` : `${KNIGHT_PREFIX}_${s}_${knightSerial(serial)}`;
}

const BOT_NAME_RE = /^(?:百科(?:機器人|ai)|ai騎士)/i;
const LEGACY_NAME_RE = /^百科ai(?:_(\d+))?$/i;
const LEGACY_WATCH_RE = /^百科ai看房(\d*)$/i;
const KNIGHT_NAME_RE = /^ai騎士_([^_\s]+)(?:_(\d+))?$/i;

/** 這個名字是我們的機器人嗎（AI騎士、舊的 百科AI／百科機器人；大小寫、全半形不論）。 */
export function isKnightBotName(name: string | null | undefined): boolean {
  return BOT_NAME_RE.test(tidy(name ?? ''));
}

/** `AI騎士_百科_03` → { style: '百科', serial: 3 }；舊名字先換成新的再拆；不是騎士名字時 null。 */
export function parseKnightName(name: string | null | undefined): { style: string; serial: number | null } | null {
  const m = KNIGHT_NAME_RE.exec(knightDisplayName(name ?? ''));
  if (!m) return null;
  return { style: m[1], serial: m[2] === undefined ? null : Number(m[2]) };
}

/**
 * 顯示用的名字：舊名字換成新的（`百科AI` → `AI騎士_百科`、`百科AI_3` → `AI騎士_百科_03`、`百科AI看房1460` → `AI騎士看房1460`）；
 * 其他名字（含已經是 AI騎士 的、更早的 `百科機器人A`、真人）照原樣。
 */
export function knightDisplayName(name: string): string {
  const t = tidy(name);
  const legacy = LEGACY_NAME_RE.exec(t);
  if (legacy) return legacy[1] === undefined ? DEFAULT_KNIGHT_STATS_NAME : knightName(DEFAULT_KNIGHT_STYLE, Number(legacy[1]));
  const watch = LEGACY_WATCH_RE.exec(t);
  if (watch) return `${KNIGHT_PREFIX}看房${watch[1]}`;
  return name;
}

/**
 * 戰績上算哪一位：「百科」風格（含舊的 百科AI、百科AI_n、百科機器人…）都是 `AI騎士_百科`（同以前 player_aliases.json
 * 把 百科AI_0～99 併成「百科AI」）；其他騎士各自一位，座位序號不算（站長 2026-11-27「所有的AI騎士應該都只有一隻」：
 * `AI騎士_ED`、舊的 `AI騎士_ED_01`、同桌的 `AI騎士_ED_02` 都是 `AI騎士_ED`）；沒有風格的（「AI騎士」）算「百科」；不是機器人時 null。
 */
export function knightStatsName(name: string | null | undefined): string | null {
  const t = tidy(name ?? '');
  if (!isKnightBotName(t)) return null;
  if (/^百科/i.test(t)) return DEFAULT_KNIGHT_STATS_NAME;
  const k = parseKnightName(t);
  // 只寫「AI騎士」、看房帳號這類沒有風格的：當成目前的引擎。
  if (!k) return DEFAULT_KNIGHT_STATS_NAME;
  return k.style === DEFAULT_KNIGHT_STYLE ? DEFAULT_KNIGHT_STATS_NAME : knightName(k.style);
}
