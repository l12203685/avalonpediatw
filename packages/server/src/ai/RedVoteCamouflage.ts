/**
 * 紅方照雜魚的票型投票（強桌差距 R1，2026-10-30；`AgentTuning.redNormalVote` = 比例 q）。
 *
 * `docs/ai/strong_table_gap.md`：機器人紅方第 3 局起不在隊上時，有隊友的隊外白 95%、沒有隊友的隊 0.5%——一眼就看得出誰是
 * 誰的隊友；各紅方角色勝率前 1/4 的玩家兩種都約 20–25%。百科〈為什麼不該亂開場外白球〉「紅方場外白被抓出隊友」、〈外白〉
 * 「壞人不想一操作就被抓到，混和自己的身分打黑白球」「壞人外白：尾派是好人且高機率派過時讓隊友拿任務」。
 * 規則：第 3 局起、非強制、不在隊上（奧伯倫除外），以比例 q（依座位、回合、第幾次提議雜湊）照「坐在這個位置、只看公開紀錄
 * 的忠臣」會投的票投；只有關鍵時照紅方利益投：隊上有隊友而且紅方已兩紅（這隊過了就三紅）→ 白；隊上沒有隊友而且藍方已
 * 兩藍（這隊過了藍方就三藍）→ 黑。由 `ForwardAgent.decide` 算出那一票。
 */
import type { AgentTuning } from './AgentTuning';
import type { PlayerObservation } from './types';

export function redNormalVoteNow(tuning: Readonly<AgentTuning>, obs: PlayerObservation): boolean {
  const q = tuning.redNormalVote ?? 0;
  if (q <= 0 || obs.gamePhase !== 'team_vote' || obs.myTeam !== 'evil' || obs.myRole === 'oberon') return false;
  const round = obs.currentRound ?? 1;
  if (round < 3 || (obs.failCount ?? 0) >= 4) return false;
  if ((obs.proposedTeam ?? []).includes(obs.myPlayerId)) return false;
  let h = 0x811c9dc5;
  for (const ch of `${obs.myPlayerId}|${round}|${obs.failCount ?? 0}|rednormal`) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return (h % 10000) / 10000 < q;
}

/** The vote the red camp's interest forces whatever the cover (`null` = no forced vote). */
export function redVoteCritical(obs: PlayerObservation): boolean | null {
  const mates = new Set(obs.knownEvils);
  const mateOn = (obs.proposedTeam ?? []).some((id) => id !== obs.myPlayerId && mates.has(id));
  const fails = obs.questResults.filter((r) => r === 'fail').length;
  const wins = obs.questResults.filter((r) => r === 'success').length;
  if (mateOn && fails >= 2) return true;
  if (!mateOn && wins >= 2) return false;
  return null;
}

/**
 * 紅隊長第 1、2 局注定被否決的提議照雜魚派（強桌差距 R2；`AgentTuning.redLoyalLeadEarly`）。
 *
 * 機器人刺客／莫德雷德當隊長，第 2 局派 2 個以上相認紅 91–97%（強者約 40%）；第 1、2 局非強制提議在一般票規則下不會出任務，
 * 疊隊友只會洩漏身分——藍方讀派隊（`beliefBotTables`）後更是如此。百科〈紅方何時要派隊友〉「1-4 以前自然就好，＂刻意＂就
 * 顯得你是能力者」。規則：第 1、2 局非強制、紅方隊長（奧伯倫除外）→ 照「坐在這個位置、只看公開紀錄的忠臣」會派的隊。
 */
export function redLoyalLeadEarlyNow(tuning: Readonly<AgentTuning>, obs: PlayerObservation): boolean {
  if (!tuning.redLoyalLeadEarly || obs.gamePhase !== 'team_select' || obs.myTeam !== 'evil' || obs.myRole === 'oberon') return false;
  return (obs.currentRound ?? 1) <= 2 && (obs.failCount ?? 0) < 4;
}
