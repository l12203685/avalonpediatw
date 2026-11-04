/**
 * 強者分面群組（Edward 2026-11-04；docs/ai/strong_metrics.md）。取代「角色王」（原始角色勝率會挑到整體打得不好的角色專家）。
 *
 * 1. **母體（pool）**：網站 Elo（analysis_cache.json → rating.players）非暫定、生涯 ≥ 50 場的人裡，Elo 前 20%（目前 10 人）。
 * 2. **高強度局**：桌上平均開打前 Elo（games_cache.json 的 lineup 第 4 欄 = 每個座位 Elo×10）在所有局的前 30%
 *    （目前 ≥ 1501、1659 局裡 498 局）。
 * 3. **分面**（分開看，絕不混成一個勝率）：
 *    (a) 任務階段：藍方贏在三藍死或三藍活、紅方贏在三紅（反映派隊／投票／湖／任務）。在高強度局裡，
 *        每一局的「任務階段贏 − 該角色在高強度局的平均」→ 每人每個陣營的平均超額（紅方任務／藍方任務）；
 *        每個角色的超額向那個人的陣營超額收縮（K = `shrinkK`，小樣本 ≈ 陣營超額），陣營超額本身向 0 收縮（同一個 K）。
 *    (b) 刺客刺中率：當刺客時 三藍死 / (三藍死 + 三藍活)；
 *    (c) 梅林存活率：當梅林時 三藍活 / (三藍死 + 三藍活)。
 *        (b)(c) 先用高強度局；那個人的高強度樣本 < `minRateSample` 就改用全部局（`basis`）。
 *        值 = 同一組局的平均率 + 收縮後的超額（向平均收縮，K = `rateShrinkK`）。
 * 4. 每個分面在母體裡排名，取前 3／前 5。
 *
 * 公開 repo：任何會進 commit 的輸出只能寫「分面＋名次」（例如 紅方任務王#1、刺客刺中王#2，`facetLabel`）；
 * 名字只在記憶體裡、只有命令列 `--names` 時才印到主控台。
 *
 * 資料解析和 scratchpad 的 kings.py 相同：config 字串的第 i 個字元是 configRoleOrder 第 i 個角色的座位（'0' = 10 號位）、
 * 其他座位是忠臣；outcome 0 三紅、1 三藍死、2 三藍活；分類「百科AI」不算；座位有未知玩家（-1）不算。
 */
import type { Role } from '@avalon/shared';
import { EVIL_ROLES, ROLE_CODE_ORDER } from '../benchmark/sheetsReplay';

export const OUTCOME_RED = 0;
export const OUTCOME_BLUE_DEAD = 1;
export const OUTCOME_BLUE_ALIVE = 2;

/** 一局（只取分面要用的欄位）：座位 1..10 的名字、角色、結果、桌上平均 Elo（沒有 lineup = null）。 */
export interface CohortGame {
  id: string;
  names: string[];
  roles: Role[];
  outcome: 0 | 1 | 2;
  avgElo: number | null;
}

export interface RatingRow {
  name: string;
  elo: number;
  games: number;
  provisional: boolean;
}

export interface DatasetLike {
  fields: readonly string[];
  vocab: { category?: readonly string[]; outcome: readonly string[] };
  players: readonly string[];
  games: readonly (readonly unknown[])[];
}

const BOT_CATEGORY = '百科AI';

function seatOfChar(ch: string): number {
  return ch === '0' ? 10 : ch.charCodeAt(0) - 48;
}

