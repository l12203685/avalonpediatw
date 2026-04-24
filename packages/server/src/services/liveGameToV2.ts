/**
 * Live-game → V2 record builder.
 *
 * Phase 2c (2026-04-24): 現場對局結束時，從 `Room` + `GameEngine` event buffer 組
 * `GameRecordV2`，供 `GameHistoryRepositoryV2.saveV2` 雙寫。
 *
 * 資料來源：
 *   - Room 的 `voteHistory[]` / `questHistory[]` / `ladyOfTheLakeHistory[]` / `endReason` / `assassinTargetId`
 *     （GameEngine 已在 resolveVoting / resolveQuestPhase / submitLadyOfTheLakeTarget / resolveAssassination
 *     裡逐筆推到 Room，Phase 2a 設計文件確認這是現場紀錄的 SSoT）
 *   - Room 的 `players[playerId].role` → V2 `finalResult.roles` 座號對照
 *   - Room 的 `players` 插入順序就是座位 1..N
 *   - Room 的 `createdAt` 當 `playedAt`；`startedAt` 傳入覆蓋用（GameServer 有 roomStartTimes）
 *
 * 無法從現場推的欄位 Phase 2c 先留 undefined（不阻塞）：
 *   - `MissionV2.startedAt/endedAt/votingDurationMs` — 未來加 engine 計時；現階段 undefined
 *   - `transcript` — 現場無結構 transcript；未來 Phase 3 才做
 */

import type {
  GameRecordV2,
  FinalResultV2,
  MissionV2,
  LadyLinkV2,
  FixedTenStrings,
  RolesV2,
  WinReasonV2,
  CampV2,
} from '@avalon/shared';
import {
  convertV1ToV2,
  type V1GameRecordInput,
  type V1PlayerInput,
  type V1VoteRecordInput,
  type V1QuestRecordInput,
  type V1LadyRecordInput,
  normalizeWinReason,
} from '@avalon/shared';
import type { Room } from '@avalon/shared';
import type { GameEngine } from '../game/GameEngine';

export interface BuildV2Options {
  /** Wall-clock ms of game start; falls back to `room.createdAt` if omitted. */
  startedAtMs?: number;
  /** Wall-clock ms of game end; falls back to `Date.now()`. */
  endedAtMs?: number;
}

/**
 * 從 Room 現場資料組裝 V1 shape，再用 `convertV1ToV2` 繞一圈共用轉換邏輯。
 *
 * 這樣做的好處：
 *   1. 現場寫 V2 的路徑跟 V1→V2 migration script 走相同 converter → 一致性 & 減少 bug 面
 *   2. converter 單元測試 cover 現場流程（不用另寫 live-specific tests）
 *   3. V1 saveGameRecord 仍然是 V1 write 的 SSoT，V2 只是它的轉型結果
 */
export function buildV2RecordFromRoom(
  room: Room,
  _engine: GameEngine,
  opts: BuildV2Options = {},
): GameRecordV2 {
  const startedAt = opts.startedAtMs ?? room.createdAt ?? Date.now();
  const endedAt = opts.endedAtMs ?? Date.now();
  const duration = Math.max(0, endedAt - startedAt);

  const winner: 'good' | 'evil' = room.evilWins ? 'evil' : 'good';

  // Derive winReason from Room.endReason (GameEngine writes this on game_ended).
  const endReason: string = room.endReason ?? (winner === 'good' ? 'assassination_failed' : 'failed_quests');

  // Room.players order = seat order (GameEngine shuffles once at startGame).
  const playerEntries = Object.entries(room.players);
  const players: V1PlayerInput[] = playerEntries.map(([pid, p]) => ({
    playerId: pid,
    displayName: p.name,
    role: p.role ?? null,
    team: p.team ?? null,
    won:
      (winner === 'good' && p.team === 'good') ||
      (winner === 'evil' && p.team === 'evil'),
  }));

  const voteHistory: V1VoteRecordInput[] = (room.voteHistory ?? []).map((v) => ({
    round: v.round,
    attempt: v.attempt,
    leader: v.leader,
    team: [...v.team],
    approved: v.approved,
    votes: { ...v.votes },
  }));
  const questHistory: V1QuestRecordInput[] = (room.questHistory ?? []).map((q) => ({
    round: q.round,
    team: [...q.team],
    result: q.result,
    failCount: q.failCount,
  }));
  const ladyHistory: V1LadyRecordInput[] = (room.ladyOfTheLakeHistory ?? []).map((l) => ({
    round: l.round,
    holderId: l.holderId,
    targetId: l.targetId,
    result: l.result,
    declared: l.declared,
    declaredClaim: l.declaredClaim,
  }));

  const v1: V1GameRecordInput = {
    gameId: room.id,
    roomName: room.name,
    playerCount: playerEntries.length,
    winner,
    winReason: endReason,
    questResults: room.questResults ?? [],
    duration,
    players,
    createdAt: startedAt,
    endedAt,
    voteHistoryPersisted: voteHistory,
    questHistoryPersisted: questHistory,
    ladyOfTheLakeHistoryPersisted: ladyHistory,
    assassinTargetId: room.assassinTargetId,
    leaderStartIndex:
      typeof room.leaderIndex === 'number' ? room.leaderIndex : undefined,
  };

  return convertV1ToV2(v1);
}
