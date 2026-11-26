/**
 * 依玩家風格建立的 AI騎士（站長 2026-11-26）。
 *
 * 站長原話：「以後整個系統裡面的百科AI 都改名成 AI騎士_{風格}_{##} / 如果風格沒指定 就是「百科」 就是目前訓練出來的 /
 * 我希望你先針對目前的強者 或是至少總場數超過250場的玩家分別建立他們各自風格的AI騎士」；
 * 之後改成：「還是直接用玩家id吧 repo本身公開也沒關係 因為玩家也是匿名」→ 名字是 `AI騎士_{玩家ID}_{##}`，
 * 擬合出來的風格標籤（穩健／激進／鐵壁…）放在 profile 的 `tag`。
 *
 * 一隻 AI騎士 = 百科AI 的引擎 ＋ 擂台白名單裡的開關（`knobs.ts`），開關值用那位玩家自己的決策擬合
 * （`scripts/styleKnights.ts`：真人局重播，同第 1 關／人類 PR 量尺的 `agreement` 重播）。
 * 這個模組是純函式：擬合用的「決策族」、混合比例與格點的收縮估計、風格標籤、白話說明、名字與資料夾 id。
 */
import { DEFAULT_AGENT_TUNING, type AgentTuning } from '../ai/AgentTuning';
import { ARENA_ROLES, HOUSE_AUTHOR, NAME_MAX, type ArenaRole, type BotProfile, type KnobValues } from './profile';

export { HOUSE_AUTHOR };
export const KNIGHT_PREFIX = 'AI騎士_';

export type DecisionType = 'team' | 'vote' | 'quest' | 'assassinate';
export type KnobKey = keyof AgentTuning;

export const EVIL_ROLES: readonly ArenaRole[] = ['assassin', 'morgana', 'mordred', 'oberon'];
export const GOOD_ROLES: readonly ArenaRole[] = ['merlin', 'percival', 'loyal'];

/** 一個決策點（擬合只需要這些欄位）。 */
export interface SpotLite {
  type: DecisionType;
  role: string;
  round: number;
  /** 紅方已經拿到的失敗任務數（投票那一刻）。 */
  redFails: number;
  /** 投票：自己在提議的隊上。 */
  onTeam?: boolean;
}

/**
 * 一個候選的打法 = 一個開關取某個值。
 * - `pick`：那個值的決策直接來自某一次重播（布林、格點開關）。
 * - `mix`：機率開關（每次決策擲一次）：值 p 時 = p ×「開關 = 1 的那次重播」＋（1 − p）×「開關 = 0 的那次重播」，期望一致度是兩者的加權。
 */
export type Candidate =
  | { kind: 'pick'; key: KnobKey; value: number | boolean; probe: string }
  | { kind: 'mix'; key: KnobKey; probe0: string; probe1: string };

/** 一個決策族：一組互不重疊的決策點，只用一個開關（或幾條軸裡選一條）來擬合。 */
export interface Family {
  id: string;
  /** 白話名稱（報表用）。 */
  zh: string;
  roles: readonly ArenaRole[];
  type: DecisionType;
  /** 決策點是否屬於這一族（角色與決策種類已先過濾）。 */
  match: (s: SpotLite) => boolean;
  /** 幾條軸；每條軸是一個開關。擬合時在所有軸、所有值裡挑一個。 */
  axes: Array<{ key: KnobKey; values: ReadonlyArray<number | boolean>; candidate: (v: number | boolean) => Candidate }>;
}

/** 一次重播（probe）：開關值＋這次要算的決策點。`D` = 百科AI 本身。 */
export interface Probe {
  id: string;
  knobs: KnobValues;
  /** 這次重播要算哪些（決策種類 × 角色 × 條件）。 */
  wants: (s: SpotLite) => boolean;
}

