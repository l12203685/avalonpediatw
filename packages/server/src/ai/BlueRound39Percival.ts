/**
 * 優化迴圈第 39 回合・藍方・派西（2026-11-11）。
 *
 * 第 38 回合的 `percivalThumbRead`（單一門檻 0.6）和 `beliefThumbNoStain` 沒有效果，原因量出來是：
 *   - 「哪一根拇指是梅林」不是從後驗來的，而是從舊的計分（每上過一次失敗任務就 −1，不管幾張失敗）來的，
 *     所以梅林被失敗任務沾到時還是帶莫甘娜；
 *   - 後驗在第 2 局被擠在 0.5 附近，單一門檻把兩根拇指都擋掉（第 1 局失敗後第 2 局不帶拇指 14% → 91%，真人 45%）；
 *   - 好幾個重新挑隊的步驟沒有檢查拇指。
 *
 * 這裡換成兩件事（各自預設關）：
 *   - `percivalRead39`：派西自己的拇指讀法＝在真人牌譜上擬合的模型（2,229 局、28,574 個派西的決策點、每一局分開擬合；
 *     特徵全是派西看得到的事：誰派了另一根拇指（整隊照派上一次成功的隊不算）、誰派了我、誰上過成功／失敗的任務（一張或兩張以上失敗）、
 *     誰帶的隊出任務成功／失敗、內黑、外白、對另一根拇指的票、湖的宣告、我自己的湖）。我自己的湖看到的那一根是確定的；
 *     我在隊上、失敗張數等於其他隊員人數的任務，其他隊員確定是紅。讀法取代舊的計分決定 A／B（拇指上過一張失敗的任務不再自動換邊）。
 *   - `percivalCarry39`：派西當隊長、第 2 局起：絕不同時帶兩根；比較不像梅林的那一根在讀法信心 ≥ 0.7 時不帶；
 *     比較像梅林的那一根只上過成功的任務就帶，否則照信心決定：1＝門檻（第 2 局前 4 次 0.63、第 2 局第 5 次 0.53、第 3–5 局 0.64），
 *     2＝照真人的比例抽（信心 < 0.65 約 38%、0.65–0.8 約 70%、≥ 0.8 約 82%；第 2 局第 5 次：乾淨或被另一根拇指派過才帶，否則信心 ≥ 0.8）；
 *     第 3 局第 1 次提議另一格（門檻 0.55、信心 < 0.65 時 50%）。3＝同 1 的門檻，但只改 A／B 的加減分、不硬擋拇指（邏輯優先 1E、不變量 INV-Pe2：
 *     除非確定是紅，派西不硬排除拇指）。
 *     完全分不出來時不帶拇指。檢查接在每一個重新挑隊的步驟（候選人、隊長自己的票、重派成功的隊、第 2 局帶自己的視角等）；
 *     只有「整隊照派上一次成功的隊、那根拇指本來就在上面」可以例外。第 1 局不變（不帶拇指）。
 */
import type { PlayerObservation } from './types';
import type { AgentTuning } from './AgentTuning';
import { isForcedVoteRecord } from './belief/BeliefOptions';
import { failCards, missionFailed } from './missionFacts';

/** 模型的特徵（每一根拇指各算一次，取 X − Y 的差）。 */
export const PERCIVAL_READ39_FEATURES = [
  'propY_nr', 'propY_reuse', 'propP', 'onSucc', 'onFail1', 'onFailM', 'ledFail', 'ledSucc', 'ib12', 'ib35', 'ow12', 'ow35',
  'vYoff_app', 'vYon_rej', 'vYlead_app', 'rejSuccOff', 'appFailOff', 'lakeGood', 'lakeEvil', 'heldYgood', 'heldYevil', 'heldP', 'ownGood', 'ownEvil',
] as const;
type Feat = typeof PERCIVAL_READ39_FEATURES[number];

