/**
 * 和強者的落差：分局面的結果分布（站長 2026-11-18：「根據尾派陣營以及局勢去區分遊戲結果 來評估與強者的落差」）。
 *
 * 機器人自我對打與真人局在同一組固定的局面格上比結果分布。真人局 = 網站數據分析的那一批局（games_cache.json，
 * `decodeGamesDataset`，百科AI 局不算），每局的牌譜細節從 game_db.json 對應的紀錄拿（來源 id 對 games_cache 的 id），
 * S 用 games_cache 的陣容強度；「高端桌」= S ≥ 分組的 S 上切點（預設 55，同網站；第 1G 節起，取代只讀 game_db 的舊參考）。
 * （三紅／三藍死／三藍活，加上任務三藍）。每一格報 n、機器人率、真人率（Wilson 95%）與差；每一族格
 * （例：5家×0家）算一個以真人頻率加權的 total variation 距離 D；列出加權落差最大的格。
 *
 * 座位一律以第 1 局第 1 個隊長為 1 家，依序到 0 家（1 家前一位）；兩邊的紀錄都照這個慣例（`selfplay/sp.ts`
 * detail=1、`game_db.py`）。提議者照輪序：全局第 i 次提議（0 起算）的隊長 = 第 (i mod 10) + 1 家。
 *
 * 純函式；讀檔與輸出在 `scripts/botGap.ts`。只用座位、配置、提議、任務、湖、刺殺，沒有名字。
 */

export type Outcome = 'red3' | 'blueDead' | 'blueAlive';
export const OUTCOMES: readonly Outcome[] = ['red3', 'blueDead', 'blueAlive'];
export const OUTCOME_LABEL: Record<Outcome, string> = { red3: '三紅', blueDead: '三藍死', blueAlive: '三藍活' };

/** 每一格報的四個率：三種結果，加上任務三藍（= 三藍死 + 三藍活）。 */
export type Metric = Outcome | 'missionBlue';
export const METRICS: readonly Metric[] = ['red3', 'blueDead', 'blueAlive', 'missionBlue'];
export const METRIC_LABEL: Record<Metric, string> = { ...OUTCOME_LABEL, missionBlue: '任務三藍' };

export type RoleKey = 'merlin' | 'percival' | 'loyal' | 'assassin' | 'morgana' | 'mordred' | 'oberon';
export const ROLE_LABEL: Record<RoleKey, string> = {
  merlin: '梅林', percival: '派西', loyal: '忠臣', assassin: '刺客', morgana: '莫甘娜', mordred: '莫德雷德', oberon: '奧伯倫',
};
/** 配置字串第 i 個字元 = 這個角色的座位（game_db 與 sp.ts detail 相同）。 */
export const CONFIG_ROLES: readonly RoleKey[] = ['assassin', 'morgana', 'mordred', 'oberon', 'percival', 'merlin'];
const RED_ROLES = new Set<RoleKey>(['assassin', 'morgana', 'mordred', 'oberon']);
/** 座位字元，依輪序：1..9、0（第 10 位）。 */
export const SEATS: readonly string[] = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];

export type Claim = 'o' | 'x' | '';

export interface GapRound {
  /** 這一局每一次提議的隊（座位字元），照提議順序。 */
  teams: string[];
  /** 任務牌：'o' 成功、'x' 失敗；沒出任務 = ''。 */
  mission: string;
}

export interface GapGame {
  outcome: Outcome;
  /** 桌上強度 S（10 個座位開打前 PR 的平均）；機器人局 = null。 */
  s: number | null;
  red5: boolean;
  red0: boolean;
  /** 座位 → 角色；只有摘要欄的機器人列 = null。 */
  roles: Record<string, RoleKey> | null;
  rounds: GapRound[] | null;
  /** 第一個湖：持湖者陣營 × 被驗者真實陣營 × 宣告；沒有湖 = null。 */
  lake1: { holderRed: boolean; targetRed: boolean; target: string; claim: Claim } | null;
}

// ─── 解析 ────────────────────────────────────────────────────────────────────

export function parseConfig(config: string): Record<string, RoleKey> | null {
  if (typeof config !== 'string' || config.length !== CONFIG_ROLES.length) return null;
  const seats = config.split('');
  if (new Set(seats).size !== seats.length || seats.some((c) => !SEATS.includes(c))) return null;
  const roles: Record<string, RoleKey> = {};
  for (const s of SEATS) roles[s] = 'loyal';
  seats.forEach((s, i) => { roles[s] = CONFIG_ROLES[i]; });
  return roles;
}

export const isRed = (roles: Record<string, RoleKey>, seat: string): boolean => RED_ROLES.has(roles[seat]);

/** 10 人局：第 4 局要 2 張失敗。 */
export function missionFailed(round: number, mission: string): boolean {
  const fails = (mission.match(/x/g) ?? []).length;
  return fails >= (round === 4 ? 2 : 1);
}

