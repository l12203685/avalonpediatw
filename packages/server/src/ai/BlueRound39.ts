/**
 * 優化迴圈第 39 回合・藍方（2026-11-11）。
 *
 * Edward 11/10（晚）：「照真人改的項目沒差＝沒照到強者的邏輯」。第 38 回合的 `goodLakeHuman` 只改了「最近一次任務成功」一種情況，
 * 而且把同分全部改成擲銅板；和強者持湖者的一致只從 26% 到 27%。真人資料（2,229 局、藍方持湖 2,687 次）量到機器人和強者差最多的
 * 地方都在任務失敗之後：機器人會湖出過兩張失敗的隊上的人（真人第 1、2 湖幾乎從不）、在失敗的隊裡湖最不確定的那一個，
 * 同分照座位序（第 1 湖時就是 1 號，Edward：湖誰和上下家無關）。
 *
 * `goodLake39`（位元，各自預設關；只用持湖者看得到的事實）：
 *   - 1：第 1、2 湖不湖上過「出兩張以上失敗」的任務的人（還有別人可以湖時）。第 3 湖不管。
 *   - 2：照比分順序（FS 和 SF 不同）的優先類別（見 `lake39Prefs`）：只在真人集中在某一類的格子用；真人分散的格子不加類別規則
 *        （第 38 回合在分散的格子硬挑一類，和強者的一致反而下降）。
 *   - 4：同分不照座位序：先比持湖者的後驗（比較藍的；紅方已兩勝時不比），再亂數；下一局第 3–5 位派隊只在第 1 湖 FS、第 2 湖 SFF／FSF 當很弱的同分排序。
 *   - 8：同一類裡照持湖者的後驗挑比較藍的那一個（紅方未兩勝的格子；第 1 湖 SS 先挑自己派的隊出過任務的人）。
 *   - 64：紅方已兩勝、之後還有湖時也照比較藍的挑（＝信任項；牽涉 10/13 的裁定「兩紅時湖中不一定要湖好人」，Edward 還沒裁定，只量）。
 *   - 256：第 1 湖 FS 改成先湖兩局都上過的人（百科 wiki-208 §2；Edward 待裁定，只量）。
 *   - 128：梅林持湖也用位元 2／8（公開的分類＋自己的後驗，等於在同一類裡先挑他知道不是紅的人）；沒有 128 時梅林只用位元 1、4。
 * 第 3 湖照原本的共同資訊規則（第 39 回合沒有做）。
 */
import type { PlayerObservation } from './types';
import type { AgentTuning } from './AgentTuning';
import { bayesOptionsOf, bayesRedShare } from './belief/BayesBelief';
import { analyzeGoodLake } from './GoodLakeInfo';

/** 候選人的任務類別：F2＝上過出兩張以上失敗的任務；FS＝失敗、成功的任務都上過；F＝只上過失敗的；S＝只上過成功的；N＝沒上過任務。 */
export type LakeClass = 'F2' | 'FS' | 'F' | 'S' | 'N';

export interface Lake39Candidate {
  id: string;
  cls: LakeClass;
  /** 上過最近一次任務。 */
  onLast: boolean;
  /** 自己當隊長派的隊出過任務。 */
  ledWent: boolean;
  /** 下一局派隊的順位（1＝第一個派）。 */
  npos: number;
  /** 持湖者的後驗：紅的機率。 */
  pRed: number;
}

export interface Lake39State {
  /** 第幾湖（0 起算）。 */
  lake: number;
  /** 比分順序，例如 'SF'。 */
  score: string;
  redHasTwo: boolean;
}

export function lake39State(obs: PlayerObservation): Lake39State {
  const score = (obs.questResults ?? []).map((r) => (r === 'fail' ? 'F' : 'S')).join('');
  return { lake: (obs.lakeHistory ?? []).length, score, redHasTwo: score.split('F').length - 1 >= 2 };
}

