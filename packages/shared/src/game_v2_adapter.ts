/**
 * V2 → V1 adapter.
 *
 * V2 schema 是極簡原子資料，舊分析程式（`GameAnalytics`, `EloAttributionService`,
 * `sheetsAnalysis`, `ReplayService`…）依賴 V1 的 `GamePlayerRecord[]` / `questResults[]`
 * 等派生欄位。為讓舊碼在 Phase 1 就能讀 V2 資料，提供一層 hydrate adapter。
 *
 * Phase 2 會把舊分析改為吃純函式（`packages/shared/src/derived/`），屆時此 adapter
 * 即可退場。在那之前維持為純函式，no side effects。
 */

import {
  AVALON_CONFIG,
  type QuestResult,
  type Role,
  type Team,
} from './types/game';
import {
  type CampV2,
  type GameRecordV2,
  type MissionV2,
  type RolesV2,
} from './types/game_v2';

/**
 * V1-compatible player row（跟 `@avalon/server` 的 `GamePlayerRecord` 同型）。
 * 重新在 shared 宣告一次避免反向依賴 server package。
 */
export interface GamePlayerV1View {
  playerId: string;
  displayName: string;
  role: Role | null;
  team: Team | null;
  won: boolean;
  ownerUid?: string | null;
}

/**
 * V1-compatible record view（對齊 `GameHistoryRepository.GameRecord` 的「讀取面」）。
 * 非 Firestore document，僅供舊分析程式 in-memory 消費。
 */
export interface GameRecordV1View {
  gameId: string;
  roomName: string;
  playerCount: number;
  winner: CampV2;
  winReason: string;
  questResults: QuestResult[];
  duration: number;
  players: GamePlayerV1View[];
  createdAt: number;
  endedAt: number;
  assassinTargetId?: string;
  leaderStartIndex?: number;
}

/**
 * 取得 V2 record 中真正有玩家的人數（非空字串的 playerIds OR displayNames）。
 */
export function computePlayerCount(v2: GameRecordV2): number {
  let count = 0;
  for (let i = 0; i < 10; i += 1) {
    if (v2.displayNames[i]?.trim() || v2.playerIds[i]?.trim()) {
      count += 1;
    }
  }
  return count;
}

/**
 * 勝方 — V2 `finalResult.winnerCamp` 就是答案；保留函式介面作為未來派生計算的入口。
 */
export function computeWinner(v2: GameRecordV2): CampV2 {
  return v2.finalResult.winnerCamp;
}

/**
 * 從 `missions` 推導 V1 的 `questResults[]`。
 * 規則：
 *   - 每個 round 取最後一次 `passed === true` 且有 `questResult` 的 mission。
 *   - 若 round 內所有 proposal 都 rejected（罕見，理論上 round 1-2 可能），該 round 無 result。
 *   - 結果按 round 升序返回。
 */
export function computeQuestResults(v2: GameRecordV2): QuestResult[] {
  const byRound = new Map<number, MissionV2>();
  for (const m of v2.missions) {
    if (m.questResult && m.passed) {
      byRound.set(m.round, m);
    }
  }
  const rounds = Array.from(byRound.keys()).sort((a, b) => a - b);
  return rounds.map((r) => {
    const m = byRound.get(r)!;
    return m.questResult!.success ? 'success' : 'fail';
  });
}

/**
 * 從能力角色座號 + `AVALON_CONFIG` 推導某座號的完整 Role。
 * 未能推導出能力角色的座號一律回傳 `loyal`（假設一般好人）或 `null`（資料不足）。
 */
