/**
 * 每種局子句 → (game) => boolean（r9 設計 §3.3）。名字已在 apply.ts 換成資料集的正式名字。
 * 「有名字的座位」才看得到玩家：沒寫名字的座位不屬於任何人。
 */
import {
  OUTCOME_BLUE_ALIVE,
  OUTCOME_BLUE_DEAD,
  OUTCOME_THREE_RED,
  RED_ROLES,
  SEATS,
  isFinalWin,
  isOutcome,
  roleFactionName,
} from '../constants';
import type { Game } from '../dataset';
import { gameSeats, matchesLineup } from '../lineup';
import type { GameClause, SeatNo, Side } from './types';

export type GamePredicate = (g: Game) => boolean;

const TRIO_SHORT: Record<string, string> = { 派西維爾: '派', 梅林: '梅', 莫甘娜: '娜' };

/** 座位字元 → 座號（"0" = 10）。 */
export function seatNumber(seat: string): number {
  return seat === '0' ? 10 : Number(seat);
}

/** 篩選用的分類值：空白 = 未分類。 */
export function categoryValue(g: Pick<Game, 'category'>): string {
  return g.category === '' ? '未分類' : g.category;
}

/** ISO 星期（1 = 星期一 … 7 = 星期日）；沒有日期為 0。 */
export function isoWeekday(date: string): number {
  if (!date) return 0;
  const [y, m, d] = date.split('-').map(Number);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return day === 0 ? 7 : day;
}

function sideOfRole(role: string): Side | '' {
  const f = roleFactionName(role);
  return f === '紅方' ? 'red' : f === '藍方' ? 'blue' : '';
}

/** compute_seat_order 的 get_trio_order：派 / 梅 / 娜 依座號排的順序（例：梅派娜）；缺一個時 null。 */
export function trioOrder(g: Pick<Game, 'seatRoles'>): string | null {
  const seatOf = new Map<string, number>();
  for (const [seat, role] of g.seatRoles) {
    if (!(role in TRIO_SHORT)) continue;
    const n = seat === '0' ? 10 : /^[0-9]$/.test(seat) ? Number(seat) : NaN;
    if (Number.isNaN(n)) continue;
    seatOf.set(role, n);
  }
  if (seatOf.size !== 3) return null;
  return [...seatOf.entries()].sort((a, b) => a[1] - b[1]).map(([role]) => TRIO_SHORT[role]).join('');
}

/** 10 人局各任務的出牌張數（第 4 個任務要兩張失敗才算失敗）。 */
export const TEN_PLAYER_TEAM_SIZES: readonly number[] = [3, 4, 4, 5, 5];

/**
 * 任務順序（例：藍紅藍藍）：依出牌（missions）判斷每個任務的紅藍，第 4 個任務兩張失敗才算紅。
 * 只認 10 人標準隊伍人數（3、4、4、5、5）而且中間沒有空掉的任務；其他的局回 null。
 * 一方拿到 3 個任務之後的格子不看（局已分出勝負）。
 */
export function missionSequence(g: Pick<Game, 'missions'>): string | null {
  let seq = '';
  let blue = 0;
  let red = 0;
  for (let i = 0; i < g.missions.length; i += 1) {
    if (blue >= 3 || red >= 3) break;
    const m = g.missions[i];
    if (m.round !== i + 1 || m.total !== TEN_PLAYER_TEAM_SIZES[i]) return null;
    const isRed = m.fails >= (i === 3 ? 2 : 1);
    seq += isRed ? '紅' : '藍';
    if (isRed) red += 1;
    else blue += 1;
  }
  return seq || null;
}

function inRange(x: number, min?: number, max?: number): boolean {
  return (min === undefined || x >= min) && (max === undefined || x <= max);
}

function tagged(g: Game, prefix: string, values: readonly string[]): boolean {
  const own = g.noteTags.filter((t) => t.startsWith(prefix));
  return values.some((v) => (v === 'none' ? own.length === 0 : own.includes(`${prefix}${v}`)));
}

/** 有名字的座位：[座位字元, 名字, 角色]。 */
function namedSeats(g: Game): Array<[string, string, string]> {
  const out: Array<[string, string, string]> = [];
  SEATS.forEach((seat, i) => {
    const name = g.seatPlayers[i];
    if (name) out.push([seat, name, g.seatRoles.get(seat) as string]);
  });
  return out;
}

