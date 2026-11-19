/**
 * 用局號查一局牌譜（/更正 指令，Edward 2026-11-17：玩家要能對有問題的牌譜送出更正；claude.ai 頁面外人只能看，
 * 所以走大家已經在用的機器人）。
 *
 * 兩份檔案，都在 packages/server/、每天的資料更新一起 commit、伺服器執行期不連外：
 *   - records_cache.json（網站「牌譜紀錄」頁的資料，services/recordsList.ts）：有暱稱、網站上有這一篇；
 *   - game_db.json（牌譜總庫，scripts 產生）：每局的檢查結果（checks：error／warn／info）與 problem。
 * 局號：試算表 S1794、模擬瓦 M536、DC 貼文 id（15～22 位數字）、外部 P…；也認總庫 sources 裡的來源 id。
 *
 * 讀一次就留在記憶體（兩份共約 7 MB 的 JSON，只留查詢用得到的欄位）。檔案不在 log 一行警告，查詢照樣用另一份；
 * 正式 image 要帶這兩份（根目錄 Dockerfile 的 COPY；Render 用的 Dockerfile.server 是 COPY . .）。
 * 測試或本機另指檔案：AVALON_RECORDS_CACHE（同 recordsList）、AVALON_GAME_DB。
 */
import fs from 'fs';
import { recordsPaths, isRecordsDocument, gameDbPaths, ENV_GAME_DB } from './recordsList';

export { ENV_GAME_DB };

export interface LookupProposal { team: string; votes: string[] }
export interface LookupRound { proposals: LookupProposal[]; mission: string }
export interface LookupLake { after: number; holder: string; target: string; claim: string }
export interface LookupGame {
  config: string;
  rounds: LookupRound[];
  lakes: LookupLake[];
  assassination: string;
  outcome: string;
}

export interface RecordLookup {
  /** 正式局號（網站／總庫用的那個）。 */
  id: string;
  kind: 'real' | 'sim' | 'external' | '';
  date: string;
  venue: string;
  /** 牌譜（讀不懂的局是 null）。 */
  game: LookupGame | null;
  /** 1..9、0 家的暱稱（只有網站上有這一篇、而且讀得懂時才有）。 */
  names: string[] | null;
  /** 問題（總庫的 problem、error／warn 檢查、網站那一篇的 problem；去重、照這個順序）。 */
  problems: string[];
  /** 網站上有這一篇（有連結）。 */
  onSite: boolean;
  /** 網站那一篇的 id（連結用；通常同 id，打的是另一篇重複貼文時是那一篇）；沒有是 ''。 */
  siteId: string;
}

interface DbEntry {
  id: string;
  kind: RecordLookup['kind'];
  date: string;
  venue: string;
  game: LookupGame | null;
  problem: string;
  checks: { level: string; msg: string }[];
}

interface SiteEntry { id: string; date: string; venue: string; game: LookupGame | null; names: string[] | null; problem: string }

interface Index {
  db: Map<string, DbEntry>;
  /** 來源 id → 正式局號。 */
  alias: Map<string, string>;
  site: Map<string, SiteEntry>;
}

let cached: Index | null = null;

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function asGame(raw: unknown): LookupGame | null {
  if (!raw || typeof raw !== 'object') return null;
  const g = raw as Record<string, unknown>;
  if (typeof g.config !== 'string' || !Array.isArray(g.rounds)) return null;
  const rounds: LookupRound[] = (g.rounds as unknown[]).map((r) => {
    const round = (r ?? {}) as Record<string, unknown>;
    const proposals = Array.isArray(round.proposals) ? round.proposals as unknown[] : [];
    return {
      proposals: proposals.map((p) => {
        const prop = (p ?? {}) as Record<string, unknown>;
        return { team: str(prop.team), votes: Array.isArray(prop.votes) ? (prop.votes as unknown[]).map(str).filter(Boolean) : [] };
      }),
      mission: str(round.mission),
    };
  });
  const lakes: LookupLake[] = (Array.isArray(g.lakes) ? g.lakes as unknown[] : []).map((l) => {
    const lake = (l ?? {}) as Record<string, unknown>;
    return { after: typeof lake.after === 'number' ? lake.after : 0, holder: str(lake.holder), target: str(lake.target), claim: str(lake.claim) };
  });
  return { config: g.config, rounds, lakes, assassination: str(g.assassination), outcome: str(g.outcome) };
}

function readJson(paths: string[], label: string): unknown {
  const file = paths.find((p) => fs.existsSync(p));
  if (!file) {
    // 不默默降級：少了總庫，/更正 看不到檢查結果與更正、只在總庫裡的局（模擬、外部）也查不到（Dockerfile 要 COPY 這兩份）。
    console.warn(`[record-lookup] 找不到 ${label}；/更正 只能用另一份資料查`);
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    console.warn('[record-lookup] 讀取失敗：1');
    return null;
  }
}

