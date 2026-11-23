/**
 * 第 59 回合（藍方在隊上的投票）：真人局逐點重播（`scripts/onTeamVoteStudy59.ts`）——藍方第 3 局起、第 1–4 次提議、自己在隊上（不是隊長），
 * 真人反對 28%、機器人（真人桌策略層）56%。指定玩家一致度工具（#146）最大的一類不同就是這裡（機器人內黑、玩家贊成）。
 *
 * 原因（`BlueRound33.bayesVoteCriteria` 在隊上的那一段）：P(隊上自己以外有紅) ≥ 0.8（紅方兩勝 0.7；之後還會當隊長再低 0.05）就內黑。
 *   - 第 4 局要兩張失敗才失敗，但 `goodBayesVote=3` 照「隊上有紅」讀：五人隊上自己以外四個人，光是開局的機率就有 96% 帶紅，
 *     所以機器人第 4 局在隊上 65% 內黑；照字面（P(隊上的紅 ≥ 2)）讀，真人反對的比例和這個機率幾乎一樣高（P 0.3 → 37%、0.6 → 51%、0.9 → 66%）。
 *   - 第 3 局四人隊、自己以外三個人：開局 88% 帶紅，門檻 0.8 只比開局低一點；真人在 P 0.8–0.9 只反對 27%（P ≥ 0.9 也只有 39%）。
 *
 * `onTeamVote59 = θ₄`（0 = 關）：第 4 局在隊上照字面讀，P(隊上的紅 ≥ 2) ≥ θ₄ 才內黑。
 * `onTeamVote59R3 = θ₃`（0 = 照原本）：第 3 局在隊上內黑的門檻（取代 `goodBayesBad`／`goodBayesBadKey`）。
 * 兩個都只改 `bayesVoteCriteria` 的門檻那一步：公開邏輯證明會失敗（provFail）、好人投票關卡、湖的硬規則、隊長自己贊成、第 5 局都不變；
 * 「之後還會當隊長」的位移（`leaderOppVote51`）照樣扣。
 * 只給忠臣、派西：梅林在隊上的正常票也走這一段（坐在梅林位置的公開視角，`publicLoyalView`），但人類 PR 量尺上梅林一起改是負的
 * （第 4 局照字面時梅林會贊成帶一個他看得到的紅的隊；−0.26 ± 0.04 pp／座位局，每一層都負），所以梅林照原本。
 */
import type { PlayerObservation } from './types';
import type { AgentTuning } from './AgentTuning';

/** 第 59 回合在這一點的（要幾個紅、門檻）；null = 照原本。呼叫端：藍方在隊上、第 3–5 局、非強制、不是隊長。 */
export function onTeamBar59(tuning: Readonly<AgentTuning>, obs: PlayerObservation, failsRequired: number): { req: number; bar: number } | null {
  if (obs.publicLoyalView === true) return null;
  const round = obs.currentRound ?? 1;
  if (round === 4) {
    const t4 = tuning.onTeamVote59 ?? 0;
    return t4 > 0 ? { req: failsRequired, bar: t4 } : null;
  }
  if (round === 3) {
    const t3 = tuning.onTeamVote59R3 ?? 0;
    return t3 > 0 ? { req: failsRequired, bar: t3 } : null;
  }
  return null;
}
