/**
 * 優化迴圈第 4 回合・紅方的候選（2026-10-29）：反制第 3 回合藍方的「好人看機率投黑」（`goodCleanVote`）。
 *
 * B1 `redCleanLook`：第 3 局起紅方當隊長時，在「隊上紅方剛好夠讓任務失敗」（10 人局第 4 局兩張、其他一張）的隊伍裡，
 *    挑藍方自己估起來最乾淨的那一隊——站在每個可能是藍方的玩家的位置（自己看不到的人：不在 knownEvils、不是自己），
 *    用他們的貝氏信念（同一份公開紀錄、只少了紅方的私人資訊）算「這隊沒有紅」的機率，取平均最高的。
 *    隊伍大小沿用原本流程選的隊。奧伯倫不適用（看不到隊友，湊不出確定的失敗張數）。
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

/** The public view of a seat the red leader takes for blue: the same records, none of red's private knowledge. */
function blueView(obs: PlayerObservation, viewer: string): PlayerObservation {
  return {
    ...obs,
    myPlayerId: viewer,
    myRole: 'loyal',
    myTeam: 'good',
    knownEvils: [],
    knownWizards: undefined,
    myLakeResults: [],
  } as PlayerObservation;
}

/** B1: the team to propose instead, or the pipeline's action unchanged. */
export function redCleanLookTeam(tuning: Readonly<AgentTuning>, obs: PlayerObservation, action: AgentAction): AgentAction {
  if (!tuning.redCleanLook || action.type !== 'team_select') return action;
  if (obs.myTeam !== 'evil' || obs.myRole === 'oberon' || (obs.currentRound ?? 1) < 3) return action;
  const size = action.teamIds.length;
  const me = obs.myPlayerId;
  const mates = obs.knownEvils.filter((id) => id !== me);
  const viewers = obs.allPlayerIds.filter((id) => id !== me && !mates.includes(id));
  const failsNeeded = obs.currentRound === 4 && obs.playerCount >= 7 ? 2 : 1;
  if (mates.length < failsNeeded - 1 || viewers.length < size - failsNeeded) return action;
  const views = viewers.map((v) => blueView(obs, v));
  let best: string[] | null = null;
  let bestScore = -1;
  for (const reds of combinations(mates, failsNeeded - 1)) {
    for (const fill of combinations(viewers, size - failsNeeded)) {
      const team = [me, ...reds, ...fill];
      let sum = 0;
      for (const view of views) sum += bayesTeamClean(view, team) ?? 0;
      const score = sum / views.length;
      if (score > bestScore) { bestScore = score; best = team; }
    }
  }
  return best ? { type: 'team_select', teamIds: best } : action;
}
