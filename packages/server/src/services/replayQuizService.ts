/**
 * 統一 AI騎士（C）— 站長私人重玩測驗（Replay Quiz）。
 *
 * 規格（docs/ai/UNIFIED_KNIGHTS_STATUS.md 第 C 節）：
 *   - 僅限站長使用（由路由層透過 `knightAdminAuth` 嚴格把關）。
 *   - 從 `games_cache.json` 挑選「距今超過 30 天（一個月以前）」的歷史局，
 *     重建指定玩家當時座位看得到的公開紀錄與角色視野，所有玩家名字匿名換成座位
 *     （`1家`～`9家`、`0家`），絕不在題目 payload 洩漏原本的真實選擇、真實名字、對局 ID 或日期。
 *   - 私人作答紀錄沿用 `GitHubJsonFile`（存於 private repo `bot-state/replay-quiz.json`，
 *     沿用既有 `GITHUB_ACCOUNTS_*` 環境變數，不新增環境變數；未設定時退回記憶體）。
 *   - 記錄作答結果與選填的「為什麼」理由文字，並計算逐動作與當初歷史決策的一致比例：
 *     `team`（派隊）／`vote`（投票）／`lakeTarget`（選湖）／`lakeClaim`（湖中宣告）／`assassinate`（刺殺）。
 */