/** 持湖者看得到的每個候選人的特徵。 */
export function lake39Candidates(obs: PlayerObservation, candidates: readonly string[], tuning: Readonly<AgentTuning>): Lake39Candidate[] {
  const quests = obs.questHistory ?? [];
  const failed = quests.filter((q) => q.result === 'fail');
  const passed = quests.filter((q) => q.result !== 'fail');
  const two = new Set(failed.filter((q) => (q.failCount ?? 0) >= 2).flatMap((q) => q.team));
  const onF = new Set(failed.flatMap((q) => q.team));
  const onS = new Set(passed.flatMap((q) => q.team));
  const last = [...quests].sort((a, b) => b.round - a.round)[0];
  const ledWent = new Set<string>();
  for (const v of obs.voteHistory) if (v.approved) ledWent.add(v.leader);
  const ids = obs.allPlayerIds;
  const lastVote = obs.voteHistory[obs.voteHistory.length - 1];
  const nextFirst = lastVote ? (ids.indexOf(lastVote.leader) + 1) % ids.length : 0;
  const share = bayesRedShare(obs, bayesOptionsOf(tuning));
  return candidates.map((id) => {
    const cls: LakeClass = two.has(id) ? 'F2' : onF.has(id) && onS.has(id) ? 'FS' : onF.has(id) ? 'F' : onS.has(id) ? 'S' : 'N';
    const npos = ((ids.indexOf(id) - nextFirst + ids.length) % ids.length) + 1;
    return { id, cls, onLast: !!last && last.team.includes(id), ledWent: ledWent.has(id), npos, pRed: share.get(id) ?? 0.5 };
  });
}

/** 持湖者在隊上、失敗張數等於其他隊員人數的失敗任務：其他隊員一定是紅，湖他們是浪費。 */
function certainReds(obs: PlayerObservation): Set<string> {
  const me = obs.myPlayerId;
  const out = new Set<string>();
  for (const q of obs.questHistory ?? []) {
    if (q.result !== 'fail' || !q.team.includes(me)) continue;
    if ((q.failCount ?? 0) >= q.team.length - 1) for (const id of q.team) if (id !== me) out.add(id);
  }
  return out;
}

/**
 * 每一格的優先類別（位元 2），照比分順序（FS 和 SF 不同），前面的類別有人可湖就只在那一類裡挑：
 *   - 第 1 湖 FF：上過失敗任務（不是兩張失敗）的人，其次沒上過任務的人（真人強者 81／19%、全部 75／24%；機器人 F 79%，其中 20% 是兩張失敗的隊）。
 *   - 第 1 湖 FS：只上過第 2 局成功任務的人，其次兩局都上過的（真人強者 83%、全部 73%；機器人 42%）。
 *   - 第 1 湖 SS：第 2 局的隊員（真人 91–94%）。
 *   - 第 2 湖 SFS、FSS：第 3 局的隊員（真人 91–94%）。
 * 其餘格子（第 1 湖 SF、第 2 湖 SFF／FSF／FFS／SSF）沒有類別規則：真人在這些格子裡是分散的（例如 SFF 第 3 局的隊員 41% vs 可湖 40%），
 * 只拿掉兩張失敗的隊（位元 1）。回傳的是依序的類別清單；'L'＝上過最近一次任務。
 */
export function lake39Prefs(st: Lake39State): Array<LakeClass | 'L'> {
  if (st.lake === 0) {
    switch (st.score) {
      case 'FF': return ['F', 'N'];
      case 'FS': return ['S', 'FS'];
      case 'SS': return ['L'];
      default: return [];
    }
  }
  if (st.lake === 1 && (st.score === 'SFS' || st.score === 'FSS')) return ['L'];
  return [];
}

const near = (a: number, b: number, eps: number): boolean => Math.abs(a - b) <= eps;
/** 後驗差在這個範圍內算同分（持湖者分不出誰比較藍）。 */
const TIE_BAND = 0.05;

