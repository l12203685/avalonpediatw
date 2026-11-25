/**
 * 第 77 回合（藍方・梅林）：梅林的提議在世界線刺客（第 75 回合 `assassinWorldLine75`）眼裡不要比忠臣好認。
 *
 * 第 75 回合量到：世界線刺客最穩的訊號是「梅林逐人、分角色的派法」。拆到格之後（`scripts/merlinLeakStudy77.py`）幾乎全部是同一件事——
 * **梅林的隊不帶他看得到的紅，忠臣的隊常常帶**：隊上看得到的紅一樣多時，梅林和忠臣的提議在表裡分不出來；第 1 局非強制的提議
 * 忠臣帶到看得到的紅 54%（真人 58%）、梅林 1%（真人 6.5%），這一格加第 2 局非強制的提議占全部證據的一半以上。
 * 這些提議幾乎不會出任務（真人局出任務的比例低於一成，`BlueRound37.PROPOSAL_GO_RATE`；和 `merlinFlowFollow`、`merlinPublicThumb58` 同一個範圍）。
 *
 * `merlinCover77 = q`（0–1，0 = 關）：在這個範圍裡，梅林以比例 q（照座位、局、第幾次提議雜湊；同一個局面每次一樣）派
 * 「坐在他位置、只看公開紀錄的忠臣」會派的那一隊——整條忠臣的派隊流程（`ForwardAgent.decideMain` 的公開視角），看得到的紅在不在隊上
 * 由公開局勢決定，不刻意放也不刻意避開。這樣他在這幾格的每一種派法出現的比例就是忠臣的比例。
 * 照舊不放的（放了就照原本的派法）：出過失敗任務、他看得到的紅（`merlinKnownRed54`）；他自己確定但看不到的紅（湖＋任務證明的莫德雷德，Issue #17）；
 * 湖的規則擋下的人；過不了公開視角邏輯閘門的隊。第 3 局起、強制局都不碰（會出任務；A1「紅方已兩勝必出失敗」與 A0 不相干）。
 *
 * `merlinCoverScope77`（位元；0 = 1＋2）：1 = 第 1 局；2 = 第 2 局；4 = 那一隊帶兩個以上看得到的紅就照原本的派法；
 * 8 = 這一局他前面已經有一次非強制的提議帶過看得到的紅，就照原本的派法（一局最多一次）。
 *
 * 藍方的讀法跟著變（`merlinCoverMix77`）：`merlinCover77` 開的時候，忠臣／派西讀好人隊長第 1、2 局非強制的提議，「知道一些東西的好人」的比例
 * 以 q 的比例換成忠臣的值（現行預設讀提議用的隊長視角讀法，`Viewpoint53.viewpointLog53` 的 `cover`：派西眼中好的那根拇指原本用梅林的 0.455，
 * 蓋住的提議用忠臣的 0.077）。不這樣讀，梅林照忠臣派的那一隊一帶到看得到的紅，派西維爾就會把隊上的人讀得太乾淨、把真梅林那根拇指讀成莫甘娜。
 * 舊的嚴格讀法（`BayesOptions.merlinEarlyMix`；現行預設的提議次方是 0，不會用到）也一樣：嚴格模型的比重 1 − q，其餘照忠臣隊長的派隊表（`merlinEarlyGood`）。
 */
import type { AgentTuning } from './AgentTuning';
import type { PlayerObservation } from './types';
import { PROPOSAL_GO_RATE } from './BlueRound37';

/** 診斷計數（研究腳本、自我對打的拆解用；不影響決策）。 */
export const round77Stats = { applies: 0, sent: 0, thumb: 0, same: 0, barred: 0 };

function hash01(text: string): number {
  let h = 0x811c9dc5;
  for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return (h % 10000) / 10000;
}

/** `merlinCoverScope77` 的局別位元（0 = 第 1、2 局都用）。 */
function roundBits(tuning: Readonly<AgentTuning>): number {
  const bits = (tuning.merlinCoverScope77 ?? 0) & 3;
  return bits === 0 ? 3 : bits;
}

/** 這一次梅林的提議要不要照忠臣的流程派（範圍＋比例）；不適用 = false。 */
export function merlinCover77Now(tuning: Readonly<AgentTuning>, obs: PlayerObservation): boolean {
  const q = tuning.merlinCover77 ?? 0;
  if (!(q > 0) || obs.myRole !== 'merlin' || obs.gamePhase !== 'team_select') return false;
  const round = obs.currentRound ?? 1;
  const fc = obs.failCount ?? 0;
  // 只有幾乎不會出任務的提議：第 1、2 局非強制（同 `merlinFlowFollow`、`merlinPublicThumb58` 的範圍）。
  if (round > 2 || fc >= 4 || (PROPOSAL_GO_RATE[round]?.[fc] ?? 1) >= 0.1) return false;
  if ((roundBits(tuning) & (round === 1 ? 1 : 2)) === 0) return false;
  const me = obs.myPlayerId;
  if (((tuning.merlinCoverScope77 ?? 0) & 8) !== 0) {
    const seen = new Set(obs.knownEvils);
    if (obs.voteHistory.some((v) => v.leader === me && v.attempt < 5 && v.team.some((id) => seen.has(id)))) return false;
  }
  return q >= 1 || hash01(`${me}|${round}|${fc}|cover77`) < q;
}

/**
 * 忠臣流程派出來的隊 `team` 梅林能不能照派：`barred` = 呼叫端算好的不能放的人（`merlinKnownRed54` 擋下的紅、他自己確定但看不到的紅、湖的規則擋下的人）。
 * 位元 4：兩個以上看得到的紅不派。
 */
export function merlinCover77TeamOk(tuning: Readonly<AgentTuning>, obs: PlayerObservation, team: readonly string[], barred: readonly string[]): boolean {
  if (team.some((id) => barred.includes(id))) return false;
  if (((tuning.merlinCoverScope77 ?? 0) & 4) !== 0 && team.filter((id) => obs.knownEvils.includes(id)).length >= 2) return false;
  return true;
}

/**
 * 藍方讀「可能是梅林的人」第 1、2 局非強制的提議：嚴格模型的比重（其餘照一般藍方的派隊表）與套用的局別（0 = 兩局）。
 * `merlinCover77` 關的時候回 null（讀法不變）。
 */
export function merlinCoverMix77(tuning: Readonly<Partial<AgentTuning>>): { mix: number; round: number } | null {
  const q = tuning.merlinCover77 ?? 0;
  if (!(q > 0)) return null;
  const bits = ((tuning.merlinCoverScope77 ?? 0) & 3) || 3;
  return { mix: Math.max(0, 1 - Math.min(q, 1)), round: bits === 3 ? 0 : bits };
}
