/**
 * GET /api/analysis/records 的資料（網站「牌譜紀錄」頁籤，Edward 2026-10-30：「百科網站可以直接多一個頁籤是
 * 『牌譜紀錄與覆盤』…直接同步現在 DC 的牌譜紀錄與覆盤頻道」）。
 *
 * - 來源：packages/server/records_cache.json，由 refresh-analysis-cache.yml 每天跑 discord_records_export.py 產生、
 *   跟分析快取一起 commit（Discord 論壇每篇貼文 = 一局：標題、標籤、發文時間、解析後的牌譜；不含起始訊息原文，
 *   也不含討論串裡的回覆）。伺服器執行期不連 Discord、不需要任何金鑰。
 * - 檔案不存在或格式不對 → 503 'Records list not yet generated'（網站顯示「尚未產生」）。
 * - 回應本體組一次、預先壓成 gzip / brotli，強 ETag，If-None-Match → 304（同 /api/analysis/games）。
 * - 舊局號（2026-11-19 站長：#records=S1629 打不開）：同一局在試算表與 DC 都有時，清單只留 DC 那一篇（id = 貼文 id），
 *   試算表的 S…、Discord匯入的 D…、重複貼文等其他來源 id 就對不到。組回應時讀牌譜總庫 game_db.json（每局的 sources），
 *   把「網站上沒有這個 id 的來源 id」寫進那一篇的 aka（recordAliases），網站用它把舊連結轉到那一篇。總庫不在 → 照原樣，不加 aka。
 * - 玩家別名（2026-11-25 站長：「把 軒/ED 直接改成軒 那場我沒玩」）：座位上的名字是 player_aliases.json 左邊的舊寫法時，
 *   改顯示右邊的正式名字（跟戰績、排行一致；只差大小寫／全半形也算）。百科AI_1、百科AI_2… 是不同座位的機器人，不併成同一個名字。
 *   別名檔不在或格式不對 → 名字照貼文原樣。records_cache.json 本身不改（每天從 Discord 重新產生）。
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

/** 本機預覽或測試用另一份清單（比照 AVALON_GAMES_DATASET）；正式環境不設。 */
export const ENV_RECORDS_CACHE = 'AVALON_RECORDS_CACHE';
export const RECORDS_FORMAT = 'avalon-records';
/** 改名前（2026-10-31 以前）每日寫的格式名稱；改名後第一次每日更新前，已 commit 的檔案還是這個名稱。 */
export const LEGACY_RECORDS_FORMAT = 'avalon-paipu';
export const RECORDS_VERSION = 1;
export const RECORDS_NOT_GENERATED = 'Records list not yet generated';

/** 牌譜總庫（game_db.json，scripts 產生、每天 commit）；本機或測試另指檔案用這個（services/recordLookup 也讀）。 */
export const ENV_GAME_DB = 'AVALON_GAME_DB';

const GAME_DB_PATHS = [
  path.resolve(__dirname, '..', '..', 'game_db.json'),
  path.resolve(__dirname, '..', '..', '..', '..', '..', 'packages', 'server', 'game_db.json'),
];

/** 玩家別名（player_aliases.json，站長指定）；本機或測試另指檔案用這個。 */
export const ENV_PLAYER_ALIASES = 'AVALON_PLAYER_ALIASES';

const ALIASES_PATHS = [
  path.resolve(__dirname, '..', '..', 'player_aliases.json'),
  path.resolve(__dirname, '..', '..', '..', '..', '..', 'packages', 'server', 'player_aliases.json'),
];

const RECORDS_PATHS = [
  path.resolve(__dirname, '..', '..', 'records_cache.json'),
  path.resolve(__dirname, '..', '..', '..', '..', '..', 'packages', 'server', 'records_cache.json'),
];

export interface RecordPayload {
  identity: Buffer;
  gzip: Buffer;
  br: Buffer;
  etag: string;
  posts: number;
  /** 清單裡的貼文 id（回覆路由只讀這些貼文的討論串）。 */
  ids: ReadonlySet<string>;
  guildId: string;
}

