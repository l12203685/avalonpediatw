import {
  finalFields,
  playerOutcomeBlocks,
  theoryLastWindows,
  theoryRoleWindows,
} from '../../../services/api';
import type {
  AnalysisPlayerRadar,
  AnalysisPlayerStats,
  AnalysisTheorySettings,
  PlayerOutcomeBlocks,
  PlayerRoleWindows,
  PlayerTheoryWindow,
} from '../../../services/api';

/**
 * 玩家雷達的資料整理 (2026-10-14 Edward：角色勝率分三塊、用條件機率；角色理論改各角色近 10 場、
 * 忠臣近 40 場，位置理論近 100 場，整體理論 = 生涯角色理論、生涯滿 250 場才列)。
 *
 * 這裡只挑欄位、不重算公式：
 *  - 三塊結果 (任務／刺殺／遊戲) = radar.outcomeBlocks (新後端)，沒有就用同一個
 *    @avalon/shared playerOutcomeBlocks(player) 從原始計數算 (經 services/api 匯出)。
 *  - 紅方刺中率、藍方梅林存活率 = 刺殺結果 (只看到達三藍的局) — 算不出來是 null，圖上不畫，
 *    絕不退回 三藍死 / 全部紅方場、三藍活 / 全部藍方場 這種無條件的比例。
 *  - 理論勝率讀快取的 players[].theory：roleWindows (角色理論)、last<positionGames> (位置理論)、
 *    career (整體理論)；視窗與門檻讀 theorySettings()，不寫死 10／40／100／250。
 */

/** 角色固定順序 (紅方四個在前)；快取多出來的角色接在後面。 */
export const ROLE_ORDER: readonly string[] = ['刺客', '莫甘娜', '莫德雷德', '奧伯倫', '派西維爾', '梅林', '忠臣'];

export type AxisKey =
  | 'winRate' | 'redWinRate' | 'blueMerlinProtect' | 'missionWinRate'
  | 'roleTheory' | 'positionTheory' | 'redMerlinKillRate' | 'experience';

export const AXIS_ORDER: readonly AxisKey[] = [
  'winRate', 'redWinRate', 'blueMerlinProtect', 'missionWinRate',
  'roleTheory', 'positionTheory', 'redMerlinKillRate', 'experience',
];

export interface AxisRow {
  key: AxisKey;
  /** 勝率軸 0–100 %；經驗 = 場數 / 10 (上限 100)。算不出來為 null → 圖上不畫這條軸，表格顯示「—」。 */
  value: number | null;
  /** 分母場數 (理論勝率 = 用到的場數)；不知道為 null。 */
  n: number | null;
}

