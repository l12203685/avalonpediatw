/**
 * V1 → V2 converter.
 *
 * Phase 2c (2026-04-24): 讀舊 Firestore `games/` 每筆 `GameRecordV1` → 組 `GameRecordV2`。
 *
 * V1 欄位對照 V2：
 *   - `gameId` → `gameId`
 *   - `createdAt` → `playedAt`
 *   - `endedAt - createdAt` → `totalDurationMs`
 *   - `players[].playerId` 按 V1 插入順序落到 `playerSeats[0..N-1]`，其餘座補空字串
 *   - `players[].role === 'merlin'` 等 → `finalResult.roles.*Seat`
 *   - `winner` + `winReason` → `finalResult.winnerCamp` + `finalResult.winReason`（V1 字串 → V2 enum mapping）
 *   - `voteHistoryPersisted` → 逐筆 → `MissionV2[]`
 *   - `questHistoryPersisted` → 疊到對應 round 的最後 `MissionV2.questResult`
 *   - `ladyOfTheLakeHistoryPersisted` → `LadyLinkV2[]`（V1 沒 declaration 的用 result 當 declaration）
 *   - `assassinTargetId` → 查 `players[].playerId === target` 的 seat → `finalResult.assassinTargetSeat`
 *
 * 不存欄位（V1 沒）在 V2 留 `null` / `undefined`：
 *   - `MissionV2.votes[]`（V1 的 voteHistoryPersisted.votes 是 Record<playerId, boolean>，能推但 Phase 2c MVP 先留 null）
 *   - `MissionV2.questResult.successCount` 從 `team.length - failCount` 推
 *   - `transcript`（V1 不存）
 *
 * Edward 2026-04-24：「V1→V2 遷移 script 舊 Firestore games/ → games_v2/」。
 */

import type { Role, Team } from '../types/game';
import type {
  CampV2,
  FinalResultV2,
  FixedTenStrings,
  GameRecordV2,
  LadyLinkV2,
  MissionV2,
  RolesV2,
  WinReasonV2,
} from '../types/game_v2';

// ---------------------------------------------------------------------------
// V1 input shape (minimum subset we consume — matches
// server/src/services/GameHistoryRepository.ts GameRecord).
// ---------------------------------------------------------------------------

export interface V1PlayerInput {
  playerId: string;
  displayName?: string;
  role: Role | null;
  team: Team | null;
  won: boolean;
  ownerUid?: string | null;
}

export interface V1VoteRecordInput {
  round: number;
  attempt: number;
  leader: string;
  team: string[];
  approved: boolean;
  /** V1: playerId → approve bool. */
  votes: Record<string, boolean>;
}

export interface V1QuestRecordInput {
  round: number;
  team: string[];
  result: 'success' | 'fail';
  failCount: number;
}

export interface V1LadyRecordInput {
  round: number;
  holderId: string;
  targetId: string;
  result: 'good' | 'evil';
  declared?: boolean;
  declaredClaim?: 'good' | 'evil';
}

