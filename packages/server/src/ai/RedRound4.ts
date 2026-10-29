/**
 * 優化迴圈第 4 回合・紅方的候選（2026-10-29）：反制第 3 回合藍方的「好人看機率投黑」（`goodCleanVote`）。
 *
 * B1 `redCleanLook`：第 3 局起紅方當隊長時，在「隊上紅方剛好夠讓任務失敗」（10 人局第 4 局兩張、其他一張）的隊伍裡，
 *    挑藍方自己估起來最乾淨的那一隊——站在每個可能是藍方的玩家的位置（自己看不到的人：不在 knownEvils、不是自己），
 *    用他們的貝氏信念（同一份公開紀錄、只少了紅方的私人資訊）算「這隊沒有紅」的機率，取平均最高的。
 *    隊伍大小沿用原本流程選的隊。奧伯倫不適用（看不到隊友，湊不出確定的失敗張數）。
 *
 * Edward 2026-10-29：「梅林用那樣的策略躲刺，紅方要做的其實應該是盡可能適時的疊隊友衝隊友，但記得要分工合作，
 * 不能一次爆開全被抓到。」（出任務的失敗牌分工已有位階法：兩個相認紅同隊時刺客出失敗、莫德雷德出成功。）
 * C1 `redStackRatio`（疊隊友，適時）：B1 的隊伍再多帶一個隊友——只在多帶之後藍方估的乾淨機率仍有最乾淨隊的
 *    這個比例以上時（0 = 關）。兩個紅同隊，一張失敗由位階法分給一人，另一人留著不爆。
 * C2 `redDivisionVote`（衝隊友要分工）：第 3 局起不在隊上、隊上有隊友時，替隊友投白（外白）的只有已經比較曝光的紅；
 *    藍方估起來最乾淨的前 N 個紅照正常票投黑，保持乾淨（0 = 關）。每個紅都用同一份公開紀錄排序，不用溝通就分得出工。
 *
 * Edward 2026-10-29：「既然允許梅林去派可見拇指，那只要發現某個隊友拿超過平均被選到的次數以上，這時隊友就應該盡量
 * 在隊伍選擇上帶這個人。甚至是分拆成 2 邊：一邊目標是送莫德雷德進任務，另一邊則是送可見拇指（刺客或莫甘娜）進任務。」
 * 「熱門隊友」= 被藍方隊長（紅方知道哪些隊長是紅的，只算其他隊長的提議）選進隊伍的次數超過全體平均的隊友，取最多的那個。
 * D1 `redFavoriteMate`：第 3 局起紅隊長的隊伍帶熱門隊友（1 = 自己＋熱門隊友；2 = 只帶熱門隊友、自己不上，
 *    10 人局第 4 局要兩張失敗時仍是自己＋熱門隊友）；其餘位置照 B1 挑藍方估起來最乾淨的人（0 = 關）。
 * D2 `redTwoLines`：分兩邊——莫德雷德當隊長送自己（梅林看不到他）；刺客、莫甘娜當隊長送熱門隊友（多半是被梅林派過的
 *    可見拇指，自己不上）。紅方互相不知道角色，每個紅只看自己的角色就分得出邊。
 */
import type { AgentAction, PlayerObservation } from './types';
import type { AgentTuning } from './AgentTuning';
import { bayesRedShare, bayesTeamClean } from './belief/BayesBelief';

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
  const bestOf = (redCount: number): { team: string[] | null; score: number } => {
    let team: string[] | null = null;
    let score = -1;
    if (mates.length < redCount - 1 || viewers.length < size - redCount || redCount > size) return { team, score };
    for (const reds of combinations(mates, redCount - 1)) {
      for (const fill of combinations(viewers, size - redCount)) {
        const t = [me, ...reds, ...fill];
        let sum = 0;
        for (const view of views) sum += bayesTeamClean(view, t) ?? 0;
        if (sum / views.length > score) { score = sum / views.length; team = t; }
      }
    }
    return { team, score };
  };
  // D1 / D2: the reds on the team are fixed (the favorite teammate, or the leader), the rest is B1's cleanest fill.
  const fixedReds = fixedRedSet(tuning, obs, failsNeeded);
  if (fixedReds) {
    const blues = viewers.filter((id) => !fixedReds.includes(id));
    if (blues.length >= size - fixedReds.length && fixedReds.length <= size) {
      let team: string[] | null = null;
      let score = -1;
      for (const fill of combinations(blues, size - fixedReds.length)) {
        const t = [...fixedReds, ...fill];
        let sum = 0;
        for (const view of views) sum += bayesTeamClean(view, t) ?? 0;
        if (sum / views.length > score) { score = sum / views.length; team = t; }
      }
      if (team) return { type: 'team_select', teamIds: team };
    }
  }
  const min = bestOf(failsNeeded);
  // C1: stack one more teammate when that costs little of the cleanest look.
  const ratio = tuning.redStackRatio ?? 0;
  if (ratio > 0) {
    const stacked = bestOf(failsNeeded + 1);
    if (stacked.team && stacked.score >= ratio * min.score) return { type: 'team_select', teamIds: stacked.team };
  }
  return min.team ? { type: 'team_select', teamIds: min.team } : action;
}

