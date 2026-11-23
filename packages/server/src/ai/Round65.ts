/**
 * 第 65 回合（紅方）：第 59 回合待測清單的紅方外白、Gemini 第二意見 G6（紅方派隊太好認）、奧伯倫的票。
 *
 * 真人局同一批決策點（`scripts/redSideStudy65.ts`）：
 * - 相認紅（刺客、莫甘娜、莫德雷德）第 3 局起不在隊上，真人外白 22.4%（高端桌 19.3%），機器人 5.3%。真人的外白跟著桌上其他人的票走——
 *   其他 9 人贊成 ≤ 4 票時真人外白約 10%，7、8、9 票時 49%、69%、87%；機器人在每一格都是 3–13%（照雜魚投票 `redNormalVote`
 *   用的是機器人忠臣的票型，機器人忠臣不在隊上幾乎不外白）。
 * - 紅方隊長第 3、5 局非強制的提議，隊上看得到的紅（含自己）≥ 2 的比例真人 34.5%、機器人 57.2%（第 4 回合 `redStackRatio=0.8` 的疊隊友）。
 *
 * `redCrowdWhite65`（值 = 門檻 τ；0 = 關）：照雜魚投票的紅方（第 3 局起、非強制、不在隊上；`redNormalVote` 的範圍，奧伯倫只在
 *   `oberonNormalVote` 開著時）要投反對時——不管是照忠臣的反對，還是藍方聽牌、隊上沒有隊友的「關鍵隊」反對——先估「不算自己，這隊過不過得了」：
 *   隊上的人都算贊成；不在隊上、它看不到是紅的人，站在那個座位（同一份公開紀錄，用藍方的讀法 `bayesTeamClean`）估「這隊沒有紅」≥ τ 的算贊成；
 *   不在隊上的隊友不算。贊成數已經過半（10 人局 6 票）→ 自己的反對擋不下來，只會被看到，改投贊成（跟著大家外白）。
 *   只用投票前看得到的公開紀錄，不看別人這一次的票。
 * `redStackRate65`（值 = 比例 p；0 = 關）：第 3、5 局非強制的提議，紅隊長（不含奧伯倫）在 `redCleanLook` 的隊上多帶一個隊友（`redStackRatio`）
 *   只在雜湊 < p 時照舊，其他時候只帶剛好夠讓任務失敗的紅。第 4 局（要兩張失敗）與強制局不變。
 */
import type { AgentTuning } from './AgentTuning';
import type { PlayerObservation } from './types';
import { bayesOptionsOf, bayesTeamClean } from './belief/BayesBelief';

/** 診斷計數（研究腳本、自我對打拆解用；不影響決策）。 */
export const round65Stats = { crowdChecked: 0, crowdWhite: 0, stackChecked: 0, stackSkipped: 0 };

function hash01(s: string): number {
  let h = 0x811c9dc5;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return (h % 10000) / 10000;
}

/** 這個座位的公開視角（同一份紀錄，沒有紅方的私人資訊；同 `RedRound4.blueView`）。 */
function publicView(obs: PlayerObservation, viewer: string): PlayerObservation {
  return { ...obs, myPlayerId: viewer, myRole: 'loyal', myTeam: 'good', knownEvils: [], knownWizards: undefined, allEvilIds: undefined, myLakeResults: [] } as PlayerObservation;
}

/** 不算自己（也不算不在隊上的隊友），估這隊會拿到幾張贊成。 */
export function crowdApprovals65(tuning: Readonly<AgentTuning>, obs: PlayerObservation, tau: number): number {
  const me = obs.myPlayerId;
  const team = obs.proposedTeam ?? [];
  const mates = new Set(obs.knownEvils);
  const opts = bayesOptionsOf(tuning);
  let yes = 0;
  for (const id of obs.allPlayerIds) {
    if (id === me) continue;
    if (team.includes(id)) { yes++; continue; }
    if (mates.has(id)) continue;
    if ((bayesTeamClean(publicView(obs, id), team, opts) ?? 0) >= tau) yes++;
  }
  return yes;
}

/**
 * `redCrowdWhite65`：照雜魚投票的紅方要反對時，這隊不算自己也過得了 → true（改投贊成）。呼叫的地方已經在 `redNormalVoteNow` 的範圍內
 * （第 3 局起、非強制、不在隊上、紅方）。
 */
export function redCrowdWhite65(tuning: Readonly<AgentTuning>, obs: PlayerObservation): boolean {
  const tau = tuning.redCrowdWhite65 ?? 0;
  if (tau <= 0 || obs.gamePhase !== 'team_vote' || obs.myTeam !== 'evil') return false;
  if ((obs.currentRound ?? 1) < 3 || (obs.failCount ?? 0) >= 4) return false;
  if ((obs.proposedTeam ?? []).includes(obs.myPlayerId)) return false;
  round65Stats.crowdChecked++;
  const majority = Math.floor(obs.playerCount / 2) + 1;
  const ok = crowdApprovals65(tuning, obs, tau) >= majority;
  if (ok) round65Stats.crowdWhite++;
  return ok;
}

/** `redStackRate65`：false = 這一次不多帶隊友（第 3、5 局非強制、紅隊長、雜湊 ≥ p）；其他情況 true（照 `redStackRatio`）。 */
export function redStackAllowed65(tuning: Readonly<AgentTuning>, obs: PlayerObservation): boolean {
  const p = tuning.redStackRate65 ?? 0;
  if (p <= 0 || obs.myTeam !== 'evil' || obs.myRole === 'oberon') return true;
  const round = obs.currentRound ?? 1;
  if ((round !== 3 && round !== 5) || (obs.failCount ?? 0) >= 4) return true;
  round65Stats.stackChecked++;
  const ok = hash01(`${obs.myPlayerId}|${round}|${obs.failCount ?? 0}|redstack65`) < p;
  if (!ok) round65Stats.stackSkipped++;
  return ok;
}
