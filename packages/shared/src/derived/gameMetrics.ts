/**
 * V2 派生指標 — 純函式，從 `GameRecordV2[]` 即時計算。
 *
 * 設計原則：
 *   1. 只存原子資料 → 所有統計在此計算（不冗存）
 *   2. 純函式 + 無 side effect → 前後端共用
 *   3. UUID-only：playerSeats 的 UUID 是唯一鍵；`sheets:<名字>` 偽 UUID 同等對待
 *   4. 座位制：seatIdx = playerSeats.indexOf(uid)；seatNo = seatIdx + 1 (1..10)
 *
 * Edward 2026-04-24 Phase 2b：
 *   - 一天更新一次（非 realtime），存 `computed_stats/{playerId}` 配 `lastComputedGameId`
 *   - 增量重算：新戰績進 → 對該玩家重算（backend 的 repo 處理）
 *   - 全玩家入排行榜，按分類顯示
 *
 * Edward 2026-04-24 13:37：分類門檻改用 **場次** 不是 ELO：
 *   - 菜雞：totalGames < 50
 *   - 初學：50 ≤ totalGames < 100
 *   - 新手：100 ≤ totalGames < 150
 *   - 中堅：150 ≤ totalGames < 200
 *   - 高手：200 ≤ totalGames < 250
 *   - 大師：totalGames ≥ 250
 *   每個 tier 內部按 ELO 排序。全玩家都進排行榜（大部分在菜雞/初學）。
 */

import { AVALON_CONFIG, type Role, type Team } from '../types/game';
import type {
  CampV2,
  GameRecordV2,
  RolesV2,
} from '../types/game_v2';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PlayerId = string;
export type Seat = number;

/** 玩家分類（低→高）。門檻以 **總場次** 判定，Edward 2026-04-24 13:37 拍板。 */
export type PlayerTier =
  | '菜雞'
  | '初學'
  | '新手'
  | '中堅'
  | '高手'
  | '大師';

export interface PlayerWinRateV2 {
  overall: number;                          // 0..1
  asGood: number;                           // 0..1
  asEvil: number;                           // 0..1
  byPlayerCount: Record<number, number>;    // {5: 0.45, 6: 0.50, ...}
  totalGames: number;
  wins: number;
}

export interface PlayerRoleStatsV2 {
  plays: number;
  wins: number;
  rate: number;  // 0..1
}

export interface AlignmentStatsV2 {
  rate: number;   // 0..1
  total: number;
  correct: number;
}

/** 對單一玩家的完整派生統計快照（寫入 `computed_stats/{playerId}`）。 */
export interface ComputedPlayerStatsV2 {
  playerId: PlayerId;
  computedAt: number;
  lastComputedGameId: string | null;
  totalGames: number;

  winRate: PlayerWinRateV2;
  roleWinRate: Record<Role, PlayerRoleStatsV2>;
  missionSuccessRate: {
    asGood: AlignmentStatsV2;
    asEvil: AlignmentStatsV2;
  };
  voteAccuracy: AlignmentStatsV2;
  ladyAccuracy: AlignmentStatsV2;
  merlinAssassinationRate: {
    timesAsMerlin: number;
    timesAssassinated: number;
    survivalRate: number;   // 1 - (assassinated / timesAsMerlin)
  };

  elo: number;
  tier: PlayerTier;
}

export interface LeaderboardEntryV2 {
  playerId: PlayerId;
  elo: number;
  tier: PlayerTier;
  totalGames: number;
  winRate: number;
  rank: number;
}

// ---------------------------------------------------------------------------
// Role expansion — 把空位補成 loyal/minion
// ---------------------------------------------------------------------------

/**
 * 把座位 1..playerCount 全展開成 Role。未在 roles 裡指派的座位，依 AVALON_CONFIG
 * 剩餘池推導：
 *   - 剩餘池只含 loyal → 該座 loyal
 *   - 剩餘池只含單一 evil role（罕見）→ 該座該角色
 *   - 多種可能 → null（理論不會發生，AVALON_CONFIG role 與 RolesV2 鍵位一致時）
 *
 * 注意：Phase 1 adapter 的 deriveRoleForSeat 是簡化版；此函式為正式版。
 */
