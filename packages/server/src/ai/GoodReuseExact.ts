/**
 * 忠臣／派西照派成功的隊（優化迴圈第 24 回合・藍方；Edward 2026-11-03 練習台標記，`AgentTuning.goodReuseExact`）。
 *
 * > 為什麼沒有照派 2890？這不是第二局已經過的組合嗎？（第 2 局 2、8、9、0 成功，第 3 局同樣 4 人，隊長 1 號忠臣派 1、2、8、9——把自己換進去，被否決）
 * > 2890 已經成功過，應該要優先認為 0 是梅林才合理吧（同一局派西 2 號看到 7、0，0 在成功的隊上，機器人卻派 2、7、8、9）。
 *
 * 正式流程（`ForwardAgent`）的隊長一定在自己的隊上，忠臣的「最乾淨的隊」（`goodCleanLead`）也一定放自己（自己對自己是確定的藍），
 * 所以「照派上一局成功、自己不在上面的隊」做不出來；真人牌譜裡成功之後的第一個提議 73.8% 整隊保留（`TeamReuse.ts`），隊長不在那一隊的多半照原樣派、不把自己放進去。
 *
 * 規則（忠臣、派西當隊長；上一局任務成功而且沒有失敗牌；這一局還沒有人派過、被否決過那一隊）：
 *   1 = 隊長不在那一隊：人數相同 → 照原樣派；多一人 → 那一隊＋自己；
 *   2 = 1 ＋ 隊長在那一隊上、人數相同 → 照原樣派（派西不再拿另一根拇指換掉成功隊上的那一根）。
 * 照派的隊仍然要過好人的邏輯閘門（必定失敗／被支配的隊，`allowed`）、照派的守門（`TeamReuse.teamReuseGuard`：湖的硬1／硬2、隊長當成紅的人），
 * 也要守住隊長自己湖的宣告（`goodVouchFollowUp`：自己宣藍的人要在隊上、宣紅的人不能在）。不適用時回傳原本的動作。
 */
import type { AgentAction, PlayerObservation } from './types';
import type { AgentTuning } from './AgentTuning';
import { teamReuseGuard } from './TeamReuse';
import { goodVouchTeamConstraint } from './GoodLakeFollowUp';

export function goodReuseExactTeam(
  tuning: Readonly<AgentTuning>,
  obs: PlayerObservation,
  action: AgentAction,
  allowed: (team: readonly string[]) => boolean = () => true,
): AgentAction {
  const mode = tuning.goodReuseExact ?? 0;
  if (mode <= 0 || action.type !== 'team_select' || obs.myTeam !== 'good') return action;
  // Round 26 `merlinReuseExact`: Merlin re-proposes the successful team the same way when it holds no red he sees — what a loyal with
  // the same public record does (assassinReuseRead=11 reads "Merlin skipped a clean successful team" as Merlin-like: ×1.38).
  const merlin = obs.myRole === 'merlin' && tuning.merlinReuseExact === true;
  if (obs.myRole !== 'loyal' && obs.myRole !== 'percival' && !merlin) return action;
  const round = obs.currentRound ?? 1;
  if (round < 2) return action;
  const last = obs.questHistory.find((q) => q.round === round - 1);
  if (!last || obs.questResults[round - 2] !== 'success' || (last.failCount ?? 0) > 0) return action;
  // Round 30 `goodReuseNoMatchPoint` (BlueRound30.ts): red has two fails (R5, or R4 after an R3 success) — the next fail loses, Merlin's
  // norm and the assassin's re-proposal read stop there, and the exact re-proposal is less clean than the leader's own cleanest team
  // (self-play R5: 79.7% vs 93.5%; human games 40.9% vs 63.1%) → keep the pipeline's team.
  if (tuning.goodReuseNoMatchPoint === true && obs.questResults.filter((r) => r === 'fail').length >= 2) return action;
  const me = obs.myPlayerId;
  const size = action.teamIds.length;
  const on = last.team.includes(me);
  let team: string[] | null = null;
  if (!on && last.team.length === size) team = [...last.team];
  else if (!on && last.team.length + 1 === size) team = [me, ...last.team];
  else if (on && mode >= 2 && last.team.length === size) team = [...last.team];
  if (!team) return action;
  if (merlin && team.some((id) => obs.knownEvils.includes(id))) return action;
  const key = [...team].sort().join(',');
  if (obs.voteHistory.some((v) => v.round === round && [...v.team].sort().join(',') === key)) return action;
  if ([...action.teamIds].sort().join(',') === key || !allowed(team)) return action;
  // The leader keeps its own lake word, and the reuse guard (lake hard rules, seats it treats as red) binds as on any reuse.
  if (tuning.goodVouchFollowUp) {
    const c = goodVouchTeamConstraint(obs);
    if (c && (c.banned.some((id) => team!.includes(id)) || c.required.some((id) => !team!.includes(id)))) return action;
  }
  if (!teamReuseGuard(obs)(team)) return action;
  return { type: 'team_select', teamIds: team };
}
