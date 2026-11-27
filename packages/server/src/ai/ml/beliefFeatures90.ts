/**
 * 第 90 回合 第 1 號模型（世界後驗估值器）的特徵：藍方座位（忠臣、派西）在一個決策點，對另外每一個人算一列。
 *
 * 只用這個座位當下看得到的東西：公開紀錄（每一次提議的隊長、隊伍、票；任務隊伍與失敗張數；湖的持有者、目標、宣告）、
 * 自己的座位與角色、派西看到的兩根拇指，加上兩個「現行」的數：
 * - `base`：現行信念（`bayesRedShare`，210 個紅方世界的精確列舉＋真人表的概似）說這個人是紅的機率；
 * - `uni`：只用遊戲規則（L1* 世界均分，不讀任何動作）說的機率。
 * 第 1 號模型的「取代查表」版本（`mode` 位元 2）不用 `base`，只用 `uni`＋這裡的跨回合特徵；「疊加」版本用 `base` 當起點，學表沒有寫到的交互作用。
 *
 * 訓練（`scripts/ml/exportBelief90.ts` → `scripts/ml/train90.py`）與執行期（`Round90.ts`）用同一支函式，特徵不會對錯位。
 * 特徵名稱的順序就是模型 JSON 的 `features`。
 */
import type { PlayerObservation } from '../types';
import { logit } from './mlModel90';

export const BELIEF_FEATURES_90 = [
  'baseLogit', 'uniLogit', 'percival', 'thumb', 'round', 'fails', 'succ',
  'onFail', 'failShare', 'onSucc', 'onTwoFail', 'onFailWithMe',
  'nVotes', 'approveRate', 'offApproveR12', 'onReject', 'offApproveR3', 'apprFailedTeam', 'rejSuccTeam', 'apprFailers', 'agreeMe', 'apprWithMe',
  'nProps', 'propsFailers', 'propsSelfOff', 'propsFailed', 'propsSucc', 'propsInclMe', 'inclByOthers', 'inclByMe', 'inclByFailLeader',
  'lakeEvil', 'lakeGood', 'declEvil', 'declGood', 'lakeHolder',
  'seat', 'seat5', 'seat0', 'seatFromMe', 'leadDist', 'attempt',
  'baseXround', 'onFailXfails', 'uniXbase',
] as const;

const NF = BELIEF_FEATURES_90.length;

const failedQuest = (q: { round: number; failCount?: number; result?: string }, n: number): boolean =>
  q.result === 'fail' || (q.failCount ?? 0) >= (q.round === 4 && n >= 7 ? 2 : 1);

export interface BeliefRows90 {
  ids: string[];
  rows: Float64Array[];
}

/**
 * 每一個其他座位一列（同 `ids` 的順序）。`base`／`uni` 是那個人是紅的機率（缺的當 0.5）。
 */
