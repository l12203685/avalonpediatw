/**
 * 「百科AI 優化歷程」頁（#ai-history）的資料型別與純函式（站長 2026-11-20：「百科網站上可以彙整公布一下目前優化的進程歷史嗎
 * 主要的改動 精簡 一目了然就好 做了什麼策略/動作/思考優化 導致 任務勝率&最終勝率 提升 (分角色)」）。
 *
 * 資料：packages/web/src/data/aiHistory.json，由 scripts/build_ai_history.ts 產生——
 * 手寫的里程碑（docs/ai/ai_history.curated.json）＋從 docs/ai/optimization_loop.md 第 4 節回合紀錄表解析出來的回合數。
 * 每次採用新預設就在 curated 檔加一列、重跑腳本（見 optimization_loop.md 第 4 節的說明）。
 * 測試：packages/server/src/__tests__/WebAiHistory.test.ts（web 沒有測試執行器）。
 */
import {
  DEFAULT_COHORT_CUTS, OUTCOME_BLUE_ALIVE, OUTCOME_BLUE_DEAD, OUTCOME_THREE_RED, S_TIERS, TABLE_TIER_LABELS,
  type StrengthPoint,
} from '@avalon/shared/stats';

/** 角色（篩選與分角色彙整用）。reading = 藍方全體的讀人方法；blue／red = 一次改到多個角色的整包。 */
export type AiRole =
  | 'reading' | 'loyal' | 'merlin' | 'percival'
  | 'assassin' | 'morgana' | 'mordred' | 'oberon'
  | 'blue' | 'red';

export const ROLE_LABEL: Record<AiRole, string> = {
  reading: '讀法（藍方全體）',
  loyal: '忠臣',
  merlin: '梅林',
  percival: '派西',
  assassin: '刺客',
  morgana: '莫甘娜',
  mordred: '莫德雷德',
  oberon: '奧伯倫',
  blue: '藍方多角色整包',
  red: '紅方多角色整包',
};

/** 分角色彙整的順序：藍方在前、紅方在後。 */
export const ROLE_ORDER: readonly AiRole[] = [
  'reading', 'loyal', 'merlin', 'percival', 'blue', 'assassin', 'morgana', 'mordred', 'oberon', 'red',
];

export const ROLE_SIDE: Record<AiRole, 'blue' | 'red'> = {
  reading: 'blue', loyal: 'blue', merlin: 'blue', percival: 'blue', blue: 'blue',
  assassin: 'red', morgana: 'red', mordred: 'red', oberon: 'red', red: 'red',
};

/**
 * 一次量測的差（百分點）。values 一個值＋lo／hi = 有 95% 區間；多個值 = 文件只列各組種子的點估計（例：+1.2／+0.8）。
 * 勝率差從「改的那一方」看：藍方列是藍方最終勝率（三藍活），紅方列是紅方勝率。
 */
export interface AiDelta {
  values: number[];
  lo?: number;
  hi?: number;
}

export interface AiMilestone {
  /** 唯一 id，例 r54-merlin-known-red。 */
  id: string;
  /** 回合（optimization_loop.md 第 4 節的「回合」欄），例 '54'、'43b'。 */
  round: string;
  /** 採用（改成預設）的日期 YYYY-MM-DD。 */
  date: string;
  side: 'blue' | 'red';
  /** 改到的角色（篩選用）。 */
  roles: AiRole[];
  /** 分角色彙整時算在哪一格（一個里程碑只算一次）。 */
  primary: AiRole;
  /** strategy = 策略／動作；reading = 讀人的方法；fix = 邏輯一致性修正。 */
  kind: 'strategy' | 'reading' | 'fix';
  /** 重點（預設只顯示重點）。 */
  highlight?: boolean;
  /** 做了什麼（一句，策略語言）。 */
  what: string;
  /** 為什麼（一句：想法或真人資料的發現）。 */
  why: string;
  /** 最終勝率差（從改的那一方看）；null = 文件沒有單獨量。 */
  win: AiDelta | null;
  /** 任務三藍率差（藍方三次任務成功的比率；正 = 三藍變多）；null = 文件沒有。 */
  task: AiDelta | null;
  /** 量測規模，例「3 組 × 10 萬局確認」。 */
  sample: string;
  note?: string;
}

/** 走勢圖的一點：那一回合之後的預設（全機器人自我對打，對手 = 當時的另一方預設）。 */
export interface AiSeriesPoint {
  round: string;
  /** 這一回合改的是哪一方（null = 起點）。 */
  side: 'blue' | 'red' | null;
  /** 藍方最終勝率（三藍活）%。 */
  win: number;
  /** 任務三藍率 %（文件有才有）。 */
  task: number | null;
  note?: string;
}