/** 從任務與刺殺推結果；沒分出勝負 = null。 */
export function outcomeOf(rounds: readonly GapRound[], roles: Record<string, RoleKey>, assassinTarget: string): Outcome | null {
  let fail = 0;
  let ok = 0;
  rounds.forEach((r, i) => {
    if (!r.mission) return;
    if (missionFailed(i + 1, r.mission)) fail++; else ok++;
  });
  if (fail >= 3) return 'red3';
  if (ok >= 3) {
    const merlin = Object.keys(roles).find((s) => roles[s] === 'merlin');
    return assassinTarget !== '' && assassinTarget === merlin ? 'blueDead' : 'blueAlive';
  }
  return null;
}

const asClaim = (c: unknown): Claim => (c === 'o' || c === 'x' ? c : '');

function lake1Of(roles: Record<string, RoleKey>, holder: string, target: string, claim: unknown): GapGame['lake1'] {
  if (!SEATS.includes(holder) || !SEATS.includes(target)) return null;
  return { holderRed: isRed(roles, holder), targetRed: isRed(roles, target), target, claim: asClaim(claim) };
}

/** `selfplay/sp.ts` detail=1 的 'g' 欄：{c, r: [{p: [[隊, 贊成的座位]], m, f}], l: [[持湖, 被驗, 宣告]], a}。 */
export interface BotDetail {
  c: string;
  r: { p: [string, string][]; m: string; f?: string }[];
  l: [string, string, string][];
  a: string;
}

export function gameFromBotDetail(d: BotDetail): GapGame | null {
  const roles = parseConfig(d.c);
  if (!roles || !Array.isArray(d.r)) return null;
  const rounds: GapRound[] = d.r.map((r) => ({ teams: (r?.p ?? []).map((p) => String(p[0])), mission: String(r?.m ?? '') }));
  const outcome = outcomeOf(rounds, roles, String(d.a ?? ''));
  if (!outcome) return null;
  const l = Array.isArray(d.l) && d.l.length ? d.l[0] : null;
  return {
    outcome, s: null, red5: isRed(roles, '5'), red0: isRed(roles, '0'), roles, rounds,
    lake1: l ? lake1Of(roles, String(l[0]), String(l[1]), l[2]) : null,
  };
}

/**
 * 沒有 'g' 欄的自我對打列（只有摘要欄）：只能算 5家×0家，有 lake45 欄時再加第一湖。
 * 需要的欄：threeBlue、merlinKilled、red5、red0；可選 redLake、lkTRed、lkClaim、lkT。
 */
export function gameFromBotSummary(row: readonly unknown[], cols: readonly string[]): GapGame | null {
  const at = (k: string): unknown => { const i = cols.indexOf(k); return i >= 0 ? row[i] : undefined; };
  const tb = at('threeBlue');
  const mk = at('merlinKilled');
  const r5 = at('red5');
  const r0 = at('red0');
  if (tb === undefined || mk === undefined || r5 === undefined || r0 === undefined) return null;
  const outcome: Outcome = Number(tb) !== 1 ? 'red3' : Number(mk) === 1 ? 'blueDead' : 'blueAlive';
  const holderRed = at('redLake');
  const targetRed = at('lkTRed');
  const lake1 = holderRed !== undefined && targetRed !== undefined && Number(holderRed) >= 0 && Number(targetRed) >= 0
    ? { holderRed: Number(holderRed) === 1, targetRed: Number(targetRed) === 1, target: String(at('lkT') ?? ''), claim: asClaim(at('lkClaim')) }
    : null;
  return { outcome, s: null, red5: Number(r5) === 1, red0: Number(r0) === 1, roles: null, rounds: null, lake1 };
}

/** game_db.json 的一局（只用到的欄）。 */
export interface DbGame {
  id?: string;
  /** 這局的來源（sheet = games_cache 的試算表局，id「S<流水號>」；dc_import = games_cache 的 DC 匯入局，id「D<hash>」）。 */
  sources?: { src: string; id: string }[];
  kind?: string;
  status?: string;
  external?: boolean;
  s?: number | null;
  game?: {
    config: string;
    rounds: { proposals: { team: string }[]; mission: string }[];
    lakes: { after?: number; holder: string; target: string; claim?: string }[];
    assassination?: string;
    outcome?: string;
  } | null;
}

const DB_OUTCOME: Record<string, Outcome> = { 三紅: 'red3', 三藍死: 'blueDead', 三藍活: 'blueAlive' };

/** 真人實戰局：kind real、status ok／warn、不是外部來源、牌譜讀得懂、結果和任務對得上。 */
export function gameFromDb(rec: DbGame): GapGame | null {
  if (rec.kind !== 'real' || (rec.status !== 'ok' && rec.status !== 'warn') || rec.external) return null;
  const g = rec.game;
  if (!g) return null;
  const roles = parseConfig(g.config);
  if (!roles || !Array.isArray(g.rounds)) return null;
  const rounds: GapRound[] = g.rounds.map((r) => ({ teams: (r.proposals ?? []).map((p) => String(p.team)), mission: String(r.mission ?? '') }));
  const recorded = DB_OUTCOME[String(g.outcome ?? '')];
  const derived = outcomeOf(rounds, roles, String(g.assassination ?? ''));
  // 任務端要一致；三藍時刺殺目標可能沒記（結果欄是正本）。
  if (!recorded || !derived || (recorded === 'red3') !== (derived === 'red3')) return null;
  const l = Array.isArray(g.lakes) && g.lakes.length ? g.lakes[0] : null;
  return {
    outcome: recorded, s: typeof rec.s === 'number' ? rec.s : null, red5: isRed(roles, '5'), red0: isRed(roles, '0'), roles, rounds,
    lake1: l ? lake1Of(roles, String(l.holder), String(l.target), l.claim) : null,
  };
}

