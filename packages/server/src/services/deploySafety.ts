/**
 * 「現在合併會不會打斷人？」（站長 2026-11-26：「你未來可以先確定沒有影響進行中的局或任務再合併嗎」）
 *
 * 每次合併到 main、而且改到後端，Render 就重新部署、伺服器重啟、記憶體清空。這裡把「重啟的話誰會丟掉東西」
 * 算成幾個數字，放在 /api/bots/status → live；根目錄的 scripts/deployGate.mjs 讀它，安全才回 0。
 *
 * 只有數字和固定的代碼，沒有房間代號、名字、聊天內容。
 *
 * safeToDeploy = 沒有任何真人會丟掉東西：
 *   - 擋（blocking）：有真人的對局進行中、練習局進行中、刺殺等指令中、模擬瓦題目沒存檔、遊戲內回饋還沒寫進試算表、
 *     練習局「被針對」的回答還沒寫進試算表、伺服器還沒把房間數接上來（不知道 = 不安全）。
 *   - 不擋，只列出來（minor）：大廳裡有真人在等（重啟後重新開房就好）、LINE 待送的同步訊息、模擬瓦題目有存檔
 *     （重啟後讀回來）、只有機器人的房間。
 */

/** GameServer 算的房間數（liveCounts()）。 */
export interface LiveRoomCounts {
  /** 遊戲中（不在大廳、還沒結束）的房間，練習房不算。 */
  roomsInGame: number;
  /** 其中至少有一個真人「連線中」的。 */
  roomsInGameWithHumans: number;
  /** 其中有真人、但真人全都斷線了的（手機鎖屏、關分頁；回來還能接著打）。 */
  roomsInGameHumansAway: number;
  /** 其中只有機器人的（沒有人會丟掉東西）。 */
  roomsInGameBotsOnly: number;
  /** 大廳裡有連線中的真人的房間。 */
  roomsInLobbyWithHumans: number;
  /** 練習房（與機器人練習）遊戲中。 */
  practiceInGame: number;
  /** 刺殺階段，機器人刺客在等紅方真人打「/刺殺 N」。 */
  redTalkWaits: number;
  /** 練習局「被針對」回答，還在等追問、還沒寫進試算表。 */
  practiceExploitPending: number;
}

export interface DeployLiveInput {
  rooms: LiveRoomCounts | null;
  /** 模擬瓦進行中的題目。 */
  simSessionsActive: number;
  /** 模擬瓦題目有存檔可以讀回來（private repo 有設定、開機讀檔做完）。 */
  simSessionsPersisted: boolean;
  /** 遊戲內回饋：還開著的局裡，判斷成回饋、還沒寫進試算表的句數。 */
  pendingFeedbackRows: number;
  /** LINE 待送的同步訊息。 */
  lineReplyQueue: number;
}

export type DeployLiveStatus = LiveRoomCounts & {
  simSessionsActive: number;
  pendingFeedbackRows: number;
  lineReplyQueue: number;
  /** 沒有任何真人會丟掉東西（只有 minor 的原因時也是 true）。 */
  safeToDeploy: boolean;
  /** 所有原因（代碼），擋的在前。 */
  reasons: string[];
  /** 其中會擋的。 */
  blocking: string[];
};

/** 會擋部署的原因代碼。 */
export const BLOCKING_REASONS = [
  'rooms_in_game_with_humans',
  'rooms_in_game_humans_away',
  'practice_in_game',
  'red_talk_waits',
  'sim_sessions_unsaved',
  'feedback_unsaved',
  'practice_exploit_pending',
  'live_counts_unavailable',
] as const;

/** 只列出來、不擋的原因代碼。 */
export const MINOR_REASONS = [
  'lobby_with_humans',
  'line_reply_queue',
  'sim_sessions_saved',
  'bot_only_rooms',
] as const;

const EMPTY_ROOMS: LiveRoomCounts = {
  roomsInGame: 0,
  roomsInGameWithHumans: 0,
  roomsInGameHumansAway: 0,
  roomsInGameBotsOnly: 0,
  roomsInLobbyWithHumans: 0,
  practiceInGame: 0,
  redTalkWaits: 0,
  practiceExploitPending: 0,
};

/** 純函式：數字 → 能不能部署。 */
export function evaluateDeploySafety(input: DeployLiveInput): DeployLiveStatus {
  const rooms = input.rooms ?? EMPTY_ROOMS;
  const blocking: string[] = [];
  const minor: string[] = [];
  if (!input.rooms) blocking.push('live_counts_unavailable');
  if (rooms.roomsInGameWithHumans > 0) blocking.push('rooms_in_game_with_humans');
  if (rooms.roomsInGameHumansAway > 0) blocking.push('rooms_in_game_humans_away');
  if (rooms.practiceInGame > 0) blocking.push('practice_in_game');
  if (rooms.redTalkWaits > 0) blocking.push('red_talk_waits');
  if (input.simSessionsActive > 0) {
    if (input.simSessionsPersisted) minor.push('sim_sessions_saved');
    else blocking.push('sim_sessions_unsaved');
  }
  if (input.pendingFeedbackRows > 0) blocking.push('feedback_unsaved');
  if (rooms.practiceExploitPending > 0) blocking.push('practice_exploit_pending');
  if (rooms.roomsInLobbyWithHumans > 0) minor.push('lobby_with_humans');
  if (input.lineReplyQueue > 0) minor.push('line_reply_queue');
  if (rooms.roomsInGameBotsOnly > 0) minor.push('bot_only_rooms');
  return {
    ...rooms,
    simSessionsActive: input.simSessionsActive,
    pendingFeedbackRows: input.pendingFeedbackRows,
    lineReplyQueue: input.lineReplyQueue,
    safeToDeploy: blocking.length === 0,
    reasons: [...blocking, ...minor],
    blocking,
  };
}

// ─── GameServer 接上來的房間數 ───────────────────────────────────────────────

let roomCountsSource: (() => LiveRoomCounts) | null = null;

/** GameServer 開始時接上；之後 /api/bots/status 每次都問它。 */
export function setLiveRoomCountsSource(fn: (() => LiveRoomCounts) | null): void {
  roomCountsSource = fn;
}

/** 現在的房間數；還沒接上或算的時候出錯 → null（當成不安全）。 */
export function readLiveRoomCounts(): LiveRoomCounts | null {
  if (!roomCountsSource) return null;
  try {
    return roomCountsSource();
  } catch {
    return null;
  }
}
