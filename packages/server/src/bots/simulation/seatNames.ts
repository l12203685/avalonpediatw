/**
 * 模擬瓦 — /公布 的「1～0 家各是誰」（Edward 2026-11-20：「模擬瓦公布我說了要把ID 也一起列在座位下方」）。
 *
 * 題庫（sim_bank.json）刻意沒有名字，這裡也不把名字寫進題庫：名字在執行期從網站已經公開的牌譜紀錄清單
 * （records_cache.json，網站「牌譜紀錄」頁同一份）拿——題庫那一局對到的那一篇（recordsIndex.linkRecords，
 * 也就是 /公布 連結的那一篇）的 game.names。
 *
 * 名字照網站戰績的規則換成正式名字（player_aliases.json，generate_cache.py 同一套）：
 *   1. 拆分（splits）先套：那個名字（任何寫法、別名也算）在規則挑到的局（局號在 games 裡，或符合 from／to／venue）
 *      的座位（有寫 seat 就只有那個座位）改成規則的 as；同一個名字第一條挑到的規則算數。
 *      局號比對：那一篇的 id，加上牌譜總庫 game_db.json 同一局的所有來源 id（S…／D…／DC 貼文 id）。
 *   2. 別名（aliases）再套：舊寫法（大小寫、全半形不同也算）→ 正式名字。
 * 某一家沒有名字就只寫座位，不報錯；檔案讀不到就照原樣（拆分、別名只是讓名字跟網站一樣）。
 *
 * 純函式 + 讀檔各一；log 只有固定文字（不寫任何名字）。
 */

import * as fs from 'fs';
import * as path from 'path';
import { playerNameKey } from '@avalon/shared';
import { gameDbPaths } from '../../services/recordsList';
import { describeError } from '../media/bytes';

const SEAT_CHARS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];
/** 一個名字最多幾個字（回覆不被一個超長的名字撐爆）。 */
export const SEAT_NAME_MAX = 20;

/** player_aliases.json splits 的一條規則（generate_cache.PlayerSplit 的同一個意思）。 */
export interface SeatSplitRule {
  /** 那個名字的 playerIdentityKey（別名也算同一人）。 */
  key: string;
  as: string;
  games: ReadonlySet<string>;
  from: string;
  to: string;
  venue: string;
  /** '1'..'9'、'0'；'' = 任何座位。 */
  seat: string;
}

export interface SeatNameRules {
  /** 舊寫法的 playerNameKey → 正式名字（大小寫、全半形不同也算同一個舊寫法）。 */
  aliases: ReadonlyMap<string, string>;
  splits: SeatSplitRule[];
}

export const NO_SEAT_NAME_RULES: SeatNameRules = { aliases: new Map(), splits: [] };

/** generate_cache.player_identity_key：playerNameKey，舊寫法換成正式名字的 key。 */
function identityKey(name: string, aliases: ReadonlyMap<string, string>): string {
  const key = playerNameKey(name);
  const official = aliases.get(key);
  return official === undefined ? key : playerNameKey(official);
}

/** 局的資料（拆分規則挑局用）：所有局號、日期（YYYY-MM-DD）、分類（線瓦／面瓦…）。 */
export interface SeatNameGame {
  ids: readonly string[];
  date: string;
  venue: string;
}

/** 名字照網站的寫法收乾淨（generate_cache.normalize_player_name）：零寬字元拿掉、控制字元當空白，空白收成一格，太長截斷；不是字串 → ''。 */
export function tidySeatName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const text = raw
    .replace(/\p{Cf}/gu, '')
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ')
    .split(/\s+/u)
    .filter(Boolean)
    .join(' ');
  const chars = [...text];
  return chars.length > SEAT_NAME_MAX ? `${chars.slice(0, SEAT_NAME_MAX - 1).join('')}…` : text;
}

/** generate_cache.normalize_split_game_id：S＋流水號、D＋10 碼、DC 貼文 id；其他 → ''。 */
export function normalizeSplitGameId(raw: unknown): string {
  const text = typeof raw === 'string' ? raw.normalize('NFKC').trim() : '';
  if (/^\d{15,21}$/u.test(text)) return text;
  const sheet = /^[Ss]?(\d{1,9})$/u.exec(text);
  if (sheet) return `S${Number(sheet[1])}`;
  return /^D[0-9a-f]{10}$/u.test(text) ? text : '';
}

const day = (v: unknown): string => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(v) ? v : '');

/**
 * player_aliases.json → 規則。寬鬆：格式不對的條目跳過（檔案的嚴格檢查在 generate_cache.py，每日更新時就會擋下）。
 */
export function parseSeatNameRules(doc: unknown): SeatNameRules {
  if (!doc || typeof doc !== 'object') return NO_SEAT_NAME_RULES;
  const d = doc as { aliases?: unknown; splits?: unknown };
  const aliases = new Map<string, string>();
  if (d.aliases && typeof d.aliases === 'object') {
    for (const [from, to] of Object.entries(d.aliases as Record<string, unknown>)) {
      const key = playerNameKey(from);
      if (typeof to === 'string' && key && playerNameKey(to) && !aliases.has(key)) aliases.set(key, tidySeatName(to));
    }
  }
  const splits: SeatSplitRule[] = [];
  if (d.splits && typeof d.splits === 'object') {
    for (const [name, items] of Object.entries(d.splits as Record<string, unknown>)) {
      const key = identityKey(name, aliases);
      if (!key || !Array.isArray(items)) continue;
      for (const raw of items) {
        const r = (raw ?? {}) as { as?: unknown; games?: unknown; from?: unknown; to?: unknown; venue?: unknown; seat?: unknown };
        const as = tidySeatName(r.as);
        if (!playerNameKey(as)) continue;
        const games = new Set((Array.isArray(r.games) ? r.games : []).map(normalizeSplitGameId).filter(Boolean));
        const seat = String(r.seat ?? '');
        const rule: SeatSplitRule = {
          key,
          as,
          games,
          from: day(r.from),
          to: day(r.to),
          venue: typeof r.venue === 'string' ? r.venue.trim() : '',
          seat: SEAT_CHARS.includes(seat) ? seat : '',
        };
        if (rule.games.size === 0 && !rule.from && !rule.to && !rule.venue) continue;
        splits.push(rule);
      }
    }
  }
  return { aliases, splits };
}

