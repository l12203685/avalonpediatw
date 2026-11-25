/**
 * 第 75 回合（紅方・刺客）：刺殺照「派西維爾－梅林」世界線找梅林。
 *
 * 站長 2026-11-25（原話）：
 * >「真人刺中率比較高是因為 來自四個紅方的視角會綜合考慮 你不能只考慮刺客的視角
 * >  還有莫甘娜跟整體場上的反饋 因為莫甘娜會被派西維爾看到 所以考慮刺殺梅林時 可以從這點去反推可能的派西維爾位置
 * >  進而推出誰是派西維爾 誰是梅林 的世界線存在的可能性與合理性」
 *
 * 現行的刺殺（`assassin/*`）一次只看一個候選人：條件 logit 模型＋投票／隊長／照派讀法，用到的紅方資訊是「誰是紅」
 * （刺客自己的隊友、開牌之後的完整名單）與「誰是莫德雷德」（梅林看不到他）。**誰是莫甘娜從來沒有用到**——沒有任何一項在推派西維爾。
 *
 * `assassinWorldLine75`（0 = 關）：刺殺分數 = `assassinWorldLineOwn75` × 現行分數 ＋ `assassinWorldLine75` × log P(梅林 = 候選人)，
 * P 來自 30 條世界線（`assassin/WorldLines75.ts`；真人局擬合）。分層（`assassinVisibleRedTier`，INV-A2）照舊在前，只改第一層裡的排序。
 * 只在紅方開牌之後（`allEvilRoles`，四個紅方一起討論）、10 人局、紅方是刺客／莫甘娜／莫德雷德／奧伯倫各一個時套用；其他情況照原本。
 * A0（好人持湖說實話）、A1（紅方已兩勝必出失敗）不相干：這個開關只碰刺殺選人。
 */
import type { AgentTuning } from './AgentTuning';
import type { PlayerObservation } from './types';
import { WORLD_LINE_TABLES_75, worldLines75, type WorldLineReadout, type WorldLineTables } from './assassin/WorldLines75';

/** 診斷計數（研究腳本用；不影響決策）。 */
export const round75Stats = { applied: 0, notApplicable: 0 };

let activeTables: WorldLineTables = WORLD_LINE_TABLES_75;

/**
 * 研究腳本用：換一份表（交叉擬合時，驗證的那一半要用另一半的局擬合的表）；null = 換回正式的表。
 * 正式流程不呼叫。
 */
export function setWorldLineTables75(tables: WorldLineTables | null): void {
  activeTables = tables ?? WORLD_LINE_TABLES_75;
}

/** 現在用的表（測試、研究腳本用）。 */
export function worldLineTables75(): WorldLineTables {
  return activeTables;
}

/** 世界線的讀法（開關開、而且這個觀測適用時）；否則 null。 */
export function worldLineReadout75(tuning: Readonly<AgentTuning>, obs: PlayerObservation): WorldLineReadout | null {
  if ((tuning.assassinWorldLine75 ?? 0) <= 0) return null;
  const out = worldLines75(obs, activeTables);
  if (out) round75Stats.applied++; else round75Stats.notApplicable++;
  return out;
}

/**
 * 把世界線的梅林邊際加進刺殺分數：`own × 現行分數 + w × log P(梅林 = id)`。開關關、或不適用時原樣回傳同一個 Map。
 * 候選人不在世界線裡（不會發生：候選人都是藍方）當成比最低的邊際再低一點。
 */
export function applyWorldLine75(tuning: Readonly<AgentTuning>, obs: PlayerObservation, scores: Map<string, number>): Map<string, number> {
  const read = worldLineReadout75(tuning, obs);
  if (!read) return scores;
  const w = tuning.assassinWorldLine75 ?? 0;
  const own = tuning.assassinWorldLineOwn75 ?? 0;
  let floor = 0;
  for (const v of read.merlin.values()) if (v < floor) floor = v;
  const out = new Map<string, number>();
  for (const [id, s] of scores) out.set(id, own * s + w * (read.merlin.get(id) ?? floor - 1));
  return out;
}
