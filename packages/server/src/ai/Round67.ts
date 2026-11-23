/**
 * 第 67 回合（紅方）：第 1、2 局紅方在隊上的票。
 *
 * 真人局同一批決策點（人類 PR 量尺 `humanPrBenchmark.ts --roles assassin,morgana,mordred,oberon --dump`，`scripts/redSideStudy67.ts`
 * 接回局面、`redSideStudy67.py` 依局面格拆量尺）：第 56–66 回合沒做過的紅方落差裡，最大的一塊是「相認紅第 1、2 局在隊上的票」
 * （量尺 −0.32 ± 0.06 pp／局；高端桌 S ≥ 55 第 2 局第 1 局失敗之後 −0.29 ± 0.12）：機器人一律贊成（R1–R2 正常票），真人在第 2 局
 * 內黑約 4%（第 1 局 1%）。落差集中在「第 2 局、第 1 局失敗之後、隊上有兩個紅」——真人在那裡內黑的局，紅方的結果比較好。
 *
 * 站長的範圍：D3「R1–R2 一律正常票」（Edward 2026-04-30）在 2026-11-04 改成分階段解除，忠臣先在有把握時用公開資訊開異常票；
 * 站長 11/19「外白內黑傾向 還是要建立在對組合的解讀上 不是硬白硬黑」。所以這個開關不是照真人比例隨機投，而是紅方照「坐在這個位置、
 * 只看公開紀錄的忠臣」讀這隊：公開上這隊很可能有紅（例如帶了第 1 局失敗隊上的人）時，一個有把握的忠臣會內黑，紅方照做來偽裝。
 *
 * `redEarlyBlack67 = θ`（0 = 關）：紅方（莫甘娜、莫德雷德；刺客要位元 64、奧伯倫要位元 32）第 1、2 局非強制、在隊上、不是隊長，
 * 同座位的公開視角忠臣讀出 P(這隊有紅) ≥ θ 就反對。
 * `redEarlyBlack67Scope`（位元；0 = 25）：1 = 第 2 局、第 1 局失敗之後；2 = 第 2 局、第 1 局成功之後；4 = 第 1 局；8 = 隊上要有看得到的隊友；
 * 16 = 只在自己這一票決定不了過不過時（估其他人的贊成數：隊上的人算贊成，不在隊上、看不到是紅的人照他自己的公開視角 P(乾淨) ≥ 0.5 算贊成，
 * 同第 65 回合 `crowdApprovals65`；剛好差自己一票就過的時候不內黑，擋下一隊會失敗的任務不划算）；32 = 奧伯倫也適用；64 = 刺客也適用
 * （人類 PR 量尺上刺客那一支每一層都是負的，所以預設只給莫甘娜、莫德雷德）。
 * 硬約束（隊長自己的提議、照派自己這一局先前的隊、紅方持湖者言行一致…）在呼叫端之前就處理掉了。只用投票前的公開紀錄。
 */
import type { AgentTuning } from './AgentTuning';
import type { PlayerObservation } from './types';
import { bayesOptionsOf, bayesTeamClean } from './belief/BayesBelief';
import { crowdApprovals65 } from './Round65';

/** 「決定不了」的估法：不在隊上、看不到是紅的人，自己的公開視角 P(乾淨) ≥ 0.5 算贊成。 */
const CROWD_CLEAN_TAU = 0.5;

/** 診斷計數（研究腳本用；不影響決策）。 */
export const round67Stats = { checked: 0, black: 0, decisive: 0 };

/** 同一座位、只有公開紀錄的忠臣視角（沒有紅方看得到的隊友）。 */
function publicLoyal(obs: PlayerObservation): PlayerObservation {
  return { ...obs, myRole: 'loyal', myTeam: 'good', knownEvils: [], knownWizards: undefined, allEvilIds: undefined, myLakeResults: [] } as PlayerObservation;
}

/** 同座位的公開視角忠臣讀出的 P(這隊至少一紅)；讀不出來回 null。 */
export function publicTeamRedProb67(tuning: Readonly<AgentTuning>, obs: PlayerObservation, team: readonly string[]): number | null {
  const clean = bayesTeamClean(publicLoyal(obs), team, bayesOptionsOf(tuning));
  return clean === null ? null : 1 - clean;
}

/** true = 這一票改投反對（紅方第 1、2 局在隊上的內黑）；false = 照原本。 */
export function redEarlyBlack67(tuning: Readonly<AgentTuning>, obs: PlayerObservation): boolean {
  const theta = tuning.redEarlyBlack67 ?? 0;
  if (!(theta > 0) || obs.gamePhase !== 'team_vote' || obs.myTeam !== 'evil') return false;
  const scope = (tuning.redEarlyBlack67Scope ?? 0) || 25;
  if (obs.myRole === 'oberon' && (scope & 32) === 0) return false;
  if (obs.myRole === 'assassin' && (scope & 64) === 0) return false;
  const round = obs.currentRound ?? 1;
  if (round > 2 || (obs.failCount ?? 0) >= 4 || obs.currentLeader === obs.myPlayerId) return false;
  const team = obs.proposedTeam ?? [];
  if (!team.includes(obs.myPlayerId)) return false;
  if (round === 1 && (scope & 4) === 0) return false;
  if (round === 2) {
    const r1Failed = (obs.questResults ?? [])[0] === 'fail';
    if (r1Failed && (scope & 1) === 0) return false;
    if (!r1Failed && (scope & 2) === 0) return false;
  }
  if ((scope & 8) !== 0 && !team.some((id) => id !== obs.myPlayerId && obs.knownEvils.includes(id))) return false;
  round67Stats.checked++;
  if ((publicTeamRedProb67(tuning, obs, team) ?? 0) < theta) return false;
  if ((scope & 16) !== 0) {
    const majority = Math.floor(obs.playerCount / 2) + 1;
    if (crowdApprovals65(tuning, obs, CROWD_CLEAN_TAU) === majority - 1) { round67Stats.decisive++; return false; }
  }
  round67Stats.black++;
  return true;
}
