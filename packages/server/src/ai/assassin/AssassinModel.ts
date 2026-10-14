/**
 * AssassinModel — 刺殺選人的條件邏輯回歸（2026-10-12）。
 *
 * 只用刺客「合法」看得到的資訊：
 *   - 公開歷史：每次提議的隊伍、隊長與票型（強制局的合成票不算）、
 *     任務結果、已宣告的湖；
 *   - 刺客自己知道的紅方隊友（`knownEvils`）與刺殺階段的完整紅方名單
 *     （`allEvilIds`，只拿來排除候選與判斷湖主陣營）。
 *   絕不讀 roleMap；候選人的真實角色只在訓練時當標籤。
 *
 * 模型：每個候選人 c 一個特徵向量 x_c，P(c = 梅林) ∝ exp(w · x_c)
 * （softmax over 候選）。權重由 `scripts/assassinModel.ts` 用
 * `sheets_cache.json` 的牌譜（有刺殺目標的三藍局）訓練，以對局為單位
 * 70/30 切分，寫進 `assassinModelWeights.ts`。訓練方法、測試集刺中率與
 * 基準見 `docs/ai/strength_benchmark.md`。
 *
 * 權重是「原始特徵尺度」（訓練時的標準化已折進權重），推論時直接
 * 內積即可；softmax 的常數項對 argmax 沒有影響，所以不存偏置。
 */

import type { PlayerObservation, VoteRecord } from '../types';
import { ASSASSIN_MODEL_WEIGHTS } from './assassinModelWeights';

export interface AssassinModelWeights {
  /** 版本字串（訓練日期 + 資料快照）。 */
  version: string;
  /** 與 `ASSASSIN_FEATURE_NAMES` 同序。 */
  features: readonly string[];
  weights: readonly number[];
}

export const ASSASSIN_FEATURE_NAMES: readonly string[] = [
  // 隊伍 / 任務
  'propRate',            // 被提議次數 / 提議總數
  'succMissions',        // 參與的成功任務數
  'failMissions',        // 參與的失敗任務數
  'cleanRecord',         // 有失敗任務但本人從未在失敗隊上
  'lastSuccessTeam',     // 在最後一次成功任務隊上
  'r1Mission',           // 在 R1 出任務隊上
  'onTeamWithEvilRate',  // 被提議時隊上含可見紅（刺客 / 隊友）的比例
  'pickedByEvilRate',    // 紅方（刺客 / 隊友）當隊長時選到本人的比例
  // 投票（排除強制局）
  'offApproveRate',      // 隊外投白比例
  'onRejectRate',        // 隊內投黑比例
  'rejectSelfTeamRate',  // 隊伍含刺客時投黑的比例
  'approveSelfTeamOff',  // 隊外投白給含刺客的隊伍（次數）
  'rejectAllyTeamRate',  // 隊伍含刺客隊友時投黑的比例
  'approveAllyTeamOff',  // 隊外投白給含隊友的隊伍（次數）
  'approveCleanOffRate', // 隊外投白給「無可見紅」隊伍的比例
  'rejectCleanOnRate',   // 隊內投黑給「無可見紅」隊伍的比例
  'voteOutcomeAgreeRate',// 票與任務結果一致的比例（白→成功、黑→失敗）
  'agreeWithAssassinRate',// 與刺客同票的比例
  // 隊長
  'ledRate',             // 當隊長次數 / 提議總數
  'ledWithSelfRate',     // 自己派隊時含刺客的比例
  'ledWithAllyRate',     // 自己派隊時含隊友的比例
  'ledCleanCount',       // 自己派隊無可見紅的次數
  'ledApprovedRate',     // 自己派的隊伍通過的比例
  // 湖
  'lakedByEvilGood',     // 被紅方湖主宣告好
  'lakedByEvilEvil',     // 被紅方湖主宣告壞
  'lakedByOtherGood',    // 被非紅湖主宣告好
  'lakedByOtherEvil',    // 被非紅湖主宣告壞
  'heldLake',            // 當過湖主
  'lakeTargetEvil',      // 當湖主時查了紅方
  // 座位（one-hot，座位 1..10）
  'seat1', 'seat2', 'seat3', 'seat4', 'seat5', 'seat6', 'seat7', 'seat8', 'seat9', 'seat10',
];

function isForced(v: VoteRecord): boolean {
  return v.attempt >= 5;
}

function ratio(num: number, den: number): number {
  return den === 0 ? 0 : num / den;
}

