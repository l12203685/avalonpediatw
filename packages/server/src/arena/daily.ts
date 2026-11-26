/**
 * AI 擂台的每日大賽（站長 2026-11-26「做成像CICD 並且每天至少跑10萬局」）：分片、可重現的種子、
 * 精簡的分片結果檔、合併、每日歷史快照（60 天後併成每週）與網站用的走勢。全部是純函式；
 * 跑棋與讀寫檔在 scripts/arenaDaily.ts，排程在 .github/workflows/arena-tournament.yml。
 *
 * 可重現：第 i 局只由 (seed, i) 決定（座位：report.ts `tournamentSeating`；整局：table.ts `playTable(…, `${seed}|${i}`)`），
 * 跟分成幾片、每片幾個行程無關。每日排程的 seed = `arena-<台北日期>`，所以同一天重跑失敗的分片會得到同樣的局。
 */
import { createHash } from 'crypto';
import type { Leaderboard } from './report';
import type { ArenaSide } from './profile';
import type { Outcome, SeatResult, TableResult } from './table';

export const SHARD_SCHEMA = 1;
export const HISTORY_SCHEMA = 1;
/** 每日快照保留天數；更舊的併成每週一份（`YYYY-Www.json`）。 */
export const KEEP_DAYS = 60;
/** 網站走勢顯示最近幾天。 */
export const TREND_DAYS = 30;

// ── 分片與種子 ───────────────────────────────────────────

/** 這一輪是怎麼來的：每日排程、合併到 main 後的補跑、手動。 */
export type RunKind = 'daily' | 'push' | 'manual' | 'smoke';

/**
 * 這一輪的 seed。每日排程只看日期（重跑同一天＝同樣的局）；其他種類加上 run 編號，
 * 同一天多跑幾輪也不會重複打同樣的局。
 */
export function runSeed(date: string, kind: RunKind, runId?: string | number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`日期要是 YYYY-MM-DD，收到「${date}」`);
  if (kind === 'daily') return `arena-${date}`;
  if (runId === undefined || String(runId) === '') throw new Error(`${kind} 這種要給 run 編號`);
  return `arena-${date}-${kind}-${runId}`;
}

export interface SliceRange { index: number; count: number; start: number; end: number }

/** 總共 `total` 局切成 `count` 片，第 `index` 片負責的連續局號 [start, end)。前面幾片多一局。 */
export function sliceRange(total: number, index: number, count: number): SliceRange {
  if (!Number.isInteger(total) || total < 0) throw new Error('局數要是非負整數');
  if (!Number.isInteger(count) || count < 1) throw new Error('片數要是正整數');
  if (!Number.isInteger(index) || index < 0 || index >= count) throw new Error(`第 ${index} 片超出 0..${count - 1}`);
  const base = Math.floor(total / count);
  const rem = total % count;
  const start = index * base + Math.min(index, rem);
  return { index, count, start, end: start + base + (index < rem ? 1 : 0) };
}

/** `--slice 3/12` 的值。 */
export function parseSlice(spec: string): { index: number; count: number } {
  const m = /^(\d+)\/(\d+)$/.exec(spec.trim());
  if (!m) throw new Error(`--slice 要是「第幾片/共幾片」（從 0 數），收到「${spec}」`);
  const index = Number(m[1]); const count = Number(m[2]);
  if (count < 1 || index >= count) throw new Error(`--slice ${spec} 超出範圍`);
  return { index, count };
}

/**
 * 每日大賽要切幾片：每片最多 `perShard` 局，最多 `maxShards` 片（GitHub 公開 repo 一次最多 20 個 job 同時跑）。
 * 局數太多時每片變大，而不是超過片數上限。
 */
export function planShards(games: number, perShard = 10_000, maxShards = 20): { shards: number; perShard: number } {
  if (!Number.isInteger(games) || games < 1) throw new Error('局數要是正整數');
  const shards = Math.min(maxShards, Math.max(1, Math.ceil(games / perShard)));
  return { shards, perShard: Math.ceil(games / shards) };
}

/** 名冊（id 與 profile）的雜湊：每一片都要是同一份名冊才能合併。 */
export function rosterHash(bots: readonly { id: string; profile: unknown }[]): string {
  return createHash('sha256').update(JSON.stringify(bots.map((b) => [b.id, b.profile ?? null]))).digest('hex').slice(0, 16);
}

// ── 精簡的對局編碼 ─────────────────────────────────────────
//
// 一局 = 1 個結果字元 + 每個座位 3 個字元（名冊索引 2 位 36 進位 + 角色 1 字元；出手刺殺的座位角色字元大寫）。
// 10 人局 31 個字元，10 萬局約 3 MB。陣營、勝負、刺中與否都能從角色與結果推回來。