/** 同分的排序（位元 4）：下一局第 3–5 位只在第 1 湖 FS、第 2 湖 SFF／FSF 當很弱的同分排序，其餘直接亂數。 */
function breakTie(st: Lake39State, tied: readonly Lake39Candidate[], rnd: () => number): Lake39Candidate {
  let pool = tied;
  const weakNpos = (st.lake === 0 && st.score === 'FS') || (st.lake === 1 && (st.score === 'SFF' || st.score === 'FSF'));
  if (weakNpos) {
    const mid = pool.filter((c) => c.npos >= 3 && c.npos <= 5);
    if (mid.length > 0) pool = mid;
  }
  return pool[Math.min(pool.length - 1, Math.floor(rnd() * pool.length))];
}

/** 這個持湖者適用 `goodLake39`（梅林要位元 128）。 */
export function goodLake39On(tuning: Readonly<AgentTuning>, obs: PlayerObservation): boolean {
  return (tuning.goodLake39 ?? 0) > 0 && obs.myTeam === 'good';
}

/** 這個持湖者實際用到的位元：梅林沒有位元 128 時只用 1（兩張失敗的隊，所有藍方都適用）與 4（同分不照座位序）。 */
export function goodLake39Bits(tuning: Readonly<AgentTuning>, obs: PlayerObservation): number {
  const bits = tuning.goodLake39 ?? 0;
  return obs.myRole === 'merlin' && (bits & 128) === 0 ? bits & 5 : bits;
}

/**
 * `goodLake39` 的湖目標。`candidates` 已經去掉持湖者的避開名單（梅林看得到的紅）。不適用時回傳 null（照原本的流程）。
 * 紅方未兩勝：同一類裡照原本的共同資訊＋信任分數（位元 8：直接照持湖者的後驗挑比較藍的；第 1 湖 SS 先挑自己派的隊出過任務的人）。
 * 紅方已兩勝：照原本只看資訊的分數（信任項 0，10/13 裁定），位元 64 才加信任項（只量，待 Edward 裁定）。
 * 同分：位元 4 先比後驗（只在紅方未兩勝或位元 64），再照下一局順位的弱排序，最後亂數；沒有位元 4 照座位序（原本的做法）。
 * `rnd` 用 `Math.random`（自我對打與重播都固定亂數）。
 */
export function goodLake39Pick(
  tuning: Readonly<AgentTuning>,
  obs: PlayerObservation,
  candidates: readonly string[],
  rnd: () => number = Math.random,
): string | null {
  if (!goodLake39On(tuning, obs) || candidates.length === 0) return null;
  const bits = goodLake39Bits(tuning, obs);
  const st = lake39State(obs);
  const cert = certainReds(obs);
  let ids = candidates.filter((id) => !cert.has(id));
  if (ids.length === 0) ids = [...candidates];
  let cs = lake39Candidates(obs, ids, tuning);
  if ((bits & 1) && st.lake <= 1) {
    const kept = cs.filter((c) => c.cls !== 'F2');
    if (kept.length > 0) cs = kept;
  }
  if ((bits & 2) && st.lake <= 1) {
    // 位元 256（Edward 待裁定的項目 1，只量）：第 1 湖 FS 照百科 wiki-208 §2 先湖兩局都上過的人（強者真人相反：只上過第 2 局的 71%、重疊 24%）。
    const prefs = (bits & 256) && st.lake === 0 && st.score === 'FS' ? (['FS', 'S'] as Array<LakeClass | 'L'>) : lake39Prefs(st);
    for (const k of prefs) {
      const sel = cs.filter((c) => (k === 'L' ? c.onLast : c.cls === k));
      if (sel.length > 0) { cs = sel; break; }
    }
  }
  if (cs.length === 1) return cs[0].id;
  const trustOk = !st.redHasTwo || (bits & 64) !== 0;
  const seatFirst = (xs: readonly Lake39Candidate[]): Lake39Candidate => [...xs].sort((a, b) => obs.allPlayerIds.indexOf(a.id) - obs.allPlayerIds.indexOf(b.id))[0];
  if ((bits & 8) && st.lake <= 1 && trustOk) {
    let pool = cs;
    if (st.lake === 0 && st.score === 'SS') {
      const went = pool.filter((c) => c.ledWent);
      if (went.length > 0) pool = went;
    }
    const min = Math.min(...pool.map((c) => c.pRed));
    const tied = pool.filter((c) => near(c.pRed, min, (bits & 4) ? TIE_BAND : 1e-9));
    return (bits & 4) ? breakTie(st, tied, rnd).id : seatFirst(tied).id;
  }
  const an = analyzeGoodLake(obs, cs.map((c) => c.id), { trustWeight: 1 }, (bits & 64) !== 0 && st.lake <= 1);
  if (!an) return null;
  const best = Math.max(...an.candidates.map((c) => c.score));
  const top = an.candidates.filter((c) => best - c.score <= 1e-9).map((c) => cs.find((x) => x.id === c.id)!);
  if (top.length === 1) return top[0].id;
  if (bits & 4) {
    let pool = top;
    if (trustOk) {
      const min = Math.min(...top.map((c) => c.pRed));
      pool = top.filter((c) => near(c.pRed, min, 1e-9));
    }
    return breakTie(st, pool, rnd).id;
  }
  return seatFirst(top).id;
}

