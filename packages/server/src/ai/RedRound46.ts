/**
 * 優化迴圈第 46 回合・紅方（2026-11-18；站長同意測試：「紅方四個開關也一起測」）。第 45 回合診斷（5、0 雙藍時紅方太弱）的三個候選；
 * 預設全部關，採用要站長另外決定（第 1E 節之後紅方凍結）。
 *
 *   - `assassinTailRead45`：刺殺模型加上「強制局（尾家）派的隊完全沒有紅」的概似比。第 45 回合：5藍0藍 梅林在 5 家時機器人刺客刺中
 *     30.5%、真人 56.9%；機器人梅林在 5 家的強制局從不放看得到的紅。真人局（game_db 82d4188）藍方強制局的隊完全沒有紅：
 *     強者桌（strength strong／high）梅林 53.5%（n 71）、其他藍方 38.1%（n 409）→ ×1.40；全部真人 60.4%（553）／33.7%（2,815）→ ×1.79。
 *     放了看得到的紅的強制局已經由 `assassinVisibleRedTier` 往下排，這裡不再算（避免同一個證據算兩次）。
 *   - `redLeadOff45`：紅隊長第 3 局起的非強制提議，以比例 q 派「公開視角的忠臣會派」的隊、不放自己。強者紅隊長（不含奧伯倫）第 3 局起
 *     非強制提議不放自己 19.7%（441 次；全部真人 21.2%），其中 0 紅 64%、1 紅 28%。機器人 0%（`ForwardAgent.generateTeamSelectCandidates`
 *     每一局都強制隊長在隊上）。
 *   - `redRankOrderR2Fix45`：在 `HeuristicAgent.chooseRedHierarchyVote`（第 2 局莫甘娜照第 3 局的規則出失敗）。
 */
import type { PlayerObservation } from './types';
import type { AgentTuning } from './AgentTuning';

/** `assassinTailRead45` 的 ln 概似比（每一次完全沒有紅的強制局）：1 = 強者真人、2 = 全部真人。 */
export const TAIL_CLEAN_LOG_LR: Readonly<Record<number, number>> = {
  1: Math.log(0.535 / 0.381),
  2: Math.log(0.604 / 0.337),
};

/** 候選人 `candidate` 當隊長的強制局（第 5 次提議）裡，隊上完全沒有紅（`reds`：刺殺階段知道的全部紅方）的次數 × ln LR；mode 0 = 0。 */
export function tailCleanLogRatio(obs: PlayerObservation, candidate: string, reds: ReadonlySet<string>, mode: number): number {
  const lr = TAIL_CLEAN_LOG_LR[mode];
  if (lr === undefined) return 0;
  let n = 0;
  for (const v of obs.voteHistory) {
    if (v.leader !== candidate || v.attempt < 5) continue;
    if (!v.team.some((id) => reds.has(id))) n++;
  }
  return n * lr;
}

function hash01(text: string): number {
  let h = 0x811c9dc5;
  for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return (h % 10000) / 10000;
}

/**
 * `redLeadOff45`：這一次提議要不要改派不含自己的公開忠臣隊。紅方（不含奧伯倫）當隊長、第 3 局起、非強制、紅方未兩勝，
 * 照座位、局、第幾次提議、這一局的公開狀態雜湊（不用亂數），比例 q。
 */
export function redLeadOffNow(tuning: Readonly<AgentTuning>, obs: PlayerObservation): boolean {
  const q = tuning.redLeadOff45 ?? 0;
  if (q <= 0 || obs.gamePhase !== 'team_select' || obs.myTeam !== 'evil' || obs.myRole === 'oberon') return false;
  const round = obs.currentRound ?? 1;
  if (round < 3 || (obs.failCount ?? 0) >= 4) return false;
  if ((obs.questResults ?? []).filter((r) => r === 'fail').length >= 2) return false;
  const state = obs.questHistory.map((x) => `${x.round}:${x.failCount}`).join(',');
  return hash01(`${obs.myPlayerId}|${round}|${obs.failCount ?? 0}|${state}|redleadoff45`) < q;
}

/**
 * `redLeadOff45` 的隊：公開視角忠臣的隊 `loyalTeam`；自己在上面時，換成公開視角紅的機率 `redShare` 最低的隊外的人（同分照座位順序）。
 */
export function teamWithoutSelf(obs: PlayerObservation, loyalTeam: readonly string[], redShare: ReadonlyMap<string, number>): string[] {
  const me = obs.myPlayerId;
  if (!loyalTeam.includes(me)) return [...loyalTeam];
  const outside = obs.allPlayerIds.filter((id) => id !== me && !loyalTeam.includes(id));
  if (outside.length === 0) return [...loyalTeam];
  const best = outside.reduce((a, b) => ((redShare.get(b) ?? 0.5) < (redShare.get(a) ?? 0.5) ? b : a));
  return loyalTeam.map((id) => (id === me ? best : id));
}
