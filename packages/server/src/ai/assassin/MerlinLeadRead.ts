/**
 * 刺客從派票的「資訊超前」找梅林（優化迴圈第 6 回合・紅方候選，2026-10-29；`AgentTuning.assassinLeadRead`）。
 *
 * 百科〈刺殺梅林〉：「資訊過度超前者 ☆☆☆☆☆——有些地方是當下派不出來的；比大家快半步的是老手，比老手還快的是梅林」，
 * 派票特徵表「1-1 給出精準的壞人區間 → 高機率梅林」「多次修正其他人的區間錯誤」「後置位大幅修正前面派票」。
 *
 * 做法：候選人當隊長的每一次非強制提議，把觀測截到那次提議之前、站在「坐在他位置的忠臣」看，
 * p = 這隊沒有紅的機率（公開資訊下派出乾淨隊有多難）。刺客知道誰是紅：
 * - 隊上沒有梅林看得到的紅：P(這樣派 | 梅林) ≈ 1 − ε，P(這樣派 | 忠臣) ≈ p → 公開越難派出的乾淨隊，越像梅林；
 * - 隊上有梅林看得到的紅：P(| 梅林) = ε（第 1、2 局注定被否決的提議梅林可能派拇指躲刺，ε 放寬），P(| 忠臣) ≈ 1 − p。
 * 對數概似比加總、乘權重加到刺殺分數上（分數是對數機率；同 `MerlinVoteRead` 的接法）。
 * 誰是莫德雷德：有 `allEvilRoles` 就用，否則對每個紅方取平均。
 */
import type { PlayerObservation } from '../types';
import { bayesTeamClean, type BayesOptions } from '../belief/BayesBelief';

const EPS = 0.05;
const EPS_DOOMED = 0.5;
const P_FLOOR = 0.03;

/** The public view of a loyal sitting at `leader` just before proposal `index` was made. */
function loyalViewBefore(obs: PlayerObservation, index: number): PlayerObservation {
  const rec = obs.voteHistory[index];
  return {
    ...obs,
    myPlayerId: rec.leader,
    myRole: 'loyal',
    myTeam: 'good',
    knownEvils: [],
    knownWizards: undefined,
    allEvilIds: undefined,
    allEvilRoles: undefined,
    currentRound: rec.round,
    voteHistory: obs.voteHistory.slice(0, index),
    questHistory: obs.questHistory.filter((q) => q.round < rec.round),
    questResults: obs.questResults.slice(0, Math.max(0, rec.round - 1)),
    lakeHistory: (obs.lakeHistory ?? []).filter((l) => l.round < rec.round),
    myLakeResults: [],
  } as PlayerObservation;
}

/** Public P(clean) of every non-forced proposal `candidate` led, cached per observation (and table choice). */
const cleanCache = new WeakMap<PlayerObservation, Map<string, number>>();
function publicClean(obs: PlayerObservation, index: number, opts: Readonly<BayesOptions>): number {
  let m = cleanCache.get(obs);
  if (!m) { m = new Map(); cleanCache.set(obs, m); }
  const key = `${index}|${opts.botTables ?? 0}`;
  const hit = m.get(key);
  if (hit !== undefined) return hit;
  const p = bayesTeamClean(loyalViewBefore(obs, index), obs.voteHistory[index].team, opts) ?? 0.5;
  m.set(key, p);
  return p;
}

/**
 * log [ mean over Mordred d of P(proposals | Merlin) / P(proposals | loyal) ] for `candidate`. `opts`: the loyal model the public view is read with — the human tables by default; `assassinLeadReadBot` reads it the way
 * the bot blues actually do (`beliefBotTables`), the view Merlin's loyal-style proposals are built from.
 */
export function merlinLeadLogRatio(obs: PlayerObservation, candidate: string, reds: readonly string[], opts: Readonly<BayesOptions> = {}): number {
  const leads: number[] = [];
  obs.voteHistory.forEach((v, i) => { if (v.leader === candidate && v.attempt < 5) leads.push(i); });
  if (leads.length === 0 || reds.length === 0) return 0;
  const roles = obs.allEvilRoles;
  const known = roles ? reds.filter((id) => roles[id] === 'mordred') : [];
  const mordreds: (string | null)[] = roles ? (known.length > 0 ? known : [null]) : [...reds];
  let sum = 0;
  for (const d of mordreds) {
    let lr = 0;
    for (const i of leads) {
      const v = obs.voteHistory[i];
      const seenRed = v.team.some((id) => id !== d && reds.includes(id));
      const p = Math.min(Math.max(publicClean(obs, i, opts), P_FLOOR), 1 - P_FLOOR);
      const eps = v.round <= 2 ? EPS_DOOMED : EPS;
      lr += seenRed ? Math.log(eps / (1 - p)) : Math.log((1 - eps) / p);
    }
    sum += Math.exp(lr);
  }
  return Math.log(sum / mordreds.length);
}
