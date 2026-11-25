/**
 * 第 81 回合（紅方・提議與投票）：任務三藍比兩邊都強的真人局多出的那幾個百分點，落在哪幾個任務節點、哪一種票。
 *
 * 拆解（`scripts/missionGapStudy81.py`，`docs/ai/gap/r81-mission-gap.md`）：兩邊都強的真人局（藍、紅平均 PR 都 ≥ 55）對現行基準線的自我對打，
 * 用「每個任務節點的失敗率換成機器人的」逐節點相加（performance-difference，加起來剛好等於總差）。差最多的兩格：
 *   (a) **第 3 局、紅方已兩勝（0:2）**：真人這一局失敗 74%、機器人 60%。機器人的提議幾乎都過不了（拖到強制局 65%，真人 36%）；
 *       紅方這一格的票：相認紅不在隊上、看得到隊友在隊上，第 4 次提議外白真人 51%、機器人 19%（第 69 回合的 `redKeyCrowd69` 只在真人桌開）；
 *       奧伯倫不在隊上，機器人不管隊上有沒有紅都投白 60%（真人 13%）——奧伯倫看不到隊友，基準線的他在這一格的白票和隊上有沒有紅無關。
 *   (b) **第 5 局（2:2）**：藍方已兩勝，紅方的外白有硬約束（盤點 G3：藍方已兩藍，不外白全藍的隊）；這一格只量現成的開關。
 *
 * 開關（都預設 0 = 關；關著時這個檔案不改任何決定）：
 * - `mpOwnRead81 = θ`（0～1）：**紅方已兩勝、藍方還沒兩勝**（第 3 局 0:2、第 4 局 1:2）、非強制、自己不在隊上、也不是自己的提議，
 *   自己看得到的隊友不夠讓這隊失敗（相認紅：隊上看得到的隊友 < 要的失敗張數；奧伯倫：一律）——用自己的視角（自己的紅方資訊＋公開紀錄，
 *   `bayesTeamRedsBelow`）估 P(隊上的紅夠讓任務失敗)，≥ θ 就投白（這隊過了，隊上的紅出失敗——A1——紅方就贏）。
 *   `mpOwnRead81Scope`（位元）：1 = 相認紅；2 = 奧伯倫（角色位元都不設 = 兩種都算）；4 = 低於 θ 也照讀法投黑（不只加白：奧伯倫原本不管隊上有沒有紅都常投白）；
 *   8 = 只在第 3 局（不含第 4 局 1:2）；16 = 一半做一半不做（第 1C 節；依座位、局、第幾次提議雜湊，同一個局面每次一樣）。
 *   不碰：藍方已兩勝的局面（硬約束 `oberonMatchPoint`、相認紅的 `redVoteCritical` 在前面判）、看得到夠多隊友的相認紅（`redKeyWhite`／`redKeyCrowd69`）、
 *   自己的提議（`leaderSelfApprove`）、強制局、紅方持湖者言行一致、被咬的奧伯倫。
 * - `oberonNormalRate81 = q`（0～1）：`oberonNormalVote` 開著時（真人桌），奧伯倫第 3 局起不在隊上只以比例 q 照「坐在這個位置的忠臣」投
 *   （依座位、局、第幾次提議雜湊；其他時候照基準線的投法）。線索表第 9 項：真人桌的奧伯倫外白第 3／4／5 局 2.9／2.8／8.3%，強者 17.5／28.6／41.0%。
 *   0 = 關（`oberonNormalVote` 照原本整個開或關）。
 */
import { AVALON_CONFIG } from '@avalon/shared';
import type { AgentTuning } from './AgentTuning';
import type { PlayerObservation } from './types';
import { bayesOptionsOf, bayesTeamRedsBelow } from './belief/BayesBelief';

const RECOGNISED: ReadonlySet<string> = new Set(['assassin', 'morgana', 'mordred']);

/** 診斷計數（自我對打拆解用；不影響決策）。 */
export const round81Stats = { mpChecked: 0, mpWhite: 0, mpBlack: 0, oberonNormal: 0, oberonFree: 0 };