/** generate_cache.PlayerSplit.picks：局號在 games 裡，或有篩選條件且全部符合。 */
export function splitPicks(rule: SeatSplitRule, game: SeatNameGame): boolean {
  if (game.ids.some((id) => rule.games.has(id))) return true;
  if (!rule.from && !rule.to && !rule.venue) return false;
  if ((rule.from || rule.to) && !game.date) return false;
  if (rule.from && game.date < rule.from) return false;
  if (rule.to && game.date > rule.to) return false;
  return !rule.venue || game.venue.trim() === rule.venue;
}

/** 一篇的十個名字 → 網站戰績上的名字（拆分、別名套過）；沒有名字的座位是 ''。 */
export function resolveSeatNames(names: readonly unknown[], game: SeatNameGame, rules: SeatNameRules = NO_SEAT_NAME_RULES): string[] {
  return SEAT_CHARS.map((seat, i) => {
    const name = tidySeatName(names[i]);
    const nameKey = playerNameKey(name);
    if (!nameKey) return '';
    const official = rules.aliases.get(nameKey);
    const key = official === undefined ? nameKey : playerNameKey(official);
    const split = rules.splits.find((r) => r.key === key && (!r.seat || r.seat === seat) && splitPicks(r, game));
    if (split) return split.as;
    return official ?? name;
  });
}

/** game_db.json → 每個局號（總庫局號與每個來源 id）→ 同一局的所有局號。讀不懂 → 空的。 */
export function gameIdIndex(db: unknown): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const games = (db as { games?: unknown } | null)?.games;
  if (!Array.isArray(games)) return out;
  for (const raw of games) {
    const g = (raw ?? {}) as { id?: unknown; sources?: unknown };
    const ids = [...new Set([g.id, ...(Array.isArray(g.sources) ? g.sources : []).map((s) => (s as { id?: unknown } | null)?.id)]
      .filter((id): id is string => typeof id === 'string' && /^[0-9A-Za-z_-]{1,40}$/u.test(id)))];
    for (const id of ids) if (!out.has(id)) out.set(id, ids);
  }
  return out;
}

/**
 * 題庫 games[] 的索引 → 十個名字：`records`（索引 → 貼文 id，linkRecords）對到的那一篇的 game.names。
 * 一個名字都沒有的局不放（/公布 就不印名字那一行）。
 */
export function linkSeatNames(
  records: ReadonlyMap<number, string>,
  posts: readonly unknown[],
  rules: SeatNameRules = NO_SEAT_NAME_RULES,
  ids: ReadonlyMap<string, readonly string[]> = new Map(),
): Map<number, string[]> {
  const wanted = new Set(records.values());
  const byId = new Map<string, { names: unknown[]; game: SeatNameGame }>();
  for (const raw of posts) {
    const p = (raw ?? {}) as { id?: unknown; date?: unknown; game?: unknown };
    const id = typeof p.id === 'string' ? p.id : '';
    if (!wanted.has(id) || byId.has(id)) continue;
    const g = (p.game ?? {}) as { names?: unknown; category?: unknown };
    if (!Array.isArray(g.names)) continue;
    byId.set(id, {
      names: g.names,
      game: { ids: ids.get(id) ?? [id], date: day(p.date), venue: typeof g.category === 'string' ? g.category : '' },
    });
  }
  const out = new Map<number, string[]>();
  for (const [index, id] of records) {
    const post = byId.get(id);
    if (!post) continue;
    const names = resolveSeatNames(post.names, post.game, rules);
    if (names.some(Boolean)) out.set(index, names);
  }
  return out;
}

export const PLAYER_ALIASES_FILE = 'player_aliases.json';

/** src/bots/simulation（或 dist/bots/simulation）往上三層 = packages/server。 */
export function playerAliasesPaths(): string[] {
  return [
    path.resolve(__dirname, '..', '..', '..', PLAYER_ALIASES_FILE),
    path.resolve(process.cwd(), 'packages', 'server', PLAYER_ALIASES_FILE),
    path.resolve(process.cwd(), PLAYER_ALIASES_FILE),
  ];
}

function readJson(paths: readonly string[], label: string): unknown {
  const file = paths.find((p) => fs.existsSync(p));
  if (!file) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.warn(`[sim] reading ${label} failed (${describeError(err)}); /公布 names stay as written`);
    return null;
  }
}

/** 名字的規則和局號對照（開機讀題庫時讀一次）。總庫只有在拆分規則列了局號時才讀。 */
export function readSeatNameSources(
  aliasPaths: readonly string[] = playerAliasesPaths(),
  dbPaths: readonly string[] = gameDbPaths(),
): { rules: SeatNameRules; ids: Map<string, string[]> } {
  const rules = parseSeatNameRules(readJson(aliasPaths, PLAYER_ALIASES_FILE));
  const ids = rules.splits.some((r) => r.games.size > 0) ? gameIdIndex(readJson(dbPaths, 'game_db.json')) : new Map<string, string[]>();
  return { rules, ids };
}