const isEvil = (r: string): boolean => (EVIL_ROLES as readonly string[]).includes(r);
const notOberonEvil = (r: string): boolean => r === 'assassin' || r === 'morgana' || r === 'mordred';
const goodVoter = (r: string): boolean => r === 'loyal' || r === 'percival';
const isKey = (s: SpotLite): boolean => s.redFails >= 2;
/** 忠臣、派西第 3 局起的票（貝氏準則 `goodBayesVote` 的範圍；隊長自己的票也算進來，它不受影響但無妨）。 */
const blueVote = (s: SpotLite): boolean => s.type === 'vote' && goodVoter(s.role) && s.round >= 3;

/**
 * 藍方投票的門檻格點（`goodBayesVote` 的四個門檻）。舊的 `goodCleanVote`／`goodTailVote`／`goodKeyVote` 不擬合：
 * 現行預設裡第 3 局起忠臣、派西的票由貝氏準則決定，那三個門檻在真人局的決策點上幾乎不會改變任何一票（試跑 938 票 0 票不同）。
 */
export const BAYES_GOOD_GRID = [0.5, 0.6, 0.7, 0.8, 0.9] as const;
export const BAYES_BAD_GRID = [0.6, 0.7, 0.8, 0.9, 0.95] as const;
export const BAYES_GOOD_KEY_GRID = [0.7, 0.8, 0.9, 0.95] as const;
export const BAYES_BAD_KEY_GRID = [0.5, 0.6, 0.7, 0.8, 0.9] as const;
export const MIX_GRID = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1] as const;

const D = DEFAULT_AGENT_TUNING;
const probeOfGrid = (prefix: string, grid: readonly number[], def: number) => (v: number | boolean): string =>
  (v === def ? 'D' : `${prefix}${grid.indexOf(v as number)}`);

/**
 * 重播清單。互不重疊的開關（不同角色或不同決策種類）放在同一次重播裡，省計算。
 * 藍方投票的門檻開關會互相影響，所以每個格點值各一次，而且只算那一類的決策點。
 */
export function buildProbes(): Probe[] {
  const probes: Probe[] = [
    { id: 'D', knobs: {}, wants: () => true },
    {
      id: 'P1',
      knobs: {
        redHideHuman: false, redR1Teammate: false, redStackRate65: 0, redNormalVote: 0,
        merlinNormalVote: 0, merlinCover77: 1, percivalNoThumbsR1: false, assassinModel: false,
      },
      wants: (s) => (s.type === 'quest' && notOberonEvil(s.role))
        || (s.type === 'team' && (isEvil(s.role) || s.role === 'merlin' || s.role === 'percival'))
        || (s.type === 'vote' && (isEvil(s.role) || s.role === 'merlin'))
        || s.type === 'assassinate',
    },
    {
      id: 'P2',
      knobs: { oberonR1AlwaysFail64: 1, redStackRate65: 1, redCleanWhite: 1 },
      wants: (s) => (s.type === 'quest' && s.role === 'oberon') || ((s.type === 'team' || s.type === 'vote') && isEvil(s.role)),
    },
    { id: 'P3', knobs: { redCleanApprove: 1 }, wants: (s) => s.type === 'vote' && isEvil(s.role) },
  ];
  const grid = (prefix: string, key: KnobKey, values: readonly number[], wants: (s: SpotLite) => boolean): void => {
    values.forEach((v, i) => {
      if (v === D[key]) return;
      probes.push({ id: `${prefix}${i}`, knobs: { [key]: v }, wants });
    });
  };
  // 不在隊上 → 外白的門檻；在隊上 → 內黑的門檻；關鍵局（紅方兩勝）各一組。每組只算自己那一類的票。
  grid('G', 'goodBayesGood', BAYES_GOOD_GRID, (s) => blueVote(s) && !s.onTeam && !isKey(s));
  grid('B', 'goodBayesBad', BAYES_BAD_GRID, (s) => blueVote(s) && s.onTeam === true && !isKey(s));
  grid('GK', 'goodBayesGoodKey', BAYES_GOOD_KEY_GRID, (s) => blueVote(s) && !s.onTeam && isKey(s));
  grid('BK', 'goodBayesBadKey', BAYES_BAD_KEY_GRID, (s) => blueVote(s) && s.onTeam === true && isKey(s));
  return probes;
}

