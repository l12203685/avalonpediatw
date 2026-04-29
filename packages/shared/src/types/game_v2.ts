/**
 * Avalon 戰績 V2 — 極簡原子資料 schema.
 *
 * 設計原則（見 `staging/subagent_results/game_record_v2_design_2026-04-24.md`）：
 *   1. 只存原子資料，派生指標（勝率 / ELO / 任務成功率 …）皆即時計算。
 *   2. 座號制 1..10 作局內穩定鍵；座 10 == Edward 口中的「0 號玩家」。
 *   3. 投票用 `{R}-{#}` 編碼（round × proposalIndex）。
 *   4. Sheets metadata（pageRef/session/note…）不進主結構。
 *   5. 玩家資訊只存 **UUID**（字元最少、唯一性）。displayName 由呼叫端透過 userId → user profile
 *      查表即時補；歷史 Sheets 資料找不到用戶則用 `sheets:<原名字>` 偽 UUID 落地以保留局內穩定鍵。
 *      — Edward 2026-04-24 12:18：「當然是只存 uuid, 字元最少, 唯一性的」
 *
 * Phase 2a 範圍：UUID-only schema + Sheets parser。
 */

export type WinReasonV2 =
  | 'threeBlue_merlinAlive'   // 三藍活（刺殺失敗 → 好人勝）
  | 'threeBlue_merlinKilled'  // 三藍死（刺殺成功 → 壞人勝）
  | 'threeRed'                // 三紅（任務三次失敗 → 壞人勝）
  | 'fiveRejections'          // 五連否決（自動壞人勝）
  | 'hostCancelled';          // 房主中止

export type CampV2 = 'good' | 'evil';

export type TranscriptPhaseV2 =
  | 'night'
  | 'team_select'
  | 'voting'
  | 'quest'
  | 'lady'
  | 'assassin'
  | 'chat';

/**
 * 能力角色座號對照表。
 * key 未出現 = 此局無此角色（一般好人/一般壞人由 AVALON_CONFIG 減去能力角色推導）。
 */
export interface RolesV2 {
  merlin?: number;
  percival?: number;
  assassin?: number;
  morgana?: number;
  mordred?: number;
  oberon?: number;
}

/**
 * 單次提議 + 投票（Edward 的 `{R}-{#}` 原子單位）。
 *
 * 歷史 Sheets 資料幾乎沒有逐人投票紀錄；`votes` 允許 `null` 表示「無資料」。
 * Live 對局必須填 live roster 長度的 array。
 */
export interface MissionV2 {
  round: 1 | 2 | 3 | 4 | 5;
  proposalIndex: 1 | 2 | 3 | 4 | 5;
  leaderSeat: number;
  teamSeats: number[];
  /** `null` = 歷史資料無逐人投票；array length 需對齊 live 玩家人數。 */
  votes: Array<'approve' | 'reject'> | null;
  passed: boolean;
  approveCount: number;
  rejectCount: number;
  /** 只在 `passed === true` 時存在。 */
  questResult?: {
    successCount: number;
    failCount: number;
    success: boolean;
  };
  startedAt?: number;
  endedAt?: number;
  votingDurationMs?: number;
}

/**
 * 湖中女神（Lady of the Lake）單次使用。
 */
export interface LadyLinkV2 {
  round: number;
  holderSeat: number;
  targetSeat: number;
  declaration: CampV2;
  actual: CampV2;
  truthful: boolean;
}

/**
 * 加分項：對話逐字稿單行。
 */
export interface TranscriptLineV2 {
  ts: number;
  actorSeat: number;
  actorName?: string;
  phase: TranscriptPhaseV2;
  text: string;
}

/**
 * 最終結果 + 能力角色座號。
 */
export interface FinalResultV2 {
  winnerCamp: CampV2;
  winReason: WinReasonV2;
  /** 刺殺對象座號；只在 `winReason` 為 `threeBlue_*` 時有意義。 */
  assassinTargetSeat?: number;
  /** 刺中梅林（derived: roles.merlin === assassinTargetSeat），保留作資料冗餘校驗。 */
  assassinCorrect?: boolean;
  roles: RolesV2;
}

/**
 * 固定 10 位的 tuple。5 人局的後 5 位以空字串 `''` 填充。
 * 型別層面強制 10 位，避免下游以 `length` 判斷時出錯。
 */
export type FixedTenStrings = [
  string, string, string, string, string,
  string, string, string, string, string,
];

/**
 * V2 戰績主結構。
 *
 * 儲存：`games_v2/{gameId}`（與 V1 `games/` 並行；舊 collection 保留唯讀）。
 */
export interface GameRecordV2 {
  schemaVersion: 2;
  gameId: string;
  /** Unix ms — 比賽開始時間。 */
  playedAt: number;
  /** 加分項：總時長。 */
  totalDurationMs?: number;

  /**
   * 玩家 UUID 按座號 1..10 排列（index 0 = 座 1，index 9 = 座 10 = Edward 的「0 號」）。
   *
   * 寫入規則：
   *   - 註冊用戶：存 Firebase Auth / Supabase 的 user UID（字元最少、唯一）
   *   - 歷史 Sheets 無帳號的玩家：存 `sheets:<原名字>` 偽 UUID 作局內穩定鍵
   *   - 空座（5/7 人局後段）：空字串 `''`
   *
   * 不冗存 displayName — 上游讀取時透過用戶資料表查名字；Sheets 偽 UUID
   * 帶 `sheets:` 前綴，callback 解析出 `<原名字>` 後顯示。
   *   — Edward 2026-04-24 12:18 原話：「當然是只存 uuid, 字元最少, 唯一性的」
   */
  playerSeats: FixedTenStrings;