// ─── 局面格 ──────────────────────────────────────────────────────────────────

export interface Family {
  id: string;
  label: string;
  /** 交叉族（兩個基本族的乘積）：列在報告裡、進前 10 名，但不進總距離的平均。 */
  cross: boolean;
  cell: (g: GapGame) => string | null;
}

const side = (red: boolean): string => (red ? '紅' : '藍');
const cell50 = (g: GapGame): string => `5${side(g.red5)}0${side(g.red0)}`;

/** 第 r 局的強制局（第 5 次提議）：照輪序的提議者陣營 × 隊上有沒有紅；沒走到第 5 次 = 「沒走到第5次」。 */
export function forcedCell(g: GapGame, round: number): string | null {
  if (!g.rounds || !g.roles || g.rounds.length < round) return null;
  const before = g.rounds.slice(0, round - 1).reduce((a, r) => a + r.teams.length, 0);
  const teams = g.rounds[round - 1].teams;
  if (teams.length < 5) return '沒走到第5次';
  const roles = g.roles;
  const leader = SEATS[(before + 4) % SEATS.length];
  const teamRed = teams[4].split('').some((s) => isRed(roles, s));
  return `隊長${side(isRed(roles, leader))}·${teamRed ? '隊上有紅' : '隊上無紅'}`;
}

export function lake1Cell(g: GapGame, withHolder = true): string | null {
  const l = g.lake1;
  if (!l || l.claim === '') return null;
  return `${withHolder ? `持湖${side(l.holderRed)}·` : ''}驗到${side(l.targetRed)}·說${l.claim === 'o' ? '藍' : '紅'}`;
}

/** 第 k 局後的比數「藍:紅」。 */
export function scoreCell(g: GapGame, k: number): string | null {
  if (!g.rounds || g.rounds.length < k) return null;
  let b = 0;
  let r = 0;
  for (let i = 0; i < k; i++) {
    const m = g.rounds[i].mission;
    if (!m) return null;
    if (missionFailed(i + 1, m)) r++; else b++;
  }
  return `${b}:${r}`;
}

const roleCell = (seat: string) => (g: GapGame): string | null => (g.roles ? ROLE_LABEL[g.roles[seat]] : null);

export const FAMILIES: readonly Family[] = [
  { id: '50', label: '5家×0家陣營', cross: false, cell: cell50 },
  ...[1, 2, 3, 4, 5].map((r): Family => ({ id: `forced:R${r}`, label: `第 ${r} 局強制局（第 5 次提議）的隊長陣營×隊上有沒有紅`, cross: false, cell: (g): string | null => forcedCell(g, r) })),
  { id: 'lake1', label: '第一湖：持湖者陣營×被驗者真實陣營×宣告', cross: false, cell: (g): string | null => lake1Cell(g) },
  ...[1, 2, 3].map((k): Family => ({ id: `score:R${k}`, label: `第 ${k} 局後的比數（藍:紅）`, cross: false, cell: (g): string | null => scoreCell(g, k) })),
  { id: 'role:1', label: '1 家的角色（1-1 隊長）', cross: false, cell: roleCell('1') },
  { id: 'role:5', label: '5 家的角色（第 1 局強制局隊長）', cross: false, cell: roleCell('5') },
  { id: 'role:0', label: '0 家的角色（第 2 局強制局隊長、第一湖）', cross: false, cell: roleCell('0') },
  { id: '50×lake1', label: '5家×0家×第一湖被驗者真實陣營×宣告（第 46 回合的組合）', cross: true, cell: (g): string | null => { const l = lake1Cell(g, false); return l ? `${cell50(g)}·${l}` : null; } },
  { id: '50×score:R2', label: '5家×0家×第 2 局後的比數', cross: true, cell: (g): string | null => { const s = scoreCell(g, 2); return s ? `${cell50(g)}·${s}` : null; } },
];

// ─── 統計 ────────────────────────────────────────────────────────────────────

export interface Counts { n: number; red3: number; blueDead: number; blueAlive: number }
const emptyCounts = (): Counts => ({ n: 0, red3: 0, blueDead: 0, blueAlive: 0 });
export const hits = (c: Counts, m: Metric): number => (m === 'missionBlue' ? c.blueDead + c.blueAlive : c[m]);

/** family id → cell → 計數。 */
export type Tally = Map<string, Map<string, Counts>>;

export function newTally(): Tally { return new Map(FAMILIES.map((f) => [f.id, new Map<string, Counts>()])); }

