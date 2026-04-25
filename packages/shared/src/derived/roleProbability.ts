/**
 * 角色抽到機率 — 純函式。
 *
 * 定義：給定人數 playerCount（及可選變體 config），由 AVALON_CONFIG 的 roles 陣列推
 * 每個 Role 在該人數下被抽中的機率 = 該 role 在陣列中的出現次數 / 總座位數。
 *
 * Edward 2026-04-24 14:05：
 *   > 理論勝率是 該玩家的 SUM(各腳色勝率 * 抽到該腳色機率)
 *   > 各角色機率應該很簡單吧...
 *
 * 例：
 *   5 人：merlin/percival/loyal/assassin/morgana → 每個 1/5
 *   6 人：merlin/percival/loyal/loyal/assassin/morgana → loyal 2/6, 其他 1/6
 *   7 人：merlin/percival/loyal/loyal/assassin/morgana/oberon → loyal 2/7, 其他 1/7
 *   8 人：merlin/percival/loyal/loyal/loyal/assassin/morgana/mordred → loyal 3/8, 其他 1/8
 *   9 人：merlin/percival/loyal*4/assassin/morgana/mordred → loyal 4/9, 其他 1/9
 *   10 人：merlin/percival/loyal*4/assassin/morgana/mordred/oberon → loyal 4/10, 其他 1/10
 */

import { AVALON_CONFIG, type Role } from '../types/game';
import type { GameConfig } from '../types/game';

/**
 * 單一人數下每個 Role 的抽中機率。
 *
 * @param playerCount 人數（5..10）
 * @param config      可選：直接傳 GameConfig（變體模式用）。不傳走 AVALON_CONFIG[playerCount]。
 * @returns Record<Role, number> — 該 playerCount 下每個 Role 的機率 0..1；沒出現的 Role = 0
 */
export function getRolePickProbability(
  playerCount: number,
  config?: GameConfig,
): Partial<Record<Role, number>> {
  const cfg = config ?? AVALON_CONFIG[playerCount];
  if (!cfg) return {};
  const total = cfg.roles.length;
  if (total === 0) return {};

  const counts: Partial<Record<Role, number>> = {};
  for (const r of cfg.roles) {
    counts[r] = (counts[r] ?? 0) + 1;
  }
  const out: Partial<Record<Role, number>> = {};
  for (const [role, count] of Object.entries(counts)) {
    out[role as Role] = (count ?? 0) / total;
  }
  return out;
}

/**
 * 跨多場次的**平均**角色機率 — 以該玩家實際遇到的各人數局次數加權。
 *
 * Edward 2026-04-24 14:07 v2 做法：按該玩家在各人數局的場次加權平均。
 *
 * @param gamesByPlayerCount  Record<人數, 該人數的場次> — 例如 {5: 10, 7: 5}
 * @returns Record<Role, number> — 加權後每個 Role 的平均機率
 */
export function getAveragedRolePickProbability(
  gamesByPlayerCount: Record<number, number>,
): Partial<Record<Role, number>> {
  const out: Partial<Record<Role, number>> = {};
  let totalWeight = 0;
  for (const games of Object.values(gamesByPlayerCount)) {
    totalWeight += games;
  }
  if (totalWeight === 0) return out;

  for (const [countStr, games] of Object.entries(gamesByPlayerCount)) {
    const count = Number(countStr);
    if (!Number.isFinite(count) || games <= 0) continue;
    const probs = getRolePickProbability(count);
    const weight = games / totalWeight;
    for (const [role, p] of Object.entries(probs)) {
      out[role as Role] = (out[role as Role] ?? 0) + (p ?? 0) * weight;
    }
  }
  return out;
}
