/**
 * 第 53 回合（站長 2026-11-19，原話）：
 *
 * > 除了派西 大家都用忠臣資訊 不太可能跟全員忠臣一樣 因為藍方資訊是變強的 (光是確認兩個人一好一壞 就多了很多資訊) 而且 所有人都用忠臣資訊 =
 * > 任務上應該會趨向更容易三藍 如果沒有做到代表忠臣的能力還不夠從完全無資訊局找到全好
 *
 * 「精確挑隊」：隊長（忠臣、派西；E-loyal 裡照忠臣的座位也是忠臣視角）列出所有含自己、人數對的隊，對每一隊算
 * P(這隊沒有紅)，挑最高的。世界集合 = 確定性層的 L1*（遊戲規則、自己的視野——派西的兩根拇指恰好一紅一藍——自己的湖、
 * 好人持湖說實話 A0、兩敗後不拖 A1、還湖 A2；`buildCertainty`）。
 *   - 權重 1（`posterior`）：機器人自己的後驗（世界 × 投票／派隊概似，`bayesTeamClean`，和 `goodCleanLead` 同一個函式）。
 *   - 權重 2（`uniform`）：L1* 的世界一樣重（只用硬規則，不讀任何人的動作）。
 *
 * `exactPick53`（預設 0）：1 = 用後驗、2 = 用均勻權重，在隊長最後的隊上換成 P(沒有紅) 最高的隊（機器人原本的隊已經是最高
 * ——差 1e-9 以內——就不換；同分的隊之間照種子亂數挑）。只換挑隊、不換投票；梅林、紅方座位不用。
 */
import type { AgentAction, PlayerObservation } from './types';
import type { AgentTuning } from './AgentTuning';
import { bayesOptionsOf, bayesTeamClean } from './belief/BayesBelief';
import { buildCertainty } from './belief/Certainty';

export type CleanWeighting = 'posterior' | 'uniform';

function combinations<T>(items: readonly T[], k: number): T[][] {
  const out: T[][] = [];
  const pick = (start: number, acc: T[]): void => {
    if (acc.length === k) { out.push([...acc]); return; }
    for (let i = start; i <= items.length - (k - acc.length); i++) { acc.push(items[i]); pick(i + 1, acc); acc.pop(); }
  };
  pick(0, []);
  return out;
}

/** P(no red) of a team under the weighting; null when there is no world. */
export function teamClean53(obs: PlayerObservation, team: readonly string[], weighting: CleanWeighting, tuning: Readonly<Partial<AgentTuning>>): number | null {
  if (weighting === 'posterior') return bayesTeamClean(obs, team, bayesOptionsOf(tuning));
  const view = buildCertainty(obs);
  const worlds = view.worlds('L1*');
  if (worlds.length === 0) return null;
  const mask = view.maskOf(team);
  let n = 0;
  for (const w of worlds) if ((w & mask) === 0) n++;
  return n / worlds.length;
}

/** Every team of `size` holding the viewer, with its P(no red); null when there is no world. Enumeration order = seat order. */
export function cleanScores53(obs: PlayerObservation, size: number, weighting: CleanWeighting, tuning: Readonly<Partial<AgentTuning>>): { team: string[]; p: number }[] | null {
  const me = obs.myPlayerId;
  const others = obs.allPlayerIds.filter((id) => id !== me);
  if (size < 1 || size - 1 > others.length) return null;
  const out: { team: string[]; p: number }[] = [];
  if (weighting === 'uniform') {
    const view = buildCertainty(obs);
    const worlds = view.worlds('L1*');
    if (worlds.length === 0) return null;
    for (const fill of combinations(others, size - 1)) {
      const team = [me, ...fill];
      const mask = view.maskOf(team);
      let n = 0;
      for (const w of worlds) if ((w & mask) === 0) n++;
      out.push({ team, p: n / worlds.length });
    }
    return out;
  }
  const opts = bayesOptionsOf(tuning);
  for (const fill of combinations(others, size - 1)) {
    const team = [me, ...fill];
    const p = bayesTeamClean(obs, team, opts);
    if (p === null) return null;
    out.push({ team, p });
  }
  return out;
}

const TIE = 1e-9;

/** Whether `exactPick53` applies to this decision (a good loyal / Percival leader's team pick). */
export function exactPick53Applies(tuning: Readonly<Partial<AgentTuning>>, obs: PlayerObservation, action: AgentAction): boolean {
  const mode = tuning.exactPick53 ?? 0;
  if (mode !== 1 && mode !== 2) return false;
  if (action.type !== 'team_select' || obs.myTeam !== 'good') return false;
  return obs.myRole === 'loyal' || obs.myRole === 'percival';
}

/** `exactPick53`: the team with the highest P(no red) (the leader's own team when it already is). */
export function exactPick53Team(tuning: Readonly<Partial<AgentTuning>>, obs: PlayerObservation, action: AgentAction): AgentAction {
  if (!exactPick53Applies(tuning, obs, action) || action.type !== 'team_select') return action;
  const weighting: CleanWeighting = tuning.exactPick53 === 1 ? 'posterior' : 'uniform';
  const scores = cleanScores53(obs, action.teamIds.length, weighting, tuning);
  if (!scores || scores.length === 0) return action;
  const best = Math.max(...scores.map((s) => s.p));
  const mine = action.teamIds.includes(obs.myPlayerId) ? teamClean53(obs, action.teamIds, weighting, tuning) : null;
  if (mine !== null && mine >= best - TIE) return action;
  const top = scores.filter((s) => s.p >= best - TIE);
  const pick = top[Math.min(top.length - 1, Math.floor(Math.random() * top.length))];
  return { type: 'team_select', teamIds: pick.team };
}
