/**
 * 篩選管線（r9 設計 §3.1）：
 *
 *   G   資料集全部局（timelineDate 已在 G 上算好）
 *   ①  局子句與玩家在局子句（AND；每個子句可 not）                         → G1
 *   ②  每個 excludePlayers 子句在評估集（預設 G、可選 G1）上選人 → D（丟局）、H（只是不上榜）
 *   ③  丟掉有任何有名字座位是 D 中的人的局（dropIncompleteGames 時連名字沒寫齊的局）  → G2
 *   ④  buildSections(G2, as-of A, activity)，⑤ H 只從名單 / 榜上拿掉（不改任何人的數字）
 *
 * 所有 excludePlayers 子句都在同一個評估集上判斷，彼此順序無關；丟局後不再重新判斷。
 * 篩選是空的（沒有子句、options 是預設）時結果 = 快取的同名區塊（一致性測試保證）。
 */
import type { Role } from '../constants';
import { buildSections, dropDatesAfter, type Sections } from '../build';
import type { DecodedDataset, Game } from '../dataset';
import { findTypedPlayerName, playerNameKey } from '../../playerNameMatch';
import { addDays, windowStart, type LeaderboardOptions } from '../leaderboard';
import { computePlayerStats, type PlayerRow } from '../players';
import type { PlayerSeat } from '../theory';
import type { PairRoster } from '../pairs';
import { compare, evaluateMetric, METRICS, type MetricContext } from './metrics';
import { clausePredicate } from './predicates';
import type { Clause, ExcludePlayersClause, GameClause, GameFilter, PlayerSelector } from './types';

/** 引擎需要的快取資訊（伺服器 /api/analysis/games 的 context 是它的超集）。 */
export interface StatsContext {
  /** 快取的 leaderboard.asOf（預設畫面與引擎永遠用同一天）。 */
  asOf: string;
  /** 快取的 players.aliases（舊名 → 正式名字；沒有就 {}）。 */
  aliases?: Record<string, string>;
  chemistryRoster?: PairRoster;
}

export interface ClauseReport {
  index: number;
  kind: Clause['kind'];
  /** 這個子句單獨會丟掉的局數（局子句；在全部局上數）。 */
  failing?: number;
  /** excludePlayers：被選中的人數、有資格的人數（PR 的母體）、評估集。 */
  selected?: number;
  eligible?: number;
  evaluatedOn?: 'unfiltered' | 'filtered';
  /** 找不到的名字（該子句不生效）。 */
  unresolved?: string[];
  inactive?: string;
}

export interface FilterMeta {
  totalGames: number;
  /** 局子句之後（G1）。 */
  gamesAfterClauses: number;
  /** 丟掉排除玩家的局之後（G2，實際計算的局）。 */
  games: number;
  droppedPlayers: number;
  hiddenPlayers: number;
  asOf: string;
  activity: 'filtered' | 'all' | 'none';
  clauses: ClauseReport[];
  unresolvedNames: string[];
  warnings: string[];
}

export interface FilterApplication {
  /** 實際計算的局（G2）。 */
  games: Game[];
  /** 只從名單 / 榜上拿掉的人。 */
  hidden: Set<string>;
  /** 丟掉他們的局的人。 */
  dropped: Set<string>;
  asOf: string;
  leaderboard: Omit<LeaderboardOptions, 'hidden'>;
  meta: FilterMeta;
}

