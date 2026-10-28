/**
 * 好人看貝氏後驗投票（優化迴圈第 3 回合・藍方，2026-10-28；`AgentTuning.goodCleanVote`）。
 *
 * 任務階段診斷（scripts/missionDiagnosis.ts）：第 3 局起出任務的隊有三成是紅隊長派的、隊上必有紅，機器人好人
 * 幾乎都放行（第 3 局走到第 5 次強制提議的比例：真人 40%、機器人 2%）。這條規則：第 3 局起、非強制提議，
 * 忠臣與派西估「這隊沒有紅」的機率（L1* 世界 × 真人動作概似的後驗，`bayesTeamClean`）低於門檻就投黑。
 * 梅林看得到紅，不用這條；只會把贊成改成反對，不會反過來。
 */
import type { AgentTuning } from './AgentTuning';
import type { PlayerObservation } from './types';
import { bayesTeamClean } from './belief/BayesBelief';

/** true = 這一票改投黑。 */
export function goodCleanVoteReject(tuning: Readonly<AgentTuning>, obs: PlayerObservation): boolean {
  const tau = tuning.goodCleanVote ?? 0;
  if (tau <= 0 || obs.gamePhase !== 'team_vote' || obs.myTeam !== 'good') return false;
  if (obs.myRole !== 'loyal' && (obs.myRole !== 'percival' || tuning.goodCleanVoteLoyalOnly)) return false;
  if ((obs.currentRound ?? 1) < 3) return false;
  const team = obs.proposedTeam ?? [];
  if (team.length === 0) return false;
  const p = bayesTeamClean(obs, team, { thumbRoles: tuning.bayesThumbRoles === true });
  return p !== null && p < tau;
}
