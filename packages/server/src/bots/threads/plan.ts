/**
 * Threads 每日出題（2026-11-17）— 一週的出題計畫，純函式。
 *
 * Edward 2026-11-11 的每週主題（edward_rulings；模擬瓦的 `/模擬 今天` 用同一套）：
 *   週一 刺殺梅林＋公布週日那局；週二 派西維爾思考＋公布週一的梅林；週三 1-5 尾派＋公布週二的派西；
 *   週四 公布週三的答案，題目延續同一局：3-5 尾派（所以週三選「第二局開紅、輪得到 3-5 尾派」的局）；
 *   週五 2-5 尾派＋公布週四那局的完整牌譜；週六 同一局接到 4-5（Issue #37：局數不夠時改成第四局忠臣派 5 人）；
 *   週日 第五局決策＋公布週六那局。
 * Edward 11/16：「模擬畢竟只是模擬」——題目只從實戰出：題庫 sim_bank.json 建的時候就把模擬的局拿掉了
 * （scripts/buildSimBank.ts），網站牌譜的連結也跳過模擬的貼文（recordsIndex.isSimulatedPost）。
 *
 * 可重現：同一個日期、同一份題庫一定選同一題（每一個池子照「題庫代號＋決定」的雜湊排好，
 * 第 k 週拿第 k 個，題庫不變就不會重複出同一局，直到池子用完一輪）。
 * 題庫或牌譜連結更新會讓之後的排序變；已經產生過的草稿以存下來的檔案為準（threadsDraft.ts 先讀檔）。
 */

import { createHash } from 'crypto';
import type { Role } from '@avalon/shared';
import {
  assassinSeat,
  midDecision,
  type SimGame,
} from '../simulation/scenario';

/** 一週七天的主題（0 = 週日，台北日期）。 */
export type ThreadsKind = 'assassin' | 'percival' | 'tail' | 'final' | 'round4';

export interface ThreadsTheme {
  weekday: number;
  /** 貼文開頭的主題字。 */
  label: string;
  kind: ThreadsKind;
  /** 尾派：第幾局的第 5 次（final = 第 5 局）。 */
  round?: number;
  /** 這一天的題目延續前一天同一局（週四、週六）。 */
  continues?: boolean;
}

export const THREADS_THEMES: readonly ThreadsTheme[] = [
  { weekday: 0, label: '週日・第五局決策', kind: 'final', round: 5 },
  { weekday: 1, label: '週一・刺殺梅林', kind: 'assassin' },
  { weekday: 2, label: '週二・派西維爾思考', kind: 'percival' },
  { weekday: 3, label: '週三・1-5 尾派', kind: 'tail', round: 1 },
  { weekday: 4, label: '週四・同一局接到 3-5', kind: 'tail', round: 3, continues: true },
  { weekday: 5, label: '週五・2-5 尾派', kind: 'tail', round: 2 },
  { weekday: 6, label: '週六・同一局接到 4-5', kind: 'tail', round: 4, continues: true },
];

export function themeOf(weekday: number): ThreadsTheme {
  return THREADS_THEMES[((weekday % 7) + 7) % 7];
}

/** 週六沒有能連著的 2-5＋4-5 時的題目（Issue #37「局數不夠時改成第四局忠臣派 5 人」）。 */
export const ROUND4_LOYAL_LABEL = '週六・第四局忠臣派 5 人';
/** 週四沒有能連著的 1-5＋3-5 時：獨立的 3-5。 */
export const THU_ALONE_LABEL = '週四・3-5 尾派';

/** 這一天這一題的標題：延續的日子沒有延續時改用獨立的標題。 */
export function labelFor(weekday: number, pick: Pick<ThreadsPick, 'kind' | 'round' | 'continues'>): string {
  if (pick.kind === 'round4') return ROUND4_LOYAL_LABEL;
  const theme = themeOf(weekday);
  if (theme.continues && !pick.continues && theme.round === 3) return THU_ALONE_LABEL;
  return theme.label;
}

