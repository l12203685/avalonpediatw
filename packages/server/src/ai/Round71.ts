/**
 * 第 71 回合（紅方・刺客）：刺殺選人的輸入——條件邏輯模型（`assassin/AssassinModel.ts`）的「看得到的紅」用梅林看得到的紅。
 *
 * 人類 PR 量尺逐決策拆到紅方局面格（`scripts/redSideStudy67.ts`／`.py`，在第 67–70 回合之後的基準線與真人桌讀法上重跑）：
 * 紅方最大的負格仍是刺殺（基準線 −2.84 ± 0.93、真人桌 −2.18 ± 0.93 pp／局；同一批 1,193 個真人刺殺點真人刺中 44.5%、機器人 39.1／40.3%），
 * 其他負格都小於 0.25 pp／局（紅隊長第 3–5 局的提議、紅方兩紅同隊的任務牌都不負；奧伯倫真人桌只剩第 5 局 −0.20）。
 *
 * 模型的特徵（2026-10-12 擬合）裡「隊上有看得到的紅」「乾淨的隊」「派隊含隊友」用的是**刺客自己的隊友**（`knownEvils`：莫甘娜、莫德雷德），
 * 不是梅林看得到的紅（刺客、莫甘娜、奧伯倫）。梅林的票與派隊跟著他看得到的紅走：隊上只有莫德雷德的隊在梅林眼裡是乾淨的，隊上有奧伯倫的隊不是。
 * 刺殺階段紅方開牌相認（`allEvilRoles`，Edward 2026-10-26），刺客知道梅林看得到誰，所以這是同一份資訊、換成對的參照。
 *
 * `assassinSight71`（位元；0 = 關）：模型特徵的「隊友」改成梅林看得到的紅（全部紅方扣掉莫德雷德與刺客自己；刺客自己另算，梅林也看得到）——
 * 1 = 投票的特徵（隊外投白／隊內投黑給有紅／乾淨的隊）；2 = 派隊的特徵（派隊含隊友的比例、乾淨隊的次數）；4 = 被提議時隊上有看得到的紅的比例。
 * 「紅方隊長選到他」（`pickedByEvilRate`）讀的是紅方知道的事，不改。權重不重新擬合（同一組權重，特徵的意思照模型原本要量的東西）。
 * 沒有 `allEvilRoles`（舊的觀測）時不套用。
 *
 * 第二格：**第 5 局（一定是 2:2）紅方不在隊上、隊上沒有看得到的隊友**的非強制提議（人類 PR 量尺 真人桌 奧伯倫 −0.20 ± 0.05 pp／局）。
 * 這一局任務一張失敗就夠、紅方已兩勝必出失敗（A1），所以隊上只要有一個紅，這隊過了紅方就贏。現行的票：相認紅照「隊上沒有隊友 = 藍方的隊」反對
 * （`redVoteCritical`：藍方已兩勝、隊上沒有看得到的隊友就反對），奧伯倫照忠臣投（真人桌 `oberonNormalVote`）；但相認紅看不到奧伯倫、
 * 奧伯倫看不到任何隊友，「隊上沒有看得到的隊友」不等於「隊上沒有紅」。真人局這一格 3,516 點：紅方自己視角（自己的紅方資訊＋公開紀錄，
 * `bayesTeamClean`）的 P(隊上至少一紅) 分得出隊上實際有沒有紅（AUC 奧伯倫 0.77、相認紅 0.86；≥ 0.9 的點實際有紅 77%／87%）。
 *
 * `redR5Red71 = θ`（0 = 關）：這一格、紅方自己視角 P(隊上至少一紅) ≥ θ 就贊成（隊上的紅會出失敗，這隊過了紅方就贏）；
 * θ = 1 = 只在確定性層（`certaintyFor(obs).minReds`，規則與自己的資訊推得出來的；層級見位元 4）說隊上一定有紅時贊成——盤點 G3「藍方已兩藍不外白全藍的隊」的字面
 * 範圍內（隊上一定有紅就不是全藍的隊；奧伯倫的硬約束 `oberonMatchPoint` 也是這樣判）；θ < 1 會外白「大概有紅、但不確定」的隊，超出 G3 的字面。
 * `redR5Red71Scope`（位元；角色位元都不設 = 1＋2）：1 = 相認紅（刺客、莫甘娜、莫德雷德）；2 = 奧伯倫；4 = θ = 1 時確定性層也用桌上慣例（L1*：A0、A1），
 * 不設 = 只用規則與自己的視野（L0：任務的失敗張數、看得到的隊友、自己的湖）。L1* 的 A1 假設「紅方已兩勝之後，隊上的紅湊得到失敗就會出」，但第 4 局
 * 隊上落單的相認紅和奧伯倫互相看不到（各自照 `redHideR4Solo` 藏），兩個都藏的局 L1* 會推出不在隊上的紅（自我對打 563001 第 544 局就是這樣）。
 * 硬約束（隊長自己的提議、紅方持湖者言行一致、奧伯倫被咬…）在呼叫端之前就處理掉了；強制局不適用。
 */
