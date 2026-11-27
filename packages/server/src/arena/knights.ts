/**
 * AI騎士 名冊（執行期）：練習台、一般房間「指定哪一位 AI騎士」用（站長 2026-11-26：「所以如果練習台想呼叫AI騎士_ED 有辦法嗎」）。
 *
 * 來源：伺服器內建的 `knights.generated.json`（`scripts/knightsGenerate.ts` 從 `community-bots/_knights/` 產生），
 * 外加預設的 AI騎士_百科（= 百科AI 本身，沒有任何開關）。執行期不讀 repo 最上層的資料夾——正式機（Render）只部署
 * `packages/server`、`packages/shared` 的改動，一位騎士的改動要重跑產生器、跟著伺服器一起提交。
 *
 * 一位騎士在對局裡 = 百科AI 的引擎 ＋ 那份 profile 的開關（overrides → sides[陣營] → roles[角色]，同擂台 `resolveProfileTuning`）
 * ＋ 那位玩家的殘差層（schema 2 的 `residual`，`knightAgent.ts`；站長 2026-11-27 起正式對局也套，同擂台）。
 * 正式對局的基準線照舊（預設＋環境變數＋這一桌的真人桌策略層），騎士的開關蓋在最上面，殘差層在引擎決定之後重新打分。
 */
import type { AgentTuning } from '../ai/AgentTuning';
import type { HeuristicAgent } from '../ai/HeuristicAgent';
import { buildKnightAgent, liveResidualEnabled } from './knightAgent';
import GENERATED from './knights.generated.json';
import { knobFor } from './knobs';
import { validateProfile, type ArenaRole, type ArenaSide, type BotProfile, type KnobValues } from './profile';

export const DEFAULT_KNIGHT_ID = 'baike';
export const DEFAULT_KNIGHT_NAME = 'AI騎士_百科';
/** 練習台「隨機混搭」：每個機器人座位各抽一位（含百科）。 */
export const KNIGHT_MIX_ID = 'random-mix';

export interface Knight {
  id: string;
  /** 不含座位序號的名字（`AI騎士_ED`、`AI騎士_百科`）；房間裡的座位名 = 這個 ＋ `_01`、`_02`…。 */
  baseName: string;
  /** 風格標籤（`藏鋒`、`鐵壁`…）；百科沒有。 */
  tag?: string;
  /** 白話的打法說明。 */
  style: string;
  /** null = 百科AI 本身。 */
  profile: BotProfile | null;
}

export interface KnightSummary {
  id: string;
  name: string;
  tag?: string;
  style: string;
}

const SERIAL_SUFFIX_RE = /_\d{1,3}$/;

/** `AI騎士_ED_01` → `AI騎士_ED`（profile 名字自己帶的序號拿掉，房間裡另外編號）。 */
export function knightBaseName(name: string): string {
  return name.trim().replace(SERIAL_SUFFIX_RE, '');
}

const BAIKE: Knight = {
  id: DEFAULT_KNIGHT_ID,
  baseName: DEFAULT_KNIGHT_NAME,
  style: '目前訓練出來的百科AI 本身，沒有另外調任何開關。',
  profile: null,
};

/** 從產生的 JSON 建名冊；每一份再過一次 `validateProfile`（官方規則），沒過的不收。 */
export function buildKnightRegistry(raw: unknown): { knights: Knight[]; rejected: string[] } {
  const knights: Knight[] = [BAIKE];
  const rejected: string[] = [];
  const list = (raw as { knights?: unknown })?.knights;
  if (!Array.isArray(list)) return { knights, rejected };
  const seen = new Set<string>([DEFAULT_KNIGHT_ID, KNIGHT_MIX_ID]);
  const seenBase = new Set<string>([BAIKE.baseName.toLowerCase()]);
  for (const item of list) {
    const id = String((item as { id?: unknown })?.id ?? '');
    const v = validateProfile((item as { profile?: unknown })?.profile, id, { house: true });
    if (!v.ok || !v.profile || seen.has(id)) { rejected.push(id || '(no id)'); continue; }
    const baseName = knightBaseName(v.profile.name);
    if (seenBase.has(baseName.toLowerCase())) { rejected.push(id); continue; }
    seen.add(id);
    seenBase.add(baseName.toLowerCase());
    const k: Knight = { id, baseName, style: v.profile.style, profile: v.profile };
    if (v.profile.tag) k.tag = v.profile.tag;
    knights.push(k);
  }
  return { knights, rejected };
}

