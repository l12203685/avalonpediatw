/**
 * 第 63 回合（藍方；Gemini 第二意見 G1，`docs/ai/gemini_strategy_review.md` 問題二、`docs/ai/optimization_loop.md` 第 5 節）。
 *
 * `innerBlackEvGate63`（G1 `innerBlackEvGate`）：忠臣／派西第 3 局起、非強制、自己在隊上、不是隊長時，內黑要看「否決之後換得到什麼」，
 * 不只看眼前這隊和一個固定門檻比：
 *   - p_now = P(這隊過關)（觀察者的後驗；過關 = 隊上的紅少於這一局要的失敗張數，第 4 局照字面）；
 *   - p_alt = 否決之後的期望過關率：尾家（強制局的隊長）是自己 → 自己能派的最好的隊；是別人 → max_{T ∋ 尾家} P(尾家藍 且 T 過關) ＋ 0.08 × P(尾家紅)
 *     （提案的寫法：紅方尾家幾乎一定放夠的紅，0.08 是提案的值）。做法位元 2：取之後每一任隊長（到尾家為止）的最大值；
 *   - p_alt − p_now > 邊際 才內黑。邊際 = 開關值 × 提案的表：紅方已兩勝而且不是第 4 局 0.05、第 4 局 0.18、藍方已兩勝 0.22、其他 0.15。
 * 做法位元 1：只在原本的門檻也要內黑時才看（只會把內黑改成贊成）；0 = 照提案取代門檻那一步（預設贊成，只有期望差夠大才內黑）。
 * 只換門檻那一步：公開邏輯證明會失敗（provFail）、派西拇指、第 4 局留下第 3 局成功的隊、`goodOnTeamState` 照舊；梅林（公開視角）照原本（第 59 回合：梅林一起改是負的）。
 */
import { AVALON_CONFIG } from '@avalon/shared';
import type { PlayerObservation } from './types';
import type { AgentTuning } from './AgentTuning';
import { bayesRedShare, bayesTeamRedsBelow, bayesWorlds, type BayesOptions } from './belief/BayesBelief';
import { leaderAhead, tailLeaderOf } from './GoodVoteAlt';

/** 紅方尾家派的隊過關的機率（提案的值）。 */
export const RED_TAIL_PASS_63 = 0.08;

/** 提案的邊際表（開關值 = 1 時）。 */
export function evGateMargin63(obs: PlayerObservation): number {
  const round = obs.currentRound ?? 1;
  const res = obs.questResults ?? [];
  const reds = res.filter((r) => r === 'fail').length;
  const blues = res.filter((r) => r === 'success').length;
  if (reds >= 2 && round !== 4) return 0.05;
  if (round === 4) return 0.18;
  if (blues >= 2) return 0.22;
  return 0.15;
}

function failsRequired(obs: PlayerObservation): number {
  const round = obs.currentRound ?? 1;
  return AVALON_CONFIG[obs.playerCount ?? obs.allPlayerIds.length]?.questFailsRequired?.[round - 1] ?? 1;
}

/**
 * max_{T ∋ leader, |T| = k} P(leader 藍 且 T 上的紅 < req)（觀察者的後驗）。req = 1 時就是 `bestCleanWith`（含 leader 的隊乾淨 ⇒ leader 藍）。
 * 全部列舉（10 人局最多 C(9, 4) = 126 隊）。
 */
export function bestPassWith63(obs: PlayerObservation, leader: string, k: number, req: number, opts: Readonly<BayesOptions>): number | null {
  const ids = obs.allPlayerIds;
  if (k <= 0 || k > ids.length || !ids.includes(leader)) return null;
  const { worlds, wts, bitOf } = bayesWorlds(obs, opts);
  if (worlds.length === 0) return null;
  const lb = bitOf(leader);
  const others = ids.filter((id) => id !== leader).map(bitOf);
  const pop = (x: number): number => { let c = 0; while (x) { x &= x - 1; c++; } return c; };
  let best = 0;
  const rec = (start: number, left: number, mask: number): void => {
    if (left === 0) {
      let s = 0;
      for (let i = 0; i < worlds.length; i++) { const w = worlds[i]; if ((w & lb) === 0 && pop(w & mask) < req) s += wts[i]; }
      if (s > best) best = s;
      return;
    }
    for (let i = start; i <= others.length - left; i++) rec(i + 1, left - 1, mask | others[i]);
  };
  rec(0, k - 1, lb);
  return best;
}

/** 否決之後換到的期望過關率（`leader` 派隊）：bestPassWith ＋ 0.08 × P(leader 紅)；leader 是自己就是自己能派的最好的隊。 */
function altPass63(obs: PlayerObservation, leader: string, k: number, req: number, opts: Readonly<BayesOptions>): number | null {
  const best = bestPassWith63(obs, leader, k, req, opts);
  if (best === null) return null;
  if (leader === obs.myPlayerId) return best;
  const pRed = bayesRedShare(obs, opts).get(leader) ?? 0.5;
  return best + RED_TAIL_PASS_63 * pRed;
}

export interface EvGate63 {
  /** true = 內黑（期望差 > 邊際）。 */
  reject: boolean;
  pNow: number;
  pAlt: number;
  margin: number;
}

/**
 * `innerBlackEvGate63` 在這一票的判斷；開關關、不適用（梅林的公開視角、強制局、不在隊上、自己是隊長）或後驗是空的 → null。
 * 呼叫端（`BlueRound33.bayesVoteCriteria` 在隊上那一段）已經檢查過：忠臣／派西、第 3 局起、非強制、不是隊長、自己在隊上。
 */
export function evGate63(tuning: Readonly<AgentTuning>, obs: PlayerObservation, team: readonly string[], opts: Readonly<BayesOptions>): EvGate63 | null {
  const scale = tuning.innerBlackEvGate63 ?? 0;
  if (!(scale > 0) || obs.publicLoyalView === true) return null;
  const fc = obs.failCount ?? 0;
  if (fc >= 4 || !team.includes(obs.myPlayerId) || obs.currentLeader === obs.myPlayerId) return null;
  const req = failsRequired(obs);
  const pNow = bayesTeamRedsBelow(obs, team, req, opts);
  if (pNow === null) return null;
  const mode = tuning.innerBlackEvGate63Mode ?? 0;
  let pAlt: number | null = null;
  if ((mode & 2) !== 0) {
    for (let o = 1; o <= 4 - fc; o++) {
      const L = leaderAhead(obs, o);
      if (L === null) continue;
      const v = altPass63(obs, L, team.length, req, opts);
      if (v !== null && (pAlt === null || v > pAlt)) pAlt = v;
    }
  } else {
    const tail = tailLeaderOf(obs);
    pAlt = tail === null ? null : altPass63(obs, tail, team.length, req, opts);
  }
  if (pAlt === null) return null;
  const margin = scale * evGateMargin63(obs);
  return { reject: pAlt - pNow > margin, pNow, pAlt, margin };
}
