/**
 * 局勢樹（Edward 2026-10-31：「或許你可以做個類似局勢走勢樹狀分支分類圖，再結合湖中女神的宣告，用這個角度去分析看看」；
 * 「局勢不只要看雙方陣營已經拿下的局數，順序也很重要：紅藍藍紅 跟 藍紅紅藍 是完全不同的意義…還要搭配上湖中跟宣告」；
 * 「第二局開藍後，下一位隊長幾乎會照派開藍的組合」）。
 *
 * 純函式（web 沒有測試執行器，在 server 的 WebStateTree.test.ts 測）：
 *   toStateGame(game)              統計 Worker 裡把一局縮成樹要的欄位（任務順序、三次湖、各回合的隊伍）
 *   buildStateTree(games, mode)    第 1→5 個任務一層一層分支；第 2、3、4 個任務後（局還沒分出勝負）插一層湖的宣告
 *   foldSmall(node, minN)          樣本太少的分支併成「其他」
 *   nodeClauses(path)              點一個節點 → 篩選子句（任務順序開頭 + 湖的宣告條件）
 *   stateTreeFindings(games)       「看得出什麼」：同比分不同順序、第二局後湖的宣告、照派
 */
import {
  OUTCOME_BLUE_ALIVE,
  OUTCOME_BLUE_DEAD,
  OUTCOME_THREE_RED,
  missionSequence,
  roleFactionName,
  type Clause,
  type Game,
  type LakeClause,
} from '@avalon/shared/stats';

import type { LakeKey, LakeMode, LakeObs } from './lakeKeys';
import { lakeKey, lakeKeyLabel } from './lakeKeys';

export { lakeKey, lakeKeyLabel } from './lakeKeys';
export type { LakeKey, LakeMode, LakeObs } from './lakeKeys';

export type Mark = '藍' | '紅';
export type StateOutcome = '三紅' | '三藍死' | '三藍活';

/** 一個回合的派隊：出任務的隊伍、第一個提案、提案次數。 */
export interface RoundTeams {
  team: string;
  first: string;
  tries: number;
}

/** 統計 Worker 回傳：篩選後列入樹的局，與因為不完整／不是 10 人標準隊伍而沒列入的局數。 */
export interface StateGamesResult {
  games: StateGame[];
  excluded: number;
}

/** 樹要的一局。 */
export interface StateGame {
  seq: string;
  outcome: StateOutcome;
  /** 第 1、2、3 次湖（第 2、3、4 個任務之後）；沒有持湖記錄 = null。 */
  lakes: Array<LakeObs | null>;
  /** 第 1..5 個任務的派隊（沒有提案記錄 = null）。 */
  teams: Array<RoundTeams | null>;
}

export interface OutcomeMix {
  三紅: number;
  三藍死: number;
  三藍活: number;
}

export interface Ratio {
  yes: number;
  of: number;
}

/** 下一個任務的派隊事實（這個節點之後還有任務才有）。 */
export interface NextRoundFacts {
  /** 下一個任務是第幾個。 */
  round: number;
  /** 下一位隊長第一個提案包含上一個出任務的隊伍（照派）；第 1 個任務沒有上一隊 = of 0。 */
  reuse: Ratio;
  /** 照派／不照派時下一個任務開藍。 */
  reuseBlue: Ratio;
  otherBlue: Ratio;
  /** 第一個提案就通過。 */
  firstPass: Ratio;
  /** 下一個任務開藍。 */
  nextBlue: Ratio;
  /** 下一個任務的提案次數合計（平均 = sum / of）。 */
  tries: { sum: number; of: number };
}

export interface PathStep {
  kind: 'mission' | 'lake';
  /** mission：'藍' / '紅'；lake：LakeKey。 */
  key: string;
  /** 湖的第幾次（1..3）。 */
  index?: 1 | 2 | 3;
}

export interface StateNode {
  id: string;
  kind: 'root' | 'mission' | 'lake' | 'other';
  label: string;
  /** 到這裡為止的任務順序。 */
  seq: string;
  /** 已經打完幾個任務。 */
  round: number;
  /** 樹的第幾層（根 = 0；湖也算一層）。 */
  depth: number;
  path: PathStep[];
  mode: LakeMode;
  n: number;
  outcomes: OutcomeMix;
  /** 已經分出勝負（3 紅 / 3 藍）。 */
  decided: '三紅' | '三藍' | null;
  next: NextRoundFacts | null;
  children: StateNode[];
  /** 「其他」：併進來的分支數。 */
  folded?: number;
}

