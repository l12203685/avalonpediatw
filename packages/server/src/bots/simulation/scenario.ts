/**
 * 模擬瓦（2026-10-14）— 題目：題號、選題、視角、公開事件，純函式。
 *
 * 一題 = 某一局的某一家在某一次派票的當下：你坐在那個位置、拿那個角色和那個角色的資訊，
 * 看到目前為止的派票，自己派一次，再看你的派票放出了什麼資訊，最後公布角色。
 *   - 1～5 家的第一個決定是第 1 局自己那一次派票（1-5 強制那次也算，就是「5 家怎麼派」）；
 *   - 6～0 家的第一個決定是第 2 局自己那一次（第 1 局任務結果已經出來）；
 *   - （/下一步 2026-11-17 拿掉：一題只作答這一個決定點。）
 * 1 家第 1 局前面沒有別人的派票，是純「釋放」練習，只有指定 1 家時才出。
 *
 * 2026-11-16（Edward：「我希望你模擬偶爾可以玩 2-5 或 3-5（藍紅或紅紅的 3-5）」「目前出題應該要可以像我本來 Threads 上
 * 想要出題的模式」）：除了「這一家的第一個決定」，也可以從指定的局面開始（坐在那一次的隊長位置）：
 *   - 1-5、2-5、3-5、4-5 = 那一局第 5 次派票（強制出發，尾派）；3-5 只出第 2 局任務失敗的局（藍紅或紅紅）；
 *   - 5局 = 第 5 局的任何一次派票（派 5 人）；
 *   - 刺殺 = 三藍、有刺殺的局，你是刺客（看得到紅方隊友＋整局公開紀錄），/刺 座位 作答；
 *   - 今天 = 照 Threads 的每週主題（台北日期，見 TODAY_THEMES）；
 *   - 只指定角色的 /模擬（沒有指定座位）偶爾出 2-5、3-5（各約 15%，見 SIM_MID_SHARE；什麼都沒指定的見 2026-11-19）；
 *   - 題號多一段：K7Q2M-3-5 = 第 3 局第 5 次開始（座位是那一次的隊長）；K7Q2M-A = 那一局的刺殺題；
 *     舊的 K7Q2M-4 照舊是 4 家的第一個決定。
 *
 * 2026-11-19（Edward：「你再給題目的時候 至少要篩選」「以後/模擬 沒指定情境(spot)的話 就抽選一局 你應該要可以判斷出
 * 該局最有價值最值得思考出題的幾個 spot」）：
 *   - 2-5 只出「第 1 局任務失敗」，或「第 1 局成功、但 2-1～2-4 至少兩個隊長不是派三加一」的局（round2TailWorthy；
 *     三加一 = 第 1 局出任務的 3 人＋另 1 人）；3-5 照舊只出第 2 局失敗的局（2-5 開藍時 3-1 多半照派，不值得出）；
 *   - 第四局不只 4-5：`/模擬 4局`、週六的今天主題、自動選題都是「第 4 局隨機一個當過隊長的忠臣」（Threads 的 round4）；
 *     `/模擬 4-5` 照舊是 4-5；
 *   - 沒有指定任何東西的 /模擬：抽一局、列出這局的 spot、照「值得想」打分數，從最高的那一個開始（spotValue.ts）。
 *     指定角色、座位、局面、題號、刺殺、今天的照舊。
 * 篩選寫在 midDecision 裡，模擬瓦的局面池和 Threads 的候選池（plan.ts tailPick）用同一個函式，兩邊一致。
 * 題庫只有真人實戰（試算表「牌譜」分頁；模擬的局不進題庫，見 bankCodec.buildBankFile）。
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

/** 從第幾局第幾次派票開始（2-5 = { round: 2, attempt: 5 }）。 */
export interface SimStage {
  round: number;
  attempt: number;
}

/** 可以指定的尾派局面：1-5、2-5、3-5、4-5。 */
export const TAIL_ROUNDS: readonly number[] = [1, 2, 3, 4];

/** 三加一：第 2 局的隊 = 第 1 局出任務的 3 人全在、再加 1 人（Edward 2026-11-19 的說法）。 */
export function isThreePlusOne(game: Pick<SimGame, 'quests'>, teamSeats: readonly number[]): boolean {
  const q1 = game.quests.find((q) => q.round === 1);
  if (!q1 || teamSeats.length !== q1.teamSeats.length + 1) return false;
  return q1.teamSeats.every((s) => teamSeats.includes(s));
}