/** games_cache.json → 分面用的局（寬鬆版：只要角色、結果、十個已知玩家；不需要能重播）。 */
export function cohortGamesFromDataset(d: DatasetLike): CohortGame[] {
  const at = (name: string): number => d.fields.indexOf(name);
  const [iId, iCat, iCfg, iOut, iSeats, iLineup] = ['id', 'cat', 'config', 'outcome', 'seats', 'lineup'].map(at);
  const out: CohortGame[] = [];
  for (const g of d.games) {
    if (d.vocab.category?.[g[iCat] as number] === BOT_CATEGORY) continue;
    const outcome = g[iOut] as number;
    if (outcome !== 0 && outcome !== 1 && outcome !== 2) continue;
    const cfg = String(g[iCfg] ?? '');
    if (!/^[0-9]{6}$/.test(cfg) || new Set(cfg).size !== 6) continue;
    const seats = g[iSeats] as number[];
    if (!Array.isArray(seats) || seats.length !== 10 || seats.some((s) => s < 0)) continue;
    const roles: Role[] = new Array<Role>(10).fill('loyal');
    for (let i = 0; i < 6; i++) roles[seatOfChar(cfg[i]) - 1] = ROLE_CODE_ORDER[i];
    const lineup = g[iLineup] as unknown[] | undefined;
    const elo = Array.isArray(lineup) && lineup.length >= 5 && Array.isArray(lineup[4]) ? (lineup[4] as number[]) : null;
    out.push({
      id: String(g[iId]),
      names: seats.map((s) => d.players[s] ?? ''),
      roles,
      outcome: outcome as 0 | 1 | 2,
      avgElo: elo && elo.length === 10 ? elo.reduce((a, x) => a + x / 10, 0) / 10 : null,
    });
  }
  return out;
}

/** 母體：非暫定、≥ minGames 場的人依 Elo 由高到低，取前 floor(n × topShare) 人。 */
export function strongPool(rating: readonly RatingRow[], opts: { topShare?: number; minGames?: number } = {}): string[] {
  const share = opts.topShare ?? 0.2;
  const minGames = opts.minGames ?? 50;
  const eligible = rating.filter((p) => !p.provisional && p.games >= minGames).sort((a, b) => b.elo - a.elo || a.name.localeCompare(b.name));
  return eligible.slice(0, Math.floor(eligible.length * share)).map((p) => p.name);
}

/** 高強度門檻：有平均 Elo 的局由低到高排，第 floor(n × (1 − topShare)) 個的值；平均 Elo ≥ 門檻 = 高強度。 */
export function intensityThreshold(games: readonly CohortGame[], topShare = 0.3): number {
  const avg = games.map((g) => g.avgElo).filter((x): x is number => x !== null).sort((a, b) => a - b);
  if (avg.length === 0) return Number.POSITIVE_INFINITY;
  return avg[Math.min(avg.length - 1, Math.floor(avg.length * (1 - topShare)))];
}

export function isHighIntensity(g: Pick<CohortGame, 'avgElo'>, threshold: number): boolean {
  return g.avgElo !== null && g.avgElo >= threshold;
}

export const isRed = (r: Role): boolean => EVIL_ROLES.has(r);

/** 任務階段贏（紅：三紅；藍：三藍死或三藍活）。 */
export function missionStageWin(role: Role, outcome: number): number {
  return isRed(role) ? (outcome === OUTCOME_RED ? 1 : 0) : outcome !== OUTCOME_RED ? 1 : 0;
}

export type FacetId =
  | 'redMission'
  | 'blueMission'
  | 'assassinHit'
  | 'merlinSurvival'
  | `mission:${Role}`;

export const MISSION_ROLES: readonly Role[] = ['merlin', 'percival', 'loyal', 'assassin', 'morgana', 'mordred', 'oberon'];
const ROLE_ZH: Record<string, string> = {
  merlin: '梅林', percival: '派西', loyal: '忠臣', assassin: '刺客', morgana: '莫甘娜', mordred: '莫德雷德', oberon: '奧伯倫',
};

export function facetName(f: FacetId): string {
  switch (f) {
    case 'redMission': return '紅方任務王';
    case 'blueMission': return '藍方任務王';
    case 'assassinHit': return '刺客刺中王';
    case 'merlinSurvival': return '梅林存活王';
    default: return `${ROLE_ZH[f.slice(8)] ?? f.slice(8)}任務王`;
  }
}

/** 公開用的稱呼：「紅方任務王#1」。 */
export function facetLabel(f: FacetId, rank: number): string {
  return `${facetName(f)}#${rank}`;
}

export interface FacetEntry {
  name: string;
  /** 排名用的值：任務分面 = 收縮後的超額；比率分面 = 平均率 + 收縮後的超額。 */
  value: number;
  /** 沒收縮的值（任務 = 平均超額；比率 = 原始率）。 */
  raw: number;
  n: number;
  /** 比率分面用哪一組局。 */
  basis: 'hi' | 'all';
}

