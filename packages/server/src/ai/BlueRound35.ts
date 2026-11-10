/**
 * 優化迴圈第 35 回合・藍方（2026-11-09）。
 *
 * 忠臣照百科〈解讀前人派票 - 延伸、修正、尊重、分類與有意識的派票〉（wiki-24，Edward 11/09 確認的規格）的完整回應（`loyalFlowPick=4`）：
 * 先用角色混合讀人（`beliefRecursive=5`）分類上一位隊長——好／壞 × 有沒有視角（每個人是梅林、派西、紅、奧伯倫的後驗，`bayesRoleShares`）——
 * 再照文章的表回應：
 *   - 認為 2 偏好 ⇒ 2 是梅林 → 認同；2 是派西 → 認同或尊重（取尊重）；2 是忠臣 → 尊重或反對（取尊重；3 家忠臣在 1-2 之後沒有資訊直接認同忠臣）；
 *   - 認為 2 偏壞 ⇒ 一壞派兩好 → 尊重（文章：通常選尊重而非認同）；一壞派隊友 → 反對（修正）；
 *   - 前面每一個提議都看起來錯（每支隊乾淨的機率都很低）→ 從前方派票者排序 G > N > B：把 G 帶進來、不碰 B 與 B 的組合；
 *   - 不派完全反向的隊、不照派這一局的提議（忠臣照派效益低）。
 * 認同＝隊上至少兩個是上一位隊長那一隊的人；尊重＝最多一個；修正＝一個都不留（也不帶他）。在這些條件下挑自己後驗最乾淨的隊；沒有隊符合時依序放寬。
 * 4 = 只在第 1 局（第 34 回合：第 2 局套用時量尺變差；第 1 局成功之後第 2 局照派成功的隊＝認同第 1 局的隊伍資訊，已經是現行規則）；
 * 5 = 再加第 1 局失敗之後的第 2 局（這一局前面有別人的提議時）。
 */
import type { AgentAction, PlayerObservation } from './types';
import type { AgentTuning } from './AgentTuning';
import { bayesOptionsOf, bayesRoleShares, bayesTeamClean } from './belief/BayesBelief';

export type WikiResponse = 'agree' | 'respect' | 'correct';

/** 文章表格的門檻：在「偏好」的條件下，梅林的條件機率夠高才認同。 */
export const WIKI_AGREE_MERLIN = 0.4;
/** 前面每一支隊乾淨的機率都低於這個 → 「前面三家都派錯了」，改用 G > N > B。 */
export const WIKI_ALL_WRONG = 0.1;

export interface LeaderClass { leader: string; red: number; merlinGivenGood: number; percivalGivenGood: number; mateGivenRed: number; response: WikiResponse }

/** 上一位隊長的分類與回應（文章的表）。`mateGivenRed` = 他是紅時，他的隊上有隊友的機率（用世界後驗算：P(紅且隊上另有紅) / P(紅)）。 */
export function classifyLeader(shares: Map<string, { merlin: number; percival: number; red: number; oberon: number }>, leader: string, mateGivenRed: number): LeaderClass {
  const s = shares.get(leader) ?? { merlin: 0, percival: 0, red: 0.5, oberon: 0 };
  const good = Math.max(1e-9, 1 - s.red);
  const merlinGivenGood = s.merlin / good;
  const percivalGivenGood = s.percival / good;
  let response: WikiResponse;
  if (s.red < 0.5) response = merlinGivenGood >= WIKI_AGREE_MERLIN ? 'agree' : 'respect';
  else response = mateGivenRed >= 0.5 ? 'correct' : 'respect';
  return { leader, red: s.red, merlinGivenGood, percivalGivenGood, mateGivenRed, response };
}

