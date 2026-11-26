/**
 * AI 擂台的統計：座位安排（可重現）、本機測試的成對報表、排行榜 JSON。全部是純函式。
 */
import { seededRandom } from '../ai/benchmark/agreement';
import { fitRatings, pairedMean, wilson, type Interval, type SideRating } from './rating';
import { DEFAULT_AGENT_TUNING } from '../ai/AgentTuning';
import { ARENA_KNOBS } from './knobs';
import { profileKnobSummary } from './profile';
import { REFERENCE_ID, REFERENCE_NAME, type RegisteredBot } from './registry';
import type { Outcome, TableResult } from './table';
import type { RunKind, Trend } from './daily';

// ── 座位安排 ─────────────────────────────────────────────

/** 本機測試第 i 局：哪些座位（加入順序）是你的機器人。`botSeats` 預設一半。 */
export function localBotMask(seed: string, i: number, playerCount: number, botSeats?: number): boolean[] {
  const k = Math.max(1, Math.min(playerCount, botSeats ?? Math.floor(playerCount / 2)));
  const rnd = seededRandom(`${seed}|${i}|local-seats`);
  const order = Array.from({ length: playerCount }, (_, s) => s);
  for (let s = order.length - 1; s > 0; s--) {
    const j = Math.floor(rnd() * (s + 1));
    [order[s], order[j]] = [order[j], order[s]];
  }
  const mask = new Array<boolean>(playerCount).fill(false);
  for (const s of order.slice(0, k)) mask[s] = true;
  return mask;
}

/** 擂台第 i 局：人數（從 `sizes` 抽）與每個座位坐誰（從名冊均勻抽，可重複）。 */
export function tournamentSeating(seed: string, i: number, entrantIds: readonly string[], sizes: readonly number[]): { playerCount: number; seats: string[] } {
  const rnd = seededRandom(`${seed}|${i}|arena-seats`);
  const playerCount = sizes[Math.floor(rnd() * sizes.length)];
  const seats = Array.from({ length: playerCount }, () => entrantIds[Math.floor(rnd() * entrantIds.length)]);
  return { playerCount, seats };
}

/** `--players` 的值：「10」或「5-10」。 */
export function parseSizes(spec: string): number[] {
  const m = /^(\d+)(?:-(\d+))?$/.exec(spec.trim());
  if (!m) throw new Error(`--players 要是 10 或 5-10，收到「${spec}」`);
  const lo = Number(m[1]); const hi = Number(m[2] ?? m[1]);
  if (lo < 5 || hi > 10 || lo > hi) throw new Error('--players 只能在 5 到 10 之間');
  return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
}

/** 局號 → 人數：本機測試的 `--players`（單一人數或 5-10 輪流）。 */
export function localPlayerCount(sizes: readonly number[], i: number): number {
  return sizes[i % sizes.length];
}

// ── 本機測試報表 ───────────────────────────────────────────

export interface LocalPair { bot: TableResult; control: TableResult }

export interface PairedStat {
  games: number;
  /** 你的機器人坐在這裡時，這一邊贏的比例。 */
  bot: Interval;
  /** 同樣的局全部換成百科AI 時，這一邊贏的比例。 */
  control: Interval;
  /** 成對差（百分點用 ×100）。 */
  diff: { mean: number; low: number; high: number; n: number };
}

export type OutcomeSplit = Record<Outcome, number>;

export interface LocalReport {
  bot: string;
  games: number;
  sides: { evil: PairedStat; good: PairedStat };
  roles: Record<string, PairedStat>;
  outcomes: { bot: OutcomeSplit; control: OutcomeSplit };
  /** 你的機器人出手刺殺（三藍）時刺中梅林的比例；對照 = 同一個座位在百科AI 那局的刺中率。 */
  assassin: { bot: Interval; control: Interval };
}

function paired(rows: { bot: boolean; control: boolean }[]): PairedStat {
  const kb = rows.filter((r) => r.bot).length;
  const kc = rows.filter((r) => r.control).length;
  return {
    games: rows.length,
    bot: wilson(kb, rows.length),
    control: wilson(kc, rows.length),
    diff: pairedMean(rows.map((r) => (r.bot ? 1 : 0) - (r.control ? 1 : 0))),
  };
}

