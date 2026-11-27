/**
 * 統一 AI騎士（B2）— 私人儲存與認領狀態（站長 2026-11-27 裁決）。
 *
 * 沿用每日小觀念／模擬瓦同一套 `GitHubJsonFile`（`bots/conceptDaily/store.ts`），存放在
 * private repo `bot-state/player-knights.json`，沿用既有 `GITHUB_ACCOUNTS_*` 環境變數，
 * 不新增任何環境變數。沒有設定 repo 時退回記憶體（測試與本機開發直接可用）。
 *
 * 內容（皆為私人資料，只存在 private repo）：
 *   - `claims`: 帳號 uid ↔ 玩家 ID 的認領申請（pending / approved / rejected），須站長逐筆核准才生效。
 *   - `knights`: 已核准玩家的騎士第 2 層調整（`adjust`，只接受 `ARENA_KNOBS` 白名單開關）與改動紀錄（含私人回饋原文）。
 *
 * 公開投影（`buildPublicKnightsPayload` → `GET /api/knights/public`）：
 *   只輸出公開開關與必要公開欄位（`playerId`、`knightId`、`adjust` 裡的白名單開關與 `residualOff`、`updatedAt`），
 *   **絕不輸出** `uid`、`ownerUid`、`email`、`note`、`feedback`、`history`、`reviewedBy` 或未核准認領。
 */

import { randomBytes } from 'crypto';
import type { ConceptStateRepoConfig } from '../bots/conceptDaily/config';
import { GitHubJsonFile } from '../bots/conceptDaily/store';
import { knobFor } from '../arena/knobs';
import {
  ARENA_ROLES,
  STYLE_MAX,
  type ArenaRole,
  type ArenaSide,
  type KnobValues,
} from '../arena/profile';

export const PLAYER_KNIGHTS_VERSION = 1;
export const PLAYER_KNIGHTS_PATH = 'bot-state/player-knights.json';
export const CLAIM_NOTE_MAX = 200;
export const FEEDBACK_MAX = 500;
export const PLAYER_ID_MAX = 32;
export const HISTORY_MAX = 50;

export const RESIDUAL_ACTION_KEYS = [
  'team',
  'vote',
  'quest',
  'lakeTarget',
  'lakeClaim',
  'assassinate',
] as const;
export type ResidualActionKey = typeof RESIDUAL_ACTION_KEYS[number];

export type ClaimStatus = 'pending' | 'approved' | 'rejected';

export interface PlayerIdClaim {
  id: string;
  uid: string;
  displayName: string;
  playerId: string;
  knightId: string | null;
  note?: string;
  status: ClaimStatus;
  createdAt: string;
  reviewedAt?: string;
  reviewedBy?: string;
  reviewReason?: string;
}

/** 第 2 層（玩家自己的調整），結構與 B1 `KnightAdjust` 對齊。 */
export interface PlayerKnightAdjust {
  schema: 1;
  note?: string;
  source?: string;
  overrides?: KnobValues;
  sides?: Partial<Record<ArenaSide, KnobValues>>;
  roles?: Partial<Record<ArenaRole, KnobValues>>;
  residualOff?: ResidualActionKey[];
}

export interface PlayerKnightHistoryEntry {
  id: string;
  at: string;
  byUid: string;
  source: string;
  note?: string;
  feedback?: string;
  summary: string;
  adjust: PlayerKnightAdjust;
}

export interface PlayerKnightRecord {
  playerId: string;
  knightId: string | null;
  ownerUid: string;
  adjust: PlayerKnightAdjust;
  updatedAt: string;
  history: PlayerKnightHistoryEntry[];
}

export interface PlayerKnightsState {
  version: number;
  updatedAt: string;
  claims: Record<string, PlayerIdClaim>;
  knights: Record<string, PlayerKnightRecord>;
}

/** 公開端點 `/api/knights/public` 單筆騎士形狀（不含任何個資／回饋原文）。 */
export interface PublicPlayerKnightAdjust {
  schema: 1;
  overrides?: KnobValues;
  sides?: Partial<Record<ArenaSide, KnobValues>>;
  roles?: Partial<Record<ArenaRole, KnobValues>>;
  residualOff?: ResidualActionKey[];
}