const bools = [true, false] as const;
const pickBool = (key: KnobKey, probeFalse: string) => (v: number | boolean): Candidate =>
  ({ kind: 'pick', key, value: v, probe: v === D[key] ? 'D' : probeFalse });
const mix = (key: KnobKey, probe0: string, probe1: string) => (): Candidate => ({ kind: 'mix', key, probe0, probe1 });

function gridFamily(id: string, zh: string, match: (s: SpotLite) => boolean, key: KnobKey, grid: readonly number[], prefix: string): Family {
  return {
    id, zh, roles: ['loyal', 'percival'], type: 'vote', match,
    axes: [{ key, values: grid, candidate: (v) => ({ kind: 'pick', key, value: v, probe: probeOfGrid(prefix, grid, D[key] as number)(v) }) }],
  };
}

/** 決策族（每一族的決策點互不重疊）。 */
export function buildFamilies(): Family[] {
  return [
    {
      id: 'redQuest', zh: '紅方第 1、2 局藏牌', roles: ['assassin', 'morgana', 'mordred'], type: 'quest', match: () => true,
      axes: [{ key: 'redHideHuman', values: bools, candidate: pickBool('redHideHuman', 'P1') }],
    },
    {
      id: 'oberonQuest', zh: '奧伯倫開局出失敗', roles: ['oberon'], type: 'quest', match: () => true,
      axes: [{ key: 'oberonR1AlwaysFail64', values: MIX_GRID, candidate: mix('oberonR1AlwaysFail64', 'D', 'P2') }],
    },
    {
      id: 'redTeamR1', zh: '紅方第 1 局帶隊友', roles: EVIL_ROLES, type: 'team', match: (s) => s.round === 1,
      axes: [{ key: 'redR1Teammate', values: bools, candidate: pickBool('redR1Teammate', 'P1') }],
    },
    {
      id: 'redTeamStack', zh: '紅方疊隊友', roles: EVIL_ROLES, type: 'team', match: (s) => s.round !== 1,
      axes: [{ key: 'redStackRate65', values: MIX_GRID, candidate: mix('redStackRate65', 'P1', 'P2') }],
    },
    {
      id: 'redVote', zh: '紅方投票', roles: EVIL_ROLES, type: 'vote', match: () => true,
      axes: [
        { key: 'redNormalVote', values: MIX_GRID, candidate: mix('redNormalVote', 'P1', 'D') },
        { key: 'redCleanWhite', values: MIX_GRID, candidate: mix('redCleanWhite', 'D', 'P2') },
        { key: 'redCleanApprove', values: MIX_GRID, candidate: mix('redCleanApprove', 'D', 'P3') },
      ],
    },
    gridFamily('blueOff', '忠臣／派西不在隊上的票', (s) => s.round >= 3 && !s.onTeam && !isKey(s), 'goodBayesGood', BAYES_GOOD_GRID, 'G'),
    gridFamily('blueOn', '忠臣／派西在隊上的票（內黑）', (s) => s.round >= 3 && s.onTeam === true && !isKey(s), 'goodBayesBad', BAYES_BAD_GRID, 'B'),
    gridFamily('blueOffKey', '忠臣／派西關鍵局不在隊上的票', (s) => s.round >= 3 && !s.onTeam && isKey(s), 'goodBayesGoodKey', BAYES_GOOD_KEY_GRID, 'GK'),
    gridFamily('blueOnKey', '忠臣／派西關鍵局在隊上的票', (s) => s.round >= 3 && s.onTeam === true && isKey(s), 'goodBayesBadKey', BAYES_BAD_KEY_GRID, 'BK'),
    {
      id: 'merlinVote', zh: '梅林投票', roles: ['merlin'], type: 'vote', match: () => true,
      axes: [{ key: 'merlinNormalVote', values: MIX_GRID, candidate: mix('merlinNormalVote', 'P1', 'D') }],
    },
    {
      id: 'merlinTeam', zh: '梅林派隊', roles: ['merlin'], type: 'team', match: () => true,
      axes: [{ key: 'merlinCover77', values: MIX_GRID, candidate: mix('merlinCover77', 'D', 'P1') }],
    },
    {
      id: 'percivalTeam', zh: '派西第 1 局派隊', roles: ['percival'], type: 'team', match: (s) => s.round === 1,
      axes: [{ key: 'percivalNoThumbsR1', values: bools, candidate: pickBool('percivalNoThumbsR1', 'P1') }],
    },
    {
      id: 'assassin', zh: '刺殺', roles: ['assassin'], type: 'assassinate', match: () => true,
      axes: [{ key: 'assassinModel', values: bools, candidate: pickBool('assassinModel', 'P1') }],
    },
  ];
}

