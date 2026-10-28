/**
 * 「三種結果與場次排行」比例圖的資料 (Edward 2026-10-28：「用比例的方式呈現那三種結果下再切分贏的跟輸的…
 * 一條呈現遊戲結果比例 一條呈現任務輸贏 一條呈現刺殺輸贏 一條呈現最終輸贏」)。
 *
 * 只用 /api/analysis/players 每列的六個原始計數 (packages/shared/src/stats/players.ts)，全部從玩家自己那一方看：
 *
 *               三紅            三藍死                三藍活
 *   當紅方      任務贏 → 贏     任務輸、刺殺贏 → 贏   任務輸、刺殺輸 → 輸
 *   當藍方      任務輸 → 輸     任務贏、刺殺輸 → 輸   任務贏、刺殺贏 → 贏
 *
 *   遊戲結果  三紅 = 紅三紅 (贏) + 藍三紅 (輸)；三藍死 = 紅三藍死 (贏) + 藍三藍死 (輸)；
 *             三藍活 = 藍三藍活 (贏) + 紅三藍活 (輸)
 *   任務      贏 = 紅三紅 + 藍三藍死 + 藍三藍活                         n = 全部場數
 *   刺殺      贏 = 紅三藍死 + 藍三藍活；只算三藍局                       n = 三藍局數
 *   最終      贏 = 紅三紅 + 紅三藍死 + 藍三藍活                          n = 全部場數
 *
 * 加總 (全體玩家) = 每位玩家每場各算一次，就是「平均一位玩家」的基準。篩選時瀏覽器引擎重算 players 列，
 * 這裡跟著變。純函式，測試在 packages/server/src/__tests__/WebAnalysisStats.test.ts。
 */

/** players 列裡用到的六個原始計數 (舊快取可能缺)。 */
export interface RawOutcomeCounts {
  rawRedThreeRed?: number;
  rawRedMerlinDead?: number;
  rawRedMerlinAlive?: number;
  rawBlueThreeRed?: number;
  rawBlueMerlinDead?: number;
  rawBlueMerlinAlive?: number;
}

export const RAW_OUTCOME_KEYS = [
  'rawRedThreeRed', 'rawRedMerlinDead', 'rawRedMerlinAlive',
  'rawBlueThreeRed', 'rawBlueMerlinDead', 'rawBlueMerlinAlive',
] as const satisfies readonly (keyof RawOutcomeCounts)[];

export type ShareOutcome = '三紅' | '三藍死' | '三藍活';

export interface WonLost {
  won: number;
  lost: number;
}

/** 贏的場數與分母；rate = 贏 ÷ n × 100 (n = 0 時 null)。 */
export interface WinPart {
  win: number;
  n: number;
  rate: number | null;
}

export interface PlayerOutcomeShares {
  games: number;
  /** 三種結果各自贏、輸的場數 (固定順序 三紅 → 三藍死 → 三藍活)。 */
  outcomes: Record<ShareOutcome, WonLost>;
  mission: WinPart;
  assassination: WinPart;
  final: WinPart;
}

function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

function part(win: number, n: number): WinPart {
  return { win, n, rate: n > 0 ? (win / n) * 100 : null };
}

/** 六個計數都是數字才算有 (舊快取沒有 → false，顯示「—」而不是 0)。 */
export function hasRawOutcomes(p: RawOutcomeCounts | null | undefined): boolean {
  return !!p && RAW_OUTCOME_KEYS.every(k => typeof p[k] === 'number' && Number.isFinite(p[k]));
}

/** 一位玩家 (或加總) 從自己那一方看的四條比例。 */
export function playerOutcomeShares(p: RawOutcomeCounts): PlayerOutcomeShares {
  const r3 = count(p.rawRedThreeRed);
  const rd = count(p.rawRedMerlinDead);
  const ra = count(p.rawRedMerlinAlive);
  const b3 = count(p.rawBlueThreeRed);
  const bd = count(p.rawBlueMerlinDead);
  const ba = count(p.rawBlueMerlinAlive);
  const games = r3 + rd + ra + b3 + bd + ba;
  return {
    games,
    outcomes: {
      三紅: { won: r3, lost: b3 },
      三藍死: { won: rd, lost: bd },
      三藍活: { won: ba, lost: ra },
    },
    mission: part(r3 + bd + ba, games),
    assassination: part(rd + ba, rd + ra + bd + ba),
    final: part(r3 + rd + ba, games),
  };
}

/** 全部玩家的六個計數加總 (每位玩家每場各算一次)；有任何一列缺計數就回 null (半套加總不如不顯示)。 */
export function sumRawOutcomes(players: readonly RawOutcomeCounts[]): RawOutcomeCounts | null {
  if (players.length === 0 || !players.every(hasRawOutcomes)) return null;
  const sum: Required<RawOutcomeCounts> = {
    rawRedThreeRed: 0, rawRedMerlinDead: 0, rawRedMerlinAlive: 0,
    rawBlueThreeRed: 0, rawBlueMerlinDead: 0, rawBlueMerlinAlive: 0,
  };
  for (const p of players) {
    for (const k of RAW_OUTCOME_KEYS) sum[k] += count(p[k]);
  }
  return sum;
}