export interface PublicPlayerKnight {
  playerId: string;
  knightId: string | null;
  adjust: PublicPlayerKnightAdjust;
  updatedAt: string;
}

export interface PublicKnightsPayload {
  schema: 1;
  updatedAt: string;
  knights: PublicPlayerKnight[];
}

export interface AdjustValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  adjust?: PlayerKnightAdjust;
}

// eslint-disable-next-line no-control-regex
const INVISIBLE_RE = /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/;
const URL_RE = /(https?:\/\/|www\.)/i;
const MENTION_RE = /@[A-Za-z0-9-]/;
const ADJUST_TOP_KEYS = new Set(['schema', 'note', 'source', 'overrides', 'sides', 'roles', 'residualOff']);
const ROLE_SET = new Set<string>(ARENA_ROLES);
const RESIDUAL_SET = new Set<string>(RESIDUAL_ACTION_KEYS);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 玩家 ID 正規化鍵值（NFKC、去空白、小寫），用於避免大小寫／全半形重複認領。 */
export function normalizePlayerIdKey(playerId: string): string {
  return playerId.normalize('NFKC').trim().toLowerCase();
}

export function validatePlayerId(raw: unknown): { ok: true; playerId: string } | { ok: false; error: string } {
  if (typeof raw !== 'string') return { ok: false, error: '玩家 ID 要是文字' };
  const s = raw.normalize('NFKC').trim();
  if (!s) return { ok: false, error: '請輸入玩家 ID' };
  if ([...s].length > PLAYER_ID_MAX) return { ok: false, error: `玩家 ID 最多 ${PLAYER_ID_MAX} 個字` };
  if (INVISIBLE_RE.test(s)) return { ok: false, error: '玩家 ID 不能包含控制或不可見字元' };
  if (URL_RE.test(s) || MENTION_RE.test(s)) return { ok: false, error: '玩家 ID 不能包含網址或 @ 標記' };
  return { ok: true, playerId: s };
}

function checkOptionalText(label: string, raw: unknown, max: number, errors: string[], opts: { allowMention?: boolean } = {}): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') { errors.push(`${label} 要是文字`); return undefined; }
  const s = raw.trim();
  if (!s) return undefined;
  if ([...s].length > max) errors.push(`${label} 最多 ${max} 個字（現在 ${[...s].length}）`);
  if (INVISIBLE_RE.test(s.replace(/\n/g, ''))) errors.push(`${label} 不能包含控制或不可見字元`);
  if (URL_RE.test(s)) errors.push(`${label} 不能放網址`);
  if (!opts.allowMention && MENTION_RE.test(s)) errors.push(`${label} 不能 @ 別人`);
  return s;
}

