/**
 * AI 擂台的機器人設定檔（profile.json，第 1 階段：資料，不是程式）。
 *
 * 一隻機器人 = 百科AI 的引擎 ＋ 白名單裡的風格開關（`knobs.ts`）。這個模組是純函式、不讀檔：
 * 社群資料夾（`community-bots/<id>/profile.json`）、CLI 的 `arena:check`，以及之後網站上直接調的機器人
 * （「代理騎士」，存在伺服器、匯出成 profile 清單）都用同一份檢查與同一套解析。
 */
import { DEFAULT_AGENT_TUNING, type AgentTuning } from '../ai/AgentTuning';
import { ARENA_KNOBS, knobFor } from './knobs';

export const PROFILE_SCHEMA_VERSION = 1;

export const ARENA_ROLES = ['merlin', 'percival', 'loyal', 'assassin', 'morgana', 'mordred', 'oberon'] as const;
export type ArenaRole = typeof ARENA_ROLES[number];
export type ArenaSide = 'good' | 'evil';

export type KnobValues = Partial<Record<keyof AgentTuning, number | boolean>>;

export interface BotProfile {
  schema: number;
  /** 顯示名稱（排行榜上的名字）。 */
  name: string;
  /** 作者自己選擇公開的 GitHub 帳號（不含 @）。 */
  author: string;
  /** 打法說明（作者自己寫的一段話）。 */
  style: string;
  /** 所有座位都套用的開關。 */
  overrides?: KnobValues;
  /** 只在這一邊套用（後蓋前：overrides → sides → roles）。 */
  sides?: Partial<Record<ArenaSide, KnobValues>>;
  /** 只在拿到這個角色時套用。 */
  roles?: Partial<Record<ArenaRole, KnobValues>>;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  profile?: BotProfile;
}

export const BOT_ID_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;
export const GITHUB_HANDLE_RE = /^(?!-)[A-Za-z0-9-]{1,39}$/;
export const NAME_MAX = 24;
export const STYLE_MAX = 300;

/** 保留字：不能冒充官方或管理員（大小寫、空白不分）。 */
const RESERVED_NAME_PARTS = ['百科ai', '百科機器人', 'avalonpedia', '官方', 'official', '管理員', 'admin', '站長', 'moderator'];

const URL_RE = /(https?:\/\/|www\.)/i;
const MENTION_RE = /@[A-Za-z0-9-]/;
// 控制字元與看不見的字元（零寬、雙向控制）會讓名字看起來和實際不同。
// eslint-disable-next-line no-control-regex
const INVISIBLE_RE = /[\u0000-\u001f\u007f​-‏‪-‮⁠-⁤﻿]/;

const TOP_KEYS = new Set(['schema', 'name', 'author', 'style', 'overrides', 'sides', 'roles']);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function checkText(label: string, v: unknown, max: number, errors: string[], opts: { multiline?: boolean } = {}): string | undefined {
  if (typeof v !== 'string') { errors.push(`${label} 要是文字`); return undefined; }
  const s = v.trim();
  if (s.length === 0) { errors.push(`${label} 不能空白`); return undefined; }
  if ([...s].length > max) errors.push(`${label} 最多 ${max} 個字（現在 ${[...s].length}）`);
  const invisible = opts.multiline ? s.replace(/\n/g, '') : s;
  if (INVISIBLE_RE.test(invisible)) errors.push(`${label} 不能有控制字元或看不見的字元`);
  if (URL_RE.test(s)) errors.push(`${label} 不能放網址`);
  if (MENTION_RE.test(s)) errors.push(`${label} 不能 @ 別人`);
  return s;
}