let REGISTRY: Knight[] | null = null;

function registry(): Knight[] {
  if (REGISTRY === null) {
    const built = buildKnightRegistry(GENERATED);
    if (built.rejected.length > 0) console.warn(`[knights] ${built.rejected.length} knight profile(s) rejected: ${built.rejected.join(', ')}`);
    REGISTRY = built.knights;
  }
  return REGISTRY;
}

/** 名冊（百科在第一個，其他照資料夾順序）。 */
export function listKnights(): readonly Knight[] {
  return registry();
}

/** 給網站的清單（名字是不帶序號的 `AI騎士_ED`）。 */
export function listKnightSummaries(): KnightSummary[] {
  return registry().map((k) => {
    const s: KnightSummary = { id: k.id, name: k.baseName, style: k.style };
    if (k.tag) s.tag = k.tag;
    return s;
  });
}

export function getKnight(id: string | null | undefined): Knight | undefined {
  if (typeof id !== 'string') return undefined;
  return registry().find((k) => k.id === id);
}

/** 不認得的騎士 id 退回百科的次數（只記次數；不記傳進來的字）。 */
export const knightFallbackCounter = { unknown: 0 };

/**
 * 用戶端傳來的騎士 id → 名冊裡的 id。沒傳（undefined／null／空字串）→ `null`（呼叫端照舊）；
 * 名冊裡有 → 那個 id；其他（不認得、型別不對）→ 百科，並記一次（log 只印次數）。
 * `allowMix`：練習台的「隨機混搭」也算認得。
 */
/**
 * 依使用者輸入（id、`AI騎士_ED_01`、`AI騎士_ED`、`ED`、`百科`）找名冊裡的騎士 id；不分大小寫、先做 NFKC。
 * 找不到回 null（不計入未知 fallback 計數器，供補位指令驗證用）。
 */
export function resolveKnightRef(raw: string | null | undefined): string | null {
  const q = (raw ?? '').normalize('NFKC').trim().toLowerCase();
  if (!q) return null;
  if (q === DEFAULT_KNIGHT_ID || q === '百科' || q === 'ai騎士_百科' || q === 'ai騎士_百科_00' || q === 'ai騎士_百科_01') {
    return DEFAULT_KNIGHT_ID;
  }
  const stripped = q.replace(/^ai騎士_/, '').replace(/_\d{1,2}$/, '');
  for (const k of listKnights()) {
    const idLow = k.id.normalize('NFKC').toLowerCase();
    const nameLow = (k.profile?.name ?? k.baseName).normalize('NFKC').toLowerCase();
    const baseLow = k.baseName.normalize('NFKC').toLowerCase();
    const shortLow = baseLow.replace(/^ai騎士_/, '');
    if (q === idLow || q === nameLow || q === baseLow || q === shortLow || (stripped && stripped === shortLow)) {
      return k.id;
    }
  }
  return null;
}

export function resolveKnightId(raw: unknown, opts: { allowMix?: boolean } = {}): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw === 'string') {
    if (opts.allowMix && raw === KNIGHT_MIX_ID) return KNIGHT_MIX_ID;
    if (getKnight(raw)) return raw;
  }
  knightFallbackCounter.unknown++;
  console.warn(`[knights] unknown knight id → ${DEFAULT_KNIGHT_ID} (total ${knightFallbackCounter.unknown})`);
  return DEFAULT_KNIGHT_ID;
}

/**
 * 這位騎士在這個角色、陣營要蓋上去的開關（只有 profile 的那幾層，不含預設值）。
 * 百科或不認得的 id → 空物件。
 */
