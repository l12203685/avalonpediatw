/**
 * 分組統計（九宮格）的共用工具（Edward 2026-11-11）。
 *
 * ── 慣例 ────────────────────────────────────────────────────────────────────
 * 凡是討論的數字樣本太小（例：兩紅之後的派隊、關鍵票，中位數的玩家每格只有 6 次左右），不看個人、改看合併的組：
 * 依玩家的 PR 分 強者／一般人／新手，或切成 S × PR 的 3×3 九宮格：
 *   列 = 玩家（那個事件的那一局開打前、這個座位的 PR）  強者 PR ≥ prHi、一般人 prLo ≤ PR < prHi、新手 PR < prLo
 *   欄 = 桌（那一局的 S = 10 個座位開打前 PR 的平均）   高端 S ≥ sHi、普通 sLo ≤ S < sHi、歡樂 S < sLo
 * 每格都附樣本數（事件數）與人數；列合計（依玩家分層）、欄合計（依桌分層）與全體一起給。之後新的統計要分組時，
 * 事件換成 CohortRecord 交給 cohortGrid，畫面用 web 的 components/analysis/cohort/CohortGrid。
 * ───────────────────────────────────────────────────────────────────────────
 *
 * PR 的定義與網站其他 PR 一樣（benchmarks.ts seatPr、dataset.ts lineup）：那一局開打前、在「生涯已 ≥30 場」的玩家池裡的
 * Elo 百分等級（0–100 整數），每日產生資料時在全部局上算好、存在每局的 lineup，不隨篩選或時間窗改變。暫定座位（當時生涯
 * 未滿 30 場）、沒寫名字的座位、沒評分的局（玩家池太小、舊資料）沒有可用的 PR → 未評分（只算在合計與全體）。
 * 同一位玩家不同時期的 PR 不同，所以他的事件可能分在不同組；「人數」是那一組裡不同的名字數。
 * S = lineup.s（strength.ts S_TIERS 用的同一個值；暫定與沒寫名字的座位 PR 最高 50，照樣算進 S）。沒評分的局 → 未評分。
 *
 * 切點（四個都可以調，預設）：
 *   prHi = 80、prLo = 20：基準列的 前 20%／中間／後 20%（benchmarks.ts prGroup 的預設，下界含、上界不含）。
 *   sHi = 55、sLo = 38：陣容強度 S_TIERS 的分界（高端 = 高強度 + 偏強、普通 = 一般、歡樂 = 偏弱）。
 * 分界一律下界含、上界不含。PR 是整數，切點也限整數；S 有一位小數，切點可以有一位小數。
 */
import { DEFAULT_BENCHMARK_CUTS, seatPr } from './benchmarks';
import { SEATS } from './constants';
import type { Game } from './dataset';
import { S_TIERS } from './strength';

export const PLAYER_TIERS = ['strong', 'regular', 'novice'] as const;
export type PlayerTier = (typeof PLAYER_TIERS)[number];
export type PlayerTierKey = PlayerTier | 'unrated';
export const PLAYER_TIER_KEYS: readonly PlayerTierKey[] = [...PLAYER_TIERS, 'unrated'];

export const TABLE_TIERS = ['high', 'normal', 'casual'] as const;
export type TableTier = (typeof TABLE_TIERS)[number];
export type TableTierKey = TableTier | 'unrated';
export const TABLE_TIER_KEYS: readonly TableTierKey[] = [...TABLE_TIERS, 'unrated'];

/** 組名（中文；網站另有 i18n）。 */
export const PLAYER_TIER_LABELS: Readonly<Record<PlayerTierKey, string>> = { strong: '強者', regular: '一般人', novice: '新手', unrated: '未評分' };
export const TABLE_TIER_LABELS: Readonly<Record<TableTierKey, string>> = { high: '高端', normal: '普通', casual: '歡樂', unrated: '未評分' };

/** 四個切點：玩家 PR 的上下切點、桌 S 的上下切點。 */
export interface CohortCuts {
  prHi: number;
  prLo: number;
  sHi: number;
  sLo: number;
}