export function addGame(t: Tally, g: GapGame, families: readonly Family[] = FAMILIES): void {
  for (const f of families) {
    const key = f.cell(g);
    if (key === null) continue;
    const m = t.get(f.id) ?? new Map<string, Counts>();
    t.set(f.id, m);
    const c = m.get(key) ?? emptyCounts();
    m.set(key, c);
    c.n++;
    c[g.outcome]++;
  }
}

export function tallyGames(games: Iterable<GapGame>, families: readonly Family[] = FAMILIES): Tally {
  const t = newTally();
  for (const g of games) addGame(t, g, families);
  return t;
}

export function totals(games: Iterable<GapGame>): Counts {
  const c = emptyCounts();
  for (const g of games) { c.n++; c[g.outcome]++; }
  return c;
}

export interface Rate { k: number; n: number; rate: number; lo: number; hi: number }

/** Wilson 95% 區間。 */
export function wilson(k: number, n: number): Rate {
  if (n === 0) return { k, n, rate: NaN, lo: NaN, hi: NaN };
  const z = 1.959964;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { k, n, rate: p, lo: Math.max(0, c - h), hi: Math.min(1, c + h) };
}

const dist = (c: Counts): number[] => OUTCOMES.map((o) => (c.n ? c[o] / c.n : NaN));

/** ½ Σ |p − q|（三種結果）；任一邊沒有局 = NaN。 */
export function tvDistance(a: Counts, b: Counts): number {
  if (!a.n || !b.n) return NaN;
  const p = dist(a);
  const q = dist(b);
  return 0.5 * p.reduce((s, x, i) => s + Math.abs(x - q[i]), 0);
}

/**
 * 兩邊分布其實相同時 TV 的期望值（抽樣雜訊的底）：每個結果 E|p̂ − q̂| ≈ √(2/π)·√(p(1−p)(1/n₁ + 1/n₂))，p 用參考那邊（真人）。
 */
export function tvNoise(ref: Counts, other: Counts): number {
  if (!ref.n || !other.n) return NaN;
  const p = dist(ref);
  const k = Math.sqrt(2 / Math.PI) * Math.sqrt(1 / ref.n + 1 / other.n);
  return 0.5 * p.reduce((s, x) => s + k * Math.sqrt(x * (1 - x)), 0);
}

/** 兩個比例的差的 z（不合併的標準誤）。 */
export function diffZ(a: Rate, b: Rate): number {
  if (!a.n || !b.n) return NaN;
  const se = Math.sqrt((a.rate * (1 - a.rate)) / a.n + (b.rate * (1 - b.rate)) / b.n);
  return se > 0 ? (a.rate - b.rate) / se : 0;
}

export type RefCohort = 'human' | 'strong';

export interface MetricCell {
  bot: Rate;
  human: Rate;
  strong: Rate;
  /** 機器人 − 真人、機器人 − 強者（比例，不是百分點）。 */
  gapHuman: number;
  gapStrong: number;
  zHuman: number;
  zStrong: number;
}

export interface CellReport {
  family: string;
  cell: string;
  bot: Counts;
  human: Counts;
  strong: Counts;
  /** 這一格在這一族的真人（強者）局裡的占比。 */
  shareHuman: number;
  shareStrong: number;
  metrics: Record<Metric, MetricCell>;
  tvHuman: number;
  tvStrong: number;
  noiseHuman: number;
  noiseStrong: number;
  /** 占比 × TV（進距離的格才有；其餘 NaN）。 */
  weightedHuman: number;
  weightedStrong: number;
  /** 進距離：機器人 n ≥ minBot 且參考 n ≥ minRef。 */
  inHuman: boolean;
  inStrong: boolean;
}

export interface FamilyReport {
  id: string;
  label: string;
  cross: boolean;
  cells: CellReport[];
  /** 加權 TV 距離（權重 = 參考的格頻率，在進距離的格上重新正規化）。 */
  dHuman: number;
  dStrong: number;
  /** 同樣加權的抽樣雜訊底。 */
  noiseHuman: number;
  noiseStrong: number;
  /** 進距離的格占參考局的比例。 */
  massHuman: number;
  massStrong: number;
  /** 參考局在機器人完全沒有出現的格的比例（機器人不會走到的局面）。 */
  uncoveredHuman: number;
  uncoveredStrong: number;
}

export interface GapOptions {
  minBot: number;
  minRef: number;
  top: number;
}
export const DEFAULT_GAP_OPTIONS: GapOptions = { minBot: 30, minRef: 10, top: 10 };

export interface CohortTallies { bot: Tally; human: Tally; strong: Tally }

export interface GapSummary {
  /** 基本族（不含交叉族）D 的平均。 */
  dHuman: number;
  dStrong: number;
  noiseHuman: number;
  noiseStrong: number;
}

export interface GapReport {
  meta: Record<string, unknown>;
  totals: { bot: Counts; human: Counts; strong: Counts };
  families: FamilyReport[];
  summary: GapSummary;
  topHuman: CellReport[];
  topStrong: CellReport[];
}