/**
 * 候選人 `candidateId` 的特徵向量（與 `ASSASSIN_FEATURE_NAMES` 同序）。
 * `obs` 必須是刺客自己的觀測（`myPlayerId` = 刺客）。
 */
export function assassinCandidateFeatures(obs: PlayerObservation, candidateId: string): number[] {
  const me = obs.myPlayerId;
  const ally = new Set(obs.knownEvils);
  const evilAll = new Set<string>([me, ...obs.knownEvils, ...(obs.allEvilIds ?? [])]);
  const visibleEvil = (id: string): boolean => id === me || ally.has(id);

  const votes = obs.voteHistory;
  const quests = obs.questHistory;
  const c = candidateId;

  // 隊伍 / 任務
  const totalProps = votes.length;
  let propCount = 0;
  let onTeamWithEvil = 0;
  let evilLed = 0;
  let evilLedPicked = 0;
  for (const v of votes) {
    const onTeam = v.team.includes(c);
    if (onTeam) {
      propCount++;
      if (v.team.some((id) => id !== c && visibleEvil(id))) onTeamWithEvil++;
    }
    if (visibleEvil(v.leader)) {
      evilLed++;
      if (onTeam) evilLedPicked++;
    }
  }
  let succMissions = 0;
  let failMissions = 0;
  let anyFail = false;
  let lastSuccessRound = 0;
  for (const q of quests) {
    const on = q.team.includes(c);
    if (q.result === 'fail') {
      anyFail = true;
      if (on) failMissions++;
    } else {
      lastSuccessRound = q.round;
      if (on) succMissions++;
    }
  }
  const lastSuccess = quests.find((q) => q.round === lastSuccessRound);
  const lastSuccessTeam = lastSuccess !== undefined && lastSuccess.team.includes(c) ? 1 : 0;
  const r1 = quests.find((q) => q.round === 1);
  const r1Mission = r1 !== undefined && r1.team.includes(c) ? 1 : 0;

  // 投票
  let off = 0, offApprove = 0;
  let on = 0, onReject = 0;
  let selfTeam = 0, selfTeamReject = 0, approveSelfTeamOff = 0;
  let allyTeam = 0, allyTeamReject = 0, approveAllyTeamOff = 0;
  let cleanOff = 0, cleanOffApprove = 0;
  let cleanOn = 0, cleanOnReject = 0;
  let missionVotes = 0, outcomeAgree = 0;
  let paired = 0, agree = 0;
  const questByRound = new Map(quests.map((q) => [q.round, q]));
  for (const v of votes) {
    if (isForced(v)) continue;
    const vote = v.votes[c];
    if (vote === undefined) continue;
    const onTeam = v.team.includes(c);
    const hasSelf = v.team.includes(me);
    const hasAlly = v.team.some((id) => ally.has(id));
    const clean = !hasSelf && !hasAlly;
    if (onTeam) {
      on++;
      if (!vote) onReject++;
      if (clean) {
        cleanOn++;
        if (!vote) cleanOnReject++;
      }
    } else {
      off++;
      if (vote) offApprove++;
      if (clean) {
        cleanOff++;
        if (vote) cleanOffApprove++;
      }
      if (hasSelf && vote) approveSelfTeamOff++;
      if (hasAlly && vote) approveAllyTeamOff++;
    }
    if (hasSelf) {
      selfTeam++;
      if (!vote) selfTeamReject++;
    }
    if (hasAlly) {
      allyTeam++;
      if (!vote) allyTeamReject++;
    }
    if (v.approved) {
      const q = questByRound.get(v.round);
      if (q) {
        missionVotes++;
        if ((vote && q.result === 'success') || (!vote && q.result === 'fail')) outcomeAgree++;
      }
    }
    const mine = v.votes[me];
    if (mine !== undefined) {
      paired++;
      if (mine === vote) agree++;
    }
  }

  // 隊長
  let led = 0, ledWithSelf = 0, ledWithAlly = 0, ledClean = 0, ledApproved = 0;
  for (const v of votes) {
    if (v.leader !== c) continue;
    led++;
    const hasSelf = v.team.includes(me);
    const hasAlly = v.team.some((id) => ally.has(id));
    if (hasSelf) ledWithSelf++;
    if (hasAlly) ledWithAlly++;
    if (!hasSelf && !hasAlly) ledClean++;
    if (v.approved) ledApproved++;
  }

  // 湖
  let lakedByEvilGood = 0, lakedByEvilEvil = 0, lakedByOtherGood = 0, lakedByOtherEvil = 0;
  let heldLake = 0, lakeTargetEvil = 0;
  // Undeclared lakes (`'none'`, S1-9c) were absent before 2026-10-14; the
  // trained weights expect that, so they stay out.
  for (const rec of obs.lakeHistory ?? []) {
    if (rec.declaredClaim === 'none') continue;
    if (rec.targetId === c) {
      const evilHolder = evilAll.has(rec.holderId);
      if (rec.declaredClaim === 'good') {
        if (evilHolder) lakedByEvilGood = 1; else lakedByOtherGood = 1;
      } else if (evilHolder) lakedByEvilEvil = 1; else lakedByOtherEvil = 1;
    }
    if (rec.holderId === c) {
      heldLake = 1;
      if (evilAll.has(rec.targetId)) lakeTargetEvil = 1;
    }
  }

  const seatIdx = obs.allPlayerIds.indexOf(c);
  const seats = Array.from({ length: 10 }, (_, i) => (i === seatIdx ? 1 : 0));

  return [
    ratio(propCount, totalProps),
    succMissions,
    failMissions,
    anyFail && failMissions === 0 ? 1 : 0,
    lastSuccessTeam,
    r1Mission,
    ratio(onTeamWithEvil, propCount),
    ratio(evilLedPicked, evilLed),
    ratio(offApprove, off),
    ratio(onReject, on),
    ratio(selfTeamReject, selfTeam),
    approveSelfTeamOff,
    ratio(allyTeamReject, allyTeam),
    approveAllyTeamOff,
    ratio(cleanOffApprove, cleanOff),
    ratio(cleanOnReject, cleanOn),
    ratio(outcomeAgree, missionVotes),
    ratio(agree, paired),
    ratio(led, totalProps),
    ratio(ledWithSelf, led),
    ratio(ledWithAlly, led),
    ledClean,
    ratio(ledApproved, led),
    lakedByEvilGood,
    lakedByEvilEvil,
    lakedByOtherGood,
    lakedByOtherEvil,
    heldLake,
    lakeTargetEvil,
    ...seats,
  ];
}