/**
 * C2: true = this red votes reject (stays clean) instead of approving a teammate's team off the team. The reds
 * blue rates cleanest (average over the possible-blue seats' posteriors, public records only) are the first
 * `redDivisionVote` of them.
 */
export function redDivisionReject(tuning: Readonly<AgentTuning>, obs: PlayerObservation): boolean {
  const hidden = tuning.redDivisionVote ?? 0;
  if (hidden <= 0 || obs.gamePhase !== 'team_vote' || obs.myTeam !== 'evil' || obs.myRole === 'oberon') return false;
  if ((obs.currentRound ?? 1) < 3 || (obs.failCount ?? 0) >= 4) return false;
  const me = obs.myPlayerId;
  const team = obs.proposedTeam ?? [];
  const mates = obs.knownEvils.filter((id) => id !== me);
  if (team.includes(me) || !team.some((id) => mates.includes(id))) return false;
  // Red already at two failed missions: every vote counts, push.
  if ((obs.questResults ?? []).filter((r) => r === 'fail').length >= 2) return false;
  const viewers = obs.allPlayerIds.filter((id) => id !== me && !mates.includes(id));
  const reds = [me, ...mates];
  const suspicion = new Map(reds.map((id) => [id, 0]));
  for (const v of viewers) {
    const share = bayesRedShare(blueView(obs, v));
    for (const id of reds) if (id !== v) suspicion.set(id, (suspicion.get(id) ?? 0) + (share.get(id) ?? 0));
  }
  // Rounded so float noise between equal suspicions does not split the reds' shared ranking (ties: seat id).
  const key = (id: string): number => Math.round((suspicion.get(id) ?? 0) * 1e6);
  const order = [...reds].sort((a, b) => key(a) - key(b) || a.localeCompare(b));
  return order.slice(0, hidden).includes(me);
}

/**
 * The teammate blue leaders pick most (proposals led by seats red does not know as red), when that is above the
 * all-seat average; null otherwise.
 */
export function favoriteMate(obs: PlayerObservation): string | null {
  const me = obs.myPlayerId;
  const reds = new Set([me, ...obs.knownEvils]);
  const count = new Map(obs.allPlayerIds.map((id) => [id, 0]));
  for (const v of obs.voteHistory) {
    if (reds.has(v.leader)) continue;
    for (const id of v.team) count.set(id, (count.get(id) ?? 0) + 1);
  }
  const avg = [...count.values()].reduce((a, b) => a + b, 0) / Math.max(1, count.size);
  let best: string | null = null;
  for (const id of obs.knownEvils) {
    if (id === me) continue;
    const c = count.get(id) ?? 0;
    if (c > avg && (best === null || c > (count.get(best) ?? 0))) best = id;
  }
  return best;
}

/** D1 / D2: the reds the leader's team carries, or null for B1's own choice. */
function fixedRedSet(tuning: Readonly<AgentTuning>, obs: PlayerObservation, failsNeeded: number): string[] | null {
  const me = obs.myPlayerId;
  let mode = tuning.redFavoriteMate ?? 0;
  if (tuning.redTwoLines) {
    // Mordred sends himself (B1); the visible thumbs send the favorite teammate.
    if (obs.myRole === 'mordred') return null;
    mode = 2;
  }
  if (mode <= 0) return null;
  const fav = favoriteMate(obs);
  if (!fav) return null;
  if (mode === 1 || failsNeeded >= 2) return [me, fav];
  return [fav];
}
