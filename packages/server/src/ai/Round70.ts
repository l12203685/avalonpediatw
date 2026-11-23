/**
 * 第 70 回合（藍方）：人類 PR 量尺逐決策拆到藍方局面格（第 66、68 回合的做法，在第 69 回合之後的基準線與真人桌讀法上重跑），
 * 第 56–69 回合沒做過、而且有一個說得出來的原因的最大藍方負格——**第 5 局（2:2，這一隊決定勝負）藍方隊長非強制的提議**
 * （基準線 忠臣 −0.56 ± 0.20、派西 −0.24 ± 0.09 pp／局；第 68 回合第 4 節留下的那一格）。
 *
 * 同一批真人決策點（第 5 局、忠臣／派西當隊長、非強制，723 點）：機器人永遠派自己後驗「這隊沒有紅」最高的那支（忠臣 100%），
 * 它說那支隊乾淨的機率平均 0.84，實際會失敗 53%（第 3、4 次提議、第 4 局成功之後；真人 36%）——後驗在第 5 局過度自信，
 * 和第 1F 節第 5 條的校準曲線一致（Platt 斜率第 5 局 0.45，越後面越過度自信）。在同一批點拆開讀法：不用隊長視角讀法（`viewpoint53`）
 * 53 → 47%、讀票的次方 0.2 再到 42%（真人 36%）；其他讀法（`copyDiscount55`、`missionRole56`、第 68 回合 `missionScore68`、`beliefRecalib`）都不動這一格。
 *
 * `r5Lead70`（位元；0 = 關）：第 5 局非強制的提議、藍方當隊長時，挑隊改用校準過的讀法——
 * - 1 = 不用隊長視角讀法（`viewpoint53`、`viewpointPow53` 當成 0）；
 * - 2 = 讀票的次方改成 `r5Lead70Temper`（0 = 0.2；取代 `beliefTemper` 的投票那一半與 `blueVoteTemper57`）；
 * - 4 = 只在第 3、4 次提議（不設 = 第 1–4 次）；
 * - 8 = 忠臣、16 = 派西、32 = 梅林（三個都不設 = 忠臣＋派西）。
 * 只改挑隊時用的讀法：同一個座位的投票、湖、其他局都不變；強制局（第 5 次）照舊。
 * 做法：在這個決定上換一個用改過的開關的 agent（記憶從公開紀錄重建，`HeuristicAgent.act` 的讀入本來就是冪等的），
 * 開關關時程式路徑不變（和現行預設逐局相同）。
 */
import type { AgentTuning } from './AgentTuning';
import type { PlayerObservation } from './types';

/** 診斷計數（研究腳本、自我對打拆解用；不影響決策）。 */
export const round70Stats = { applied: 0 };

/** 第 5 局、非強制、藍方隊長挑隊、角色在範圍內 → 套第 70 回合的讀法。 */
export function r5Lead70Applies(tuning: Readonly<AgentTuning>, obs: PlayerObservation): boolean {
  const mode = tuning.r5Lead70 ?? 0;
  if ((mode & 3) === 0) return false;
  if (obs.gamePhase !== 'team_select' || obs.myTeam !== 'good') return false;
  if ((obs.currentRound ?? 1) !== 5) return false;
  if (obs.currentLeader !== undefined && obs.currentLeader !== obs.myPlayerId) return false;
  const fc = obs.failCount ?? 0;
  if (fc >= 4) return false;
  if ((mode & 4) !== 0 && fc < 2) return false;
  const roleBits = mode & 56;
  const roles = roleBits === 0 ? 24 : roleBits;
  const bit = obs.myRole === 'loyal' ? 8 : obs.myRole === 'percival' ? 16 : obs.myRole === 'merlin' ? 32 : 0;
  return (roles & bit) !== 0;
}

/** 這個決定用的開關（`r5Lead70` 本身關掉，避免再套一次）。 */
export function r5Lead70Tuning(tuning: Readonly<AgentTuning>): AgentTuning {
  const mode = tuning.r5Lead70 ?? 0;
  const out: AgentTuning = { ...tuning, r5Lead70: 0 };
  if ((mode & 1) !== 0) { out.viewpoint53 = 0; out.viewpointPow53 = 0; }
  if ((mode & 2) !== 0) out.blueVoteTemper57 = (tuning.r5Lead70Temper ?? 0) > 0 ? tuning.r5Lead70Temper : 0.2;
  return out;
}