import { createHash, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import { AVALON_CONFIG, type Role } from '@avalon/shared';
import { BOT_GAME_CATEGORY } from '@avalon/shared/stats';
import type { ConceptStateRepoConfig } from '../bots/conceptDaily/config';
import { GitHubJsonFile } from '../bots/conceptDaily/store';
import {
  replayGameFromDataset,
  type DatasetHeader,
  type DatasetTuple,
} from '../ai/benchmark/datasetReplay';
import {
  buildReplayObservation,
  seatOfId,
  validLakeTargetSeats,
  type DecisionPoint,
} from '../ai/benchmark/replayObservation';
import {
  campOf,
  EVIL_ROLES,
  FIRST_LAKE_HOLDER_SEAT,
  type Camp,
  type ReplayGame,
} from '../ai/benchmark/sheetsReplay';
import { isAssassinator } from '../game/assassinator';
import { ENV_GAMES_DATASET } from './gamesDataset';
import { normalizePlayerIdKey } from './playerKnightsStore';

export const REPLAY_QUIZ_VERSION = 1;
export const REPLAY_QUIZ_PATH = 'bot-state/replay-quiz.json';
export const REPLAY_QUIZ_MIN_AGE_DAYS = 30;
export const REPLAY_QUIZ_REASON_MAX = 500;
export const REPLAY_QUIZ_DEFAULT_PLAYER_ID = 'ED';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export const REPLAY_QUIZ_ACTIONS = [
  'team',
  'vote',
  'lakeTarget',
  'lakeClaim',
  'assassinate',
] as const;

export type ReplayQuizAction = typeof REPLAY_QUIZ_ACTIONS[number];

export type ReplayQuizAnswerValue = number[] | boolean | number | Camp;

/** `games_cache.json` 的精簡介面（只列本服務用到的欄位）。 */
export interface ReplayQuizDataset extends DatasetHeader {
  players: readonly string[];
  aliases?: Record<string, string>;
  games: readonly DatasetTuple[];
}

export interface ReplayQuizSeatInfo {
  seat: number;
  label: string;
}

export interface ReplayQuizVoteHistoryItem {
  round: number;
  attempt: number;
  leaderSeat: number;
  leaderLabel: string;
  teamSeats: number[];
  approved: boolean;
  forced: boolean;
  approveSeats: number[];
  rejectSeats: number[];
}

export interface ReplayQuizQuestHistoryItem {
  round: number;
  teamSeats: number[];
  result: 'success' | 'fail';
  failCount: number;
}

export interface ReplayQuizLakeHistoryItem {
  round: number;
  holderSeat: number;
  holderLabel: string;
  targetSeat: number;
  targetLabel: string;
  declaredClaim: 'good' | 'evil' | 'none';
}

export interface ReplayQuizPrivateLakeResult {
  round: number;
  targetSeat: number;
  targetLabel: string;
  result: Camp;
}

export interface ReplayQuizVision {
  knownEvils: number[];
  knownWizards?: number[];
  allEvilSeats?: number[];
  allEvilRoles?: Record<number, Role>;
  myLakeResults: ReplayQuizPrivateLakeResult[];
}

/**
 * 送給前端的題目（嚴格去識別化、不含真實答案、不含玩家名稱、不含對局 ID 與日期）。
 */
export interface ReplayQuizQuestion {
  questionId: string;
  action: ReplayQuizAction;
  mySeat: number;
  mySeatLabel: string;
  myRole: Role;
  myTeam: Camp;
  playerCount: number;
  seats: ReplayQuizSeatInfo[];
  evilCount: number;
  currentRound: number;
  currentAttempt?: number;
  currentLeaderSeat: number;
  currentLeaderLabel: string;
  proposedTeamSeats?: number[];
  requiredTeamSize?: number;
  validTargetSeats?: number[];
  inspectedTargetSeat?: number;
  inspectedTargetLabel?: string;
  inspectedResult?: Camp;
  vision: ReplayQuizVision;
  questHistory: ReplayQuizQuestHistoryItem[];
  voteHistory: ReplayQuizVoteHistoryItem[];
  lakeHistory: ReplayQuizLakeHistoryItem[];
}

/** 伺服器內部題目（含對照答案與歷史對局 metadata，絕不直接序列化到 `/next`）。 */
export interface InternalQuizItem {
  question: ReplayQuizQuestion;
  actualAnswer: ReplayQuizAnswerValue;
  gameId: string;
  gameDate: string;
  playerId: string;
}

export interface ReplayQuizAnswerRecord {
  id: string;
  questionId: string;
  gameId: string;
  gameDate: string;
  playerId: string;
  adminEmail: string;
  uid: string;
  seat: number;
  role: Role;
  action: ReplayQuizAction;
  userAnswer: ReplayQuizAnswerValue;
  actualAnswer: ReplayQuizAnswerValue;
  matched: boolean;
  reason?: string;
  answeredAt: string;
}

export interface ReplayQuizState {
  version: number;
  updatedAt: string;
  answers: ReplayQuizAnswerRecord[];
}

export interface ActionAgreementStat {
  answered: number;
  matched: number;
  rate: number | null;
}

export interface ReplayQuizStats {
  overall: ActionAgreementStat;
  byAction: Record<ReplayQuizAction, ActionAgreementStat>;
}

export interface ReplayQuizSubmitResult {
  ok: true;
  record: ReplayQuizAnswerRecord;
  matched: boolean;
  actualAnswer: ReplayQuizAnswerValue;
  actualAnswerLabel: string;
  userAnswerLabel: string;
  gameDate: string;
  stats: ReplayQuizStats;
}

export type ReplayQuizSubmitOutcome =
  | ReplayQuizSubmitResult
  | { ok: false; code: string; error: string };

// eslint-disable-next-line no-control-regex
const INVISIBLE_RE = /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/;
const ACTION_SET = new Set<string>(REPLAY_QUIZ_ACTIONS);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 座位編號（1..10）→ 匿名座位名稱（`1家`～`9家`、`0家`）。 */
export function seatLabel(seat: number): string {
  return seat === 10 ? '0家' : `${seat}家`;
}

/** 格式化作答內容為易讀中文（全部用座位，不含任何玩家名稱）。 */
export function formatAnswerLabel(action: ReplayQuizAction, value: ReplayQuizAnswerValue): string {
  if (action === 'team' && Array.isArray(value)) {
    const sorted = [...value].sort((a, b) => a - b);
    return sorted.map(seatLabel).join('、');
  }
  if (action === 'vote' && typeof value === 'boolean') {
    return value ? '贊成（白票）' : '反對（黑票）';
  }
  if ((action === 'lakeTarget' || action === 'assassinate') && typeof value === 'number') {
    return seatLabel(value);
  }
  if (action === 'lakeClaim' && (value === 'good' || value === 'evil')) {
    return value === 'good' ? '藍方（好人）' : '紅方（壞人）';
  }
  return String(value);
}

export function isValidQuizAction(raw: unknown): raw is ReplayQuizAction {
  return typeof raw === 'string' && ACTION_SET.has(raw);
}

/** 解析對局日期字串（`YYYY-MM-DD` 或 ISO）並判斷是否嚴格超過 `minAgeDays` 天。 */
export function isGameOlderThanDays(dateText: string, now: Date, minAgeDays = REPLAY_QUIZ_MIN_AGE_DAYS): boolean {
  const trimmed = dateText.trim();
  if (!trimmed) return false;
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? `${trimmed}T00:00:00.000Z` : trimmed;
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return false;
  return now.getTime() - ts > minAgeDays * MS_PER_DAY;
}

function makeQuestionId(gameId: string, seat: number, action: ReplayQuizAction, index: number): string {
  return createHash('sha256')
    .update(`replay-quiz:v1:${gameId}:${seat}:${action}:${index}`)
    .digest('hex')
    .slice(0, 16);
}

/** 在資料集中解析目標玩家 ID（支援大小寫／全半形正規化與 `aliases` 對照）對應的所有 `players` 索引。 */
export function resolvePlayerIndicesInDataset(dataset: ReplayQuizDataset, playerId: string): Set<number> {
  const targetKey = normalizePlayerIdKey(playerId);
  if (!targetKey) return new Set();

  // 先透過 aliases 把輸入轉成標準名（若有）
  let canonicalKey = targetKey;
  if (dataset.aliases) {
    for (const [alias, canonical] of Object.entries(dataset.aliases)) {
      if (normalizePlayerIdKey(alias) === targetKey) {
        canonicalKey = normalizePlayerIdKey(canonical);
        break;
      }
    }
  }

  // 同時收集指向同一標準名的別名
  const matchingKeys = new Set<string>([targetKey, canonicalKey]);
  if (dataset.aliases) {
    for (const [alias, canonical] of Object.entries(dataset.aliases)) {
      if (normalizePlayerIdKey(canonical) === canonicalKey) {
        matchingKeys.add(normalizePlayerIdKey(alias));
      }
    }
  }

  const indices = new Set<number>();
  dataset.players.forEach((name, idx) => {
    if (matchingKeys.has(normalizePlayerIdKey(name))) {
      indices.add(idx);
    }
  });
  return indices;
}

function buildAnonymizedQuestion(
  game: ReplayGame,
  seat: number,
  action: ReplayQuizAction,
  point: DecisionPoint,
  index: number,
  extra: Partial<Pick<
    ReplayQuizQuestion,
    | 'currentAttempt'
    | 'proposedTeamSeats'
    | 'requiredTeamSize'
    | 'validTargetSeats'
    | 'inspectedTargetSeat'
    | 'inspectedTargetLabel'
    | 'inspectedResult'
  >> = {},
): ReplayQuizQuestion {
  const obs = buildReplayObservation(game, seat, point);
  const seats: ReplayQuizSeatInfo[] = Array.from({ length: game.playerCount }, (_, i) => ({
    seat: i + 1,
    label: seatLabel(i + 1),
  }));

  const voteHistory: ReplayQuizVoteHistoryItem[] = obs.voteHistory.map((v, idx) => {
    const rawProposal = game.proposals[idx];
    const forced = rawProposal?.forced ?? v.attempt === 5;
    const approveSeats: number[] = [];
    const rejectSeats: number[] = [];
    for (let s = 1; s <= game.playerCount; s++) {
      if (v.votes[`P${s}`]) approveSeats.push(s);
      else rejectSeats.push(s);
    }
    const leaderSeat = seatOfId(v.leader);
    return {
      round: v.round,
      attempt: v.attempt,
      leaderSeat,
      leaderLabel: seatLabel(leaderSeat),
      teamSeats: v.team.map(seatOfId),
      approved: v.approved,
      forced,
      approveSeats,
      rejectSeats,
    };
  });

  const questHistory: ReplayQuizQuestHistoryItem[] = obs.questHistory.map((q) => ({
    round: q.round,
    teamSeats: q.team.map(seatOfId),
    result: q.result,
    failCount: q.failCount,
  }));

  const lakeHistory: ReplayQuizLakeHistoryItem[] = (obs.lakeHistory ?? []).map((l) => {
    const holderSeat = seatOfId(l.holderId);
    const targetSeat = seatOfId(l.targetId);
    return {
      round: l.round,
      holderSeat,
      holderLabel: seatLabel(holderSeat),
      targetSeat,
      targetLabel: seatLabel(targetSeat),
      declaredClaim: l.declaredClaim,
    };
  });

  const allEvilSeats = obs.allEvilIds ? obs.allEvilIds.map(seatOfId) : undefined;
  const allEvilRoles = obs.allEvilRoles
    ? Object.fromEntries(Object.entries(obs.allEvilRoles).map(([pid, r]) => [seatOfId(pid), r]))
    : undefined;

  const vision: ReplayQuizVision = {
    knownEvils: obs.knownEvils.map(seatOfId),
    ...(obs.knownWizards ? { knownWizards: obs.knownWizards.map(seatOfId) } : {}),
    ...(allEvilSeats ? { allEvilSeats } : {}),
    ...(allEvilRoles ? { allEvilRoles } : {}),
    myLakeResults: (obs.myLakeResults ?? []).map((r) => {
      const targetSeat = seatOfId(r.targetId);
      return {
        round: r.round,
        targetSeat,
        targetLabel: seatLabel(targetSeat),
        result: r.result,
      };
    }),
  };

  const currentLeaderSeat = seatOfId(obs.currentLeader);

  return {
    questionId: makeQuestionId(game.id, seat, action, index),
    action,
    mySeat: seat,
    mySeatLabel: seatLabel(seat),
    myRole: obs.myRole,
    myTeam: obs.myTeam,
    playerCount: obs.playerCount,
    seats,
    evilCount: obs.evilCount ?? game.seatRoles.filter((r) => EVIL_ROLES.has(r)).length,
    currentRound: obs.currentRound,
    currentLeaderSeat,
    currentLeaderLabel: seatLabel(currentLeaderSeat),
    ...extra,
    vision,
    questHistory,
    voteHistory,
    lakeHistory,
  };
}

/** 從單一歷史對局中抽出該玩家座位的全部關鍵決策題目（派隊／投票／選湖／湖中宣告／刺殺）。 */
export function extractDecisionItemsForSeat(
  game: ReplayGame,
  seat: number,
  meta: { gameDate: string; playerId: string; source: number },
): InternalQuizItem[] {
  const items: InternalQuizItem[] = [];
  const config = AVALON_CONFIG[game.playerCount];
  const myRole = game.seatRoles[seat - 1];

  // 1. 派隊 & 2. 投票
  game.proposals.forEach((p, pIdx) => {
    if (p.leaderSeat === seat) {
      const requiredTeamSize = config.questTeams[p.round - 1];
      const question = buildAnonymizedQuestion(
        game,
        seat,
        'team',
        { kind: 'team_select', proposal: pIdx },
        pIdx,
        {
          currentAttempt: p.attempt,
          requiredTeamSize,
        },
      );
      items.push({
        question,
        actualAnswer: [...p.teamSeats].sort((a, b) => a - b),
        gameId: game.id,
        gameDate: meta.gameDate,
        playerId: meta.playerId,
      });
    }

    if (!p.forced && p.votesReliable) {
      const question = buildAnonymizedQuestion(
        game,
        seat,
        'vote',
        { kind: 'team_vote', proposal: pIdx },
        pIdx,
        {
          currentAttempt: p.attempt,
          proposedTeamSeats: [...p.teamSeats],
        },
      );
      items.push({
        question,
        actualAnswer: Boolean(p.votes[seat - 1]),
        gameId: game.id,
        gameDate: meta.gameDate,
        playerId: meta.playerId,
      });
    }
  });

  // 3. 選湖 & 4. 湖中宣告
  if (game.lakeChainValid && game.lakes.length > 0) {
    const firstHolder = meta.source === 0 ? FIRST_LAKE_HOLDER_SEAT : game.lakes[0].holderSeat;
    game.lakes.forEach((lake, lIdx) => {
      if (lake.holderSeat !== seat) return;

      const validTargets = validLakeTargetSeats(game, lIdx, firstHolder);
      if (validTargets.includes(lake.targetSeat)) {
        const question = buildAnonymizedQuestion(
          game,
          seat,
          'lakeTarget',
          { kind: 'lake', lake: lIdx },
          lIdx,
          { validTargetSeats: validTargets },
        );
        items.push({
          question,
          actualAnswer: lake.targetSeat,
          gameId: game.id,
          gameDate: meta.gameDate,
          playerId: meta.playerId,
        });
      }

      if (lake.claim !== null) {
        const inspectedResult = campOf(game.seatRoles[lake.targetSeat - 1]);
        const question = buildAnonymizedQuestion(
          game,
          seat,
          'lakeClaim',
          { kind: 'lake', lake: lIdx },
          lIdx,
          {
            inspectedTargetSeat: lake.targetSeat,
            inspectedTargetLabel: seatLabel(lake.targetSeat),
            inspectedResult,
          },
        );
        items.push({
          question,
          actualAnswer: lake.claim,
          gameId: game.id,
          gameDate: meta.gameDate,
          playerId: meta.playerId,
        });
      }
    });
  }

  // 5. 刺殺
  if (game.assassinTargetSeat !== undefined && isAssassinator(myRole, game.seatRoles)) {
    const validTargetSeats = Array.from({ length: game.playerCount }, (_, i) => i + 1)
      .filter((s) => !EVIL_ROLES.has(game.seatRoles[s - 1]));
    if (validTargetSeats.includes(game.assassinTargetSeat)) {
      const question = buildAnonymizedQuestion(
        game,
        seat,
        'assassinate',
        { kind: 'assassination' },
        0,
        { validTargetSeats },
      );
      items.push({
        question,
        actualAnswer: game.assassinTargetSeat,
        gameId: game.id,
        gameDate: meta.gameDate,
        playerId: meta.playerId,
      });
    }
  }

  return items;
}

/** 從整個 `games_cache.json` 建立指定玩家「超過 30 天」歷史局的測驗題庫。 */
export function buildQuizPoolFromDataset(
  dataset: ReplayQuizDataset,
  playerId: string,
  options: { now?: Date; minAgeDays?: number } = {},
): InternalQuizItem[] {
  const now = options.now ?? new Date();
  const minAgeDays = options.minAgeDays ?? REPLAY_QUIZ_MIN_AGE_DAYS;
  const playerIndices = resolvePlayerIndicesInDataset(dataset, playerId);
  if (playerIndices.size === 0) return [];

  const catAt = dataset.fields.indexOf('cat');
  const seatsAt = dataset.fields.indexOf('seats');
  const dateAt = dataset.fields.indexOf('date');
  if (seatsAt < 0 || dateAt < 0) return [];

  const pool: InternalQuizItem[] = [];
  for (const row of dataset.games) {
    if (catAt >= 0 && dataset.vocab.category?.[row[catAt] as number] === BOT_GAME_CATEGORY) {
      continue;
    }
    const rawDate = typeof row[dateAt] === 'string' ? (row[dateAt] as string) : '';
    if (!isGameOlderThanDays(rawDate, now, minAgeDays)) {
      continue;
    }
    const seats = row[seatsAt];
    if (!Array.isArray(seats) || seats.length !== 10) continue;

    const seatIdx = seats.findIndex((idx) => typeof idx === 'number' && playerIndices.has(idx));
    if (seatIdx < 0) continue;

    const parsed = replayGameFromDataset(row, dataset);
    if (!parsed.ok) continue;

    const seat = seatIdx + 1;
    const extracted = extractDecisionItemsForSeat(parsed.value.game, seat, {
      gameDate: parsed.value.date,
      playerId,
      source: parsed.value.source,
    });
    pool.push(...extracted);
  }

  return pool;
}

/** 計算逐動作與整體一致比例統計。 */
export function computeReplayQuizStats(records: readonly ReplayQuizAnswerRecord[]): ReplayQuizStats {
  const byAction = {} as Record<ReplayQuizAction, ActionAgreementStat>;
  for (const action of REPLAY_QUIZ_ACTIONS) {
    byAction[action] = { answered: 0, matched: 0, rate: null };
  }

  let totalAnswered = 0;
  let totalMatched = 0;
  for (const r of records) {
    if (!isValidQuizAction(r.action)) continue;
    totalAnswered += 1;
    if (r.matched) totalMatched += 1;
    const cell = byAction[r.action];
    cell.answered += 1;
    if (r.matched) cell.matched += 1;
  }

  for (const action of REPLAY_QUIZ_ACTIONS) {
    const cell = byAction[action];
    cell.rate = cell.answered > 0 ? cell.matched / cell.answered : null;
  }

  return {
    overall: {
      answered: totalAnswered,
      matched: totalMatched,
      rate: totalAnswered > 0 ? totalMatched / totalAnswered : null,
    },
    byAction,
  };
}

/** 驗證前端送出的答案格式並與歷史真實選擇比對。 */
export function validateAndCompareAnswer(
  item: InternalQuizItem,
  rawAnswer: unknown,
): { ok: true; normalized: ReplayQuizAnswerValue; matched: boolean } | { ok: false; error: string } {
  const { question, actualAnswer } = item;

  switch (question.action) {
    case 'team': {
      if (!Array.isArray(rawAnswer)) {
        return { ok: false, error: '派隊答案必須是座位數字陣列' };
      }
      const seats: number[] = [];
      for (const v of rawAnswer) {
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > question.playerCount) {
          return { ok: false, error: `座位必須是 1 到 ${question.playerCount} 的整數` };
        }
        seats.push(v);
      }
      const unique = [...new Set(seats)].sort((a, b) => a - b);
      if (unique.length !== seats.length) {
        return { ok: false, error: '隊伍中不能重複選擇同一座位' };
      }
      const required = question.requiredTeamSize ?? 0;
      if (unique.length !== required) {
        return { ok: false, error: `本回合需要派出剛好 ${required} 位隊員（目前選了 ${unique.length} 位）` };
      }
      const actual = [...(actualAnswer as number[])].sort((a, b) => a - b);
      const matched = unique.length === actual.length && unique.every((s, i) => s === actual[i]);
      return { ok: true, normalized: unique, matched };
    }

    case 'vote': {
      if (typeof rawAnswer !== 'boolean') {
        return { ok: false, error: '投票答案必須是布林值（true 贊成／false 反對）' };
      }
      return { ok: true, normalized: rawAnswer, matched: rawAnswer === actualAnswer };
    }

    case 'lakeTarget':
    case 'assassinate': {
      if (typeof rawAnswer !== 'number' || !Number.isInteger(rawAnswer)) {
        return { ok: false, error: '目標座位必須是整數' };
      }
      const valid = question.validTargetSeats ?? [];
      if (!valid.includes(rawAnswer)) {
        return { ok: false, error: `${seatLabel(rawAnswer)} 不是此局面的合法目標` };
      }
      return { ok: true, normalized: rawAnswer, matched: rawAnswer === actualAnswer };
    }

    case 'lakeClaim': {
      if (rawAnswer !== 'good' && rawAnswer !== 'evil') {
        return { ok: false, error: '湖中宣告答案必須是 good（藍方）或 evil（紅方）' };
      }
      return { ok: true, normalized: rawAnswer, matched: rawAnswer === actualAnswer };
    }
  }
}