export type RecordLoad = { ok: true; payload: RecordPayload } | { ok: false; status: number; error: string };

let loaded: RecordLoad | null = null;

/** 牌譜紀錄清單的檔案路徑（模擬瓦 bots/simulation/recordsIndex.ts 也讀同一份）。 */
export function recordsPaths(): string[] {
  const override = process.env[ENV_RECORDS_CACHE]?.trim();
  return override ? [path.resolve(override)] : RECORDS_PATHS;
}

/** 牌譜總庫的檔案路徑。 */
export function gameDbPaths(): string[] {
  const override = process.env[ENV_GAME_DB]?.trim();
  return override ? [path.resolve(override)] : GAME_DB_PATHS;
}

/** 局號的外形（同 game_db.public_id：DC 貼文 id、S／M＋流水號、D＋雜湊、P＋ProAvalon id）。 */
const ALIAS_ID = /^[0-9A-Za-z_-]{1,40}$/;

/**
 * 網站清單的每一篇 → 它的其他局號（aka）：總庫每一局的 sources 裡，不是網站上任何一篇 id 的來源 id。
 * 那一局在網站上是哪一篇：總庫局號本身，不在清單上就取第一個在清單上的來源 id；都不在 → 略過。
 * 同一個來源 id 出現在兩局時給先出現的那一局（不會發生，防萬一）。
 */
export function recordAliases(posts: readonly unknown[], db: unknown): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const games = (db as { format?: unknown; games?: unknown } | null);
  if (!games || games.format !== 'avalon-game-db' || !Array.isArray(games.games)) return out;
  const onSite = new Set(posts.map((p) => String((p as { id?: unknown } | null)?.id ?? '')).filter(Boolean));
  const claimed = new Set<string>();
  for (const raw of games.games as unknown[]) {
    const g = (raw ?? {}) as { id?: unknown; sources?: unknown };
    const ids = [g.id, ...(Array.isArray(g.sources) ? g.sources : []).map((s) => (s as { id?: unknown } | null)?.id)]
      .filter((id): id is string => typeof id === 'string' && ALIAS_ID.test(id));
    const target = ids.find((id) => onSite.has(id));
    if (!target) continue;
    const aka = [...new Set(ids)].filter((id) => !onSite.has(id) && !claimed.has(id));
    if (!aka.length) continue;
    for (const id of aka) claimed.add(id);
    out.set(target, [...(out.get(target) ?? []), ...aka]);
  }
  return out;
}

/** 名字的比對鍵：全半形、大小寫、頭尾空白不分（同 generate_cache.py 的 player_name_key 的用意）。 */
function nameKey(name: string): string {
  return name.normalize('NFKC').trim().toLowerCase();
}

/** 百科AI、百科AI_3：機器人的座位名，牌譜上保留編號。 */
const PEDIA_BOT_NAME = /^百科AI(?:_\d+)?$/;

/**
 * player_aliases.json 的 aliases → 牌譜上要換掉的寫法（鍵 = nameKey(舊寫法)，值 = 正式名字）。
 * 機器人的座位名不換。不是物件、值不是字串的項目略過。
 */
export function recordNameRenames(doc: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const aliases = (doc as { aliases?: unknown } | null)?.aliases;
  if (!aliases || typeof aliases !== 'object' || Array.isArray(aliases)) return out;
  for (const [from, to] of Object.entries(aliases as Record<string, unknown>)) {
    if (typeof to !== 'string' || !to.trim() || PEDIA_BOT_NAME.test(from.trim())) continue;
    out.set(nameKey(from), to.trim());
  }
  return out;
}