export function familyOf(families: readonly Family[], s: SpotLite): Family | undefined {
  return families.find((f) => f.type === s.type && (f.roles as readonly string[]).includes(s.role) && f.match(s));
}

/** 一個決策點：玩家的選擇＋各次重播的機器人選擇。 */
export interface ScoredSpot extends SpotLite {
  human: string;
  agent: Readonly<Record<string, string>>;
}

/** 候選在一個決策點的期望一致度（0..1）；缺那次重播的決策 → null。 */
export function expectedMatch(spot: ScoredSpot, c: Candidate, value: number | boolean): number | null {
  if (c.kind === 'pick') {
    const a = spot.agent[c.probe];
    return a === undefined ? null : a === spot.human ? 1 : 0;
  }
  const a0 = spot.agent[c.probe0];
  const a1 = spot.agent[c.probe1];
  if (a0 === undefined || a1 === undefined) return null;
  const p = value as number;
  return p * (a1 === spot.human ? 1 : 0) + (1 - p) * (a0 === spot.human ? 1 : 0);
}

export interface CandidateScore {
  key: KnobKey;
  value: number | boolean;
  /** 期望一致的決策數。 */
  sum: number;
  n: number;
}

/** 一族、一組決策點：每個候選（軸 × 值）的期望一致數。 */
export function scoreFamily(f: Family, spots: readonly ScoredSpot[]): CandidateScore[] {
  const out: CandidateScore[] = [];
  for (const axis of f.axes) {
    for (const v of axis.values) {
      const c = axis.candidate(v);
      let sum = 0;
      let n = 0;
      for (const s of spots) {
        const m = expectedMatch(s, c, v);
        if (m === null) continue;
        sum += m;
        n += 1;
      }
      out.push({ key: axis.key, value: v, sum, n });
    }
  }
  return out;
}

const sameValue = (a: number | boolean, b: number | boolean): boolean =>
  typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-9 : a === b;

/**
 * 收縮挑選：每個候選的分數 = (玩家的期望一致數 + κ × 全體的一致率) / (n + κ)，挑最高的。
 * 資料少的時候全體的偏好佔比較重（「資料少就往全體縮」）；同分時偏向百科AI 的預設值。
 * 玩家在這一族沒有決策點 → 回 null（不改）。
 */
export function chooseShrunk(
  player: readonly CandidateScore[],
  population: readonly CandidateScore[],
  kappa: number,
): { key: KnobKey; value: number | boolean } | null {
  if (player.length === 0 || player.every((c) => c.n === 0)) return null;
  let best: { key: KnobKey; value: number | boolean; score: number; isDefault: boolean } | null = null;
  for (const c of player) {
    const pop = population.find((p) => p.key === c.key && sameValue(p.value, c.value));
    const popRate = pop && pop.n > 0 ? pop.sum / pop.n : 0;
    const score = (c.sum + kappa * popRate) / (c.n + kappa);
    const isDefault = sameValue(c.value, DEFAULT_AGENT_TUNING[c.key] as number | boolean);
    if (!best || score > best.score + 1e-9 || (Math.abs(score - best.score) <= 1e-9 && isDefault && !best.isDefault)) {
      best = { key: c.key, value: c.value, score, isDefault };
    }
  }
  return best ? { key: best.key, value: best.value } : null;
}