/** 預設切點：PR 80／20（= 基準列預設的前 20%／後 20%）、S 55／38（= S_TIERS 偏強、一般的下界）。 */
export const DEFAULT_COHORT_CUTS: Readonly<CohortCuts> = {
  prHi: 100 - DEFAULT_BENCHMARK_CUTS.top,
  prLo: DEFAULT_BENCHMARK_CUTS.bottom,
  sHi: S_TIERS.find((t) => t.id === 'strong')!.min,
  sLo: S_TIERS.find((t) => t.id === 'normal')!.min,
};

/** 切點的範圍：1–99（含）；PR 切點是整數、S 切點最多一位小數；上 > 下。 */
export const COHORT_CUT_LIMITS = { min: 1, max: 99 } as const;

const inRange = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
  && n >= COHORT_CUT_LIMITS.min && n <= COHORT_CUT_LIMITS.max;
const oneDecimal = (n: number): boolean => Math.abs(Math.round(n * 10) - n * 10) < 1e-9;

/** 合法的切點：都在 1–99、PR 是整數、S 最多一位小數、上切點 > 下切點。 */
export function validCohortCuts(c: unknown): c is CohortCuts {
  const v = c as Partial<CohortCuts> | null;
  if (!v || typeof v !== 'object') return false;
  const { prHi, prLo, sHi, sLo } = v;
  if (!inRange(prHi) || !inRange(prLo) || !inRange(sHi) || !inRange(sLo)) return false;
  if (!Number.isInteger(prHi) || !Number.isInteger(prLo) || !oneDecimal(sHi) || !oneDecimal(sLo)) return false;
  return prHi > prLo && sHi > sLo;
}

export function isDefaultCohortCuts(c: CohortCuts): boolean {
  return c.prHi === DEFAULT_COHORT_CUTS.prHi && c.prLo === DEFAULT_COHORT_CUTS.prLo
    && c.sHi === DEFAULT_COHORT_CUTS.sHi && c.sLo === DEFAULT_COHORT_CUTS.sLo;
}

/** 分享連結的寫法：「prHi-prLo-sHi-sLo」（例 80-20-55-38）。 */
export function encodeCohortCuts(c: CohortCuts): string {
  return [c.prHi, c.prLo, c.sHi, c.sLo].join('-');
}

/** 「80-20-55-38」→ 切點；不合法 → null。 */
export function decodeCohortCuts(text: string | null | undefined): CohortCuts | null {
  const parts = (text ?? '').split('-');
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,2}(\.\d)?$/.test(p))) return null;
  const [prHi, prLo, sHi, sLo] = parts.map(Number);
  const cuts = { prHi, prLo, sHi, sLo };
  return validCohortCuts(cuts) ? cuts : null;
}

/** 這個 PR 屬於哪一組：PR ≥ prHi 強者、PR ≥ prLo 一般人、其他新手；沒有 PR → 未評分。 */
export function playerTier(pr: number | null | undefined, cuts: CohortCuts = DEFAULT_COHORT_CUTS): PlayerTierKey {
  if (typeof pr !== 'number') return 'unrated';
  return pr >= cuts.prHi ? 'strong' : pr >= cuts.prLo ? 'regular' : 'novice';
}

/** 這個 S 屬於哪一組：S ≥ sHi 高端、S ≥ sLo 普通、其他歡樂；沒有 S → 未評分。 */
export function tableTier(s: number | null | undefined, cuts: CohortCuts = DEFAULT_COHORT_CUTS): TableTierKey {
  if (typeof s !== 'number') return 'unrated';
  return s >= cuts.sHi ? 'high' : s >= cuts.sLo ? 'normal' : 'casual';
}

/** 一個座位在那一局的 PR 與那一局的 S（`i` = SEATS 順序的索引；沒有 = null）。 */
export function seatCohort(g: Pick<Game, 'lineup'>, i: number): { pr: number | null; s: number | null } {
  return { pr: seatPr(g, i), s: g.lineup ? g.lineup.s : null };
}

