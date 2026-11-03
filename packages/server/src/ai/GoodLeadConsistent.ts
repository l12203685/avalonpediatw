/**
 * 好人隊長的派票和自己的票一致（優化迴圈第 24 回合・藍方；Edward 2026-11-03 練習台：「3 家第二次派票的組合不合理——他先內黑過 2350，但又照派一次，又自派自黑」；
 * `AgentTuning.goodLeadConsistent`）。
 *
 * 正式流程的派隊分數（`TeamReuse` 的照派加分：這一局被否決過的隊 ×0.45）和投票規則（`goodCleanVote`／`goodKeyVote`：後驗「這隊沒有紅」低於門檻就投黑）是兩條路，
 * 派西／忠臣當隊長時會派一支自己的投票規則會投黑的隊（同一局剛內黑過的隊被照派加分選回來），再對自己的隊投黑。
 *
 *   1 = 派隊：忠臣／派西隊長最後派出的隊，若自己的投票規則（關鍵局門檻、一般門檻）會投黑，改派自己後驗最乾淨的隊（含自己、過邏輯閘門）；
 *       照派加分也不再拿「自己在隊上、投了黑」的被否決隊當參考。
 *   2 = 1 ＋ 投票：忠臣／派西對自己派的隊（非強制）一律投白（仍然不越過好人投票關卡）；
 *   3 = 2 ＋ 梅林也對自己派的隊投白（Edward 裁定：梅林在隊上的正常票內白沒有問題；隊上看得到的紅會直接輸掉時照舊投黑，`merlinVoteFatal`）。
 */
import type { AgentAction, PlayerObservation } from './types';
import type { AgentTuning } from './AgentTuning';
import { bayesOptionsOf, bayesTeamClean } from './belief/BayesBelief';
import { goodCleanVoteReject, goodKeyVoteReject } from './GoodCleanVote';
import { merlinVoteFatal } from './MerlinLoyalStyle';

const goodLeader = (obs: PlayerObservation): boolean => obs.myTeam === 'good' && (obs.myRole === 'loyal' || obs.myRole === 'percival');

/** Whether the reuse plan skips the rejected teams the leader sat on and voted against. */
export function leadConsistentSkip(tuning: Readonly<AgentTuning>, obs: PlayerObservation): boolean {
  return (tuning.goodLeadConsistent ?? 0) >= 1 && goodLeader(obs);
}

/** Would this seat's own vote rules reject `team` (as a non-forced proposal of this round)? */
export function ownVoteRejects(tuning: Readonly<AgentTuning>, obs: PlayerObservation, team: readonly string[]): boolean {
  const asVote = { ...obs, gamePhase: 'team_vote', proposedTeam: [...team] } as PlayerObservation;
  return goodKeyVoteReject(tuning, asVote) || goodCleanVoteReject(tuning, asVote);
}

function combinations<T>(items: readonly T[], k: number): T[][] {
  const out: T[][] = [];
  const pick = (start: number, acc: T[]): void => {
    if (acc.length === k) { out.push([...acc]); return; }
    for (let i = start; i <= items.length - (k - acc.length); i++) { acc.push(items[i]); pick(i + 1, acc); acc.pop(); }
  };
  pick(0, []);
  return out;
}

export function goodLeadConsistentTeam(
  tuning: Readonly<AgentTuning>,
  obs: PlayerObservation,
  action: AgentAction,
  allowed: (team: readonly string[]) => boolean = () => true,
): AgentAction {
  if ((tuning.goodLeadConsistent ?? 0) < 1 || action.type !== 'team_select' || !goodLeader(obs)) return action;
  if ((obs.failCount ?? 0) >= 4) return action;
  if (!ownVoteRejects(tuning, obs, action.teamIds)) return action;
  const me = obs.myPlayerId;
  const opts = bayesOptionsOf(tuning);
  let best: string[] | null = null;
  let bestP = -1;
  for (const fill of combinations(obs.allPlayerIds.filter((id) => id !== me), action.teamIds.length - 1)) {
    const team = [me, ...fill];
    if (!allowed(team)) continue;
    const p = bayesTeamClean(obs, team, opts) ?? 0;
    if (p > bestP + 1e-12) { bestP = p; best = team; }
  }
  return best ? { type: 'team_select', teamIds: best } : action;
}

/** `goodLeadConsistent` ≥ 2: a loyal / Percival leader's vote on its own non-forced proposal is white (3: Merlin too, unless fatal). */
export function goodLeaderSelfApprove(tuning: Readonly<AgentTuning>, obs: PlayerObservation): boolean {
  const m = tuning.goodLeadConsistent ?? 0;
  const merlin = m >= 3 && obs.myTeam === 'good' && obs.myRole === 'merlin' && !merlinVoteFatal(obs);
  if (m < 2 || obs.gamePhase !== 'team_vote' || !(goodLeader(obs) || merlin)) return false;
  if ((obs.failCount ?? 0) >= 4) return false;
  return obs.currentLeader === obs.myPlayerId && (obs.proposedTeam ?? []).includes(obs.myPlayerId);
}
