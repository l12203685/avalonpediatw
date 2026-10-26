import { useEffect, useState } from 'react';
import {
  fetchAnalysisPlayers,
  getErrorMessage,
  outcomeBlocks,
  roleFaction,
  type AnalysisOverview,
  type AnalysisPlayerStats,
  type ChemistryMatrix,
  type OutcomeBlocks,
  type OutcomeCounts,
  type OutcomeFaction,
} from '../../services/api';
import type { MetricBlockKey, MetricBlockValues } from './ui';
import { filterScopedLoader } from '../../stats/filterScopedLoader';

/**
 * 「位置」「角色與默契」兩個分頁的資料整理 (2026-10-14 Edward：「角色勝率那邊應該分三塊」+「用條件機率」)。
 *
 * 只做加總與挑欄位；三塊結果 (任務 / 刺殺 / 遊戲) 一律交給 @avalon/shared 的 outcomeBlocks
 * (經 services/api 匯出)，不在這裡重算比率。來源 (兩份快取 schemaVersion 3、4 都有，除非另註)：
 *  - overview.seatPositionWinRates[].roles[].outcomes：每個位置 × 角色的 三紅／三藍死／三藍活 局數
 *    (全部對局；每局每個位置都有一個角色，所以同一位置的紅方 = 四個紅方角色加總)。
 *  - players[].roleOutcomes (schemaVersion 4)：各玩家各角色的局數；全部玩家加總 = 有名字的座位，
 *    和 overview.roleFinalWinRates 同一個分母 (角色理論補值用的全體勝率)。
 *  - players[].roleSeatStats ("角色|座號" → 場數、任務結果的勝場)：玩家 × 位置 × 陣營的 n。
 *  - players[].seatOutcomes：玩家坐這個位置的全部對局 (紅藍都有) 的三種結果局數。
 *  - chemistry.outcomePair：兩人共同場次的三種結果 % (一位小數) 與共同場數。
 */

/** 角色固定順序：紅方四個 → 藍方三個 (與 RoleFinalWinRates 舊版相同)。 */
export const ROLE_ORDER: readonly string[] = ['刺客', '莫甘娜', '莫德雷德', '奧伯倫', '派西維爾', '梅林', '忠臣'];

/** players[] 的座位鍵 ('0' = 10 號)，顯示順序 1..10。 */
export const PLAYER_SEAT_KEYS: readonly string[] = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];

/** 座位顯示號碼：players[] 的 '0' 是 10 號；overview / roleSeatStats 已經寫成 '10'。 */
export function seatNumber(seat: string): string {
  return seat === '0' ? '10' : seat;
}

type BreakdownLike = { threeRed?: number; threeBlueDead?: number; threeBlueAlive?: number } | null | undefined;

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

function emptyCounts(): OutcomeCounts {
  return { 三紅: 0, 三藍死: 0, 三藍活: 0 };
}

function addBreakdown(acc: OutcomeCounts, o: BreakdownLike): void {
  acc.三紅 += num(o?.threeRed);
  acc.三藍死 += num(o?.threeBlueDead);
  acc.三藍活 += num(o?.threeBlueAlive);
}

function hasBreakdown(o: BreakdownLike): boolean {
  return !!o && typeof o === 'object' && ['threeRed', 'threeBlueDead', 'threeBlueAlive'].every(
    k => typeof (o as Record<string, unknown>)[k] === 'number',
  );
}

/** OutcomeBlocks → MetricBlocks 的一列 (win 0–100，n = 分母)；沒有資料時三格都是「—」。 */
export function blockValues(b: OutcomeBlocks | null | undefined): MetricBlockValues {
  const cell = (k: MetricBlockKey): { win: number | null; n: number | null } =>
    b ? { win: b[k].win, n: b[k].n } : { win: null, n: null };
  return { mission: cell('mission'), assassination: cell('assassination'), final: cell('final') };
}

// ── 位置：全體 ────────────────────────────────────────────────────────────────

export interface SeatFactionCounts {
  /** overview 的座位鍵 "1".."10"。 */
  seat: string;
  red: OutcomeCounts;
  blue: OutcomeCounts;
  /** 每個角色在這個位置的局數。 */
  roles: Record<string, OutcomeCounts>;
}