function sanitizeOptionalReason(raw: unknown): { ok: true; reason?: string } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === '') return { ok: true };
  if (typeof raw !== 'string') return { ok: false, error: '理由文字必須是字串' };
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true };
  if ([...trimmed].length > REPLAY_QUIZ_REASON_MAX) {
    return { ok: false, error: `理由最多 ${REPLAY_QUIZ_REASON_MAX} 個字` };
  }
  if (INVISIBLE_RE.test(trimmed.replace(/\r?\n/g, ''))) {
    return { ok: false, error: '理由不能包含控制或不可見字元' };
  }
  return { ok: true, reason: trimmed };
}

// ── 私人儲存（沿用 GitHubJsonFile + GITHUB_ACCOUNTS_*，不新增環境變數）──────

export function emptyReplayQuizState(): ReplayQuizState {
  return {
    version: REPLAY_QUIZ_VERSION,
    updatedAt: new Date(0).toISOString(),
    answers: [],
  };
}

export function normalizeReplayQuizState(raw: unknown): ReplayQuizState {
  const s = emptyReplayQuizState();
  if (!isPlainObject(raw)) return s;
  if (typeof raw.updatedAt === 'string') s.updatedAt = raw.updatedAt;
  if (Array.isArray(raw.answers)) {
    for (const item of raw.answers) {
      if (!isPlainObject(item)) continue;
      if (
        typeof item.id === 'string' &&
        typeof item.questionId === 'string' &&
        typeof item.gameId === 'string' &&
        typeof item.playerId === 'string' &&
        typeof item.adminEmail === 'string' &&
        typeof item.uid === 'string' &&
        typeof item.seat === 'number' &&
        typeof item.role === 'string' &&
        isValidQuizAction(item.action) &&
        typeof item.matched === 'boolean' &&
        typeof item.answeredAt === 'string'
      ) {
        s.answers.push({
          id: item.id,
          questionId: item.questionId,
          gameId: item.gameId,
          gameDate: typeof item.gameDate === 'string' ? item.gameDate : '',
          playerId: item.playerId,
          adminEmail: item.adminEmail,
          uid: item.uid,
          seat: item.seat,
          role: item.role as Role,
          action: item.action,
          userAnswer: item.userAnswer as ReplayQuizAnswerValue,
          actualAnswer: item.actualAnswer as ReplayQuizAnswerValue,
          matched: item.matched,
          ...(typeof item.reason === 'string' && item.reason ? { reason: item.reason } : {}),
          answeredAt: item.answeredAt,
        });
      }
    }
  }
  return s;
}