/** 座位字元 → SEATS 的索引（不是座位 = -1）。 */
export const seatIndex = (seat: string): number => (SEATS as readonly string[]).indexOf(seat);

// ── 九宮格 ────────────────────────────────────────────────────────────────

/**
 * 一筆事件（或同一局同一座位的幾個事件合起來）：誰（沒寫名字 = null）、哪一局、他的 PR、那一局的 S、
 * 事件數 n，與各分類（或對／錯…）的次數 counts（長度 = cohortGrid 的 width；意義由呼叫端決定）。
 */
export interface CohortRecord {
  player: string | null;
  game: number;
  pr: number | null;
  s: number | null;
  n: number;
  counts: readonly number[];
}

/** 一格：事件數、各分類次數、不同的名字數、不同的局數。 */
export interface CohortCell {
  n: number;
  counts: number[];
  players: number;
  games: number;
}

/** 3×3（＋未評分）：cells[玩家分層][桌分層]、rows = 依玩家分層合計、cols = 依桌分層合計、all = 全體。 */
export interface CohortGrid {
  cuts: CohortCuts;
  width: number;
  cells: Record<PlayerTierKey, Record<TableTierKey, CohortCell>>;
  rows: Record<PlayerTierKey, CohortCell>;
  cols: Record<TableTierKey, CohortCell>;
  all: CohortCell;
}

class Acc {
  n = 0;
  counts: number[];
  players = new Set<string>();
  games = new Set<number>();
  constructor(width: number) {
    this.counts = new Array<number>(width).fill(0);
  }
  add(r: CohortRecord): void {
    this.n += r.n;
    for (let k = 0; k < this.counts.length; k += 1) this.counts[k] += r.counts[k] ?? 0;
    if (r.player !== null) this.players.add(r.player);
    this.games.add(r.game);
  }
  cell(): CohortCell {
    return { n: this.n, counts: [...this.counts], players: this.players.size, games: this.games.size };
  }
}

/** 事件 → 九宮格（含未評分的列與欄）＋列合計、欄合計、全體。 */
export function cohortGrid(records: Iterable<CohortRecord>, cuts: CohortCuts = DEFAULT_COHORT_CUTS, width = 1): CohortGrid {
  const cellAcc = {} as Record<PlayerTierKey, Record<TableTierKey, Acc>>;
  const rowAcc = {} as Record<PlayerTierKey, Acc>;
  const colAcc = {} as Record<TableTierKey, Acc>;
  for (const p of PLAYER_TIER_KEYS) {
    rowAcc[p] = new Acc(width);
    cellAcc[p] = {} as Record<TableTierKey, Acc>;
    for (const t of TABLE_TIER_KEYS) cellAcc[p][t] = new Acc(width);
  }
  for (const t of TABLE_TIER_KEYS) colAcc[t] = new Acc(width);
  const allAcc = new Acc(width);
  for (const r of records) {
    const p = playerTier(r.pr, cuts);
    const t = tableTier(r.s, cuts);
    cellAcc[p][t].add(r);
    rowAcc[p].add(r);
    colAcc[t].add(r);
    allAcc.add(r);
  }
  const cells = {} as CohortGrid['cells'];
  const rows = {} as CohortGrid['rows'];
  const cols = {} as CohortGrid['cols'];
  for (const p of PLAYER_TIER_KEYS) {
    rows[p] = rowAcc[p].cell();
    cells[p] = {} as Record<TableTierKey, CohortCell>;
    for (const t of TABLE_TIER_KEYS) cells[p][t] = cellAcc[p][t].cell();
  }
  for (const t of TABLE_TIER_KEYS) cols[t] = colAcc[t].cell();
  return { cuts: { ...cuts }, width, cells, rows, cols, all: allAcc.cell() };
}

/** 幾個分類合起來的次數（例：第 4 局「最多一個紅方」= 全好 + 只有莫德雷德 + 只含一拇指）。 */
export function cohortSum(cell: Pick<CohortCell, 'counts'>, indexes: readonly number[]): number {
  return indexes.reduce((s, k) => s + (cell.counts[k] ?? 0), 0);
}

// ── 分布（切點合不合理）────────────────────────────────────────────────────