/** 一族、一組決策點、一個選擇：期望一致數（選擇 = 百科AI 的預設值就是基準）。 */
export function familyAgreement(f: Family, spots: readonly ScoredSpot[], choice: { key: KnobKey; value: number | boolean } | null): { sum: number; n: number } {
  const axis = choice ? f.axes.find((a) => a.key === choice.key) ?? f.axes[0] : f.axes[0];
  const value = choice ? choice.value : (DEFAULT_AGENT_TUNING[axis.key] as number | boolean);
  const c = axis.candidate(value);
  let sum = 0;
  let n = 0;
  for (const s of spots) {
    const m = expectedMatch(s, c, value);
    if (m === null) continue;
    sum += m;
    n += 1;
  }
  return { sum, n };
}

// ── 擬合結果 → profile ──────────────────────────────────────

/** 每一族的選擇（只放和預設不同的）。 */
export type FittedChoices = Partial<Record<string, { key: KnobKey; value: number | boolean }>>;

/** 選擇 → profile 的開關：一族涵蓋整個陣營就放 sides，否則放 roles（只套在擬合用到的角色上）。 */
export function choicesToLayers(families: readonly Family[], choices: FittedChoices): Pick<BotProfile, 'sides' | 'roles'> {
  const sides: NonNullable<BotProfile['sides']> = {};
  const roles: NonNullable<BotProfile['roles']> = {};
  for (const f of families) {
    const c = choices[f.id];
    if (!c || sameValue(c.value, DEFAULT_AGENT_TUNING[c.key] as number | boolean)) continue;
    const allEvil = EVIL_ROLES.every((r) => f.roles.includes(r)) && f.roles.length === EVIL_ROLES.length;
    if (allEvil) {
      (sides.evil ??= {})[c.key] = c.value;
    } else {
      for (const r of f.roles) (roles[r] ??= {})[c.key] = c.value;
    }
  }
  const out: Pick<BotProfile, 'sides' | 'roles'> = {};
  if (Object.keys(sides).length) out.sides = sides;
  const orderedRoles: NonNullable<BotProfile['roles']> = {};
  for (const r of ARENA_ROLES) if (roles[r]) orderedRoles[r] = roles[r];
  if (Object.keys(orderedRoles).length) out.roles = orderedRoles;
  return out;
}

/** profile 裡某個角色實際用的開關值（只看白名單、用來算標籤與說明）。 */
function knobAt(layers: Pick<BotProfile, 'sides' | 'roles'>, role: ArenaRole, key: KnobKey): number | boolean {
  const side = (EVIL_ROLES as readonly string[]).includes(role) ? 'evil' : 'good';
  const v = layers.roles?.[role]?.[key] ?? layers.sides?.[side]?.[key];
  return (v ?? DEFAULT_AGENT_TUNING[key]) as number | boolean;
}

// ── 風格標籤（固定詞表）──────────────────────────────────────

/**
 * 風格標籤的詞表（固定；測試檢查）。每個詞是一個方向：
 * 紅方 激進／潛伏、藍方投票 鐵壁／寬容、梅林 明燈／藏鋒；哪個方向都不明顯 = 穩健。
 * 最明顯的一個方向當標籤；第二明顯的也夠強（≥ 第一的 0.6 倍）就接在後面（四個字，例如「激進鐵壁」）。
 */