export function mergeReplayQuizStates(base: ReplayQuizState, mine: ReplayQuizState): ReplayQuizState {
  const byId = new Map<string, ReplayQuizAnswerRecord>();
  for (const a of base.answers) byId.set(a.id, a);
  for (const a of mine.answers) byId.set(a.id, a);
  const answers = [...byId.values()].sort((a, b) => (a.answeredAt < b.answeredAt ? -1 : a.answeredAt > b.answeredAt ? 1 : 0));
  return {
    version: REPLAY_QUIZ_VERSION,
    updatedAt: base.updatedAt > mine.updatedAt ? base.updatedAt : mine.updatedAt,
    answers,
  };
}

/** 沿用既有 `GITHUB_ACCOUNTS_*`（不新增環境變數），存到 private repo 的 `bot-state/replay-quiz.json`。 */
export function replayQuizRepoConfig(env: NodeJS.ProcessEnv = process.env): ConceptStateRepoConfig | null {
  const token = (env.GITHUB_ACCOUNTS_TOKEN || '').trim();
  const repo = (env.GITHUB_ACCOUNTS_REPO || '').trim();
  if (!token || !/^[^/\s]+\/[^/\s]+$/.test(repo)) return null;
  return {
    token,
    repo,
    branch: (env.GITHUB_ACCOUNTS_BRANCH || 'main').trim(),
    path: REPLAY_QUIZ_PATH,
    api: (env.GITHUB_API_BASE || 'https://api.github.com').trim(),
  };
}

