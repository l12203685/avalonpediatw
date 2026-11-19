/**
 * 第 52 回合（站長 2026-11-19，原話）：
 *
 * > 我覺得你訓練的重點可以先放在 1-5 跟 2-5 的尾派上 看強者忠臣還有派西 在 1-5 跟 2-5(第一局開紅/藍 分開看) 會怎麼派 差異是不是很大
 *
 * 真人局（`scripts/tailPickStudy.ts`／`.py`，第 52 回合第 1、2 節）：機器人忠臣在三格的全好隊比例和真人忠臣差不多；最大、最清楚的差在
 * **派西的 2-5（第 1 局任務失敗）**——機器人派西 78% 整隊照派這一局前面的某一個提議（真人派西 23%、強者派西 9.5%），全好隊 30.6%（真人 37.9%）。
 * 派西沒有自己的第 2 局派隊規則（`goodCleanLead` 預設只給忠臣），隊伍來自候選評分＋照派加分（`TeamReuse`：前面被否決的提議也加分）。
 *
 * `tailClean52`（位元，預設 0）：派西在第 1、2 局強制局用 `goodCleanLead` 的派西路徑（P(這隊沒有紅) 最高、照拇指邏輯、邏輯閘門照舊）。
 *   1 = 1-5；2 = 2-5、第 1 局任務失敗；4 = 2-5、第 1 局任務成功。其餘決策點、其他角色不變。
 */
import type { PlayerObservation } from './types';
import type { AgentTuning } from './AgentTuning';

/** 這個決策點的 `tailClean52` 位元（不適用 = 0）。 */
export function tailClean52Bit(obs: PlayerObservation): number {
  if (obs.gamePhase !== 'team_select' || obs.myRole !== 'percival' || obs.myTeam !== 'good') return 0;
  if ((obs.failCount ?? 0) < 4 || obs.currentLeader !== obs.myPlayerId) return 0;
  const round = obs.currentRound ?? 1;
  if (round === 1) return 1;
  if (round === 2) return obs.questResults[0] === 'fail' ? 2 : 4;
  return 0;
}

/** `goodCleanLeadTeam` 用的 tuning：`tailClean52` 在這個決策點適用時，派西也用最乾淨的隊（`goodCleanLead` 位元 2）；否則原樣。 */
export function tailClean52Tuning(tuning: Readonly<AgentTuning>, obs: PlayerObservation): Readonly<AgentTuning> {
  const bits = tuning.tailClean52 ?? 0;
  if (bits <= 0) return tuning;
  const bit = tailClean52Bit(obs);
  if (bit === 0 || (bits & bit) === 0) return tuning;
  return { ...tuning, goodCleanLead: (tuning.goodCleanLead ?? 0) | 2 };
}