export interface PlayerRadarModel {
  player: AnalysisPlayerStats;
  /** 紅方場、藍方場、各角色 (schemaVersion 4) 的三塊結果，每塊附 n。 */
  blocks: PlayerOutcomeBlocks;
  /** 全部場次的遊戲結果 (最終勝率)。 */
  finalWinRate: number | null;
  axes: AxisRow[];
  /** 角色理論 (各角色近 K 場)；schemaVersion < 4 為 null。 */
  roleWindows: PlayerRoleWindows | null;
  /** 位置理論 (近 positionGames 場)；快取沒有那個視窗為 null。 */
  positionWindow: PlayerTheoryWindow | null;
  /** 生涯 (整體理論 = 它的 overallTheory；舊快取 = 它的 roleTheory)。 */
  career: PlayerTheoryWindow | null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function isWindow(w: unknown): w is PlayerTheoryWindow {
  return Boolean(w) && typeof w === 'object' && typeof (w as PlayerTheoryWindow).roleTheory === 'number';
}

/** players[].theory 的位置理論視窗 (window = settings.positionGames)；沒有就 null，不拿別的視窗代替。 */
export function positionTheoryWindow(
  theory: AnalysisPlayerStats['theory'],
  settings: AnalysisTheorySettings,
): PlayerTheoryWindow | null {
  return theoryLastWindows(theory).find(w => w.window === settings.positionGames) ?? null;
}

/** 從 /players/:name 的回應整理出雷達圖、三塊勝率、理論勝率要用的數字。 */
export function buildRadarModel(
  data: AnalysisPlayerRadar,
  settings: AnalysisTheorySettings,
  roleFinalWinRates?: Record<string, number>,
): PlayerRadarModel {
  const { player, radar } = data;
  const ff = finalFields(player, roleFinalWinRates);
  const fromBackend = radar.outcomeBlocks && typeof radar.outcomeBlocks === 'object' ? radar.outcomeBlocks : null;
  const blocks = fromBackend ?? playerOutcomeBlocks(player);
  // 新後端 (有 outcomeBlocks) 的 redMerlinKillRate / blueMerlinProtect 已是條件機率 (原始計數缺時它用
  // 各陣營比例的比值，一樣是條件的)；舊後端送的是無條件比例，不讀。
  const conditional = (v: unknown): number | null => (fromBackend ? num(v) : null);
  const redKill = blocks.red ? blocks.red.assassination.win : conditional(radar.redMerlinKillRate);
  const blueAlive = blocks.blue ? blocks.blue.assassination.win : conditional(radar.blueMerlinProtect);

  const theory = player.theory;
  const roleWindows = theoryRoleWindows(theory);
  const positionWindow = positionTheoryWindow(theory, settings);
  const careerRaw = theory?.career;
  const career = isWindow(careerRaw) ? careerRaw : null;
  const total = num(player.totalGames);

  const values: Record<AxisKey, { value: number | null; n: number | null }> = {
    winRate: { value: ff.finalWinRate, n: total },
    redWinRate: {
      value: blocks.red?.final.win ?? ff.finalRedWinRate,
      n: blocks.red?.final.n ?? num(player.rawRedGames),
    },
    blueMerlinProtect: { value: blueAlive, n: blocks.blue?.assassination.n ?? null },
    missionWinRate: { value: ff.missionWinRate, n: total },
    roleTheory: { value: roleWindows?.roleTheory ?? null, n: roleWindows?.games ?? null },
    positionTheory: { value: positionWindow?.positionTheory ?? null, n: positionWindow?.games ?? null },
    redMerlinKillRate: { value: redKill, n: blocks.red?.assassination.n ?? null },
    experience: {
      value: num(radar.experience) ?? (total === null ? null : Math.min(total / 10, 100)),
      n: total,
    },
  };

  return {
    player,
    blocks,
    finalWinRate: ff.finalWinRate,
    axes: AXIS_ORDER.map(key => ({ key, ...values[key] })),
    roleWindows,
    positionWindow,
    career,
  };
}

/** roleOutcomes / roleWindows 的角色，固定順序在前、其他接後。 */
export function orderedRoles(roles: Iterable<string>): string[] {
  const set = new Set(roles);
  return [...ROLE_ORDER.filter(r => set.has(r)), ...[...set].filter(r => !ROLE_ORDER.includes(r))];
}

export type RoleCellStatus = 'full' | 'partial' | 'topUp' | 'none';

/**
 * 角色理論一格的狀態：沒打過 (用全體勝率)、補值 (場數 < 補值門檻，同 generate_cache.py
 * role_window_theory 的 m = max(theoryMinCellGames, 1))、未打滿 (< 視窗)、打滿。
 */
export function roleCellStatus(games: number, window: number, minCellGames: number): RoleCellStatus {
  if (!(games > 0)) return 'none';
  if (games < Math.max(minCellGames, 1)) return 'topUp';
  return games < window ? 'partial' : 'full';
}

/** 角色理論的視窗：特殊角色各近幾場、忠臣近幾場 (theoryConfig.roleWindowGames)。 */
export function roleWindowSizes(settings: AnalysisTheorySettings): { special: number; loyal: number } {
  const map = settings.roleWindowGames;
  const special = ROLE_ORDER.filter(r => r !== '忠臣').map(r => map[r]).find(v => typeof v === 'number');
  return { special: special ?? 0, loyal: map['忠臣'] ?? 0 };
}

/** 角色理論那段場次 (各角色視窗加起來) 實際的最終勝率 %，與用到的場數；沒有場次時 null。 */
export function roleWindowsFinal(rw: PlayerRoleWindows): { rate: number | null; n: number } {
  let wins = 0;
  let games = 0;
  for (const cell of Object.values(rw.roles)) {
    if (typeof cell?.games === 'number' && typeof cell.wins === 'number') {
      games += cell.games;
      wins += cell.wins;
    }
  }
  return { rate: games > 0 ? (wins / games) * 100 : null, n: games };
}
