/**
 * 合併計算（Edward 2026-11-03「你能夠把 場數未滿30場的人 併成同一個人嗎 或是我希望你可以增加一個功能 類似把某幾個人
 * 戰績合併計算」）：篩選的 options.merge（自訂幾組名字當成同一位玩家）與 options.mergeSmall（生涯場數未滿 N 的人
 * 併成一位「散客（<N場）」）。
 *
 * 做法：在管線最一開始（任何子句之前）把每局座位的名字改掉，得到一份「改名後的資料集」，之後的子句、選人、
 * 各區塊（排行、玩家表、默契、陣容強度、自動發現…）都只看到合併後的名字，彼此一致。
 *
 *  - 先套自訂合併，再數生涯場數：自訂合併後的人看合併後的總場數；自訂合併的名字（`as`）不會再被併進散客。
 *  - 生涯場數 = 全部局（不看任何子句、不看基準日）中有結果（三紅／三藍死／三藍活）的座位數，與玩家條件「場數」
 *    看全部局時的值相同。
 *  - 同一局可以有好幾位散客（或同一組的兩個名字）：合併後的名字佔好幾個座位。玩家的數字照引擎原本的規則逐座位算
 *    （場數 = 座位次數，一局兩位散客算兩場，勝率是逐座位的加權）；默契／配對每局只算一次（同名佔兩席不和自己配對）。
 *  - 沒有合併選項時完全不經過這裡（結果與快取逐欄相同）。
 */
import { isOutcome } from '../constants';
import type { DecodedDataset, Game } from '../dataset';
import { MERGE_LIMITS, type FilterOptions, type MergeGroup } from './types';

/** 散客的名字。 */
export function pooledPlayerName(maxGames: number): string {
  return `散客（<${maxGames}場）`;
}

export interface MergeGroupReport {
  as: string;
  /** 對到資料集的名字（合併進 `as` 的人）。 */
  names: string[];
  unresolved?: string[];
}

export interface MergeReport {
  groups: MergeGroupReport[];
  /** 散客：名字、門檻、併進去的人數。 */
  pooled?: { name: string; maxGames: number; players: number };
  /** 改了名字的原始名字數。 */
  renamed: number;
}

export interface MergeResult {
  decoded: DecodedDataset;
  /** 原始名字 → 合併後的名字（只有改了的）。 */
  rename: Map<string, string>;
  report: MergeReport;
}

export function hasMergeOptions(options: FilterOptions | null | undefined): boolean {
  return Boolean(options && ((options.merge && options.merge.length) || options.mergeSmall));
}

const cache = new WeakMap<DecodedDataset, Map<string, MergeResult>>();
const CACHE_SIZE = 4;

/**
 * 改名後的資料集（同一份資料集、同樣的合併只算一次，局物件與 players 列的評估快取才能沿用）。
 * `resolve`：名字 → 資料集的正式名字（apply.ts resolvePlayerName，含別名）。
 */