export const STYLE_WORDS = {
  steady: '穩健',
  redBold: '激進',
  redSly: '潛伏',
  blueStrict: '鐵壁',
  blueLoose: '寬容',
  merlinOpen: '明燈',
  merlinHidden: '藏鋒',
} as const;
export type StyleWord = typeof STYLE_WORDS[keyof typeof STYLE_WORDS];
export const STYLE_VOCAB: readonly StyleWord[] = Object.values(STYLE_WORDS);

/** 一個方向至少要偏離這麼多才算（0..1，偏離預設的幅度）。 */
export const STYLE_MIN = 0.25;

/** 三條方向軸的分數（正 = 第一個詞、負 = 第二個詞）。 */
export function styleAxes(layers: Pick<BotProfile, 'sides' | 'roles'>): { red: number; blue: number; merlin: number } {
  const red = (role: ArenaRole): number => {
    const parts: number[] = [];
    parts.push(1 - (knobAt(layers, role, 'redNormalVote') as number)); // 越低越照紅方利益投
    parts.push(((knobAt(layers, role, 'redStackRate65') as number) - 0.5) * 2); // 疊隊友
    parts.push(knobAt(layers, role, 'redHideHuman') === false ? 1 : 0); // 不藏牌
    parts.push(-(knobAt(layers, role, 'redCleanWhite') as number)); // 偽裝時放行乾淨隊
    parts.push(-(knobAt(layers, role, 'redCleanApprove') as number));
    return parts.reduce((x, y) => x + y, 0);
  };
  // 四個紅方角色裡偏離最大的那一個（大多數開關放在整個紅方，所以通常都一樣）。
  const redScore = EVIL_ROLES.map(red).reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a), 0);
  // 鐵壁 = 不在隊上更不放行（外白門檻高）、在隊上更常內黑（內黑門檻低）。
  const blueRole = (role: ArenaRole): number =>
    ((knobAt(layers, role, 'goodBayesGood') as number) - D.goodBayesGood) / 0.2
    + (D.goodBayesBad - (knobAt(layers, role, 'goodBayesBad') as number)) / 0.15
    + ((knobAt(layers, role, 'goodBayesGoodKey') as number) - D.goodBayesGoodKey) / 0.1
    + (D.goodBayesBadKey - (knobAt(layers, role, 'goodBayesBadKey') as number)) / 0.2;
  const blue = (blueRole('loyal') + blueRole('percival')) / 2;
  const merlin = (1 - (knobAt(layers, 'merlin', 'merlinNormalVote') as number)) - (knobAt(layers, 'merlin', 'merlinCover77') as number);
  return { red: redScore, blue, merlin };
}

/** 風格標籤（2 或 4 個字，詞表裡的詞）。 */
export function styleTag(layers: Pick<BotProfile, 'sides' | 'roles'>): string {
  const ax = styleAxes(layers);
  const dims: Array<{ score: number; word: StyleWord }> = [
    { score: Math.abs(ax.red), word: ax.red >= 0 ? STYLE_WORDS.redBold : STYLE_WORDS.redSly },
    { score: Math.abs(ax.blue), word: ax.blue >= 0 ? STYLE_WORDS.blueStrict : STYLE_WORDS.blueLoose },
    { score: Math.abs(ax.merlin), word: ax.merlin >= 0 ? STYLE_WORDS.merlinOpen : STYLE_WORDS.merlinHidden },
  ].filter((d) => d.score >= STYLE_MIN).sort((a, b) => b.score - a.score);
  if (dims.length === 0) return STYLE_WORDS.steady;
  if (dims.length >= 2 && dims[1].score >= 0.6 * dims[0].score) return `${dims[0].word}${dims[1].word}`;
  return dims[0].word;
}

// ── 白話說明 ────────────────────────────────────────────────

const pct = (x: number): string => `${Math.round(x * 100)}%`;

