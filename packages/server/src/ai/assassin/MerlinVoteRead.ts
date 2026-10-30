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

/**
 * 第 12 回合紅方候選 `assassinVoteModel`（`model = 'normal'`）：第 11 回合起梅林照雜魚投票（`merlinNormalVote`；Edward 10/30
 * 裁定）——在隊上照忠臣投（內白沒有資訊），只有紅方已兩紅、隊上有他看得到的紅時內黑；不在隊上時有看得到的紅就不外白，
 * 看得到的都乾淨時照忠臣投。舊模型（`'strict'`）把「在隊上贊成有可見紅的隊」當成「不是梅林」的強烈證據，正好讀反了
 * 第 11 回合的梅林。誰是莫德雷德：刺殺階段紅方開牌相認（`allEvilRoles`），有就用，否則對每個紅方取平均。
 */
export type MerlinVoteModel = 'strict' | 'normal' | 'normalFit';

/**
 * `'normalFit'`：同 `'normal'`，但一般藍方（梅林以外）在兩個有資訊的格子裡的贊成率改用第 11 回合預設自我對打量到的比例
 * （300 局，第 3 局起非強制）：不在隊上、隊上有梅林看得到的紅 27%（梅林 0%）；在隊上、紅方已兩紅、隊上有看得到的紅
 * 52%（梅林 0%）。信念概似表的格子是「隊上有沒有紅」（含莫德雷德），不是「梅林看不看得到」。
 */
const FIT_OFF_SEEN = 0.27;
const FIT_ON_SEEN_FATAL = 0.52;

/** Whether approving `team` could lose the game on the spot in Merlin's view at that vote (`merlinVoteFatal`, then). */
function fatalThen(obs: PlayerObservation, round: number, seen: number): boolean {
  if (seen === 0) return false;
  const fails = (obs.questResults ?? []).slice(0, Math.max(0, round - 1)).filter((r) => r === 'fail').length;
  return fails >= 2 || (round === 4 && obs.playerCount >= 7 && seen >= 2);
}

/** log [ mean over Mordred d of P(votes | Merlin) / P(votes | generic blue) ] for `candidate`. */
export function merlinVoteLogRatio(obs: PlayerObservation, candidate: string, reds: readonly string[], model: MerlinVoteModel = 'strict'): number {
  const late = obs.voteHistory.filter((v) => v.round >= 3 && v.attempt < 5 && v.votes[candidate] !== undefined);
  if (late.length === 0 || reds.length === 0) return 0;
  const normal = model !== 'strict';
  const roles = normal ? obs.allEvilRoles : undefined;
  const known = roles ? reds.filter((id) => roles[id] === 'mordred') : [];
  const mordreds: (string | null)[] = roles ? (known.length > 0 ? known : [null]) : [...reds];
  let sum = 0;
  for (const d of mordreds) {
    let lr = 0;
    for (const v of late) {
      const on = v.team.includes(candidate);
      const hasRed = v.team.some((id) => reds.includes(id));
      const seen = v.team.filter((id) => id !== d && reds.includes(id)).length;
      let pg = genericGoodVoteProb(on, hasRed, v.round, true);
      let pm: number;
      if (normal) {
        // Merlin votes as the generic blue would (no information) unless the seen reds bar the approve.
        const barred = on ? fatalThen(obs, v.round, seen) : seen > 0;
        if (!barred) continue;
        if (model === 'normalFit') pg = on ? FIT_ON_SEEN_FATAL : FIT_OFF_SEEN;
        pm = EPS;
      } else {
        pm = seen > 0 ? EPS : Math.min(genericGoodVoteProb(on, false, v.round, true), 1 - EPS);
      }
      lr += Math.log(v.votes[candidate] ? pm / pg : (1 - pm) / (1 - pg));
    }
    sum += Math.exp(lr);
  }
  return Math.log(sum / mordreds.length);
}
