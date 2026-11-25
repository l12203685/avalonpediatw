/**
 * 第 76 回合（藍方）：忠臣、派西第 4 局（要兩張失敗）在隊上的票——照比分分開的門檻、門檻附近的漸進。
 *
 * 起點（`docs/ai/gap/loyal-breakdown-leads.md` A1；全部真人局用 `scripts/onTeamVoteStudy76.ts` 重量）：真人桌的 `onTeamVote59=0.8`
 * （第 59 回合：P(隊上的紅 ≥ 2) ≥ 0.8 才內黑）把第 4 局在隊上的內黑從基準線的五成壓到一成以下，隊上其實有兩個紅的隊幾乎不擋；
 * 真人會隨著隊上的紅變多而多擋。第 4 局只有兩種比分：
 *   - 1:2（紅方已兩勝）：這一隊失敗紅方就贏；
 *   - 2:1（藍方已兩勝）：這一隊成功藍方就三勝、失敗還有第 5 局。
 * 兩種比分放行一支會失敗的隊的代價不同，所以門檻分開；`onTeamVote59` 一個數管兩種比分。
 *
 * 開關（都預設 0 = 關；關著時這個檔案不改任何決定）：
 * - `onTeamR4Key76 = θ`：第 4 局、比分 1:2、在隊上，P(隊上的紅 ≥ 2) ≥ θ 才內黑（取代 `onTeamVote59` 在這個比分的值）。
 * - `onTeamR4Open76 = θ`：同上，比分 2:1。
 * - `onTeamR4Soft76 = w`：門檻附近的漸進——門檻改成 θ ＋ w ×（2u − 1），u 是這個局面的雜湊（座位、第幾次提議、隊伍；同一個局面每次一樣）。
 *   P 在 θ − w 以下一律贊成、θ ＋ w 以上一律內黑，中間照比例（真人的反對率就是跟著 P 連續升高，不是一刀切）。
 *   θ 取這個比分的 `onTeamR4Key76`／`onTeamR4Open76`，沒有設就取 `onTeamVote59`；兩個都沒有 = 不適用。
 * - `onTeamR4Prov76 = 1`：第 4 局照字面讀的時候（`onTeamVote59` 或上面兩個門檻有設），「公開邏輯證明會失敗」（provFail）也照字面——
 *   要兩個確定的紅才直接內黑；只有一個確定的紅時改看 P(隊上的紅 ≥ 2) 過不過門檻。原本這一步照「隊上有紅」讀（一個確定的紅就內黑），
 *   真人局這種票 365 張裡任務真的失敗的只有 39%。好人投票關卡（`LogicGates.goodVoteGate`）本來就照那一局要幾張失敗判，不受影響。
 *
 * 和第 59 回合相同的範圍：只改 `BlueRound33.bayesVoteCriteria` 在隊上的那一段（門檻那一步；`onTeamR4Prov76` 另外改 provFail 要幾個確定的紅）——
 * 好人投票關卡、湖的硬規則、隊長自己贊成、不在隊上的票、第 3、5 局都不變；「之後還會當隊長」的位移（`leaderOppVote51`）照樣扣。
 * 只給忠臣、派西（梅林在隊上的正常票走公開視角 `publicLoyalView`，這裡略過；第 59 回合量過梅林一起改是負的）。
 * A0（好人持湖說實話）、A1（紅方已兩勝必出失敗）不相干。
 */
import type { PlayerObservation } from './types';
import type { AgentTuning } from './AgentTuning';

function hash01(s: string): number {
  let h = 0x811c9dc5;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return (h % 10000) / 10000;
}

/** 第 76 回合的開關有沒有任何一個打開。 */
export function round76On(tuning: Readonly<AgentTuning>): boolean {
  return (tuning.onTeamR4Key76 ?? 0) > 0 || (tuning.onTeamR4Open76 ?? 0) > 0 || (tuning.onTeamR4Soft76 ?? 0) > 0 || (tuning.onTeamR4Prov76 ?? 0) > 0;
}

/**
 * 「公開邏輯證明會失敗」要幾個確定的紅：`onTeamR4Prov76` 開、第 4 局（要兩張失敗）、而且這一點照字面讀（這個比分有第 59 或 76 回合的門檻）
 * → 那一局要的失敗張數；其他情況回傳呼叫端原本的 `req`。梅林的公開視角略過（同第 59 回合）。
 */
export function provReq76(tuning: Readonly<AgentTuning>, obs: PlayerObservation, failsRequired: number, req: number): number {
  if (!((tuning.onTeamR4Prov76 ?? 0) > 0) || obs.publicLoyalView === true) return req;
  if ((obs.currentRound ?? 1) !== 4 || failsRequired < 2) return req;
  const key = (obs.questResults ?? []).filter((r) => r === 'fail').length >= 2;
  const literal = (tuning.onTeamVote59 ?? 0) > 0 || (key ? (tuning.onTeamR4Key76 ?? 0) : (tuning.onTeamR4Open76 ?? 0)) > 0;
  return literal ? failsRequired : req;
}

/**
 * 第 76 回合在這一點的（要幾個紅、門檻）；null = 照原本（第 59 回合的 `onTeamBar59` 或基準線）。
 * 呼叫端：藍方（忠臣、派西）在隊上、第 3–5 局、非強制、不是隊長。
 */
export function onTeamBar76(tuning: Readonly<AgentTuning>, obs: PlayerObservation, failsRequired: number, team: readonly string[]): { req: number; bar: number } | null {
  if (!round76On(tuning) || obs.publicLoyalView === true) return null;
  if ((obs.currentRound ?? 1) !== 4 || failsRequired < 2) return null;
  const key = (obs.questResults ?? []).filter((r) => r === 'fail').length >= 2;
  const own = key ? (tuning.onTeamR4Key76 ?? 0) : (tuning.onTeamR4Open76 ?? 0);
  const theta = own > 0 ? own : (tuning.onTeamVote59 ?? 0);
  if (!(theta > 0)) return null;
  const w = tuning.onTeamR4Soft76 ?? 0;
  if (!(w > 0)) return own > 0 ? { req: failsRequired, bar: theta } : null;
  const u = hash01(`${obs.myPlayerId}|${obs.failCount ?? 0}|${[...team].sort().join(',')}|r4soft76`);
  return { req: failsRequired, bar: theta + w * (2 * u - 1) };
}