/** 開關值 → 一句白話（只寫和百科AI 不同的地方）。 */
export function describeKnob(key: KnobKey, value: number | boolean, who: string): string | null {
  const v = value;
  switch (key) {
    case 'redHideHuman': return v === false ? `${who}第 1、2 局能出失敗就出，不藏牌` : null;
    case 'oberonR1AlwaysFail64': return (v as number) > 0 ? `奧伯倫第 1 局上任務約 ${pct(v as number)} 直接出失敗` : null;
    case 'redR1Teammate': return v === false ? `${who}第 1 局當隊長不帶隊友` : null;
    case 'redStackRate65': return (v as number) > 0.5 ? `${who}第 3、5 局當隊長常多帶一位隊友（約 ${pct(v as number)}）` : `${who}第 3、5 局當隊長很少多帶隊友（約 ${pct(v as number)}）`;
    case 'redNormalVote': return `${who}第 3 局起只有約 ${pct(v as number)} 的票裝成好人，其餘照紅方利益投`;
    case 'redCleanWhite': return `${who}裝好人時，約 ${pct(v as number)} 會放行看起來乾淨的隊`;
    case 'redCleanApprove': return `${who}第 3 局起不在隊上，約 ${pct(v as number)} 會贊成沒有隊友的隊`;
    case 'goodCleanVote': return (v as number) > D.goodCleanVote ? `${who}第 3 局起比較嚴格，有點懷疑就投反對` : `${who}第 3 局起比較寬鬆，願意放行`;
    case 'goodTailVote': return (v as number) > D.goodTailVote ? `${who}不在隊上時更常投反對` : `${who}不在隊上時更常放行`;
    case 'goodKeyVote': return (v as number) > D.goodKeyVote ? `${who}在紅方再贏一局就輸的關鍵局更不敢放行` : `${who}在關鍵局比較願意賭`;
    case 'goodBayesGood': return (v as number) > D.goodBayesGood ? `${who}第 3 局起不在隊上更常投反對` : `${who}第 3 局起不在隊上更常放行`;
    case 'goodBayesBad': return (v as number) < D.goodBayesBad ? `${who}第 3 局起在隊上更常內黑` : `${who}第 3 局起在隊上很少內黑`;
    case 'goodBayesGoodKey': return (v as number) > D.goodBayesGoodKey ? `${who}在紅方再贏一局就輸的關鍵局更不敢放行` : `${who}在關鍵局比較願意放行`;
    case 'goodBayesBadKey': return (v as number) < D.goodBayesBadKey ? `${who}在關鍵局在隊上更常內黑` : `${who}在關鍵局在隊上很少內黑`;
    case 'merlinNormalVote': return `梅林第 3 局起約 ${pct(1 - (v as number))} 的票照自己看到的紅投（比較明顯）`;
    case 'merlinCover77': return `梅林第 1、2 局約 ${pct(v as number)} 的提議照忠臣的派法（藏得比較深）`;
    case 'percivalNoThumbsR1': return v === false ? '派西第 1 局當隊長會放一根拇指' : null;
    case 'assassinModel': return v === false ? '刺殺改用經驗規則，不用模型' : null;
    default: return null;
  }
}

const ROLE_ZH: Readonly<Record<ArenaRole, string>> = {
  merlin: '梅林', percival: '派西', loyal: '忠臣', assassin: '刺客', morgana: '莫甘娜', mordred: '莫德雷德', oberon: '奧伯倫',
};

function whoOf(roles: readonly string[], side: 'good' | 'evil' | null): string {
  if (side === 'evil') return '紅方';
  if (roles.length === 2 && roles.includes('loyal') && roles.includes('percival')) return '忠臣和派西';
  return roles.map((r) => ROLE_ZH[r as ArenaRole] ?? r).join('、');
}