function checkKnobsBlock(
  where: string,
  raw: unknown,
  errors: string[],
  warnings: string[],
  side?: ArenaSide | 'role',
  role?: ArenaRole,
): KnobValues | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) { errors.push(`${where} 要是物件 {"開關": 值}`); return undefined; }
  const out: KnobValues = {};
  for (const [key, value] of Object.entries(raw)) {
    const knob = knobFor(key);
    if (!knob) {
      errors.push(`${where}.${key}：不在開放的白名單開關清單裡`);
      continue;
    }
    if (knob.kind === 'boolean') {
      if (typeof value !== 'boolean') {
        errors.push(`${where}.${key} 要是 true 或 false`);
        continue;
      }
    } else {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        errors.push(`${where}.${key} 要是數字`);
        continue;
      }
      if (value < knob.min || value > knob.max) {
        errors.push(`${where}.${key} 要在 ${knob.min} 到 ${knob.max} 之間（現在 ${value}）`);
        continue;
      }
    }
    if (side === 'good' && knob.side !== 'good') warnings.push(`${where}.${key} 是紅方／刺客開關，放在藍方區塊沒有作用`);
    if (side === 'evil' && knob.side === 'good') warnings.push(`${where}.${key} 是藍方開關，放在紅方區塊沒有作用`);
    if (side === 'role' && role) {
      const isGood = role === 'merlin' || role === 'percival' || role === 'loyal';
      if (isGood && knob.side !== 'good') warnings.push(`${where}.${key} 是紅方／刺客開關，${role} 用不到`);
      if (!isGood && knob.side === 'good') warnings.push(`${where}.${key} 是藍方開關，${role} 用不到`);
    }
    (out as Record<string, number | boolean>)[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** 驗證第 2 層調整物件（白名單開關、範圍、residualOff、說明文字）。 */
export function validatePlayerKnightAdjust(raw: unknown): AdjustValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isPlainObject(raw)) {
    return { ok: false, errors: ['調整內容要是 JSON 物件'], warnings };
  }
  for (const k of Object.keys(raw)) {
    if (!ADJUST_TOP_KEYS.has(k)) {
      errors.push(`不認得的欄位「${k}」（只接受 schema、note、source、overrides、sides、roles、residualOff）`);
    }
  }
  if (raw.schema !== undefined && raw.schema !== 1) {
    errors.push(`schema 必須是 1（現在 ${String(raw.schema)}）`);
  }

  const note = checkOptionalText('note', raw.note, STYLE_MAX, errors);
  const source = checkOptionalText('source', raw.source, 64, errors);
  const overrides = checkKnobsBlock('overrides', raw.overrides, errors, warnings);

  let sides: Partial<Record<ArenaSide, KnobValues>> | undefined;
  if (raw.sides !== undefined) {
    if (!isPlainObject(raw.sides)) {
      errors.push('sides 要是物件 {"good": {...}, "evil": {...}}');
    } else {
      const s: Partial<Record<ArenaSide, KnobValues>> = {};
      for (const [k, v] of Object.entries(raw.sides)) {
        if (k !== 'good' && k !== 'evil') {
          errors.push(`sides.${k}：只接受 good 或 evil`);
          continue;
        }
        const checked = checkKnobsBlock(`sides.${k}`, v, errors, warnings, k);
        if (checked) s[k] = checked;
      }
      if (Object.keys(s).length > 0) sides = s;
    }
  }

  let roles: Partial<Record<ArenaRole, KnobValues>> | undefined;
  if (raw.roles !== undefined) {
    if (!isPlainObject(raw.roles)) {
      errors.push('roles 要是物件 {"merlin": {...}, ...}');
    } else {
      const r: Partial<Record<ArenaRole, KnobValues>> = {};
      for (const [k, v] of Object.entries(raw.roles)) {
        if (!ROLE_SET.has(k)) {
          errors.push(`roles.${k}：不認得的角色（只接受 ${ARENA_ROLES.join('、')}）`);
          continue;
        }
        const role = k as ArenaRole;
        const checked = checkKnobsBlock(`roles.${k}`, v, errors, warnings, 'role', role);
        if (checked) r[role] = checked;
      }
      if (Object.keys(r).length > 0) roles = r;
    }
  }

  let residualOff: ResidualActionKey[] | undefined;
  if (raw.residualOff !== undefined) {
    if (!Array.isArray(raw.residualOff)) {
      errors.push('residualOff 要是動作名稱陣列');
    } else {
      const seen = new Set<ResidualActionKey>();
      for (const item of raw.residualOff) {
        if (typeof item !== 'string' || !RESIDUAL_SET.has(item)) {
          errors.push(`residualOff 含不認得的動作「${String(item)}」（只接受 ${RESIDUAL_ACTION_KEYS.join('、')}）`);
          continue;
        }
        seen.add(item as ResidualActionKey);
      }
      if (seen.size > 0) residualOff = [...seen];
    }
  }

  if (errors.length > 0) return { ok: false, errors, warnings };

  const adjust: PlayerKnightAdjust = { schema: 1 };
  if (note) adjust.note = note;
  if (source) adjust.source = source;
  if (overrides) adjust.overrides = overrides;
  if (sides) adjust.sides = sides;
  if (roles) adjust.roles = roles;
  if (residualOff) adjust.residualOff = residualOff;
  return { ok: true, errors, warnings, adjust };
}