export interface ReplayQuizBackend {
  readonly name: string;
  load(): Promise<{ state: ReplayQuizState; version: string | null } | null>;
  save(state: ReplayQuizState, version: string | null): Promise<{ ok: true; version: string | null } | { ok: false; conflict: boolean }>;
}

export class MemoryReplayQuizBackend implements ReplayQuizBackend {
  readonly name = 'memory';
  private raw: string | null = null;
  private v = 0;

  async load(): Promise<{ state: ReplayQuizState; version: string | null } | null> {
    if (!this.raw) return null;
    return { state: normalizeReplayQuizState(JSON.parse(this.raw)), version: String(this.v) };
  }

  async save(state: ReplayQuizState, version: string | null): Promise<{ ok: true; version: string } | { ok: false; conflict: boolean }> {
    if (this.raw !== null && version !== String(this.v)) return { ok: false, conflict: true };
    this.raw = JSON.stringify(state);
    this.v += 1;
    return { ok: true, version: String(this.v) };
  }
}

export class GitHubReplayQuizBackend implements ReplayQuizBackend {
  readonly name = 'github';
  private readonly file: GitHubJsonFile;

  constructor(cfg: ConceptStateRepoConfig, fetchImpl: typeof fetch = fetch, timeoutMs = 8_000) {
    this.file = new GitHubJsonFile(cfg, fetchImpl, timeoutMs);
  }

