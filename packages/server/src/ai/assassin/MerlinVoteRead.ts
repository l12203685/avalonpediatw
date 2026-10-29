/**
 * 刺客從投票紀錄找梅林（優化迴圈第 6 回合・紅方候選，2026-10-29；`AgentTuning.assassinMerlinVotes`）。
 *
 * 梅林資訊流診斷（scripts/merlinDiagnosis.ts）：機器人梅林第 3 局起對「隊上有他看得到的紅」的隊贊成 0%（真人 25.7%），
 * 但刺客的模型（真人牌譜擬合）沒用到這麼強的訊號，刺中率 27%（真人 43%）。Edward 10/29：紅方要逼梅林給資訊、找到刺殺對象。
 *
 * 每個候選人第 3 局起的非強制投票，在「他是梅林」（看得到的紅 = 全部紅方扣掉莫德雷德；誰是莫德雷德取平均）與
 * 「他是一般藍方」（真人投票表）兩個模型下的對數概似比，乘上權重加到刺殺分數上（分數是對數機率）。
 */
import type { PlayerObservation } from '../types';
import { genericGoodVoteProb } from '../belief/BayesBelief';

const EPS = 0.05;

/** log [ mean over Mordred d of P(votes | Merlin) / P(votes | generic blue) ] for `candidate`. */
export function merlinVoteLogRatio(obs: PlayerObservation, candidate: string, reds: readonly string[]): number {
  const late = obs.voteHistory.filter((v) => v.round >= 3 && v.attempt < 5 && v.votes[candidate] !== undefined);
  if (late.length === 0 || reds.length === 0) return 0;
  let sum = 0;
  for (const d of reds) {
    let lr = 0;
    for (const v of late) {
      const on = v.team.includes(candidate);
      const hasRed = v.team.some((id) => reds.includes(id));
      const seenRed = v.team.some((id) => id !== d && reds.includes(id));
      const pg = genericGoodVoteProb(on, hasRed, v.round, true);
      const pm = seenRed ? EPS : Math.min(genericGoodVoteProb(on, false, v.round, true), 1 - EPS);
      lr += Math.log(v.votes[candidate] ? pm / pg : (1 - pm) / (1 - pg));
    }
    sum += Math.exp(lr);
  }
  return Math.log(sum / reds.length);
}