/** 計算第 2 層改動摘要（存入私人改動紀錄，顯示在我的騎士頁）。 */
export function summarizeAdjustDiff(prev: PlayerKnightAdjust | undefined, next: PlayerKnightAdjust): string {
  const parts: string[] = [];
  const describeLayer = (prefix: string, a?: KnobValues, b?: KnobValues): void => {
    const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
    for (const k of keys) {
      const av = (a as Record<string, unknown> | undefined)?.[k];
      const bv = (b as Record<string, unknown> | undefined)?.[k];
      if (av === bv) continue;
      if (bv === undefined) parts.push(`移除 ${prefix}${k}`);
      else if (av === undefined) parts.push(`${prefix}${k}=${String(bv)}`);
      else parts.push(`${prefix}${k}: ${String(av)}→${String(bv)}`);
    }
  };
  describeLayer('', prev?.overrides, next.overrides);
  for (const side of ['good', 'evil'] as const) {
    describeLayer(`${side}.`, prev?.sides?.[side], next.sides?.[side]);
  }
  for (const role of ARENA_ROLES) {
    describeLayer(`${role}.`, prev?.roles?.[role], next.roles?.[role]);
  }
  const prevOff = (prev?.residualOff ?? []).join(',');
  const nextOff = (next.residualOff ?? []).join(',');
  if (prevOff !== nextOff) {
    parts.push(nextOff ? `停用殘差(${nextOff})` : '啟用全部殘差');
  }
  if (parts.length === 0 && (prev?.note ?? '') !== (next.note ?? '')) {
    parts.push('更新說明文字');
  }
  return parts.length > 0 ? parts.slice(0, 8).join('、') : '無開關變動';
}

export function emptyPlayerKnightsState(): PlayerKnightsState {
  return {
    version: PLAYER_KNIGHTS_VERSION,
    updatedAt: new Date(0).toISOString(),
    claims: {},
    knights: {},
  };
}

export function normalizePlayerKnightsState(raw: unknown): PlayerKnightsState {
  const s = emptyPlayerKnightsState();
  if (!isPlainObject(raw)) return s;
  if (typeof raw.updatedAt === 'string') s.updatedAt = raw.updatedAt;

  if (isPlainObject(raw.claims)) {
    for (const [id, c] of Object.entries(raw.claims)) {
      if (!isPlainObject(c)) continue;
      if (
        typeof c.id === 'string' &&
        typeof c.uid === 'string' &&
        typeof c.playerId === 'string' &&
        (c.status === 'pending' || c.status === 'approved' || c.status === 'rejected') &&
        typeof c.createdAt === 'string'
      ) {
        s.claims[id] = {
          id: c.id,
          uid: c.uid,
          displayName: typeof c.displayName === 'string' ? c.displayName : c.uid,
          playerId: c.playerId,
          knightId: typeof c.knightId === 'string' ? c.knightId : null,
          ...(typeof c.note === 'string' ? { note: c.note } : {}),
          status: c.status,
          createdAt: c.createdAt,
          ...(typeof c.reviewedAt === 'string' ? { reviewedAt: c.reviewedAt } : {}),
          ...(typeof c.reviewedBy === 'string' ? { reviewedBy: c.reviewedBy } : {}),
          ...(typeof c.reviewReason === 'string' ? { reviewReason: c.reviewReason } : {}),
        };
      }
    }
  }

  if (isPlainObject(raw.knights)) {
    for (const [key, k] of Object.entries(raw.knights)) {
      if (!isPlainObject(k)) continue;
      if (typeof k.playerId !== 'string' || typeof k.ownerUid !== 'string') continue;
      const checked = validatePlayerKnightAdjust(k.adjust ?? { schema: 1 });
      const adjust: PlayerKnightAdjust = checked.ok && checked.adjust ? checked.adjust : { schema: 1 };
      const history: PlayerKnightHistoryEntry[] = [];
      if (Array.isArray(k.history)) {
        for (const h of k.history) {
          if (!isPlainObject(h) || typeof h.id !== 'string' || typeof h.at !== 'string' || typeof h.byUid !== 'string') continue;
          const hv = validatePlayerKnightAdjust(h.adjust ?? { schema: 1 });
          history.push({
            id: h.id,
            at: h.at,
            byUid: h.byUid,
            source: typeof h.source === 'string' ? h.source : 'web',
            ...(typeof h.note === 'string' ? { note: h.note } : {}),
            ...(typeof h.feedback === 'string' ? { feedback: h.feedback } : {}),
            summary: typeof h.summary === 'string' ? h.summary : '',
            adjust: hv.ok && hv.adjust ? hv.adjust : { schema: 1 },
          });
        }
      }
      s.knights[key] = {
        playerId: k.playerId,
        knightId: typeof k.knightId === 'string' ? k.knightId : null,
        ownerUid: k.ownerUid,
        adjust,
        updatedAt: typeof k.updatedAt === 'string' ? k.updatedAt : s.updatedAt,
        history: history.slice(-HISTORY_MAX),
      };
    }
  }

  return s;
}