  async load(): Promise<{ state: ReplayQuizState; version: string | null } | null> {
    const got = await this.file.read();
    return got ? { state: normalizeReplayQuizState(got.json), version: got.sha } : null;
  }

  async save(state: ReplayQuizState, version: string | null): Promise<{ ok: true; version: string | null } | { ok: false; conflict: boolean }> {
    const res = await this.file.write(
      `${JSON.stringify(state, null, 2)}\n`,
      `bot-state: replay quiz ${state.updatedAt.slice(0, 10)}`,
      version,
    );
    return res.ok ? { ok: true, version: res.sha } : res;
  }
}

export class ReplayQuizStore {
  private state: ReplayQuizState = emptyReplayQuizState();
  private version: string | null = null;
  private loading: Promise<void> | null = null;
  private writing: Promise<void> = Promise.resolve();
  private dirty = false;

  constructor(
    readonly backend: ReplayQuizBackend,
    private readonly logger: { warn: (m: string) => void } = { warn: (m) => console.warn(`[replay-quiz] ${m}`) },
  ) {}

  ready(): Promise<void> {
    this.loading ??= (async (): Promise<void> => {
      try {
        const got = await this.backend.load();
        if (got) {
          this.state = mergeReplayQuizStates(got.state, this.state);
          this.version = got.version;
        }
      } catch (err) {
        this.logger.warn(`loading state from ${this.backend.name} failed (${err instanceof Error ? err.message.slice(0, 80) : typeof err})`);
      }
    })();
    return this.loading;
  }