const DATA_OUTCOMES: readonly string[] = [OUTCOME_THREE_RED, OUTCOME_BLUE_DEAD, OUTCOME_BLUE_ALIVE];

function side(role: string): 'B' | 'R' | '' {
  const f = role ? roleFactionName(role) : '';
  return f === '紅方' ? 'R' : f === '藍方' ? 'B' : '';
}

/** 各回合的派隊（votingProposals：[回合, 第幾次, 隊伍, 贊成座位]）。 */
function roundTeams(g: Pick<Game, 'votingProposals'>): Array<RoundTeams | null> {
  const out: Array<RoundTeams | null> = [null, null, null, null, null];
  const byRound = new Map<number, Array<[number, string]>>();
  for (const [round, attempt, team] of g.votingProposals) {
    if (round < 1 || round > 5 || !team) continue;
    const list = byRound.get(round) ?? [];
    list.push([attempt, team]);
    byRound.set(round, list);
  }
  for (const [round, list] of byRound) {
    list.sort((a, b) => a[0] - b[0]);
    out[round - 1] = { team: list[list.length - 1][1], first: list[0][1], tries: list.length };
  }
  return out;
}

/**
 * 解碼後的一局 → 樹要的欄位。不列入（回 null）：結果不是三紅／三藍死／三藍活、任務不是 10 人標準隊伍人數、
 * 任務順序沒打完或與結果對不上（三紅要 3 紅、三藍要 3 藍）。
 */
export function toStateGame(g: Game): StateGame | null {
  if (!DATA_OUTCOMES.includes(g.outcome)) return null;
  const seq = missionSequence(g);
  if (!seq) return null;
  const reds = [...seq].filter((c) => c === '紅').length;
  const blues = seq.length - reds;
  if (g.outcome === OUTCOME_THREE_RED ? reds !== 3 : blues !== 3) return null;
  const lakes = [0, 1, 2].map((i): LakeObs | null => {
    const lake = g.lakes[i];
    if (!lake) return null;
    const c = g.claims[i];
    const claim = c?.claim === '藍' ? 'o' : c?.claim === '紅' ? 'x' : '';
    return { claim, holder: side(lake.holderRole), target: side(lake.targetRole) };
  });
  return { seq, outcome: g.outcome as StateOutcome, lakes, teams: roundTeams(g) };
}

/** 湖分支的固定順序（說好在前）。 */
const LAKE_ORDER = ['o', 'o+', 'o!', 'Bo', 'Ro', 'x', 'x+', 'x!', 'Bx', 'Rx', '?', '-'];

function emptyOutcomes(): OutcomeMix {
  return { 三紅: 0, 三藍死: 0, 三藍活: 0 };
}

function add(r: Ratio, yes: boolean): void {
  r.of += 1;
  if (yes) r.yes += 1;
}

function containsTeam(proposal: string, team: string): boolean {
  return [...team].every((s) => proposal.includes(s));
}

/** 這些局下一個任務（第 round + 1 個）的派隊事實。 */
export function nextRoundFacts(games: StateGame[], round: number): NextRoundFacts | null {
  const facts: NextRoundFacts = {
    round: round + 1,
    reuse: { yes: 0, of: 0 }, reuseBlue: { yes: 0, of: 0 }, otherBlue: { yes: 0, of: 0 },
    firstPass: { yes: 0, of: 0 }, nextBlue: { yes: 0, of: 0 }, tries: { sum: 0, of: 0 },
  };
  let any = false;
  for (const g of games) {
    if (g.seq.length <= round) continue;
    any = true;
    const blue = g.seq[round] === '藍';
    add(facts.nextBlue, blue);
    const next = g.teams[round];
    if (!next) continue;
    add(facts.firstPass, next.tries === 1);
    facts.tries.sum += next.tries;
    facts.tries.of += 1;
    const prev = round > 0 ? g.teams[round - 1] : null;
    if (!prev) continue;
    const reused = containsTeam(next.first, prev.team);
    add(facts.reuse, reused);
    add(reused ? facts.reuseBlue : facts.otherBlue, blue);
  }
  return any ? facts : null;
}

function decidedOf(seq: string): '三紅' | '三藍' | null {
  const reds = [...seq].filter((c) => c === '紅').length;
  if (reds >= 3) return '三紅';
  if (seq.length - reds >= 3) return '三藍';
  return null;
}

