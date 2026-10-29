/**
 * 梅林照忠臣的方式派票（優化迴圈第 5 回合・梅林，Edward 2026-10-29；`AgentTuning.merlinLoyalStyle`）：
 *
 * > 梅林派票並非「只能切區間」或是「只能派可見紅方躲刺」——梅林應該是隨著局勢發展，跟場上所有忠臣做一樣的事。
 *
 * 〈梅林資訊與雜魚視角的同步〉：先透過雜魚視角找出合理的故事線，再配合內建視角選出最能符合雜魚視角的那一條。
 * 實作：梅林當隊長時，用「只看公開紀錄的忠臣」（自己的座位、沒有私人資訊）的貝氏信念算每支隊「沒有紅」的機率，
 * 在隊上沒有他看得到的紅的隊伍裡挑最高的那支；同分時看延伸／修正與切區間（`ZoneModel`）。
 * 忠臣、派西讀「可能是梅林的人」的派票：一支合理的隊、而且不會有他看得到的紅（`BayesOptions.merlinEarlyStrict`）。
 */
import type { AgentAction, PlayerObservation } from './types';
import type { AgentTuning } from './AgentTuning';
import { bayesTeamClean } from './belief/BayesBelief';
import { merlinSignalScore } from './belief/ZoneModel';

function combinations<T>(items: readonly T[], k: number): T[][] {
  const out: T[][] = [];
  const pick = (start: number, acc: T[]): void => {
    if (acc.length === k) { out.push([...acc]); return; }
    for (let i = start; i <= items.length - (k - acc.length); i++) { acc.push(items[i]); pick(i + 1, acc); acc.pop(); }
  };
  pick(0, []);
  return out;
}

/** Merlin's loyal-style team, or the action unchanged. */
export function merlinLoyalStyleTeam(tuning: Readonly<AgentTuning>, obs: PlayerObservation, action: AgentAction): AgentAction {
  if (!tuning.merlinLoyalStyle || action.type !== 'team_select' || obs.myRole !== 'merlin') return action;
  const me = obs.myPlayerId;
  const seen = new Set(obs.knownEvils);
  const pool = obs.allPlayerIds.filter((id) => id !== me && !seen.has(id));
  const size = action.teamIds.length;
  if (pool.length < size - 1) return action;
  // The public loyal view of my own seat: the same records, none of Merlin's sight.
  const publicView = { ...obs, myRole: 'loyal', knownEvils: [], knownWizards: undefined, myLakeResults: [] } as PlayerObservation;
  const prior = obs.voteHistory.filter((p) => p.round <= 2 && p.leader !== me).map((p) => ({ leader: p.leader, team: p.team }));
  let best: string[] | null = null;
  let bestScore = -Infinity;
  for (const fill of combinations(pool, size - 1)) {
    const team = [me, ...fill];
    const p = bayesTeamClean(publicView, team) ?? 0;
    // Loyal plausibility first; the extension / correction / zone signal only breaks near-ties.
    const score = Math.log(Math.max(p, 1e-12)) + 0.05 * merlinSignalScore(obs.allPlayerIds, team, seen, prior, me);
    if (score > bestScore) { bestScore = score; best = team; }
  }
  return best ? { type: 'team_select', teamIds: best } : action;
}
