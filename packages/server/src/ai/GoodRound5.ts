/**
 * 優化迴圈第 5 回合・藍方的候選（2026-10-29）：拉任務勝率（Edward 10/29：會玩的真人桌任務勝率 55–58%，機器人約 40%）。
 *
 * 任務階段診斷（scripts/missionDiagnosis.ts，第 4 回合 B1 之後 400 局）：第 3 局任務成功 34%（真人 45%），
 * 出任務的隊三成五是紅隊長派的。藍方能直接控制的是自己當隊長時派的隊。
 *
 * L5 `goodCleanLead`（分角色：1 = 忠臣、2 = 派西、3 = 兩者）：第 2 局起藍方當隊長，派自己＋（隊伍人數 − 1）個人裡
 *    「這隊沒有紅」後驗機率最高的那一隊（世界 × 真人動作概似，`bayesTeamClean`；派西用拇指邏輯）——原本的流程用每個人
 *    的紅方機率分別打分數，會漏掉「A、B 兩個裡剛好一個紅」這種相關。第 1 局沒有資訊、照原規則。梅林看得到紅，不用這條。
 */
import type { AgentAction, PlayerObservation } from './types';
import type { AgentTuning } from './AgentTuning';
import { bayesTeamClean } from './belief/BayesBelief';

function combinations<T>(items: readonly T[], k: number): T[][] {
  const out: T[][] = [];
  const pick = (start: number, acc: T[]): void => {
    if (acc.length === k) { out.push([...acc]); return; }
    for (let i = start; i <= items.length - (k - acc.length); i++) { acc.push(items[i]); pick(i + 1, acc); acc.pop(); }
  };
  pick(0, []);
  return out;
}

/** L5: the leader's cleanest team (same size as the pipeline's), or the action unchanged. */
export function goodCleanLeadTeam(tuning: Readonly<AgentTuning>, obs: PlayerObservation, action: AgentAction): AgentAction {
  const scope = tuning.goodCleanLead ?? 0;
  if (scope <= 0 || action.type !== 'team_select' || obs.myTeam !== 'good') return action;
  const loyal = obs.myRole === 'loyal' && (scope & 1) !== 0;
  const percival = obs.myRole === 'percival' && (scope & 2) !== 0;
  if (!loyal && !percival) return action;
  // R1: only with `r1ReadPrior` and an earlier proposal on the table to read (1-2 onwards).
  const round = obs.currentRound ?? 1;
  if (round < 2 && !(tuning.r1ReadPrior && obs.voteHistory.some((v) => v.round === 1))) return action;
  const me = obs.myPlayerId;
  const others = obs.allPlayerIds.filter((id) => id !== me);
  const size = action.teamIds.length;
  const opts = { thumbRoles: tuning.bayesThumbRoles === true, strictMerlin: tuning.percivalThumbLogic === true, merlinMixture: tuning.loyalMerlinRead ?? 0, zoneMerlin: tuning.merlinZoneSignal === true, merlinEarlyStrict: tuning.merlinLoyalStyle === true };
  let best: string[] | null = null;
  let bestP = -1;
  for (const fill of combinations(others, size - 1)) {
    const team = [me, ...fill];
    const p = bayesTeamClean(obs, team, opts);
    if (p === null) return action;
    if (p > bestP + 1e-12) { bestP = p; best = team; }
  }
  return best ? { type: 'team_select', teamIds: best } : action;
}