export interface AiHeadlineRow {
  key: string;
  label: string;
  /** 任務三藍率 %。 */
  task: number | null;
  /** 藍方最終勝率（三藍活）%。 */
  win: number;
  /** 刺中率（三藍之後梅林被刺中）%。 */
  hit: number | null;
  sample: string;
  note?: string;
}

export interface AiHistoryData {
  version: 1;
  generatedAt: string;
  source: string;
  stats: { rounds: number; adoptedRounds: number; notAdoptedRounds: number; latestRound: string };
  headline: AiHeadlineRow[];
  series: AiSeriesPoint[];
  milestones: AiMilestone[];
}

// ── 回合紀錄表（optimization_loop.md 第 4 節） ─────────────────────────────────────────

export interface RoundRow {
  round: string;
  side: string;
  adoptedText: string;
  adopted: boolean;
}

/** 「採用」欄 → 有沒有改預設。「是」「**是**…」「是（B1、C1…）」算採用；「否」「不採用」「—」不算。 */
export function isAdoptedText(text: string): boolean {
  const t = text.replace(/\*/g, '').trim();
  return /^是/.test(t);
}

/** '43b' → 43.5、'7' → 7；排序用。讀不懂時 NaN。 */
export function roundOrder(round: string): number {
  const m = /^(\d+)([a-z]?)$/i.exec(round.trim());
  if (!m) return Number.NaN;
  return Number(m[1]) + (m[2] ? 0.5 : 0);
}

/**
 * 解析 optimization_loop.md 的「## 4. 回合紀錄」表：每一列的回合、陣營、採用欄（最後一個「採用」欄位，照表頭找位置）。
 * 同一回合分角色的多列（例：第 3 回合忠臣／派西／梅林）各自一列。
 */
export function parseRoundTable(markdown: string): RoundRow[] {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s*4\.\s*回合紀錄/.test(l));
  if (start < 0) return [];
  let header: string[] | null = null;
  const rows: RoundRow[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s/.test(line) || /^###\s/.test(line)) break;
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (!header) {
      header = cells;
      continue;
    }
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
    const roundIdx = header.indexOf('回合');
    const sideIdx = header.indexOf('陣營');
    const adoptIdx = header.lastIndexOf('採用');
    if (roundIdx < 0 || adoptIdx < 0) continue;
    const round = (cells[roundIdx] ?? '').replace(/\*/g, '').trim();
    if (!/^\d+[a-z]?$/i.test(round)) continue;
    const adoptedText = cells[adoptIdx] ?? '';
    rows.push({ round, side: cells[sideIdx] ?? '', adoptedText, adopted: isAdoptedText(adoptedText) });
  }
  return rows;
}

/** 回合數：同一回合的多列算一回合；有任何一列採用就算「有採用的回合」。回合 0（起點量測）不算。 */
export function roundStats(rows: RoundRow[]): AiHistoryData['stats'] {
  const byRound = new Map<string, boolean>();
  for (const r of rows) {
    if (r.round === '0') continue;
    byRound.set(r.round, (byRound.get(r.round) ?? false) || r.adopted);
  }
  const rounds = [...byRound.keys()];
  const adoptedRounds = rounds.filter((r) => byRound.get(r)).length;
  const latestRound = rounds.reduce((best, r) => (roundOrder(r) > roundOrder(best) ? r : best), rounds[0] ?? '0');
  return { rounds: rounds.length, adoptedRounds, notAdoptedRounds: rounds.length - adoptedRounds, latestRound };
}

// ── 顯示 ─────────────────────────────────────────────────────────────────────────────

/** 點估計：一個值就是那個值；多組種子取平均（彙整用）。 */
export function deltaMean(d: AiDelta | null | undefined): number | null {
  if (!d || d.values.length === 0) return null;
  return d.values.reduce((a, b) => a + b, 0) / d.values.length;
}

function signed(n: number, digits: number): string {
  const s = Math.abs(n).toFixed(digits);
  if (Number(s) === 0) return `±${s}`;
  return `${n > 0 ? '+' : '−'}${s}`;
}

function digitsOf(d: AiDelta): number {
  const all = [...d.values, ...(d.lo !== undefined ? [d.lo] : []), ...(d.hi !== undefined ? [d.hi] : [])];
  const dec = (n: number): number => {
    const s = String(Math.abs(n));
    const i = s.indexOf('.');
    return i < 0 ? 0 : s.length - i - 1;
  };
  return Math.min(2, Math.max(1, ...all.map(dec)));
}

