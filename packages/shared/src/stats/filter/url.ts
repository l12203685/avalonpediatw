/**
 * 篩選物件的驗證與分享連結編碼（r9 設計 §3.7）：`1.<base64url(UTF-8 JSON)>`。
 *
 * 外來的篩選（網址、機器人、伺服器請求）一律先經 sanitizeFilter：未知的子句丟掉、欄位用白名單驗證
 * （數值範圍、日期格式、角色名、座號 1..10），有問題的子句丟掉並回報；名字不在這裡對（apply.ts 對到
 * 資料集的正式名字，找不到時該子句不生效）。
 */
import { ALL_ROLES } from '../constants';
import {
  GAME_CLAUSE_KINDS, LEADERBOARD_OVERRIDE_RANGES, METRIC_IDS,
  type Clause, type FilterOptions, type GameFilter, type LeaderboardOverrideKey, type LeaderboardOverrides,
} from './types';

export const FILTER_URL_VERSION = '1';

type Spec =
  | 'bool' | 'int' | 'num' | 'date' | 'name' | 'names' | 'ints' | 'roles' | 'role' | 'seats' | 'side'
  | { enum: readonly string[] } | { enums: readonly string[] } | { range: [number, number] };

interface KindSchema {
  required?: Record<string, Spec>;
  optional?: Record<string, Spec>;
}

const SIDE = { enum: ['red', 'blue'] } as const;
/** 任務順序的開頭：藍／紅組成、1–5 個字（62 種）。 */
const MISSION_SEQ_PREFIXES: readonly string[] = ((): string[] => {
  const out: string[] = [];
  let level = [''];
  for (let i = 0; i < 5; i += 1) {
    level = level.flatMap((p) => [`${p}藍`, `${p}紅`]);
    out.push(...level);
  }
  return out;
})();
const SCHEMA: Record<string, KindSchema> = {
  category: { required: { in: { enums: ['線瓦', '面瓦', '娛樂', '未分類', '其他'] } } },
  source: { required: { in: { enums: ['sheet', 'discord'] } } },
  date: { optional: { from: 'date', to: 'date', undated: { enum: ['exclude', 'include'] } } },
  weekday: { required: { in: 'ints' } },
  sessionIndex: { optional: { min: 'int', max: 'int' } },
  season: { required: { in: 'names' } },
  venue: { required: { in: 'names' } },
  noteFlag: { required: { any: 'names' } },
  namedSeats: { optional: { min: 'int', max: 'int' } },
  outcome: { required: { in: { enums: ['三紅', '三藍死', '三藍活', 'other'] } } },
  finalWinner: { required: { is: SIDE } },
  missionCount: { required: { in: 'ints' } },
  mission: { required: { round: { range: [1, 5] } }, optional: { result: { enum: ['pass', 'fail'] }, minFails: 'int', maxFails: 'int' } },
  gameState: { required: { in: 'names' } },
  missionSeq: { required: { prefix: { enum: MISSION_SEQ_PREFIXES } } },
  firstTeam: { optional: { redCount: 'ints', hasMerlin: 'bool', hasPercival: 'bool' } },
  lakeCount: { required: { in: 'ints' } },
  lake: {
    required: { index: { range: [1, 3] } },
    optional: { holderSide: SIDE, targetSide: SIDE, holderRole: 'roles', targetRole: 'roles', claim: { enums: ['red', 'blue', 'none'] } },
  },
  assassination: { required: { target: { enums: [...ALL_ROLES, 'none'] } } },
  roleSeat: { required: { role: 'role', seats: 'seats' } },
  trioOrder: { required: { in: { enums: ['派梅娜', '派娜梅', '梅派娜', '梅娜派', '娜派梅', '娜梅派'] } } },
  captain: { required: { round: { range: [1, 5] }, side: SIDE } },
  gameId: { required: { in: 'names' } },
  lineup: {
    optional: {
      sMin: { range: [0, 100] }, strongPr: { range: [0, 100] }, strongCount: { range: [1, 10] },
      merlinPrMin: { range: [0, 100] }, percivalPrMin: { range: [0, 100] }, redMinPrMin: { range: [0, 100] },
      loyalMinPrMin: { range: [0, 100] }, gapMin: { range: [-100, 100] },
      combine: { enum: ['and', 'or'] }, includeUnscored: 'bool',
    },
  },
  withPlayer: {
    required: { player: 'name' },
    optional: { role: 'roles', side: SIDE, seat: 'seats', result: { enum: ['win', 'loss'] }, resultRule: { enum: ['final', 'mission'] } },
  },
  withAnyPlayer: { required: { players: 'names' } },
  withPlayers: { required: { players: 'names', relation: { enum: ['together', 'sameTeam', 'opposingTeams'] } } },
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_LIST = 200;
const MAX_TEXT = 100;

function valid(spec: Spec, v: unknown): boolean {
  const isInt = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x) && Math.abs(x) < 1e7;
  const isText = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= MAX_TEXT;
  const list = (x: unknown, item: (y: unknown) => boolean): boolean =>
    Array.isArray(x) && x.length > 0 && x.length <= MAX_LIST && x.every(item);
  if (spec === 'bool') return typeof v === 'boolean';
  if (spec === 'int') return isInt(v);
  if (spec === 'num') return typeof v === 'number' && Number.isFinite(v);
  if (spec === 'date') return typeof v === 'string' && DATE_RE.test(v);
  if (spec === 'name') return isText(v);
  if (spec === 'names') return list(v, isText);
  if (spec === 'ints') return list(v, isInt);
  if (spec === 'role') return (ALL_ROLES as readonly unknown[]).includes(v);
  if (spec === 'roles') return list(v, (x) => (ALL_ROLES as readonly unknown[]).includes(x));
  if (spec === 'seats') return list(v, (x) => isInt(x) && x >= 1 && x <= 10);
  if (spec === 'side') return v === 'red' || v === 'blue';
  if ('enum' in spec) return spec.enum.includes(v as string);
  if ('enums' in spec) return list(v, (x) => spec.enums.includes(x as string));
  if ('range' in spec) return isInt(v) && v >= spec.range[0] && v <= spec.range[1];
  return false;
}