  finalResult: FinalResultV2;

  missions: MissionV2[];

  /** 未使用湖則 undefined 或空 array。 */
  ladyChain?: LadyLinkV2[];

  /** 對話逐字稿（加分項，Phase 1 保留未實作）。 */
  transcript?: TranscriptLineV2[];

  /**
   * ELO-exclusion flags (Edward 2026-04-24 14:43：「在計算ELO時排除有AI 與 有
   * 勾選"娛樂局" 的場次」).
   *
   * - `hasAI`: snapshot of whether any seat was a bot at game-end (derived from
   *   `Room.players[*].isBot`). `true` = at least one AI / bot participant.
   * - `casual`: host opted into the "casual match" checkbox in the lobby so
   *   the match is explicitly excluded from competitive stats.
   *
   * Both default to `undefined` (treat as `false`) so historical V2 records
   * with no migration remain valid. `ComputedStatsRepositoryV2` + leaderboard
   * compute flow skip games where either flag is true.
   */
  hasAI?: boolean;
  casual?: boolean;
}

// ── Selfplay reasoning trace (Wave D 2026-04-29) ─────────────────────────
//
// Edward 2026-04-29 grill round 5: structured per-decision reasoning trace
// that captures **only the rows worth reading** — anomaly votes, mission
// fails (red side), every lake event, and assassin pick. The render layer
// uses the 4-column template (解讀/邏輯/目的/動作) plus the 忠臣 baseline
// + override pattern so any role's reasoning reads as
//   "if I were a loyalist I would think X, but I additionally know Y".
//
// Storage: gzip(JSONL) → base64 → Firestore `selfplay_reasoning/{gameId}`
// (Option F per `staging/subagent_results/selfplay_db_storage_eval_2026-04-29.md`).
// V2 atoms stay in `games_v2/{gameId}` so leaderboard / stats queries don't
// pull this blob unnecessarily.

/** Decision moments captured in the reasoning trace. */
export type ReasoningDecisionType =
  | 'team_select'
  | 'team_vote'
  | 'quest_vote'
  | 'lake_target'
  | 'lake_declare'
  | 'assassinate';

/**
 * Anomaly classification (Edward 2026-04-29 Q4 spec).
 *
 *   - `inner_black`     — on-team player voting reject.
 *   - `outer_white`     — off-team player voting approve.
 *   - `outer_white_self`— leader proposes a team that excludes themselves
 *                        AND votes approve (外灑外白).
 *   - `null`            — normal vote (in-team approve / out-team reject)
 *                        or non-vote decision.
 */
export type ReasoningAnomalyType =
  | 'inner_black'
  | 'outer_white'
  | 'outer_white_self'
  | null;

/**
 * Mission-vote (quest_vote) classification — only red-side ships a mission
 * thought (Edward Q7: 藍方 = 必出成功, 不列思維). The render layer drops
 * blue-side quest_vote entries; this enum records the red intent.
 */
export type ReasoningMissionVoteType =
  | 'red_success'  // red plays 成功票 (cover; Q7 視局勢出)
  | 'red_fail'     // red plays 失敗票
  | null;          // not a quest_vote OR blue side (always 成功)

/**
 * One captured reasoning entry. The thought is built from atomic fields
 * so the renderer can print 4-column template OR the JSONL stays raw enough
 * to feed an LLM training pipeline later.
 */
export interface ReasoningEntry {
  decisionType: ReasoningDecisionType;
  /** Round 1..5 (assassinate uses last round). */
  round: number;
  /** Proposal index within round (1..5); 0 for non-proposal decisions. */
  attempt: number;
  /** Actor seat (1..10; seat 10 displayed as "0"). */
  actorSeat: number;
  /** Actor role tag (`merlin`/`percival`/`loyal`/`assassin`/...). */
  actorRole: string;
  /** Leader seat at decision time. */
  leaderSeat: number;

  /** 4-column template fields (Edward 2026-04-29 Q1). */
  interpretation: string;  // 解讀: 我看到上家 X 動作 Y, 我推 Z
  logic: string;           // 邏輯: 一句推導鏈
  purpose: string;         // 目的: 角色目的 (來自 camp purpose 清單)
  action: string;          // 動作: 派 130 / 異常黑 / 出失敗票 等

  /** 忠臣 baseline + override 母模板 (Edward 2026-04-29 Q2). */
  loyalistBaseline: string;  // baseline: 如果我是忠臣會推 ...
  myOverride: string;        // override: 但我內建知 X, 推導變 Y

  /** Filter helpers (Edward 2026-04-29 Q4/Q5/Q7). */
  anomalyType: ReasoningAnomalyType;
  missionVoteType: ReasoningMissionVoteType;
}

/**
 * Storage doc for `selfplay_reasoning/{gameId}` — Option F (per
 * `staging/subagent_results/selfplay_db_storage_eval_2026-04-29.md`).
 *
 *   gzReasoningB64 = base64(gzip(JSONL_of_entries))
 */
export interface SelfplayReasoningRecord {
  schemaVersion: 1;
  gameId: string;
  rowCount: number;
  /** base64-encoded gzip of `ReasoningEntry[]` serialized as JSONL. */
  gzReasoningB64: string;
  meta: {
    decisionTypes: Partial<Record<ReasoningDecisionType, number>>;
    /** Filtered counts AFTER the renderer drops normal/blue rows — the
     *  numbers Edward will see in the .md output. */
    keptForRender: number;
  };
}
