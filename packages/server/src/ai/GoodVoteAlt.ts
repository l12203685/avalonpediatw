/**
 * 第 26 回合藍方：「否決的價值」——每一個提議都可能出任務（Edward 2026-11-04：「沒有所謂『注定被否決』」）。
 *
 * 強者量尺（docs/ai/strong_metrics.md 第 5 節）差距第 1 名：第 3、4 局藍方在隊上、忠臣視角這隊乾淨 10–30% 時，強者贊成約 90%，
 * 機器人 32–45%；第 3 局起藍方內黑率 強者 25% 對機器人 56%，內黑準度 80% 對 74%。真人局重播（第 26 回合 `r26_gap1`）：機器人在隊上的
 * 內黑全部來自 `goodKeyVote`（關鍵局後驗 < 0.5）與 `goodCleanVote`（後驗 < 0.45）——兩條都是「和一個固定門檻比」，
 * 不看否決之後會出什麼隊。否決之後下一個隊長派隊；第 4 次提議被否決，強制局的隊長（尾家）派的隊一定出任務。
 *
 * 這裡的比較：P(這隊乾淨) 對上 max_{T ∋ 下一任隊長, |T| = k} P(T 乾淨)（同一個後驗）。含下一任隊長的隊乾淨就表示下一任隊長是藍，
 * 所以這個值已經乘上「下一任隊長是藍」的機率：下一任隊長很可能是紅時，否決換來的隊幾乎一定有紅。
 *   - `goodVoteAlt`（λ；忠臣／派西，在隊上、第 3 局起、非強制）：門檻規則要投黑，但這隊 ≥ λ × 下一任隊長能派的最乾淨的隊 → 改投白。
 *   - `loyalTailWhite`（τ；只有真的忠臣，D3 第一階段）：第 1–4 次提議、任何一局，尾家是紅的機率 ≥ τ、這隊 ≥ λ × 尾家能派的最乾淨的隊 → 投白
 *     （在隊上、不在隊上都一樣——不在隊上就是外白）。
 * 兩條都只會把黑改成白，而且不越過好人投票關卡（必敗、被支配的隊；第 1、2 局也檢查確定性層的必敗）。
 *   - `mpTailWhite`（第 28 回合，D3 第二階段）：梅林／派西只在同一座位、只看公開紀錄的忠臣也會開的時候開（`mpTailWhiteNow`）。
 */
import type { AgentTuning } from './AgentTuning';
import type { PlayerObservation } from './types';
import { bayesOptionsOf, bayesRedShare, bayesTeamClean, type BayesOptions } from './belief/BayesBelief';

/** 第 a 次提議之後的隊長：offset 1 = 下一任，4 − failCount = 尾家（強制局的隊長）。 */
export function leaderAhead(obs: PlayerObservation, offset: number): string | null {
  const ids = obs.allPlayerIds;
  const lead = ids.indexOf(obs.currentLeader ?? '');
  if (lead < 0 || ids.length === 0) return null;
  return ids[(lead + offset) % ids.length];
}

/** 尾家（第 5 次強制提議的隊長）；已經是強制局時 null。 */
export function tailLeaderOf(obs: PlayerObservation): string | null {
  const fc = obs.failCount ?? 0;
  if (fc >= 4) return null;
  return leaderAhead(obs, 4 - fc);
}

/**
 * max_{T ∋ leader, |T| = k} P(T 乾淨)：`leader` 能派的最乾淨的隊（觀察者的後驗）。含 leader 的隊乾淨 ⇒ leader 是藍，
 * 所以這個值 ≤ 1 − P(leader 紅)。觀察者自己永遠是確定的藍。
 */
export function bestCleanWith(obs: PlayerObservation, leader: string, k: number, opts: Readonly<BayesOptions>): number | null {
  const ids = obs.allPlayerIds;
  if (k <= 0 || k > ids.length || !ids.includes(leader)) return null;
  const share = bayesRedShare(obs, opts);
  // 候選：leader ＋ 其他人裡挑 k − 1 個。人數不多（10 人局最多 C(9, 4) = 126），全部列舉。
  const others = ids.filter((id) => id !== leader);
  let best: number | null = null;
  const pick: string[] = [];
  const rec = (start: number): void => {
    if (pick.length === k - 1) {
      const p = bayesTeamClean(obs, [leader, ...pick], opts);
      if (p !== null && (best === null || p > best)) best = p;
      return;
    }
    for (let i = start; i <= others.length - (k - 1 - pick.length); i++) {
      pick.push(others[i]);
      rec(i + 1);
      pick.pop();
    }
  };
  // 依嫌疑排序後只取最乾淨的 min(8, n − 1) 人列舉（C(8, 4) = 70）。
  others.sort((a, b) => (share.get(a) ?? 0.5) - (share.get(b) ?? 0.5));
  others.length = Math.min(others.length, 8);
  rec(0);
  return best;
}

/**
 * `goodVoteAlt`：門檻規則（`goodCleanVote`／`goodKeyVote`）要投黑時，改投白嗎。`p` = 這隊乾淨的機率（同一個後驗）。
 * 忠臣／派西（梅林照忠臣投票時也走這裡）、在隊上、第 3 局起、非強制。
 */
