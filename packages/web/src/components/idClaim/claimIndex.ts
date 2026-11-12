/**
 * ID 認領頁的資料與計算（Edward 2026-11-03：玩家說「這幾個 ID 是我」，不用登入，管理者核准）。
 *
 * 資料 = 數據分析已在用的每局資料集（/api/analysis/games，Worker 解碼一次；stats/statsCompute.ts computeClaimData
 * 縮成這裡的 ClaimData），不另外下載。名字是正式名字：player_aliases.json 的別名在每日產生資料時已併入，
 * `aliases`（別名 → 正式名字）用來標示「已合併」。
 */
import { BLUE_ROLES, RED_ROLES } from '@avalon/shared/stats';

/** 一局：日期、當日第幾場（0 = 不明）、SEATS 順序（1..9、0 家）的名字與角色、哪方贏（'' = 不明）。 */
export interface ClaimGame {
  seq: number;
  date: string;
  slot: number;
  players: Array<string | null>;
  roles: string[];
  winner: 'red' | 'blue' | '';
}

export interface ClaimData {
  asOf: string;
  players: string[];
  aliases: Record<string, string>;
  games: ClaimGame[];
}

export interface IdSummary {
  name: string;
  games: number;
  /** 有日期的局裡最早／最晚的日期（都沒有日期 = ''）。 */
  first: string;
  last: string;
  /** 這個 ID 的局（ClaimData.games 的索引），新的在前。 */
  gameIdx: number[];
}

/** 只差大小寫／全半形／空白算同一個（比照 generate_cache 的 player_name_key）。 */
export function nameKey(name: string): string {
  return name.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** 座位索引（SEATS 順序）→ 1-based 座位號（10 = 0 家；顯示用 displaySeatNumber 寫成 0）。 */
export function seatNumber(index: number): number {
  return index + 1;
}

/** 新的在前：日期、當日場次、合併順序。 */
function newerFirst(a: ClaimGame, b: ClaimGame): number {
  if (a.date !== b.date) return a.date < b.date ? 1 : -1;
  if (a.slot !== b.slot) return b.slot - a.slot;
  return b.seq - a.seq;
}

/** 每個 ID 的場數、日期範圍、局。 */
export function buildIdIndex(data: ClaimData): Map<string, IdSummary> {
  const index = new Map<string, IdSummary>();
  for (const name of data.players) index.set(name, { name, games: 0, first: '', last: '', gameIdx: [] });
  const order = data.games.map((_, i) => i).sort((a, b) => newerFirst(data.games[a], data.games[b]));
  for (const i of order) {
    const g = data.games[i];
    const seen = new Set<string>();
    for (const p of g.players) {
      if (!p || seen.has(p)) continue;
      seen.add(p);
      let s = index.get(p);
      if (!s) {
        s = { name: p, games: 0, first: '', last: '', gameIdx: [] };
        index.set(p, s);
      }
      s.games += 1;
      s.gameIdx.push(i);
      if (g.date) {
        if (!s.first || g.date < s.first) s.first = g.date;
        if (!s.last || g.date > s.last) s.last = g.date;
      }
    }
  }
  return index;
}

/** 已經被別名併進 `name` 的寫法。 */
export function mergedInto(name: string, aliases: Record<string, string>): string[] {
  return Object.entries(aliases).filter(([, to]) => to === name).map(([from]) => from);
}

export interface SearchHit {
  name: string;
  games: number;
  last: string;
  /** 這個寫法已經是別名：併進了哪位（不能再選）。 */
  aliasOf?: string;
}

/** 搜尋：完全相同 > 開頭相同 > 包含；同一級場數多的在前。別名寫法也列出（標示已併入誰）。 */
export function searchIds(
  query: string,
  data: Pick<ClaimData, 'aliases'>,
  index: Map<string, IdSummary>,
  exclude: ReadonlySet<string>,
  limit = 8,
): SearchHit[] {
  const q = nameKey(query);
  if (!q) return [];
  const rank = (name: string): number => {
    const k = nameKey(name);
    if (k === q) return 0;
    if (k.startsWith(q)) return 1;
    return k.includes(q) ? 2 : -1;
  };
  const hits: Array<SearchHit & { r: number }> = [];
  for (const s of index.values()) {
    if (exclude.has(s.name)) continue;
    const r = rank(s.name);
    if (r >= 0) hits.push({ name: s.name, games: s.games, last: s.last, r });
  }
  for (const [from, to] of Object.entries(data.aliases)) {
    if (index.has(from)) continue;
    const r = rank(from);
    if (r >= 0) hits.push({ name: from, games: 0, last: '', aliasOf: to, r: r + 0.5 });
  }
  hits.sort((a, b) => a.r - b.r || b.games - a.games || a.name.localeCompare(b.name));
  return hits.slice(0, limit).map(({ r: _r, ...hit }) => hit);
}

export type GameResult = '勝' | '敗' | '';

export interface IdGameRow {
  game: ClaimGame;
  seat: number;
  role: string;
  result: GameResult;
  /** 同桌其他人（座位順序，沒寫名字的不列）。 */
  mates: string[];
}

/** `name` 在這局的座位、角色、勝負、同桌。 */
export function idGameRow(game: ClaimGame, name: string): IdGameRow | null {
  const i = game.players.indexOf(name);
  if (i < 0) return null;
  const role = game.roles[i] ?? '';
  const side = RED_ROLES.has(role) ? 'red' : BLUE_ROLES.has(role) ? 'blue' : '';
  const result: GameResult = !side || !game.winner ? '' : side === game.winner ? '勝' : '敗';
  const mates = game.players.filter((p, j): p is string => j !== i && p !== null);
  return { game, seat: seatNumber(i), role, result, mates };
}

export interface SameGameConflict {
  game: ClaimGame;
  seats: Array<{ name: string; seat: number }>;
}

/** 選的 ID 裡有兩個以上同一局都在桌上（那就不可能是同一個人）。 */
export function sameGameConflicts(names: string[], data: ClaimData, index: Map<string, IdSummary>): SameGameConflict[] {
  const chosen = new Set(names);
  const games = new Set<number>();
  for (const n of chosen) for (const i of index.get(n)?.gameIdx ?? []) games.add(i);
  const out: SameGameConflict[] = [];
  for (const i of games) {
    const g = data.games[i];
    const seats = g.players
      .map((p, j) => (p && chosen.has(p) ? { name: p, seat: seatNumber(j) } : null))
      .filter((s): s is { name: string; seat: number } => s !== null);
    if (seats.length >= 2) out.push({ game: g, seats });
  }
  return out.sort((a, b) => newerFirst(a.game, b.game));
}

/** 「2026-10-31 第 7 場」；沒有日期／場次就省略那一半。 */
export function gameLabel(game: Pick<ClaimGame, 'date' | 'slot'>): string {
  const parts = [game.date || '日期不明'];
  if (game.slot > 0) parts.push(`第 ${game.slot} 場`);
  return parts.join(' ');
}

/** 「2024-03-02 – 2026-10-31」；只有一天就一個日期。 */
export function dateRange(s: Pick<IdSummary, 'first' | 'last'>): string {
  if (!s.first) return '日期不明';
  return s.first === s.last ? s.first : `${s.first} – ${s.last}`;
}