export function expandRolesForAllSeats(
  roles: RolesV2,
  playerCount: number,
): Record<Seat, Role | null> {
  const out: Record<Seat, Role | null> = {};
  const config = AVALON_CONFIG[playerCount];
  if (!config) {
    // unknown player count — 只標能力角色，其餘 null
    for (let seat = 1; seat <= playerCount; seat += 1) {
      out[seat] = deriveRoleBySpecialOnly(seat, roles);
    }
    return out;
  }

  // 已指派的能力角色集合（單件）
  const assignedSpecial = new Set<Role>();
  const seatToRole = new Map<Seat, Role>();

  const SPECIAL_KEYS: Array<[keyof RolesV2, Role]> = [
    ['merlin', 'merlin'],
    ['percival', 'percival'],
    ['assassin', 'assassin'],
    ['morgana', 'morgana'],
    ['mordred', 'mordred'],
    ['oberon', 'oberon'],
  ];

  for (const [key, role] of SPECIAL_KEYS) {
    const s = roles[key];
    if (typeof s === 'number') {
      seatToRole.set(s, role);
      assignedSpecial.add(role);
    }
  }

  // 從 AVALON_CONFIG.roles 減去已指派的 special → 剩餘池（多個 loyal 各自為一項）
  const remainingPool: Role[] = [];
  const specialConsumed = new Set<Role>();
  for (const r of config.roles) {
    if (r === 'loyal' || r === 'minion') {
      remainingPool.push(r);
      continue;
    }
    if (assignedSpecial.has(r) && !specialConsumed.has(r)) {
      specialConsumed.add(r);
      continue;
    }
    remainingPool.push(r);
  }

  // 剩餘座位（1..playerCount 減 seatToRole 已有者）依序分配剩餘池。
  // 注意：剩餘池順序不代表特定座位，此處為推導用；只要人池一致即可。
  const remainingSeats: Seat[] = [];
  for (let seat = 1; seat <= playerCount; seat += 1) {
    if (!seatToRole.has(seat)) remainingSeats.push(seat);
  }

  // 如果剩餘池只有同種角色（全 loyal 或全 minion），所有剩餘座位都填同種。
  const uniquePool = Array.from(new Set(remainingPool));
  if (uniquePool.length === 1) {
    const single = uniquePool[0];
    for (const seat of remainingSeats) seatToRole.set(seat, single);
  } else {
    // 剩餘池混雜 → 無法從座位精確推導；只標 special，其他 null。
    // （理論上 AVALON_CONFIG 設計只有 loyal 是多件，其他為單件，所以剩餘池應只剩 loyal。）
  }

  for (let seat = 1; seat <= playerCount; seat += 1) {
    out[seat] = seatToRole.get(seat) ?? null;
  }
  return out;
}

function deriveRoleBySpecialOnly(seat: Seat, roles: RolesV2): Role | null {
  if (roles.merlin === seat) return 'merlin';
  if (roles.percival === seat) return 'percival';
  if (roles.assassin === seat) return 'assassin';
  if (roles.morgana === seat) return 'morgana';
  if (roles.mordred === seat) return 'mordred';
  if (roles.oberon === seat) return 'oberon';
  return null;
}

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

function teamToCamp(team: Team | null): CampV2 | null {
  if (team === 'good') return 'good';
  if (team === 'evil') return 'evil';
  return null;
}

// ---------------------------------------------------------------------------
// Game helpers
// ---------------------------------------------------------------------------

function nonEmptyPlayerCount(game: GameRecordV2): number {
  let count = 0;
  for (let i = 0; i < 10; i += 1) {
    if (game.playerSeats[i]?.trim()) count += 1;
  }
  return count;
}