function metricCell(bot: Counts, human: Counts, strong: Counts, m: Metric): MetricCell {
  const b = wilson(hits(bot, m), bot.n);
  const h = wilson(hits(human, m), human.n);
  const s = wilson(hits(strong, m), strong.n);
  return { bot: b, human: h, strong: s, gapHuman: b.rate - h.rate, gapStrong: b.rate - s.rate, zHuman: diffZ(b, h), zStrong: diffZ(b, s) };
}

const mean = (xs: readonly number[]): number => { const v = xs.filter(Number.isFinite); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN; };

export function familyReport(f: Family, t: CohortTallies, opts: GapOptions = DEFAULT_GAP_OPTIONS): FamilyReport {
  const B = t.bot.get(f.id) ?? new Map<string, Counts>();
  const H = t.human.get(f.id) ?? new Map<string, Counts>();
  const S = t.strong.get(f.id) ?? new Map<string, Counts>();
  const keys = [...new Set([...B.keys(), ...H.keys(), ...S.keys()])];
  const sumN = (m: Map<string, Counts>): number => [...m.values()].reduce((a, c) => a + c.n, 0);
  const nH = sumN(H);
  const nS = sumN(S);
  const cells: CellReport[] = keys.map((cell) => {
    const bot = B.get(cell) ?? emptyCounts();
    const human = H.get(cell) ?? emptyCounts();
    const strong = S.get(cell) ?? emptyCounts();
    const metrics = Object.fromEntries(METRICS.map((m) => [m, metricCell(bot, human, strong, m)])) as Record<Metric, MetricCell>;
    const inHuman = bot.n >= opts.minBot && human.n >= opts.minRef;
    const inStrong = bot.n >= opts.minBot && strong.n >= opts.minRef;
    const shareHuman = nH ? human.n / nH : 0;
    const shareStrong = nS ? strong.n / nS : 0;
    const tvHuman = tvDistance(bot, human);
    const tvStrong = tvDistance(bot, strong);
    return {
      family: f.id, cell, bot, human, strong, shareHuman, shareStrong, metrics,
      tvHuman, tvStrong, noiseHuman: tvNoise(human, bot), noiseStrong: tvNoise(strong, bot),
      weightedHuman: inHuman ? shareHuman * tvHuman : NaN, weightedStrong: inStrong ? shareStrong * tvStrong : NaN,
      inHuman, inStrong,
    };
  });
  cells.sort((a, b) => b.human.n - a.human.n || b.bot.n - a.bot.n || a.cell.localeCompare(b.cell));
  const weighted = (ref: RefCohort): { d: number; noise: number; mass: number; uncovered: number } => {
    const inc = cells.filter((c) => (ref === 'human' ? c.inHuman : c.inStrong));
    const share = (c: CellReport): number => (ref === 'human' ? c.shareHuman : c.shareStrong);
    const mass = inc.reduce((a, c) => a + share(c), 0);
    const d = mass > 0 ? inc.reduce((a, c) => a + share(c) * (ref === 'human' ? c.tvHuman : c.tvStrong), 0) / mass : NaN;
    const noise = mass > 0 ? inc.reduce((a, c) => a + share(c) * (ref === 'human' ? c.noiseHuman : c.noiseStrong), 0) / mass : NaN;
    const uncovered = cells.filter((c) => c.bot.n === 0).reduce((a, c) => a + share(c), 0);
    return { d, noise, mass, uncovered };
  };
  const h = weighted('human');
  const s = weighted('strong');
  return {
    id: f.id, label: f.label, cross: f.cross, cells,
    dHuman: h.d, dStrong: s.d, noiseHuman: h.noise, noiseStrong: s.noise,
    massHuman: h.mass, massStrong: s.mass, uncoveredHuman: h.uncovered, uncoveredStrong: s.uncovered,
  };
}

export function buildGapReport(
  t: CohortTallies,
  tot: GapReport['totals'],
  meta: Record<string, unknown> = {},
  opts: GapOptions = DEFAULT_GAP_OPTIONS,
  families: readonly Family[] = FAMILIES,
): GapReport {
  const fams = families.map((f) => familyReport(f, t, opts));
  const base = fams.filter((f) => !f.cross);
  const all = fams.flatMap((f) => f.cells);
  const top = (key: 'weightedHuman' | 'weightedStrong'): CellReport[] =>
    all.filter((c) => Number.isFinite(c[key])).sort((a, b) => b[key] - a[key]).slice(0, opts.top);
  return {
    meta: { ...meta, minBot: opts.minBot, minRef: opts.minRef },
    totals: tot,
    families: fams,
    summary: {
      dHuman: mean(base.map((f) => f.dHuman)), dStrong: mean(base.map((f) => f.dStrong)),
      noiseHuman: mean(base.map((f) => f.noiseHuman)), noiseStrong: mean(base.map((f) => f.noiseStrong)),
    },
    topHuman: top('weightedHuman'),
    topStrong: top('weightedStrong'),
  };
}

// ─── 當成關卡：候選 vs 基準 ─────────────────────────────────────────────────