/** 一天的題目：哪一局、哪一個決定（刺殺題沒有派票決定）、誰的視角。 */
export interface ThreadsPick {
  kind: ThreadsKind;
  /** 題庫代號（sha1 指紋的前 5 碼，題庫重建也不變）。 */
  gameId: string;
  /** proposals[] 的索引；刺殺題是 null。 */
  proposal: number | null;
  /** 視角的座位（尾派＝隊長；刺殺題＝刺客）。 */
  seat: number;
  /** 尾派的局（final = 5）。 */
  round?: number;
  /** 週四、週六：延續前一天同一局。 */
  continues?: boolean;
}

/** 題號：跟模擬瓦一樣（K7Q2M-1-5、K7Q2M-A），第 5 局的題目寫實際的第幾次。 */
export function exerciseIdOfPick(pick: ThreadsPick, game: SimGame): string {
  if (pick.kind === 'assassin' || pick.proposal === null) return `${pick.gameId}-A`;
  const p = game.proposals[pick.proposal];
  return `${pick.gameId}-${p.round}-${p.attempt}`;
}

// ─── 日期 ─────────────────────────────────────────────────────────────────

/** `YYYY-MM-DD`（台北日期）→ 從 1970-01-01 起的天數。 */
export function dayNumber(date: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error(`date must be YYYY-MM-DD: ${date}`);
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const back = new Date(t);
  if (back.getUTCMonth() !== Number(m[2]) - 1 || back.getUTCDate() !== Number(m[3])) throw new Error(`no such date: ${date}`);
  return Math.round(t / 86_400_000);
}

export function dateOfDay(day: number): string {
  return new Date(day * 86_400_000).toISOString().slice(0, 10);
}

export function addDays(date: string, n: number): string {
  return dateOfDay(dayNumber(date) + n);
}

/** 星期（0 = 週日）。 */
export function weekdayOf(date: string): number {
  return ((dayNumber(date) + 4) % 7 + 7) % 7; // 1970-01-01 是週四
}

/** 週一是一週的開始；第 0 週 = 2026-11-16 那一週。 */
export const THREADS_EPOCH_MONDAY = '2026-11-16';

export function weekIndexOf(date: string): number {
  return Math.floor((dayNumber(date) - dayNumber(THREADS_EPOCH_MONDAY)) / 7);
}

/**
 * 第一篇貼文的日期（站長 2026-11-17 貼出第一題 36AKW-2-5）：這一天的 A 沒有昨天的答案，
 * 之前的日子不算（不會出現在任何 A 的「昨天的答案」裡）。
 */
export const THREADS_START_DATE = '2026-11-17';

/** 今天的台北日期。 */
export function taipeiToday(now: number = Date.now()): string {
  return new Date(now + 8 * 3_600_000).toISOString().slice(0, 10);
}

// ─── 池子 ─────────────────────────────────────────────────────────────────

/** 視角的偏好：忠臣、派西 → 梅林 → 紅方（公開題目以藍方視角為主）。 */
const ROLE_TIERS: readonly (readonly Role[])[] = [['loyal', 'percival'], ['merlin']];

function tierOf(role: Role): number {
  const i = ROLE_TIERS.findIndex((t) => t.includes(role));
  return i < 0 ? ROLE_TIERS.length : i;
}

function hash32(text: string): number {
  return parseInt(createHash('sha1').update(text).digest('hex').slice(0, 8), 16);
}

interface Candidate {
  picks: ThreadsPick[];
  /** 視角的偏好（小的好）。 */
  tier: number;
  linked: boolean;
  key: string;
}

export interface ThreadsBank {
  games: readonly SimGame[];
  /** games[] 的索引 → 網站牌譜的貼文 id。 */
  records?: ReadonlyMap<number, string>;
}