// ── 被別人宣告紅的人不上隊（`loyalLakePair`，檢查表 LP-12／LK-09 第 1 部分＋ML-05 第 3 部分）────────────────
/**
 * 最近一次湖（上一局結束時）持湖者 H 宣告 X 是紅、我不是 H 也不是 X：這一局非強制的提議不帶 X（整隊照派成功的隊也一樣），
 * 除非我自己估 H 是紅的機率 ≥ 0.5（和投票規則用同一個測試，派的隊和投的票一致）。真人強者在這個點帶 X 11%、全部 17%，機器人 21%；
 * 第 1 局失敗、第 2 局成功之後（SF）機器人帶 X 48%（真人 21%），那時 X 是紅 62%。
 * 忠臣當隊長適用；梅林照派成功的隊（`merlinReuseNorm`／`merlinReuseExact`）也用同一條公開的限制（用公開視角估 H），
 * 免得只有梅林會整隊重派有被宣告紅的人的隊。持湖者自己的宣告照原本的規則（`goodVouchTeamConstraint`）。座位只當持湖者／被湖的人，沒有鄰座。
 * 位元 4（只量）：不看持湖者的後驗，一律不帶 X。回傳要擋掉的 X，不適用時回傳 null。
 */
export function lakePairBarred(tuning: Readonly<AgentTuning>, obs: PlayerObservation): string | null {
  if (!((tuning.loyalLakePair ?? 0) & 1) || obs.myTeam !== 'good' || obs.gamePhase !== 'team_select') return null;
  if (obs.myRole !== 'loyal' && obs.myRole !== 'merlin') return null;
  if ((obs.failCount ?? 0) >= 4) return null;
  const lakes = obs.lakeHistory ?? [];
  const last = lakes[lakes.length - 1];
  if (!last || last.declaredClaim !== 'evil' || last.round !== (obs.currentRound ?? 1) - 1) return null;
  const me = obs.myPlayerId;
  if (last.holderId === me || last.targetId === me) return null;
  const view: PlayerObservation = obs.myRole === 'merlin'
    ? { ...obs, myRole: 'loyal', knownEvils: [], knownWizards: undefined, allEvilIds: undefined, myLakeResults: [], publicLoyalView: true }
    : obs;
  if ((tuning.loyalLakePair ?? 0) & 4) return last.targetId;
  const pH = bayesRedShare(view, bayesOptionsOf(tuning)).get(last.holderId) ?? 0.5;
  return pH >= 0.5 ? null : last.targetId;
}