  getAnswers(playerId?: string): ReplayQuizAnswerRecord[] {
    if (!playerId) return [...this.state.answers];
    const key = normalizePlayerIdKey(playerId);
    return this.state.answers.filter((a) => normalizePlayerIdKey(a.playerId) === key);
  }

  async appendAnswer(record: ReplayQuizAnswerRecord): Promise<void> {
    await this.ready();
    await this.mutate((s) => {
      s.answers.push(record);
      s.updatedAt = record.answeredAt;
    });
  }

  private mutate(fn: (s: ReplayQuizState) => void): Promise<void> {
    fn(this.state);
    this.dirty = true;
    this.writing = this.writing.then(() => this.flush());
    return this.writing;
  }

  private async flush(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await this.backend.save(this.state, this.version);
        if (res.ok) {
          this.version = res.version;
          return;
        }
        if (!res.conflict) break;
        const fresh = await this.backend.load();
        if (fresh) {
          this.state = mergeReplayQuizStates(fresh.state, this.state);
          this.version = fresh.version;
        } else {
          this.version = null;
        }
      } catch (err) {
        this.logger.warn(`saving state to ${this.backend.name} failed (${err instanceof Error ? err.message.slice(0, 80) : typeof err})`);
        break;
      }
    }
    this.dirty = true;
  }
}

// ── 主服務（題庫快取 + 出題 + 作答紀錄 + 統計）─────────────────────────────

export interface ReplayQuizServiceDeps {
  store?: ReplayQuizStore;
  loadDataset?: () => ReplayQuizDataset | null;
  now?: () => Date;
  random?: () => number;
}

export function loadDefaultGamesDataset(): ReplayQuizDataset | null {
  const filePath = path.resolve(
    process.env[ENV_GAMES_DATASET]?.trim() || path.join(__dirname, '..', '..', 'games_cache.json'),
  );
  if (!fs.existsSync(filePath)) return null;
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as ReplayQuizDataset;
  if (!raw || !Array.isArray(raw.games) || !Array.isArray(raw.fields) || !Array.isArray(raw.players)) {
    return null;
  }
  return raw;
}

export class ReplayQuizService {
  readonly store: ReplayQuizStore;
  private readonly loadDataset: () => ReplayQuizDataset | null;
  private readonly now: () => Date;
  private readonly random: () => number;
  private datasetCache: ReplayQuizDataset | null | undefined = undefined;
  private poolCache = new Map<string, { dayKey: string; items: InternalQuizItem[]; byId: Map<string, InternalQuizItem> }>();

  constructor(deps: ReplayQuizServiceDeps = {}) {
    this.store = deps.store ?? getReplayQuizStore();
    this.loadDataset = deps.loadDataset ?? loadDefaultGamesDataset;
    this.now = deps.now ?? (() => new Date());
    this.random = deps.random ?? Math.random;
  }

  private getDataset(): ReplayQuizDataset | null {
    if (this.datasetCache === undefined) {
      this.datasetCache = this.loadDataset();
    }
    return this.datasetCache;
  }

  private getPool(playerId: string): { items: InternalQuizItem[]; byId: Map<string, InternalQuizItem> } {
    const key = normalizePlayerIdKey(playerId);
    const currentNow = this.now();
    const dayKey = currentNow.toISOString().slice(0, 10);
    const cached = this.poolCache.get(key);
    if (cached && cached.dayKey === dayKey) {
      return cached;
    }

    const dataset = this.getDataset();
    const items = dataset ? buildQuizPoolFromDataset(dataset, playerId, { now: currentNow }) : [];
    const byId = new Map<string, InternalQuizItem>();
    for (const item of items) {
      byId.set(item.question.questionId, item);
    }
    const entry = { dayKey, items, byId };
    this.poolCache.set(key, entry);
    return entry;
  }

  async getNextQuestion(params: {
    playerId: string;
    action?: ReplayQuizAction;
  }): Promise<{
    playerId: string;
    poolSize: number;
    remainingCount: number;
    question: ReplayQuizQuestion | null;
    stats: ReplayQuizStats;
  }> {
    await this.store.ready();
    const pool = this.getPool(params.playerId);
    const answers = this.store.getAnswers(params.playerId);
    const answeredIds = new Set(answers.map((a) => a.questionId));

    const filteredPool = params.action
      ? pool.items.filter((item) => item.question.action === params.action)
      : pool.items;
    const remaining = filteredPool.filter((item) => !answeredIds.has(item.question.questionId));

    let chosen: ReplayQuizQuestion | null = null;
    if (remaining.length > 0) {
      const idx = Math.min(remaining.length - 1, Math.floor(this.random() * remaining.length));
      chosen = remaining[idx].question;
    }

    return {
      playerId: params.playerId,
      poolSize: filteredPool.length,
      remainingCount: remaining.length,
      question: chosen,
      stats: computeReplayQuizStats(answers),
    };
  }