function split(tables: readonly TableResult[]): OutcomeSplit {
  const n = tables.length || 1;
  const c = (o: Outcome): number => tables.filter((t) => t.outcome === o).length / n;
  return { threeRed: c('threeRed'), merlinKilled: c('merlinKilled'), threeBlue: c('threeBlue') };
}

export function localReport(pairs: readonly LocalPair[], botId: string): LocalReport {
  const sideRows: Record<'evil' | 'good', { bot: boolean; control: boolean }[]> = { evil: [], good: [] };
  const roleRows: Record<string, { bot: boolean; control: boolean }[]> = {};
  let hitB = 0; let triesB = 0; let hitC = 0; let triesC = 0;
  for (const { bot, control } of pairs) {
    const mine = bot.seats.map((s, i) => ({ s, i })).filter(({ s }) => s.entrant === botId);
    for (const side of ['evil', 'good'] as const) {
      if (mine.some(({ s }) => s.team === side)) sideRows[side].push({ bot: bot.winner === side, control: control.winner === side });
    }
    for (const role of new Set(mine.map(({ s }) => s.role))) {
      const team = mine.find(({ s }) => s.role === role)!.s.team;
      (roleRows[role] ??= []).push({ bot: bot.winner === team, control: control.winner === team });
    }
    for (const { s, i } of mine) {
      if (s.assassinHit !== undefined) { triesB++; if (s.assassinHit) hitB++; }
      const c = control.seats[i];
      if (c?.assassinHit !== undefined) { triesC++; if (c.assassinHit) hitC++; }
    }
  }
  const roles: Record<string, PairedStat> = {};
  for (const role of ['merlin', 'percival', 'loyal', 'assassin', 'morgana', 'mordred', 'oberon']) {
    if (roleRows[role]) roles[role] = paired(roleRows[role]);
  }
  return {
    bot: botId,
    games: pairs.length,
    sides: { evil: paired(sideRows.evil), good: paired(sideRows.good) },
    roles,
    outcomes: { bot: split(pairs.map((p) => p.bot)), control: split(pairs.map((p) => p.control)) },
    assassin: { bot: wilson(hitB, triesB), control: wilson(hitC, triesC) },
  };
}

// ── 排行榜 ───────────────────────────────────────────────

export const LEADERBOARD_SCHEMA = 1;

export interface LeaderboardBot {
  rank: number;
  id: string;
  name: string;
  /** 作者自己選擇公開的 GitHub 帳號；百科AI、示範對手與官方 AI騎士 為 null。 */
  author: string | null;
  source: RegisteredBot['source'];
  /** 稱號（侍從／騎士／圓桌騎士…，之後的「代理騎士」用）；沒有就是 null。 */
  title: string | null;
  /** 風格標籤（依玩家風格建立的 AI騎士 才有）；沒有就是 null。 */
  tag: string | null;
  style: string;
  knobs: string[];
  rating: { overall: SideRating; red: SideRating; blue: SideRating };
  /** 坐過的座位數（一局可能坐好幾個座位）與出現的局數。 */
  seats: number;
  games: number;
  red: { seats: number; winRate: number };
  blue: { seats: number; winRate: number };
  assassin: { tries: number; hits: number };
}

export interface Leaderboard {
  schema: number;
  generatedAt: string;
  seed: string;
  games: number;
  sizes: number[];
  reference: string;
  method: string;
  baseRedWin: Record<number, number>;
  bots: LeaderboardBot[];
  /** 沒收進名冊的社群資料夾（只有 id 與原因）。 */
  rejected: { id: string; errors: string[] }[];
  /** 開放的開關（網站的說明與「給你的 AI 的提示」用，和 knobs.ts 同一份）。 */
  knobCatalog: KnobCatalogEntry[];
  /** 每日大賽（`arena:daily aggregate`）才有：今天與累計局數、這一輪怎麼跑的。 */
  daily?: DailyInfo;
  /** 每日大賽才有：最近幾天的總分走勢。 */
  trend?: Trend;
}

export interface DailyInfo {
  /** 台北日期。 */
  date: string;
  /** 這一輪：每日排程／合併到 main 後補跑／手動。 */
  kind: RunKind;
  gamesToday: number;
  runsToday: number;
  /** 開始每日大賽以來總共打了幾局（歷史快照加總）。 */
  gamesTotal: number;
  shards: number;
  /** 某一片失敗時少掉的局數（0 = 全部到齊）。 */
  missingGames: number;
  gamesPerSecPerRunner: number;
  slowestShardSec: number;
}

