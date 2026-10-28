/**
 * 梅林在注定被否決的提議裡放一個看得到的紅（2026-10-28，優化迴圈第 1 回合・藍方）。
 *
 * 第 1、2 局照 Edward 的裁定一律正常票（隊內白、隊外黑，`AgentTuning` D3）：非強制的提議（第 1–4 次）只有隊員贊成，
 * 一定被否決，不會出任務。梅林從不把看得到的紅放進自己的隊，刺客的「派過可見紅的隊長排除」（10/26 裁定）就能把他
 * 從候選裡留下來；在這些不會出任務的提議裡放一個看得到的紅，任務上幾乎沒有代價，刺客卻會把他排除。
 * 第 5 次強制提議（會出任務）、第 3 局起（投票不再一律正常票）都照常。
 */
import type { AgentTuning } from './AgentTuning';
import type { AgentAction, PlayerObservation } from './types';

/** Whether this proposal is one the R1–R2 normal votes always reject (non-forced, round ≤ 2). */
export function doomedProposal(obs: PlayerObservation): boolean {
  return (obs.currentRound ?? 1) <= 2 && (obs.failCount ?? 0) < 4;
}

/**
 * `merlinDoomedRed` on, Merlin leading a doomed proposal with no visible red on it: swap one teammate other
 * than Merlin for a visible red (both picked with `Math.random`, seeded by the callers that need it).
 */
export function merlinDoomedRedCover(tuning: Readonly<AgentTuning>, obs: PlayerObservation, action: AgentAction): AgentAction {
  if (!tuning.merlinDoomedRed || action.type !== 'team_select' || obs.myRole !== 'merlin') return action;
  if (!doomedProposal(obs)) return action;
  const visible = obs.knownEvils;
  const team = action.teamIds;
  if (visible.length === 0 || team.some((id) => visible.includes(id))) return action;
  const swappable = team.filter((id) => id !== obs.myPlayerId);
  if (swappable.length === 0) return action;
  const out = swappable[Math.floor(Math.random() * swappable.length)];
  const red = visible[Math.floor(Math.random() * visible.length)];
  return { type: 'team_select', teamIds: team.map((id) => (id === out ? red : id)) };
}