/**
 * 篩選後的局裡 PR 與 S 的分布：
 *   seatPr    有名字的座位的 PR 次數（索引 = PR 0..100）；seatUnrated = 有名字但沒有 PR 的座位數
 *   playerPr  每位玩家最近一局（篩選範圍內、有 PR 的）的 PR 次數；playerUnrated = 從來沒有 PR 的名字數
 *   gameS     局的 S 次數（索引 = S × 10，0..1000）；gameUnrated = 沒評分的局數
 */
export interface CohortHistogram {
  seatPr: number[];
  seatUnrated: number;
  playerPr: number[];
  playerUnrated: number;
  gameS: number[];
  gameUnrated: number;
}

/** 每位玩家在這些局裡最近一局有 PR 的 PR（局依 seq 排序）。 */
export function latestPlayerPr(games: readonly Game[]): Map<string, number> {
  const out = new Map<string, number>();
  const sorted = [...games].sort((a, b) => a.seq - b.seq);
  for (const g of sorted) {
    g.seatPlayers.forEach((name, i) => {
      if (name === null) return;
      const pr = seatPr(g, i);
      if (pr !== null) out.set(name, pr);
    });
  }
  return out;
}

export function cohortHistogram(games: readonly Game[]): CohortHistogram {
  const seatPrHist = new Array<number>(101).fill(0);
  const playerPrHist = new Array<number>(101).fill(0);
  const gameS = new Array<number>(1001).fill(0);
  let seatUnrated = 0;
  let gameUnrated = 0;
  const names = new Set<string>();
  for (const g of games) {
    if (g.lineup) gameS[Math.min(1000, Math.max(0, Math.round(g.lineup.s * 10)))] += 1;
    else gameUnrated += 1;
    g.seatPlayers.forEach((name, i) => {
      if (name === null) return;
      names.add(name);
      const pr = seatPr(g, i);
      if (pr === null) seatUnrated += 1;
      else seatPrHist[Math.min(100, Math.max(0, Math.round(pr)))] += 1;
    });
  }
  const latest = latestPlayerPr(games);
  for (const pr of latest.values()) playerPrHist[Math.min(100, Math.max(0, Math.round(pr)))] += 1;
  return { seatPr: seatPrHist, seatUnrated, playerPr: playerPrHist, playerUnrated: names.size - latest.size, gameS, gameUnrated };
}

/** 次數表（索引 i 的值 = i ÷ scale）依兩個切點分三份：hi = 值 ≥ hiCut、mid、lo = 值 < loCut。 */
export function histogramSplit(hist: readonly number[], hiCut: number, loCut: number, scale = 1): { hi: number; mid: number; lo: number; total: number } {
  let hi = 0;
  let mid = 0;
  let lo = 0;
  hist.forEach((c, i) => {
    const v = i / scale;
    // 浮點：S 的索引是 S × 10 的整數，切點最多一位小數，用整數比
    const vi = Math.round(v * 10);
    if (vi >= Math.round(hiCut * 10)) hi += c;
    else if (vi >= Math.round(loCut * 10)) mid += c;
    else lo += c;
  });
  return { hi, mid, lo, total: hi + mid + lo };
}

/**
 * 三等分的切點：最小的值 v 使得「< v 的次數」≥ 1/3、≥ 2/3（切在值的邊界上；同一個值不會被拆開，所以三份不一定剛好各 1/3）。
 * 回傳 { lo, hi }（值的單位；沒有資料 = null）。
 */
export function histogramTerciles(hist: readonly number[], scale = 1): { lo: number; hi: number } | null {
  const total = hist.reduce((s, c) => s + c, 0);
  if (total === 0) return null;
  const cut = (q: number): number => {
    let below = 0;
    for (let i = 0; i < hist.length; i += 1) {
      // 切點 = 下一個值：< i 的次數第一次到 q 時，切在 i
      if (below >= q * total) return i / scale;
      below += hist[i];
    }
    return (hist.length - 1) / scale;
  };
  return { lo: cut(1 / 3), hi: cut(2 / 3) };
}