/** 寫入衝突時合併兩份狀態：每一筆 claim／knight 取較晚更新的。 */
export function mergePlayerKnightsStates(base: PlayerKnightsState, mine: PlayerKnightsState): PlayerKnightsState {
  const out: PlayerKnightsState = {
    version: PLAYER_KNIGHTS_VERSION,
    updatedAt: base.updatedAt > mine.updatedAt ? base.updatedAt : mine.updatedAt,
    claims: { ...base.claims },
    knights: { ...base.knights },
  };
  for (const [id, c] of Object.entries(mine.claims)) {
    const prev = out.claims[id];
    const prevTs = prev?.reviewedAt ?? prev?.createdAt ?? '';
    const mineTs = c.reviewedAt ?? c.createdAt;
    if (!prev || mineTs >= prevTs) out.claims[id] = c;
  }
  for (const [key, k] of Object.entries(mine.knights)) {
    const prev = out.knights[key];
    if (!prev || k.updatedAt >= prev.updatedAt) out.knights[key] = k;
  }
  return out;
}

/**
 * 公開投影（給 `GET /api/knights/public` 與每日擂台用）：
 * 只輸出已核准騎士的白名單開關與 `residualOff`，**絕不洩漏** `uid`、`ownerUid`、`email`、`note`、`feedback`、`history`、`claims`。
 */
export function buildPublicKnightsPayload(state: PlayerKnightsState): PublicKnightsPayload {
  const knights: PublicPlayerKnight[] = [];
  for (const record of Object.values(state.knights)) {
    const cleanAdjust: PublicPlayerKnightAdjust = { schema: 1 };
    if (record.adjust.overrides && Object.keys(record.adjust.overrides).length > 0) {
      cleanAdjust.overrides = { ...record.adjust.overrides };
    }
    if (record.adjust.sides && Object.keys(record.adjust.sides).length > 0) {
      cleanAdjust.sides = {};
      if (record.adjust.sides.good) cleanAdjust.sides.good = { ...record.adjust.sides.good };
      if (record.adjust.sides.evil) cleanAdjust.sides.evil = { ...record.adjust.sides.evil };
    }
    if (record.adjust.roles && Object.keys(record.adjust.roles).length > 0) {
      cleanAdjust.roles = {};
      for (const [role, knobs] of Object.entries(record.adjust.roles)) {
        if (knobs) cleanAdjust.roles[role as ArenaRole] = { ...knobs };
      }
    }
    if (record.adjust.residualOff && record.adjust.residualOff.length > 0) {
      cleanAdjust.residualOff = [...record.adjust.residualOff];
    }
    knights.push({
      playerId: record.playerId,
      knightId: record.knightId,
      adjust: cleanAdjust,
      updatedAt: record.updatedAt,
    });
  }
  knights.sort((a, b) => a.playerId.localeCompare(b.playerId, 'zh-Hant'));
  return {
    schema: 1,
    updatedAt: state.updatedAt,
    knights,
  };
}

/**
 * 沿用既有 `GITHUB_ACCOUNTS_*`（不新增環境變數），寫到 private repo 的 `bot-state/player-knights.json`。
 */
export function playerKnightsRepoConfig(env: NodeJS.ProcessEnv = process.env): ConceptStateRepoConfig | null {
  const token = (env.GITHUB_ACCOUNTS_TOKEN || '').trim();
  const repo = (env.GITHUB_ACCOUNTS_REPO || '').trim();
  if (!token || !/^[^/\s]+\/[^/\s]+$/.test(repo)) return null;
  return {
    token,
    repo,
    branch: (env.GITHUB_ACCOUNTS_BRANCH || 'main').trim(),
    path: PLAYER_KNIGHTS_PATH,
    api: (env.GITHUB_API_BASE || 'https://api.github.com').trim(),
  };
}

export interface PlayerKnightsBackend {
  readonly name: string;
  load(): Promise<{ state: PlayerKnightsState; version: string | null } | null>;
  save(state: PlayerKnightsState, version: string | null): Promise<{ ok: true; version: string | null } | { ok: false; conflict: boolean }>;
}