/**
 * 每個位置 × 陣營 (與 × 角色) 的三種結果局數；任何一格缺 roles[].outcomes (更舊的快取) 就回 null，
 * 呼叫端顯示「下次每日更新後提供」，不拿 0 充數。
 */
export function seatFactionCounts(overview: AnalysisOverview | null | undefined): SeatFactionCounts[] | null {
  const seats = overview?.seatPositionWinRates;
  if (!Array.isArray(seats) || seats.length === 0) return null;
  const out: SeatFactionCounts[] = [];
  for (const s of seats) {
    if (!Array.isArray(s.roles) || s.roles.length === 0 || !s.roles.every(r => hasBreakdown(r.outcomes))) return null;
    const row: SeatFactionCounts = { seat: String(s.seat), red: emptyCounts(), blue: emptyCounts(), roles: {} };
    for (const r of s.roles) {
      const counts = emptyCounts();
      addBreakdown(counts, r.outcomes);
      row.roles[r.role] = counts;
      addBreakdown(roleFaction(r.role) === 'red' ? row.red : row.blue, r.outcomes);
    }
    out.push(row);
  }
  return out.sort((a, b) => Number(a.seat) - Number(b.seat));
}

// ── 角色：全體 ────────────────────────────────────────────────────────────────

export interface RolePopulation {
  /** 各角色的三種結果局數 (有名字的座位)；舊快取為 null。 */
  counts: Record<string, OutcomeCounts> | null;
  /** 各角色場數 (Σ players[].rawRoleGames，有名字的座位 = roleFinalWinRates 的分母)；沒有時 null。 */
  games: Record<string, number> | null;
}

/**
 * 全部玩家各角色加總。roleOutcomes (schemaVersion 4) 每位玩家都有才算 counts，
 * 不然整個 null (半套加總會比全體少，不如不顯示)。
 */
export function rolePopulation(players: readonly AnalysisPlayerStats[] | null | undefined): RolePopulation {
  if (!players || players.length === 0) return { counts: null, games: null };
  let counts: Record<string, OutcomeCounts> | null = {};
  let games: Record<string, number> | null = {};
  for (const p of players) {
    const ro = p.roleOutcomes;
    if (counts && ro && typeof ro === 'object') {
      for (const [role, c] of Object.entries(ro)) {
        const acc = counts[role] ?? (counts[role] = emptyCounts());
        acc.三紅 += num(c?.三紅);
        acc.三藍死 += num(c?.三藍死);
        acc.三藍活 += num(c?.三藍活);
      }
    } else {
      counts = null;
    }
    const rg = p.rawRoleGames;
    if (games && rg && typeof rg === 'object') {
      for (const [role, n] of Object.entries(rg)) games[role] = (games[role] ?? 0) + num(n);
    } else {
      games = null;
    }
  }
  return { counts, games };
}

// ── 玩家 × 位置 ───────────────────────────────────────────────────────────────

/** players[].roleSeatStats ("角色|座號"，座號 1..10)；services/api 的型別沒列，這裡補上。 */
export type RoleSeatStats = Record<string, { games: number; wins: number; winRate?: number }>;
export type PlayerWithSeatStats = AnalysisPlayerStats & { roleSeatStats?: RoleSeatStats };

export type SeatMode = 'all' | OutcomeFaction;

/**
 * 玩家在這個位置 (players[] 的座位鍵) 的場數：全部 / 紅方 / 藍方。roleSeatStats 沒有時 null
 * (舊快取；那時只有比率，沒有 n)。
 */
export function playerSeatGames(p: PlayerWithSeatStats, seat: string, mode: SeatMode): number | null {
  const stats = p.roleSeatStats;
  if (!stats || typeof stats !== 'object') return null;
  const label = seatNumber(seat);
  let games = 0;
  for (const role of ROLE_ORDER) {
    if (mode !== 'all' && roleFaction(role) !== mode) continue;
    games += num(stats[`${role}|${label}`]?.games);
  }
  return games;
}