/**
 * 2-5 值得出（Edward 2026-11-19：「2-5 要給 1-5 有開紅 或 1-5 開藍 但至少 兩個人不是派 三加一 的組合」）：
 * 第 1 局任務失敗；或成功、但第 2 局第 1～4 次的隊長裡至少兩個人派的不是三加一。
 * 「1-5」指第 1 局出任務的那一隊（通常是 1-5 強制出發；第 1 局提早出發的局照那一隊算）。
 */
export function round2TailWorthy(game: Pick<SimGame, 'quests' | 'proposals'>): boolean {
  const q1 = game.quests.find((q) => q.round === 1);
  if (!q1) return false;
  if (q1.failed) return true;
  const notThreePlusOne = game.proposals.filter((p) => p.round === 2 && p.attempt <= 4 && !isThreePlusOne(game, p.teamSeats)).length;
  return notThreePlusOne >= 2;
}

/** 第 2 局任務失敗（3-5 的條件）。 */
export function round3TailWorthy(game: Pick<SimGame, 'quests'>): boolean {
  return !!game.quests.find((q) => q.round === 2)?.failed;
}

/**
 * 這一局 `round` 局第 5 次派票（proposals 的索引），沒有或不值得出就是 null。
 * 2-5 照 round2TailWorthy 篩（2026-11-19）；3-5 只出第 2 局任務失敗的局（Edward 11/16：「藍紅或紅紅的 3-5」，
 * Threads 週四「第二局開紅、而且輪到 3-5 尾派」；11/19：「2-5開藍 3-1 高機率會照派」）。
 * 指定題號（K7Q2M-2-5）不經過這裡（stageDecision），照舊出。
 */
export function midDecision(game: SimGame, round: number): number | null {
  const p = game.proposals.find((x) => x.round === round && x.attempt === 5);
  if (!p) return null;
  if (round === 2 && !round2TailWorthy(game)) return null;
  if (round === 3 && !round3TailWorthy(game)) return null;
  return p.globalIndex;
}

/** 第 4 局忠臣當隊長的派票（任何一次，照時間；Edward 2026-11-19「隨機給一個第四局有派隊機會的忠臣」）。 */
export function round4LoyalDecisions(game: SimGame): number[] {
  return game.proposals.filter((p) => p.round === 4 && game.seatRoles[p.leaderSeat - 1] === 'loyal').map((p) => p.globalIndex);
}

/** 某一局某一次的派票（proposals 的索引），沒有就是 null。 */
export function stageDecision(game: SimGame, stage: SimStage): number | null {
  const p = game.proposals.find((x) => x.round === stage.round && x.attempt === stage.attempt);
  return p ? p.globalIndex : null;
}

/** 刺殺題：三藍、有刺殺、有刺客的局（題庫裡的座位）；不是就 null。 */
export function assassinSeat(game: SimGame): number | null {
  if (game.quests.filter((q) => !q.failed).length < 3 || game.assassinTargetSeat === undefined) return null;
  const i = game.seatRoles.indexOf('assassin');
  return i < 0 ? null : i + 1;
}

// ─── 題號 ─────────────────────────────────────────────────────────────────

/**
 * 題號 = 題庫代號-座位字元（0 家寫 0），例如 K7Q2M-4（4 家的第一個決定）；
 * 從某一局第幾次開始的題目 = 題庫代號-局-次，例如 K7Q2M-3-5（座位是那一次的隊長）；刺殺題 = 題庫代號-A。
 */
export function exerciseIdOf(gameId: string, seat: number, stage?: SimStage, assassin?: boolean): string {
  if (assassin) return `${gameId}-A`;
  return stage ? `${gameId}-${stage.round}-${stage.attempt}` : `${gameId}-${seatChar(seat)}`;
}

