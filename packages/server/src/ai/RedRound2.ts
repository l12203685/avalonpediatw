/**
 * 優化迴圈第 2 回合・紅方的兩個候選（2026-10-28；維持刺殺裁定、從任務端下手）。
 *
 * A1 `redHideEarly`：第 1、2 局，隊上沒有其他看得到的隊友時，紅方以機率 p 出成功藏身（真人牌譜：第 1 局隊上一個紅時
 *    任務 25% 成功，第 2 局 11%）。藍方的貝氏信念用真人的任務概似，機器人紅方幾乎一定出失敗，成功的隊因此被讀得太乾淨。
 *    人類規則（R1 落單莫甘娜出失敗）優先；奧伯倫不適用（看不到隊友）。
 * A2 `redCleanApprove`：第 3 局起，紅方不在隊上、隊上沒有它看得到的紅時，以機率 q 贊成（機器人紅方 14% vs 藍方 99.6%：
 *    這一格是貝氏藍方抓紅最清楚的地方）。藍方已有兩局成功時不套用（放行乾淨的隊等於送藍方第三局）。
 */
import type { AgentTuning } from './AgentTuning';
import type { PlayerObservation } from './types';

/** A1: 'success' (hide) or null (no opinion) for a red quest card. Draws `Math.random` only when it applies. */
export function redHideEarlyCard(tuning: Readonly<AgentTuning>, obs: PlayerObservation): 'success' | null {
  if (!(tuning.redHideEarly > 0) || obs.myTeam !== 'evil' || obs.myRole === 'oberon') return null;
  if ((obs.currentRound ?? 1) > 2) return null;
  const team = obs.proposedTeam ?? [];
  if (team.some((id) => id !== obs.myPlayerId && obs.knownEvils.includes(id))) return null;
  return Math.random() < tuning.redHideEarly ? 'success' : null;
}

/** A2: true (approve) or null for a red seat's vote. Draws `Math.random` only when it applies. */
export function redCleanApproveVote(tuning: Readonly<AgentTuning>, obs: PlayerObservation): true | null {
  if (!(tuning.redCleanApprove > 0) || obs.myTeam !== 'evil') return null;
  if ((obs.currentRound ?? 1) < 3 || (obs.failCount ?? 0) >= 4) return null;
  if ((obs.questResults ?? []).filter((r) => r === 'success').length >= 2) return null;
  const team = obs.proposedTeam ?? [];
  if (team.includes(obs.myPlayerId) || team.some((id) => obs.knownEvils.includes(id))) return null;
  return Math.random() < tuning.redCleanApprove ? true : null;
}

/**
 * 第 12 回合 `mordredHideR1`：第 1 局莫德雷德是隊上唯一看得到的紅時出成功藏身。藍方照機器人表讀任務牌（第 7 回合起；機器人紅方
 * 幾乎從不藏），成功的隊被讀成乾淨，之後莫德雷德被帶進隊伍；梅林看不到他，派隊與投票都擋不了。
 */
export function mordredHideR1Card(tuning: Readonly<AgentTuning>, obs: PlayerObservation): 'success' | null {
  if (!tuning.mordredHideR1 || obs.myRole !== 'mordred' || (obs.currentRound ?? 1) !== 1) return null;
  const team = obs.proposedTeam ?? [];
  if (team.some((id) => id !== obs.myPlayerId && obs.knownEvils.includes(id))) return null;
  return 'success';
}

/**
 * 第 14 回合 `redHideR1`：第 1 局刺客或莫甘娜是隊上唯一看得到的紅時，以比例 p 出成功藏身（莫德雷德照 `mordredHideR1`）。
 * 第 2 回合的 A1（`redHideEarly`，第 1、2 局）在藍方照真人表讀任務牌時 −2.9pp；現在藍方照機器人表讀（第 1 局一個紅的隊幾乎都失敗），
 * 而且第 13 回合起忠臣／派西不在隊上預設投黑，梅林能擋看得到的紅只剩派隊與關鍵局的內黑。Draws `Math.random` only when it applies.
 */
export function redHideR1Card(tuning: Readonly<AgentTuning>, obs: PlayerObservation): 'success' | null {
  if (!(tuning.redHideR1 > 0) || (obs.myRole !== 'assassin' && obs.myRole !== 'morgana') || (obs.currentRound ?? 1) !== 1) return null;
  // Round 16 `redHideR1Who`: 1 = the assassin only, 2 = Morgana only (0 = both).
  const who = tuning.redHideR1Who ?? 0;
  if ((who === 1 && obs.myRole !== 'assassin') || (who === 2 && obs.myRole !== 'morgana')) return null;
  const team = obs.proposedTeam ?? [];
  if (team.some((id) => id !== obs.myPlayerId && obs.knownEvils.includes(id))) return null;
  return tuning.redHideR1 >= 1 || Math.random() < tuning.redHideR1 ? 'success' : null;
}