import type { AgentTuning } from './AgentTuning';
import type { PlayerObservation } from './types';
import type { AssassinSight } from './assassin/AssassinModel';
import { bayesOptionsOf, bayesTeamClean } from './belief/BayesBelief';
import { certaintyFor } from './LogicGates';

/** 診斷計數（研究腳本、自我對打拆解用；不影響決策）。 */
export const round71Stats = { sight: 0, r5Checked: 0, r5White: 0 };

/** `assassinSight71`：模型特徵改讀梅林看得到的紅；關、或沒有紅方開牌的資訊時 undefined（照原本）。 */
export function assassinSight71(tuning: Readonly<AgentTuning>, obs: PlayerObservation): AssassinSight | undefined {
  const parts = tuning.assassinSight71 ?? 0;
  if (parts <= 0 || !obs.allEvilRoles) return undefined;
  const me = obs.myPlayerId;
  const ally = new Set(Object.entries(obs.allEvilRoles).filter(([id, role]) => id !== me && role !== 'mordred').map(([id]) => id));
  round71Stats.sight++;
  return { ally, parts };
}

/** 第 5 局、非強制、紅方、不在隊上、隊上沒有看得到的隊友（範圍照 `redR5Red71Scope`）。 */
export function inR5Cell71(tuning: Readonly<AgentTuning>, obs: PlayerObservation): boolean {
  if ((tuning.redR5Red71 ?? 0) <= 0 || obs.gamePhase !== 'team_vote' || obs.myTeam !== 'evil') return false;
  if ((obs.currentRound ?? 1) !== 5 || (obs.failCount ?? 0) >= 4) return false;
  const scope = ((tuning.redR5Red71Scope ?? 0) & 3) || 3;
  if ((scope & (obs.myRole === 'oberon' ? 2 : 1)) === 0) return false;
  const team = obs.proposedTeam ?? [];
  if (team.includes(obs.myPlayerId) || team.some((id) => obs.knownEvils.includes(id))) return false;
  return true;
}

/** 紅方自己視角 P(隊上至少一紅)（自己的紅方資訊＋公開紀錄；研究腳本也用）。 */
export function ownRedOnTeam71(tuning: Readonly<AgentTuning>, obs: PlayerObservation): number {
  const clean = bayesTeamClean({ ...obs, seatTeam: obs.myTeam }, obs.proposedTeam ?? [], bayesOptionsOf(tuning));
  return clean === null ? 0 : 1 - clean;
}

/** `redR5Red71`：true = 改投贊成；false = 照原本。 */
export function redR5Red71(tuning: Readonly<AgentTuning>, obs: PlayerObservation): boolean {
  if (!inR5Cell71(tuning, obs)) return false;
  round71Stats.r5Checked++;
  const theta = tuning.redR5Red71 ?? 0;
  if (theta >= 1) {
    let min = 0;
    // Bit 4: the table conventions too (L1*: A0 a good lake holder tells the truth, A1 no stalling once red has two fails); off = the rules
    // and this red's own sight only (L0). A1 at L1 assumes every red on an R4 team fails when the reds on it could fail it together, but
    // a lone seeing red and Oberon do not see each other (each hides on a two-fail mission) — so L1* can name a red who is not there.
    const level = ((tuning.redR5Red71Scope ?? 0) & 4) !== 0 ? 'L1*' : 'L0';
    try { min = certaintyFor(obs).minReds(obs.proposedTeam ?? [], level); } catch { min = 0; }
    if (min < 1) return false;
  } else if (ownRedOnTeam71(tuning, obs) < theta) return false;
  round71Stats.r5White++;
  return true;
}
