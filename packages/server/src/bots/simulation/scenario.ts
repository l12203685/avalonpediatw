/**
 * 模擬瓦（2026-10-14）— 題目：題號、選題、視角、公開事件，純函式。
 *
 * 一題 = 某一局的某一家在某一次派票的當下：你坐在那個位置、拿那個角色和那個角色的資訊，
 * 看到目前為止的派票，自己派一次，再看你的派票放出了什麼資訊，最後公布角色。
 *   - 1～5 家的第一個決定是第 1 局自己那一次派票（1-5 強制那次也算，就是「5 家怎麼派」）；
 *   - 6～0 家的第一個決定是第 2 局自己那一次（第 1 局任務結果已經出來）；
 *   - 之後 /下一步 走到同一家下一次當隊長。
 * 1 家第 1 局前面沒有別人的派票，是純「釋放」練習，只有指定 1 家時才出。
 *
 * 視角照正式機器人（`roleKnowledge()`）：梅林看到莫德雷德以外的紅（拇指）；派西看到兩根拇指
 * （一梅林一莫甘娜，照座位排，看不出誰是誰）；刺客、莫甘娜、莫德雷德互相看到座位、看不到奧伯倫；
 * 奧伯倫誰都看不到；忠臣沒有資訊。
 */

import type { Role } from '@avalon/shared';
import { AVALON_CONFIG } from '@avalon/shared';
import { EVIL_ROLES, type ReplayGame, type ReplayLake } from '../../ai/benchmark/sheetsReplay';
import { roleKnowledge, seatOfId } from '../../ai/benchmark/replayObservation';
import type { SimRoleChoice } from './commands';
import { SIM_THIN_POOL_MIN } from './config';
import { seatChar, sortSeats } from './seats';

/** 題庫裡的一局：解析後的對局，沒有名字。 */
export type SimGame = Omit<ReplayGame, 'names'>;

export const TEAM_SIZES: readonly number[] = AVALON_CONFIG[10].questTeams;
export const FAILS_REQUIRED: readonly number[] = AVALON_CONFIG[10].questFailsRequired;

export const RED_ROLES: readonly Role[] = ['assassin', 'morgana', 'mordred', 'oberon'];
export const BLUE_ROLES: readonly Role[] = ['merlin', 'percival', 'loyal'];
export const SIM_ROLES: readonly Role[] = ['merlin', 'percival', 'loyal', 'assassin', 'morgana', 'mordred', 'oberon'];

/** 隨機題預設出的座位（owner D7 預設：第 1 局 2～5 家，像百科的模擬題）。 */
export const DEFAULT_SEATS: readonly number[] = [2, 3, 4, 5];

export function isRed(role: Role): boolean {
  return EVIL_ROLES.has(role);
}

// ─── 視角 ─────────────────────────────────────────────────────────────────

export type Sight =
  | { kind: 'loyal' }
  /** 梅林看到的紅（莫德雷德除外）。 */
  | { kind: 'merlin'; seen: number[] }
  /** 派西的兩根拇指（一梅林一莫甘娜），照座位排。 */
  | { kind: 'percival'; thumbs: number[] }
  /** 刺客／莫甘娜／莫德雷德看到的隊友座位（不含奧伯倫）。 */
  | { kind: 'evil'; mates: number[] }
  | { kind: 'oberon' };

export function sightFor(game: Pick<SimGame, 'seatRoles' | 'playerCount'>, seat: number): Sight {
  const role = game.seatRoles[seat - 1];
  const k = roleKnowledge({ ...(game as SimGame), names: [] }, seat);
  const evils = sortSeats(k.knownEvils.map(seatOfId));
  switch (role) {
    case 'merlin':
      return { kind: 'merlin', seen: evils };
    case 'percival':
      return { kind: 'percival', thumbs: sortSeats((k.knownWizards ?? []).map(seatOfId)) };
    case 'oberon':
      return { kind: 'oberon' };
    case 'assassin':
    case 'morgana':
    case 'mordred':
      return { kind: 'evil', mates: evils };
    default:
      return { kind: 'loyal' };
  }
}

/** 這個角色看得到的座位（拇指／看到的紅／隊友），沒有就是空的。 */
export function sightSeats(sight: Sight): number[] {
  switch (sight.kind) {
    case 'merlin': return sight.seen;
    case 'percival': return sight.thumbs;
    case 'evil': return sight.mates;
    default: return [];
  }
}