/** '+0.16 [+0.13, +0.19]'、'+1.2／+0.8（2 組）'、'+4.0'；null → '—'。單位是百分點，不帶 pp。 */
export function formatDelta(d: AiDelta | null | undefined): string {
  if (!d || d.values.length === 0) return '—';
  const k = digitsOf(d);
  if (d.values.length === 1) {
    const v = signed(d.values[0], k);
    return d.lo !== undefined && d.hi !== undefined ? `${v} [${signed(d.lo, k)}, ${signed(d.hi, k)}]` : v;
  }
  return `${d.values.map((v) => signed(v, k)).join('／')}（${d.values.length} 組）`;
}

/** 有 95% 區間而且整個在 0 以上 = 'up'、整個在 0 以下 = 'down'、跨 0 = 'flat'；沒有區間照點估計（|x| < 0.1 算 flat）。 */
export function deltaTrend(d: AiDelta | null | undefined): 'up' | 'down' | 'flat' | null {
  const m = deltaMean(d);
  if (!d || m === null) return null;
  if (d.lo !== undefined && d.hi !== undefined && d.values.length === 1) {
    if (d.lo > 0) return 'up';
    if (d.hi < 0) return 'down';
    return 'flat';
  }
  if (Math.abs(m) < 0.1) return 'flat';
  return m > 0 ? 'up' : 'down';
}

