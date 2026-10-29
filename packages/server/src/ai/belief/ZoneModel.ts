/**
 * 區間派票法（社群百科〈視角與區間派票法〉、〈區間派票法之變體（點/夾/跳）〉；Edward 2026-10-29）：
 * 「透過派票把圓桌切成幾個區域，梅林看到的拇指落在這些區域」——梅林的隊上沒有他看得到的紅，隊員之間空出來的
 * 座位（區間）裝著拇指。1-1 直接切區間；1-2～1-4 延伸或修正前面的派票；2-x 再加上第一局的任務結果與共識。
 *
 * 模型：梅林在他看起來乾淨的人（藍方＋看不到的莫德雷德）裡挑隊員，區間裡有拇指的個數越多越好：
 *   P(隊伍 | 梅林, 看得到的紅) ∝ exp(β × 有拇指的區間數)，隊上有看得到的紅 → 幾乎不可能（ε 平分給所有隊伍）。
 * 同一個梅林的每一次派票都要符合同一組拇指，所以「延伸或修正」不用另外寫：前後矛盾的世界自然被壓下去。
 */

export const ZONE_BETA = 1.5;
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

/** The zone-cutting Merlin's team: the leader + the clean pick with the most red-holding zones (ties: first in order). */
export function bestZoneTeam(order: readonly string[], leader: string, size: number, seen: ReadonlySet<string>): string[] | null {
  const pool = order.filter((id) => id !== leader && !seen.has(id));
  if (pool.length < size - 1) return null;
  let best: string[] | null = null;
  let bestScore = -1;
  for (const fill of combos(pool, size - 1)) {
    const team = [leader, ...fill];
    const s = zoneScore(order, new Set(team), seen);
    if (s > bestScore) { bestScore = s; best = team; }
  }
  return best;
}

/** log P(team | leader is a zone-cutting Merlin who sees `seen`). */
export function zoneTeamLogProb(order: readonly string[], leader: string, team: readonly string[], seen: ReadonlySet<string>, beta = ZONE_BETA): number {
  const size = team.length;
  if (team.some((id) => id !== leader && seen.has(id))) return Math.log(ZONE_EPS / Math.max(1, choose(order.length - 1, size - 1)));
  const pool = order.filter((id) => id !== leader && !seen.has(id));
  let z = 0;
  for (const fill of combos(pool, size - 1)) z += Math.exp(beta * zoneScore(order, new Set([leader, ...fill]), seen));
  const s = zoneScore(order, new Set(team), seen);
  return z > 0 ? beta * s - Math.log(z) : Math.log(ZONE_EPS);
}
