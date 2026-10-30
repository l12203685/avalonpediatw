/**
 * 場數段位 chip（個人頁、個人分析頁）：只看總場數，跟 Elo 無關。
 *
 * Edward 2026-04-26 12:32-12:35 — 3 段，chip 直接顯場數區間：
 *   • `<100 場`     total_games  0-99
 *   • `100-199 場`  total_games  100-199
 *   • `≥200 場`     total_games  ≥ 200
 *
 * （原 utils/eloRank.ts：名字叫 ELO 但早就只看場數。2026-10-30 網站的 Elo 統一成分析快取的 rating 區塊後，
 *  改名並拿掉沒在用的 ELO 下限欄位。）
 */

export interface GamesTier {
  label: string;
  color: string;       // Tailwind text color class
  bgColor: string;     // Tailwind bg color class
  borderColor: string; // Tailwind border color class
  /** Minimum total games for this tier. */
  minGames: number;
}

/** Three tiers, low → high. */
export const GAMES_TIERS: readonly GamesTier[] = [
  { label: '<100 場',    color: 'text-blue-400',   bgColor: 'bg-blue-900/40',   borderColor: 'border-blue-700',   minGames: 0   },
  { label: '100-199 場', color: 'text-purple-400', bgColor: 'bg-purple-900/40', borderColor: 'border-purple-700', minGames: 100 },
  { label: '≥200 場',    color: 'text-orange-400', bgColor: 'bg-orange-900/40', borderColor: 'border-orange-700', minGames: 200 },
];

/** The highest tier whose minGames the player has. */
export function getGamesTier(totalGames: number): GamesTier {
  for (let i = GAMES_TIERS.length - 1; i >= 0; i--) {
    if (totalGames >= GAMES_TIERS[i].minGames) return GAMES_TIERS[i];
  }
  return GAMES_TIERS[0];
}