function sanitizeSelector(raw: unknown): Clause | string {
  const c = raw as Record<string, unknown>;
  const who = c.who as Record<string, unknown> | undefined;
  if (c.scope !== 'dropGames' && c.scope !== 'hideFromLists') return 'excludePlayers.scope';
  if (!who || typeof who !== 'object') return 'excludePlayers.who';
  const extra = c.dropIncompleteGames === true ? { dropIncompleteGames: true } : {};
  if (who.by === 'names') {
    if (!valid('names', who.names)) return 'excludePlayers.who.names';
    return { kind: 'excludePlayers', scope: c.scope, who: { by: 'names', names: who.names as string[], ...(who.invert === true ? { invert: true } : {}) }, ...extra };
  }
  if (who.by !== 'metric') return 'excludePlayers.who.by';
  if (!(METRIC_IDS as readonly unknown[]).includes(who.metric)) return 'excludePlayers.who.metric';
  if (!valid({ enum: ['gt', 'ge', 'lt', 'le'] }, who.op)) return 'excludePlayers.who.op';
  const hasValue = valid('num', who.value);
  const hasPr = valid('num', who.pr) && (who.pr as number) >= 0 && (who.pr as number) <= 100;
  if (hasValue === hasPr) return 'excludePlayers.who: give value or pr';
  if (who.role !== undefined && !valid('role', who.role)) return 'excludePlayers.who.role';
  if (who.minGames !== undefined && !(valid('int', who.minGames) && (who.minGames as number) >= 0)) return 'excludePlayers.who.minGames';
  const selector: Record<string, unknown> = { by: 'metric', metric: who.metric, op: who.op };
  if (who.role !== undefined) selector.role = who.role;
  if (hasValue) selector.value = who.value;
  else selector.pr = who.pr;
  if (who.evaluatedOn === 'filtered') selector.evaluatedOn = 'filtered';
  if (who.ineligible === 'select') selector.ineligible = 'select';
  if (who.minGames !== undefined) selector.minGames = who.minGames;
  if (who.invert === true) selector.invert = true;
  return { kind: 'excludePlayers', scope: c.scope, who: selector, ...extra } as Clause;
}

/** options.leaderboard：只留已知的鍵、範圍內的整數（依 LEADERBOARD_OVERRIDE_RANGES 的順序）。 */
export function sanitizeLeaderboardOverrides(raw: unknown, warnings: string[] = []): LeaderboardOverrides {
  const out: LeaderboardOverrides = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push('options.leaderboard');
    return out;
  }
  const r = raw as Record<string, unknown>;
  for (const key of Object.keys(r)) {
    if (!(key in LEADERBOARD_OVERRIDE_RANGES)) warnings.push(`options.leaderboard.${key}`);
  }
  for (const [key, [lo, hi]] of Object.entries(LEADERBOARD_OVERRIDE_RANGES) as Array<[LeaderboardOverrideKey, readonly [number, number]]>) {
    const v = r[key];
    if (v === undefined) continue;
    if (typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi) out[key] = v;
    else warnings.push(`options.leaderboard.${key}`);
  }
  return out;
}

