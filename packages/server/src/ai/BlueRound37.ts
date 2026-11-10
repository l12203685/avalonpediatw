/**
 * 優化迴圈第 37 回合・藍方（2026-11-10）。
 *
 * Edward 11/10：「梅林太好抓的根因＝忠臣接受／釋放／傳遞自己視角的能力太弱」。量測（docs/ai/optimization_loop.md 第 37 回合）：
 * 自我對打裡忠臣第 2 局的提議幾乎是同一支隊（兩位忠臣的隊平均重疊 2.32 人；真人強者 1.17 人，和各派各的一樣），所以一個梅林看得到的紅
 * 被第一位派進去，後面的忠臣全部跟著髒，梅林是唯一沒跟的人（刺客的第二層分層只剩梅林：第 1 局失敗的局 21%，真人 12.5%）。
 *
 *   - `loyalR2View`：第 1 局失敗之後的第 2 局，忠臣（2、4 加派西）非強制的提議照 wiki-24 回應上一任隊長，派「自己的視角」：
 *     上一任看起來紅（自己後驗 ≥ 0.5）→ 修正，他隊上的人（含他）一個都不留；否則尊重，他隊上的人（含他）最多留 1 人（3、4 = 最多 2 人）；
 *     不照派這一局出現過的隊、不派和這一局前面完全反向的隊；在這些條件裡挑自己後驗最乾淨的隊。沒有符合的隊時依序放寬。
 *   - `percivalThumbSure=θ`：派西第 2 局起只放自己後驗裡「是梅林」的機率 ≥ θ 的拇指；隊上有分不出來的拇指時改派不含它、自己後驗最乾淨的隊
 *     （整支照派成功任務的隊不動）。
 * 兩個都預設關。
 */
import type { AgentAction, PlayerObservation } from './types';
import type { AgentTuning } from './AgentTuning';
import { bayesOptionsOf, bayesRedShare, bayesTeamClean } from './belief/BayesBelief';

type Allowed = (team: readonly string[]) => boolean;

function combos<T>(items: readonly T[], k: number): T[][] {
  const out: T[][] = [];
  const pick = (start: number, acc: T[]): void => {
    if (acc.length === k) { out.push([...acc]); return; }
    for (let i = start; i <= items.length - (k - acc.length); i++) { acc.push(items[i]); pick(i + 1, acc); acc.pop(); }
  };
  pick(0, []);
  return out;
}

/** 第 1 局失敗之後的第 2 局、非強制。 */
export function r2AfterR1Fail(obs: PlayerObservation): boolean {
  return (obs.currentRound ?? 1) === 2 && (obs.questResults ?? [])[0] === 'fail' && (obs.failCount ?? 0) < 4;
}

/** `loyalR2View`：見檔頭。不適用時回傳原本的動作（同一個物件）。 */
export function loyalR2ViewTeam(tuning: Readonly<AgentTuning>, obs: PlayerObservation, action: AgentAction, allowed: Allowed = () => true): AgentAction {
  const mode = tuning.loyalR2View ?? 0;
  if (!(mode > 0) || action.type !== 'team_select' || obs.myTeam !== 'good' || obs.publicLoyalView === true) return action;
  const withPercival = mode === 2 || mode === 4;
  if (!(obs.myRole === 'loyal' || (withPercival && obs.myRole === 'percival'))) return action;
  if (!r2AfterR1Fail(obs)) return action;
  const me = obs.myPlayerId;
  const earlier = obs.voteHistory.filter((v) => v.round === 2);
  const prevs = earlier.filter((v) => v.leader !== me);
  if (prevs.length === 0) return action;
  const prev = prevs[prevs.length - 1];
  const keep = mode >= 3 ? 2 : 1;
  const size = action.teamIds.length;
  const opts = bayesOptionsOf(tuning);
  const share = bayesRedShare(obs, opts);
  const correct = (share.get(prev.leader) ?? 0.5) >= 0.5;
  const prevTeam = new Set(prev.team.filter((id) => id !== me));
  const seen = new Set(earlier.flatMap((v) => v.team).filter((id) => id !== me));
  const keys = new Set(earlier.map((v) => [...v.team].sort().join(',')));
  const others = obs.allPlayerIds.filter((id) => id !== me);
  const cands: { team: string[]; p: number; ok: number }[] = [];
  for (const fill of combos(others, size - 1)) {
    const team = [me, ...fill];
    const inPrev = fill.filter((id) => prevTeam.has(id)).length;
    const reversed = seen.size > 0 && fill.every((id) => !seen.has(id));
    const same = keys.has([...team].sort().join(','));
    let ok = 0;
    if (!reversed && !same) ok = (correct ? inPrev === 0 : inPrev <= keep) ? 2 : 1;
    const p = bayesTeamClean(obs, team, opts);
    if (p === null) return action;
    cands.push({ team, p, ok });
  }
  cands.sort((a, b) => (b.ok - a.ok) || (b.p - a.p > 1e-12 ? 1 : a.p - b.p > 1e-12 ? -1 : 0));
  const best = cands.find((c) => allowed(c.team));
  if (!best) return action;
  const cur = [...action.teamIds].sort().join(',');
  return [...best.team].sort().join(',') === cur ? action : { type: 'team_select', teamIds: best.team };
}

/** `percivalThumbSure`：見檔頭。不適用時回傳原本的動作（同一個物件）。 */
export function percivalThumbSureTeam(tuning: Readonly<AgentTuning>, obs: PlayerObservation, action: AgentAction, allowed: Allowed = () => true): AgentAction {
  const theta = tuning.percivalThumbSure ?? 0;
  if (!(theta > 0) || action.type !== 'team_select' || obs.myRole !== 'percival' || obs.myTeam !== 'good' || obs.publicLoyalView === true) return action;
  const thumbs = obs.knownWizards ?? [];
  if (thumbs.length !== 2 || (obs.currentRound ?? 1) < 2) return action;
  const opts = bayesOptionsOf(tuning);
  const share = bayesRedShare(obs, opts);
  const unsure = thumbs.filter((id) => 1 - (share.get(id) ?? 0.5) < theta);
  if (!action.teamIds.some((id) => unsure.includes(id))) return action;
  // 整支照派成功任務的隊：常態，不動。
  const round = obs.currentRound ?? 1;
  const results = obs.questResults ?? [];
  if (obs.questHistory.some((q) => q.round < round && results[q.round - 1] === 'success' && q.team.every((id) => action.teamIds.includes(id)))) return action;
  const me = obs.myPlayerId;
  const pool = obs.allPlayerIds.filter((id) => id !== me && !unsure.includes(id));
  const size = action.teamIds.length;
  if (pool.length < size - 1) return action;
  let best: { team: string[]; p: number } | null = null;
  for (const fill of combos(pool, size - 1)) {
    const team = [me, ...fill];
    if (!allowed(team)) continue;
    const p = bayesTeamClean(obs, team, opts);
    if (p === null) return action;
    if (!best || p - best.p > 1e-12) best = { team, p };
  }
  return best ? { type: 'team_select', teamIds: best.team } : action;
}
