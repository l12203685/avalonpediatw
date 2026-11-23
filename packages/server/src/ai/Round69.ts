/**
 * 第 69 回合（紅方）：第 67 回合量到的最大紅方落差那一格——相認紅（刺客、莫甘娜、莫德雷德）**第 3 局、紅方已兩勝、不在隊上、隊上有看得到的隊友**的票
 * （人類 PR 量尺 −1.30 ± 0.09 pp／局、3,830 個決策點；高端桌 −1.19 ± 0.21）。站長 2026-11-23：「做（第 69 回合單做這格）」。
 *
 * 這隊過了，隊友出失敗（A1：紅方已兩勝必出失敗）紅方就贏，所以外白只有在「這隊過不了、外白的人被看到」時才有代價。
 * 現行的關鍵隊外白（第 16 回合 `redKeyWhite=1`，`RedVoteCamouflage.redKeyWhiteVote`）估「這隊過不過得了」時只算隊上的人（隊上的藍方照 `goodKeyVote`
 * 門檻）和不在隊上的紅，**不在隊上的藍方一律當反對**；湊不到過半就照忠臣投（反對）。第 65 回合的「跟著大家外白」`redCrowdWhite65` 是在全部第 3 局起的
 * 隊外票上做的（三把尺都不過）；這一格只動紅方已兩勝、隊友在隊上的關鍵隊。
 *
 * 真人局這一格 3,884 點（`scripts/redSideStudy69.ts`）：其他人實際的贊成數 ≥ 5（自己這一票決定、或不管自己都過）第 1、2 次提議 7–11%、第 3 次 22%、
 * **第 4 次（強制局之前的最後一次）56%**；真人在第 4 次贊成 56.5%（高端桌 63.6%），機器人 6.9%。公開視角的忠臣後驗在這一格幾乎都說「有紅」
 * （不在隊上的藍方 P(乾淨) ≥ 0.3 平均 0.11 人，真人實際贊成 0.30 人），所以只靠公開後驗估贊成數抓不到桌上「快到強制局、大家放行」的票。
 *
 * `redKeyCrowd69`（位元；0 = 關）：在這一格、`redKeyWhite` 說不外白時——
 * - 1 = 第 4 次提議外白（不估贊成數：這隊過了紅方就贏；過不了下一隊就是強制局）；
 * - 2 = 第 3 次提議也外白；
 * - 4 = 其他提議估贊成數：隊上的贊成（同 `redKeyWhite`）＋不在隊上的紅（含自己）＋不在隊上、站在那個座位（同一份公開紀錄、藍方的讀法 `bayesTeamClean`）
 *   估「這隊沒有紅」≥ τ（`redKeyCrowd69Tau`，0 = 0.5）的藍方 ≥ 過半就外白（讀的是隊伍組合在公開紀錄上的樣子，站長 11/19「外白內黑傾向 還是要建立在
 *   對組合的解讀上 不是硬白硬黑」；只用投票前的公開紀錄，不看別人這一次的票）；
 * - 8 = 尾家（第 5 次的隊長）是看得到的紅（含自己）時不適用（強制局紅方自己派隊就贏，現在外白只會被看到）；
 * - 16 = 第 4、5 局（紅方已兩勝）也適用（只量）。
 * 硬約束（隊長自己的提議、奧伯倫、紅方持湖者言行一致…）在呼叫端之前就處理掉了；奧伯倫看不到隊友，不在範圍內。
 */
import type { AgentTuning } from './AgentTuning';
import type { PlayerObservation } from './types';
import { bayesOptionsOf, bayesTeamClean } from './belief/BayesBelief';
import { tailLeaderOf } from './GoodVoteAlt';

/** 診斷計數（研究腳本、自我對打拆解用；不影響決策）。 */
export const round69Stats = { checked: 0, white: 0 };

/** 這個座位的公開視角（同一份紀錄，沒有紅方的私人資訊）。 */
function publicView(obs: PlayerObservation, viewer: string): PlayerObservation {
  return { ...obs, myPlayerId: viewer, myRole: 'loyal', myTeam: 'good', knownEvils: [], knownWizards: undefined, allEvilIds: undefined, myLakeResults: [] } as PlayerObservation;
}