function checkKnobs(where: string, raw: unknown, errors: string[], warnings: string[], side?: ArenaSide | 'role', role?: ArenaRole): KnobValues | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) { errors.push(`${where} 要是物件 {"開關": 值}`); return undefined; }
  const out: KnobValues = {};
  for (const [key, value] of Object.entries(raw)) {
    const knob = knobFor(key);
    if (!knob) { errors.push(`${where}.${key}：不在開放的開關清單裡（見 community-bots/README.md）`); continue; }
    if (knob.kind === 'boolean') {
      if (typeof value !== 'boolean') { errors.push(`${where}.${key} 要是 true 或 false`); continue; }
    } else {
      if (typeof value !== 'number' || !Number.isFinite(value)) { errors.push(`${where}.${key} 要是數字`); continue; }
      if (value < knob.min || value > knob.max) { errors.push(`${where}.${key} 要在 ${knob.min} 到 ${knob.max} 之間（現在 ${value}）`); continue; }
    }
    // 放在不會用到的區塊：沒有作用，但不算錯。
    if (side === 'good' && knob.side !== 'good') warnings.push(`${where}.${key} 是紅方／刺客的開關，放在藍方區塊沒有作用`);
    if (side === 'evil' && knob.side === 'good') warnings.push(`${where}.${key} 是藍方的開關，放在紅方區塊沒有作用`);
    if (side === 'role' && role) {
      const good = role === 'merlin' || role === 'percival' || role === 'loyal';
      if (good && knob.side !== 'good') warnings.push(`${where}.${key} 是紅方／刺客的開關，${role} 用不到`);
      if (!good && knob.side === 'good') warnings.push(`${where}.${key} 是藍方的開關，${role} 用不到`);
    }
    (out as Record<string, number | boolean>)[key] = value;
  }
  return out;
}

/**
 * 檢查一份 profile（JSON.parse 之後的物件）。`id` 是資料夾名稱（社群資料夾才有）。
 * 只看格式、白名單與範圍；「一人一隻」「名字重複」是整個名冊的檢查（`validateRoster`）。
 */
export function validateProfile(raw: unknown, id?: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (id !== undefined && !BOT_ID_RE.test(id)) {
    errors.push(`資料夾名稱「${id}」只能用小寫英文、數字、減號，2–32 個字，開頭不能是減號`);
  }
  if (!isPlainObject(raw)) return { ok: false, errors: [...errors, 'profile.json 要是一個 JSON 物件'], warnings };
  for (const key of Object.keys(raw)) if (!TOP_KEYS.has(key)) errors.push(`不認得的欄位「${key}」`);
  if (raw.schema !== PROFILE_SCHEMA_VERSION) errors.push(`schema 要是 ${PROFILE_SCHEMA_VERSION}`);
  const name = checkText('name', raw.name, NAME_MAX, errors);
  if (name) {
    const folded = name.toLowerCase().replace(/\s+/g, '');
    const hit = RESERVED_NAME_PARTS.find((p) => folded.includes(p));
    if (hit) errors.push(`name 不能包含「${hit}」（保留給官方）`);
  }
  let author: string | undefined;
  if (typeof raw.author !== 'string' || !GITHUB_HANDLE_RE.test(raw.author)) {
    errors.push('author 要是你的 GitHub 帳號（英文、數字、減號，不含 @）');
  } else author = raw.author;
  const style = checkText('style', raw.style, STYLE_MAX, errors, { multiline: true });
  const overrides = checkKnobs('overrides', raw.overrides, errors, warnings);
  let sides: BotProfile['sides'];
  if (raw.sides !== undefined) {
    if (!isPlainObject(raw.sides)) errors.push('sides 要是物件 {"good": {...}, "evil": {...}}');
    else {
      sides = {};
      for (const [k, v] of Object.entries(raw.sides)) {
        if (k !== 'good' && k !== 'evil') { errors.push(`sides 只能有 good、evil，不認得「${k}」`); continue; }
        const vals = checkKnobs(`sides.${k}`, v, errors, warnings, k);
        if (vals) sides[k] = vals;
      }
    }
  }
  let roles: BotProfile['roles'];
  if (raw.roles !== undefined) {
    if (!isPlainObject(raw.roles)) errors.push('roles 要是物件 {"merlin": {...}, ...}');
    else {
      roles = {};
      for (const [k, v] of Object.entries(raw.roles)) {
        if (!(ARENA_ROLES as readonly string[]).includes(k)) { errors.push(`roles 不認得角色「${k}」（可用：${ARENA_ROLES.join('、')}）`); continue; }
        const vals = checkKnobs(`roles.${k}`, v, errors, warnings, 'role', k as ArenaRole);
        if (vals) roles[k as ArenaRole] = vals;
      }
    }
  }
  const knobCount = Object.keys(overrides ?? {}).length
    + Object.values(sides ?? {}).reduce((n, v) => n + Object.keys(v ?? {}).length, 0)
    + Object.values(roles ?? {}).reduce((n, v) => n + Object.keys(v ?? {}).length, 0);
  if (errors.length === 0 && knobCount === 0) warnings.push('沒有改任何開關：這隻會和百科AI 打得一模一樣');
  if (errors.length > 0) return { ok: false, errors, warnings };
  const profile: BotProfile = { schema: PROFILE_SCHEMA_VERSION, name: name!, author: author!, style: style! };
  if (overrides) profile.overrides = overrides;
  if (sides) profile.sides = sides;
  if (roles) profile.roles = roles;
  return { ok: true, errors, warnings, profile };
}