export interface V1GameRecordInput {
  gameId: string;
  roomName?: string;
  playerCount: number;
  winner: 'good' | 'evil';
  /** V1 free-form string (e.g. `merlin_assassinated`, `failed_quests_limit`). */
  winReason: string;
  questResults: Array<'success' | 'fail' | 'pending'>;
  /** milliseconds total. */
  duration: number;
  players: V1PlayerInput[];
  createdAt: number;
  endedAt: number;
  // Optional Phase-2 audit fields
  voteHistoryPersisted?: V1VoteRecordInput[];
  questHistoryPersisted?: V1QuestRecordInput[];
  ladyOfTheLakeHistoryPersisted?: V1LadyRecordInput[];
  assassinTargetId?: string;
  leaderStartIndex?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * V1 `winReason` 字串 → V2 `WinReasonV2` enum。
 *
 * GameHistoryRepository.saveGameRecord 寫入的字串來自 GameEngine `room.endReason`:
 *   - `merlin_assassinated` → threeBlue_merlinKilled
 *   - `assassination_failed` → threeBlue_merlinAlive
 *   - `assassination_timeout` → threeBlue_merlinAlive（好人勝，刺客超時）
 *   - `failed_quests_limit` / `failed_quests` → threeRed
 *   - `vote_rejections_limit` / `vote_rejections` → fiveRejections
 *   - `host_cancelled` → hostCancelled
 *
 * GameImportService.jsonRecordToGameRecord 也可能寫 `howTheGameWasWon` 字串（ProAvalon legacy）。
 * 無法識別時以 `winner` 降級：good → threeBlue_merlinAlive，evil → threeRed。
 */
export function normalizeWinReason(
  raw: string,
  winner: 'good' | 'evil',
): WinReasonV2 {
  const s = (raw || '').toLowerCase();
  if (s.includes('host') && s.includes('cancel')) return 'hostCancelled';
  if (s.includes('merlin_assassinated') || s.includes('merlin assassinated') || s.includes('merlin_killed')) {
    return 'threeBlue_merlinKilled';
  }
  if (s.includes('assassination_failed') || s.includes('assassination failed') ||
      s.includes('assassination_timeout') || s.includes('assassination timeout')) {
    return 'threeBlue_merlinAlive';
  }
  if (s.includes('failed_quests') || s.includes('failed quests') || s.includes('3 failed')) {
    return 'threeRed';
  }
  if (s.includes('vote_reject') || s.includes('vote reject') || s.includes('5_reject') ||
      s.includes('five reject') || s.includes('hammer')) {
    return 'fiveRejections';
  }
  // Fallback: infer from winner.
  return winner === 'good' ? 'threeBlue_merlinAlive' : 'threeRed';
}

/**
 * 從 V1 players 排列建 V2 playerSeats（UUID-only，長度固定 10）。
 * V1 的 `playerId` 即為 UUID（或 pro-avalon `displayName` fallback），照 array 順序塞。
 * 空位以空字串補齊。
 */
export function buildPlayerSeats(players: V1PlayerInput[]): FixedTenStrings {
  const arr: string[] = [];
  for (const p of players) {
    arr.push(p.playerId || '');
  }
  while (arr.length < 10) arr.push('');
  return arr.slice(0, 10) as unknown as FixedTenStrings;
}

/**
 * V1 players 的 role 欄位 → V2 RolesV2 座號對照（1..10）。
 * 未 assign role 的座位不進 map（V2 schema 用 undefined 表示「此局無此角色」）。
 */
export function buildRolesFromV1(players: V1PlayerInput[]): RolesV2 {
  const roles: RolesV2 = {};
  players.forEach((p, idx) => {
    const seat = idx + 1;
    switch (p.role) {
      case 'merlin':
        roles.merlin = seat;
        break;
      case 'percival':
        roles.percival = seat;
        break;
      case 'assassin':
        roles.assassin = seat;
        break;
      case 'morgana':
        roles.morgana = seat;
        break;
      case 'mordred':
        roles.mordred = seat;
        break;
      case 'oberon':
        roles.oberon = seat;
        break;
      default:
        // loyal / minion / null — 不占能力角色座號
        break;
    }
  });
  return roles;
}

/**
 * V1 playerId → V2 seat 查表（1..10）。查不到回 undefined。
 */
export function findSeatByPlayerId(
  players: V1PlayerInput[],
  playerId: string | undefined,
): number | undefined {
  if (!playerId) return undefined;
  const idx = players.findIndex((p) => p.playerId === playerId);
  return idx >= 0 ? idx + 1 : undefined;
}

/**
 * 將 V1 voteHistoryPersisted 轉成 V2 missions：
 *   - 每筆 V1 VoteRecord 對應一個 MissionV2 row（round + attempt as proposalIndex）
 *   - approved 的 mission 接上對應 round 的 questHistoryPersisted.result
 *   - V1 的 votes Record<pid, bool> → V2 votes array（按 playerSeats 順序）
 */
export function buildMissionsFromV1(
  players: V1PlayerInput[],
  voteHistory: V1VoteRecordInput[] | undefined,
  questHistory: V1QuestRecordInput[] | undefined,
): MissionV2[] {
  if (!voteHistory || voteHistory.length === 0) return [];

  const pidToSeat = new Map<string, number>();
  players.forEach((p, idx) => pidToSeat.set(p.playerId, idx + 1));

  // Match quest result per round — V1 stores one QuestRecord per completed round.
  const questByRound = new Map<number, V1QuestRecordInput>();
  for (const q of questHistory ?? []) {
    questByRound.set(q.round, q);
  }

  const missions: MissionV2[] = [];
  for (const v of voteHistory) {
    const round = v.round as 1 | 2 | 3 | 4 | 5;
    const proposalIndex = (Math.min(Math.max(v.attempt, 1), 5)) as 1 | 2 | 3 | 4 | 5;
    const leaderSeat = pidToSeat.get(v.leader) ?? 0;
    const teamSeats = v.team
      .map((pid) => pidToSeat.get(pid))
      .filter((s): s is number => typeof s === 'number');

    // votes array — 按 playerSeats 順序（seat 1..N 對應 index 0..N-1）。
    // V1 未投票的玩家不在 votes map，V2 array 長度必須等於玩家人數；缺的標為 null 整體。
    let votesArr: Array<'approve' | 'reject'> | null = null;
    if (v.votes && Object.keys(v.votes).length > 0) {
      const arr: Array<'approve' | 'reject' | null> = [];
      let allFilled = true;
      for (const p of players) {
        const vote = v.votes[p.playerId];
        if (typeof vote === 'boolean') {
          arr.push(vote ? 'approve' : 'reject');
        } else {
          allFilled = false;
          arr.push(null);
        }
      }
      // Only promote to non-null array if every seat has a vote (V2 invariant).
      votesArr = allFilled ? (arr as Array<'approve' | 'reject'>) : null;
    }

    const approveCount = Object.values(v.votes ?? {}).filter((b) => b === true).length;
    const rejectCount = Object.values(v.votes ?? {}).filter((b) => b === false).length;

    const mission: MissionV2 = {
      round,
      proposalIndex,
      leaderSeat,
      teamSeats,
      votes: votesArr,
      passed: v.approved,
      approveCount,
      rejectCount,
    };

    // Only approved proposals ran a quest → add questResult if we have it.
    if (v.approved) {
      const q = questByRound.get(round);
      if (q) {
        const teamLen = q.team?.length ?? teamSeats.length;
        mission.questResult = {
          successCount: Math.max(0, teamLen - (q.failCount ?? 0)),
          failCount: q.failCount ?? 0,
          success: q.result === 'success',
        };
      }
    }

    missions.push(mission);
  }

  // Sort deterministically by round asc, proposalIndex asc.
  missions.sort((a, b) =>
    a.round !== b.round ? a.round - b.round : a.proposalIndex - b.proposalIndex,
  );

  return missions;
}

/**
 * V1 ladyOfTheLakeHistoryPersisted → V2 LadyLinkV2[]。
 *
 * V1 `result` 是 holder 看到的真實陣營；V2 `declaration` 是 holder 公開宣告的陣營。
 * V1 `declaredClaim` 存在 → 直接用；不存在 → 沒宣告過，declaration 以 result 當 placeholder。
 * `truthful` = (declaration === actual)。
 */
export function buildLadyChainFromV1(
  players: V1PlayerInput[],
  ladyHistory: V1LadyRecordInput[] | undefined,
): LadyLinkV2[] {
  if (!ladyHistory || ladyHistory.length === 0) return [];
  const pidToSeat = new Map<string, number>();
  players.forEach((p, idx) => pidToSeat.set(p.playerId, idx + 1));

  return ladyHistory.map((l) => {
    const holderSeat = pidToSeat.get(l.holderId) ?? 0;
    const targetSeat = pidToSeat.get(l.targetId) ?? 0;
    const actual: CampV2 = l.result;
    const declaration: CampV2 = l.declaredClaim ?? l.result;
    return {
      round: l.round,
      holderSeat,
      targetSeat,
      declaration,
      actual,
      truthful: declaration === actual,
    };
  });
}

// ---------------------------------------------------------------------------
// Main converter
// ---------------------------------------------------------------------------

/**
 * V1 GameRecord → V2 GameRecordV2。純函式；無 side effect。
 */
export function convertV1ToV2(v1: V1GameRecordInput): GameRecordV2 {
  const players = v1.players ?? [];
  const winnerCamp: CampV2 = v1.winner;
  const playerSeats = buildPlayerSeats(players);
  const roles = buildRolesFromV1(players);
  const missions = buildMissionsFromV1(
    players,
    v1.voteHistoryPersisted,
    v1.questHistoryPersisted,
  );
  const ladyChain = buildLadyChainFromV1(players, v1.ladyOfTheLakeHistoryPersisted);
  const winReason = normalizeWinReason(v1.winReason, winnerCamp);
  const assassinTargetSeat = findSeatByPlayerId(players, v1.assassinTargetId);
  const assassinCorrect =
    typeof assassinTargetSeat === 'number' && typeof roles.merlin === 'number'
      ? assassinTargetSeat === roles.merlin
      : undefined;

  const finalResult: FinalResultV2 = {
    winnerCamp,
    winReason,
    roles,
    ...(typeof assassinTargetSeat === 'number' ? { assassinTargetSeat } : {}),
    ...(typeof assassinCorrect === 'boolean' ? { assassinCorrect } : {}),
  };

  const record: GameRecordV2 = {
    schemaVersion: 2,
    gameId: v1.gameId,
    playedAt: v1.createdAt,
    totalDurationMs: typeof v1.duration === 'number' && v1.duration > 0 ? v1.duration : undefined,
    playerSeats,
    finalResult,
    missions,
    ...(ladyChain.length > 0 ? { ladyChain } : {}),
  };

  return record;
}
