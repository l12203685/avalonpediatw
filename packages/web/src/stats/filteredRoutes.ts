/**
 * 篩選後的分析 API 回應 (Edward 2026-10-14 複合篩選；docs/stats/filter_engine.md)。
 *
 * 有篩選時，網站不打 /api/analysis/<path>，改用瀏覽器端引擎 (@avalon/shared/stats computeStats) 算出的
 * 區塊，組成與伺服器路由相同形狀的 data。不篩選時引擎結果 = 快取的同名區塊 (每日一致性檢查保證)，所以這裡
 * 對不篩選的結果算出來的回應必須與伺服器的回應逐欄相同 (AnalysisFilteredRoutes.test.ts 用正式快取比對)。
 *
 * 不隨篩選變動的路徑 (特徵研究 L141 以外的研究、/profile/*、精算榜、ELO) 不在這裡：照常打 API，介面標示
 * 「此區塊不隨篩選變動」。
 */
import { findSamePlayerName, playerOutcomeBlocks } from '@avalon/shared';
import type { StatsResult } from '@avalon/shared/stats';

/** 有篩選時改用引擎結果的路徑 (其餘照常打 API)。 */
export const FILTERED_PATHS = [
  '/overview', '/players', '/chemistry', '/missions', '/rounds', '/lake', '/seat-order', '/captain', '/leaderboard',
] as const;

/** 回應 = 引擎結果 (路徑不在 FILTERED_PATHS、也不是 /players/:name 時 undefined = 照常打 API)。 */
export type FilteredRoute =
  | { kind: 'data'; data: unknown }
  | { kind: 'notFound' };

/** 五成雙到一位小數 (同 generate_cache.py rnd1 / 伺服器 sheetsAnalysis.rnd1)。 */
function rnd1(n: number): number {
  const scaled = n * 10;
  const floor = Math.floor(scaled);
  const frac = scaled - floor;
  if (frac === 0.5) return (floor % 2 === 0 ? floor : floor + 1) / 10;
  return Math.round(scaled) / 10;
}

type Row = Record<string, unknown>;

/** 伺服器 normalizeSeatOrderPermutation：三藍梅活／三藍梅死與三個 pct 欄。 */
function seatOrderPermutation(p: Row): Row {
  const n = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
  const total = n(p.total) ?? 0;
  const blueAlive = n(p['三藍梅活']) ?? n(p['三藍活']) ?? 0;
  const blueDead = n(p['三藍梅死']) ?? n(p['三藍死']) ?? 0;
  const threeRed = n(p['三紅']) ?? 0;
  const pct = (x: number): number => (total > 0 ? rnd1((x / total) * 100) : 0);
  return {
    ...p,
    '三藍梅活': blueAlive,
    '三藍梅死': blueDead,
    '三紅': threeRed,
    '三藍梅活pct': n(p['三藍梅活pct']) ?? pct(blueAlive),
    '三藍梅死pct': n(p['三藍梅死pct']) ?? pct(blueDead),
    '三紅pct': n(p['三紅pct']) ?? pct(threeRed),
  };
}

/** 伺服器 GET /players/:name 的 radar (routes/analysis.ts)；引擎的列都有原始計數。 */
function playerRadar(player: Row): Row {
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const career = (player.theory as { career?: { roleTheory?: unknown; positionTheory?: unknown } } | undefined)?.career;
  const outcomeBlocks = playerOutcomeBlocks(player);
  const ratio = (hit: unknown, miss: unknown): number | null => {
    const h = num(hit);
    const m = num(miss);
    return h !== null && m !== null && h + m > 0 ? rnd1((h / (h + m)) * 100) : null;
  };
  return {
    winRate: player.finalWinRate ?? player.winRate,
    redWinRate: player.finalRedWinRate ?? player.redWin,
    blueMerlinProtect: outcomeBlocks.blue
      ? outcomeBlocks.blue.assassination.win
      : ratio(player.blueMerlinAlive, player.blueMerlinDead),
    missionWinRate: player.missionWinRate ?? player.winRate,
    excessWinRate: player.excessWinRate ?? null,
    redMerlinKillRate: outcomeBlocks.red
      ? outcomeBlocks.red.assassination.win
      : ratio(player.redMerlinDead, player.redMerlinAlive),
    experience: Math.min((num(player.totalGames) ?? 0) / 10, 100),
    roleTheory: typeof career?.roleTheory === 'number' ? career.roleTheory : null,
    positionTheory: typeof career?.positionTheory === 'number' ? career.positionTheory : null,
    outcomeBlocks,
  };
}

/** /players/<名字> 的名字 (Express 會解碼；再解一次給雙重編碼的呼叫端，壞掉的 % 保留原樣)。 */
function playerParam(path: string): string | null {
  const m = /^\/players\/([^/]+)$/.exec(path);
  if (!m) return null;
  let name = m[1];
  for (let i = 0; i < 2; i += 1) {
    try {
      name = decodeURIComponent(name);
    } catch {
      break;
    }
  }
  return name;
}

/**
 * 分析 API 路徑 (例：'/overview'、'/players/某人') → 篩選後的回應；undefined = 這條路徑不隨篩選變動，
 * 照常打 API。
 */
export function filteredRoute(path: string, result: StatsResult): FilteredRoute | undefined {
  const name = playerParam(path);
  if (name !== null) {
    const details = result.playerDetails;
    const aliases = result.players.aliases ?? {};
    const keys = Object.keys(details);
    const key = findSamePlayerName(name, keys, (k) => details[k]?.player?.totalGames ?? 0, aliases);
    if (key === undefined) return { kind: 'notFound' };
    const player = details[key].player as unknown as Row;
    return { kind: 'data', data: { player, radar: playerRadar(player) } };
  }
  switch (path) {
    case '/overview':
      return { kind: 'data', data: result.overview };
    case '/players': {
      const players = result.players.players;
      return { kind: 'data', data: { players, total: players.length, aliases: result.players.aliases ?? {} } };
    }
    case '/chemistry':
      // 試算表的四張舊矩陣 (coWin / coLose / winCorr / coWinMinusLose) 沒有完整公式，不能重算：改變對局時不顯示
      // (docs/stats/filter_engine.md「默契分母與試算表的關係」)，只給重算的三結果配對。
      return { kind: 'data', data: { outcomePair: result.pairs.outcomePair } };
    case '/missions':
      return { kind: 'data', data: result.missions };
    case '/rounds':
      return { kind: 'data', data: result.rounds };
    case '/lake':
      return { kind: 'data', data: result.lake };
    case '/seat-order': {
      const s = result.seatOrder as unknown as { permutations?: Row[] } & Row;
      return { kind: 'data', data: { ...s, permutations: (s.permutations ?? []).map(seatOrderPermutation) } };
    }
    case '/captain':
      return { kind: 'data', data: result.captainAnalysis };
    case '/leaderboard':
      return { kind: 'data', data: result.leaderboard };
    default:
      return undefined;
  }
}

/** /feature-studies：L141 換成篩選後重算的版本 (其餘研究不隨篩選變動，原樣)。 */
export function withFilteredLakeClaim<T extends { sampleSize?: unknown; features?: Array<{ loopId?: string }> }>(
  studies: T,
  result: StatsResult,
): T {
  const features = (studies.features ?? []).map((f) => (f.loopId === 'L141' ? (result.lakeClaim as unknown as typeof f) : f));
  return { ...studies, features };
}

/** 這項特徵研究會不會隨篩選重算 (只有 L141)。 */
export function isFilterableStudy(loopId: string): boolean {
  return loopId === 'L141';
}
