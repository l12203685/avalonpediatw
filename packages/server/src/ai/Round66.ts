/**
 * 第 66 回合（藍方）：第 2 局在隊上的票。
 *
 * 真人局同一批決策點（`scripts/blueSideStudy66.ts`，10 人局 2,341 局；人類 PR 量尺 `humanPrBenchmark.ts --dump` 逐決策拆開）：
 * - 藍方第 2 局非強制、在隊上（不是隊長）的投票 18,673 點，真人贊成 93.7%，機器人 100%（R1–R2 一律正常票，第 26／28 回合的 D3 分階段解除只開了外白）。
 * - 人類 PR 量尺裡這一格是機器人落後真人最多的一塊（基準線與真人桌都一樣：第 2 局 0:1、1:0 在隊上合計約 −1.4pp／局）。
 *   分角色：派西 −0.81、梅林 −0.44、忠臣 −0.18pp／局。真人梅林的內黑多半在隊上有他看得到的紅時（看得到 1 紅 9%、2 紅 14%、沒有 3%）；
 *   真人派西兩根拇指都在隊上時內黑 22%（確定有紅）。
 *
 * 站長的範圍（D3：R1–R2 一律正常票，2026-11-04 改成分階段解除）：忠臣先在有把握時用公開資訊開異常票；梅林、派西只在「同樣公開資訊的忠臣也會」的範圍內開
 * （第 28 回合 `mpTailWhite` 的同一個做法）。站長 11/19：「外白內黑傾向 還是要建立在對組合的解讀上 不是硬白硬黑」。
 *
 * `r2InnerBlack66 = θ`（0 = 關）：第 2 局、非強制、在隊上、不是隊長的藍方，讀法說 P(這隊有紅) ≥ θ 就反對。
 * `r2InnerBlack66Roles`（位元；0 當成 6 = 派西＋梅林，忠臣那一支第 1H 節不過）：
 * - 1 忠臣：自己的後驗（忠臣的私人資訊只有自己是好人，就是公開視角）。
 * - 2 派西：同座位的公開視角忠臣過 θ，而且他自己的後驗（含拇指）也過 θ。
 * - 4 梅林：同座位的公開視角忠臣過 θ（不用他看得到的紅）。
 * - 8 派西兩根拇指都在隊上（確定有紅）→ 反對；16 梅林隊上有他看得到的紅 → 反對。這兩個用私人資訊，在 D3 的範圍外，只量、不採用（要站長決定）。
 * `r2InnerBlack66Mix = p`（0 = 一律）：第 1C 節「中性改測 50%」——照局面雜湊（座位、第幾次提議、隊伍）< p 才內黑，同一局面每次一樣。
 * 結果（第 66 回合）：位元 6（派西＋梅林，θ 0.9）人類 PR 量尺派西 +0.46 ± 0.06、梅林 +0.60 ± 0.06，每一層兩半都正 → 真人桌採用（`humanProfile.ts`）；
 * 忠臣（位元 1）每一層都負（−0.14 ± 0.02），不放；自我對打中性（+0.01 [−0.09, +0.11]），基準線不用。
 * 反對不需要過好人投票關卡（關卡只擋贊成）；隊長自己的提議與照派自己這一局先前的隊（`leaderSelfApprove`）在呼叫端之前就處理掉了。
 */
import type { AgentTuning } from './AgentTuning';
import type { PlayerObservation } from './types';
import { bayesOptionsOf, bayesTeamClean } from './belief/BayesBelief';

/** 診斷計數（研究腳本用；不影響決策）。 */
export const round66Stats = { checked: 0, black: 0 };

function hash01(s: string): number {
  let h = 0x811c9dc5;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return (h % 10000) / 10000;
}

/** 同一座位、只有公開紀錄的忠臣視角（沒有梅林看得到的紅、沒有派西的拇指）。 */
function publicLoyal(obs: PlayerObservation): PlayerObservation {
  return { ...obs, myRole: 'loyal', myTeam: 'good', knownEvils: [], knownWizards: undefined, allEvilIds: undefined, myLakeResults: [] } as PlayerObservation;
}

/** 讀法說這隊有紅的機率（P(至少一紅)；第 2 局一張失敗就失敗）；讀不出來回 null。 */
export function teamRedProb66(tuning: Readonly<AgentTuning>, view: PlayerObservation, team: readonly string[]): number | null {
  const clean = bayesTeamClean(view, team, bayesOptionsOf(tuning));
  return clean === null ? null : 1 - clean;
}

/** true = 這一票改投反對（第 2 局在隊上的內黑）；false = 照原本。 */
export function r2InnerBlack66(tuning: Readonly<AgentTuning>, obs: PlayerObservation): boolean {
  const theta = tuning.r2InnerBlack66 ?? 0;
  if (!(theta > 0) || obs.gamePhase !== 'team_vote' || obs.myTeam !== 'good' || obs.publicLoyalView === true) return false;
  if ((obs.currentRound ?? 1) !== 2 || (obs.failCount ?? 0) >= 4 || obs.currentLeader === obs.myPlayerId) return false;
  const team = obs.proposedTeam ?? [];
  if (!team.includes(obs.myPlayerId)) return false;
  const roles = (tuning.r2InnerBlack66Roles ?? 0) || 6;
  const role = obs.myRole;
  round66Stats.checked++;
  let black = false;
  if (role === 'loyal') {
    if ((roles & 1) !== 0) black = (teamRedProb66(tuning, obs, team) ?? 0) >= theta;
  } else if (role === 'percival') {
    const wiz = obs.knownWizards ?? [];
    if ((roles & 8) !== 0 && wiz.length >= 2 && wiz.every((id) => team.includes(id))) black = true;
    else if ((roles & 2) !== 0) {
      black = (teamRedProb66(tuning, publicLoyal(obs), team) ?? 0) >= theta && (teamRedProb66(tuning, obs, team) ?? 0) >= theta;
    }
  } else if (role === 'merlin') {
    if ((roles & 16) !== 0 && team.some((id) => obs.knownEvils.includes(id))) black = true;
    else if ((roles & 4) !== 0) black = (teamRedProb66(tuning, publicLoyal(obs), team) ?? 0) >= theta;
  }
  const mix = tuning.r2InnerBlack66Mix ?? 0;
  if (black && mix > 0 && hash01(`${obs.myPlayerId}|${obs.failCount ?? 0}|${[...team].sort().join(',')}|r2black66`) >= mix) black = false;
  if (black) round66Stats.black++;
  return black;
}
