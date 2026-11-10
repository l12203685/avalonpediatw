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
 *     5、6 = 1、2 只用在第 2、3 次提議（第 4 次出任務的機率較高，照原本的流程）。
 *     `loyalR2ViewKeep=γ`（和 `loyalR2View` 一起）：不用固定人數，改成每多留一人乾淨機率打 γ 折。
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

export interface R2ViewCand { team: string[]; p: number; /** 上一任隊上（含他）留下幾人 */ kept: number; leaderIn: boolean; /** 照派這一局出現過的隊、或和前面完全反向 */ barred: boolean }

/** 第 2 局這一次提議的候選隊（含自己）：自己後驗的乾淨機率、相對上一任隊長的隊留了幾人。沒有上一任（別人的）提議時 null。 */
export function r2ViewCandidates(tuning: Readonly<AgentTuning>, obs: PlayerObservation, size: number): { cands: R2ViewCand[]; prevLeader: string } | null {
  const me = obs.myPlayerId;
  const earlier = obs.voteHistory.filter((v) => v.round === 2);
  const prevs = earlier.filter((v) => v.leader !== me);
  if (prevs.length === 0) return null;
  const prev = prevs[prevs.length - 1];
  const opts = bayesOptionsOf(tuning);
  const prevTeam = new Set(prev.team.filter((id) => id !== me));
  const seen = new Set(earlier.flatMap((v) => v.team).filter((id) => id !== me));
  const keys = new Set(earlier.map((v) => [...v.team].sort().join(',')));
  const others = obs.allPlayerIds.filter((id) => id !== me);
  const cands: R2ViewCand[] = [];
  for (const fill of combos(others, size - 1)) {
    const team = [me, ...fill];
    const p = bayesTeamClean(obs, team, opts);
    if (p === null) return null;
    const reversed = seen.size > 0 && fill.every((id) => !seen.has(id));
    const same = keys.has([...team].sort().join(','));
    cands.push({ team, p, kept: fill.filter((id) => prevTeam.has(id)).length, leaderIn: fill.includes(prev.leader), barred: reversed || same });
  }
  return { cands, prevLeader: prev.leader };
}

