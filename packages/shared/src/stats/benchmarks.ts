/**
 * 基準列（Edward 2026-11-03「你可以預設讓以下幾個呈現在所有排行跟數據分析的最上列嗎 [散客 < 30場] [排除散客後全體]
 * [排除散客後 PR50+] [排除散客後 PR50-]」；同日改成「如果改成 前1/3 中間1/3 後1/3呢」）：五個虛擬的「玩家」，逐座位把篩選後的局分組，各組照玩家的算法算一列，
 * 網站把它們釘在每張玩家表的最上面當比較基準（不排名、不算進人數）。
 *
 *  - 散客 < N 場：生涯場數未滿 N 的玩家的座位。生涯場數的定義與合併計算（filter/merge.ts）相同：全部局（不看任何
 *    子句、不看基準日）中有結果（三紅／三藍死／三藍活）的座位數，別名已合併。N = options.mergeSmall.maxGames（有開
 *    「散客」合併時），否則 30。合併計算有開時看合併後的名字：散客（<N場）本身算散客，自訂合併的名字看合併後的總場數。
 *  - 排除散客後全體：其他所有有名字的座位（散客 + 全體 = 篩選後全部有名字的座位）。
 *  - 排除散客後 前1/3／中間1/3／後1/3：全體裡、依那一局開打前這個座位的時間相對 Elo PR（games_cache 的 lineup，
 *    generate_cache.compute_lineups）三等分，三組互不重疊：
 *      前1/3   PR ≥ 200/3（66.66…）
 *      中間1/3 100/3 ≤ PR < 200/3（「一般玩家」的基準）
 *      後1/3   PR < 100/3（33.33…）
 *    分界用精確的三分之一：比較 3 × PR 與 100、200（不用 33.33 之類的小數，沒有浮點邊界問題；PR 剛好 = 100/3 算中間、
 *    = 200/3 算前）。PR 是 0–100 的整數時：0–33 後、34–66 中、67–100 前。
 *    PR 是在「生涯已 ≥30 場」的玩家池裡的百分等級；暫定座位（當時生涯未滿 30 場，PR 被壓在 50 以下）與沒評分的局
 *    （玩家池太小、舊資料沒有 lineup）沒有可用的 PR，三個 PR 列都不算，但照樣算在「全體」
 *    （前 + 中 + 後 + 沒有 PR = 全體）。
 *
 * 每組的數字：
 *  - row：players 區塊同一形狀的一列（PlayerTally.toRow + 時間線理論 + 每個座位的三結果），名字 = 組名。勝率都是
 *    逐座位加權（一局有好幾位散客就算好幾場），與合併計算的散客相同。
 *  - theory：理論表的欄位，全部用「篩選後這組全部座位」算（不是最近 N 場／各角色窗：一個組每天幾十個座位，最近 N 場
 *    沒有意義）：角色理論、位置理論、整體理論、最終勝率 = theoryWindow（生涯版，補值用篩選後的族群率）；任務／刺殺
 *    勝率 = missionAssassination。
 *  - assassin：當刺客、任務做到三藍的局的刺中率（全部，不是最近 N 次）。
 *
 * 純函式，只讀局；不改任何人的數字（篩選結果的其他區塊完全不受影響）。
 */
import { OUTCOME_BLUE_ALIVE, OUTCOME_BLUE_DEAD, isOutcome } from './constants';
import type { DecodedDataset, Game, GamesDatasetConfig } from './dataset';
import { rate } from './pyround';
import { computeSeatOutcomesPerPlayer, playerTallies, type PlayerRow } from './players';
import { missionAssassination, playerTheory, playerTimelines, type OutcomeRates, type RoleSeatRates } from './theory';

/** 沒有開「散客」合併時的門檻。 */
export const BENCHMARK_DEFAULT_MAX_GAMES = 30;
/** 顯示順序：散客、全體、前1/3、中間1/3、後1/3。 */
export const BENCHMARK_IDS = ['casual', 'regular', 'prTop', 'prMid', 'prBottom'] as const;
export type BenchmarkId = (typeof BENCHMARK_IDS)[number];
export type BenchmarkTertile = 'prTop' | 'prMid' | 'prBottom';

/** PR 的三等分（精確：3 × PR 與 100、200 比；PR = 100/3 → 中間、= 200/3 → 前）。 */
export function prTertile(pr: number): BenchmarkTertile {
  const x = pr * 3;
  return x >= 200 ? 'prTop' : x >= 100 ? 'prMid' : 'prBottom';
}

