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
import { bayesOptionsOf, bayesRedShare, bayesTeamClean } from './belief/BayesBelief';

/** true = 這一票改投黑。 */
export function goodCleanVoteReject(tuning: Readonly<AgentTuning>, obs: PlayerObservation): boolean {
  const tau = tuning.goodCleanVote ?? 0;
  if (tau <= 0 || obs.gamePhase !== 'team_vote' || obs.myTeam !== 'good') return false;
  const loyal = obs.myRole === 'loyal' && !tuning.goodCleanVotePercivalOnly;
  const percival = obs.myRole === 'percival' && !tuning.goodCleanVoteLoyalOnly;
  if (!loyal && !percival) return false;
  if ((obs.currentRound ?? 1) < 3) return false;
  if ((obs.failCount ?? 0) + 1 > (tuning.goodCleanVoteMaxAttempt ?? 4)) return false;
  const team = obs.proposedTeam ?? [];
  if (team.length === 0) return false;
  const p = bayesTeamClean(obs, team, bayesOptionsOf(tuning));
  return p !== null && p < tau;
}

/**
 * 好人不在隊上的票：預設一般票，外白只為「洗尾／第六好」（強桌差距 B3，2026-10-30；`AgentTuning.goodTailVote` = 門檻 τ）。
 *
 * `docs/ai/strong_table_gap.md`：機器人忠臣／派西第 3 局起不在隊上，乾淨的隊外白 64–80%、有紅的隊 26–32%；忠臣勝率前 1/4
 * 的玩家 33%／11%。百科〈外白〉「請賦予你的每個外白意義」「洗掉尾派的動機：認為尾派是壞人」「場外的第六好往往才是決定能不能
 * 三藍的關鍵」，〈為什麼不該亂開場外白球〉「一場的外白一般 3 次以下」。
 * 規則（第 3 局起、非強制、忠臣或派西、不在隊上）：這隊乾淨的機率 p ≥ τ 而且（本局強制局的隊長紅的機率 ≥ 0.4＝洗尾，
 * 或藍方已兩藍＝這隊過了就三藍）→ 白；否則 → 黑。回傳要投的票；不適用時 null。
 */
export function goodTailVote(tuning: Readonly<AgentTuning>, obs: PlayerObservation): boolean | null {
  const tau = tuning.goodTailVote ?? 0;
  if (tau <= 0 || obs.gamePhase !== 'team_vote' || obs.myTeam !== 'good') return null;
  if (obs.myRole !== 'loyal' && obs.myRole !== 'percival') return null;
  if ((obs.currentRound ?? 1) < 3 || (obs.failCount ?? 0) >= 4) return null;
  const team = obs.proposedTeam ?? [];
  if (team.length === 0 || team.includes(obs.myPlayerId)) return null;
  const opts = bayesOptionsOf(tuning);
  const p = bayesTeamClean(obs, team, opts);
  if (p === null) return null;
  if (p < tau) return false;
  if (obs.questResults.filter((r) => r === 'success').length >= 2) return true;
  const ids = obs.allPlayerIds;
  const lead = ids.indexOf(obs.currentLeader ?? '');
  if (lead < 0) return null;
  const tail = ids[(lead + (4 - (obs.failCount ?? 0))) % ids.length];
  if (tail === obs.myPlayerId) return false;
  const tailRed = bayesRedShare(obs, opts).get(tail) ?? 0;
  return tailRed >= 0.4;
}