function build(): Index {
  const index: Index = { db: new Map(), alias: new Map(), site: new Map() };
  const db = readJson(gameDbPaths(), 'game_db.json') as { format?: unknown; games?: unknown } | null;
  if (db && !(db.format === 'avalon-game-db' && Array.isArray(db.games))) console.warn('[record-lookup] game_db.json 格式不符；/更正 只能用 records_cache.json 查');
  if (db && db.format === 'avalon-game-db' && Array.isArray(db.games)) {
    for (const raw of db.games as unknown[]) {
      const e = (raw ?? {}) as Record<string, unknown>;
      const id = str(e.id);
      if (!id) continue;
      const kind = str(e.kind);
      index.db.set(id, {
        id,
        kind: kind === 'real' || kind === 'sim' || kind === 'external' ? kind : '',
        date: str(e.date),
        venue: str(e.venue),
        game: asGame(e.game),
        problem: str(e.problem),
        checks: (Array.isArray(e.checks) ? e.checks as unknown[] : []).map((c) => {
          const check = (c ?? {}) as Record<string, unknown>;
          return { level: str(check.level), msg: str(check.msg) };
        }).filter((c) => c.msg),
      });
      for (const s of Array.isArray(e.sources) ? e.sources as unknown[] : []) {
        const sid = str((s as Record<string, unknown> | null)?.id);
        if (sid && sid !== id && !index.alias.has(sid)) index.alias.set(sid, id);
      }
    }
  }
  const site = readJson(recordsPaths(), 'records_cache.json');
  if (isRecordsDocument(site)) {
    for (const raw of site.posts) {
      const p = (raw ?? {}) as Record<string, unknown>;
      const id = str(p.id);
      if (!id) continue;
      const g = (p.game ?? null) as Record<string, unknown> | null;
      const names = g && Array.isArray(g.names) ? (g.names as unknown[]).map(str) : null;
      const tags = Array.isArray(p.tags) ? (p.tags as unknown[]).map(str) : [];
      index.site.set(id, {
        id,
        date: str(p.date),
        venue: str(g?.category) || tags.find((t) => t === '線瓦' || t === '面瓦' || t === '娛樂') || '',
        game: asGame(g),
        names: names && names.some(Boolean) ? names : null,
        problem: str(p.problem),
      });
    }
  }
  return index;
}

function index(): Index {
  if (!cached) cached = build();
  return cached;
}

/** 測試用：下次查詢重新讀檔。 */
export function __resetRecordLookupForTests(): void {
  cached = null;
}

/**
 * 使用者打的局號 → 正規化（全形轉半形、去 #、網址取 #records= 後面、s1794 → S1794）。空字串 = 看不懂。
 */
export function normaliseRecordId(raw: string): string {
  let t = (raw ?? '').normalize('NFKC').trim();
  const m = /records=([^\s&#]+)/u.exec(t);
  if (m) {
    try {
      t = decodeURIComponent(m[1]);
    } catch {
      return ''; // 壞掉的 %（#records=%）：當看不懂的局號，照常回「找不到局號」
    }
  }
  t = t.replace(/^#/, '').trim();
  if (/^[smp][0-9a-z]+$/iu.test(t)) t = t[0].toUpperCase() + t.slice(1);
  return /^[0-9A-Za-z_-]{1,40}$/u.test(t) ? t : '';
}

/** 用局號查一局；沒有這一局 → null。 */
export function lookupRecord(rawId: string): RecordLookup | null {
  const want = normaliseRecordId(rawId);
  if (!want) return null;
  const idx = index();
  // 總庫優先（檢查結果與更正在那裡）：總庫的局號 → 總庫的來源 id → 只在網站上的局。
  // 來源 id 也是網站上的一篇（例：同一局在論壇貼了兩次）時，答總庫那一局，網站資料（暱稱、連結）照樣用得上。
  const id = idx.db.has(want) ? want : idx.alias.get(want) ?? (idx.site.has(want) ? want : '');
  if (!id) return null;
  const db = idx.db.get(id);
  const siteId = idx.site.has(id) ? id : idx.site.has(want) ? want : '';
  const site = siteId ? idx.site.get(siteId) : undefined;
  const problems: string[] = [];
  const add = (s: string): void => {
    const t = s.trim();
    if (t && !problems.includes(t)) problems.push(t);
  };
  if (db) {
    add(db.problem);
    for (const c of db.checks) if (c.level === 'error' || c.level === 'warn') add(c.msg);
  }
  if (site) add(site.problem);
  // 網站那一篇有暱稱；牌譜以總庫為準（套用過更正），總庫讀不懂時才用網站的。
  const game = db?.game ?? site?.game ?? null;
  return {
    id,
    kind: db?.kind ?? (site ? (id.startsWith('M') ? 'sim' : 'real') : ''),
    date: db?.date || site?.date || '',
    venue: db?.venue || site?.venue || '',
    game,
    names: site?.names ?? null,
    problems,
    onSite: Boolean(site),
    siteId,
  };
}