/** profile 的白話說明（≤ 300 字；擂台 `style` 欄）。 */
export function describeStyle(layers: Pick<BotProfile, 'sides' | 'roles'>, tag: string): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(layers.sides?.evil ?? {})) {
    const s = describeKnob(k as KnobKey, v as number | boolean, '紅方');
    if (s) lines.push(s);
  }
  // 同一個開關、同一個值放在好幾個角色上：合併成一句。
  const byKnob = new Map<string, { key: KnobKey; value: number | boolean; roles: string[] }>();
  for (const r of ARENA_ROLES) {
    for (const [k, v] of Object.entries(layers.roles?.[r] ?? {})) {
      const id = `${k}=${String(v)}`;
      const e = byKnob.get(id) ?? { key: k as KnobKey, value: v as number | boolean, roles: [] };
      e.roles.push(r);
      byKnob.set(id, e);
    }
  }
  for (const e of byKnob.values()) {
    const allRedButOberon = ['assassin', 'morgana', 'mordred'].every((r) => e.roles.includes(r)) && e.roles.length === 3;
    const s = describeKnob(e.key, e.value, allRedButOberon ? '紅方（奧伯倫除外）' : whoOf(e.roles, null));
    if (s) lines.push(s);
  }
  const head = `依一位玩家自己的真人牌局擬合的打法（風格：${tag}）。`;
  const body = lines.length ? `${lines.join('；')}。其他照百科AI。` : '和百科AI 幾乎一樣。';
  let text = head + body;
  if ([...text].length > 300) text = `${[...text].slice(0, 299).join('')}…`;
  return text;
}

// ── 名字與資料夾 ─────────────────────────────────────────────

/** 擂台名字：`AI騎士_{玩家ID}_{##}`（## 從 01 起，每位玩家各自編號）。 */
export function knightName(playerId: string, serial: number): string {
  return `${KNIGHT_PREFIX}${playerId}_${String(serial).padStart(2, '0')}`;
}

/** 名字放得進擂台的長度上限嗎。 */
export function knightNameFits(playerId: string, serial = 1): boolean {
  return [...knightName(playerId, serial)].length <= NAME_MAX;
}

function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * 資料夾 id（擂台規則：小寫英文、數字、減號，2–32 個字）。
 * 英數字的玩家 ID → `knight-<id 小寫、其他字元換成減號>-01`；有中文等字元 → `knight-<ID 的雜湊 8 碼>-01`（顯示名稱照原樣）。
 */
export function knightFolderId(playerId: string, serial: number): string {
  const nn = String(serial).padStart(2, '0');
  const slug = playerId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const asciiOnly = /^[\x20-\x7e]+$/.test(playerId) && slug.length >= 1;
  const core = asciiOnly ? slug.slice(0, 32 - 'knight-'.length - 3).replace(/-+$/g, '') : fnv1a(playerId).toString(16).padStart(8, '0');
  return `knight-${core}-${nn}`;
}

/** 一份 AI騎士 的 profile（擂台格式，作者固定 AI騎士團）。 */
export function buildKnightProfile(playerId: string, serial: number, layers: Pick<BotProfile, 'sides' | 'roles'>): BotProfile {
  const tag = styleTag(layers);
  const p: BotProfile = {
    schema: 1,
    name: knightName(playerId, serial),
    author: HOUSE_AUTHOR,
    style: describeStyle(layers, tag),
    tag,
  };
  if (layers.sides) p.sides = layers.sides;
  if (layers.roles) p.roles = layers.roles;
  return p;
}

/** 兩份 profile 的開關值（展開成 role → key → value）一樣嗎（測試、重產時比對用）。 */
export function effectiveKnobs(layers: Pick<BotProfile, 'sides' | 'roles'>): Record<string, Record<string, number | boolean>> {
  const out: Record<string, Record<string, number | boolean>> = {};
  for (const r of ARENA_ROLES) {
    const side = (EVIL_ROLES as readonly string[]).includes(r) ? 'evil' : 'good';
    const merged: KnobValues = { ...(layers.sides?.[side] ?? {}), ...(layers.roles?.[r] ?? {}) };
    if (Object.keys(merged).length) out[r] = merged as Record<string, number | boolean>;
  }
  return out;
}