function makeNode(
  games: StateGame[], kind: StateNode['kind'], label: string, seq: string, depth: number, path: PathStep[], mode: LakeMode,
): StateNode {
  const outcomes = emptyOutcomes();
  for (const g of games) outcomes[g.outcome] += 1;
  const decided = decidedOf(seq);
  return {
    id: path.length ? path.map((p) => (p.kind === 'lake' ? `~${p.key}` : p.key)).join('') : 'root',
    kind, label, seq, round: seq.length, depth, path, mode, n: games.length, outcomes, decided,
    next: decided ? null : nextRoundFacts(games, seq.length),
    children: [],
  };
}

function grow(node: StateNode, games: StateGame[]): void {
  if (node.decided) return;
  const round = node.round;
  const lakeIndex = round - 1; // 第 2 個任務後 = 第 1 次湖
  const needLake = node.mode !== 'none' && node.kind === 'mission' && round >= 2 && round <= 4;
  if (needLake) {
    const groups = new Map<LakeKey, StateGame[]>();
    for (const g of games) {
      const k = lakeKey(g.lakes[lakeIndex - 1], node.mode);
      const list = groups.get(k) ?? [];
      list.push(g);
      groups.set(k, list);
    }
    const keys = [...groups.keys()].sort((a, b) => LAKE_ORDER.indexOf(a) - LAKE_ORDER.indexOf(b));
    for (const k of keys) {
      const list = groups.get(k) as StateGame[];
      const step: PathStep = { kind: 'lake', key: k, index: lakeIndex as 1 | 2 | 3 };
      const child = makeNode(list, 'lake', `湖${lakeIndex} ${lakeKeyLabel(k)}`, node.seq, node.depth + 1, [...node.path, step], node.mode);
      node.children.push(child);
      grow(child, list);
    }
    return;
  }
  for (const mark of ['藍', '紅'] as const) {
    const list = games.filter((g) => g.seq[round] === mark);
    if (!list.length) continue;
    const seq = node.seq + mark;
    const child = makeNode(list, 'mission', seq, seq, node.depth + 1, [...node.path, { kind: 'mission', key: mark }], node.mode);
    node.children.push(child);
    grow(child, list);
  }
}

/** 篩選後的局 → 樹要的局（統計 Worker 裡呼叫）。 */
export function toStateGames(games: Game[]): StateGamesResult {
  const out: StateGame[] = [];
  for (const g of games) {
    const s = toStateGame(g);
    if (s) out.push(s);
  }
  return { games: out, excluded: games.length - out.length };
}

/** 整棵樹（根 = 全部局）。 */
export function buildStateTree(games: StateGame[], mode: LakeMode): StateNode {
  const root = makeNode(games, 'root', '全部', '', 0, [], mode);
  grow(root, games);
  return root;
}

function mergeOutcomes(nodes: StateNode[]): OutcomeMix {
  const out = emptyOutcomes();
  for (const n of nodes) {
    out.三紅 += n.outcomes.三紅;
    out.三藍死 += n.outcomes.三藍死;
    out.三藍活 += n.outcomes.三藍活;
  }
  return out;
}

/** 少於 minN 局的分支併成一個「其他」（不再往下長）；只有一個小分支時也叫其他，數字照算。 */
export function foldSmall(node: StateNode, minN: number): StateNode {
  const big = node.children.filter((c) => c.n >= minN).map((c) => foldSmall(c, minN));
  const small = node.children.filter((c) => c.n < minN);
  const children = [...big];
  if (small.length) {
    const outcomes = mergeOutcomes(small);
    children.push({
      id: `${node.id}|other`, kind: 'other', label: '其他', seq: node.seq, round: node.round, depth: node.depth + 1,
      path: node.path, mode: node.mode, n: small.reduce((s, c) => s + c.n, 0), outcomes, decided: null, next: null,
      children: [], folded: small.length,
    });
  }
  return { ...node, children };
}

/** 結果比率（0–1；沒有局 = null）。 */
export function outcomeRate(o: OutcomeMix, key: StateOutcome): number | null {
  const n = o.三紅 + o.三藍死 + o.三藍活;
  return n ? o[key] / n : null;
}

/** 三藍局的刺中率（三藍死 / 三藍）。 */
export function hitRate(o: OutcomeMix): number | null {
  const n = o.三藍死 + o.三藍活;
  return n ? o.三藍死 / n : null;
}

