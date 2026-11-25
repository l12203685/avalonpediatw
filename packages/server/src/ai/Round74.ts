/**
 * 第 74 回合（情境分析；藍方・派西）：情境題庫（`scenarios/`、`docs/ai/gap/r74-scenarios.md`）裡和真人差最多的一類——派西的拇指。
 *
 * 站長 2026-11-25：「策略的優化方式可以從我說的 節點分支的拆解或是情境分析去做」。每日一題題庫的 1,849 個派西題（第 2 局起派西第一次當隊長）：
 * - 派出去的隊「全藍」的比例機器人不輸真人（43% 對 40%），但**帶到莫甘娜** 25% 對真人 17%，**兩根都不帶** 15–18% 對真人 35%；
 * - 差最多的是「只有一根拇指出過失敗的任務」的第 2 局（265 題）：機器人幾乎一定帶沒沾到的那一根（真人桌讀法 0% 不帶、基準線 14%，真人 45%），
 *   帶到莫甘娜 38% 對真人 17%。在真人牌譜上，被一張失敗的任務沾到的那一根是梅林的比例是 50.9%（584 題；兩張以上失敗才有資訊：18.4%）——
 *   梅林看不到莫德雷德、第 1 局的隊又多半是強制局，被沾到不是他能避開的；這就是每日一題 2026-11-24（TMQ2M-3-4）的局面。
 * - 派西後驗裡「哪一根是梅林」的準度（Brier 0.200／0.218）比第 39 回合在真人牌譜上擬合的讀法（0.187）差。
 *
 * 兩個開關（預設都關；關的時候程式路徑不變）：
 *
 * `percivalNoInfo74`（0–1 的門檻；0 = 關）——Edward 10/14「派西沒資訊時預設不派拇指」延伸到第 2 局起：派西當隊長，擬合讀法（`percivalRead39`）
 * 對「哪一根是梅林」的信心低於門檻、而且第 39 回合的計畫本來就不帶比較像梅林的那一根時，兩根拇指都不帶（硬擋，每一個重新挑隊的步驟都檢查；
 * 整隊照派上一次成功的隊、拇指本來就在上面照舊可以）。信心夠、或比較像梅林的那一根只上過成功的任務時照原本。
 * **硬擋拇指和邏輯優先 1E／不變量 INV-Pe2（除非確定是紅，派西不硬排除拇指）衝突**（同第 39 回合的 `percivalCarry39=1`／`2`）：不變量檢查在這個開關打開時
 * 會報 INV-Pe2 違反，所以沒有站長的裁定不能用。量測：派法變得很像真人（帶莫甘娜 25 → 17%、都不帶 15 → 32%），人類 PR 量尺派西 −0.19 ± 0.13，沒有採用。
 *
 * `thumbBlend74`（0–1 的權重；0 = 關）——派西後驗裡兩根拇指誰是紅的比例，改成後驗和擬合讀法在 log-odds 上的加權平均
 * （權重 w 給讀法；w = 1 就是第 40 回合的 `percivalRead39=1`），每一種拇指分配裡各個世界的相對權重不變。
 * **第 74 回合：三種真人桌採用 0.25**（`humanProfile.ts`；真人局 Brier 每一層兩半都變好、人類 PR 量尺派西 +0.43 ± 0.12）；基準線 0。
 *
 * A0（好人持湖說實話）、A1（紅方已兩勝必出失敗）不相干；派西自己的湖驗到拇指、任務證明的紅照舊是確定的（讀法回 0／1 時後驗本來就是 0／1）。
 */
import type { AgentTuning } from './AgentTuning';
import type { PercivalThumbPlan39 } from './BlueRound39Percival';
import type { PlayerObservation } from './types';

/** 診斷計數（研究腳本用；不影響決策）。 */
export const round74Stats = { noInfoBar: 0, blend: 0 };

/** `percivalNoInfo74` 的門檻（0 = 關）。 */
export function noInfoThreshold74(tuning: Readonly<Partial<AgentTuning>>): number {
  const v = tuning.percivalNoInfo74 ?? 0;
  return v > 0 ? Math.min(v, 1) : 0;
}

/**
 * `percivalNoInfo74`：第 39 回合的帶拇指計畫（`percivalThumbPlan39`）在「分不出來」的時候改成兩根都硬擋。
 * 計畫是 null（不是派西當隊長、第 1 局、`percivalCarry39` 關著）或開關關著時原樣傳回。
 */
export function noInfoPlan74(tuning: Readonly<Partial<AgentTuning>>, obs: PlayerObservation, plan: PercivalThumbPlan39 | null): PercivalThumbPlan39 | null {
  const tau = noInfoThreshold74(tuning);
  if (!(tau > 0) || !plan) return plan;
  if (obs.myRole !== 'percival' || obs.gamePhase !== 'team_select' || (obs.currentRound ?? 1) < 2) return plan;
  // 讀法說得出來（信心夠）或計畫本來就帶比較像梅林的那一根（例如他只上過成功的任務）：照原本。
  if (plan.carryFav || plan.read.conf >= tau) return plan;
  round74Stats.noInfoBar += 1;
  const [a, b] = plan.read.thumbs;
  return { read: plan.read, carryFav: false, barred: new Set([a, b]) };
}

const clampP = (p: number): number => Math.min(Math.max(p, 1e-6), 1 - 1e-6);
const logit = (p: number): number => Math.log(clampP(p) / (1 - clampP(p)));

/**
 * `thumbBlend74`：P(拇指 A 是紅) 的後驗值 `pPost` 和讀法的值 `pRead`（= 1 − 讀法的 P(A 是梅林)）在 log-odds 上加權平均，`w` 給讀法。
 * 任一邊是確定的（0 或 1）就用確定的那一個（兩邊確定而且相反時照後驗）。
 */
export function blendThumbSplit74(pPost: number, pRead: number, w: number): number {
  if (!(w > 0)) return pPost;
  if (pPost <= 0 || pPost >= 1) return pPost;
  if (pRead <= 0 || pRead >= 1) return pRead;
  const ww = Math.min(w, 1);
  const z = (1 - ww) * logit(pPost) + ww * logit(pRead);
  return 1 / (1 + Math.exp(-z));
}