function dot(w: readonly number[], x: readonly number[]): number {
  let s = 0;
  const n = Math.min(w.length, x.length);
  for (let i = 0; i < n; i++) s += w[i] * x[i];
  return s;
}

/** 每位候選人的線性分數 w · x（越高越像梅林）。 */
export function scoreAssassinCandidates(
  obs: PlayerObservation,
  candidates: readonly string[],
  model: AssassinModelWeights = ASSASSIN_MODEL_WEIGHTS,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const id of candidates) {
    out.set(id, dot(model.weights, assassinCandidateFeatures(obs, id)));
  }
  return out;
}

/** 分數轉成候選人間的機率（softmax）。 */
export function assassinTargetProbabilities(
  obs: PlayerObservation,
  candidates: readonly string[],
  model: AssassinModelWeights = ASSASSIN_MODEL_WEIGHTS,
): Map<string, number> {
  const scores = scoreAssassinCandidates(obs, candidates, model);
  let max = Number.NEGATIVE_INFINITY;
  for (const s of scores.values()) if (s > max) max = s;
  let z = 0;
  const exps = new Map<string, number>();
  for (const [id, s] of scores) {
    const e = Math.exp(s - max);
    exps.set(id, e);
    z += e;
  }
  const out = new Map<string, number>();
  for (const [id, e] of exps) out.set(id, e / z);
  return out;
}

/**
 * 模型的刺殺目標：分數最高的候選人；同分依 `allPlayerIds` 座位序（決定性）。
 * `candidates` 應已排除紅方（呼叫端用 `allEvilIds` 過濾）。
 */
export function pickAssassinTargetByModel(
  obs: PlayerObservation,
  candidates: readonly string[],
  model: AssassinModelWeights = ASSASSIN_MODEL_WEIGHTS,
): string {
  if (candidates.length === 0) throw new Error('pickAssassinTargetByModel: no candidates');
  const scores = scoreAssassinCandidates(obs, candidates, model);
  const order = new Map(obs.allPlayerIds.map((id, i) => [id, i]));
  let best = candidates[0];
  for (const id of candidates.slice(1)) {
    const a = scores.get(id) ?? 0;
    const b = scores.get(best) ?? 0;
    if (a > b || (a === b && (order.get(id) ?? 0) < (order.get(best) ?? 0))) best = id;
  }
  return best;
}