// ─── 決定點 ───────────────────────────────────────────────────────────────

/** 這一家每一次當隊長的派票（proposals 的索引），照時間。 */
export function decisionsOf(game: SimGame, seat: number): number[] {
  return game.proposals.filter((p) => p.leaderSeat === seat).map((p) => p.globalIndex);
}

/** 這一家的第一個決定：1～5 家第 1 局、6～0 家第 2 局；沒有就是 null。 */
export function firstDecision(game: SimGame, seat: number): number | null {
  const round = seat <= 5 ? 1 : 2;
  const p = game.proposals.find((x) => x.round === round && x.leaderSeat === seat);
  return p ? p.globalIndex : null;
}

/** 同一家在 `after` 之後的下一次派票，沒有就是 null。 */
export function nextDecision(game: SimGame, seat: number, after: number): number | null {
  const p = game.proposals.find((x) => x.globalIndex > after && x.leaderSeat === seat);
  return p ? p.globalIndex : null;
}

// ─── 題號 ─────────────────────────────────────────────────────────────────

/** 題號 = 題庫代號-座位字元（第 10 家寫 0），例如 K7Q2M-4。 */
export function exerciseIdOf(gameId: string, seat: number): string {
  return `${gameId}-${seatChar(seat)}`;
}

export function splitExerciseId(id: string): { gameId: string; seat: number } | null {
  const m = /^([0-9A-Z]+)-([0-9])$/.exec(id);
  if (!m) return null;
  return { gameId: m[1], seat: m[2] === '0' ? 10 : Number(m[2]) };
}

// ─── 公開事件 ─────────────────────────────────────────────────────────────

export type PublicEvent =
  | {
    kind: 'proposal';
    index: number;
    round: number;
    attempt: number;
    leaderSeat: number;
    teamSeats: number[];
    plusSeats: number[];
    minusSeats: number[];
    forced: boolean;
    /** 這個隊伍出了任務。 */
    approved: boolean;
  }
  | { kind: 'quest'; round: number; teamSeats: number[]; successCount: number; failCount: number; failed: boolean }
  | { kind: 'lake'; index: number; round: number; holderSeat: number; targetSeat: number; claim: ReplayLake['claim'] };

/** 整局的公開事件，照發生順序：派票（含票）、任務、湖的宣告。 */
export function publicEvents(game: SimGame): PublicEvent[] {
  const out: PublicEvent[] = [];
  for (const p of game.proposals) {
    out.push({
      kind: 'proposal',
      index: p.globalIndex,
      round: p.round,
      attempt: p.attempt,
      leaderSeat: p.leaderSeat,
      teamSeats: sortSeats(p.teamSeats),
      plusSeats: sortSeats(p.plusSeats),
      minusSeats: sortSeats(p.minusSeats),
      forced: p.forced,
      approved: p.wentOnMission,
    });
    if (!p.wentOnMission) continue;
    const q = game.quests.find((x) => x.round === p.round);
    if (!q) continue;
    out.push({ kind: 'quest', round: q.round, teamSeats: sortSeats(q.teamSeats), successCount: q.successCount, failCount: q.failCount, failed: q.failed });
    game.lakes.forEach((l, i) => {
      if (l.round === q.round) {
        out.push({ kind: 'lake', index: i, round: l.round, holderSeat: l.holderSeat, targetSeat: l.targetSeat, claim: l.claim });
      }
    });
  }
  return out;
}

/** proposals[index] 在事件清單裡的位置（它之前的事件 = 當下看得到的）。 */
export function eventIndexOfProposal(events: readonly PublicEvent[], proposalIndex: number): number {
  const i = events.findIndex((e) => e.kind === 'proposal' && e.index === proposalIndex);
  return i < 0 ? events.length : i;
}

/** 某一家在當下（前 `cursor` 個事件）自己湖過的結果：真相，從角色來。 */
export interface OwnLake { targetSeat: number; evil: boolean }

/** 決定當下的視角：座位、角色、私人資訊、看得到的事件、自己湖到的真相。 */
export interface SimView {
  seat: number;
  role: Role;
  sight: Sight;
  events: PublicEvent[];
  ownLakes: OwnLake[];
}

