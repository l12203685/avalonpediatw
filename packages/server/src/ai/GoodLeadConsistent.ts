/**
 * 隊長的派票和自己的票一致（優化迴圈第 24 回合；Edward 2026-11-03 練習台：「3 家第二次派票的組合不合理——他先內黑過 2350，但又照派一次，又自派自黑」；
 * `docs/ai/basic_logic_inventory.md` 規則 L2／S4／S5／S6，稽核 (a)、(b)、(b3)）。
 *
 * 正式流程（`ForwardAgent`）的投票沒有「隊長一律贊成自己的隊」（只有備援路徑 `HeuristicAgent.voteOnTeam` 有），派隊分數（`TeamReuse` 的照派加分：
 * 這一局被否決過的隊 ×0.45）和投票規則（`goodCleanVote`／`goodKeyVote`：後驗「這隊沒有紅」低於門檻就投黑）是兩條路：
 * 自我對打第 3 局起隊長對自己的隊投黑——藍方 11.6%（派西 32.5%、梅林 21.8%）、紅方 23.7%，真人 0.6–0.9%。
 *
 * 硬約束（`AgentTuning.leaderSelfApprove`，預設開；欄位只為了量測與舊表）：
 *   - 投票：隊長在自己派的非強制提議上一律投白；本局自己派過、自己在上面的隊被別人照派（非強制）也投白（S6）。
 *   - 派隊：忠臣／派西隊長最後派出的隊，若自己的投票規則（關鍵局門檻、一般門檻）會投黑，改派自己後驗最乾淨的隊（含自己、過邏輯閘門；那一隊也要過自己的投票規則，
 *     連最乾淨的隊都過不了——例如關鍵局沒有乾淨的隊——就維持原本的隊）——派隊和投票用同一個評估。
 *   - 好人（梅林除外）的白球仍然不越過好人投票關卡（必定失敗／被支配的隊，INV-V1）：重播真人局時隊伍是真人派的，可能是自己視角的必敗隊。
 * 第 25 回合把投票那一半延伸到隊長不在自己派的隊上（`AgentTuning.leaderSelfApproveOffTeam`，硬約束；第 24 回合 `goodReuseExact` 會照原樣派自己不在上面的成功隊，
 * 稽核 (a″)：隊長對那種提議投黑 藍方 32.6%，真人 5.2%）。
 * 開關（`AgentTuning.goodLeadConsistent`，預設關）：1 = 照派加分不再拿「自己在隊上、投了黑」的被否決隊當參考（忠臣／派西／梅林；S5，稽核 (b)），
 * 忠臣／派西隊長最後派的隊若正是這一局自己內黑過的隊，改派自己後驗最乾淨、這一局沒有內黑過的隊。
 */
import type { AgentAction, PlayerObservation } from './types';
import type { AgentTuning } from './AgentTuning';
import { bayesOptionsOf, bayesTeamClean } from './belief/BayesBelief';
import { goodCleanVoteReject, goodKeyVoteReject } from './GoodCleanVote';

const goodLeader = (obs: PlayerObservation): boolean => obs.myTeam === 'good' && (obs.myRole === 'loyal' || obs.myRole === 'percival');
const key = (team: readonly string[]): string => [...team].sort().join(',');

/** Whether the reuse plan skips the rejected teams the leader sat on and voted against (`goodLeadConsistent`, blue leaders). */
export function leadConsistentSkip(tuning: Readonly<AgentTuning>, obs: PlayerObservation): boolean {
  // Round 25 `redLeadConsistent`: the red leaders' version (稽核 (b) 紅方 55%、奧伯倫 90%；真人 4.2%).
  if (obs.myTeam === 'evil') return (tuning.redLeadConsistent ?? 0) >= 1;
  return (tuning.goodLeadConsistent ?? 0) >= 1 && obs.myTeam === 'good';
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

/** The teams (sorted keys) this seat sat on and voted against earlier in the round (內黑). */
function innerBlacked(obs: PlayerObservation): Set<string> {
  const me = obs.myPlayerId;
  const round = obs.currentRound ?? 1;
  return new Set(obs.voteHistory.filter((v) => v.round === round && v.team.includes(me) && v.votes[me] === false).map((v) => key(v.team)));
}

/** `goodLeadConsistent` (pick side): a loyal / Percival leader does not re-propose a team it inner-blacked this round. */
export function goodNoInnerBlackRepeat(
  tuning: Readonly<AgentTuning>,
  obs: PlayerObservation,
  action: AgentAction,
  allowed: (team: readonly string[]) => boolean = () => true,
): AgentAction {
  if ((tuning.goodLeadConsistent ?? 0) < 1 || action.type !== 'team_select' || !goodLeader(obs)) return action;
  if ((obs.failCount ?? 0) >= 4) return action;
  const banned = innerBlacked(obs);
  if (!banned.has(key(action.teamIds))) return action;
  const me = obs.myPlayerId;
  const opts = bayesOptionsOf(tuning);
  let best: string[] | null = null;
  let bestP = -1;
  for (const fill of combinations(obs.allPlayerIds.filter((id) => id !== me), action.teamIds.length - 1)) {
    const team = [me, ...fill];
    if (banned.has(key(team)) || !allowed(team)) continue;
    const p = bayesTeamClean(obs, team, opts) ?? 0;
    if (p > bestP + 1e-12) { bestP = p; best = team; }
  }
  return best ? { type: 'team_select', teamIds: best } : action;
}

/** The pick side of the constraint: a loyal / Percival leader's final team passes its own vote thresholds (else its cleanest team). */
export function goodLeadConsistentTeam(
  tuning: Readonly<AgentTuning>,
  obs: PlayerObservation,
  action: AgentAction,
  allowed: (team: readonly string[]) => boolean = () => true,
): AgentAction {
  // Only where the leader's belief is the posterior its vote rules read (`bayesBelief`; the pyramid pipeline has no such pair).
  if (!tuning.leaderSelfApprove || !tuning.bayesBelief || action.type !== 'team_select' || !goodLeader(obs)) return action;
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
  // Only a team the own vote rules accept (when even the cleanest is rejected — e.g. the key round with nothing clean — keep the pick).
  return best && !ownVoteRejects(tuning, obs, best) ? { type: 'team_select', teamIds: best } : action;
}

/**
 * The vote side of the constraint (every camp): white on the leader's own non-forced proposal it sits on, and on a non-forced
 * re-proposal (by someone else) of a team this seat led earlier in the round and sits on. null = not this case.
 */
export function leaderSelfApproveReason(tuning: Readonly<AgentTuning>, obs: PlayerObservation): string | null {
  if (!tuning.leaderSelfApprove || obs.gamePhase !== 'team_vote' || (obs.failCount ?? 0) >= 4) return null;
  const me = obs.myPlayerId;
  const team = obs.proposedTeam ?? [];
  // Round 25 `leaderSelfApproveOffTeam` (稽核 (a″)): the leader's own proposal it is not on (`goodReuseExact` re-proposes the
  // successful team as it was) — 自派自黑 all the same (bot blue 32.6%, human 5.2%).
  if (!team.includes(me)) return obs.currentLeader === me && tuning.leaderSelfApproveOffTeam ? 'leader approves its own team (not on it)' : null;
  if (obs.currentLeader === me) return 'leader approves its own team';
  const round = obs.currentRound ?? 1;
  const k = key(team);
  if (obs.voteHistory.some((v) => v.round === round && v.leader === me && key(v.team) === k)) return 'approves its own earlier team of the round';
  return null;
}