export interface KeyCrowdEstimate69 {
  /** 隊上算贊成的人數：看得到的紅都贊成；其他人站在自己的座位估「這隊沒有紅」≥ `goodKeyVote` 門檻才算（同 `redKeyWhiteVote`）。 */
  onYes: number;
  /** 隊上不是看得到的紅的人數。 */
  onBlue: number;
  /** 不在隊上的看得到的紅（含自己）。 */
  offReds: number;
  /** 不在隊上、看不到是紅的人，各自的公開視角 P(這隊沒有紅)，由大到小。 */
  offBlueP: number[];
}

/** 紅方視角的贊成估計（只用投票前的公開紀錄；研究腳本也用）。 */
export function keyCrowdEstimate69(tuning: Readonly<AgentTuning>, obs: PlayerObservation): KeyCrowdEstimate69 {
  const me = obs.myPlayerId;
  const reds = new Set([me, ...obs.knownEvils]);
  const team = obs.proposedTeam ?? [];
  const keyTau = tuning.goodKeyVote > 0 ? tuning.goodKeyVote : 0.5;
  const opts = bayesOptionsOf(tuning);
  let onYes = 0;
  let onBlue = 0;
  let offReds = 0;
  const offBlueP: number[] = [];
  for (const id of obs.allPlayerIds) {
    const on = team.includes(id);
    if (reds.has(id)) { if (on) onYes++; else offReds++; continue; }
    const p = bayesTeamClean(publicView(obs, id), team, opts) ?? 0;
    if (on) { onBlue++; if (p >= keyTau) onYes++; } else offBlueP.push(p);
  }
  offBlueP.sort((a, b) => b - a);
  return { onYes, onBlue, offReds, offBlueP };
}

/** 這一格（相認紅、紅方已兩勝、非強制、不在隊上、隊上有看得到的隊友；局照位元 16、尾家照位元 8）。 */
export function inKeyCrowdCell69(tuning: Readonly<AgentTuning>, obs: PlayerObservation): boolean {
  const bits = tuning.redKeyCrowd69 ?? 0;
  if (bits <= 0 || obs.gamePhase !== 'team_vote' || obs.myTeam !== 'evil' || obs.myRole === 'oberon') return false;
  const round = obs.currentRound ?? 1;
  if (round < 3 || (round > 3 && (bits & 16) === 0)) return false;
  if ((obs.failCount ?? 0) >= 4) return false;
  if ((obs.questResults ?? []).filter((r) => r === 'fail').length < 2) return false;
  const team = obs.proposedTeam ?? [];
  if (team.includes(obs.myPlayerId) || !team.some((id) => obs.knownEvils.includes(id))) return false;
  if ((bits & 8) !== 0) {
    const tail = tailLeaderOf(obs);
    if (tail !== null && (tail === obs.myPlayerId || obs.knownEvils.includes(tail))) return false;
  }
  return true;
}

/** `redKeyCrowd69`：true = 改投贊成（關鍵隊外白）；false = 照原本。 */
export function redKeyCrowd69(tuning: Readonly<AgentTuning>, obs: PlayerObservation): boolean {
  if (!inKeyCrowdCell69(tuning, obs)) return false;
  const bits = tuning.redKeyCrowd69 ?? 0;
  round69Stats.checked++;
  const fc = obs.failCount ?? 0;
  if (((bits & 1) !== 0 && fc === 3) || ((bits & 2) !== 0 && fc === 2)) { round69Stats.white++; return true; }
  if ((bits & 4) === 0) return false;
  const tau = (tuning.redKeyCrowd69Tau ?? 0) || 0.5;
  const e = keyCrowdEstimate69(tuning, obs);
  const majority = Math.floor(obs.playerCount / 2) + 1;
  const yes = e.onYes + e.offReds + e.offBlueP.filter((p) => p >= tau).length;
  if (yes < majority) return false;
  round69Stats.white++;
  return true;
}