export interface GateTolerance {
  /** 總距離（基本族平均）可以增加多少。 */
  overall: number;
  /** 單一基本族的 D 可以增加多少。 */
  family: number;
}
export const DEFAULT_GATE_TOLERANCE: GateTolerance = { overall: 0.003, family: 0.01 };

export interface GateResult {
  deltaHuman: number;
  deltaStrong: number;
  families: { id: string; baseHuman: number; candHuman: number; deltaHuman: number; baseStrong: number; candStrong: number; deltaStrong: number }[];
  /** 加權落差（對真人）增加最多的格。 */
  worsened: { family: string; cell: string; base: number; cand: number; delta: number }[];
  /** 加權落差（對真人）減少最多的格。 */
  improved: { family: string; cell: string; base: number; cand: number; delta: number }[];
  pass: boolean;
  reasons: string[];
}

export function compareReports(base: GapReport, cand: GapReport, tol: GateTolerance = DEFAULT_GATE_TOLERANCE, top = 10): GateResult {
  const reasons: string[] = [];
  const deltaHuman = cand.summary.dHuman - base.summary.dHuman;
  const deltaStrong = cand.summary.dStrong - base.summary.dStrong;
  if (deltaHuman > tol.overall) reasons.push(`總距離（真人）+${deltaHuman.toFixed(4)} > ${tol.overall}`);
  if (deltaStrong > tol.overall) reasons.push(`總距離（強者）+${deltaStrong.toFixed(4)} > ${tol.overall}`);
  const families = cand.families.map((cf) => {
    const bf = base.families.find((f) => f.id === cf.id);
    const row = {
      id: cf.id,
      baseHuman: bf?.dHuman ?? NaN, candHuman: cf.dHuman, deltaHuman: cf.dHuman - (bf?.dHuman ?? NaN),
      baseStrong: bf?.dStrong ?? NaN, candStrong: cf.dStrong, deltaStrong: cf.dStrong - (bf?.dStrong ?? NaN),
    };
    if (!cf.cross) {
      if (row.deltaHuman > tol.family) reasons.push(`${cf.id}（真人）+${row.deltaHuman.toFixed(4)} > ${tol.family}`);
      if (row.deltaStrong > tol.family) reasons.push(`${cf.id}（強者）+${row.deltaStrong.toFixed(4)} > ${tol.family}`);
    }
    return row;
  });
  const cells = cand.families.flatMap((cf) => {
    const bf = base.families.find((f) => f.id === cf.id);
    return cf.cells.map((c) => {
      const b = bf?.cells.find((x) => x.cell === c.cell);
      return { family: cf.id, cell: c.cell, base: b?.weightedHuman ?? NaN, cand: c.weightedHuman, delta: c.weightedHuman - (b?.weightedHuman ?? NaN) };
    });
  }).filter((c) => Number.isFinite(c.delta));
  return {
    deltaHuman, deltaStrong, families,
    worsened: [...cells].sort((a, b) => b.delta - a.delta).slice(0, top).filter((c) => c.delta > 0),
    improved: [...cells].sort((a, b) => a.delta - b.delta).slice(0, top).filter((c) => c.delta < 0),
    pass: reasons.length === 0,
    reasons,
  };
}

// ─── Markdown ────────────────────────────────────────────────────────────────

const pct = (x: number, d = 1): string => (Number.isFinite(x) ? (100 * x).toFixed(d) : '—');
const signed = (x: number, d = 1): string => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${(100 * x).toFixed(d)}` : '—');
const num = (x: number, d = 3): string => (Number.isFinite(x) ? x.toFixed(d) : '—');
const ci = (r: Rate): string => (r.n ? `${pct(r.rate)} [${pct(r.lo, 0)}, ${pct(r.hi, 0)}]` : '—');
const triple = (c: Counts): string => (c.n ? OUTCOMES.map((o) => pct(c[o] / c.n)).join('／') : '—');
const tripleCi = (c: Counts): string => (c.n ? OUTCOMES.map((o) => ci(wilson(c[o], c.n))).join('／') : '—');

function familyLabel(id: string): string {
  return FAMILIES.find((f) => f.id === id)?.label ?? id;
}

function topTable(cells: readonly CellReport[], ref: RefCohort): string[] {
  const out = [
    `| # | 族 | 格 | n 機器人／真人／強者 | 機器人 三紅／三藍死／三藍活 % | ${ref === 'human' ? '真人' : '強者'} 三紅／三藍死／三藍活 %（Wilson 95%） | 任務三藍 機器人／真人／強者 % | Δ任務三藍 對真人／強者（pp） | Δ三藍活 對真人／強者（pp） | TV（雜訊底） | 加權 |`,
    '|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  cells.forEach((c, i) => {
    const refC = ref === 'human' ? c.human : c.strong;
    const mb = c.metrics.missionBlue;
    const ba = c.metrics.blueAlive;
    out.push(`| ${i + 1} | ${c.family} | ${c.cell} | ${c.bot.n}／${c.human.n}／${c.strong.n} | ${triple(c.bot)} | ${tripleCi(refC)} | ${pct(mb.bot.rate)}／${pct(mb.human.rate)}／${pct(mb.strong.rate)} | ${signed(mb.gapHuman)}／${signed(mb.gapStrong)} | ${signed(ba.gapHuman)}／${signed(ba.gapStrong)} | ${num(ref === 'human' ? c.tvHuman : c.tvStrong)}（${num(ref === 'human' ? c.noiseHuman : c.noiseStrong)}） | ${num(ref === 'human' ? c.weightedHuman : c.weightedStrong, 4)} |`);
  });
  return out;
}