const ROLE_CODE: Record<string, string> = {
  merlin: 'm', percival: 'p', loyal: 'l', assassin: 'a', morgana: 'g', mordred: 'd', oberon: 'o', minion: 'n',
};
const CODE_ROLE: Record<string, string> = Object.fromEntries(Object.entries(ROLE_CODE).map(([r, c]) => [c, r]));
const EVIL_ROLES = new Set(['assassin', 'morgana', 'mordred', 'oberon', 'minion']);
const OUTCOME_CODE: Record<Outcome, string> = { threeRed: 'R', merlinKilled: 'K', threeBlue: 'B' };
const CODE_OUTCOME: Record<string, Outcome> = { R: 'threeRed', K: 'merlinKilled', B: 'threeBlue' };
const MAX_ENTRANTS = 36 * 36;

export function teamOfRole(role: string): ArenaSide {
  return EVIL_ROLES.has(role) ? 'evil' : 'good';
}

export function winnerOf(outcome: Outcome): ArenaSide {
  return outcome === 'threeBlue' ? 'good' : 'evil';
}

/** 把一局壓成一個短字串；`index` = 名冊 id → 索引。資料對不起來（陣營、勝負）就丟錯，不要默默存錯。 */
export function encodeTable(t: TableResult, index: ReadonlyMap<string, number>): string {
  if (winnerOf(t.outcome) !== t.winner) throw new Error(`${t.gameSeed}：結果 ${t.outcome} 和贏家 ${t.winner} 對不起來`);
  let s = OUTCOME_CODE[t.outcome];
  for (const seat of t.seats) {
    const i = index.get(seat.entrant);
    if (i === undefined) throw new Error(`${t.gameSeed}：名冊裡沒有 ${seat.entrant}`);
    if (i >= MAX_ENTRANTS) throw new Error('名冊太大（上限 1296 隻）');
    const code = ROLE_CODE[seat.role];
    if (!code) throw new Error(`${t.gameSeed}：不認得的角色 ${seat.role}`);
    if (teamOfRole(seat.role) !== seat.team) throw new Error(`${t.gameSeed}：${seat.role} 的陣營不是 ${seat.team}`);
    if (seat.assassinHit !== undefined && seat.assassinHit !== (t.outcome === 'merlinKilled')) {
      throw new Error(`${t.gameSeed}：刺殺結果和整局結果對不起來`);
    }
    s += i.toString(36).padStart(2, '0') + (seat.assassinHit !== undefined ? code.toUpperCase() : code);
  }
  return s;
}

/** `encodeTable` 的反向（`fingerprint` 不保留，給空字串）。 */
export function decodeTable(code: string, ids: readonly string[], gameSeed: string): TableResult {
  const outcome = CODE_OUTCOME[code[0]];
  if (!outcome || (code.length - 1) % 3 !== 0) throw new Error(`${gameSeed}：壞掉的對局字串「${code}」`);
  const winner = winnerOf(outcome);
  const seats: SeatResult[] = [];
  for (let p = 1; p < code.length; p += 3) {
    const entrant = ids[Number.parseInt(code.slice(p, p + 2), 36)];
    const c = code[p + 2];
    const role = CODE_ROLE[c.toLowerCase()];
    if (entrant === undefined || !role) throw new Error(`${gameSeed}：壞掉的對局字串「${code}」`);
    const team = teamOfRole(role);
    const seat: SeatResult = { entrant, role, team, won: team === winner };
    if (c !== c.toLowerCase()) seat.assassinHit = outcome === 'merlinKilled';
    seats.push(seat);
  }
  return { gameSeed, playerCount: seats.length, winner, outcome, seats, fingerprint: '' };
}

// ── 分片結果檔 ───────────────────────────────────────────

export interface ShardFile {
  schema: number;
  seed: string;
  date: string;
  kind: RunKind;
  totalGames: number;
  slice: SliceRange;
  sizes: number[];
  roster: string[];
  rosterHash: string;
  /** 這一片實際跑了多久（秒）、用了幾個行程：量吞吐用。 */
  elapsedSec: number;
  workers: number;
  /** 第 start + k 局 = games[k]。 */
  games: string[];
}

export function makeShardFile(args: Omit<ShardFile, 'schema' | 'games'> & { tables: readonly TableResult[] }): ShardFile {
  const { tables, ...rest } = args;
  if (tables.length !== rest.slice.end - rest.slice.start) throw new Error('這一片的局數和範圍對不起來');
  const index = new Map(rest.roster.map((id, i) => [id, i]));
  return { schema: SHARD_SCHEMA, ...rest, games: tables.map((t) => encodeTable(t, index)) };
}