export function splitExerciseId(id: string): { gameId: string; seat?: number; stage?: SimStage; assassin?: boolean } | null {
  const killId = /^([0-9A-Z]+)-A$/.exec(id);
  if (killId) return { gameId: killId[1], assassin: true };
  const staged = /^([0-9A-Z]+)-([1-5])-([1-5])$/.exec(id);
  if (staged) return { gameId: staged[1], stage: { round: Number(staged[2]), attempt: Number(staged[3]) } };
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
    /**
     * 照「隊內贊成、隊外反對＋記號」重建的票跟結果對得上（解析器的 votesReliable）。
     * 舊紀錄常常沒記出發那次的記號；false 時回覆標「票沒記全」，不把重建的票當事實。
     */
    votesReliable: boolean;
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
      votesReliable: p.forced || p.votesReliable,
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

/**
 * 局面題目池：`局:角色` → 隊長是那個角色的派票。局 1～4 = 那一局第 5 次（尾派，2-5、3-5 有條件，見 midDecision）；
 * 局 5 = 第 5 局的每一次派票。`4局:角色` = 第 4 局的每一次派票（`/模擬 4局`；沒指定角色時只出忠臣）。
 * `派西:晚` / `派西:早` = 派西維爾當隊長的派票（第 2 局起／第 1 局，週二主題）。
 */
export function midPoolKey(round: number, role: Role, anyAttempt = false): string {
  return anyAttempt && round !== 5 ? `${round}局:${role}` : `${round}:${role}`;
}

export const PERCIVAL_LATE_KEY = '派西:晚';
export const PERCIVAL_EARLY_KEY = '派西:早';

export function buildMidPool(games: readonly SimGame[]): Map<string, DecisionRef[]> {
  const pool = new Map<string, DecisionRef[]>();
  const add = (key: string, ref: DecisionRef): void => {
    const list = pool.get(key) ?? [];
    list.push(ref);
    pool.set(key, list);
  };
  games.forEach((g, gi) => {
    for (const round of TAIL_ROUNDS) {
      const d = midDecision(g, round);
      if (d !== null) add(midPoolKey(round, g.seatRoles[g.proposals[d].leaderSeat - 1]), { game: gi, proposal: d });
    }
    for (const p of g.proposals) {
      const role = g.seatRoles[p.leaderSeat - 1];
      if (p.round === 5) add(midPoolKey(5, role), { game: gi, proposal: p.globalIndex });
      if (p.round === 4) add(midPoolKey(4, role, true), { game: gi, proposal: p.globalIndex });
      if (role === 'percival') add(p.round >= 2 ? PERCIVAL_LATE_KEY : PERCIVAL_EARLY_KEY, { game: gi, proposal: p.globalIndex });
    }
  });
  return pool;
}

/** 刺殺題的局（games[] 的索引）。 */
export function buildAssassinPool(games: readonly SimGame[]): number[] {
  return games.map((g, i) => (assassinSeat(g) !== null ? i : -1)).filter((i) => i >= 0);
}

/** 只指定角色的 /模擬（沒有座位、局面）出 2-5、3-5 的機率（各一份）；什麼都沒指定的 /模擬 改用 spotValue 選。 */
export const SIM_MID_SHARE = 0.15;

/**
 * Threads 的每週主題（Edward 2026-11-11 規劃、11/16「出題應該要可以像我本來 Threads 上想要出題的模式」）。
 * 星期照台北日期（0 = 週日）。週四、週六直接出後面那一題（3-5、4-5）：/下一步 2026-11-17 拿掉之後，模擬瓦不再從 1-5 走到 3-5。
 */
export type TodayTheme =
  | { day: number; label: string; kind: 'assassin' }
  | { day: number; label: string; kind: 'percival' }
  /**
   * `thenRound`：優先出「這一家下一次就是 thenRound 的尾派」的局；沒有這種局就改出 `fallback`（那一局的尾派）。
   * `anyAttempt`：那一局的任何一次（第 4 局 = 忠臣當隊長的任何一次，2026-11-19）。
   */
  | { day: number; label: string; kind: 'tail'; round: number; anyAttempt?: boolean; thenRound?: number; fallback?: { round: number; label: string } };

export const TODAY_THEMES: readonly TodayTheme[] = [
  { day: 0, label: '週日：第五局決策（派 5 人）', kind: 'tail', round: 5 },
  { day: 1, label: '週一：刺殺梅林', kind: 'assassin' },
  { day: 2, label: '週二：派西維爾思考', kind: 'percival' },
  { day: 3, label: '週三：1-5 尾派（派 3 人）', kind: 'tail', round: 1 },
  { day: 4, label: '週四：3-5 尾派（第二局開紅，派 4 人）', kind: 'tail', round: 3 },
  { day: 5, label: '週五：2-5 尾派', kind: 'tail', round: 2 },
  { day: 6, label: '週六：第四局忠臣派 5 人（要 2 張失敗）', kind: 'tail', round: 4, anyAttempt: true, fallback: { round: 2, label: '週六：2-5 尾派' } },
];

/** 台北日期的星期（0 = 週日）。 */
export function taipeiWeekday(now: number): number {
  return new Date(now + 8 * 60 * 60 * 1000).getUTCDay();
}

export interface SelectRequest {
  role?: SimRoleChoice;
  seat?: number;
  exerciseId?: string;
  /** 指定的局面：1～4 = 那一局第 5 次（尾派）；5 = 第 5 局的任何一次。 */
  midRound?: number;
  /** 跟 midRound 一起：那一局的任何一次（`/模擬 4局`；沒指定角色時只出忠臣當隊長的）。 */
  anyAttempt?: boolean;
  /** 刺殺題、今天的主題。 */
  special?: 'assassin' | 'today';
  /** `special: 'today'` 用的星期（台北，0 = 週日）。 */
  weekday?: number;
}

export type SelectResult =
  | {
    ok: true;
    game: number;
    seat: number;
    decision: number;
    stage?: SimStage;
    assassin?: boolean;
    theme?: string;
    /** 自動選 spot（什麼都沒指定的 /模擬）：同一局接下來值得想的 1～2 題（題號＋題型）。 */
    alsoWorth?: { exerciseId: string; label: string }[];
  }
  | { ok: false; reason: 'unknown-id' }
  | { ok: false; reason: 'no-decision'; seat: number }
  | { ok: false; reason: 'no-stage'; stage: SimStage }
  | { ok: false; reason: 'no-mid'; round: number; anyAttempt?: boolean }
  | { ok: false; reason: 'no-assassin' }
  | { ok: false; reason: 'thin'; role: Role; seat: number; n: number; available: number[] }
  | { ok: false; reason: 'empty' };

function pick<T>(list: readonly T[], rng: () => number): T {
  return list[Math.min(list.length - 1, Math.floor(rng() * list.length))];
}

/**
 * 選一題。`rng` 是可重現的亂數（呼叫端用 seededRandom，種子 = 聊天室＋使用者＋時間）。
 * 指定角色＋座位但題目少於 SIM_THIN_POOL_MIN → 'thin'，附上這個角色題目夠的座位。
 */
/**
 * 有網站牌譜紀錄連結的局優先（Edward 11/16：公布時「給牌局連結就好」）：對照表有東西、而且留下來的還有題目時
 * 只出有連結的；一題都沒有就照舊從全部出（指定題號不受影響）。
 */
function preferLinked(list: readonly DecisionRef[], linked: ReadonlyMap<number, string> | undefined): readonly DecisionRef[] {
  if (!linked || linked.size === 0) return list;
  const kept = list.filter((r) => linked.has(r.game));
  return kept.length > 0 ? kept : list;
}

export function selectExercise(
  bank: {
    games: readonly SimGame[];
    byId: ReadonlyMap<string, number>;
    pool: DecisionPool;
    midPool?: DecisionPool;
    assassinPool?: readonly number[];
    records?: ReadonlyMap<number, string>;
  },
  req: SelectRequest,
  rng: () => number,
): SelectResult {
  if (req.exerciseId) {
    const parts = splitExerciseId(req.exerciseId);
    const gi = parts ? bank.byId.get(parts.gameId) : undefined;
    if (!parts || gi === undefined) return { ok: false, reason: 'unknown-id' };
    const g = bank.games[gi];
    if (parts.assassin) {
      const seat = assassinSeat(g);
      if (seat === null) return { ok: false, reason: 'no-assassin' };
      return { ok: true, game: gi, seat, decision: g.proposals.length - 1, assassin: true };
    }
    if (parts.stage) {
      const d = stageDecision(g, parts.stage);
      if (d === null) return { ok: false, reason: 'no-stage', stage: parts.stage };
      return { ok: true, game: gi, seat: g.proposals[d].leaderSeat, decision: d, stage: parts.stage };
    }
    const seat = parts.seat as number;
    const d = firstDecision(g, seat);
    if (d === null) return { ok: false, reason: 'no-decision', seat };
    return { ok: true, game: gi, seat, decision: d };
  }

  const fromRef = (ref: DecisionRef, theme?: string): SelectResult => {
    const p = bank.games[ref.game].proposals[ref.proposal];
    return { ok: true, game: ref.game, seat: p.leaderSeat, decision: ref.proposal, stage: { round: p.round, attempt: p.attempt }, ...(theme ? { theme } : {}) };
  };
  const assassinPick = (theme?: string): SelectResult => {
    const linked = bank.assassinPool ?? [];
    const kept = bank.records && bank.records.size > 0 ? linked.filter((gi) => bank.records?.has(gi)) : linked;
    const list = kept.length > 0 ? kept : linked;
    if (list.length === 0) return { ok: false, reason: 'no-assassin' };
    const gi = pick(list, rng);
    const g = bank.games[gi];
    return { ok: true, game: gi, seat: assassinSeat(g) as number, decision: g.proposals.length - 1, assassin: true, ...(theme ? { theme } : {}) };
  };

  if (req.special === 'assassin') return assassinPick();

  let roles: readonly Role[];
  if (req.role === 'red') roles = [pick(RED_ROLES, rng)];
  else if (req.role === 'blue') roles = [pick(BLUE_ROLES, rng)];
  else if (req.role) roles = [req.role];
  else roles = SIM_ROLES;

  // 局面池（1-5～4-5、5局、4局）：角色、座位篩過。4局 沒指定角色時只出忠臣當隊長的（Edward 2026-11-19）。
  const midFrom = (round: number, anyAttempt = false): DecisionRef[] => {
    const list: DecisionRef[] = [];
    const wanted = anyAttempt && round !== 5 && !req.role ? (['loyal'] as const) : roles;
    for (const role of wanted) list.push(...(bank.midPool?.get(midPoolKey(round, role, anyAttempt)) ?? []));
    return req.seat !== undefined ? list.filter((r) => bank.games[r.game].proposals[r.proposal].leaderSeat === req.seat) : list;
  };

  if (req.special === 'today') {
    const theme = TODAY_THEMES.find((t) => t.day === (req.weekday ?? 0)) ?? TODAY_THEMES[0];
    if (theme.kind === 'assassin') return assassinPick(theme.label);
    if (theme.kind === 'percival') {
      const late = bank.midPool?.get(PERCIVAL_LATE_KEY) ?? [];
      const list = preferLinked(late.length > 0 ? late : bank.midPool?.get(PERCIVAL_EARLY_KEY) ?? [], bank.records);
      if (list.length === 0) return { ok: false, reason: 'empty' };
      return fromRef(pick(list, rng), theme.label);
    }
    let list: readonly DecisionRef[] = midFrom(theme.round, theme.anyAttempt);
    let label = theme.label;
    let round = theme.round;
    if (list.length === 0 && theme.fallback) {
      round = theme.fallback.round;
      label = theme.fallback.label;
      list = midFrom(round);
    } else if (theme.thenRound !== undefined) {
      // 這一家下一次當隊長就是下一個尾派；沒有這種局就改出 fallback 的尾派（目前沒有主題用 thenRound）。
      const then = theme.thenRound;
      const chained = list.filter((r) => {
        const g = bank.games[r.game];
        const next = nextDecision(g, g.proposals[r.proposal].leaderSeat, r.proposal);
        return next !== null && next === midDecision(g, then);
      });
      if (chained.length > 0) list = chained;
      else if (theme.fallback) {
        round = theme.fallback.round;
        label = theme.fallback.label;
        list = midFrom(round);
      }
    }
    list = preferLinked(list, bank.records);
    if (list.length === 0) return { ok: false, reason: 'no-mid', round };
    return fromRef(pick(list, rng), label);
  }

  // 2-5、3-5：隨機題（沒有指定座位）偶爾出。隨機的那一擲放在高的那一端（rng 0.70～1），
  // 測試固定 rng = 0 時照舊出第一個決定。
  let midRound = req.midRound;
  if (midRound === undefined && req.seat === undefined && bank.midPool) {
    const roll = rng();
    const wanted = roll >= 1 - SIM_MID_SHARE ? 3 : roll >= 1 - 2 * SIM_MID_SHARE ? 2 : undefined;
    if (wanted !== undefined && midFrom(wanted).length > 0) midRound = wanted;
  }
  if (midRound !== undefined) {
    const anyAttempt = midRound === req.midRound && !!req.anyAttempt;
    const list = preferLinked(midFrom(midRound, anyAttempt), bank.records);
    if (list.length === 0) return { ok: false, reason: 'no-mid', round: midRound, ...(anyAttempt ? { anyAttempt } : {}) };
    return fromRef(pick(list, rng));
  }

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
  const ref = pick(preferLinked(candidates, bank.records), rng);
  const seat = bank.games[ref.game].proposals[ref.proposal].leaderSeat;
  return { ok: true, game: ref.game, seat, decision: ref.proposal };
}