  async submitAnswer(params: {
    playerId: string;
    uid: string;
    adminEmail: string;
    questionId: string;
    answer: unknown;
    reason?: unknown;
  }): Promise<ReplayQuizSubmitOutcome> {
    await this.store.ready();
    const pool = this.getPool(params.playerId);
    const item = pool.byId.get(params.questionId);
    if (!item) {
      return { ok: false, code: 'question_not_found', error: '找不到對應的題目（可能不屬於目前玩家或題目 ID 無效）' };
    }

    const checked = validateAndCompareAnswer(item, params.answer);
    if (!checked.ok) {
      return { ok: false, code: 'invalid_answer', error: checked.error };
    }

    const reasonChecked = sanitizeOptionalReason(params.reason);
    if (!reasonChecked.ok) {
      return { ok: false, code: 'invalid_reason', error: reasonChecked.error };
    }

    const nowIso = this.now().toISOString();
    const record: ReplayQuizAnswerRecord = {
      id: `rq_${Date.now()}_${randomBytes(4).toString('hex')}`,
      questionId: item.question.questionId,
      gameId: item.gameId,
      gameDate: item.gameDate,
      playerId: params.playerId,
      adminEmail: params.adminEmail,
      uid: params.uid,
      seat: item.question.mySeat,
      role: item.question.myRole,
      action: item.question.action,
      userAnswer: checked.normalized,
      actualAnswer: item.actualAnswer,
      matched: checked.matched,
      ...(reasonChecked.reason ? { reason: reasonChecked.reason } : {}),
      answeredAt: nowIso,
    };

    await this.store.appendAnswer(record);
    const answers = this.store.getAnswers(params.playerId);
    return {
      ok: true,
      record,
      matched: checked.matched,
      actualAnswer: item.actualAnswer,
      actualAnswerLabel: formatAnswerLabel(item.question.action, item.actualAnswer),
      userAnswerLabel: formatAnswerLabel(item.question.action, checked.normalized),
      gameDate: item.gameDate,
      stats: computeReplayQuizStats(answers),
    };
  }

  async getStats(params: { playerId: string; recentLimit?: number }): Promise<{
    playerId: string;
    poolSize: number;
    remainingCount: number;
    stats: ReplayQuizStats;
    recent: Array<{
      id: string;
      questionId: string;
      gameDate: string;
      seat: number;
      seatLabel: string;
      role: Role;
      action: ReplayQuizAction;
      userAnswerLabel: string;
      actualAnswerLabel: string;
      matched: boolean;
      reason?: string;
      answeredAt: string;
    }>;
  }> {
    await this.store.ready();
    const pool = this.getPool(params.playerId);
    const answers = this.store.getAnswers(params.playerId);
    const answeredIds = new Set(answers.map((a) => a.questionId));
    const remainingCount = pool.items.filter((item) => !answeredIds.has(item.question.questionId)).length;
    const limit = Math.max(1, Math.min(100, params.recentLimit ?? 20));

    const recent = [...answers]
      .sort((a, b) => (a.answeredAt < b.answeredAt ? 1 : a.answeredAt > b.answeredAt ? -1 : 0))
      .slice(0, limit)
      .map((r) => ({
        id: r.id,
        questionId: r.questionId,
        gameDate: r.gameDate,
        seat: r.seat,
        seatLabel: seatLabel(r.seat),
        role: r.role,
        action: r.action,
        userAnswerLabel: formatAnswerLabel(r.action, r.userAnswer),
        actualAnswerLabel: formatAnswerLabel(r.action, r.actualAnswer),
        matched: r.matched,
        ...(r.reason ? { reason: r.reason } : {}),
        answeredAt: r.answeredAt,
      }));

    return {
      playerId: params.playerId,
      poolSize: pool.items.length,
      remainingCount,
      stats: computeReplayQuizStats(answers),
      recent,
    };
  }
}

let storeSingleton: ReplayQuizStore | null = null;

export function getReplayQuizStore(): ReplayQuizStore {
  if (!storeSingleton) {
    const cfg = replayQuizRepoConfig();
    const backend: ReplayQuizBackend = cfg
      ? new GitHubReplayQuizBackend(cfg)
      : new MemoryReplayQuizBackend();
    if (!cfg) {
      console.warn('[replay-quiz] GITHUB_ACCOUNTS_REPO/TOKEN not set; using in-memory store');
    }
    storeSingleton = new ReplayQuizStore(backend);
  }
  return storeSingleton;
}

let serviceSingleton: ReplayQuizService | null = null;

export function getReplayQuizService(): ReplayQuizService {
  if (!serviceSingleton) {
    serviceSingleton = new ReplayQuizService({ store: getReplayQuizStore() });
  }
  return serviceSingleton;
}