function failsRequired(obs: PlayerObservation, round: number): number {
  return AVALON_CONFIG[obs.playerCount]?.questFailsRequired[round - 1] ?? 1;
}

const fails = (obs: PlayerObservation): number => (obs.questResults ?? []).filter((r) => r === 'fail').length;
const wins = (obs: PlayerObservation): number => (obs.questResults ?? []).filter((r) => r === 'success').length;

/** `mpOwnRead81` 的格子：紅方已兩勝、藍方還沒兩勝、非強制、不在隊上、不是自己的提議、看得到的隊友不夠（範圍照 `mpOwnRead81Scope`）。 */
export function inMpCell81(tuning: Readonly<AgentTuning>, obs: PlayerObservation): boolean {
  if ((tuning.mpOwnRead81 ?? 0) <= 0 || obs.gamePhase !== 'team_vote' || obs.myTeam !== 'evil') return false;
  if ((obs.failCount ?? 0) >= 4 || obs.currentLeader === obs.myPlayerId) return false;
  if (fails(obs) !== 2 || wins(obs) >= 2) return false;
  const scope = tuning.mpOwnRead81Scope ?? 0;
  const round = obs.currentRound ?? 1;
  if ((scope & 8) !== 0 && round !== 3) return false;
  const oberon = obs.myRole === 'oberon';
  if (!oberon && !RECOGNISED.has(obs.myRole)) return false;
  const roles = (scope & 3) || 3;
  if ((roles & (oberon ? 2 : 1)) === 0) return false;
  const team = obs.proposedTeam ?? [];
  if (team.includes(obs.myPlayerId)) return false;
  const seen = oberon ? 0 : team.filter((id) => obs.knownEvils.includes(id)).length;
  if (seen >= failsRequired(obs, round)) return false;
  if ((scope & 16) !== 0) {
    let h = 0x811c9dc5;
    for (const ch of `${obs.myPlayerId}|${round}|${obs.failCount ?? 0}|mp81`) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
    if ((h % 10000) / 10000 >= 0.5) return false;
  }
  return true;
}

/** 紅方自己視角 P(隊上的紅夠讓這個任務失敗)。 */
export function ownEnoughReds81(tuning: Readonly<AgentTuning>, obs: PlayerObservation): number {
  const team = obs.proposedTeam ?? [];
  const below = bayesTeamRedsBelow({ ...obs, seatTeam: obs.myTeam }, team, failsRequired(obs, obs.currentRound ?? 1), bayesOptionsOf(tuning));
  return below === null ? 0 : 1 - below;
}

/** `mpOwnRead81`：true = 投白、false = 投黑（位元 4）、null = 照原本。 */
export function mpOwnRead81(tuning: Readonly<AgentTuning>, obs: PlayerObservation): boolean | null {
  if (!inMpCell81(tuning, obs)) return null;
  round81Stats.mpChecked++;
  const p = ownEnoughReds81(tuning, obs);
  if (p >= (tuning.mpOwnRead81 ?? 0)) { round81Stats.mpWhite++; return true; }
  if (((tuning.mpOwnRead81Scope ?? 0) & 4) !== 0) { round81Stats.mpBlack++; return false; }
  return null;
}

/**
 * `oberonNormalRate81`：奧伯倫這一票要不要照忠臣投（`redNormalVoteNow` 用）。`oberonNormalVote` 關 → false（照原本）；
 * 開、而且 q = 0 → true（照原本整個開）；0 < q < 1 → 依座位、局、第幾次提議雜湊，比例 q 照忠臣投。
 */
export function oberonNormalPick81(tuning: Readonly<AgentTuning>, obs: PlayerObservation): boolean {
  if (!tuning.oberonNormalVote) return false;
  const q = tuning.oberonNormalRate81 ?? 0;
  if (q <= 0 || q >= 1) return true;
  let h = 0x811c9dc5;
  for (const ch of `${obs.myPlayerId}|${obs.currentRound ?? 1}|${obs.failCount ?? 0}|oberon81`) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  const pick = (h % 10000) / 10000 < q;
  if (pick) round81Stats.oberonNormal++; else round81Stats.oberonFree++;
  return pick;
}