export function goodVoteAltKeeps(tuning: Readonly<AgentTuning>, obs: PlayerObservation, p: number): boolean {
  const lambda = tuning.goodVoteAlt ?? 0;
  if (lambda <= 0 || obs.myTeam !== 'good') return false;
  if ((obs.currentRound ?? 1) < 3 || (obs.failCount ?? 0) >= 4) return false;
  // `goodVoteAltLast`: only the fourth proposal — rejecting it hands the mission to the forced fifth (the tail's own team).
  if (tuning.goodVoteAltLast === true && (obs.failCount ?? 0) !== 3) return false;
  const team = obs.proposedTeam ?? [];
  if (!team.includes(obs.myPlayerId)) return false;
  const next = leaderAhead(obs, 1);
  if (next === null) return false;
  const alt = bestCleanWith(obs, next, team.length, bayesOptionsOf(tuning));
  return alt !== null && p >= lambda * alt;
}

/**
 * `loyalTailWhite`（D3 第一階段）：只有真的忠臣（`publicLoyalView` 的梅林／紅方照忠臣投票不算），第 1–4 次提議、任何一局：
 * 尾家是紅的機率 ≥ τ，而且這隊乾淨的機率 ≥ λ × 尾家能派的最乾淨的隊 → 投白。呼叫端負責好人投票關卡。
 */
export function loyalTailWhiteNow(tuning: Readonly<AgentTuning>, obs: PlayerObservation): boolean {
  if (obs.myRole !== 'loyal' || obs.publicLoyalView === true) return false;
  return tailWhiteCore(tuning, obs);
}

/**
 * `loyalTailWhite` 的規則本身（不看角色）：觀察者自己的後驗。第 28 回合拆出來給 D3 第二階段（`mpTailWhite`）共用。
 * `loyalTailWhiteEarly`（第 28 回合）：`loyalTailWhiteLast` 開著時，第 1–3 次提議也開，但比較的對象換成「之後每一任隊長（到尾家為止）能派的最乾淨的隊」的最大值——
 * 前面還有別的隊長時，否決換來的不只是尾家的隊。
 */
export function tailWhiteCore(tuning: Readonly<AgentTuning>, obs: PlayerObservation): boolean {
  const tau = tuning.loyalTailWhite ?? 0;
  if (tau <= 0 || obs.gamePhase !== 'team_vote' || obs.myTeam !== 'good') return false;
  const tail = tailLeaderOf(obs);
  if (tail === null || tail === obs.myPlayerId) return false;
  const fc = obs.failCount ?? 0;
  const early = tuning.loyalTailWhiteLast === true && fc !== 3;
  // `loyalTailWhiteLast`: only the fourth proposal — the one whose rejection hands the mission to the tail's forced team
  // (unless `loyalTailWhiteEarly`: every later captain up to the tail is an alternative).
  if (early && tuning.loyalTailWhiteEarly !== true) return false;
  const team = obs.proposedTeam ?? [];
  if (team.length === 0) return false;
  const opts = bayesOptionsOf(tuning);
  const tailRed = bayesRedShare(obs, opts).get(tail) ?? 0;
  // Round 38 `loyalTailWhiteLastTau` (checklist AV-09 / AV-02): the fourth proposal of rounds 3–5 has its own threshold.
  const tau4 = tuning.loyalTailWhiteLastTau ?? 0;
  const bar = tau4 > 0 && fc === 3 && (obs.currentRound ?? 1) >= 3 ? tau4 : tau;
  if (tailRed < bar) return false;
  const p = bayesTeamClean(obs, team, opts);
  if (p === null) return false;
  let alt: number | null = null;
  if (early) {
    for (let o = 1; o <= 4 - fc; o++) {
      const leader = leaderAhead(obs, o);
      if (leader === null) continue;
      const a = bestCleanWith(obs, leader, team.length, opts);
      if (a !== null && (alt === null || a > alt)) alt = a;
    }
  } else {
    alt = bestCleanWith(obs, tail, team.length, opts);
  }
  const lambda = (tuning.loyalTailWhiteLambda ?? 0) > 0 ? tuning.loyalTailWhiteLambda : 1;
  return alt !== null && p >= lambda * alt && p > 0;
}

/**
 * 第 28 回合藍方・梅林／派西（D3 第二階段，Edward 2026-11-04「忠臣做得到 梅林跟派西維爾才能做」）：`mpTailWhite`。
 * 觸發條件只看「坐在這個位置、只看公開紀錄的忠臣」會不會開尾家外白（`tailWhiteCore` 套在公開視角上）——同樣公開資訊的忠臣也會開的才開；
 * 再加自己的私人資訊不反對：梅林＝隊上沒有他看得到的紅（10/30 裁定：異常票外白不外白看得到紅的隊，在隊上也一樣不開）；派西＝自己的後驗（含拇指）也過同一條規則。
 * 1 = 梅林＋派西；2 = 只有梅林；3 = 只有派西；0 = 關。呼叫端負責好人投票關卡與梅林的致命隊。
 */
export function mpTailWhiteNow(tuning: Readonly<AgentTuning>, obs: PlayerObservation): boolean {
  const mode = tuning.mpTailWhite ?? 0;
  if (mode <= 0 || obs.myTeam !== 'good' || obs.publicLoyalView === true) return false;
  const role = obs.myRole;
  if (role === 'merlin' ? mode === 3 : role === 'percival' ? mode === 2 : true) return false;
  const publicView = {
    ...obs, myRole: 'loyal', myTeam: 'good', knownEvils: [], knownWizards: undefined, allEvilIds: undefined, publicLoyalView: false,
  } as PlayerObservation;
  if (!tailWhiteCore(tuning, publicView)) return false;
  if (role === 'merlin') return !(obs.proposedTeam ?? []).some((id) => obs.knownEvils.includes(id));
  return tailWhiteCore(tuning, obs);
}
