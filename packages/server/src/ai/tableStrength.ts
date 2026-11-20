/**
 * 開打時的桌上強度 S（站長 2026-11-20「對上 AI/弱真人/一般真人/強真人 你都可能會需要做調整 但不會過度 就是還是有一條基準線」）。
 *
 * 同網站「陣容強度」的 S（`generate_cache._lineup_snapshot`，數據分析／勝率頁的分組都用它），只是改成「現在」：
 * - 每位真人的 PR = 他目前的網站 Elo（analysis_cache.json → rating.players，網站唯一的 Elo）在玩家池裡的百分等級
 *   （同分取中位秩、四捨五入成整數）。玩家池 = 生涯 ≥ `lineupMinGames` 場的人（`lineupActiveDays` 有設時再限最近那麼多天有打）；
 *   池子小於 `lineupMinPool` 人 → 不評分（S = null，照舊當一般真人桌）。切點都讀快取裡的 `rating.config`，不另寫一份。
 * - 暫定（< `lineupMinGames` 場）的人 PR 最高 `lineupProvisionalCap`（同網站）。
 * - 對不到的名字（訪客、新暱稱）＝ PR 50（玩家池的中位數 = 一般人；站長派工「unknown players count as average」）。
 *   網站的 S 對沒寫名字的座位用新人起始 Elo 再封頂 50；開打時對不到的人多半是不在紀錄裡的暱稱，不是新人，所以算一般人。
 * - 名字對法同網站的個人頁（`findPlayerKey`）：完全相同 → 只差大小寫／全半形／空白 → player_aliases.json 的舊名（含核准的 ID 認領）。
 *   網站帳號目前沒有「登入帳號 → 認領的紀錄 ID」的對照表，所以網站房間用房內的顯示名字。
 * - S = 桌上真人 PR 的平均（一位小數）。滿桌真人就是網站的 S；有機器人時只平均真人（機器人不是要調整的對手）。
 *
 * 分層照 `humanProfile.ts` 的 `strengthTierOfS`（網站數據分析「分組」的桌切點 `DEFAULT_COHORT_CUTS`＝S_TIERS 的 38／55）。
 * 怎麼選的見 docs/ai/optimization_loop.md 第 1H 節。
 */
import { findSamePlayerName, type PlayerAliases } from '@avalon/shared';
import { cachePlayerAliases, getAnalysisCache, rnd1, type RatingSection } from '../services/sheetsAnalysis';
import { opponentTypeOfTable, type OpponentType } from './humanProfile';

/** 對不到的名字的 PR（玩家池的中位數 = 一般人）。 */
export const UNKNOWN_PLAYER_PR = 50;

export interface PlayerPr {
  /** 對到的紀錄名字。 */
  name: string;
  pr: number;
  provisional: boolean;
}

export interface PlayerPrIndex {
  /** 玩家池人數。 */
  pool: number;
  /** 名字 → PR；對不到 → null。 */
  prOf(name: string): PlayerPr | null;
}

type RatingInput = Pick<RatingSection, 'players' | 'config'> & { dataThrough?: string | null };

function cfgNum(cfg: Record<string, unknown>, key: string, dflt: number): number {
  const v = cfg[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
}

function daysBetween(earlier: string, later: string): number {
  return Math.round((Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / 86_400_000);
}

/** 已排序的 pool 裡 x 的百分等級（0..100，同分取中位秩；同 generate_cache._percentile_rank）。 */
export function percentileRank(sortedPool: readonly number[], x: number): number {
  let lo = 0;
  let hi = sortedPool.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (sortedPool[m] < x) lo = m + 1; else hi = m; }
  const left = lo;
  hi = sortedPool.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (sortedPool[m] <= x) lo = m + 1; else hi = m; }
  return (100 * (left + 0.5 * (lo - left))) / sortedPool.length;
}

/**
 * rating 區塊（＋舊名對照）→ 每位玩家目前的 PR。池子太小（< lineupMinPool）→ null。純函式。
 */
