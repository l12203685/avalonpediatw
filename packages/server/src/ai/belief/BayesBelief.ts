/**
 * 貝氏信念（優化迴圈第 1 回合・第三階段信念引擎，2026-10-28）。
 *
 * 從確定性層的世界（L1*：規則、約定、自己的視野與湖結果）出發，每個世界乘上「在這個身分分配下，大家先前的動作會
 * 這樣發生」的機率，正規化後得到每個人是紅的後驗機率。機率表（`likelihoods.json`）是真人牌譜的彙總統計
 * （`scripts/fitBeliefLikelihoods.ts`）：
 *   - 黑白球：P(贊成 | 投票者陣營, 在不在隊上, 隊上有沒有紅, 回合段)；強制提議不算（沒有投票）；
 *   - 派隊：P(隊上有 k 個紅 | 隊長陣營, 回合段) ÷ 那個世界裡「隊長加 k 紅」的隊伍數（隊長在自己隊上的提議）；
 *   - 任務：P(失敗牌張數 | 回合, 隊上紅數)——紅方會出成功牌藏身，成功的任務也有資訊；
 *   - 湖：紅方持湖者的宣告 P(宣告 | 目標陣營)；好人持湖者說實話已經在 L1 的世界裡。
 * 自己的動作不算（自己知道自己為什麼這樣做）。每個動作用的是那個世界裡當時的身分，事件依時間逐一累加（資訊流）。
 */
import type { PlayerObservation } from '../types';
import { buildCertainty } from './Certainty';
import TABLE from './likelihoods.json';

interface Table {
  vote: Record<string, [number, number]>;
  proposal: Record<string, number>;
  voteRole: Record<string, [number, number]>;
  proposalRole: Record<string, number>;
  mission: Record<string, number[]>;
  redLake: Record<string, [number, number]>;
}
const T = TABLE as unknown as Table;

const bucket = (round: number): string => (round <= 2 ? 'r12' : 'r3');
const smooth = (hit: number, n: number): number => (hit + 1) / (n + 2);

/** `camp` = 'good' | 'evil', or a role key 'merlin' | 'morgana' (the role tables, Percival's thumbs). */
function voteProb(camp: string, on: boolean, hasRed: boolean, round: number, approve: boolean): number {
  const key = `${camp}|${on ? 'on' : 'off'}|${hasRed ? 'red' : 'clean'}|${bucket(round)}`;
  const c = (camp === 'merlin' || camp === 'morgana' ? T.voteRole[key] : T.vote[key]) ?? [1, 2];
  const p = smooth(c[0], c[1]);
  return approve ? p : 1 - p;
}

function proposalProb(camp: string, round: number, k: number): number {
  const tab = camp === 'merlin' || camp === 'morgana' ? T.proposalRole : T.proposal;
  let total = 0;
  for (let j = 0; j <= 5; j++) total += (tab[`${camp}|${bucket(round)}|${j}`] ?? 0) + 1;
  return ((tab[`${camp}|${bucket(round)}|${k}`] ?? 0) + 1) / total;
}

function missionProb(round: number, reds: number, fails: number): number {
  if (fails > reds) return 0;
  const d = T.mission[`${round}|${reds}`];
  if (!d) return fails === reds ? 0.9 : 0.1;
  const n = d.slice(0, reds + 1).reduce((a, b) => a + b + 1, 0);
  return ((d[fails] ?? 0) + 1) / n;
}

function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

const cache = new WeakMap<PlayerObservation, Map<string, number>>();
const cacheThumbs = new WeakMap<PlayerObservation, Map<string, number>>();

export interface BayesOptions {
  /**
   * `bayesThumbRoles` (optimization loop round 3): for Percival, in every world the good thumb is Merlin and
   * the red one Morgana — their actions are read with the role tables (`voteRole`, `proposalRole`), so the
   * posterior tells the thumbs apart.
   */
  thumbRoles?: boolean;
}

/** Posterior P(red) of every seat (the viewer included: 0 or 1). Uniform over L1* when nothing else is known. */
export function bayesRedShare(obs: PlayerObservation, opts: Readonly<BayesOptions> = {}): Map<string, number> {
  const thumbs = opts.thumbRoles && obs.myRole === 'percival' && (obs.knownWizards ?? []).length === 2 ? obs.knownWizards ?? [] : [];
  const store = thumbs.length > 0 ? cacheThumbs : cache;
  const hit = store.get(obs);
  if (hit) return hit;
  const view = buildCertainty(obs);
  const worlds = view.worlds('L1*');
  const ids = obs.allPlayerIds;
  const bit = (id: string): number => view.bitOf(id);
  const me = obs.myPlayerId;
  const sizeOf = (x: number): number => { let c = 0; while (x) { x &= x - 1; c++; } return c; };
  const all = view.maskOf(ids);
  const logW = worlds.map((w) => {
    const red = (id: string): boolean => (w & bit(id)) !== 0;
    // Percival's thumbs: the good one is Merlin, the red one Morgana (in this world).
    const campOf = (id: string): string => (thumbs.includes(id) ? (red(id) ? 'morgana' : 'merlin') : red(id) ? 'evil' : 'good');
    let lp = 0;
    for (const v of obs.voteHistory) {
      const teamMask = view.maskOf(v.team);
      const hasRed = (w & teamMask) !== 0;
      // Proposal (the leader on its own team; not the viewer's own).
      if (v.leader !== me && v.team.includes(v.leader)) {
        const camp = campOf(v.leader);
        const others = all & ~bit(v.leader);
        const redsAvail = sizeOf(w & others);
        const goodsAvail = sizeOf(others) - redsAvail;
        const k = sizeOf(w & teamMask & ~bit(v.leader));
        const n = choose(redsAvail, k) * choose(goodsAvail, v.team.length - 1 - k);
        if (n > 0) lp += Math.log(proposalProb(camp, v.round, k) / n);
      }
      // Votes (no vote on the forced fifth proposal).
      if (v.attempt >= 5) continue;
      for (const id of ids) {
        if (id === me || v.votes[id] === undefined) continue;
        lp += Math.log(voteProb(campOf(id), v.team.includes(id), hasRed, v.round, v.votes[id]));
      }
    }
    for (const q of obs.questHistory) {
      const p = missionProb(q.round, sizeOf(w & view.maskOf(q.team)), q.failCount ?? 0);
      lp += p > 0 ? Math.log(p) : -1e9;
    }
    for (const l of obs.lakeHistory ?? []) {
      if (l.declaredClaim === 'none' || l.holderId === me || !red(l.holderId)) continue;
      const c = T.redLake[red(l.targetId) ? 'evil' : 'good'] ?? [1, 2];
      const p = smooth(c[0], c[1]);
      lp += Math.log(l.declaredClaim === 'evil' ? p : 1 - p);
    }
    return lp;
  });
  const out = new Map<string, number>();
  if (worlds.length === 0) {
    for (const id of ids) out.set(id, id === me ? (obs.myTeam === 'evil' ? 1 : 0) : 0.5);
    store.set(obs, out);
    return out;
  }
  const max = Math.max(...logW);
  const wts = logW.map((x) => Math.exp(x - max));
  const tot = wts.reduce((a, b) => a + b, 0);
  for (const id of ids) {
    const b = bit(id);
    let s = 0;
    worlds.forEach((w, i) => { if (w & b) s += wts[i]; });
    out.set(id, s / tot);
  }
  store.set(obs, out);
  return out;
}