/** 忠臣第 1 局的完整 wiki-24 回應；不適用時回傳原本的動作。 */
export function loyalWikiPickTeam(
  tuning: Readonly<AgentTuning>,
  obs: PlayerObservation,
  action: AgentAction,
  allowed: (team: readonly string[]) => boolean = () => true,
): AgentAction {
  if ((tuning.loyalFlowPick ?? 0) < 4 || action.type !== 'team_select' || obs.myRole !== 'loyal' || obs.myTeam !== 'good' || obs.publicLoyalView === true) return action;
  const round = obs.currentRound ?? 1;
  // 4 = 只在第 1 局；5 = 再加第 1 局失敗之後的第 2 局（第 1 局成功之後照派成功的隊＝認同，已經是現行規則）。
  const r2AfterFail = round === 2 && (obs.questResults ?? [])[0] === 'fail';
  if ((obs.failCount ?? 0) >= 4 || !(round === 1 || ((tuning.loyalFlowPick ?? 0) >= 5 && r2AfterFail))) return action;
  const me = obs.myPlayerId;
  const earlier = obs.voteHistory.filter((v) => v.round === round);
  const prevs = earlier.filter((v) => v.leader !== me);
  if (prevs.length === 0) return action;
  const prev = prevs[prevs.length - 1];
  const mixOpts = bayesOptionsOf({ ...tuning, beliefRecursive: 5 });
  const shares = bayesRoleShares(obs, mixOpts);
  if (!shares) return action;
  // 他是紅時，他的隊上另有紅的機率：P(紅) − P(紅且隊上其他人都藍)，用同一個讀法的後驗。
  const others = prev.team.filter((id) => id !== prev.leader);
  const pRed = shares.get(prev.leader)?.red ?? 0.5;
  const pCleanOthers = bayesTeamClean(obs, others, mixOpts) ?? 0.5;
  const pLeaderBlueOthersClean = bayesTeamClean(obs, prev.team, mixOpts) ?? 0.5;
  const pRedAndOthersClean = Math.max(0, pCleanOthers - pLeaderBlueOthersClean);
  const mateGivenRed = pRed > 1e-9 ? Math.min(1, Math.max(0, (pRed - pRedAndOthersClean) / pRed)) : 0;
  const cls = classifyLeader(shares, prev.leader, mateGivenRed);
  const opts = bayesOptionsOf(tuning);
  // 前面每一支隊都看起來錯 → G > N > B。
  const allWrong = prevs.length >= 2 && prevs.every((v) => (bayesTeamClean(obs, v.team, opts) ?? 1) < WIKI_ALL_WRONG);
  let g: string | null = null;
  let b: string | null = null;
  if (allWrong) {
    const ranked = [...new Set(prevs.map((v) => v.leader))].sort((x, y) => (shares.get(x)?.red ?? 0.5) - (shares.get(y)?.red ?? 0.5));
    g = ranked[0];
    b = ranked[ranked.length - 1];
  }
  const bTeam = b ? new Set(prevs.filter((v) => v.leader === b).flatMap((v) => v.team)) : new Set<string>();
  const prevTeam = new Set(prev.team);
  const seen = new Set(earlier.flatMap((v) => v.team).filter((id) => id !== me));
  const keys = new Set(earlier.map((v) => [...v.team].sort().join(',')));
  const size = action.teamIds.length;
  const pool = obs.allPlayerIds.filter((id) => id !== me);
  const cands: { team: string[]; p: number; ok: number }[] = [];
  const pick = (start: number, acc: string[]): void => {
    if (acc.length === size - 1) {
      const team = [me, ...acc];
      const reversed = seen.size > 0 && acc.every((id) => !seen.has(id));
      const same = keys.has([...team].sort().join(','));
      const inPrev = acc.filter((id) => prevTeam.has(id)).length;
      let fits: boolean;
      if (allWrong) fits = (g === null || acc.includes(g)) && !acc.some((id) => bTeam.has(id));
      else if (cls.response === 'agree') fits = inPrev >= 2;
      else if (cls.response === 'respect') fits = inPrev <= 1;
      else fits = inPrev === 0;
      const ok = reversed || same ? 0 : fits ? 2 : 1;
      cands.push({ team, p: bayesTeamClean(obs, team, opts) ?? 0, ok });
      return;
    }
    for (let i = start; i <= pool.length - (size - 1 - acc.length); i++) { acc.push(pool[i]); pick(i + 1, acc); acc.pop(); }
  };
  pick(0, []);
  cands.sort((x, y) => (y.ok - x.ok) || (y.p - x.p > 1e-12 ? 1 : x.p - y.p > 1e-12 ? -1 : 0));
  const best = cands.find((c) => allowed(c.team));
  return best ? { type: 'team_select', teamIds: best.team } : action;
}