export interface MergedRun {
  seed: string;
  date: string;
  kind: RunKind;
  totalGames: number;
  sizes: number[];
  roster: string[];
  rosterHash: string;
  /** 依局號排好、解回來的對局（缺的分片就少那幾局）。 */
  tables: TableResult[];
  shards: number;
  /** 沒收到的局號範圍（某一片失敗時）。 */
  missing: { start: number; end: number }[];
  /** 最慢的一片花了幾秒；每個 runner 每秒幾局（各片局數 ÷ 秒數的中位數）。 */
  slowestShardSec: number;
  gamesPerSecPerRunner: number;
}

/** 合併同一輪的分片：seed、名冊、局數都要一樣；範圍不能重疊；缺的範圍記下來。 */
export function mergeShards(files: readonly ShardFile[]): MergedRun {
  if (files.length === 0) throw new Error('沒有任何分片結果');
  const first = files[0];
  for (const f of files) {
    if (f.schema !== SHARD_SCHEMA) throw new Error(`分片格式版本 ${f.schema} 不認得`);
    if (f.seed !== first.seed || f.rosterHash !== first.rosterHash || f.totalGames !== first.totalGames
      || f.slice.count !== first.slice.count || JSON.stringify(f.sizes) !== JSON.stringify(first.sizes)) {
      throw new Error(`第 ${f.slice.index} 片和第 ${first.slice.index} 片不是同一輪（seed／名冊／局數不同）`);
    }
    if (f.games.length !== f.slice.end - f.slice.start) throw new Error(`第 ${f.slice.index} 片的局數和範圍對不起來`);
  }
  const sorted = [...files].sort((a, b) => a.slice.start - b.slice.start);
  const tables: TableResult[] = [];
  const missing: { start: number; end: number }[] = [];
  let cursor = 0;
  for (const f of sorted) {
    if (f.slice.start < cursor) throw new Error(`第 ${f.slice.index} 片和前一片重疊（局號 ${f.slice.start}）`);
    if (f.slice.start > cursor) missing.push({ start: cursor, end: f.slice.start });
    f.games.forEach((g, k) => tables.push(decodeTable(g, first.roster, `${first.seed}|${f.slice.start + k}`)));
    cursor = f.slice.end;
  }
  if (cursor < first.totalGames) missing.push({ start: cursor, end: first.totalGames });
  const rates = files.filter((f) => f.elapsedSec > 0 && f.games.length > 0).map((f) => f.games.length / f.elapsedSec).sort((a, b) => a - b);
  const median = rates.length ? (rates.length % 2 ? rates[(rates.length - 1) / 2] : (rates[rates.length / 2 - 1] + rates[rates.length / 2]) / 2) : 0;
  return {
    seed: first.seed,
    date: first.date,
    kind: first.kind,
    totalGames: first.totalGames,
    sizes: first.sizes,
    roster: first.roster,
    rosterHash: first.rosterHash,
    tables,
    shards: files.length,
    missing,
    slowestShardSec: Math.max(...files.map((f) => f.elapsedSec)),
    gamesPerSecPerRunner: Math.round(median * 100) / 100,
  };
}

// ── 歷史快照 ─────────────────────────────────────────────

/** [總分, 下界, 上界, 紅方分, 藍方分]（整數）。 */
export type RatingTuple = [number, number, number, number, number];

export interface HistorySnapshot {
  schema: number;
  /** 'day'：`YYYY-MM-DD`；'week'：`YYYY-Www`（ISO 週）。 */
  kind: 'day' | 'week';
  period: string;
  /** 這段期間所有輪加起來的局數與輪數。 */
  games: number;
  runs: number;
  /** 每日：當天最後一輪的分數；每週：各天依局數加權平均。 */
  bots: Record<string, RatingTuple>;
}

export function ratingTuples(board: Pick<Leaderboard, 'bots'>): Record<string, RatingTuple> {
  const out: Record<string, RatingTuple> = {};
  for (const b of board.bots) {
    const r = b.rating;
    out[b.id] = [r.overall.rating, r.overall.low, r.overall.high, r.red.rating, r.blue.rating].map(Math.round) as RatingTuple;
  }
  return out;
}

/** 把這一輪記進當天的快照（同一天多輪：局數相加、分數換成最新一輪）。 */
export function applyRunToDay(prev: HistorySnapshot | null, date: string, games: number, board: Pick<Leaderboard, 'bots'>): HistorySnapshot {
  if (prev && (prev.kind !== 'day' || prev.period !== date)) throw new Error(`快照 ${prev.period} 不是 ${date} 那一天`);
  return {
    schema: HISTORY_SCHEMA,
    kind: 'day',
    period: date,
    games: (prev?.games ?? 0) + games,
    runs: (prev?.runs ?? 0) + 1,
    bots: ratingTuples(board),
  };
}

