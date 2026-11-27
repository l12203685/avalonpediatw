/**
 * AI騎士 的學習樣本數（站長 2026-11-27：「可以標注在AI騎士旁邊說 學習樣本場次數有多少 依座位/腳色/任務結果/遊戲結果
 * （雖然幾乎每個spot幾乎都完全不同）」）。
 *
 * 只有數字（沒有局號、名字）：擬合程式（`scripts/styleKnights.ts`、補寫用 `scripts/knightSamples.ts`）從網站的真人局算好，
 * 寫進官方 AI騎士 profile 的 `samples`；擂台排行榜、練習台／房間的騎士選單照這份顯示。
 * 每個局面幾乎都不一樣，所以這些數字量的是「涵蓋多少種情況」，不是同一個局面重複了幾次。
 */
import type { ReplayGame } from '../ai/benchmark/sheetsReplay';

export const SAMPLE_ROLES = ['merlin', 'percival', 'loyal', 'morgana', 'assassin', 'mordred', 'oberon'] as const;
export type SampleRole = typeof SAMPLE_ROLES[number];

export interface KnightSamples {
  /** 網站上的真人局場數（含紀錄不完整、不能重播的）。 */
  games: number;
  /** 拿來學的座位數（可以重播的；一局通常一個座位）。下面的分類都照這個數。 */
  seats: number;
  /** 依座位：[0] = 1家 … [9] = 0家（10 號位）。 */
  bySeat: number[];
  /** 依角色。 */
  byRole: Record<SampleRole, number>;
  /** 依任務結果：三藍（三次任務成功）／三紅（三次任務失敗）。 */
  byMissions: { blue3: number; red3: number };
  /** 依遊戲結果：紅方三紅勝／三藍但梅林被刺（紅勝）／三藍梅林活（藍勝）。 */
  byResult: { red3: number; merlinKilled: number; blueWin: number };
  /** 決策點（大約）：當隊長派隊、投票、任務牌、湖中、刺殺。 */
  decisions: { propose: number; vote: number; quest: number; lake: number; assassinate: number };
}

/** 一位玩家坐過的可重播座位 → 樣本數。`games` = 真人局場數（含不能重播的）。 */
export function samplesFromSeats(entries: ReadonlyArray<{ game: ReplayGame; seat: number }>, games: number): KnightSamples {
  const s: KnightSamples = {
    games,
    seats: entries.length,
    bySeat: Array.from({ length: 10 }, () => 0),
    byRole: Object.fromEntries(SAMPLE_ROLES.map((r) => [r, 0])) as Record<SampleRole, number>,
    byMissions: { blue3: 0, red3: 0 },
    byResult: { red3: 0, merlinKilled: 0, blueWin: 0 },
    decisions: { propose: 0, vote: 0, quest: 0, lake: 0, assassinate: 0 },
  };
  for (const { game, seat } of entries) {
    if (seat >= 1 && seat <= 10) s.bySeat[seat - 1] += 1;
    const role = game.seatRoles[seat - 1] as SampleRole;
    if (role in s.byRole) s.byRole[role] += 1;
    const ok = game.quests.filter((q) => !q.failed).length;
    const bad = game.quests.filter((q) => q.failed).length;
    if (ok >= 3) s.byMissions.blue3 += 1;
    if (bad >= 3) s.byMissions.red3 += 1;
    if (game.winner === 'good') s.byResult.blueWin += 1;
    else if (bad >= 3) s.byResult.red3 += 1;
    else if (ok >= 3) s.byResult.merlinKilled += 1;
    s.decisions.propose += game.proposals.filter((p) => p.leaderSeat === seat).length;
    s.decisions.vote += game.proposals.length;
    s.decisions.quest += game.quests.filter((q) => q.teamSeats.includes(seat)).length;
    s.decisions.lake += game.lakes.filter((l) => l.holderSeat === seat).length;
    if (role === 'assassin' && game.assassinTargetSeat !== undefined) s.decisions.assassinate += 1;
  }
  return s;
}

const COUNT_MAX = 1_000_000;

function count(v: unknown, where: string, errors: string[]): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > COUNT_MAX) {
    errors.push(`samples.${where} 要是 0–${COUNT_MAX} 的整數`);
    return 0;
  }
  return v;
}

function group<K extends string>(raw: unknown, keys: readonly K[], where: string, errors: string[]): Record<K, number> {
  const out = {} as Record<K, number>;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    errors.push(`samples.${where} 要是物件`);
    return out;
  }
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!(keys as readonly string[]).includes(k)) errors.push(`samples.${where} 不認得「${k}」`);
  for (const k of keys) out[k] = count(o[k], `${where}.${k}`, errors);
  return out;
}

/** profile 的 `samples`（只有官方 AI騎士）：只收上面那幾個數字欄位。 */
export function validateSamples(raw: unknown, errors: string[]): KnightSamples | undefined {
  const before = errors.length;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) { errors.push('samples 要是物件'); return undefined; }
  const o = raw as Record<string, unknown>;
  const top = ['games', 'seats', 'bySeat', 'byRole', 'byMissions', 'byResult', 'decisions'];
  for (const k of Object.keys(o)) if (!top.includes(k)) errors.push(`samples 不認得「${k}」`);
  let bySeat: number[] = [];
  if (Array.isArray(o.bySeat) && o.bySeat.length === 10) bySeat = o.bySeat.map((v, i) => count(v, `bySeat[${i}]`, errors));
  else errors.push('samples.bySeat 要是 10 個數字（1家…0家）');
  const s: KnightSamples = {
    games: count(o.games, 'games', errors),
    seats: count(o.seats, 'seats', errors),
    bySeat,
    byRole: group(o.byRole, SAMPLE_ROLES, 'byRole', errors),
    byMissions: group(o.byMissions, ['blue3', 'red3'] as const, 'byMissions', errors),
    byResult: group(o.byResult, ['red3', 'merlinKilled', 'blueWin'] as const, 'byResult', errors),
    decisions: group(o.decisions, ['propose', 'vote', 'quest', 'lake', 'assassinate'] as const, 'decisions', errors),
  };
  return errors.length === before ? s : undefined;
}
