/**
 * lake 區塊（generate_cache.compute_lake 逐行移植；Edward 2026-10-14 複合篩選：篩選後的局重算，不篩選時與快取
 * 逐欄相同）。
 *
 * 看全部局（含沒有結果的局：redWinRate 的分母是該組全部局，三結果的 % 加起來可能不到 100），湖的持湖 / 目標
 * 座位來自 首湖 / 二湖 / 三湖 欄（資料集 `lakes`，decodeGamesDataset 已換成角色與陣營）。一個湖「有」= 持湖者的
 * 陣營查得到（持湖座位不是單一數字、或不在配置裡時整個湖不算）。分組的順序 = 該組第一次出現的順序（Python
 * dict 的插入順序），所以用 Map。
 *
 * 不列任何玩家，篩選的「只是不上榜」對這裡沒有作用。
 */
import type { Game, LakeInfo } from './dataset';
import { outcomeSplit, type OutcomeSplit } from './players';
import { rnd1 } from './pyround';

/** perLake / allLakeRoleStats 的湖名（generate_cache.compute_lake 的 lake_configs）。 */
export const LAKE_NAMES = ['首湖', '二湖', '三湖'] as const;

export interface LakeHolderFactionStat {
  faction: string;
  games: number;
  redWinRate: number;
  outcomes: OutcomeSplit;
}

export interface LakeComboStat {
  holderFaction: string;
  /** 目標座位查不到角色時為空字串（Python 的 "紅方|".split("|")）。 */
  targetFaction: string;
  games: number;
  redWinRate: number;
  outcomes: OutcomeSplit;
}

export interface LakeHolderRoleStat {
  role: string;
  games: number;
  redWinRate: number;
  blueWinRate: number;
  outcomes: OutcomeSplit;
}

export interface LakeTargetRoleStat {
  role: string;
  games: number;
  redWinRate: number;
  outcomes: OutcomeSplit;
}

export interface LakeFactionSplit {
  games: number;
  redWinRate: number;
  outcomes: OutcomeSplit;
}

export interface PerLakeRow {
  lake: string;
  totalGames: number;
  holderStats: LakeHolderFactionStat[];
  comboStats: LakeComboStat[];
}

export interface LakeRoleRow {
  lake: string;
  holderRoleStats: LakeHolderRoleStat[];
  targetRoleStats: LakeTargetRoleStat[];
  sameFaction: LakeFactionSplit;
  diffFaction: LakeFactionSplit;
}

/** 快取的 lake 區塊（鍵與順序同 analysis_cache.json）。 */
export interface LakeSection {
  perLake: PerLakeRow[];
  /** 只看首湖。 */
  holderRoleStats: LakeHolderRoleStat[];
  /** 只看首湖。 */
  targetRoleStats: LakeTargetRoleStat[];
  allLakeRoleStats: LakeRoleRow[];
}

/** sum(1 for g in gs if g.red_win) / len(gs) * 100 → rnd1（gs 不是空的）。 */
function redWinRate(gs: readonly Game[]): number {
  return rnd1((gs.filter((g) => g.redWin).length / gs.length) * 100);
}

function blueWinRate(gs: readonly Game[]): number {
  return rnd1((gs.filter((g) => g.blueWin).length / gs.length) * 100);
}

/** dict.setdefault(key, []).append(g)：鍵的順序 = 第一次出現的順序。 */
function groupBy(games: readonly Game[], key: (g: Game) => string | null): Map<string, Game[]> {
  const out = new Map<string, Game[]>();
  for (const g of games) {
    const k = key(g);
    if (k === null) continue;
    const list = out.get(k);
    if (list) list.push(g);
    else out.set(k, [g]);
  }
  return out;
}

/** 第 index 湖（0..2）；持湖陣營是空的（沒有湖，或持湖座位查不到角色）時為 null。 */
function lakeOf(g: Game, index: number): LakeInfo | null {
  const lake = g.lakes[index];
  return lake && lake.holderFaction !== '' ? lake : null;
}

function holderRoleStats(games: readonly Game[], index: number): LakeHolderRoleStat[] {
  const groups = groupBy(games, (g) => (g.lakes[index] as LakeInfo).holderRole || null);
  return [...groups].map(([role, gs]) => ({
    role,
    games: gs.length,
    redWinRate: redWinRate(gs),
    blueWinRate: blueWinRate(gs),
    outcomes: outcomeSplit(gs),
  }));
}

function targetRoleStats(games: readonly Game[], index: number): LakeTargetRoleStat[] {
  const groups = groupBy(games, (g) => (g.lakes[index] as LakeInfo).targetRole || null);
  return [...groups].map(([role, gs]) => ({
    role,
    games: gs.length,
    redWinRate: redWinRate(gs),
    outcomes: outcomeSplit(gs),
  }));
}

function factionSplit(gs: readonly Game[]): LakeFactionSplit {
  return { games: gs.length, redWinRate: gs.length ? redWinRate(gs) : 0, outcomes: outcomeSplit(gs) };
}

/** generate_cache.compute_lake。 */
export function computeLake(games: readonly Game[]): LakeSection {
  const lakeGames = LAKE_NAMES.map((_, i) => games.filter((g) => lakeOf(g, i) !== null));

  const perLake: PerLakeRow[] = [];
  LAKE_NAMES.forEach((label, i) => {
    const subset = lakeGames[i];
    if (!subset.length) return;
    const holderGroups = groupBy(subset, (g) => (g.lakes[i] as LakeInfo).holderFaction);
    const comboGroups = groupBy(subset, (g) => {
      const lake = g.lakes[i] as LakeInfo;
      return `${lake.holderFaction}|${lake.targetFaction}`;
    });
    perLake.push({
      lake: label,
      totalGames: subset.length,
      holderStats: [...holderGroups].map(([faction, gs]) => ({
        faction,
        games: gs.length,
        redWinRate: redWinRate(gs),
        outcomes: outcomeSplit(gs),
      })),
      comboStats: [...comboGroups].map(([key, gs]) => {
        const [holderFaction, targetFaction] = key.split('|');
        return { holderFaction, targetFaction, games: gs.length, redWinRate: redWinRate(gs), outcomes: outcomeSplit(gs) };
      }),
    });
  });

  // Fix #12：三個湖各自的持湖 / 目標角色與「同陣營 / 不同陣營」
  const allLakeRoleStats: LakeRoleRow[] = [];
  LAKE_NAMES.forEach((label, i) => {
    const subset = lakeGames[i];
    if (!subset.length) return;
    const same: Game[] = [];
    const diff: Game[] = [];
    for (const g of subset) {
      const lake = g.lakes[i] as LakeInfo;
      if (lake.targetFaction === '') continue;
      (lake.holderFaction === lake.targetFaction ? same : diff).push(g);
    }
    allLakeRoleStats.push({
      lake: label,
      holderRoleStats: holderRoleStats(subset, i),
      targetRoleStats: targetRoleStats(subset, i),
      sameFaction: factionSplit(same),
      diffFaction: factionSplit(diff),
    });
  });

  return {
    perLake,
    holderRoleStats: holderRoleStats(lakeGames[0], 0),
    targetRoleStats: targetRoleStats(lakeGames[0], 0),
    allLakeRoleStats,
  };
}