/** 節點 → 篩選子句：任務順序開頭（有任務才加）+ 路徑上每一次湖的條件。「其他」沒有子句（null）。 */
export function nodeClauses(node: Pick<StateNode, 'kind' | 'seq' | 'path'>): Clause[] | null {
  if (node.kind === 'other') return null;
  const out: Clause[] = [];
  if (node.seq) out.push({ kind: 'missionSeq', prefix: node.seq });
  for (const step of node.path) {
    if (step.kind !== 'lake' || !step.index) continue;
    const c = lakeClause(step.key, step.index);
    if (c === null) return null;
    out.push(c);
  }
  return out;
}

function lakeClause(key: LakeKey, index: 1 | 2 | 3): LakeClause | null {
  if (key === '?') return null;
  if (key === '-') return { kind: 'lake', index, claim: ['red', 'blue'], not: true };
  const said = (c: string): 'red' | 'blue' => (c === 'o' ? 'blue' : 'red');
  if (key.length === 1) return { kind: 'lake', index, claim: [said(key)] };
  if (key[0] === 'B' || key[0] === 'R') return { kind: 'lake', index, holderSide: key[0] === 'B' ? 'blue' : 'red', claim: [said(key[1])] };
  const claim = said(key[0]);
  const truthful = key[1] === '+';
  const target = truthful ? claim : claim === 'blue' ? 'red' : 'blue';
  return { kind: 'lake', index, targetSide: target, claim: [claim] };
}

/** 套用節點：拿掉原本的任務順序條件與同一次湖的條件，再接上這個節點的子句。 */
export function mergeNodeClauses(existing: Clause[], node: Pick<StateNode, 'kind' | 'seq' | 'path'>): Clause[] | null {
  const add = nodeClauses(node);
  if (add === null) return null;
  const lakeIdx = new Set(add.filter((c): c is LakeClause => c.kind === 'lake').map((c) => c.index));
  const keep = existing.filter((c) => c.kind !== 'missionSeq' && !(c.kind === 'lake' && lakeIdx.has(c.index)));
  return [...keep, ...add];
}

// ── 看得出什麼 ──

export interface SeqStat {
  seq: string;
  n: number;
  blueWin: number | null;
  threeRed: number | null;
}

export interface SameCountContrast {
  /** 藍:紅 比分（例：2:2）。 */
  score: string;
  high: SeqStat;
  low: SeqStat;
  /** 藍方最終勝率差（0–1）。 */
  gap: number;
}

export interface LakeShift {
  seq: string;
  good: SeqStat;
  bad: SeqStat;
  gap: number;
  /** 這個前兩局之後說壞的比例（說好 + 說壞為分母）。 */
  badShare: number;
}

export interface StateTreeFindings {
  total: number;
  baseline: { blueWin: number | null; threeRed: number | null };
  contrasts: SameCountContrast[];
  /** pooled = 全部合併；withinGap = 同一個前兩局裡的差距（各順序依局數加權平均）。 */
  lakeAfterR2: { pooled: { good: SeqStat; bad: SeqStat } | null; bySeq: LakeShift[]; withinGap: number | null };
  reuseAfterR2Blue: NextRoundFacts | null;
}

function stat(seq: string, games: StateGame[]): SeqStat {
  const o = emptyOutcomes();
  for (const g of games) o[g.outcome] += 1;
  return { seq, n: games.length, blueWin: outcomeRate(o, '三藍活'), threeRed: outcomeRate(o, '三紅') };
}

/** 長度 len 的所有還沒分出勝負的順序。 */
function openSequences(len: number): string[] {
  let level = [''];
  for (let i = 0; i < len; i += 1) level = level.flatMap((p) => (decidedOf(p) ? [] : [`${p}藍`, `${p}紅`]));
  return level.filter((s) => !decidedOf(s));
}

/**
 * 「看得出什麼」：
 *  - contrasts：第 2–4 個任務後同樣比分（例：2:2）的不同順序，藍方最終勝率（三藍活）差最多的一對（各比分一條，兩邊都要 minN 局）
 *  - lakeAfterR2：第 2 個任務後第 1 次湖說好 vs 說壞的結果（全部合併與各順序）
 *  - reuseAfterR2Blue：第 2 個任務開藍後，第 3 個任務照派的比例與照派／不照派的開藍率
 */