/** `YYYY-MM-DD` → ISO 週 `YYYY-Www`。 */
export function isoWeek(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`日期「${date}」不對`);
  const day = (d.getUTCDay() + 6) % 7; // 週一 = 0
  d.setUTCDate(d.getUTCDate() - day + 3); // 那一週的週四決定年份
  const year = d.getUTCFullYear();
  const week = 1 + Math.floor((d.getTime() - Date.UTC(year, 0, 1)) / (7 * 86_400_000));
  return `${year}-W${String(week).padStart(2, '0')}`;
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 兩份快照依局數加權合併（併成每週用）。 */
export function mergeSnapshots(period: string, snaps: readonly HistorySnapshot[]): HistorySnapshot {
  const games = snaps.reduce((a, s) => a + s.games, 0);
  const runs = snaps.reduce((a, s) => a + s.runs, 0);
  const sums = new Map<string, { w: number; v: number[] }>();
  for (const s of snaps) {
    const w = Math.max(1, s.games);
    for (const [id, t] of Object.entries(s.bots)) {
      const acc = sums.get(id) ?? { w: 0, v: [0, 0, 0, 0, 0] };
      acc.w += w;
      t.forEach((x, k) => { acc.v[k] += x * w; });
      sums.set(id, acc);
    }
  }
  const bots: Record<string, RatingTuple> = {};
  for (const id of [...sums.keys()].sort()) {
    const { w, v } = sums.get(id)!;
    bots[id] = v.map((x) => Math.round(x / w)) as RatingTuple;
  }
  return { schema: HISTORY_SCHEMA, kind: 'week', period, games, runs, bots };
}

/**
 * 超過 `keepDays` 天的每日快照併進當週的每週快照。輸入 = 現有的快照（含今天的），
 * 輸出 = 要寫的檔（`<period>.json` → 內容）與要刪的每日檔。
 */
export function planRollup(snaps: readonly HistorySnapshot[], today: string, keepDays = KEEP_DAYS): {
  write: Map<string, HistorySnapshot>;
  remove: string[];
} {
  const cutoff = addDays(today, -keepDays);
  const weeks = new Map<string, HistorySnapshot[]>();
  for (const s of snaps) if (s.kind === 'week') weeks.set(s.period, [s]);
  const old = snaps.filter((s) => s.kind === 'day' && s.period < cutoff);
  const write = new Map<string, HistorySnapshot>();
  const remove: string[] = [];
  const touched = new Set<string>();
  for (const s of old) {
    const w = isoWeek(s.period);
    weeks.set(w, [...(weeks.get(w) ?? []), s]);
    touched.add(w);
    remove.push(`${s.period}.json`);
  }
  for (const w of touched) write.set(`${w}.json`, mergeSnapshots(w, weeks.get(w)!));
  return { write, remove: remove.sort() };
}

export interface Trend {
  /** 最近幾天（有跑的那幾天）。 */
  dates: string[];
  /** id → 每天的總分（那天沒出場 = null）。 */
  ratings: Record<string, (number | null)[]>;
}

/** 網站用的小走勢：最近 `days` 份每日快照的總分。 */
export function buildTrend(snaps: readonly HistorySnapshot[], ids: readonly string[], days = TREND_DAYS): Trend {
  const daily = snaps.filter((s) => s.kind === 'day').sort((a, b) => a.period.localeCompare(b.period)).slice(-days);
  const ratings: Record<string, (number | null)[]> = {};
  for (const id of ids) ratings[id] = daily.map((s) => s.bots[id]?.[0] ?? null);
  return { dates: daily.map((s) => s.period), ratings };
}

/** 全部快照（每日＋每週）的局數總和 = 開始每日大賽以來總共打了幾局。 */
export function totalGames(snaps: readonly HistorySnapshot[]): number {
  return snaps.reduce((a, s) => a + s.games, 0);
}

/** 讀進來的快照粗略檢查（壞掉的檔案略過，不要讓整輪失敗）。 */
export function parseSnapshot(raw: unknown): HistorySnapshot | null {
  const s = raw as Partial<HistorySnapshot> | null;
  if (!s || s.schema !== HISTORY_SCHEMA || (s.kind !== 'day' && s.kind !== 'week') || typeof s.period !== 'string'
    || typeof s.games !== 'number' || typeof s.runs !== 'number' || !s.bots || typeof s.bots !== 'object') return null;
  return s as HistorySnapshot;
}
