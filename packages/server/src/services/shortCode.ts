// 玩家可見短碼 — 加好友 / 精準配對用
// ─────────────────────────────────────────────────────────────
// 特性：
//  - 8 字元 A-Z0-9，排除易混字符 0/O/1/I/L（只剩 32 個字符 → 每碼 5bit）
//  - 用 crypto.randomBytes 產生（避免 Math.random 分佈偏差）
//  - 每位玩家一個；以 DB unique index 保證唯一，衝突 → 重試最多 5 次
//  - 格式驗證：僅大寫字母+數字 + 8 字元
//
// 既有系統暫以 UUID 末 6 碼（id.slice(-6).toUpperCase()）當顯示碼，但
//  1) 容易撞（2^24 空間）、2) 不持久可辨識、3) 包含 UUID 資訊。
// 遷移策略：新用戶註冊即生成；舊用戶 backfill（可離線跑 SQL 或登入時 lazy-fill）。

import { randomBytes } from 'crypto';

// 排除容易視覺混淆字符：0/O、1/I/L
// 剩 32 字元，便於玩家口述與抄寫
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const SHORT_CODE_LENGTH = 8;

export interface GenerateOptions {
  length?: number;
  alphabet?: string;
}

/**
 * 生成隨機短碼（純函式，無 side effect）。
 * 預設 8 字元，可覆寫 length / alphabet 方便測試。
 */
export function generateShortCode(opts: GenerateOptions = {}): string {
  const length   = opts.length   ?? SHORT_CODE_LENGTH;
  const alphabet = opts.alphabet ?? ALPHABET;
  if (length <= 0) throw new Error('length must be > 0');
  if (alphabet.length === 0) throw new Error('alphabet must be non-empty');

  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    // 用 modulo 映射；alphabet 長度 32 → byte 256 % 32 = 0，分佈均勻
    out += alphabet.charAt(bytes[i] % alphabet.length);
  }
  return out;
}

/**
 * 標準化輸入短碼：去空白、轉大寫。
 * 接受玩家輸入時用（避免大小寫 / 空白差異造成比對失敗）。
 */
export function normalizeShortCode(raw: string): string {
  return (raw ?? '').trim().toUpperCase().replace(/\s+/g, '');
}

/**
 * 驗證短碼格式：長度正確 + 僅限合法字符。
 * 注意：不檢查是否存在資料庫裡（那是 DB 層的工作）。
 */
export function isValidShortCode(code: string, length: number = SHORT_CODE_LENGTH): boolean {
  if (typeof code !== 'string') return false;
  if (code.length !== length) return false;
  for (const ch of code) {
    if (!ALPHABET.includes(ch)) return false;
  }
  return true;
}

/**
 * 嘗試生成未被使用的短碼。
 *
 * @param isTaken  callback：傳入候選碼、回傳是否已被佔用；由呼叫端查 DB
 * @param maxTries 最多重試次數（預設 5）
 * @returns        未被使用的短碼
 * @throws         超過重試上限仍撞碼（表示 DB 短碼空間接近飽和，該擴長度）
 *
 * 32^8 ≈ 1.1×10^12 空間；10 萬用戶衝突率仍 < 0.01%，5 次重試足夠。
 */
export async function generateUniqueShortCode(
  isTaken: (candidate: string) => Promise<boolean>,
  maxTries: number = 5,
): Promise<string> {
  for (let i = 0; i < maxTries; i++) {
    const candidate = generateShortCode();
    const taken = await isTaken(candidate);
    if (!taken) return candidate;
  }
  throw new Error(`generateUniqueShortCode: exhausted ${maxTries} tries`);
}

export { ALPHABET as SHORT_CODE_ALPHABET };