/** 新的在前：日期新的在前，同一天回合大的在前，同回合照 id。 */
export function sortMilestones(list: readonly AiMilestone[]): AiMilestone[] {
  return [...list].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    const ra = roundOrder(a.round);
    const rb = roundOrder(b.round);
    if (ra !== rb) return rb - ra;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export type RoleFilter = AiRole | 'all' | 'blueSide' | 'redSide';

export function filterMilestones(list: readonly AiMilestone[], role: RoleFilter, highlightsOnly: boolean): AiMilestone[] {
  return list.filter((m) => {
    if (highlightsOnly && !m.highlight) return false;
    if (role === 'all') return true;
    if (role === 'blueSide') return m.side === 'blue';
    if (role === 'redSide') return m.side === 'red';
    return m.roles.includes(role);
  });
}

export interface RoleSummaryRow {
  role: AiRole;
  side: 'blue' | 'red';
  /** 算在這一格的里程碑數（primary）。 */
  count: number;
  /** 改到這個角色的里程碑數（roles 含它）。 */
  touched: number;
  /** 算在這一格的最終勝率差加總（各自量的點估計；多組取平均）。 */
  winSum: number;
  /** 有勝率數字的里程碑數。 */
  winCount: number;
  taskSum: number;
  taskCount: number;
  /** 算在這一格的里程碑，新的在前。 */
  items: AiMilestone[];
}

/**
 * 分角色彙整：每個里程碑只算進它的 primary 那一格（所以各格加起來＝全部）。
 * 勝率差是「當時對當時預設」量的，彼此有重疊、對手也在變，加總只是量級，不是精確的累計。
 */
export function roleSummary(list: readonly AiMilestone[]): RoleSummaryRow[] {
  const sorted = sortMilestones(list);
  return ROLE_ORDER.map((role) => {
    const items = sorted.filter((m) => m.primary === role);
    let winSum = 0;
    let winCount = 0;
    let taskSum = 0;
    let taskCount = 0;
    for (const m of items) {
      const w = deltaMean(m.win);
      if (w !== null) { winSum += w; winCount++; }
      const t = deltaMean(m.task);
      if (t !== null) { taskSum += t; taskCount++; }
    }
    return {
      role,
      side: ROLE_SIDE[role],
      count: items.length,
      touched: sorted.filter((m) => m.roles.includes(role)).length,
      winSum,
      winCount,
      taskSum,
      taskCount,
      items,
    };
  }).filter((r) => r.count > 0 || r.touched > 0);
}

// ── 走勢圖 ───────────────────────────────────────────────────────────────────────────

export interface ChartPoint {
  x: number;
  yWin: number;
  yTask: number | null;
  p: AiSeriesPoint;
}

export interface ChartGeometry {
  points: ChartPoint[];
  winPath: string;
  /** 任務三藍只連「有數字」的相鄰點；中間缺的斷開（M 重新起筆）。 */
  taskPath: string;
  yOf: (pct: number) => number;
  ticks: number[];
}

/** 走勢圖座標：x 照回合順序等距，y 0–max%（預設 80%）。 */
export function chartGeometry(
  series: readonly AiSeriesPoint[],
  box: { width: number; height: number; left: number; right: number; top: number; bottom: number },
  maxPct = 80,
): ChartGeometry {
  const innerW = box.width - box.left - box.right;
  const innerH = box.height - box.top - box.bottom;
  const yOf = (pct: number): number => box.top + innerH * (1 - Math.max(0, Math.min(maxPct, pct)) / maxPct);
  const n = series.length;
  const points: ChartPoint[] = series.map((p, i) => ({
    x: box.left + (n <= 1 ? innerW / 2 : (innerW * i) / (n - 1)),
    yWin: yOf(p.win),
    yTask: p.task === null ? null : yOf(p.task),
    p,
  }));
  const r = (v: number): string => v.toFixed(1);
  const winPath = points.map((pt, i) => `${i === 0 ? 'M' : 'L'}${r(pt.x)},${r(pt.yWin)}`).join(' ');
  let taskPath = '';
  let prevHad = false;
  for (const pt of points) {
    if (pt.yTask === null) { prevHad = false; continue; }
    taskPath += `${taskPath ? ' ' : ''}${prevHad ? 'L' : 'M'}${r(pt.x)},${r(pt.yTask)}`;
    prevHad = true;
  }
  const ticks: number[] = [];
  for (let t = 0; t <= maxPct; t += 20) ticks.push(t);
  return { points, winPath, taskPath, yOf, ticks };
}

// ── 網址 ─────────────────────────────────────────────────────────────────────────────

/** #ai-history（也接受 #aihistory、#ai-progress）→ true。 */
export function isAiHistoryHash(hash: string | null | undefined): boolean {
  const raw = (hash ?? '').replace(/^#/, '').trim();
  return /^ai-?(history|progress)$/i.test(raw);
}

export const AI_HISTORY_HASH = '#ai-history';

// ── 真人對照（和數據分析同一個來源） ─────────────────────────────────────────────────

/**
 * 真人局的對照列：站長 2026-11-20「真人強者桌應該是用S 來看吧? 我說了要跟數據分析還有勝率統計那邊同步啊 整個系統要完全同步同來源」。
 * 輸入是數據分析「陣容強度」同一份報告的每局點（computeStrengthReport(games).points：網站的 /api/analysis/games 資料集、
 * 百科AI 局不算、有陣容強度 S 的局），分層和網站一樣：
 *   - 全部：有陣容強度的局（同「陣容強度 › 依 S 分層」的「全部」列）；
 *   - 高端桌：S ≥ 分組切點的上切點（數據分析「分組」的桌分層，預設 55 = 偏強＋高強度；跟著網站上調的切點）；
 *   - 高強度：S ≥ 65（S_TIERS）。
 */
export interface HumanRefRow {
  key: 'all' | 'high' | 'veryHigh';
  label: string;
  range: string;
  n: number;
  /** 任務三藍率 %（三藍死＋三藍活）。 */
  task: number | null;
  /** 藍方最終勝率（三藍活）%。 */
  win: number | null;
  /** 紅方勝率 %（三紅＋三藍死）。 */
  red: number | null;
  /** 刺中率 %（三藍的局裡梅林被刺中）。 */
  hit: number | null;
}

function refRow(key: HumanRefRow['key'], label: string, range: string, points: readonly Pick<StrengthPoint, 'outcome'>[]): HumanRefRow {
  let n = 0;
  let red3 = 0;
  let dead = 0;
  let alive = 0;
  for (const p of points) {
    if (p.outcome === OUTCOME_THREE_RED) red3++;
    else if (p.outcome === OUTCOME_BLUE_DEAD) dead++;
    else if (p.outcome === OUTCOME_BLUE_ALIVE) alive++;
    else continue;
    n++;
  }
  const r = (k: number, d: number): number | null => (d > 0 ? (100 * k) / d : null);
  return { key, label, range, n, task: r(dead + alive, n), win: r(alive, n), red: r(red3 + dead, n), hit: r(dead, dead + alive) };
}

export function humanReferenceRows(points: readonly Pick<StrengthPoint, 's' | 'outcome'>[], sHi: number = DEFAULT_COHORT_CUTS.sHi): HumanRefRow[] {
  const veryHigh = S_TIERS.find((t) => t.id === 'high')!;
  return [
    refRow('all', '真人局（全部）', '有陣容強度的局', points),
    refRow('high', `${TABLE_TIER_LABELS.high}桌`, `S ≥ ${sHi}`, points.filter((p) => p.s >= sHi)),
    refRow('veryHigh', veryHigh.label, veryHigh.range, points.filter((p) => p.s >= veryHigh.min)),
  ];
}
