/**
 * 複合篩選的計算引擎 — 常數（Edward 2026-10-14「我希望所有數據都有可以複合篩選的功能」）。
 *
 * 全部照抄 packages/server/generate_cache.py；資料集（games_cache.json）的 `constants` 也帶一份，
 * decodeGamesDataset 會比對，不同就拒用（產生器改了規則而引擎沒跟上時，寧可停用篩選也不算出錯的數字）。
 * 可調的門檻（LEADERBOARD_CONFIG、MIN_GAMES_THRESHOLD…）不在這裡：引擎一律讀資料集的 `config`。
 */

/** generate_cache.ALL_ROLES：players 列、族群率、理論勝率都依這個順序。 */
export const ALL_ROLES = ['刺客', '莫甘娜', '莫德雷德', '奧伯倫', '派西維爾', '梅林', '忠臣'] as const;
export type Role = (typeof ALL_ROLES)[number];

/** 配置 6 碼依序是這六個角色的座位，其餘四個座位是忠臣（generate_cache.decode_config）。 */
export const CONFIG_ROLE_ORDER: readonly Role[] = ['刺客', '莫甘娜', '莫德雷德', '奧伯倫', '派西維爾', '梅林'];

export const RED_ROLES: ReadonlySet<string> = new Set(['刺客', '莫甘娜', '莫德雷德', '奧伯倫']);
export const BLUE_ROLES: ReadonlySet<string> = new Set(['派西維爾', '梅林', '忠臣']);

/** 牌譜座位字元，桌上順序；"0" 是 10 號位。 */
export const SEATS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'] as const;
export type SeatChar = (typeof SEATS)[number];

/** roleSeatStats、seatFinalWinRates 的座號（"0" 寫成 "10"）。 */
export function seatLabel(seat: string): string {
  return seat === '0' ? '10' : seat;
}

export const OUTCOME_THREE_RED = '三紅';
export const OUTCOME_BLUE_DEAD = '三藍死';
export const OUTCOME_BLUE_ALIVE = '三藍活';
/** 只有這三種結果的局算進玩家數字（generate_cache.OUTCOMES）。 */
export const OUTCOMES = [OUTCOME_THREE_RED, OUTCOME_BLUE_DEAD, OUTCOME_BLUE_ALIVE] as const;
export type Outcome = (typeof OUTCOMES)[number];
/** 最終結算紅方勝：三紅、三藍死（docs/stats/two_stage_outcome.md）。 */
export const FINAL_RED_OUTCOMES: ReadonlySet<string> = new Set([OUTCOME_THREE_RED, OUTCOME_BLUE_DEAD]);

/** 10 人局發牌：忠臣 4/10、其他角色各 1/10（以十分之一為單位，理論勝率精確加總）。 */
export const ROLE_DEAL_TENTHS: Readonly<Record<Role, number>> = {
  刺客: 1, 莫甘娜: 1, 莫德雷德: 1, 奧伯倫: 1, 派西維爾: 1, 梅林: 1, 忠臣: 4,
};

export function isOutcome(outcome: string): outcome is Outcome {
  return outcome === OUTCOME_THREE_RED || outcome === OUTCOME_BLUE_DEAD || outcome === OUTCOME_BLUE_ALIVE;
}

/** generate_cache.role_faction：紅方 / 藍方；不是角色名時為空字串。 */
export function roleFactionName(role: string): '紅方' | '藍方' | '' {
  if (RED_ROLES.has(role)) return '紅方';
  if (BLUE_ROLES.has(role)) return '藍方';
  return '';
}

/** generate_cache.is_final_win：紅方角色三紅或三藍死勝，藍方角色只有三藍活勝。 */
export function isFinalWin(role: string, outcome: string): boolean {
  if (RED_ROLES.has(role)) return FINAL_RED_OUTCOMES.has(outcome);
  return outcome === OUTCOME_BLUE_ALIVE;
}

/**
 * generate_cache.decode_config：配置字元 → 角色，其餘 "1".."9","0" 是忠臣。同一字元出現兩次時後面的蓋掉前面的
 * （與 Python dict 相同）；配置裡的非數字字元（資料集寫成 "?"）也會成為一個鍵。
 */
export function decodeConfig(config: string): Map<string, string> {
  const seatRole = new Map<string, string>();
  let i = 0;
  for (const ch of config) {
    if (i < CONFIG_ROLE_ORDER.length) seatRole.set(ch, CONFIG_ROLE_ORDER[i]);
    i += 1;
  }
  for (const s of '1234567890') {
    if (!seatRole.has(s)) seatRole.set(s, '忠臣');
  }
  return seatRole;
}