export function stateTreeFindings(games: StateGame[], minN = 15): StateTreeFindings {
  const all = stat('', games);
  const contrasts: SameCountContrast[] = [];
  for (let len = 2; len <= 4; len += 1) {
    const byScore = new Map<string, SeqStat[]>();
    for (const seq of openSequences(len)) {
      const s = stat(seq, games.filter((g) => g.seq.startsWith(seq)));
      if (s.n < minN) continue;
      const blues = [...seq].filter((c) => c === '藍').length;
      const score = `${blues}:${len - blues}`;
      byScore.set(score, [...(byScore.get(score) ?? []), s]);
    }
    for (const [score, list] of byScore) {
      if (list.length < 2) continue;
      const sorted = [...list].sort((a, b) => (b.blueWin ?? 0) - (a.blueWin ?? 0));
      const high = sorted[0];
      const low = sorted[sorted.length - 1];
      contrasts.push({ score, high, low, gap: (high.blueWin ?? 0) - (low.blueWin ?? 0) });
    }
  }
  contrasts.sort((a, b) => b.gap - a.gap);

  const claimOf = (g: StateGame): string => lakeKey(g.lakes[0], 'claim');
  const r2 = games.filter((g) => g.seq.length >= 3);
  const good = stat('', r2.filter((g) => claimOf(g) === 'o'));
  const bad = stat('', r2.filter((g) => claimOf(g) === 'x'));
  const bySeq: LakeShift[] = [];
  for (const seq of openSequences(2)) {
    const here = r2.filter((g) => g.seq.startsWith(seq));
    const gs = stat(seq, here.filter((g) => claimOf(g) === 'o'));
    const bs = stat(seq, here.filter((g) => claimOf(g) === 'x'));
    if (gs.n < minN || bs.n < minN) continue;
    bySeq.push({ seq, good: gs, bad: bs, gap: (gs.blueWin ?? 0) - (bs.blueWin ?? 0), badShare: bs.n / (gs.n + bs.n) });
  }
  bySeq.sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));
  const weight = bySeq.reduce((s, x) => s + x.good.n + x.bad.n, 0);
  const withinGap = weight ? bySeq.reduce((s, x) => s + x.gap * (x.good.n + x.bad.n), 0) / weight : null;

  const afterR2Blue = games.filter((g) => g.seq[1] === '藍');
  return {
    total: games.length,
    baseline: { blueWin: all.blueWin, threeRed: all.threeRed },
    contrasts,
    lakeAfterR2: { pooled: good.n >= minN && bad.n >= minN ? { good, bad } : null, bySeq, withinGap },
    reuseAfterR2Blue: afterR2Blue.length ? nextRoundFacts(afterR2Blue, 2) : null,
  };
}

/** 預設展開：打完不到 maxRound 個任務的節點，以及第 maxRound 個任務後面那一層湖（湖之後的任務收合）。 */
export function defaultExpanded(root: StateNode, maxRound: number): Set<string> {
  const out = new Set<string>();
  const walk = (n: StateNode): void => {
    if (!n.children.length) return;
    const lakeNext = n.kind === 'mission' && n.round === maxRound && n.children.some((c) => c.kind === 'lake');
    if (n.round >= maxRound && !lakeNext) return;
    out.add(n.id);
    n.children.forEach(walk);
  };
  walk(root);
  return out;
}

// ── 顏色 ──

/** 節點顏色看哪個比率：藍方最終勝率（三藍活）或三紅率。 */
export type ColorMetric = 'blueWin' | 'threeRed';

const POLE_BLUE = [37, 99, 235];
const POLE_RED = [220, 38, 38];
const MIDPOINT = [82, 82, 91];
export const NO_DATA_COLOR = '#3f3f46';

function hex(rgb: number[]): string {
  return `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * 發散色階：中點（灰）= 全體的比率 mid，往藍方有利的方向偏藍、往紅方有利的方向偏紅（三紅率高 = 紅）。
 * 偏離量依中點到 0／1 的距離正規化，再取 0.7 次方讓小差距也看得出來。
 */
export function divergingColor(rate: number | null, mid: number | null, metric: ColorMetric): string {
  if (rate === null || mid === null) return NO_DATA_COLOR;
  const span = rate >= mid ? 1 - mid : mid;
  const t = span > 0 ? Math.min(1, Math.abs(rate - mid) / span) ** 0.7 : 0;
  const towardBlue = metric === 'blueWin' ? rate >= mid : rate < mid;
  const pole = towardBlue ? POLE_BLUE : POLE_RED;
  return hex(MIDPOINT.map((m, i) => m + (pole[i] - m) * t));
}

/** 節點的著色比率（0–1）。 */
export function metricRate(o: OutcomeMix, metric: ColorMetric): number | null {
  return outcomeRate(o, metric === 'blueWin' ? '三藍活' : '三紅');
}