export interface KnobCatalogEntry {
  key: string;
  kind: 'number' | 'boolean';
  side: 'good' | 'evil' | 'assassin';
  min?: number;
  max?: number;
  default: number | boolean;
  zh: string;
  en: string;
}

export function knobCatalog(): KnobCatalogEntry[] {
  return ARENA_KNOBS.map((k) => {
    const e: KnobCatalogEntry = {
      key: k.key,
      kind: k.kind,
      side: k.side,
      default: (DEFAULT_AGENT_TUNING as unknown as Record<string, number | boolean>)[k.key],
      zh: k.zh,
      en: k.en,
    };
    if (k.kind === 'number') { e.min = k.min; e.max = k.max; }
    return e;
  });
}

const REFERENCE_STYLE = '網站上正在跑的AI騎士_百科（目前訓練出來的引擎、正式預設，沒有改任何開關）。所有分數都以它為 1500。';

export function buildLeaderboard(args: {
  bots: readonly RegisteredBot[];
  tables: readonly TableResult[];
  seed: string;
  sizes: readonly number[];
  generatedAt: string;
  rejected?: { id: string; errors: string[] }[];
}): Leaderboard {
  const ids = args.bots.map((b) => b.id);
  const fit = fitRatings(args.tables, ids, REFERENCE_ID);
  const byId = new Map(fit.ratings.map((r) => [r.id, r]));
  const round1 = (x: number): number => Math.round(x * 10) / 10;
  const roundSide = (s: SideRating): SideRating => ({ rating: round1(s.rating), low: round1(s.low), high: round1(s.high) });
  const rows: LeaderboardBot[] = args.bots.map((b) => {
    let seats = 0; let games = 0; let rs = 0; let rw = 0; let bs = 0; let bw = 0; let tries = 0; let hits = 0;
    for (const t of args.tables) {
      const mine = t.seats.filter((s) => s.entrant === b.id);
      if (mine.length === 0) continue;
      games++;
      for (const s of mine) {
        seats++;
        if (s.team === 'evil') { rs++; if (s.won) rw++; } else { bs++; if (s.won) bw++; }
        if (s.assassinHit !== undefined) { tries++; if (s.assassinHit) hits++; }
      }
    }
    const r = byId.get(b.id)!;
    return {
      rank: 0,
      id: b.id,
      name: b.profile?.name ?? REFERENCE_NAME,
      author: b.source === 'community' || b.source === 'extra' ? b.profile?.author ?? null : null,
      source: b.source,
      title: b.title ?? null,
      tag: b.profile?.tag ?? null,
      style: b.profile?.style ?? REFERENCE_STYLE,
      knobs: b.profile ? profileKnobSummary(b.profile) : [],
      rating: { overall: roundSide(r.overall), red: roundSide(r.red), blue: roundSide(r.blue) },
      seats,
      games,
      red: { seats: rs, winRate: rs ? Math.round((rw / rs) * 1000) / 1000 : 0 },
      blue: { seats: bs, winRate: bs ? Math.round((bw / bs) * 1000) / 1000 : 0 },
      assassin: { tries, hits },
    };
  });
  rows.sort((a, b) => b.rating.overall.rating - a.rating.overall.rating || a.id.localeCompare(b.id));
  rows.forEach((r, i) => { r.rank = i + 1; });
  const baseRedWin: Record<number, number> = {};
  for (const [k, v] of Object.entries(fit.baseRedWin)) baseRedWin[Number(k)] = Math.round(v * 1000) / 1000;
  return {
    schema: LEADERBOARD_SCHEMA,
    generatedAt: args.generatedAt,
    seed: args.seed,
    games: args.tables.length,
    sizes: [...args.sizes],
    reference: REFERENCE_ID,
    method: '每局隨機座位、每個座位隨機抽一隻機器人（可重複），角色由引擎發。分數 = 分陣營的隊伍邏輯回歸（AI騎士_百科 = 1500；+100 分 ≈ 一整邊換成它時勝算 ×1.78），區間 = 95% 信賴區間。',
    baseRedWin,
    bots: rows,
    rejected: args.rejected ?? [],
    knobCatalog: knobCatalog(),
  };
}