/** `loyalR2View`：見檔頭。不適用時回傳原本的動作（同一個物件）。 */
export function loyalR2ViewTeam(tuning: Readonly<AgentTuning>, obs: PlayerObservation, action: AgentAction, allowed: Allowed = () => true): AgentAction {
  const mode = tuning.loyalR2View ?? 0;
  if (!(mode > 0) || action.type !== 'team_select' || obs.myTeam !== 'good' || obs.publicLoyalView === true) return action;
  const withPercival = mode === 2 || mode === 4 || mode === 6;
  if (!(obs.myRole === 'loyal' || (withPercival && obs.myRole === 'percival'))) return action;
  if (!r2AfterR1Fail(obs)) return action;
  // 5、6 = 1、2 只在第 2、3 次提議：第 4 次提議出任務的機率較高（真人局 8.2%，第 1–3 次 1.5–3.6%），真人強者在那一次留得比較多
  // （同一點重播：第 4 次用固定最多留 1 人，Jaccard −0.103 ± 0.079；第 2、3 次 −0.008／−0.020）。
  if (mode >= 5 && (obs.failCount ?? 0) >= 3) return action;
  const got = r2ViewCandidates(tuning, obs, action.teamIds.length);
  if (!got) return action;
  const gamma = tuning.loyalR2ViewKeep ?? 0;
  let best: R2ViewCand | undefined;
  if (gamma > 0) {
    // 軟性：每多留上一任隊上的一個人（含他自己），自己後驗的乾淨機率打 γ 折——只有他在自己的視角裡明顯比新的人乾淨才重複派他。
    // 真人局同一點（忠臣 1,530 點）：γ = 0.9 留 0／1／2／3 人 15／43／32／11%、留上一任隊長 25%；真人 11／40／37／12%、30%。
    const score = (c: R2ViewCand): number => c.p * Math.pow(gamma, c.kept);
    const sorted = got.cands.map((c) => ({ c, s: score(c) })).sort((a, b) => (Number(a.c.barred) - Number(b.c.barred)) || (b.s - a.s > 1e-12 ? 1 : a.s - b.s > 1e-12 ? -1 : 0));
    best = sorted.find((x) => allowed(x.c.team))?.c;
  } else {
    const keep = mode === 3 || mode === 4 ? 2 : 1;
    const share = bayesRedShare(obs, bayesOptionsOf(tuning));
    const correct = (share.get(got.prevLeader) ?? 0.5) >= 0.5;
    const rank = (c: R2ViewCand): number => (c.barred ? 0 : (correct ? c.kept === 0 : c.kept <= keep) ? 2 : 1);
    const sorted = got.cands.map((c) => ({ c, ok: rank(c) })).sort((a, b) => (b.ok - a.ok) || (b.c.p - a.c.p > 1e-12 ? 1 : a.c.p - b.c.p > 1e-12 ? -1 : 0));
    best = sorted.find((x) => allowed(x.c.team))?.c;
  }
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

// ── 合理的隊的集合裡挑（`loyalSetPick`；Edward 2026-11-10）──────────────

/**
 * 一次提議出任務的機率（真人局，局次 × 第 1–4 次提議；第 5 次是強制局）。Edward 11/10：第 1、2 局前幾次提議不是「注定被否決」，
 * 只是出任務的機率低（隊長很少不放自己、異常票少），後面的提議機率較高——新的規則照這個機率加權，不用「注定」當前提。
 */
export const PROPOSAL_GO_RATE: Readonly<Record<number, readonly number[]>> = {
  1: [0.005, 0.005, 0.005, 0.005], 2: [0.015, 0.018, 0.036, 0.082], 3: [0.25, 0.06, 0.11, 0.36], 4: [0.55, 0.21, 0.31, 0.53], 5: [0.43, 0.29, 0.32, 0.53],
};

/**
 * Edward 11/10：「忠臣在一個局面有很多支可能的隊，從少數幾支合理的裡面挑——不是唯一一支最好的、也不是照比例」。
 * 合理的集合（第一版）：含自己、不是這一局已經出現過的提議（照派成功任務的隊除外）、不和這一局前面的提議完全反向、過邏輯閘門與自己的投票規則，
 * 而且自己後驗的乾淨機率 ≥ 門檻 × 集合裡最高的；門檻 = λ + (1 − λ) × 這一次提議出任務的機率（越可能出任務，集合越緊）。
 * 正式流程挑的隊一定在集合裡。集合裡等機率挑一支（決策的亂數由對局種子決定）。強制局、照派成功任務的隊不動。
 * 重播比對（真人局同一點）：機器人只在自己隊上的人自己估 25% 紅、只在真人隊上的人估 49% 紅，實際 37%／39%——集合裡的差距不是真的。
 * `set` 回傳集合本身（量涵蓋率用）。
 */
export function loyalReasonableSet(tuning: Readonly<AgentTuning>, obs: PlayerObservation, action: AgentAction, allowed: Allowed = () => true): string[][] | null {
  const lambda = tuning.loyalSetPick ?? 0;
  if (!(lambda > 0) || action.type !== 'team_select' || obs.myTeam !== 'good' || obs.publicLoyalView === true) return null;
  if (obs.myRole !== 'loyal' && obs.myRole !== 'percival') return null;
  const fc = obs.failCount ?? 0;
  if (fc >= 4) return null;
  const round = obs.currentRound ?? 1;
  // `loyalR2View` 管的那一點（第 1 局失敗之後第 2 局回應上一支提議）由它決定。
  if ((tuning.loyalR2View ?? 0) > 0 && r2AfterR1Fail(obs) && obs.voteHistory.some((v) => v.round === 2 && v.leader !== obs.myPlayerId)) return null;
  const results = obs.questResults ?? [];
  const succ = obs.questHistory.filter((q) => q.round < round && results[q.round - 1] === 'success').map((q) => q.team);
  if (succ.some((t) => t.every((id) => action.teamIds.includes(id)))) return null;
  const me = obs.myPlayerId;
  if (!action.teamIds.includes(me)) return null;
  const size = action.teamIds.length;
  const opts = bayesOptionsOf(tuning);
  const earlier = obs.voteHistory.filter((v) => v.round === round);
  const seen = new Set(earlier.flatMap((v) => v.team).filter((id) => id !== me));
  const keys = new Set(earlier.map((v) => [...v.team].sort().join(',')));
  const curKey = [...action.teamIds].sort().join(',');
  const cands: { team: string[]; p: number }[] = [];
  for (const fill of combos(obs.allPlayerIds.filter((id) => id !== me), size - 1)) {
    const team = [me, ...fill];
    const key = [...team].sort().join(',');
    if (key !== curKey) {
      if (keys.has(key) || (seen.size > 0 && fill.every((id) => !seen.has(id)))) continue;
      if (!allowed(team)) continue;
    }
    const p = bayesTeamClean(obs, team, opts);
    if (p === null) return null;
    cands.push({ team, p });
  }
  const max = Math.max(...cands.map((c) => c.p));
  const go = PROPOSAL_GO_RATE[round]?.[fc] ?? 0.3;
  const thr = (lambda + (1 - lambda) * go) * max;
  return cands.filter((c) => c.p >= thr - 1e-12 || [...c.team].sort().join(',') === curKey).map((c) => c.team);
}

/** `loyalSetPick`：合理集合裡等機率挑一支；不適用時回傳原本的動作（同一個物件）。 */
export function loyalSetPickTeam(tuning: Readonly<AgentTuning>, obs: PlayerObservation, action: AgentAction, allowed: Allowed = () => true, rand: () => number = Math.random): AgentAction {
  const set = loyalReasonableSet(tuning, obs, action, allowed);
  if (!set || set.length <= 1 || action.type !== 'team_select') return action;
  const pick = set[Math.min(set.length - 1, Math.floor(rand() * set.length))];
  return [...pick].sort().join(',') === [...action.teamIds].sort().join(',') ? action : { type: 'team_select', teamIds: pick };
}