export function knightTuningOverrides(id: string | null | undefined, role: string | null | undefined, team: ArenaSide | null | undefined): Partial<AgentTuning> {
  const profile = getKnight(id)?.profile;
  if (!profile) return {};
  const out: Record<string, number | boolean> = {};
  const layers: (KnobValues | undefined)[] = [
    profile.overrides,
    team ? profile.sides?.[team] : undefined,
    role ? profile.roles?.[role as ArenaRole] : undefined,
  ];
  for (const layer of layers) {
    if (!layer) continue;
    for (const [k, v] of Object.entries(layer)) {
      if (!knobFor(k) || v === undefined) continue;
      out[k] = v;
    }
  }
  return out as Partial<AgentTuning>;
}

/** 這位騎士的殘差層（沒有、百科、不認得 → undefined）。 */
export function knightResidual(id: string | null | undefined): BotProfile['residual'] {
  return getKnight(id)?.profile?.residual;
}

/**
 * 正式對局（練習台、房間、補位機器人）裡一位騎士的機器人：`base`（基準線＋這一桌的策略層）→ 騎士的開關 → 殘差層。
 * 百科或不認得的 id → 照 `base` 的一般機器人。`residual: false`（或環境變數 `KNIGHT_RESIDUAL_LIVE=off`）只套開關。
 */
export function createKnightAgent(
  agentId: string,
  knightId: string | null | undefined,
  role: string | null | undefined,
  team: ArenaSide | null | undefined,
  base?: Partial<AgentTuning>,
  opts: { residual?: boolean } = {},
): HeuristicAgent {
  const knight = getKnight(knightId);
  const tuning = knight?.profile ? { ...base, ...knightTuningOverrides(knight.id, role, team) } : base;
  const useResidual = opts.residual ?? liveResidualEnabled();
  return buildKnightAgent(agentId, tuning, useResidual ? knight?.profile?.residual : undefined, knight?.profile?.residualOff);
}

/** 房間裡這位騎士下一個沒人用的座位名：`AI騎士_ED_01`，同房第二位 `AI騎士_ED_02`…。 */
export function nextKnightSeatName(baseName: string, takenNames: Iterable<string>): string {
  const taken = new Set([...takenNames].map((n) => n.toLowerCase()));
  for (let n = 1; ; n++) {
    const name = `${baseName}_${n < 10 ? `0${n}` : String(n)}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

/** 練習台座位上沒指定騎士時用誰補：百科，或每個空位各抽一位。 */
export type KnightFill = 'baike' | 'random';

/**
 * 練習台「一隻一隻召喚」（站長 2026-11-26：「如果要跟某幾個特定風格的AI騎士打練習局 可以在玩之前讓玩家自己設定好嗎 就像是一隻一隻召喚這樣」）：
 * `lineup[k]` = 第 k 個機器人座位（照座位順序、跳過玩家）指定的騎士 id，`null` = 沒指定。
 * 指定的照用（同一位可以出現好幾次）；沒指定的用 `fill` 補：百科，或從名冊各抽一位（空位之間不重複，名冊不夠再重來）。
 */
export function knightsForLineup(lineup: readonly (string | null)[], count: number, fill: KnightFill, rand: () => number = Math.random): string[] {
  const empty = Array.from({ length: count }, (_, i) => (lineup[i] && getKnight(lineup[i]) ? null : i)).filter((i): i is number => i !== null);
  const drawn = fill === 'random' ? knightsForSeats(KNIGHT_MIX_ID, empty.length, rand) : [];
  let d = 0;
  return Array.from({ length: count }, (_, i) => {
    const id = lineup[i];
    if (id && getKnight(id)) return id;
    return fill === 'random' ? drawn[d++] : DEFAULT_KNIGHT_ID;
  });
}

/**
 * 練習台：9 個機器人座位各用哪一位。指定一位 → 全部那一位；`random-mix` → 每個座位各抽一位
 * （先把名冊洗一輪不重複，名冊不夠再重來）。`rand` 給測試用。
 */
export function knightsForSeats(choice: string, count: number, rand: () => number = Math.random): string[] {
  if (choice !== KNIGHT_MIX_ID) {
    const id = getKnight(choice) ? choice : DEFAULT_KNIGHT_ID;
    return Array.from({ length: count }, () => id);
  }
  const ids = registry().map((k) => k.id);
  const out: string[] = [];
  let pool: string[] = [];
  while (out.length < count) {
    if (pool.length === 0) {
      pool = [...ids];
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
    }
    out.push(pool.pop()!);
  }
  return out;
}