export interface StatsResult extends Sections {
  key: string;
  filterKey: string;
  meta: FilterMeta;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** 篩選後少於這麼多局時提醒樣本小。 */
export const SMALL_SAMPLE_GAMES = 100;
/** PR 的母體少於這麼多人時提醒。 */
export const SMALL_PR_POPULATION = 10;

/** 名字（分享連結、機器人輸入）→ 資料集的正式名字：原樣、清理後、大小寫 / 全半形，再查別名。 */
export function resolvePlayerName(
  name: string,
  players: readonly string[],
  aliases: Readonly<Record<string, string>> = {},
): string | undefined {
  const direct = findTypedPlayerName(name, players);
  if (direct !== undefined) return direct;
  const key = playerNameKey(name);
  for (const [from, to] of Object.entries(aliases)) {
    if (from === name || playerNameKey(from) === key) return findTypedPlayerName(to, players);
  }
  return undefined;
}

type Resolved<T> = { clause: T; unresolved: string[] };

/** 子句裡的名字換成正式名字；找不到的名字回報，該子句不生效（不是讓結果變成空集合）。 */
function resolveClause(clause: Clause, players: readonly string[], aliases: Record<string, string>): Resolved<Clause> {
  const unresolved: string[] = [];
  const one = (n: string): string | undefined => {
    const r = resolvePlayerName(n, players, aliases);
    if (r === undefined) unresolved.push(n);
    return r;
  };
  switch (clause.kind) {
    case 'withPlayer': {
      const p = one(clause.player);
      return { clause: { ...clause, player: p ?? clause.player }, unresolved };
    }
    case 'withAnyPlayer': {
      const ps = clause.players.map(one).filter((x): x is string => x !== undefined);
      return { clause: { ...clause, players: ps }, unresolved };
    }
    case 'withPlayers': {
      const a = one(clause.players[0]);
      const b = one(clause.players[1]);
      return { clause: { ...clause, players: [a ?? clause.players[0], b ?? clause.players[1]] }, unresolved };
    }
    case 'excludePlayers': {
      if (clause.who.by !== 'names') return { clause, unresolved };
      const names = clause.who.names.map(one).filter((x): x is string => x !== undefined);
      return { clause: { ...clause, who: { ...clause.who, names } }, unresolved };
    }
    default:
      return { clause, unresolved };
  }
}

/** 有效 as-of：'auto' = min(快取 asOf, 沒有 not 的日期子句的 to)；或指定的日期。 */
export function effectiveAsOf(filter: GameFilter | null | undefined, cacheAsOf: string): string {
  const option = filter?.options?.asOf;
  if (option && option !== 'auto' && DATE_RE.test(option)) return option;
  let asOf = cacheAsOf;
  for (const c of filter?.clauses ?? []) {
    if (c.kind === 'date' && !c.not && c.to && DATE_RE.test(c.to) && c.to < asOf) asOf = c.to;
  }
  return asOf;
}

interface EvaluationSet {
  rows: PlayerRow[];
  ctx: MetricContext;
}

const unfilteredCache = new WeakMap<DecodedDataset, Map<string, EvaluationSet>>();

/** 評估集上的 players 列（未篩選：每個資料集與 asOf 只算一次）。 */
function evaluationSet(decoded: DecodedDataset, games: readonly Game[], asOf: string, memo: boolean): EvaluationSet {
  if (memo) {
    const byAsOf = unfilteredCache.get(decoded);
    const hit = byAsOf?.get(asOf);
    if (hit) return hit;
  }
  const stats = computePlayerStats(dropDatesAfter(games, asOf), decoded.config);
  const set: EvaluationSet = { rows: stats.rows, ctx: { config: decoded.config, asOf, timelines: stats.timelines } };
  if (memo) {
    let byAsOf = unfilteredCache.get(decoded);
    if (!byAsOf) {
      byAsOf = new Map();
      unfilteredCache.set(decoded, byAsOf);
    }
    byAsOf.set(asOf, set);
  }
  return set;
}

/** excludePlayers 的選人（selector 在評估集上；`set` 可以是函式：只有指標條件才需要算 players 列）。 */
export function selectPlayers(
  who: PlayerSelector,
  evaluation: EvaluationSet | (() => EvaluationSet),
  allPlayers: readonly string[],
): { selected: Set<string>; eligible: number; problem?: string } {
  if (who.by === 'names') {
    const names = new Set(who.names);
    return {
      selected: new Set(who.invert ? allPlayers.filter((n) => !names.has(n)) : who.names),
      eligible: allPlayers.length,
    };
  }
  const def = METRICS[who.metric];
  if (!def) return { selected: new Set(), eligible: 0, problem: `unknown metric ${String(who.metric)}` };
  if (def.needsRole && !who.role) return { selected: new Set(), eligible: 0, problem: 'metric needs a role' };
  const usePr = typeof who.pr === 'number';
  const threshold = usePr ? (who.pr as number) : who.value;
  if (typeof threshold !== 'number' || !Number.isFinite(threshold)) {
    return { selected: new Set(), eligible: 0, problem: 'no value or pr to compare with' };
  }
  const set = typeof evaluation === 'function' ? evaluation() : evaluation;
  const evals = evaluateMetric(set.rows, who.metric, set.ctx, who.role as Role | undefined, who.minGames);
  const selected = new Set<string>();
  let eligible = 0;
  for (const e of evals) {
    if (!e.eligible) {
      if (who.ineligible === 'select') selected.add(e.name);
      continue;
    }
    eligible += 1;
    const x = usePr ? (e.pr as number) : (e.value as number);
    const match = compare(x, who.op, threshold);
    if (who.invert ? !match : match) selected.add(e.name);
  }
  return { selected, eligible };
}

function isGameClause(c: Clause): c is GameClause {
  return c.kind !== 'excludePlayers';
}

/** 管線 ①–③：哪些局、誰被丟、誰被隱藏、as-of、排行的「近期出賽」規則。 */
export function applyFilter(decoded: DecodedDataset, context: StatsContext, filter?: GameFilter | null): FilterApplication {
  const all = decoded.games;
  const players = decoded.dataset.players;
  const aliases = { ...(decoded.dataset.aliases ?? {}), ...(context.aliases ?? {}) };
  const clauses = filter?.clauses ?? [];
  const asOf = effectiveAsOf(filter, context.asOf);
  const activity = filter?.options?.activity ?? 'filtered';
  const reports: ClauseReport[] = [];
  const unresolvedNames: string[] = [];
  const warnings: string[] = [];

  // ① 局子句與玩家在局子句
  const predicates: Array<(g: Game) => boolean> = [];
  const excludes: Array<{ clause: ExcludePlayersClause; report: ClauseReport }> = [];
  clauses.forEach((raw, index) => {
    const report: ClauseReport = { index, kind: raw.kind };
    reports.push(report);
    const { clause, unresolved } = resolveClause(raw, players, aliases);
    if (unresolved.length) {
      report.unresolved = unresolved;
      unresolvedNames.push(...unresolved);
      const usable = clause.kind === 'withAnyPlayer' ? clause.players.length > 0
        : clause.kind === 'excludePlayers' ? clause.who.by === 'names' && clause.who.names.length > 0
          : false;
      if (!usable) {
        report.inactive = 'unresolved player name';
        return;
      }
    }
    if (isGameClause(clause)) {
      const test = clausePredicate(clause);
      report.failing = all.reduce((n, g) => n + (test(g) ? 0 : 1), 0);
      predicates.push(test);
    } else {
      excludes.push({ clause, report });
    }
  });
  const g1 = predicates.length ? all.filter((g) => predicates.every((p) => p(g))) : all.slice();

  // ② 選人（全部子句在同一個評估集上）
  const dropped = new Set<string>();
  const hidden = new Set<string>();
  let dropIncomplete = false;
  let unfiltered: EvaluationSet | undefined;
  let filtered: EvaluationSet | undefined;
  for (const { clause, report } of excludes) {
    const on = clause.who.by === 'metric' && clause.who.evaluatedOn === 'filtered' ? 'filtered' : 'unfiltered';
    const set = (): EvaluationSet => (on === 'filtered'
      ? (filtered ??= evaluationSet(decoded, g1, asOf, false))
      : (unfiltered ??= evaluationSet(decoded, all, context.asOf, true)));
    const { selected, eligible, problem } = selectPlayers(clause.who, set, players);
    report.selected = selected.size;
    report.eligible = eligible;
    report.evaluatedOn = on;
    if (problem) {
      report.inactive = problem;
      continue;
    }
    if (clause.who.by === 'metric' && eligible < SMALL_PR_POPULATION) warnings.push('smallPopulation');
    for (const n of selected) (clause.scope === 'dropGames' ? dropped : hidden).add(n);
    if (clause.scope === 'dropGames' && clause.dropIncompleteGames) dropIncomplete = true;
  }

  // ③ 丟局
  const g2 = dropped.size || dropIncomplete
    ? g1.filter((g) => !(dropIncomplete && g.namedSeats < 10) && !g.seatPlayers.some((n) => n !== null && dropped.has(n)))
    : g1;
  if (g2.length < SMALL_SAMPLE_GAMES) warnings.push('smallSample');

  return {
    games: g2,
    hidden,
    dropped,
    asOf,
    leaderboard: leaderboardActivity(activity, all, asOf, decoded),
    meta: {
      totalGames: all.length,
      gamesAfterClauses: g1.length,
      games: g2.length,
      droppedPlayers: dropped.size,
      hiddenPlayers: hidden.size,
      asOf,
      activity,
      clauses: reports,
      unresolvedNames,
      warnings: [...new Set(warnings)],
    },
  };
}

/** 排行的「近期出賽 / 新人」：'filtered' = Python 在篩選後的局上的規則；'all' 看全部局；'none' 不限、不出新人榜。 */
function leaderboardActivity(
  activity: 'filtered' | 'all' | 'none',
  all: readonly Game[],
  asOf: string,
  decoded: DecodedDataset,
): Omit<LeaderboardOptions, 'hidden'> {
  if (activity === 'none') return { isActive: () => true, newcomer: 'none' };
  if (activity === 'filtered') return {};
  const cfg = decoded.config.leaderboard;
  const activeFrom = windowStart(asOf, cfg.activeDays);
  const newStart = windowStart(asOf, cfg.newcomerDays);
  // 全部局（日期晚於 asOf 的局不算）上每人的最後 / 第一個日期、有沒有無日期的局、三種結果的局的日期
  // （新人 = 第 newcomerMinGames 場在近 newcomerDays 天，與 Python 的時間線同樣只算三種結果的局）。
  const last = new Map<string, string>();
  const first = new Map<string, string>();
  const undated = new Set<string>();
  const played = new Map<string, string[]>();
  for (const g of all) {
    if (g.date && g.date > asOf) continue;
    const counted = g.outcome === '三紅' || g.outcome === '三藍死' || g.outcome === '三藍活';
    for (const n of g.seatPlayers) {
      if (!n) continue;
      if (!g.date) {
        if (counted) undated.add(n);
        continue;
      }
      if (!last.has(n) || g.date > (last.get(n) as string)) last.set(n, g.date);
      if (!first.has(n) || g.date < (first.get(n) as string)) first.set(n, g.date);
      if (counted) {
        if (!played.has(n)) played.set(n, []);
        (played.get(n) as string[]).push(g.date);
      }
    }
  }
  const m = Math.max(cfg.newcomerMinGames, 1);
  return {
    isActive: (name: string): boolean => {
      const d = last.get(name);
      return Boolean(d) && (activeFrom === null || (d as string) >= activeFrom);
    },
    newcomer: (name: string, _seats: readonly PlayerSeat[]): { firstPlayed: string; qualifiedOn: string } | null => {
      const d = first.get(name);
      const dates = [...(played.get(name) ?? [])].sort();
      if (!d || undated.has(name) || dates.length < m) return null;
      const qualifiedOn = dates[m - 1];
      if (newStart !== null && qualifiedOn < newStart) return null;
      return { firstPlayed: d, qualifiedOn };
    },
  };
}

/** 篩選物件的標準鍵（結果快取、比對用）：子句與清單排序、去掉預設值。空篩選 = ''。 */
export function canonicalFilterKey(filter: GameFilter | null | undefined): string {
  if (!filter || (!filter.clauses?.length && !hasOptions(filter))) return '';
  const norm = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      const items = value.map(norm);
      return items.every((x) => typeof x === 'string' || typeof x === 'number') ? [...items].sort() : items;
    }
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(value).sort()) {
        const v = (value as Record<string, unknown>)[k];
        if (v === undefined || v === false) continue;
        out[k] = norm(v);
      }
      return out;
    }
    return value;
  };
  const clauses = (filter.clauses ?? []).map((c) => JSON.stringify(norm(c))).sort();
  const options = norm({
    activity: filter.options?.activity === 'filtered' ? undefined : filter.options?.activity,
    asOf: filter.options?.asOf === 'auto' ? undefined : filter.options?.asOf,
  });
  return JSON.stringify({ v: 1, clauses, options });
}

function hasOptions(filter: GameFilter): boolean {
  const o = filter.options;
  return Boolean(o && ((o.activity && o.activity !== 'filtered') || (o.asOf && o.asOf !== 'auto')));
}

/**
 * 篩選後的全部區塊（overview、players、playerDetails、leaderboard）。`filter` 為空時 = 快取的區塊。
 */
export function computeStats(decoded: DecodedDataset, context: StatsContext, filter?: GameFilter | null): StatsResult {
  const app = applyFilter(decoded, context, filter);
  const built = buildSections(app.games, decoded.config, app.asOf, {
    hidden: app.hidden,
    gamesKey: decoded.dataset.key,
    leaderboard: app.leaderboard,
    aliases: { ...decoded.dataset.aliases, ...context.aliases },
    chemistryRoster: context.chemistryRoster,
  });
  return { key: decoded.dataset.key, filterKey: canonicalFilterKey(filter), meta: app.meta, ...built.sections };
}

/** 近一年：asOf 往前 364 天到 asOf（預設集 lastYear 用）。 */
export function lastYearRange(asOf: string): { from: string; to: string } {
  return { from: addDays(asOf, -364), to: asOf };
}