export function mergedDataset(
  decoded: DecodedDataset,
  options: FilterOptions,
  resolve: (name: string) => string | undefined,
): MergeResult {
  // ① 自訂合併：名字對到資料集；一個名字出現在好幾組時第一組算數
  const groupOf = new Map<string, string>();
  const targets = new Set<string>();
  const groups: MergeGroupReport[] = [];
  for (const g of options.merge ?? []) {
    const as = g.as.trim();
    const names: string[] = [];
    const unresolved: string[] = [];
    for (const raw of g.names) {
      const n = resolve(raw);
      if (n === undefined) unresolved.push(raw);
      else if (!groupOf.has(n)) {
        groupOf.set(n, as);
        names.push(n);
      }
    }
    if (names.length) targets.add(as);
    groups.push({ as, names, ...(unresolved.length ? { unresolved } : {}) });
  }
  const maxGames = options.mergeSmall?.maxGames;
  const key = JSON.stringify([[...groupOf], maxGames ?? null]);
  const hit = cache.get(decoded)?.get(key);
  if (hit) return { ...hit, report: { ...hit.report, groups } };

  const afterGroups = (n: string): string => groupOf.get(n) ?? n;
  // ② 散客：自訂合併之後的生涯場數（全部局、有結果的局的座位數）
  const pooled = new Set<string>();
  let pooledName: string | undefined;
  if (typeof maxGames === 'number') {
    pooledName = pooledPlayerName(maxGames);
    const counts = new Map<string, number>();
    for (const p of decoded.dataset.players) counts.set(afterGroups(p), counts.get(afterGroups(p)) ?? 0);
    for (const g of decoded.games) {
      if (!isOutcome(g.outcome)) continue;
      for (const n of g.seatPlayers) if (n !== null) counts.set(afterGroups(n), (counts.get(afterGroups(n)) ?? 0) + 1);
    }
    for (const [n, c] of counts) if (c < maxGames && !targets.has(n)) pooled.add(n);
  }

  // ③ 原始名字 → 最後的名字
  const rename = new Map<string, string>();
  for (const p of decoded.dataset.players) {
    const m = afterGroups(p);
    const final = pooled.has(m) ? (pooledName as string) : m;
    if (final !== p) rename.set(p, final);
  }
  const pooledPlayers = new Set<string>();
  for (const p of decoded.dataset.players) if (pooled.has(afterGroups(p))) pooledPlayers.add(p);

  let games: Game[] = decoded.games;
  let players = decoded.dataset.players;
  if (rename.size) {
    games = decoded.games.map((g) => {
      if (!g.seatPlayers.some((n) => n !== null && rename.has(n))) return g;
      return { ...g, seatPlayers: g.seatPlayers.map((n) => (n === null ? null : rename.get(n) ?? n)) };
    });
    players = [...new Set(decoded.dataset.players.map((p) => rename.get(p) ?? p))];
  }
  const result: MergeResult = {
    decoded: rename.size ? { dataset: { ...decoded.dataset, players }, games, config: decoded.config } : decoded,
    rename,
    report: {
      groups,
      ...(pooledName !== undefined ? { pooled: { name: pooledName, maxGames: maxGames as number, players: pooledPlayers.size } } : {}),
      renamed: rename.size,
    },
  };
  let byKey = cache.get(decoded);
  if (!byKey) {
    byKey = new Map();
    cache.set(decoded, byKey);
  }
  byKey.set(key, result);
  while (byKey.size > CACHE_SIZE) byKey.delete(byKey.keys().next().value as string);
  return result;
}

/** 別名表在合併後：舊名 → 合併後的名字；原始名字也當成合併後名字的別名（篩選裡打原名照樣找得到）。 */
export function mergedAliases(aliases: Readonly<Record<string, string>>, rename: ReadonlyMap<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [from, to] of Object.entries(aliases)) out[from] = rename.get(to) ?? to;
  for (const [from, to] of rename) out[from] = to;
  return out;
}

/** options.merge / mergeSmall 的驗證（sanitizeFilter 用）：不合法的組丟掉並回報。 */
export function sanitizeMergeOptions(
  o: Record<string, unknown>,
  warnings: string[],
): Pick<FilterOptions, 'merge' | 'mergeSmall'> {
  const out: Pick<FilterOptions, 'merge' | 'mergeSmall'> = {};
  if (o.merge !== undefined) {
    if (!Array.isArray(o.merge)) warnings.push('options.merge');
    else {
      const groups: MergeGroup[] = [];
      o.merge.slice(0, MERGE_LIMITS.groups).forEach((raw, i) => {
        const g = raw as Record<string, unknown> | null;
        const as = typeof g?.as === 'string' ? g.as.trim() : '';
        const names = Array.isArray(g?.names)
          ? [...new Set((g?.names as unknown[]).filter((n): n is string => typeof n === 'string')
            .map((n) => n.trim()).filter((n) => n.length > 0 && n.length <= 100))].slice(0, MERGE_LIMITS.names)
          : [];
        if (!as || as.length > MERGE_LIMITS.asLength || !names.length) {
          warnings.push(`options.merge[${i}]`);
          return;
        }
        groups.push({ names, as });
      });
      if (o.merge.length > MERGE_LIMITS.groups) warnings.push('options.merge: too many groups');
      if (groups.length) out.merge = groups;
    }
  }
  if (o.mergeSmall !== undefined && o.mergeSmall !== null && o.mergeSmall !== false) {
    const raw = o.mergeSmall as Record<string, unknown>;
    const n = raw && typeof raw === 'object' && raw.maxGames !== undefined ? raw.maxGames : MERGE_LIMITS.defaultGames;
    if (typeof n === 'number' && Number.isInteger(n) && n >= MERGE_LIMITS.minGames && n <= MERGE_LIMITS.maxGames) {
      out.mergeSmall = { maxGames: n };
    } else warnings.push('options.mergeSmall');
  }
  return out;
}