export function viewAt(game: SimGame, seat: number, cursor: number, events: readonly PublicEvent[] = publicEvents(game)): SimView {
  const shown = events.slice(0, cursor);
  const ownLakes: OwnLake[] = [];
  for (const e of shown) {
    if (e.kind === 'lake' && e.holderSeat === seat) {
      ownLakes.push({ targetSeat: e.targetSeat, evil: isRed(game.seatRoles[e.targetSeat - 1]) });
    }
  }
  return { seat, role: game.seatRoles[seat - 1], sight: sightFor(game, seat), events: shown, ownLakes };
}

// ─── 選題 ─────────────────────────────────────────────────────────────────

export interface DecisionRef {
  /** 題庫 games[] 的索引。 */
  game: number;
  /** proposals[] 的索引。 */
  proposal: number;
}

/** 題目池：`角色:座位` → 那一家第一個決定的清單。 */
export type DecisionPool = ReadonlyMap<string, readonly DecisionRef[]>;

export function poolKey(role: Role, seat: number): string {
  return `${role}:${seat}`;
}

export function buildDecisionPool(games: readonly SimGame[]): Map<string, DecisionRef[]> {
  const pool = new Map<string, DecisionRef[]>();
  games.forEach((g, gi) => {
    for (let seat = 1; seat <= 10; seat++) {
      const d = firstDecision(g, seat);
      if (d === null) continue;
      const key = poolKey(g.seatRoles[seat - 1], seat);
      const list = pool.get(key) ?? [];
      list.push({ game: gi, proposal: d });
      pool.set(key, list);
    }
  });
  return pool;
}

export interface SelectRequest {
  role?: SimRoleChoice;
  seat?: number;
  exerciseId?: string;
}

export type SelectResult =
  | { ok: true; game: number; seat: number; decision: number }
  | { ok: false; reason: 'unknown-id' }
  | { ok: false; reason: 'no-decision'; seat: number }
  | { ok: false; reason: 'thin'; role: Role; seat: number; n: number; available: number[] }
  | { ok: false; reason: 'empty' };

function pick<T>(list: readonly T[], rng: () => number): T {
  return list[Math.min(list.length - 1, Math.floor(rng() * list.length))];
}

/**
 * 選一題。`rng` 是可重現的亂數（呼叫端用 seededRandom，種子 = 聊天室＋使用者＋時間）。
 * 指定角色＋座位但題目少於 SIM_THIN_POOL_MIN → 'thin'，附上這個角色題目夠的座位。
 */
export function selectExercise(
  bank: { games: readonly SimGame[]; byId: ReadonlyMap<string, number>; pool: DecisionPool },
  req: SelectRequest,
  rng: () => number,
): SelectResult {
  if (req.exerciseId) {
    const parts = splitExerciseId(req.exerciseId);
    const gi = parts ? bank.byId.get(parts.gameId) : undefined;
    if (!parts || gi === undefined) return { ok: false, reason: 'unknown-id' };
    const d = firstDecision(bank.games[gi], parts.seat);
    if (d === null) return { ok: false, reason: 'no-decision', seat: parts.seat };
    return { ok: true, game: gi, seat: parts.seat, decision: d };
  }

  let roles: readonly Role[];
  if (req.role === 'red') roles = [pick(RED_ROLES, rng)];
  else if (req.role === 'blue') roles = [pick(BLUE_ROLES, rng)];
  else if (req.role) roles = [req.role];
  else roles = SIM_ROLES;
  const seats = req.seat !== undefined ? [req.seat] : DEFAULT_SEATS;

  if (roles.length === 1 && req.seat !== undefined) {
    const list = bank.pool.get(poolKey(roles[0], req.seat)) ?? [];
    if (list.length < SIM_THIN_POOL_MIN) {
      const available = Array.from({ length: 10 }, (_, i) => i + 1)
        .filter((s) => (bank.pool.get(poolKey(roles[0], s))?.length ?? 0) >= SIM_THIN_POOL_MIN);
      return { ok: false, reason: 'thin', role: roles[0], seat: req.seat, n: list.length, available };
    }
  }

  const candidates: DecisionRef[] = [];
  for (const role of roles) {
    for (const seat of seats) candidates.push(...(bank.pool.get(poolKey(role, seat)) ?? []));
  }
  if (candidates.length === 0) return { ok: false, reason: 'empty' };
  const ref = pick(candidates, rng);
  const seat = bank.games[ref.game].proposals[ref.proposal].leaderSeat;
  return { ok: true, game: ref.game, seat, decision: ref.proposal };
}