export function renderMarkdown(r: GapReport, gate?: { base: GapReport; result: GateResult }): string {
  const L: string[] = [];
  const m = r.meta;
  L.push(`# 和強者的落差：分局面的結果分布（${String(m.label ?? '')}）`, '');
  L.push(`- 機器人：${String(m.bot ?? '')}（${r.totals.bot.n} 局${m.botPartial ? `，其中 ${String(m.botPartial)} 局只有摘要欄，只進 5家×0家／第一湖` : ''}）`);
  L.push(`- 真人：${String(m.human ?? '')}；可以拆局面的 ${r.totals.human.n} 局（實戰局、status ok／warn、非外部來源、結果和任務對得上）。強者 = 高端桌 S ≥ ${String(m.strongS ?? '')}（10 個座位開打前 PR 的平均；同網站數據分析「分組」的桌分層與 S_TIERS 偏強＋高強度），${r.totals.strong.n} 局`);
  L.push(`- 每一格的比例用 Wilson 95%；TV = ½Σ|機器人 − 參考|（三紅／三藍死／三藍活）；雜訊底 = 兩邊分布相同時 TV 的期望值；每一族的 D = 以參考局的格頻率加權的 TV（只算機器人 n ≥ ${String(m.minBot)}、參考 n ≥ ${String(m.minRef)} 的格，權重重新正規化）；總距離 = 基本族 D 的平均（交叉族不算）。加權 = 格頻率 × TV。`);
  L.push('');
  L.push('## 總覽', '');
  L.push('| | n | 三紅 | 三藍死 | 三藍活 | 任務三藍 | 刺中率 |', '|---|---|---|---|---|---|---|');
  for (const [name, c] of [['機器人', r.totals.bot], ['真人', r.totals.human], ['強者', r.totals.strong]] as const) {
    const blue = c.blueDead + c.blueAlive;
    L.push(`| ${name} | ${c.n} | ${ci(wilson(c.red3, c.n))} | ${ci(wilson(c.blueDead, c.n))} | ${ci(wilson(c.blueAlive, c.n))} | ${ci(wilson(blue, c.n))} | ${ci(wilson(c.blueDead, blue))} |`);
  }
  L.push('', `**總距離 D**：對真人 ${num(r.summary.dHuman, 4)}（雜訊底 ${num(r.summary.noiseHuman, 4)}）、對強者 ${num(r.summary.dStrong, 4)}（雜訊底 ${num(r.summary.noiseStrong, 4)}）`, '');
  L.push('| 族 | D 對真人（雜訊底） | D 對強者（雜訊底） | 進距離的真人局占比 | 機器人沒走到的真人局占比 |', '|---|---|---|---|---|');
  for (const f of r.families) {
    L.push(`| ${f.id}${f.cross ? '（交叉）' : ''} | ${num(f.dHuman, 4)}（${num(f.noiseHuman, 4)}） | ${num(f.dStrong, 4)}（${num(f.noiseStrong, 4)}） | ${pct(f.massHuman)}% | ${pct(f.uncoveredHuman)}% |`);
  }
  if (gate) {
    const g = gate.result;
    L.push('', `## 關卡：候選 vs 基準（${String(gate.base.meta.label ?? '')}）`, '');
    L.push(`- 總距離 對真人 ${num(gate.base.summary.dHuman, 4)} → ${num(r.summary.dHuman, 4)}（${g.deltaHuman >= 0 ? '+' : ''}${num(g.deltaHuman, 4)}）；對強者 ${num(gate.base.summary.dStrong, 4)} → ${num(r.summary.dStrong, 4)}（${g.deltaStrong >= 0 ? '+' : ''}${num(g.deltaStrong, 4)}）`);
    L.push(`- 結果：**${g.pass ? '過' : '不過'}**${g.reasons.length ? `（${g.reasons.join('；')}）` : ''}`, '');
    L.push('| 族 | D 對真人 基準 → 候選 | D 對強者 基準 → 候選 |', '|---|---|---|');
    for (const f of g.families) L.push(`| ${f.id} | ${num(f.baseHuman, 4)} → ${num(f.candHuman, 4)}（${f.deltaHuman >= 0 ? '+' : ''}${num(f.deltaHuman, 4)}） | ${num(f.baseStrong, 4)} → ${num(f.candStrong, 4)}（${f.deltaStrong >= 0 ? '+' : ''}${num(f.deltaStrong, 4)}） |`);
    if (g.worsened.length) {
      L.push('', '加權落差（對真人）變大最多的格：', '');
      for (const c of g.worsened) L.push(`- ${c.family}｜${c.cell}：${num(c.base, 4)} → ${num(c.cand, 4)}`);
    }
    if (g.improved.length) {
      L.push('', '加權落差（對真人）變小最多的格：', '');
      for (const c of g.improved) L.push(`- ${c.family}｜${c.cell}：${num(c.base, 4)} → ${num(c.cand, 4)}`);
    }
  }
  L.push('', `## 加權落差最大的 ${r.topHuman.length} 格（對全部真人）`, '', ...topTable(r.topHuman, 'human'));
  L.push('', `## 加權落差最大的 ${r.topStrong.length} 格（對強者）`, '', ...topTable(r.topStrong, 'strong'));
  L.push('', '## 每一族的完整表', '');
  for (const f of r.families) {
    L.push(`### ${f.id}：${familyLabel(f.id)}`, '');
    L.push(`D 對真人 ${num(f.dHuman, 4)}（雜訊底 ${num(f.noiseHuman, 4)}）、對強者 ${num(f.dStrong, 4)}（雜訊底 ${num(f.noiseStrong, 4)}）`, '');
    L.push('| 格 | n 機器人／真人／強者 | 機器人 三紅／三藍死／三藍活 % | 真人 三紅／三藍死／三藍活 %（Wilson 95%） | 強者 三紅／三藍死／三藍活 % | 任務三藍 機器人 ／ 真人 [95%] ／ 強者 [95%] | Δ任務三藍 對真人／強者 | Δ三藍活 對真人／強者 | TV 真人（雜訊底）／強者 |');
    L.push('|---|---|---|---|---|---|---|---|---|');
    for (const c of f.cells) {
      const mb = c.metrics.missionBlue;
      const ba = c.metrics.blueAlive;
      L.push(`| ${c.cell} | ${c.bot.n}／${c.human.n}／${c.strong.n} | ${triple(c.bot)} | ${tripleCi(c.human)} | ${triple(c.strong)} | ${pct(mb.bot.rate)} ／ ${ci(mb.human)} ／ ${ci(mb.strong)} | ${signed(mb.gapHuman)}／${signed(mb.gapStrong)} | ${signed(ba.gapHuman)}／${signed(ba.gapStrong)} | ${num(c.tvHuman)}（${num(c.noiseHuman)}）／${num(c.tvStrong)} |`);
    }
    L.push('');
  }
  return L.join('\n');
}