export function beliefFeatures90(obs: PlayerObservation, base: ReadonlyMap<string, number>, uni: ReadonlyMap<string, number>): BeliefRows90 {
  const ids = obs.allPlayerIds;
  const n = ids.length;
  const me = obs.myPlayerId;
  const idx = new Map(ids.map((id, i) => [id, i] as const));
  const percival = obs.myRole === 'percival' && (obs.knownWizards ?? []).length === 2;
  const thumbs = new Set(percival ? obs.knownWizards ?? [] : []);
  const quests = obs.questHistory.map((q) => ({ round: q.round, team: new Set(q.team), fails: q.failCount ?? 0, failed: failedQuest(q, n), size: q.team.length }));
  const fails = quests.filter((q) => q.failed).length;
  const succ = quests.length - fails;
  const round = Math.max(1, obs.currentRound ?? 1);
  const first = obs.voteHistory.length > 0 ? obs.voteHistory[0].leader : obs.currentLeader;
  const i1 = idx.get(first) ?? 0;
  const iMe = idx.get(me) ?? 0;
  const iLead = idx.get(obs.currentLeader) ?? i1;
  // Seats on a failed mission before a given round.
  const failersBefore = (r: number): Set<string> => {
    const s = new Set<string>();
    for (const q of quests) if (q.round < r && q.failed) for (const id of q.team) s.add(id);
    return s;
  };
  const failersByRound = new Map<number, Set<string>>();
  const failersAt = (r: number): Set<string> => {
    let s = failersByRound.get(r);
    if (!s) { s = failersBefore(r); failersByRound.set(r, s); }
    return s;
  };
  const questOf = (r: number): (typeof quests)[number] | undefined => quests.find((q) => q.round === r);
  const out: Float64Array[] = [];
  const outIds: string[] = [];
  for (const j of ids) {
    if (j === me) continue;
    const x = new Float64Array(NF);
    const pb = base.get(j) ?? 0.5;
    const pu = uni.get(j) ?? 0.5;
    const bl = logit(pb);
    const ul = logit(pu);
    x[0] = bl;
    x[1] = ul;
    x[2] = percival ? 1 : 0;
    x[3] = thumbs.has(j) ? 1 : 0;
    x[4] = round;
    x[5] = fails;
    x[6] = succ;
    // Missions.
    let onFail = 0; let failShare = 0; let onSucc = 0; let onTwo = 0; let withMe = 0;
    for (const q of quests) {
      if (!q.team.has(j)) continue;
      const meOn = q.team.has(me);
      const others = q.size - (meOn ? 1 : 0);
      if (q.failed) { onFail++; if (meOn) withMe++; }
      else onSucc++;
      if (q.fails >= 2) onTwo++;
      if (others > 0) failShare += q.fails / others;
    }
    x[7] = onFail; x[8] = failShare; x[9] = onSucc; x[10] = onTwo; x[11] = withMe;
    // Votes (non-forced, j not the leader) and proposals.
    let nv = 0; let ap = 0; let offR12 = 0; let onRej = 0; let offR3 = 0; let apprFailed = 0; let rejSucc = 0; let apprFailers = 0;
    let agree = 0; let agreeN = 0; let apprMe = 0; let meOnN = 0;
    let np = 0; let pFailers = 0; let pSelfOff = 0; let pFailed = 0; let pSucc = 0; let pMe = 0; let inclOthers = 0; let inclMe = 0; let inclFailLead = 0;
    for (const v of obs.voteHistory) {
      const forced = v.attempt >= 5;
      const on = v.team.includes(j);
      const failers = failersAt(v.round);
      const went = v.approved;
      const q = went ? questOf(v.round) : undefined;
      if (v.leader === j) {
        np++;
        if (v.team.some((t) => t !== j && failers.has(t))) pFailers++;
        if (!on) pSelfOff++;
        if (q) { if (q.failed) pFailed++; else pSucc++; }
        if (v.team.includes(me)) pMe++;
        continue;
      }
      if (on) {
        if (v.leader === me) inclMe++;
        else { inclOthers++; if (failers.has(v.leader)) inclFailLead++; }
      }
      if (forced) continue;
      const vote = v.votes[j];
      if (vote === undefined) continue;
      nv++;
      if (vote) ap++;
      if (vote && !on && v.round <= 2) offR12++;
      if (!vote && on) onRej++;
      if (vote && !on && v.round >= 3) offR3++;
      if (q && q.failed && vote && !on) apprFailed++;
      if (q && !q.failed && !vote) rejSucc++;
      if (vote && !on && v.team.some((t) => failers.has(t))) apprFailers++;
      const mv = v.votes[me];
      if (mv !== undefined) { agreeN++; if (mv === vote) agree++; }
      if (v.team.includes(me)) { meOnN++; if (vote) apprMe++; }
    }
    x[12] = nv; x[13] = (ap + 1) / (nv + 2); x[14] = offR12; x[15] = onRej; x[16] = offR3; x[17] = apprFailed; x[18] = rejSucc; x[19] = apprFailers;
    x[20] = (agree + 1) / (agreeN + 2); x[21] = (apprMe + 1) / (meOnN + 2);
    x[22] = np; x[23] = pFailers; x[24] = pSelfOff; x[25] = pFailed; x[26] = pSucc; x[27] = pMe; x[28] = inclOthers; x[29] = inclMe; x[30] = inclFailLead;
    // Lake (declared claims only; the viewer's own lakes are certain facts the base already holds).
    let le = 0; let lg = 0; let de = 0; let dg = 0; let lh = 0;
    for (const l of obs.lakeHistory ?? []) {
      if (l.holderId === me || l.declaredClaim === 'none') { if (l.holderId === j) lh++; continue; }
      if (l.targetId === j) { if (l.declaredClaim === 'evil') le++; else lg++; }
      if (l.holderId === j) { lh++; if (l.declaredClaim === 'evil') de++; else dg++; }
    }
    x[31] = le; x[32] = lg; x[33] = de; x[34] = dg; x[35] = lh;
    // Seats.
    const ij = idx.get(j) ?? 0;
    const seat = ((ij - i1 + n) % n) + 1;
    x[36] = seat; x[37] = seat === 5 ? 1 : 0; x[38] = seat === n ? 1 : 0;
    x[39] = (ij - iMe + n) % n;
    x[40] = (ij - iLead + n) % n;
    x[41] = (obs.failCount ?? 0) + 1;
    // Explicit interactions.
    x[42] = bl * round; x[43] = onFail * fails; x[44] = ul * bl;
    out.push(x);
    outIds.push(j);
  }
  return { ids: outIds, rows: out };
}