/** 每一局的係數（真人牌譜擬合，L2 λ=1；第 4、5 局合併）。 */
const COEF: Readonly<Record<'R1' | 'R2' | 'R3' | 'R45', readonly number[]>> = {
  R1: [-2.36, 0.0, 0.678, 0.0, 0.0, 0.0, 0.0, 0.0, 0.895, 0.0, 0.676, 0.0, -0.38, -0.453, -0.077, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
  R2: [-1.925, 0.281, 0.563, 0.644, -0.092, -1.885, -0.537, 0.5, 0.895, 0.0, 0.586, 0.0, -0.516, -0.011, 0.194, 0.812, -0.083, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
  R3: [-1.971, 0.272, 0.515, 0.699, -0.18, -1.573, -0.419, 0.496, 0.63, 0.44, 0.669, -0.464, -0.826, -0.091, 0.067, 0.173, -0.359, 0.677, -1.075, -1.909, -0.164, 1.286, 3.088, -2.659],
  R45: [-1.697, -0.234, 0.529, 0.75, -0.335, -1.187, -0.158, -0.028, 0.893, 0.481, 0.094, -0.443, -0.27, -0.053, -0.155, -1.106, 0.568, 0.676, -1.595, -1.675, -1.796, 0.873, 3.181, -2.522],
};

/** 拇指 X 的特徵（另一根拇指 Y、派西 P），只用到目前為止公開的紀錄和派西自己的湖。 */
export function percivalThumbFeatures(obs: PlayerObservation, x: string, y: string): Record<Feat, number> {
  const p = obs.myPlayerId;
  const f: Record<Feat, number> = Object.fromEntries(PERCIVAL_READ39_FEATURES.map((k) => [k, 0])) as Record<Feat, number>;
  const quests = obs.questHistory ?? [];
  const votes = obs.voteHistory ?? [];
  const questOf = (round: number) => quests.find((q) => q.round === round);
  for (const v of votes) {
    const team = new Set(v.team);
    const went = v.approved || isForcedVoteRecord(v);
    if (v.leader === x) {
      const lastS = [...quests].filter((q) => q.round < v.round && !missionFailed(q)).sort((a, b) => b.round - a.round)[0];
      const reuse = !!lastS && lastS.team.every((id) => team.has(id));
      if (team.has(y)) {
        if (reuse && lastS!.team.includes(y)) f.propY_reuse = 1; else f.propY_nr = 1;
      }
      if (team.has(p)) f.propP = 1;
      if (went) {
        const q = questOf(v.round);
        if (q) { if (missionFailed(q)) f.ledFail = 1; else f.ledSucc = 1; }
      }
    }
    if (isForcedVoteRecord(v) || v.leader === x) continue;
    const yes = v.votes[x];
    if (yes === undefined) continue;
    const on = team.has(x);
    const r3 = v.round >= 3;
    if (on && !yes) { if (r3) f.ib35 = 1; else f.ib12 = 1; }
    if (!on && yes) { if (r3) f.ow35 = 1; else f.ow12 = 1; }
    if (team.has(y) && !on && yes) f.vYoff_app = 1;
    if (team.has(y) && on && !yes) f.vYon_rej = 1;
    if (v.leader === y && yes) f.vYlead_app = 1;
    if (went && !on) {
      const q = questOf(v.round);
      if (q) {
        if (yes && missionFailed(q)) f.appFailOff = 1;
        if (!yes && !missionFailed(q)) f.rejSuccOff = 1;
      }
    }
  }
  for (const q of quests) {
    if (!q.team.includes(x)) continue;
    if (!missionFailed(q)) { f.onSucc = 1; continue; }
    if (q.team.includes(y)) continue;
    if (failCards(q) >= 2) f.onFailM = 1; else f.onFail1 = 1;
  }
  for (const l of obs.lakeHistory ?? []) {
    if (l.targetId === x && l.holderId !== p) {
      if (l.declaredClaim === 'good') f.lakeGood = 1;
      if (l.declaredClaim === 'evil') f.lakeEvil = 1;
    }
    if (l.holderId === x) {
      if (l.targetId === y && l.declaredClaim === 'good') f.heldYgood = 1;
      if (l.targetId === y && l.declaredClaim === 'evil') f.heldYevil = 1;
      if (l.targetId === p) f.heldP = 1;
    }
  }
  for (const l of obs.myLakeResults ?? []) {
    if (l.targetId !== x) continue;
    if (l.result === 'good') f.ownGood = 1; else f.ownEvil = 1;
  }
  return f;
}

/** 派西在隊上、失敗張數等於其他隊員人數的失敗任務：其他隊員確定是紅。 */
function provenRedByMyMissions(obs: PlayerObservation): Set<string> {
  const out = new Set<string>();
  for (const q of obs.questHistory ?? []) {
    if (!missionFailed(q) || !q.team.includes(obs.myPlayerId)) continue;
    if (failCards(q) >= q.team.length - 1) for (const id of q.team) if (id !== obs.myPlayerId) out.add(id);
  }
  return out;
}

export interface PercivalRead39 {
  /** 比較像梅林的那一根（完全分不出來時是 undefined）。 */
  fav?: string;
  unfav?: string;
  /** P(fav 是梅林)，≥ 0.5。 */
  conf: number;
  /** P(拇指 [0] 是梅林)。 */
  pFirst: number;
  thumbs: readonly [string, string];
}

/** 派西的拇指讀法（`percivalRead39`）。不是派西、拇指不是兩根時回傳 null。 */
export function percivalRead39(obs: PlayerObservation): PercivalRead39 | null {
  if (obs.myRole !== 'percival') return null;
  const th = obs.knownWizards ?? [];
  if (th.length !== 2) return null;
  const [a, b] = th;
  let pA: number;
  const own = (obs.myLakeResults ?? []).find((l) => l.targetId === a || l.targetId === b);
  const proven = provenRedByMyMissions(obs);
  if (own) {
    const aGood = own.targetId === a ? own.result === 'good' : own.result !== 'good';
    pA = aGood ? 1 : 0;
  } else if (proven.has(a) !== proven.has(b)) {
    pA = proven.has(a) ? 0 : 1;
  } else {
    const r = obs.currentRound ?? 1;
    const w = COEF[r <= 1 ? 'R1' : r === 2 ? 'R2' : r === 3 ? 'R3' : 'R45'];
    const fa = percivalThumbFeatures(obs, a, b);
    const fb = percivalThumbFeatures(obs, b, a);
    let z = 0;
    PERCIVAL_READ39_FEATURES.forEach((k, i) => { z += w[i] * (fa[k] - fb[k]); });
    pA = 1 / (1 + Math.exp(-z));
  }
  const tie = Math.abs(pA - 0.5) < 1e-9;
  const fav = tie ? undefined : pA > 0.5 ? a : b;
  const unfav = tie ? undefined : pA > 0.5 ? b : a;
  return { fav, unfav, conf: Math.max(pA, 1 - pA), pFirst: pA, thumbs: [a, b] };
}

export interface PercivalThumbPlan39 {
  read: PercivalRead39;
  /** 這一次帶比較像梅林的那一根。 */
  carryFav: boolean;
  /** 不能上隊的拇指（`soft` 時只是不給「帶 A」的加分／給「不帶 B」的扣分，不硬擋）。 */
  barred: ReadonlySet<string>;
  /** 模式 3：只改 A／B 的加減分，不硬擋任何拇指（邏輯優先 1E：除非確定是紅，派西不硬排除拇指，不變量 INV-Pe2）。 */
  soft?: boolean;
}

/** fav 只上過成功的任務（從沒上過失敗的任務）。 */
function succOnly(obs: PlayerObservation, id: string): boolean {
  const qs = (obs.questHistory ?? []).filter((q) => q.team.includes(id));
  return qs.length > 0 && qs.every((q) => !missionFailed(q));
}

/** 這一局有一根拇指當隊長、把另一根拇指派進隊（第 2 局第 5 次的「拇指派拇指」）。 */
function thumbOnThumb(obs: PlayerObservation, fav: string, unfav: string): boolean {
  const r = obs.currentRound ?? 1;
  return (obs.voteHistory ?? []).some((v) => v.round === r && v.leader === unfav && v.team.includes(fav));
}

/**
 * 派西當隊長、第 2 局起的帶拇指計畫（`percivalCarry39`；需要 `percivalRead39`）。`rnd` 只在模式 2 抽一次。
 */
export function percivalThumbPlan39(tuning: Readonly<AgentTuning>, obs: PlayerObservation, rnd: () => number = Math.random): PercivalThumbPlan39 | null {
  const mode = tuning.percivalCarry39 ?? 0;
  if (mode <= 0 || !(tuning.percivalRead39 ?? 0) || obs.myRole !== 'percival' || obs.gamePhase !== 'team_select') return null;
  const r = obs.currentRound ?? 1;
  if (r < 2) return null;
  const read = percivalRead39(obs);
  if (!read) return null;
  const [a, b] = read.thumbs;
  if (!read.fav || !read.unfav) return { read, carryFav: false, barred: new Set([a, b]), ...(mode === 3 ? { soft: true } : {}) };
  const forced = (obs.failCount ?? 0) >= 4;
  const r3First = r === 3 && (obs.failCount ?? 0) === 0;
  const conf = read.conf;
  let carryFav: boolean;
  if (conf >= 0.999 || succOnly(obs, read.fav)) carryFav = true;
  else if (r === 2 && forced) {
    carryFav = thumbOnThumb(obs, read.fav, read.unfav) || conf >= (mode === 1 ? 0.53 : 0.8);
  } else if (mode === 1 || mode === 3) {
    // 第 3 局第 1 次提議另一格：真人在這裡信心 < 0.65 時還是帶比較像梅林的那一根 42–54%（lp39 PA-08）。
    carryFav = conf >= (r === 2 ? 0.63 : r3First ? 0.55 : 0.64);
  } else {
    const q = conf < 0.65 ? (r3First ? 0.5 : 0.375) : conf < 0.8 ? 0.7 : 0.82;
    carryFav = rnd() < q;
  }
  const barred = new Set<string>();
  if (!carryFav) barred.add(read.fav);
  if (conf >= 0.7 || (r === 2 && forced)) barred.add(read.unfav);
  return mode === 3 ? { read, carryFav, barred, soft: true } : { read, carryFav, barred };
}

/**
 * 隊伍符不符合計畫：不同時帶兩根拇指、不帶被擋掉的那一根。例外：整隊照派上一次成功的隊、那根拇指本來就在上面。
 */
export function percivalThumbPlanAllows(plan: PercivalThumbPlan39 | null, obs: PlayerObservation, team: readonly string[]): boolean {
  if (!plan || plan.soft) return true;
  const [a, b] = plan.read.thumbs;
  const lastS = [...(obs.questHistory ?? [])].filter((q) => !missionFailed(q)).sort((x, y) => y.round - x.round)[0];
  const reuse = !!lastS && lastS.team.every((id) => team.includes(id));
  const exempt = (id: string): boolean => reuse && lastS!.team.includes(id);
  if (team.includes(a) && team.includes(b) && !(exempt(a) && exempt(b))) return false;
  for (const id of plan.barred) if (team.includes(id) && !exempt(id)) return false;
  return true;
}
