/**
 * 資訊流研究的「骨架後驗」（2026-11-04；docs/ai/infl_research.md）。
 *
 * 和 `BayesBelief` 相同的骨架（Certainty 的 L1* 世界 × 派隊 × 任務牌 × 紅方湖宣告的格子），只把「讀票」換掉，
 * 讓對照乾淨：
 *   - `none`：不讀票（看票到底貢獻多少）；
 *   - `cells`：現行的票格（陣營 | 在隊上 | 隊上有紅 | 回合段；訓練折重新數）；
 *   - `policy`：以策略為本的票概似（`policyModel.ts`：j 的投票函數套在 j 當時的 INFL 上）。
 * 另附幾個從後驗讀數字的小工具（每人紅的機率、真相世界的機率、最乾淨的隊）。
 */
import type { PlayerObservation } from '../types';
import { buildCertainty } from '../belief/Certainty';
import { cellMissionProb, cellProposalProb, cellRedLakeProb, cellVoteProb, type CellTables } from './cellTables';
import { popcount } from './flow';
import type { PolicyVoteReader } from './policyModel';

export type VoteMode =
  | { kind: 'none' }
  | { kind: 'cells' }
  | { kind: 'policy'; reader: PolicyVoteReader };

export interface WorldPosterior {
  ids: readonly string[];
  worlds: readonly number[];
  wts: number[];
}

function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

const bitIn = (ids: readonly string[], id: string): number => {
  const k = ids.indexOf(id);
  return k < 0 ? 0 : 1 << k;
};

export function skeletonPosterior(obs: PlayerObservation, tables: CellTables, mode: VoteMode): WorldPosterior {
  const ids = obs.allPlayerIds;
  const me = obs.myPlayerId;
  const view = buildCertainty(obs);
  const worlds = view.worlds('L1*');
  const all = (1 << ids.length) - 1;
  const mask = (team: readonly string[]): number => team.reduce((m, id) => m | bitIn(ids, id), 0);
  const props = obs.voteHistory.map((v) => ({ v, team: mask(v.team), lb: bitIn(ids, v.leader), leaderOn: v.team.includes(v.leader) }));
  const quests = obs.questHistory.map((q) => ({ round: q.round, team: mask(q.team), fails: q.failCount ?? 0 }));
  const lakes = (obs.lakeHistory ?? []).filter((l) => l.declaredClaim !== 'none' && l.holderId !== me)
    .map((l) => ({ hb: bitIn(ids, l.holderId), tb: bitIn(ids, l.targetId), evil: l.declaredClaim === 'evil' }));
  const seesReds = obs.myRole === 'merlin' ? mask(obs.knownEvils) : null;
  const upTo = obs.voteHistory.length;
  const logW = worlds.map((w) => {
    let lp = 0;
    for (const p of props) {
      const { v } = p;
      if (v.leader !== me && p.leaderOn) {
        const others = all & ~p.lb;
        const redsAvail = popcount(w & others);
        const k = popcount(w & p.team & ~p.lb);
        const n = choose(redsAvail, k) * choose(popcount(others) - redsAvail, v.team.length - 1 - k);
        if (n > 0) lp += Math.log(cellProposalProb(tables, (w & p.lb) !== 0, v.round, k) / n);
      }
      if (mode.kind === 'cells' && v.attempt < 5) {
        const hasRed = (w & p.team) !== 0;
        for (const id of ids) {
          if (id === me) continue;
          const vote = v.votes[id];
          if (vote === undefined) continue;
          lp += Math.log(cellVoteProb(tables, (w & bitIn(ids, id)) !== 0, v.team.includes(id), hasRed, v.round, vote));
        }
      }
    }
    if (mode.kind === 'policy') lp += mode.reader.worldLog(me, upTo, w, seesReds);
    for (const q of quests) {
      const pm = cellMissionProb(tables, q.round, popcount(w & q.team), q.fails);
      lp += pm > 0 ? Math.log(pm) : -1e9;
    }
    for (const l of lakes) {
      if ((w & l.hb) === 0) continue;
      const pl = cellRedLakeProb(tables, (w & l.tb) !== 0);
      lp += Math.log(l.evil ? pl : 1 - pl);
    }
    return lp;
  });
  let wts: number[] = [];
  if (worlds.length > 0) {
    const mx = Math.max(...logW);
    const raw = logW.map((x) => Math.exp(x - mx));
    const tot = raw.reduce((a, b) => a + b, 0);
    wts = raw.map((x) => x / tot);
  }
  return { ids, worlds, wts };
}

/** 每個座位紅的機率（依 ids 的順序）。 */
export function sharesOf(post: WorldPosterior): number[] {
  const out = post.ids.map(() => 0);
  post.worlds.forEach((w, i) => { for (let k = 0; k < out.length; k++) if (w & (1 << k)) out[k] += post.wts[i]; });
  return out;
}

/** 這隊沒有紅的機率。 */
export function teamCleanOf(post: WorldPosterior, teamMask: number): number {
  let s = 0;
  post.worlds.forEach((w, i) => { if ((w & teamMask) === 0) s += post.wts[i]; });
  return s;
}

/** 自己＋（size − 1）人裡「沒有紅」機率最高的隊（同分取列舉順序的第一個，同 `GoodRound5.goodCleanLeadTeam`）。 */
export function bestTeamMask(cleanOf: (mask: number) => number, ids: readonly string[], me: string, size: number): { mask: number; p: number } {
  const meBit = bitIn(ids, me);
  const others = ids.map((_, k) => 1 << k).filter((b) => b !== meBit);
  let best = { mask: meBit, p: -1 };
  const pick = (start: number, acc: number, left: number): void => {
    if (left === 0) {
      const p = cleanOf(acc);
      if (p - best.p > 1e-12) best = { mask: acc, p };
      return;
    }
    for (let k = start; k <= others.length - left; k++) pick(k + 1, acc | others[k], left - 1);
  };
  pick(0, meBit, size - 1);
  return best;
}
