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
import { bayesOptionsOf, bayesTeamClean } from './belief/BayesBelief';
import { currentLakeHolder, failsRequired47, lakeAfterThisRound, lakePlanValue47, overlay47, teamRedsBelow47, weightedWorlds47 } from './BlueRound47';

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
export function goodCleanLeadTeam(
  tuning: Readonly<AgentTuning>,
  obs: PlayerObservation,
  action: AgentAction,
  allowed: (team: readonly string[]) => boolean = () => true,
): AgentAction {
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
  const opts = bayesOptionsOf(tuning);
  const scored: { team: string[]; p: number }[] = [];
  // 第 36 回合 `percivalCleanNoThumbs`：派西挑最乾淨的隊時兩根拇指都不放（不把梅林指出來、也不賭莫甘娜）；沒有這樣的隊時照原本的候選。
  // `percivalCleanNoThumbsEarly`：只在第 1、2 局（梅林破綻「只有梅林沒派過看得到的紅」看的是第 1、2 局的提議）。
  const noThumbs = tuning.percivalCleanNoThumbs === true || (tuning.percivalCleanNoThumbsEarly === true && round <= 2);
  const thumbs = percival && noThumbs && (obs.knownWizards ?? []).length === 2 ? obs.knownWizards ?? [] : [];
  const pool = thumbs.length > 0 && others.filter((id) => !thumbs.includes(id)).length >= size - 1 ? others.filter((id) => !thumbs.includes(id)) : others;
  // Round 47 (BlueRound47.ts): public-record overlays on the posterior's worlds, the R4 two-fail objective, lake planning — all off by default.
  const adj = overlay47(tuning, obs);
  const need = (tuning.goodCleanLeadR4Fix47 ?? 0) > 0 ? failsRequired47(obs) : 1;
  // Round 49 `goodCleanLeadR4Fix49`: clean stays the objective; P(fewer than the fails needed) is only a floor (within ε of its best).
  const floorEps = (tuning.goodCleanLeadR4Fix49 ?? 0) > 0 && failsRequired47(obs) > 1 ? tuning.goodCleanLeadR4Fix49 : 0;
  const plan = (tuning.lakePlanLead47 ?? 0) > 0 && lakeAfterThisRound(obs) && currentLakeHolder(obs) === me;
  const ww = adj.size > 0 || need > 1 || plan || floorEps > 0 ? weightedWorlds47(obs, opts, adj) : null;
  for (const fill of combinations(pool, size - 1)) {
    const team = [me, ...fill];
    const p = ww ? teamRedsBelow47(ww, team, need) : bayesTeamClean(obs, team, opts);
    if (p === null) return action;
    scored.push({ team, p });
  }
  if (floorEps > 0 && ww) {
    // The two-fail floor: drop the teams whose P(fewer than the fails needed) is more than ε below the best allowed one.
    const k = failsRequired47(obs);
    const below = new Map(scored.map((c) => [c, teamRedsBelow47(ww, c.team, k)]));
    const top = Math.max(...scored.filter((c) => allowed(c.team)).map((c) => below.get(c) ?? 0));
    for (let i = scored.length - 1; i >= 0; i--) if ((below.get(scored[i]) ?? 0) < top - floorEps) scored.splice(i, 1);
  }
  // Highest first (stable: enumeration order breaks ties); the logic gates (must-fail / dominated) still bind.
  scored.sort((x, y) => (y.p - x.p > 1e-12 ? 1 : x.p - y.p > 1e-12 ? -1 : 0));
  const best = scored.find((c) => allowed(c.team));
  if (best && plan && ww) {
    // `lakePlanLead47`: among the allowed teams within ε of the best, the one whose mission result leaves the most for the lake.
    const eps = tuning.lakePlanLead47;
    let pick = best;
    let value = lakePlanValue47(ww, obs, best.team);
    for (const c of scored) {
      if (c.p < best.p - eps) break;
      if (c === best || !allowed(c.team)) continue;
      const v = lakePlanValue47(ww, obs, c.team);
      if (v > value + 1e-12) { pick = c; value = v; }
    }
    return { type: 'team_select', teamIds: pick.team };
  }
  return best ? { type: 'team_select', teamIds: best.team } : action;
}