function leaderOf(game: SimGame, proposal: number): number {
  return game.proposals[proposal].leaderSeat;
}

function roleAt(game: SimGame, seat: number): Role {
  return game.seatRoles[seat - 1];
}

/** 一局裡某個尾派（第 round 局第 5 次）的題目；3-5 只出第二局開紅的局（midDecision）。 */
function tailPick(game: SimGame, round: number, continues = false): ThreadsPick | null {
  const d = midDecision(game, round);
  if (d === null) return null;
  return { kind: 'tail', gameId: game.id, proposal: d, seat: leaderOf(game, d), round, ...(continues ? { continues: true } : {}) };
}

/** 每一個池子的候選（每一局最多一個）。 */
export function buildCandidates(bank: ThreadsBank): Record<'assassin' | 'percival' | 'wedThu' | 'wed' | 'thu' | 'friSat' | 'fri' | 'sat' | 'final', Candidate[]> {
  const out = { assassin: [], percival: [], wedThu: [], wed: [], thu: [], friSat: [], fri: [], sat: [], final: [] } as Record<
    'assassin' | 'percival' | 'wedThu' | 'wed' | 'thu' | 'friSat' | 'fri' | 'sat' | 'final',
    Candidate[]
  >;
  bank.games.forEach((g, gi) => {
    const linked = !!bank.records?.has(gi);
    const add = (pool: keyof typeof out, picks: ThreadsPick[], seats: number[]): void => {
      const tier = Math.max(...seats.map((s) => tierOf(roleAt(g, s))));
      out[pool].push({ picks, tier, linked, key: `${pool}:${picks.map((p) => `${p.gameId}/${p.proposal}`).join('+')}` });
    };

    const a = assassinSeat(g);
    if (a !== null) {
      // 刺客視角本來就是紅方：不用藍方偏好。
      out.assassin.push({ picks: [{ kind: 'assassin', gameId: g.id, proposal: null, seat: a }], tier: 0, linked, key: `assassin:${g.id}` });
    }

    // 派西維爾第 2 局起當隊長的第一次（還沒分出梅林、需要用拇指想的時候最多）。
    const perc = g.proposals.find((p) => p.round >= 2 && roleAt(g, p.leaderSeat) === 'percival');
    if (perc) add('percival', [{ kind: 'percival', gameId: g.id, proposal: perc.globalIndex, seat: perc.leaderSeat }], [perc.leaderSeat]);

    const t1 = tailPick(g, 1);
    const t3 = tailPick(g, 3, true);
    if (t1 && t3) add('wedThu', [t1, t3], [t1.seat, t3.seat]);
    if (t1) add('wed', [t1], [t1.seat]);
    const t3alone = tailPick(g, 3);
    if (t3alone) add('thu', [t3alone], [t3alone.seat]);

    const t2 = tailPick(g, 2);
    const t4 = tailPick(g, 4, true);
    if (t2 && t4) add('friSat', [t2, t4], [t2.seat, t4.seat]);
    if (t2) add('fri', [t2], [t2.seat]);
    // 週六的備案：第 4 局忠臣當隊長的第一次派票（5 人）。
    const r4 = g.proposals.find((p) => p.round === 4 && roleAt(g, p.leaderSeat) === 'loyal');
    if (r4) add('sat', [{ kind: 'round4', gameId: g.id, proposal: r4.globalIndex, seat: r4.leaderSeat, round: 4 }], [r4.leaderSeat]);

    // 第 5 局：藍方隊長的第一次派票（偏好藍方視角；沒有就第一次）。
    const r5 = g.proposals.filter((p) => p.round === 5);
    const blue = r5.find((p) => tierOf(roleAt(g, p.leaderSeat)) < ROLE_TIERS.length) ?? r5[0];
    if (blue) add('final', [{ kind: 'final', gameId: g.id, proposal: blue.globalIndex, seat: blue.leaderSeat, round: 5 }], [blue.leaderSeat]);
  });
  return out;
}