function deriveRoleForSeat(seat: number, roles: RolesV2, playerCount: number): Role | null {
  if (roles.merlin === seat) return 'merlin';
  if (roles.percival === seat) return 'percival';
  if (roles.assassin === seat) return 'assassin';
  if (roles.morgana === seat) return 'morgana';
  if (roles.mordred === seat) return 'mordred';
  if (roles.oberon === seat) return 'oberon';

  // 未命中能力角色 → 依 AVALON_CONFIG 人員構成推一般好人 / 一般壞人。
  const config = AVALON_CONFIG[playerCount];
  if (!config) return null;

  // 已經在 roles 裡指派的能力角色座號集合
  const specialSeats = new Set(
    Object.values(roles).filter((s): s is number => typeof s === 'number'),
  );

  // 這座既不是特殊角色、也不在 config 裡 → 資料不足。
  if (specialSeats.has(seat)) return null;

  // 計算剩餘未指派的角色池（除掉已在 roles 指派的 special roles）。
  const assignedRoles = new Set<Role>();
  if (roles.merlin !== undefined) assignedRoles.add('merlin');
  if (roles.percival !== undefined) assignedRoles.add('percival');
  if (roles.assassin !== undefined) assignedRoles.add('assassin');
  if (roles.morgana !== undefined) assignedRoles.add('morgana');
  if (roles.mordred !== undefined) assignedRoles.add('mordred');
  if (roles.oberon !== undefined) assignedRoles.add('oberon');

  const remaining = config.roles.filter((r) => {
    if (r === 'loyal') return true; // 多個 loyal，不扣
    return !assignedRoles.has(r);
  });

  // 剩餘池若只含 loyal → 此座必為 loyal。
  if (remaining.every((r) => r === 'loyal')) return 'loyal';

  // 多種可能性 → 回 null 表示無法確定（Phase 1 不做複雜推導）。
  return null;
}

/**
 * 依 Role 推陣營（規則對齊 `types/game.ts` 的 Role definition）。
 */
function teamForRole(role: Role | null): Team | null {
  if (!role) return null;
  switch (role) {
    case 'merlin':
    case 'percival':
    case 'loyal':
      return 'good';
    case 'assassin':
    case 'morgana':
    case 'mordred':
    case 'oberon':
    case 'minion':
      return 'evil';
    default:
      return null;
  }
}

/**
 * 主要 adapter — V2 → V1 view，供舊分析程式消費。
 *
 * 注意：
 *   - 不改寫 V2 原始資料；純讀取派生新物件。
 *   - `winReason` 為 enum（V2）→ 字串（V1）直接塞 enum 字串；舊 UI 會看成 "threeBlue_merlinAlive"
 *     等 token，Phase 2 再提供中文映射函式。
 *   - `assassinTargetId` 從 `finalResult.assassinTargetSeat` 反查 `playerIds` / `displayNames`。
 */
export function hydrateV2ToV1View(v2: GameRecordV2): GameRecordV1View {
  const playerCount = computePlayerCount(v2);
  const winner = computeWinner(v2);
  const questResults = computeQuestResults(v2);

  const players: GamePlayerV1View[] = [];
  for (let i = 0; i < 10; i += 1) {
    const seat = i + 1;
    const displayName = v2.displayNames[i];
    const playerId = v2.playerIds[i];

    // 只有真正存在的玩家才納入 view（空座跳過）。
    if (!displayName?.trim() && !playerId?.trim()) continue;

    const role = deriveRoleForSeat(seat, v2.finalResult.roles, playerCount);
    const team = teamForRole(role);
    const won = team !== null && team === winner;

    players.push({
      playerId: playerId || displayName, // Sheets 歷史資料無 ID 時退回名字
      displayName: displayName || playerId,
      role,
      team,
      won,
    });
  }

  const duration = v2.totalDurationMs ?? 0;
  const endedAt = v2.playedAt + duration;

  let assassinTargetId: string | undefined;
  if (typeof v2.finalResult.assassinTargetSeat === 'number') {
    const idx = v2.finalResult.assassinTargetSeat - 1;
    if (idx >= 0 && idx < 10) {
      assassinTargetId =
        v2.playerIds[idx]?.trim() || v2.displayNames[idx]?.trim() || undefined;
    }
  }

  const leaderStartIndex =
    v2.missions.length > 0 ? v2.missions[0].leaderSeat - 1 : undefined;

  return {
    gameId: v2.gameId,
    roomName: v2.gameId, // V2 不存 roomName；用 gameId 暫代（Phase 2 由 GameSourceMeta 補）
    playerCount,
    winner,
    winReason: v2.finalResult.winReason,
    questResults,
    duration,
    players,
    createdAt: v2.playedAt,
    endedAt,
    assassinTargetId,
    leaderStartIndex,
  };
}