export class MemoryPlayerKnightsBackend implements PlayerKnightsBackend {
  readonly name = 'memory';
  private raw: string | null = null;
  private v = 0;

  async load(): Promise<{ state: PlayerKnightsState; version: string | null } | null> {
    if (!this.raw) return null;
    return { state: normalizePlayerKnightsState(JSON.parse(this.raw)), version: String(this.v) };
  }

  async save(state: PlayerKnightsState, version: string | null): Promise<{ ok: true; version: string } | { ok: false; conflict: boolean }> {
    if (this.raw !== null && version !== String(this.v)) return { ok: false, conflict: true };
    this.raw = JSON.stringify(state);
    this.v += 1;
    return { ok: true, version: String(this.v) };
  }
}

export class GitHubPlayerKnightsBackend implements PlayerKnightsBackend {
  readonly name = 'github';
  private readonly file: GitHubJsonFile;

  constructor(cfg: ConceptStateRepoConfig, fetchImpl: typeof fetch = fetch, timeoutMs = 8_000) {
    this.file = new GitHubJsonFile(cfg, fetchImpl, timeoutMs);
  }

  async load(): Promise<{ state: PlayerKnightsState; version: string | null } | null> {
    const got = await this.file.read();
    return got ? { state: normalizePlayerKnightsState(got.json), version: got.sha } : null;
  }

  async save(state: PlayerKnightsState, version: string | null): Promise<{ ok: true; version: string | null } | { ok: false; conflict: boolean }> {
    const res = await this.file.write(
      `${JSON.stringify(state, null, 2)}\n`,
      `bot-state: player knights ${state.updatedAt.slice(0, 10)}`,
      version,
    );
    return res.ok ? { ok: true, version: res.sha } : res;
  }
}

export type StoreOpResult<T> = { ok: true; data: T } | { ok: false; code: string; error: string };

export class PlayerKnightsStore {
  private state: PlayerKnightsState = emptyPlayerKnightsState();
  private version: string | null = null;
  private loading: Promise<void> | null = null;
  private writing: Promise<void> = Promise.resolve();
  private dirty = false;

  constructor(
    readonly backend: PlayerKnightsBackend,
    private readonly logger: { warn: (m: string) => void } = { warn: (m) => console.warn(`[player-knights] ${m}`) },
  ) {}

  ready(): Promise<void> {
    this.loading ??= (async (): Promise<void> => {
      try {
        const got = await this.backend.load();
        if (got) {
          this.state = mergePlayerKnightsStates(got.state, this.state);
          this.version = got.version;
        }
      } catch (err) {
        this.logger.warn(`loading state from ${this.backend.name} failed (${err instanceof Error ? err.message.slice(0, 80) : typeof err})`);
      }
    })();
    return this.loading;
  }

  getState(): PlayerKnightsState {
    return this.state;
  }

  getPublicPayload(): PublicKnightsPayload {
    return buildPublicKnightsPayload(this.state);
  }