/** 外來的篩選 → 只含合法子句的 GameFilter（null = 不是篩選物件）與被丟掉的原因。 */
export function sanitizeFilter(raw: unknown): { filter: GameFilter | null; warnings: string[] } {
  const warnings: string[] = [];
  if (!raw || typeof raw !== 'object') return { filter: null, warnings: ['not a filter'] };
  const r = raw as Record<string, unknown>;
  if (r.v !== 1) return { filter: null, warnings: ['unsupported filter version'] };
  const clauses: Clause[] = [];
  const list = Array.isArray(r.clauses) ? r.clauses.slice(0, 50) : [];
  list.forEach((rawClause, i) => {
    const c = rawClause as Record<string, unknown>;
    if (!c || typeof c !== 'object') {
      warnings.push(`clauses[${i}]: not an object`);
      return;
    }
    if (c.kind === 'excludePlayers') {
      const out = sanitizeSelector(c);
      if (typeof out === 'string') warnings.push(`clauses[${i}]: ${out}`);
      else clauses.push(out);
      return;
    }
    if (!(GAME_CLAUSE_KINDS as readonly unknown[]).includes(c.kind)) {
      warnings.push(`clauses[${i}]: unknown kind`);
      return;
    }
    const schema = SCHEMA[c.kind as string];
    const out: Record<string, unknown> = { kind: c.kind };
    for (const [field, spec] of Object.entries(schema.required ?? {})) {
      if (!valid(spec, c[field])) {
        warnings.push(`clauses[${i}].${field}`);
        return;
      }
      out[field] = c[field];
    }
    for (const [field, spec] of Object.entries(schema.optional ?? {})) {
      if (c[field] === undefined) continue;
      if (!valid(spec, c[field])) {
        warnings.push(`clauses[${i}].${field}`);
        return;
      }
      out[field] = c[field];
    }
    if (c.kind === 'withPlayers' && (c.players as unknown[]).length !== 2) {
      warnings.push(`clauses[${i}].players`);
      return;
    }
    if (c.not === true) out.not = true;
    clauses.push(out as unknown as Clause);
  });
  const options: FilterOptions = {};
  const o = (r.options ?? {}) as Record<string, unknown>;
  if (o.activity === 'all' || o.activity === 'none') options.activity = o.activity;
  if (typeof o.asOf === 'string' && DATE_RE.test(o.asOf)) options.asOf = o.asOf;
  if (o.leaderboard !== undefined) {
    const lb = sanitizeLeaderboardOverrides(o.leaderboard, warnings);
    if (Object.keys(lb).length) options.leaderboard = lb;
  }
  const filter: GameFilter = { v: 1, clauses };
  if (Object.keys(options).length) filter.options = options;
  return { filter, warnings };
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function utf8Bytes(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
  }
  return out;
}

function utf8Text(bytes: number[]): string {
  let out = '';
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i];
    let cp: number;
    let n: number;
    if (b < 0x80) { cp = b; n = 1; } else if (b >> 5 === 6) { cp = b & 31; n = 2; } else if (b >> 4 === 14) { cp = b & 15; n = 3; } else { cp = b & 7; n = 4; }
    for (let k = 1; k < n; k += 1) cp = (cp << 6) | ((bytes[i + k] ?? 0) & 63);
    out += String.fromCodePoint(cp);
    i += n;
  }
  return out;
}

function base64url(bytes: number[]): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    if (i + 1 < bytes.length) out += B64[(n >> 6) & 63];
    if (i + 2 < bytes.length) out += B64[n & 63];
  }
  return out;
}

function fromBase64url(text: string): number[] | null {
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of text) {
    const v = B64.indexOf(ch);
    if (v < 0) return null;
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 255);
    }
  }
  return bytes;
}

/** 分享連結用的字串：`1.<base64url(JSON)>`。 */
export function encodeFilter(filter: GameFilter): string {
  return `${FILTER_URL_VERSION}.${base64url(utf8Bytes(JSON.stringify(filter)))}`;
}

/** encodeFilter 的反向，經過 sanitizeFilter。壞掉的字串 → filter null。 */
export function decodeFilter(text: string): { filter: GameFilter | null; warnings: string[] } {
  const dot = text.indexOf('.');
  if (dot < 0 || text.slice(0, dot) !== FILTER_URL_VERSION) return { filter: null, warnings: ['unsupported link version'] };
  const bytes = fromBase64url(text.slice(dot + 1));
  if (!bytes) return { filter: null, warnings: ['bad link'] };
  try {
    return sanitizeFilter(JSON.parse(utf8Text(bytes)));
  } catch {
    return { filter: null, warnings: ['bad link'] };
  }
}
