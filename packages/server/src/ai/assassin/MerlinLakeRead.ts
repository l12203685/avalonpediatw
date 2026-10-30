/**
 * 刺客從湖找梅林（優化迴圈第 12 回合・紅方候選，2026-10-31；`AgentTuning.assassinLakeRead`）。
 *
 * 梅林持湖時不會湖他看得到的紅（他已經知道答案，湖了沒有資訊）：第 11 回合預設的自我對打裡，梅林湖到看得到的紅 0%，
 * 其他藍方持湖者 23%。刺殺階段紅方開牌相認，刺客知道每個湖目標是不是梅林看得到的紅（莫德雷德除外）：
 * - 湖到看得到的紅：P(| 梅林) = ε，P(| 其他藍方) ≈ q；
 * - 湖到其他人：P(| 梅林) = 1 − ε，P(| 其他藍方) ≈ 1 − q。
 * 對數概似比加總、乘權重加到刺殺分數上（同 `MerlinVoteRead` 的接法）。只用公開的湖紀錄（持湖者、目標）。
 */
import type { PlayerObservation } from '../types';

const EPS = 0.05;
/** How often a blue holder other than Merlin lakes a red Merlin sees (round-11 self-play, 238 lakes). */
export const BLUE_LAKES_SEEN_RED = 0.23;

/** log [ mean over Mordred d of P(lakes | Merlin) / P(lakes | other blue) ] for `candidate`. */
export function merlinLakeLogRatio(obs: PlayerObservation, candidate: string, reds: readonly string[]): number {
  const lakes = (obs.lakeHistory ?? []).filter((l) => l.holderId === candidate);
  if (lakes.length === 0 || reds.length === 0) return 0;
  const roles = obs.allEvilRoles;
  const known = roles ? reds.filter((id) => roles[id] === 'mordred') : [];
  const mordreds: (string | null)[] = roles ? (known.length > 0 ? known : [null]) : [...reds];
  let sum = 0;
  for (const d of mordreds) {
    let lr = 0;
    for (const l of lakes) {
      const seen = l.targetId !== d && reds.includes(l.targetId);
      lr += seen ? Math.log(EPS / BLUE_LAKES_SEEN_RED) : Math.log((1 - EPS) / (1 - BLUE_LAKES_SEEN_RED));
    }
    sum += Math.exp(lr);
  }
  return Math.log(sum / mordreds.length);
}