export interface RosterEntry {
  id: string;
  profile: BotProfile;
}

/** 整個名冊的規則：名字不能重複（大小寫、空白不分）；一開始一人一隻。 */
export function validateRoster(entries: readonly RosterEntry[]): string[] {
  const errors: string[] = [];
  const byName = new Map<string, string>();
  const byAuthor = new Map<string, string>();
  for (const e of entries) {
    const n = e.profile.name.toLowerCase().replace(/\s+/g, '');
    const prevName = byName.get(n);
    if (prevName) errors.push(`${e.id}：名字「${e.profile.name}」和 ${prevName} 重複`);
    else byName.set(n, e.id);
    const a = e.profile.author.toLowerCase();
    const prevAuthor = byAuthor.get(a);
    if (prevAuthor) errors.push(`${e.id}：作者 ${e.profile.author} 已經有一隻（${prevAuthor}）；目前一人一隻`);
    else byAuthor.set(a, e.id);
  }
  return errors;
}

/**
 * 某個座位實際用的開關：正式預設（不讀環境變數，結果可重現）→ overrides → sides[陣營] → roles[角色]。
 * `profile` 為 null = 百科AI 本身（參考點）。
 */
export function resolveProfileTuning(profile: BotProfile | null, role: string, team: ArenaSide): AgentTuning {
  const t: AgentTuning = { ...DEFAULT_AGENT_TUNING };
  if (!profile) return t;
  const layers: (KnobValues | undefined)[] = [profile.overrides, profile.sides?.[team], profile.roles?.[role as ArenaRole]];
  for (const layer of layers) {
    if (!layer) continue;
    for (const [k, v] of Object.entries(layer)) {
      // 防禦：只套白名單（profile 應該已經過 validateProfile）。
      if (!knobFor(k) || v === undefined) continue;
      (t as unknown as Record<string, unknown>)[k] = v;
    }
  }
  return t;
}

/** 這份 profile 的開關跟預設不同的地方（排行榜、報表用）。 */
export function profileKnobSummary(profile: BotProfile): string[] {
  const out: string[] = [];
  const fmt = (scope: string, vals?: KnobValues): void => {
    for (const [k, v] of Object.entries(vals ?? {})) out.push(`${scope}${k}=${v}`);
  };
  fmt('', profile.overrides);
  for (const s of ['good', 'evil'] as const) fmt(`${s}.`, profile.sides?.[s]);
  for (const r of ARENA_ROLES) fmt(`${r}.`, profile.roles?.[r]);
  return out;
}

export { ARENA_KNOBS };
