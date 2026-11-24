/**
 * 第 72 回合（藍方）：人類 PR 量尺逐決策拆到藍方局面格（第 66、68、70 回合的做法，在第 71 回合之後的基準線與真人桌讀法上重跑；
 * 藍方的決策從第 69 回合之後沒有變，所以表和第 70 回合相同），第 56–71 回合沒做過、也不在站長待裁定範圍裡的最大藍方負格——
 * **第 2 局（第 1 局失敗之後）藍方隊長非強制的提議**（真人桌 第 3–4 次 −0.51 ± 0.27、第 1–2 次 +0.04；基準線 −0.64／−0.63 pp／局）。
 *
 * 第 70 回合的結論是「沒有單一規則」：機器人的隊和真人同一個結構（自己＋0／1 個出過失敗任務的人），只多約 2–3pp 會失敗。
 * 協調者轉達的下一步是「分角色、分隊長的位置」再拆。拆的軸（`scripts/r2LeadStudy72.py`）：角色 × 隊長在不在第 1 局的隊上 × 第 1 局幾張失敗 ×
 * 第幾次；另外量了隊上出過失敗任務的人選得對不對、和這一局前面提議的重疊。每一格都在 1.4 個標準誤以內，所以本回合把幾種**讀法**
 * 做成只在這一格（以及它的子格）換的開關，用第 1 關（同一批真人決策點）直接量：
 *
 * `r2Lead72`（位元；0 = 關）：第 2 局、第 1 局任務失敗、非強制的提議，藍方當隊長時，挑隊改用——
 * - 1 = 不用隊長視角讀法（`viewpoint53`、`viewpointPow53` 當成 0）；
 * - 2 = 讀票的次方改成 `r2Lead72Temper`（0 = 0.2；取代 `beliefTemper` 的投票那一半與 `blueVoteTemper57`）；
 * - 4 = 不用遞迴後驗挑隊（`beliefLeadRecursive` 當成 0；第 36 回合的遞迴讀法本來就只用在這一格）；
 * - 8 = 只在第 3、4 次提議（不設 = 第 1–4 次）；
 * - 16 = 只在隊長在第 1 局的隊上；32 = 只在隊長不在第 1 局的隊上（都不設 = 兩種都）；
 * - 64 = 忠臣、128 = 派西、256 = 梅林（三個都不設 = 忠臣＋派西）。
 * 位元 1／2／4 至少要一個（其他位元只限範圍）。只改挑隊時用的讀法：同一個座位的投票、湖、其他局都不變；強制局（第 5 次）照舊。
 * 做法同第 70 回合 `r5Lead70`：在這個決定上換一個用改過的開關的 agent（記憶從公開紀錄重建，`HeuristicAgent.act` 的讀入本來就是冪等的），
 * 開關關時程式路徑不變（和現行預設逐局相同）。
 */
import type { AgentTuning } from './AgentTuning';
import type { PlayerObservation } from './types';

/** 診斷計數（研究腳本、自我對打拆解用；不影響決策）。 */
export const round72Stats = { applied: 0 };

/** 第 2 局、第 1 局失敗、非強制、藍方隊長挑隊、範圍（第幾次、隊長的位置、角色）內，而且至少有一個讀法位元 → 套第 72 回合的讀法。 */
export function r2Lead72Applies(tuning: Readonly<AgentTuning>, obs: PlayerObservation): boolean {
  const mode = tuning.r2Lead72 ?? 0;
  if ((mode & 7) === 0) return false;
  if (obs.gamePhase !== 'team_select' || obs.myTeam !== 'good') return false;
  if ((obs.currentRound ?? 1) !== 2 || (obs.questResults ?? [])[0] !== 'fail') return false;
  if (obs.currentLeader !== undefined && obs.currentLeader !== obs.myPlayerId) return false;
  const fc = obs.failCount ?? 0;
  if (fc >= 4) return false;
  if ((mode & 8) !== 0 && fc < 2) return false;
  const onR1 = (obs.questHistory ?? []).find((q) => q.round === 1)?.team.includes(obs.myPlayerId) ?? false;
  if ((mode & 16) !== 0 && (mode & 32) === 0 && !onR1) return false;
  if ((mode & 32) !== 0 && (mode & 16) === 0 && onR1) return false;
  const roleBits = mode & 448;
  const roles = roleBits === 0 ? 192 : roleBits;
  const bit = obs.myRole === 'loyal' ? 64 : obs.myRole === 'percival' ? 128 : obs.myRole === 'merlin' ? 256 : 0;
  return (roles & bit) !== 0;
}

/** 這個決定用的開關（`r2Lead72` 本身關掉，避免再套一次）。 */
export function r2Lead72Tuning(tuning: Readonly<AgentTuning>): AgentTuning {
  const mode = tuning.r2Lead72 ?? 0;
  const out: AgentTuning = { ...tuning, r2Lead72: 0 };
  if ((mode & 1) !== 0) { out.viewpoint53 = 0; out.viewpointPow53 = 0; }
  if ((mode & 2) !== 0) out.blueVoteTemper57 = (tuning.r2Lead72Temper ?? 0) > 0 ? tuning.r2Lead72Temper : 0.2;
  if ((mode & 4) !== 0) out.beliefLeadRecursive = 0;
  return out;
}