export function buildPlayerPrIndex(rating: RatingInput, aliases: PlayerAliases | null = null): PlayerPrIndex | null {
  const cfg = rating.config ?? {};
  const minGames = cfgNum(cfg, 'lineupMinGames', 30);
  const minPool = cfgNum(cfg, 'lineupMinPool', 20);
  const cap = cfgNum(cfg, 'lineupProvisionalCap', 50);
  const active = cfg.lineupActiveDays;
  const through = rating.dataThrough ?? null;
  const inPool = (row: RatingSection['players'][number]): boolean => {
    if (row.games < minGames) return false;
    if (typeof active !== 'number') return true;
    if (!through || !row.lastPlayed) return false;
    const d = daysBetween(row.lastPlayed, through);
    return d >= 0 && d <= active;
  };
  const rows = new Map<string, RatingSection['players'][number]>();
  for (const row of rating.players ?? []) if (row && typeof row.name === 'string' && Number.isFinite(row.elo)) rows.set(row.name, row);
  const pool = [...rows.values()].filter(inPool).map((r) => r.elo).sort((a, b) => a - b);
  if (pool.length < minPool) return null;
  const names = [...rows.keys()];
  const games = (n: string): number => rows.get(n)?.games ?? 0;
  return {
    pool: pool.length,
    prOf(name: string): PlayerPr | null {
      if (typeof name !== 'string' || !name.trim()) return null;
      const key = rows.has(name) ? name : findSamePlayerName(name, names, games, aliases);
      const row = key === undefined ? undefined : rows.get(key);
      if (!row) return null;
      const provisional = row.games < minGames;
      const raw = percentileRank(pool, row.elo);
      const pr = Math.floor((provisional ? Math.min(raw, cap) : raw) + 0.5);
      return { name: row.name, pr, provisional };
    },
  };
}

export interface TableStrength {
  /** 桌上真人 PR 的平均（一位小數）；沒有真人或不評分 → null。 */
  s: number | null;
  /** 對到紀錄的真人數。 */
  known: number;
  /** 對不到、當一般人（PR 50）的真人數。 */
  unknown: number;
}

/** 桌上真人的名字 → S。index = null（沒有快取、池子太小）→ S = null。純函式。 */
export function tableStrengthOf(humanNames: readonly string[], index: PlayerPrIndex | null): TableStrength {
  if (!index || humanNames.length === 0) return { s: null, known: 0, unknown: 0 };
  let sum = 0;
  let known = 0;
  for (const n of humanNames) {
    const hit = index.prOf(n);
    if (hit) { sum += hit.pr; known += 1; } else sum += UNKNOWN_PLAYER_PR;
  }
  return { s: rnd1(sum / humanNames.length), known, unknown: humanNames.length - known };
}

let cached: { rating: unknown; index: PlayerPrIndex | null } | null = null;

/** 網站快取（analysis_cache.json，網站讀的同一份）→ PR 索引；讀不到 → null（不丟錯）。同一份快取只建一次。 */
export function livePlayerPrIndex(): PlayerPrIndex | null {
  try {
    const c = getAnalysisCache();
    if (!c.rating) return null;
    if (cached && cached.rating === c.rating) return cached.index;
    const index = buildPlayerPrIndex(c.rating, cachePlayerAliases(c.players));
    cached = { rating: c.rating, index };
    return index;
  } catch {
    return null;
  }
}

/** 桌上真人的名字 → 現在的 S（網站快取）；讀不到 → null。 */
export function liveTableS(humanNames: readonly string[]): number | null {
  return tableStrengthOf(humanNames, livePlayerPrIndex()).s;
}

/** 桌上真人的名字 → 對手類型與 S（沒有真人 → ai；S 讀不到 → avgHuman）。`sOf` 可換（測試用）。 */
export function opponentTypeOfHumans(
  humanNames: readonly string[],
  sOf: (names: readonly string[]) => number | null = liveTableS,
): { type: OpponentType; tableS: number | null } {
  const tableS = humanNames.length > 0 ? sOf(humanNames) : null;
  return { type: opponentTypeOfTable({ humans: humanNames.length, tableS }), tableS };
}
