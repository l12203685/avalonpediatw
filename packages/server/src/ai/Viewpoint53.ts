/**
 * 第 53 回合（站長 11/19：「你只是隊伍組合跟我像 但推理內容完全不對」）：「隊長視角」的讀法——每一次提議都是隊長對其他人的一句話，
 * 照「坐在那個位置、只有當時公開資訊的忠臣」會怎麼派來讀（`Round50.proposalReads50`：那一刻、那個座位的公開視角下每一隊乾淨的機率；
 * 前面的提議誰被留下、誰被換掉都已經在那個後驗裡）。
 *
 * 公開視角的派隊模型 P_L(T) ∝ exp(β·log P(T 乾淨))（β = `BETA_TEAM_50`，真人忠臣隊長擬合）。在世界 w 下：
 *   - 隊長是好人：P(T | w) = (1 − q)·P_L(T) ＋ q·P_L(T)·[T 在 w 乾淨] / Z_w，Z_w = Σ_{T'} P_L(T')·[T' 在 w 乾淨]。
 *     q = 「知道一些東西的好人」的比例：他照公開視角派，但避開他知道的紅（梅林、場外資訊、讀人）；1 − q 是只照公開視角（含雷）。
 *     公開視角最想派的隊在 w 裡乾淨（Z_w 大）時，偏離它的隊幾乎不加分；最想派的隊在 w 裡有紅時，偏離到乾淨的隊才是強訊號——
 *     「1 派 149（不派 23）＝ 23 至少一壞」「4 不照派 149 ＝ 不信那一隊」這種讀法。
 *   - 隊長是紅：P(T | w) = (1 − r)·P_L(T) ＋ r·P_L(T)·[T 上有別的紅] / Y_w（同樣的寫法：r 的紅隊長會帶隊友）。
 * P_L(T) 在兩邊都有，比的時候消掉：世界權重乘上 (1 − q) ＋ q·[乾淨]/Z_w 或 (1 − r) ＋ r·[有別的紅]/Y_w。
 * q、r 照真人局最大概似擬合（`scripts/fitRound53.ts`）。觀察者自己的提議不讀（他知道自己為什麼這樣派）。
 */
import type { PlayerObservation } from './types';
import { BETA_TEAM_50, proposalReads50 } from './Round50';

export interface ViewpointTerm53 {
  /** 隊長的位元。 */
  lb: number;
  /** 隊長＋k−1 人的每一隊（位元遮罩）。 */
  masks: Int32Array;
  /** P_L(T)，和 `masks` 同序。 */
  pl: Float64Array;
  /** 實際的隊。 */
  actual: number;
  forced: boolean;
  /** 第 77 回合：第 1、2 局非強制的提議 = 那一局的位元（第 1 局 1、第 2 局 2）；其他 0／沒有。 */
  early?: number;
}

/** 觀察者以外的每一次提議的隊長視角項（`skipForced`：不讀第 5 次強制提議）。 */
export function viewpointTerms53(obs: PlayerObservation, skipForced = false, beta = BETA_TEAM_50): ViewpointTerm53[] {
  const reads = proposalReads50(obs);
  const me = obs.myPlayerId;
  const out: ViewpointTerm53[] = [];
  for (let i = 0; i < reads.length; i++) {
    const r = reads[i];
    if (!r || r.leader === me || (skipForced && r.forced)) continue;
    let mx = -Infinity;
    for (const x of r.logp) if (x > mx) mx = x;
    const e = Float64Array.from(r.logp, (x) => Math.exp(beta * (x - mx)));
    let z = 0;
    for (const x of e) z += x;
    for (let k = 0; k < e.length; k++) e[k] /= z;
    const v = obs.voteHistory[i];
    out.push({ lb: r.bitOf(r.leader), masks: r.masks, pl: e, actual: r.actualMask, forced: r.forced, early: v && !r.forced && v.attempt < 5 && v.round <= 2 ? v.round : 0 });
  }
  return out;
}

/**
 * 真人局擬合（`scripts/fitRound53.ts`，2,236 局、好人隊長 20,627 次、紅隊長 13,398 次；局的自助法 100 次）：
 *   q 梅林 0.455 [0.439, 0.476]、忠臣 0.065 [0.056, 0.077]、派西 0.125 [0.103, 0.147]、好人全部 0.141 [0.133, 0.151]；r 紅 0.050 [0.040, 0.064]。
 * 觀察者是派西時，好的那根拇指就是梅林（用 q 梅林），其他好人用忠臣＋派西的合併值；觀察者不知道誰是梅林時用好人全部的值。
 */
export const Q53_MERLIN = 0.455;
export const Q53_OTHER = 0.077;
export const Q53_MIX = 0.141;
export const R53 = 0.05;

/**
 * 世界 w（紅的位元遮罩）下全部隊長視角項的對數權重。`thumbs`：觀察者是派西時兩根拇指的位元（好的那根是梅林）；0 = 不知道誰是梅林。
 * `scale` 乘在 q、r 上（1 = 擬合值）。`cover`（第 77 回合）：第 1、2 局非強制的提議（`rounds` 的位元：1 = 第 1 局、2 = 第 2 局）好人隊長的 q
 * 以 `share` 的比例換成忠臣的值（梅林在那些提議照忠臣的流程派）；不給 = 照舊。
 */
export function viewpointLog53(terms: readonly ViewpointTerm53[], w: number, scale: number, thumbs = 0, cover?: { share: number; rounds: number }): number {
  let s = 0;
  const r = Math.min(R53 * scale, 0.99);
  for (const t of terms) {
    if ((w & t.lb) === 0) {
      const q0 = thumbs !== 0 ? ((thumbs & t.lb) !== 0 ? Q53_MERLIN : Q53_OTHER) : Q53_MIX;
      // 第 77 回合 `merlinCover77`：梅林在第 1、2 局非強制的提議以 share 的比例照忠臣的流程派——那些提議裡「知道一些東西的好人」的比例往忠臣的值靠。
      const covered = cover !== undefined && cover.share > 0 && (t.early ?? 0) > 0 && (cover.rounds & (t.early ?? 0)) !== 0 && q0 > Q53_OTHER;
      const q = Math.min((covered ? q0 + (Q53_OTHER - q0) * Math.min(cover!.share, 1) : q0) * scale, 0.99);
      if (!(q > 0)) continue;
      let z = 0;
      for (let k = 0; k < t.masks.length; k++) if ((w & t.masks[k]) === 0) z += t.pl[k];
      const clean = (w & t.actual) === 0;
      s += Math.log((1 - q) + (clean && z > 0 ? q / z : 0));
    } else {
      if (!(r > 0)) continue;
      const others = w & ~t.lb;
      let y = 0;
      for (let k = 0; k < t.masks.length; k++) if ((others & t.masks[k]) !== 0) y += t.pl[k];
      const mate = (others & t.actual) !== 0;
      s += Math.log((1 - r) + (mate && y > 0 ? r / y : 0));
    }
  }
  return s;
}