export interface StrongCohortOptions {
  /** 任務分面的收縮 K（預設 20，同 games_cache config.excessShrinkK）。 */
  shrinkK?: number;
  /** 刺中率／存活率的收縮 K（預設 10）。 */
  rateShrinkK?: number;
  /** 刺中率／存活率：高強度樣本少於這個就改用全部局（預設 15）。 */
  minRateSample?: number;
}

export interface StrongCohorts {
  pool: string[];
  threshold: number;
  games: number;
  hiGames: number;
  /** 高強度局每個角色的任務階段平均贏率。 */
  roleAverage: Record<string, number>;
  /** 平均率（刺中、存活），高強度局與全部局。 */
  rateAverage: { assassinHit: { hi: number; all: number }; merlinSurvival: { hi: number; all: number } };
  /** 每個分面：母體每一個人，依 value 由高到低。 */
  facets: Record<string, FacetEntry[]>;
}

const mean = (s: number, n: number): number => (n > 0 ? s / n : 0);

/** 算母體每一個人的各分面（見檔頭）。 */
export function computeStrongCohorts(
  games: readonly CohortGame[],
  pool: readonly string[],
  threshold: number,
  opts: StrongCohortOptions = {},
): StrongCohorts {
  const K = opts.shrinkK ?? 20;
  const KR = opts.rateShrinkK ?? 10;
  const minRate = opts.minRateSample ?? 15;
  const hi = games.filter((g) => isHighIntensity(g, threshold));
  // 高強度局每個角色的任務階段平均。
  const rs: Record<string, [number, number]> = {};
  for (const g of hi) g.roles.forEach((r) => { const c = (rs[r] ??= [0, 0]); c[0] += missionStageWin(r, g.outcome); c[1]++; });
  const roleAverage = Object.fromEntries(Object.entries(rs).map(([r, [s, n]]) => [r, mean(s, n)]));
  // 刺中、存活的平均率。
  const rateOf = (set: readonly CohortGame[], kind: 'assassinHit' | 'merlinSurvival'): number => {
    let s = 0; let n = 0;
    for (const g of set) { if (g.outcome === OUTCOME_RED) continue; n++; s += kind === 'assassinHit' ? (g.outcome === OUTCOME_BLUE_DEAD ? 1 : 0) : (g.outcome === OUTCOME_BLUE_ALIVE ? 1 : 0); }
    return mean(s, n);
  };
  const rateAverage = {
    assassinHit: { hi: rateOf(hi, 'assassinHit'), all: rateOf(games, 'assassinHit') },
    merlinSurvival: { hi: rateOf(hi, 'merlinSurvival'), all: rateOf(games, 'merlinSurvival') },
  };
  const poolSet = new Set(pool);
  type Sum = { s: number; n: number };
  const camp: Record<string, { red: Sum; blue: Sum }> = {};
  const role: Record<string, Record<string, Sum>> = {};
  const rate: Record<string, Record<'assassinHit' | 'merlinSurvival', { hi: Sum; all: Sum }>> = {};
  for (const name of pool) {
    camp[name] = { red: { s: 0, n: 0 }, blue: { s: 0, n: 0 } };
    role[name] = Object.fromEntries(MISSION_ROLES.map((r) => [r, { s: 0, n: 0 }]));
    rate[name] = { assassinHit: { hi: { s: 0, n: 0 }, all: { s: 0, n: 0 } }, merlinSurvival: { hi: { s: 0, n: 0 }, all: { s: 0, n: 0 } } };
  }
  for (const g of games) {
    const isHi = isHighIntensity(g, threshold);
    g.names.forEach((name, k) => {
      if (!poolSet.has(name)) return;
      const r = g.roles[k];
      if (isHi) {
        const e = missionStageWin(r, g.outcome) - (roleAverage[r] ?? 0);
        const c = camp[name][isRed(r) ? 'red' : 'blue'];
        c.s += e; c.n++;
        const rr = role[name][r]; rr.s += e; rr.n++;
      }
      if (g.outcome === OUTCOME_RED) return;
      const kind = r === 'assassin' ? 'assassinHit' : r === 'merlin' ? 'merlinSurvival' : null;
      if (!kind) return;
      const hit = kind === 'assassinHit' ? (g.outcome === OUTCOME_BLUE_DEAD ? 1 : 0) : (g.outcome === OUTCOME_BLUE_ALIVE ? 1 : 0);
      const t = rate[name][kind];
      t.all.s += hit; t.all.n++;
      if (isHi) { t.hi.s += hit; t.hi.n++; }
    });
  }
  const facets: Record<string, FacetEntry[]> = {};
  const sortDesc = (xs: FacetEntry[]): FacetEntry[] => xs.sort((a, b) => b.value - a.value || b.n - a.n || a.name.localeCompare(b.name));
  for (const side of ['red', 'blue'] as const) {
    facets[side === 'red' ? 'redMission' : 'blueMission'] = sortDesc(pool.map((name) => {
      const c = camp[name][side];
      return { name, value: c.s / (c.n + K), raw: mean(c.s, c.n), n: c.n, basis: 'hi' as const };
    }));
  }
  for (const r of MISSION_ROLES) {
    facets[`mission:${r}`] = sortDesc(pool.map((name) => {
      const c = camp[name][isRed(r) ? 'red' : 'blue'];
      const campShrunk = c.s / (c.n + K);
      const x = role[name][r];
      return { name, value: (x.s + K * campShrunk) / (x.n + K), raw: mean(x.s, x.n), n: x.n, basis: 'hi' as const };
    }));
  }
  for (const kind of ['assassinHit', 'merlinSurvival'] as const) {
    facets[kind] = sortDesc(pool.map((name) => {
      const t = rate[name][kind];
      const basis = t.hi.n >= minRate ? 'hi' : 'all';
      const x = t[basis];
      const avg = rateAverage[kind][basis];
      return { name, value: avg + (x.s - avg * x.n) / (x.n + KR), raw: mean(x.s, x.n), n: x.n, basis };
    }));
  }
  return { pool: [...pool], threshold, games: games.length, hiGames: hi.length, roleAverage, rateAverage, facets };
}