/** 玩家在這個位置的「自己陣營任務結果」勝率 % (快取欄位 seatWinRates / seatRedWinRates / seatBlueWinRates)。 */
export function playerSeatRate(p: AnalysisPlayerStats, seat: string, mode: SeatMode): number | null {
  const src = mode === 'red' ? p.seatRedWinRates : mode === 'blue' ? p.seatBlueWinRates : p.seatWinRates;
  const v = src?.[seat];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** 玩家坐這個位置的全部對局 (紅藍都有) 的三塊結果，從 `faction` 這方看；沒有 seatOutcomes 時 null。 */
export function playerSeatGameBlocks(p: AnalysisPlayerStats, seat: string, faction: OutcomeFaction): OutcomeBlocks | null {
  const so = p.seatOutcomes?.[seat];
  return hasBreakdown(so) ? outcomeBlocks(so, faction) : null;
}

// ── 默契：兩人共同場次 ───────────────────────────────────────────────────────

/**
 * outcomePair 一格的三種結果局數。快取只存 % (一位小數) 與共同場數 games；共同場數 < 1000 時
 * round(pct × games / 100) 還原出來的整數就是原本的局數 (誤差 ≤ 0.05% × 999 < 0.5 局)，兩份快取
 * 每一格三個數加起來都等於 games。還原不一致 (加總 ≠ games) 或場數太大就回 null，不顯示。
 */
export function pairOutcomeCounts(m: ChemistryMatrix | null | undefined, ri: number, ci: number): OutcomeCounts | null {
  const games = m?.games?.[ri]?.[ci];
  const red = m?.values?.[ri]?.[ci];
  const dead = m?.threeBlueDeadPct?.[ri]?.[ci];
  const alive = m?.threeBlueAlivePct?.[ri]?.[ci];
  if (typeof games !== 'number' || !(games > 0) || games >= 1000) return null;
  if (typeof red !== 'number' || typeof dead !== 'number' || typeof alive !== 'number') return null;
  const counts: OutcomeCounts = {
    三紅: Math.round((red * games) / 100),
    三藍死: Math.round((dead * games) / 100),
    三藍活: Math.round((alive * games) / 100),
  };
  return counts.三紅 + counts.三藍死 + counts.三藍活 === games ? counts : null;
}

// ── /players 每個篩選只抓一次 ─────────────────────────────────────────────────

const playersLoader = filterScopedLoader(() => fetchAnalysisPlayers()
  .then(({ players }) => (Array.isArray(players) ? (players as PlayerWithSeatStats[]) : [])));

export interface PlayersState {
  players: PlayerWithSeatStats[] | null;
  loading: boolean;
  error: string | null;
}

/** /api/analysis/players (module 級快取：玩家 × 位置、各角色勝率兩個小分頁共用一次請求)。 */
export function useAnalysisPlayerRows(): PlayersState {
  const [state, setState] = useState<PlayersState>(() => {
    const cached = playersLoader.peek();
    return { players: cached, loading: cached === null, error: null };
  });
  useEffect(() => {
    if (playersLoader.peek()) return undefined;
    let cancelled = false;
    playersLoader.load()
      .then(players => { if (!cancelled) setState({ players, loading: false, error: null }); })
      .catch(err => { if (!cancelled) setState({ players: null, loading: false, error: getErrorMessage(err) }); });
    return (): void => { cancelled = true; };
  }, []);
  return state;
}

// ── 版面 ─────────────────────────────────────────────────────────────────────

function wideQuery(): MediaQueryList | null {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(min-width: 640px)')
      : null;
  } catch {
    return null;
  }
}

/**
 * 視窗寬度 ≥ 640px (Tailwind sm)。三塊結果表在手機上不印規則說明 (表頭變窄，三塊在 390px 寬也放得下)，
 * 桌機照印。
 */
export function useIsWide(): boolean {
  const [wide, setWide] = useState<boolean>(() => wideQuery()?.matches ?? true);
  useEffect(() => {
    const mq = wideQuery();
    if (!mq) return undefined;
    const onChange = (): void => setWide(mq.matches);
    mq.addEventListener?.('change', onChange);
    return (): void => mq.removeEventListener?.('change', onChange);
  }, []);
  return wide;
}