// ─── 真人參考：網站數據分析的同一批局（第 1G 節） ─────────────────────────────

/** games_cache 解碼後的一局（只用到的欄）。 */
export interface CacheGameRef {
  id: string;
  /** 0 = 試算表、1 = DC 匯入（games_cache 的 src）。 */
  source: number;
  outcome: string;
  /** 陣容強度 S；不評分 = null。 */
  s: number | null;
}

/** games_cache 的一局在 game_db 裡的來源鍵（game_db.py 的 public_id：試算表加「S」前綴）。 */
export function cacheSourceKey(g: Pick<CacheGameRef, 'id' | 'source'>): string {
  return g.source === 0 ? `sheet|S${g.id}` : `dc_import|${g.id}`;
}

export interface HumanReference {
  human: GapGame[];
  strong: GapGame[];
  /** 網站那一批局（有結果的）與其中的高端桌局數；可以拆局面的是 human／strong。 */
  site: { games: number; strong: number };
  /** 網站的局在 game_db 找不到紀錄、或紀錄讀不懂／結果對不上的局數。 */
  unmatched: number;
}

const DECIDED = new Set(['三紅', '三藍死', '三藍活']);

/**
 * 真人參考 = 網站數據分析的那一批局（games_cache 解碼、百科AI 局已拿掉）裡，game_db 有可讀紀錄的局；S 用 games_cache 的陣容強度，
 * 高端桌 = S ≥ strongS（網站分組的 S 上切點，預設 55）。
 */
export function humanFromCache(cache: readonly CacheGameRef[], db: readonly DbGame[], strongS: number): HumanReference {
  const byKey = new Map<string, DbGame>();
  for (const rec of db) for (const src of rec.sources ?? []) {
    if (src.src === 'sheet' || src.src === 'dc_import') byKey.set(`${src.src}|${src.id}`, rec);
  }
  const human: GapGame[] = [];
  const strong: GapGame[] = [];
  let games = 0;
  let strongN = 0;
  let unmatched = 0;
  for (const c of cache) {
    if (!DECIDED.has(c.outcome)) continue;
    games++;
    const isStrong = c.s !== null && c.s >= strongS;
    if (isStrong) strongN++;
    const rec = byKey.get(cacheSourceKey(c));
    const g = rec ? gameFromDb(rec) : null;
    if (!g) { unmatched++; continue; }
    const withS: GapGame = { ...g, s: c.s };
    human.push(withS);
    if (isStrong) strong.push(withS);
  }
  return { human, strong, site: { games, strong: strongN }, unmatched };
}