/** 分面的前 k 名（名字；只在記憶體裡用）。 */
export function topOf(c: StrongCohorts, facet: FacetId, k: number): string[] {
  return (c.facets[facet] ?? []).slice(0, k).map((e) => e.name);
}

/** name 在分面的名次（1 起；不在母體 = 0）。 */
export function rankIn(c: StrongCohorts, facet: FacetId, name: string): number {
  const i = (c.facets[facet] ?? []).findIndex((e) => e.name === name);
  return i < 0 ? 0 : i + 1;
}

export type DecisionKind = 'team' | 'vote' | 'quest' | 'lakeTarget' | 'lakeClaim' | 'assassinate';

/**
 * 每一種決策對到哪一個分面（Edward 2026-11-04）：
 *   藍方角色（忠臣、派西）的派隊／投票／湖 → 藍方任務王；梅林的派隊／投票／湖（梅林風格）→ 梅林存活王；
 *   紅方角色的派隊／投票／湖／任務牌 → 紅方任務王；刺殺 → 刺客刺中王。
 */
export function decisionFacet(role: Role, kind: DecisionKind): FacetId {
  if (kind === 'assassinate') return 'assassinHit';
  if (isRed(role)) return 'redMission';
  if (role === 'merlin') return 'merlinSurvival';
  return 'blueMission';
}

/** 這個人在這種決策的分面是不是前 k 名。 */
export function inFacetTop(c: StrongCohorts, role: Role, kind: DecisionKind, name: string, k: number): boolean {
  const r = rankIn(c, decisionFacet(role, kind), name);
  return r > 0 && r <= k;
}

/** 不含名字的摘要（可以寫進檔案）：每個分面的名次、樣本數、值。 */
export function publicSummary(c: StrongCohorts, k = 5): Record<string, unknown> {
  return {
    pool: c.pool.length,
    threshold: Math.round(c.threshold * 10) / 10,
    games: c.games,
    hiGames: c.hiGames,
    roleAverage: Object.fromEntries(Object.entries(c.roleAverage).map(([r, v]) => [r, Math.round(v * 1000) / 1000])),
    rateAverage: c.rateAverage,
    facets: Object.fromEntries(Object.entries(c.facets).map(([f, es]) => [f, es.slice(0, k).map((e, i) => ({
      label: facetLabel(f as FacetId, i + 1), value: Math.round(e.value * 1000) / 1000, raw: Math.round(e.raw * 1000) / 1000, n: e.n, basis: e.basis,
    }))])),
  };
}