/**
 * 從池子裡選第 `week` 週的那一個：先縮到最好的視角、再縮到有網站牌譜連結的（縮了還有東西才縮），
 * 照雜湊排好拿第 week 個；`used` 裡的局跳過（同一週不出同一局兩次）。
 */
export function pickFrom(pool: readonly Candidate[], week: number, salt: string, used: ReadonlySet<string>): ThreadsPick[] | null {
  let list = pool.filter((c) => !c.picks.some((p) => used.has(p.gameId)));
  if (list.length === 0) return null;
  const best = Math.min(...list.map((c) => c.tier));
  list = list.filter((c) => c.tier === best);
  const linked = list.filter((c) => c.linked);
  if (linked.length > 0) list = linked;
  const sorted = [...list].sort((x, y) => hash32(`${salt}:${x.key}`) - hash32(`${salt}:${y.key}`) || (x.key < y.key ? -1 : 1));
  const n = sorted.length;
  return sorted[((week % n) + n) % n].picks;
}

/** 計畫的版本（排法改了就改這個，舊週的草稿以存下來的檔案為準）。 */
export const THREADS_PLAN_SALT = 'threads-v1';

/**
 * 一週（週一到週日）的計畫：index 0 = 週一 … 6 = 週日；選不到的那天是 null。
 * 週三＋週四、週五＋週六優先選同一局連著的；沒有就各選一題（週四改出獨立的 3-5、週六改出第四局忠臣派 5 人）。
 */
export function planWeek(bank: ThreadsBank, week: number, candidates = buildCandidates(bank)): (ThreadsPick | null)[] {
  const used = new Set<string>();
  const take = (pool: Candidate[], name: string): ThreadsPick[] | null => {
    const picks = pickFrom(pool, week, `${THREADS_PLAN_SALT}:${name}`, used);
    picks?.forEach((p) => used.add(p.gameId));
    return picks;
  };
  const mon = take(candidates.assassin, 'assassin');
  const tue = take(candidates.percival, 'percival');
  const wedThu = take(candidates.wedThu, 'wedThu');
  const wed = wedThu ? [wedThu[0]] : take(candidates.wed, 'wed');
  const thu = wedThu ? [wedThu[1]] : take(candidates.thu, 'thu');
  const friSat = take(candidates.friSat, 'friSat');
  const fri = friSat ? [friSat[0]] : take(candidates.fri, 'fri');
  const sat = friSat ? [friSat[1]] : take(candidates.sat, 'sat');
  const sun = take(candidates.final, 'final');
  return [mon, tue, wed, thu, fri, sat, sun].map((p) => p?.[0] ?? null);
}

/**
 * 延續前一天同一局（週四 3-5、週六 4-5）：前一天那一局有這個尾派就用它（就算計畫因為題庫更新換了局，
 * 也跟著實際貼出去的前一天走）；沒有就 null。
 */
export function continuationOf(game: SimGame, round: number): ThreadsPick | null {
  return tailPick(game, round, true);
}

/** 週四／週六不延續時的獨立題（週四 3-5、週六第四局忠臣派 5 人），跟計畫用同一套排法。 */
export function aloneFor(bank: ThreadsBank, date: string, candidates = buildCandidates(bank)): ThreadsPick | null {
  const wd = weekdayOf(date);
  const pool = wd === 4 ? 'thu' : wd === 6 ? 'sat' : null;
  if (!pool) return null;
  return pickFrom(candidates[pool], weekIndexOf(date), `${THREADS_PLAN_SALT}:${pool}`, new Set())?.[0] ?? null;
}

/** 某一天的題目（照計畫）。 */
export function pickForDate(bank: ThreadsBank, date: string, candidates = buildCandidates(bank)): ThreadsPick | null {
  const wd = weekdayOf(date);
  return planWeek(bank, weekIndexOf(date), candidates)[(wd + 6) % 7];
}
