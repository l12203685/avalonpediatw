/**
 * 區間派票法（社群百科〈視角與區間派票法〉、〈區間派票法之變體（點/夾/跳）〉；Edward 2026-10-29）：
 * 「透過派票把圓桌切成幾個區域，梅林看到的拇指落在這些區域」——梅林的隊上沒有他看得到的紅，隊員之間空出來的
 * 座位（區間）裝著拇指。1-1 直接切區間；1-2～1-4 延伸或修正前面的派票；2-x 再加上第一局的任務結果與共識。
 *
 * 〈延伸與修正〉（Edward 2026-10-29 更正：延伸／修正是針對「前面其他玩家派出的隊伍組合」）：
 *   - 延伸：A 派 ABC、B 梅林派 BCD——延伸 A 的派票，通常認為 A 好（A 的組合在梅林眼中乾淨，就把那些人帶進來）；
 *   - 修正：A 派 ABC、B 梅林派 BDE——修正 A 的派票，通常認為 A 或 C 至少一壞（帶 A 組合裡乾淨的人、跳過有拇指的）；
 *   - 前面全派錯時：把前方派票者排 G > N > B，把 G 帶進來，用派票說 B 和他的組合很壞（〈梅林資訊與雜魚視角的同步〉）。
 *   2-x 一樣，前面的派票包含第一局出任務的隊伍。
 *
 * 模型：梅林在他看起來乾淨的人（藍方＋看不到的莫德雷德）裡挑隊員（隊上有看得到的紅 → 幾乎不可能，ε 平分給所有隊伍），
 *   P(隊伍 | 梅林, 看得到的紅, 前面的派票) ∝ exp(β_區間 × 有拇指的區間數 + β_延伸 × 延伸的人數 + β_修正 × 修正的人數)；
 *   延伸的人 = 隊員裡出現在「前面一個在梅林眼中乾淨（隊長＋隊員都沒有拇指）的組合」裡的人；
 *   修正的人 = 隊員裡出現在「前面一個有拇指的組合」裡、本身沒有拇指的人（帶乾淨的、跳過有拇指的）。
 *   1-1 沒有前面的派票，只剩切區間。
 */

export const ZONE_BETA = 1.2;
export const EXTEND_BETA = 1.5;
export const CORRECT_BETA = 1.0;

/** An earlier proposal on the table (leader + team), for 延伸／修正. */
export interface PriorProposal { leader: string; team: readonly string[] }
const ZONE_EPS = 0.03;

/** The empty runs of seats between consecutive team members around the table (seat order = `order`). */
export function zoneGaps(order: readonly string[], team: ReadonlySet<string>): string[][] {
  const n = order.length;
  const first = order.findIndex((id) => team.has(id));
  if (first < 0) return [order.slice()];
  const gaps: string[][] = [];
  let run: string[] = [];
  for (let k = 1; k <= n; k++) {
    const id = order[(first + k) % n];
    if (team.has(id)) { if (run.length) gaps.push(run); run = []; } else run.push(id);
  }
  return gaps;
}

/** How many zones hold at least one seen red. */
export function zoneScore(order: readonly string[], team: ReadonlySet<string>, seen: ReadonlySet<string>): number {
  return zoneGaps(order, team).filter((g) => g.some((id) => seen.has(id))).length;
}

/** 延伸 / 修正 counts of a team against the earlier proposals, from a Merlin who sees `seen`. */
export function extendCorrectCounts(team: readonly string[], seen: ReadonlySet<string>, prior: readonly PriorProposal[]): { extend: number; correct: number } {
  const extendSet = new Set<string>();
  const correctSet = new Set<string>();
  for (const p of prior) {
    const members = [p.leader, ...p.team.filter((id) => id !== p.leader)];
    const dirty = members.some((id) => seen.has(id));
    for (const id of members) {
      if (seen.has(id)) continue;
      (dirty ? correctSet : extendSet).add(id);
    }
  }
  let extend = 0;
  let correct = 0;
  for (const id of team) {
    if (extendSet.has(id)) extend++;
    else if (correctSet.has(id)) correct++;
  }
  return { extend, correct };
}

/** The signal score the zone-cutting, extending / correcting Merlin maximizes. */
export function merlinSignalScore(order: readonly string[], team: readonly string[], seen: ReadonlySet<string>, prior: readonly PriorProposal[], leader: string): number {
  const others = team.filter((id) => id !== leader);
  const { extend, correct } = extendCorrectCounts(others, seen, prior);
  return ZONE_BETA * zoneScore(order, new Set(team), seen) + EXTEND_BETA * extend + CORRECT_BETA * correct;
}

function combos(items: readonly string[], k: number): string[][] {
  const out: string[][] = [];
  const pick = (start: number, acc: string[]): void => {
    if (acc.length === k) { out.push([...acc]); return; }
    for (let i = start; i <= items.length - (k - acc.length); i++) { acc.push(items[i]); pick(i + 1, acc); acc.pop(); }
  };
  pick(0, []);
  return out;
}

function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

/** Merlin's team: the leader + the clean pick with the best signal score (ties: first in order). */
export function bestZoneTeam(order: readonly string[], leader: string, size: number, seen: ReadonlySet<string>, prior: readonly PriorProposal[] = []): string[] | null {
  const pool = order.filter((id) => id !== leader && !seen.has(id));
  if (pool.length < size - 1) return null;
  let best: string[] | null = null;
  let bestScore = -Infinity;
  for (const fill of combos(pool, size - 1)) {
    const team = [leader, ...fill];
    const s = merlinSignalScore(order, team, seen, prior, leader);
    if (s > bestScore) { bestScore = s; best = team; }
  }
  return best;
}

/** log P(team | leader is a zone-cutting, extending / correcting Merlin who sees `seen`, after `prior`). */
export function zoneTeamLogProb(order: readonly string[], leader: string, team: readonly string[], seen: ReadonlySet<string>, prior: readonly PriorProposal[] = []): number {
  const size = team.length;
  if (team.some((id) => id !== leader && seen.has(id))) return Math.log(ZONE_EPS / Math.max(1, choose(order.length - 1, size - 1)));
  const pool = order.filter((id) => id !== leader && !seen.has(id));
  let z = 0;
  for (const fill of combos(pool, size - 1)) z += Math.exp(merlinSignalScore(order, [leader, ...fill], seen, prior, leader));
  const s = merlinSignalScore(order, team, seen, prior, leader);
  return z > 0 ? s - Math.log(z) : Math.log(ZONE_EPS);
}