/** 子句本身的判斷（不含 not）。 */
function rawPredicate(clause: GameClause): GamePredicate {
  switch (clause.kind) {
    case 'category':
      return (g) => (clause.in as string[]).includes(categoryValue(g));
    case 'source':
      return (g) => clause.in.includes(g.source === 1 ? 'discord' : 'sheet');
    case 'date':
      return (g) => (g.date
        ? (clause.from === undefined || g.date >= clause.from) && (clause.to === undefined || g.date <= clause.to)
        : clause.undated === 'include');
    case 'weekday':
      return (g) => Boolean(g.date) && clause.in.includes(isoWeekday(g.date));
    case 'sessionIndex':
      return (g) => g.slot > 0 && inRange(g.slot, clause.min, clause.max);
    case 'season':
      return (g) => tagged(g, 'season:', clause.in);
    case 'venue':
      return (g) => tagged(g, 'venue:', clause.in);
    case 'noteFlag':
      return (g) => clause.any.some((f) => g.noteTags.includes(`flag:${f}`));
    case 'namedSeats':
      return (g) => inRange(g.namedSeats, clause.min, clause.max);
    case 'outcome':
      return (g) => (clause.in as string[]).includes(isOutcome(g.outcome) ? g.outcome : 'other');
    case 'finalWinner':
      return (g) => (clause.is === 'red'
        ? g.outcome === OUTCOME_THREE_RED || g.outcome === OUTCOME_BLUE_DEAD
        : g.outcome === OUTCOME_BLUE_ALIVE);
    case 'missionCount':
      return (g) => clause.in.includes(g.missions.length);
    case 'mission':
      return (g) => {
        const m = g.missions.find((x) => x.round === clause.round);
        if (!m) return false;
        if (clause.result === 'pass' && m.fails !== 0) return false;
        if (clause.result === 'fail' && m.fails === 0) return false;
        return inRange(m.fails, clause.minFails, clause.maxFails);
      };
    case 'gameState':
      return (g) => Boolean(g.gameState) && clause.in.includes(g.gameState);
    case 'missionSeq':
      return (g) => (missionSequence(g) ?? '').startsWith(clause.prefix);
    case 'firstTeam':
      return (g) => g.r11Seats.length > 0
        && (clause.redCount === undefined || clause.redCount.includes(g.r11RedCount))
        && (clause.hasMerlin === undefined || clause.hasMerlin === g.r11HasMerlin)
        && (clause.hasPercival === undefined || clause.hasPercival === g.r11HasPercival);
    case 'lakeCount':
      return (g) => clause.in.includes(g.lakes.filter((l) => l !== null).length);
    case 'lake':
      return (g) => {
        const lake = g.lakes[clause.index - 1];
        if (!lake) return false;
        if (clause.holderSide !== undefined && sideOfRole(lake.holderRole) !== clause.holderSide) return false;
        if (clause.targetSide !== undefined && sideOfRole(lake.targetRole) !== clause.targetSide) return false;
        if (clause.holderRole !== undefined && !(clause.holderRole as string[]).includes(lake.holderRole)) return false;
        if (clause.targetRole !== undefined && !(clause.targetRole as string[]).includes(lake.targetRole)) return false;
        if (clause.claim !== undefined) {
          const c = g.claims[clause.index - 1];
          if (!c) return false;
          const said = c.claim === '紅' ? 'red' : c.claim === '藍' ? 'blue' : 'none';
          if (!clause.claim.includes(said)) return false;
        }
        return true;
      };
    case 'assassination':
      return (g) => {
        if (g.outcome !== OUTCOME_BLUE_DEAD && g.outcome !== OUTCOME_BLUE_ALIVE) return false;
        if (!g.kill) return (clause.target as string[]).includes('none');
        const role = g.seatRoles.get(g.kill);
        return role !== undefined && (clause.target as string[]).includes(role);
      };
    case 'roleSeat':
      return (g) => SEATS.some((seat) => g.seatRoles.get(seat) === clause.role
        && (clause.seats as number[]).includes(seatNumber(seat)));
    case 'trioOrder':
      return (g) => {
        const order = trioOrder(g);
        return order !== null && (clause.in as string[]).includes(order);
      };
    case 'captain':
      return (g) => {
        const seat = g.captains[clause.round - 1];
        if (seat === undefined || seat === null) return false;
        if (!g.missions.some((m) => m.round === clause.round)) return false;
        const faction = roleFactionName(g.seatRoles.get(seat) ?? '忠臣') || '藍方';
        return (faction === '紅方' ? 'red' : 'blue') === clause.side;
      };
    case 'gameId':
      return (g) => clause.in.includes(g.id);
    case 'lineup':
      return (g) => matchesLineup(g.lineup, clause, gameSeats(g));
    case 'withPlayer':
      return (g) => namedSeats(g).some(([seat, name, role]) => {
        if (name !== clause.player) return false;
        if (clause.role !== undefined && !(clause.role as string[]).includes(role)) return false;
        if (clause.side !== undefined && sideOfRole(role) !== clause.side) return false;
        if (clause.seat !== undefined && !(clause.seat as SeatNo[]).includes(seatNumber(seat) as SeatNo)) return false;
        if (clause.result !== undefined) {
          if (!isOutcome(g.outcome)) return false;
          const won = clause.resultRule === 'mission'
            ? (RED_ROLES.has(role) ? g.redWin : g.blueWin)
            : isFinalWin(role, g.outcome);
          if (won !== (clause.result === 'win')) return false;
        }
        return true;
      });
    case 'withAnyPlayer': {
      const wanted = new Set(clause.players);
      return (g) => g.seatPlayers.some((n) => n !== null && wanted.has(n));
    }
    case 'withPlayers':
      return (g) => {
        const seats = namedSeats(g);
        const sidesOf = (player: string): Array<Side | ''> => seats.filter(([, n]) => n === player).map(([, , r]) => sideOfRole(r));
        const a = sidesOf(clause.players[0]);
        const b = sidesOf(clause.players[1]);
        if (!a.length || !b.length) return false;
        if (clause.relation === 'together') return true;
        const same = a.some((x) => b.includes(x));
        const differ = a.some((x) => b.some((y) => y !== x));
        return clause.relation === 'sameTeam' ? same : differ;
      };
    default: {
      const never: never = clause;
      throw new Error(`unknown clause ${(never as { kind: string }).kind}`);
    }
  }
}

/** 子句 → 判斷式（含 not）。 */
export function clausePredicate(clause: GameClause): GamePredicate {
  const test = rawPredicate(clause);
  return clause.not ? (g): boolean => !test(g) : test;
}