  getClaimsByUid(uid: string): PlayerIdClaim[] {
    return Object.values(this.state.claims)
      .filter((c) => c.uid === uid)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  getAllClaims(): PlayerIdClaim[] {
    const rank = (s: ClaimStatus): number => (s === 'pending' ? 0 : s === 'approved' ? 1 : 2);
    return Object.values(this.state.claims).sort((a, b) => {
      const r = rank(a.status) - rank(b.status);
      if (r !== 0) return r;
      return a.createdAt < b.createdAt ? 1 : -1;
    });
  }

  getApprovedKnightByUid(uid: string): PlayerKnightRecord | null {
    for (const k of Object.values(this.state.knights)) {
      if (k.ownerUid === uid) return k;
    }
    return null;
  }

  getKnightByPlayerId(playerId: string): PlayerKnightRecord | null {
    return this.state.knights[normalizePlayerIdKey(playerId)] ?? null;
  }

  getKnightByKnightId(knightId: string): PlayerKnightRecord | null {
    for (const k of Object.values(this.state.knights)) {
      if (k.knightId === knightId) return k;
    }
    return null;
  }

  /** 玩家送出「這個 ID 是我」認領申請（一律先進入 pending，等站長核准）。 */
  async submitClaim(params: {
    uid: string;
    displayName: string;
    playerId: string;
    knightId: string | null;
    note?: string;
  }): Promise<StoreOpResult<PlayerIdClaim>> {
    await this.ready();
    const checkedId = validatePlayerId(params.playerId);
    if (!checkedId.ok) return { ok: false, code: 'invalid_player_id', error: checkedId.error };

    const noteErrors: string[] = [];
    const note = checkOptionalText('補充說明', params.note, CLAIM_NOTE_MAX, noteErrors);
    if (noteErrors.length > 0) return { ok: false, code: 'invalid_note', error: noteErrors[0] };

    const key = normalizePlayerIdKey(checkedId.playerId);
    const existingOwner = this.state.knights[key];
    if (existingOwner && existingOwner.ownerUid !== params.uid) {
      return { ok: false, code: 'already_claimed', error: `玩家 ID「${checkedId.playerId}」已被其他帳號認領` };
    }
    if (existingOwner && existingOwner.ownerUid === params.uid) {
      return { ok: false, code: 'already_owned', error: `你已經擁有玩家 ID「${existingOwner.playerId}」` };
    }

    const myExistingKnight = this.getApprovedKnightByUid(params.uid);
    if (myExistingKnight) {
      return { ok: false, code: 'user_already_has_knight', error: `你的帳號已綁定玩家 ID「${myExistingKnight.playerId}」` };
    }

    const dupPending = Object.values(this.state.claims).find(
      (c) => c.uid === params.uid && c.status === 'pending' && normalizePlayerIdKey(c.playerId) === key,
    );
    if (dupPending) {
      return { ok: false, code: 'duplicate_pending', error: '這個玩家 ID 已有待審核的認領申請' };
    }

    const now = new Date().toISOString();
    const claim: PlayerIdClaim = {
      id: `claim_${Date.now()}_${randomBytes(4).toString('hex')}`,
      uid: params.uid,
      displayName: params.displayName.trim() || params.uid,
      playerId: checkedId.playerId,
      knightId: params.knightId,
      ...(note ? { note } : {}),
      status: 'pending',
      createdAt: now,
    };

    await this.mutate((s) => {
      s.claims[claim.id] = claim;
      s.updatedAt = now;
    });
    return { ok: true, data: claim };
  }

  /** 站長逐筆核准或退回認領申請。 */
  async reviewClaim(params: {
    claimId: string;
    decision: 'approved' | 'rejected';
    adminEmail: string;
    reason?: string;
    resolveKnightId?: (playerId: string) => string | null;
  }): Promise<StoreOpResult<PlayerIdClaim>> {
    await this.ready();
    const existing = this.state.claims[params.claimId];
    if (!existing) return { ok: false, code: 'not_found', error: '找不到這筆認領申請' };
    if (existing.status !== 'pending') {
      return { ok: false, code: 'already_reviewed', error: `這筆申請已經處理過（${existing.status}）` };
    }

    const reasonErrors: string[] = [];
    const reason = checkOptionalText('審核備註', params.reason, CLAIM_NOTE_MAX, reasonErrors);
    if (reasonErrors.length > 0) return { ok: false, code: 'invalid_reason', error: reasonErrors[0] };

    const key = normalizePlayerIdKey(existing.playerId);
    if (params.decision === 'approved') {
      const owned = this.state.knights[key];
      if (owned && owned.ownerUid !== existing.uid) {
        return { ok: false, code: 'already_claimed', error: `玩家 ID「${existing.playerId}」已被其他帳號認領` };
      }
      const userOwned = this.getApprovedKnightByUid(existing.uid);
      if (userOwned && normalizePlayerIdKey(userOwned.playerId) !== key) {
        return { ok: false, code: 'user_already_has_knight', error: `該帳號已綁定其他玩家 ID（${userOwned.playerId}）` };
      }
    }

    const now = new Date().toISOString();
    const updatedClaim: PlayerIdClaim = {
      ...existing,
      status: params.decision,
      reviewedAt: now,
      reviewedBy: params.adminEmail,
      ...(reason ? { reviewReason: reason } : {}),
    };

    await this.mutate((s) => {
      s.claims[existing.id] = updatedClaim;
      if (params.decision === 'approved') {
        const prevKnight = s.knights[key];
        const knightId = existing.knightId ?? params.resolveKnightId?.(existing.playerId) ?? prevKnight?.knightId ?? null;
        s.knights[key] = prevKnight
          ? { ...prevKnight, ownerUid: existing.uid, knightId, updatedAt: now }
          : {
              playerId: existing.playerId,
              knightId,
              ownerUid: existing.uid,
              adjust: { schema: 1 },
              updatedAt: now,
              history: [],
            };
      }
      s.updatedAt = now;
    });

    return { ok: true, data: updatedClaim };
  }

  /** 已核准的玩家更新自己的第 2 層 `adjust` 並寫入私人改動紀錄。 */
  async saveAdjust(params: {
    uid: string;
    adjust: unknown;
    feedback?: string;
    source?: string;
  }): Promise<StoreOpResult<{ record: PlayerKnightRecord; warnings: string[] }>> {
    await this.ready();
    const owned = this.getApprovedKnightByUid(params.uid);
    if (!owned) {
      return { ok: false, code: 'not_approved', error: '請先完成玩家 ID 認領並由站長核准，才能調整自己的騎士' };
    }

    const validated = validatePlayerKnightAdjust(params.adjust);
    if (!validated.ok || !validated.adjust) {
      return { ok: false, code: 'invalid_adjust', error: validated.errors.join('；') };
    }

    const fbErrors: string[] = [];
    const feedback = checkOptionalText('回饋說明', params.feedback, FEEDBACK_MAX, fbErrors, { allowMention: false });
    if (fbErrors.length > 0) return { ok: false, code: 'invalid_feedback', error: fbErrors[0] };

    const source = (params.source?.trim() || validated.adjust.source || 'web').slice(0, 64);
    const nextAdjust: PlayerKnightAdjust = { ...validated.adjust, source };
    const now = new Date().toISOString();
    const summary = summarizeAdjustDiff(owned.adjust, nextAdjust);
    const entry: PlayerKnightHistoryEntry = {
      id: `adj_${Date.now()}_${randomBytes(3).toString('hex')}`,
      at: now,
      byUid: params.uid,
      source,
      ...(nextAdjust.note ? { note: nextAdjust.note } : {}),
      ...(feedback ? { feedback } : {}),
      summary,
      adjust: nextAdjust,
    };

    const key = normalizePlayerIdKey(owned.playerId);
    let saved!: PlayerKnightRecord;
    await this.mutate((s) => {
      const current = s.knights[key];
      const history = [...(current?.history ?? []), entry].slice(-HISTORY_MAX);
      saved = {
        ...owned,
        adjust: nextAdjust,
        updatedAt: now,
        history,
      };
      s.knights[key] = saved;
      s.updatedAt = now;
    });

    return { ok: true, data: { record: saved, warnings: validated.warnings } };
  }

  private mutate(fn: (s: PlayerKnightsState) => void): Promise<void> {
    fn(this.state);
    this.dirty = true;
    this.writing = this.writing.then(() => this.flush());
    return this.writing;
  }

  private async flush(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await this.backend.save(this.state, this.version);
        if (res.ok) {
          this.version = res.version;
          return;
        }
        if (!res.conflict) break;
        const fresh = await this.backend.load();
        if (fresh) {
          this.state = mergePlayerKnightsStates(fresh.state, this.state);
          this.version = fresh.version;
        } else {
          this.version = null;
        }
      } catch (err) {
        this.logger.warn(`saving state to ${this.backend.name} failed (${err instanceof Error ? err.message.slice(0, 80) : typeof err})`);
        break;
      }
    }
    this.dirty = true;
  }
}

let singleton: PlayerKnightsStore | null = null;

export function getPlayerKnightsStore(): PlayerKnightsStore {
  if (!singleton) {
    const cfg = playerKnightsRepoConfig();
    const backend: PlayerKnightsBackend = cfg
      ? new GitHubPlayerKnightsBackend(cfg)
      : new MemoryPlayerKnightsBackend();
    if (!cfg) {
      console.warn('[player-knights] GITHUB_ACCOUNTS_REPO/TOKEN not set; using in-memory store');
    }
    singleton = new PlayerKnightsStore(backend);
  }
  return singleton;
}