/** 一篇貼文的座位名字照別名換成正式名字；沒有要換的就回傳原物件。 */
export function renameRecordNames(post: unknown, renames: ReadonlyMap<string, string>): unknown {
  if (renames.size === 0) return post;
  const game = (post as { game?: { names?: unknown } | null } | null)?.game;
  const names = game?.names;
  if (!Array.isArray(names)) return post;
  let changed = false;
  const next = names.map((n) => {
    const to = typeof n === 'string' ? renames.get(nameKey(n)) : undefined;
    if (to === undefined || to === n) return n;
    changed = true;
    return to;
  });
  return changed ? { ...(post as object), game: { ...(game as object), names: next } } : post;
}

function readRenames(): Map<string, string> {
  const override = process.env[ENV_PLAYER_ALIASES]?.trim();
  const file = (override ? [path.resolve(override)] : ALIASES_PATHS).find((p) => fs.existsSync(p));
  if (!file) return new Map();
  try {
    return recordNameRenames(JSON.parse(fs.readFileSync(file, 'utf-8')));
  } catch {
    console.warn('[analysis/records] player_aliases.json 讀取失敗：名字照貼文原樣');
    return new Map();
  }
}

function readGameDb(): unknown {
  const file = gameDbPaths().find((p) => fs.existsSync(p));
  if (!file) {
    console.warn('[analysis/records] 找不到 game_db.json：舊局號（S…／D…）的連結不會轉到合併後的那一篇');
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    console.warn('[analysis/records] game_db.json 讀取失敗：1');
    return null;
  }
}

/** 只看外形（format、version、posts 是陣列）；欄位的隱私形狀已由產生器在寫檔前檢查。 */
export function isRecordsDocument(doc: unknown): doc is { format: string; version: number; guildId: string; posts: unknown[] } {
  if (!doc || typeof doc !== 'object') return false;
  const d = doc as Record<string, unknown>;
  return (d.format === RECORDS_FORMAT || d.format === LEGACY_RECORDS_FORMAT) && d.version === RECORDS_VERSION && typeof d.guildId === 'string'
    && /^\d{15,22}$/.test(d.guildId) && Array.isArray(d.posts);
}

function build(): RecordLoad {
  const file = recordsPaths().find((p) => fs.existsSync(p));
  if (!file) return { ok: false, status: 503, error: RECORDS_NOT_GENERATED };
  let doc: unknown;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    console.error('[analysis/records] 讀取失敗：1');
    return { ok: false, status: 503, error: RECORDS_NOT_GENERATED };
  }
  if (!isRecordsDocument(doc)) {
    console.error('[analysis/records] 格式不符：1');
    return { ok: false, status: 503, error: RECORDS_NOT_GENERATED };
  }
  const aka = recordAliases(doc.posts, readGameDb());
  const renames = readRenames();
  const data = aka.size === 0 && renames.size === 0 ? doc : {
    ...doc,
    posts: doc.posts.map((raw) => {
      const p = renameRecordNames(raw, renames);
      const extra = aka.get(String((p as { id?: unknown } | null)?.id ?? ''));
      return extra ? { ...(p as object), aka: extra } : p;
    }),
  };
  const identity = Buffer.from(JSON.stringify({ success: true, data }), 'utf-8');
  return {
    ok: true,
    payload: {
      identity,
      gzip: zlib.gzipSync(identity, { level: 9 }),
      br: zlib.brotliCompressSync(identity, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } }),
      etag: `"${crypto.createHash('sha1').update(identity).digest('hex')}"`,
      posts: doc.posts.length,
      ids: new Set(doc.posts.map((p) => String((p as { id?: unknown })?.id ?? '')).filter((id) => /^\d{15,22}$/.test(id))),
      guildId: doc.guildId,
    },
  };
}

/** 第一次呼叫時讀檔、檢查、壓縮；之後回傳同一份（invalidateRecordsPayload 清掉）。缺檔不快取，部署後補上即可讀到。 */
export function loadRecordsPayload(): RecordLoad {
  if (loaded?.ok) return loaded;
  loaded = build();
  return loaded;
}

export function invalidateRecordsPayload(): void {
  loaded = null;
}