/** 回傳該玩家在此局的 seat（1..10）；不在局中回 null。 */
export function findSeatForPlayer(
  game: GameRecordV2,
  playerId: PlayerId,
): Seat | null {
  for (let i = 0; i < 10; i += 1) {
    if (game.playerSeats[i] === playerId) return i + 1;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 1. 玩家總勝率
// ---------------------------------------------------------------------------

export function computePlayerWinRate(
  games: GameRecordV2[],
  playerId: PlayerId,
): PlayerWinRateV2 {
  let totalGames = 0;
  let wins = 0;
  let goodGames = 0;
  let goodWins = 0;
  let evilGames = 0;
  let evilWins = 0;
  const byCount: Record<number, { games: number; wins: number }> = {};

  for (const game of games) {
    const seat = findSeatForPlayer(game, playerId);
    if (seat === null) continue;
    const playerCount = nonEmptyPlayerCount(game);
    if (playerCount < 5 || playerCount > 10) continue;

    const roleMap = expandRolesForAllSeats(game.finalResult.roles, playerCount);
    const role = roleMap[seat] ?? null;
    const team = teamForRole(role);
    if (team === null) continue;

    const won = team === game.finalResult.winnerCamp;
    totalGames += 1;
    if (won) wins += 1;
    if (team === 'good') {
      goodGames += 1;
      if (won) goodWins += 1;
    } else {
      evilGames += 1;
      if (won) evilWins += 1;
    }

    const slot = byCount[playerCount] ?? { games: 0, wins: 0 };
    slot.games += 1;
    if (won) slot.wins += 1;
    byCount[playerCount] = slot;
  }

  const byPlayerCount: Record<number, number> = {};
  for (const [k, v] of Object.entries(byCount)) {
    byPlayerCount[Number(k)] = v.games > 0 ? v.wins / v.games : 0;
  }

  return {
    overall: totalGames > 0 ? wins / totalGames : 0,
    asGood: goodGames > 0 ? goodWins / goodGames : 0,
    asEvil: evilGames > 0 ? evilWins / evilGames : 0,
    byPlayerCount,
    totalGames,
    wins,
  };
}

// ---------------------------------------------------------------------------
// 2. 玩家各角色勝率
// ---------------------------------------------------------------------------

const ALL_ROLES: Role[] = [
  'merlin',
  'percival',
  'loyal',
  'assassin',
  'morgana',
  'mordred',
  'oberon',
  'minion',
];

export function computePlayerRoleWinRate(
  games: GameRecordV2[],
  playerId: PlayerId,
): Record<Role, PlayerRoleStatsV2> {
  const stats: Record<Role, PlayerRoleStatsV2> = {} as Record<Role, PlayerRoleStatsV2>;
  for (const r of ALL_ROLES) {
    stats[r] = { plays: 0, wins: 0, rate: 0 };
  }

  for (const game of games) {
    const seat = findSeatForPlayer(game, playerId);
    if (seat === null) continue;
    const playerCount = nonEmptyPlayerCount(game);
    if (playerCount < 5 || playerCount > 10) continue;

    const roleMap = expandRolesForAllSeats(game.finalResult.roles, playerCount);
    const role = roleMap[seat];
    if (!role) continue;

    const team = teamForRole(role);
    if (team === null) continue;
    const won = team === game.finalResult.winnerCamp;

    const slot = stats[role];
    slot.plays += 1;
    if (won) slot.wins += 1;
  }

  for (const r of ALL_ROLES) {
    const slot = stats[r];
    slot.rate = slot.plays > 0 ? slot.wins / slot.plays : 0;
  }
  return stats;
}

// ---------------------------------------------------------------------------
// 3. 玩家任務成功率（作為隊員時）
// ---------------------------------------------------------------------------

/**
 * 以陣營分：玩家 X 當隊員出任務的 mission，統計 success/fail。
 * "asGood" = 玩家是好人時的隊員任務；"asEvil" = 玩家是壞人時的隊員任務。
 */
export function computePlayerMissionSuccess(
  games: GameRecordV2[],
  playerId: PlayerId,
): { asGood: AlignmentStatsV2; asEvil: AlignmentStatsV2 } {
  let goodTotal = 0;
  let goodCorrect = 0;
  let evilTotal = 0;
  let evilCorrect = 0;

  for (const game of games) {
    const seat = findSeatForPlayer(game, playerId);
    if (seat === null) continue;
    const playerCount = nonEmptyPlayerCount(game);
    if (playerCount < 5 || playerCount > 10) continue;

    const roleMap = expandRolesForAllSeats(game.finalResult.roles, playerCount);
    const role = roleMap[seat];
    if (!role) continue;
    const team = teamForRole(role);
    if (team === null) continue;

    for (const m of game.missions) {
      if (!m.passed || !m.questResult) continue;
      if (!m.teamSeats.includes(seat)) continue;
      if (team === 'good') {
        goodTotal += 1;
        if (m.questResult.success) goodCorrect += 1;
      } else {
        evilTotal += 1;
        if (!m.questResult.success) evilCorrect += 1;
      }
    }
  }

  return {
    asGood: {
      total: goodTotal,
      correct: goodCorrect,
      rate: goodTotal > 0 ? goodCorrect / goodTotal : 0,
    },
    asEvil: {
      total: evilTotal,
      correct: evilCorrect,
      rate: evilTotal > 0 ? evilCorrect / evilTotal : 0,
    },
  };
}

// ---------------------------------------------------------------------------
// 4. 玩家投票正確率
// ---------------------------------------------------------------------------

/**
 * 規則：玩家投 approve 且任務通過後成功 → 對好人為正確；
 *       玩家投 reject 且該提議被否決 or 任務失敗 → 對好人為正確。
 *       以玩家陣營視角判斷：好人應 approve 成功的提議、reject 失敗/紅隊多的提議。
 *       壞人反之。
 *
 * 此處採簡化定義：玩家投票方向與「該提議最終結果對其陣營是否有利」一致 → correct。
 *   - 好人：approve 且 passed 且任務 success → correct；reject 且該 proposal 失敗
 *     (失敗後 lastPassed 為下一 proposal) or 任務 fail → correct
 *   - 壞人反之。
 */
export function computePlayerVoteAccuracy(
  games: GameRecordV2[],
  playerId: PlayerId,
): AlignmentStatsV2 {
  let total = 0;
  let correct = 0;

  for (const game of games) {
    const seat = findSeatForPlayer(game, playerId);
    if (seat === null) continue;
    const playerCount = nonEmptyPlayerCount(game);
    if (playerCount < 5 || playerCount > 10) continue;

    const roleMap = expandRolesForAllSeats(game.finalResult.roles, playerCount);
    const role = roleMap[seat];
    if (!role) continue;
    const team = teamForRole(role);
    if (team === null) continue;

    for (const m of game.missions) {
      if (!m.votes) continue;
      const idx = seat - 1;
      if (idx < 0 || idx >= m.votes.length) continue;
      const vote = m.votes[idx];

      // 判斷該提議對玩家陣營是否「有利」
      // - 任務 success → 對好人有利
      // - 任務 fail → 對壞人有利
      // - 未通過的提議（passed=false）視為中性，skip（也可算入「否決對自己有利嗎」，但簡化）
      if (!m.passed) continue;
      if (!m.questResult) continue;

      const favorableApprove =
        team === 'good' ? m.questResult.success : !m.questResult.success;
      const correctVote = favorableApprove ? 'approve' : 'reject';

      total += 1;
      if (vote === correctVote) correct += 1;
    }
  }

  return {
    total,
    correct,
    rate: total > 0 ? correct / total : 0,
  };
}

// ---------------------------------------------------------------------------
// 5. 玩家湖使用正確率（宣告 == 實際）
// ---------------------------------------------------------------------------

export function computePlayerLadyAccuracy(
  games: GameRecordV2[],
  playerId: PlayerId,
): AlignmentStatsV2 {
  let total = 0;
  let correct = 0;

  for (const game of games) {
    const seat = findSeatForPlayer(game, playerId);
    if (seat === null) continue;
    const chain = game.ladyChain ?? [];
    for (const lady of chain) {
      if (lady.holderSeat !== seat) continue;
      total += 1;
      if (lady.declaration === lady.actual) correct += 1;
    }
  }

  return {
    total,
    correct,
    rate: total > 0 ? correct / total : 0,
  };
}

// ---------------------------------------------------------------------------
// 6. 梅林被刺率
// ---------------------------------------------------------------------------

export interface MerlinAssassinationStats {
  timesAsMerlin: number;
  timesAssassinated: number;
  survivalRate: number;
}

export function computeMerlinAssassinationRate(
  games: GameRecordV2[],
  playerId: PlayerId,
): MerlinAssassinationStats {
  let timesAsMerlin = 0;
  let timesAssassinated = 0;

  for (const game of games) {
    const seat = findSeatForPlayer(game, playerId);
    if (seat === null) continue;
    if (game.finalResult.roles.merlin !== seat) continue;
    timesAsMerlin += 1;
    // 玩家為梅林，且 winReason 為 threeBlue_merlinKilled → 被刺
    if (game.finalResult.winReason === 'threeBlue_merlinKilled') {
      timesAssassinated += 1;
    }
    // 若有 assassinTargetSeat 且 == seat → 被刺（更精準）
    // 此處以 winReason 為主；assassinTargetSeat 為 Phase 2c 才寫入。
  }

  const survivalRate = timesAsMerlin > 0
    ? 1 - timesAssassinated / timesAsMerlin
    : 0;
  return { timesAsMerlin, timesAssassinated, survivalRate };
}

// ---------------------------------------------------------------------------
// 7. ELO（簡化版：以 `expectedScore` 純函式計分，供 V2 批次重算用）
// ---------------------------------------------------------------------------

/**
 * V2 ELO 計算（純函式，不依賴 Firebase）：
 *   - 起始分 1000
 *   - K = 32 * roleWeight * outcomeWeight
 *   - role weight: merlin/assassin 1.5, percival/morgana 1.2, mordred 1.3, oberon 1.1, 其他 1.0
 *   - outcome weight: threeBlue_merlinKilled (刺中梅林) 1.5；其他 1.0
 *   - 對手平均分：未知時 fallback 1500
 *
 * 注意：這是 GameStatsV2 的 batch recompute，不影響 live `rankings/`。
 */
export function computeELO(
  games: GameRecordV2[],
  playerId: PlayerId,
  initialElo = 1000,
): number {
  const ROLE_K_WEIGHTS: Record<Role, number> = {
    merlin: 1.5,
    assassin: 1.5,
    percival: 1.2,
    morgana: 1.2,
    mordred: 1.3,
    oberon: 1.1,
    loyal: 1.0,
    minion: 1.0,
  };
  const BASE_K = 32;
  const TEAM_BASELINE = 1500;
  const MIN_ELO = 100;

  let elo = initialElo;

  // games 先按 playedAt 升序處理（ELO 有順序依賴）
  const sorted = [...games].sort((a, b) => a.playedAt - b.playedAt);

  for (const game of sorted) {
    const seat = findSeatForPlayer(game, playerId);
    if (seat === null) continue;
    const playerCount = nonEmptyPlayerCount(game);
    if (playerCount < 5 || playerCount > 10) continue;

    const roleMap = expandRolesForAllSeats(game.finalResult.roles, playerCount);
    const role = roleMap[seat];
    if (!role) continue;
    const team = teamForRole(role);
    if (team === null) continue;

    const won = team === game.finalResult.winnerCamp;
    const outcomeWeight =
      game.finalResult.winReason === 'threeBlue_merlinKilled' ? 1.5 : 1.0;
    const roleWeight = ROLE_K_WEIGHTS[role] ?? 1.0;
    const adjustedK = BASE_K * roleWeight * outcomeWeight;

    // 對手平均分：V2 無跨玩家 ELO（批次重算），用 baseline
    const expected = 1 / (1 + Math.pow(10, (TEAM_BASELINE - elo) / 400));
    const actual = won ? 1 : 0;
    elo = Math.round(elo + adjustedK * (actual - expected));
    elo = Math.max(MIN_ELO, elo);
  }

  return elo;
}

// ---------------------------------------------------------------------------
// 8. 分類（Tier）
// ---------------------------------------------------------------------------

export interface TierThreshold {
  tier: PlayerTier;
  /** 該 tier 的 **總場次** 下限（包含）。 */
  minGames: number;
}

/**
 * Tier 門檻（低 → 高）。Edward 2026-04-24 13:37：用 **場次** 不是 ELO。
 *
 *   菜雞: games < 50
 *   初學: 50 ≤ games < 100
 *   新手: 100 ≤ games < 150
 *   中堅: 150 ≤ games < 200
 *   高手: 200 ≤ games < 250
 *   大師: games ≥ 250
 */
export const TIER_THRESHOLDS: TierThreshold[] = [
  { tier: '菜雞', minGames: 0 },
  { tier: '初學', minGames: 50 },
  { tier: '新手', minGames: 100 },
  { tier: '中堅', minGames: 150 },
  { tier: '高手', minGames: 200 },
  { tier: '大師', minGames: 250 },
];

/**
 * 保留常數以維持相容（已不用於 tier 判定，但 server 端有 re-export）。
 * Edward 2026-04-24 明確刪掉 `< 10 場 unranked` 規則 → 常數僅作歷史佔位，值設 0
 * 代表「無場次下限門檻」— 全玩家都入排行榜，最低進菜雞。
 */
export const TIER_MIN_GAMES = 0;

/**
 * 依 **總場次** 決定玩家 tier。
 *
 * @param elo            保留在 signature 中以相容舊呼叫端；tier 判定已不使用 ELO。
 * @param totalGames     玩家總場次
 * @param _minGames      legacy override（目前無效，保留以不破壞呼叫端）
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function computeTier(
  elo: number,
  totalGames: number,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _minGames: number = TIER_MIN_GAMES,
): PlayerTier {
  let tier: PlayerTier = '菜雞';
  for (const t of TIER_THRESHOLDS) {
    if (totalGames >= t.minGames) tier = t.tier;
  }
  return tier;
}

// ---------------------------------------------------------------------------
// 9. 按分類排行榜
// ---------------------------------------------------------------------------

/**
 * 按分類排行榜：先依 `tier` 分組，每組內按 ELO 由高到低排序（同 ELO 時維持
 * 原順序）。tier-local rank 從 1 開始。全玩家進榜（Edward 2026-04-24）。
 */
export function computeLeaderboardByTier(
  stats: ComputedPlayerStatsV2[],
): Record<PlayerTier, LeaderboardEntryV2[]> {
  const out: Record<PlayerTier, LeaderboardEntryV2[]> = {
    '菜雞': [],
    '初學': [],
    '新手': [],
    '中堅': [],
    '高手': [],
    '大師': [],
  };

  // 先把每人塞進對應 tier bucket
  for (const s of stats) {
    const entry: LeaderboardEntryV2 = {
      playerId: s.playerId,
      elo: s.elo,
      tier: s.tier,
      totalGames: s.totalGames,
      winRate: s.winRate.overall,
      rank: 0, // 稍後填 tier-local rank
    };
    out[s.tier].push(entry);
  }

  // 各 tier 內按 ELO 降序 + 填 tier-local rank（1-based）
  for (const tier of Object.keys(out) as PlayerTier[]) {
    out[tier].sort((a, b) => b.elo - a.elo);
    out[tier].forEach((e, idx) => {
      e.rank = idx + 1;
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 整合：一次算一位玩家完整 stats
// ---------------------------------------------------------------------------

export function computePlayerStatsV2(
  games: GameRecordV2[],
  playerId: PlayerId,
  opts?: { initialElo?: number; minGamesForTier?: number },
): ComputedPlayerStatsV2 {
  const winRate = computePlayerWinRate(games, playerId);
  const roleWinRate = computePlayerRoleWinRate(games, playerId);
  const missionSuccess = computePlayerMissionSuccess(games, playerId);
  const voteAccuracy = computePlayerVoteAccuracy(games, playerId);
  const ladyAccuracy = computePlayerLadyAccuracy(games, playerId);
  const merlinStats = computeMerlinAssassinationRate(games, playerId);
  const elo = computeELO(games, playerId, opts?.initialElo ?? 1000);
  const tier = computeTier(
    elo,
    winRate.totalGames,
    opts?.minGamesForTier ?? TIER_MIN_GAMES,
  );

  // lastComputedGameId：以 playedAt 最新的局為主
  let latest: GameRecordV2 | null = null;
  for (const g of games) {
    if (findSeatForPlayer(g, playerId) === null) continue;
    if (!latest || g.playedAt > latest.playedAt) latest = g;
  }

  return {
    playerId,
    computedAt: Date.now(),
    lastComputedGameId: latest?.gameId ?? null,
    totalGames: winRate.totalGames,
    winRate,
    roleWinRate,
    missionSuccessRate: missionSuccess,
    voteAccuracy,
    ladyAccuracy,
    merlinAssassinationRate: {
      timesAsMerlin: merlinStats.timesAsMerlin,
      timesAssassinated: merlinStats.timesAssassinated,
      survivalRate: merlinStats.survivalRate,
    },
    elo,
    tier,
  };
}

/**
 * 蒐集某玩家出現過的所有局。供 incremental recompute 使用。
 */
export function filterGamesForPlayer(
  games: GameRecordV2[],
  playerId: PlayerId,
): GameRecordV2[] {
  return games.filter((g) => findSeatForPlayer(g, playerId) !== null);
}

/**
 * 蒐集所有玩家 UUID（包含 `sheets:` 偽 UUID）。
 */
export function collectAllPlayerIds(games: GameRecordV2[]): PlayerId[] {
  const set = new Set<PlayerId>();
  for (const g of games) {
    for (let i = 0; i < 10; i += 1) {
      const uid = g.playerSeats[i];
      if (uid && uid.trim()) set.add(uid);
    }
  }
  return Array.from(set);
}