/** 組名（中文，機器人與沒有翻譯時用；網站另有 i18n）。 */
export function benchmarkLabel(id: BenchmarkId, maxGames: number): string {
  switch (id) {
    case 'casual': return `散客（<${maxGames}場）`;
    case 'regular': return '排除散客後全體';
    case 'prTop': return '排除散客後 前1/3';
    case 'prMid': return '排除散客後 中間1/3';
    default: return '排除散客後 後1/3';
  }
}

export function benchmarkLabelEn(id: BenchmarkId, maxGames: number): string {
  switch (id) {
    case 'casual': return `Casuals (<${maxGames} games)`;
    case 'regular': return 'All excl. casuals';
    case 'prTop': return 'Excl. casuals, top third';
    case 'prMid': return 'Excl. casuals, middle third';
    default: return 'Excl. casuals, bottom third';
  }
}

/** 理論表的欄位（篩選後這組的全部座位）。 */
export interface BenchmarkTheory extends OutcomeRates {
  roleTheory: number;
  positionTheory: number;
  overallTheory: number;
  finalWinRate: number;
  sparseRoles: number;
  sparseSeats: number;
  sparseCells: number;
  populationShare: number;
  /** 座位數。 */
  games: number;
  from: string;
  to: string;
}

export interface BenchmarkAssassin {
  hits: number;
  attempts: number;
  hitRate: number | null;
}

export interface BenchmarkGroup {
  id: BenchmarkId;
  label: string;
  labelEn: string;
  /** 有結果的局裡、這組的座位數。 */
  seats: number;
  /** 這些座位上不同的名字數。 */
  players: number;
  /** players 區塊形狀的一列（name = label）；沒有座位時 null。 */
  row: PlayerRow | null;
  theory: BenchmarkTheory | null;
  assassin: BenchmarkAssassin;
}

export interface BenchmarksSection {
  /** 散客的門檻（生涯未滿幾場）。 */
  maxGames: number;
  /** 三等分的分界（PR × 3 與這兩個數比）：[100, 200]。 */
  tertileBounds: readonly [number, number];
  /** 依 BENCHMARK_IDS 的順序，固定五組。 */
  groups: BenchmarkGroup[];
  /** 有結果的局裡全部有名字的座位（= 散客 + 全體）。 */
  totalSeats: number;
  /** 全體裡沒有可用 PR 的座位（暫定、沒評分的局）。 */
  noPrSeats: number;
}

export interface BenchmarkOptions {
  maxGames: number;
  /** 名字（篩選後的局上看到的名字）→ 生涯場數。 */
  careers: ReadonlyMap<string, number>;
  /** 合併計算的散客名字：一律算散客。 */
  pooledName?: string;
  /** 補值用的族群率（篩選後的 overview）。 */
  roleFinalWinRates: Readonly<Record<string, number>>;
  seatFinalWinRates: Readonly<Record<string, number>>;
  roleSeatFinalWinRates: RoleSeatRates;
}

const careerCache = new WeakMap<DecodedDataset, Map<string, number>>();

/** 每個名字的生涯場數（全部局、有結果的局的座位數；filter/merge.ts 同一個定義）。每份資料集只算一次。 */
export function careerGames(decoded: DecodedDataset): Map<string, number> {
  const hit = careerCache.get(decoded);
  if (hit) return hit;
  const counts = new Map<string, number>();
  for (const g of decoded.games) {
    if (!isOutcome(g.outcome)) continue;
    for (const n of g.seatPlayers) if (n !== null) counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  careerCache.set(decoded, counts);
  return counts;
}

/** 合併計算後的生涯場數：合併後的名字 = 併進去的原始名字的生涯場數加總。 */
export function mergedCareerGames(careers: ReadonlyMap<string, number>, rename: ReadonlyMap<string, string>): Map<string, number> {
  const out = new Map<string, number>();
  for (const [name, n] of careers) {
    const to = rename.get(name) ?? name;
    out.set(to, (out.get(to) ?? 0) + n);
  }
  return out;
}

/** 這個座位那一局開打前的 PR（暫定、沒評分 = null）。`i` = SEATS 順序的索引。 */
export function seatPr(g: Pick<Game, 'lineup'>, i: number): number | null {
  const l = g.lineup;
  if (!l || l.prov[i] || typeof l.prs[i] !== 'number') return null;
  return l.prs[i];
}

/** 五組的數字（`games` = 篩選後實際計算的局，日期晚於 asOf 的已當作無日期）。 */
export function computeBenchmarks(
  games: readonly Game[],
  config: GamesDatasetConfig,
  options: BenchmarkOptions,
): BenchmarksSection {
  const { maxGames, careers, pooledName } = options;
  const labels = Object.fromEntries(BENCHMARK_IDS.map((id) => [id, benchmarkLabel(id, maxGames)])) as Record<BenchmarkId, string>;
  const isCasual = (n: string): boolean => n === pooledName || (careers.get(n) ?? 0) < maxGames;

  // 兩份改名的局：A = 散客／全體，B = 前／中間／後 1/3（其他座位當沒寫名字）。局物件只換 seatPlayers。
  const names: Record<BenchmarkId, Set<string>> = {
    casual: new Set(), regular: new Set(), prTop: new Set(), prMid: new Set(), prBottom: new Set(),
  };
  let totalSeats = 0;
  let noPrSeats = 0;
  const passA: Game[] = [];
  const passB: Game[] = [];
  const renamed = (g: Game, seats: Array<string | null>): Game => ({
    ...g, seatPlayers: seats, namedSeats: seats.filter((x) => x !== null).length,
  });
  for (const g of games) {
    if (!isOutcome(g.outcome)) continue;
    const a: Array<string | null> = [];
    const b: Array<string | null> = [];
    g.seatPlayers.forEach((n, i) => {
      let ga: BenchmarkId | null = null;
      let gb: BenchmarkId | null = null;
      if (n !== null) {
        totalSeats += 1;
        if (isCasual(n)) ga = 'casual';
        else {
          ga = 'regular';
          const pr = seatPr(g, i);
          if (pr === null) noPrSeats += 1;
          else gb = prTertile(pr);
        }
        for (const id of [ga, gb]) if (id) names[id].add(n);
      }
      a.push(ga && labels[ga]);
      b.push(gb && labels[gb]);
    });
    passA.push(renamed(g, a));
    passB.push(renamed(g, b));
  }

  const rows = new Map<string, PlayerRow>();
  const theories = new Map<string, BenchmarkTheory>();
  const assassins = new Map<string, BenchmarkAssassin>();
  const minCell = Number(config.leaderboard.theoryMinCellGames);
  for (const pass of [passA, passB]) {
    const tallies = playerTallies(pass);
    const timelines = playerTimelines(pass);
    const list: PlayerRow[] = [];
    for (const [name, t] of tallies) {
      const seats = timelines.get(name) ?? [];
      const row = t.toRow(name, options.roleFinalWinRates) as PlayerRow;
      row.theory = playerTheory(seats, options.roleFinalWinRates, options.seatFinalWinRates, config.leaderboard, options.roleSeatFinalWinRates);
      list.push(row);
      const career = row.theory.career;
      theories.set(name, {
        roleTheory: career.roleTheory,
        positionTheory: career.positionTheory,
        overallTheory: career.overallTheory as number,
        finalWinRate: career.finalWinRate,
        sparseRoles: career.sparseRoles,
        sparseSeats: career.sparseSeats,
        sparseCells: career.sparseCells as number,
        populationShare: career.populationShare as number,
        games: seats.length,
        from: career.from,
        to: career.to,
        ...missionAssassination(seats),
      });
      const attempts = seats.filter((s) => s.role === '刺客' && (s.outcome === OUTCOME_BLUE_DEAD || s.outcome === OUTCOME_BLUE_ALIVE));
      const hits = attempts.filter((s) => s.outcome === OUTCOME_BLUE_DEAD).length;
      assassins.set(name, { hits, attempts: attempts.length, hitRate: attempts.length ? rate(hits, attempts.length) : null });
    }
    const seatOutcomes = computeSeatOutcomesPerPlayer(pass, list);
    for (const row of list) {
      row.seatOutcomes = seatOutcomes.get(row.name) ?? {};
      rows.set(row.name, row);
    }
  }

  const groups: BenchmarkGroup[] = BENCHMARK_IDS.map((id) => {
    const label = labels[id];
    const row = rows.get(label) ?? null;
    return {
      id,
      label,
      labelEn: benchmarkLabelEn(id, maxGames),
      seats: row ? row.totalGames : 0,
      players: names[id].size,
      row,
      theory: theories.get(label) ?? null,
      assassin: assassins.get(label) ?? { hits: 0, attempts: 0, hitRate: null },
    };
  });
  return { maxGames, tertileBounds: [100, 200], groups, totalSeats, noPrSeats };
}
