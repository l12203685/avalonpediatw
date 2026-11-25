/**
 * Threads 每日一題（2026-11-25）— 每一題的三個選項 A／B／C。
 *
 * 站長 11/25：「關於數據分析跟每日一題 希望能更直觀讓看到的人一目瞭然」→ 題目卡和貼文不再只問「你會派誰？」，
 * 直接給三個選項，路過的人回一個字母就能作答（都不是也可以留言自己的答案）。
 *
 * 選項只用出題那一刻看得到的資訊（加上「真人實際怎麼做」這個隔天才公布的答案），純函式、同一題永遠同一組：
 *   派隊題（尾派、派西、第四局、第五局）：
 *     1. 真人派的那一隊；
 *     2. 純邏輯下「全是好人」的組合最多的隊（logicModel，跟答案裡的理由同一套；優先含隊長自己）；
 *     3. 這一局前一個隊長派的隊（沒有就用上一局出任務的隊加隊長；再沒有就用純邏輯的下一名）。
 *   刺殺題：梅林、派西維爾、真人刺的那一家（跟前兩個重複時，改放出最多次成功任務的忠臣）。
 * 排好之後照座位號碼由小到大給 A、B、C，所以字母看不出哪一個是真人選的。
 */

import type { Role } from '@avalon/shared';
import { ROLE_ZH } from '../simulation/commands';
import { logicModel } from '../simulation/logic';
import { seatLabel } from '../simulation/replies';
import { TEAM_SIZES, isRed } from '../simulation/scenario';
import { maskOf, seatChar, sortSeats, teamDigits } from '../simulation/seats';
import type { PickView } from './draft';

export const CHOICE_LETTERS = ['A', 'B', 'C'] as const;
export type ChoiceLetter = (typeof CHOICE_LETTERS)[number];

export interface Choice {
  letter: ChoiceLetter;
  /** 派隊題：這一隊的座位（由小到大，10 = 0家）；刺殺題：那一家（一個座位）。 */
  seats: number[];
  /** 真人實際的選擇（隔天才公布；題目卡、貼文的題目那一半不能用）。 */
  real: boolean;
}

export interface Choices {
  kind: 'team' | 'assassin';
  items: Choice[];
}

/** 座位比大小：一個一個比（0家 = 10，排最後）。 */
function compareSeats(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

function combinations(n: number, k: number): number[][] {
  const out: number[][] = [];
  const cur: number[] = [];
  const rec = (start: number): void => {
    if (cur.length === k) {
      out.push([...cur]);
      return;
    }
    for (let s = start; s <= n; s++) {
      cur.push(s);
      rec(s + 1);
      cur.pop();
    }
  };
  rec(1);
  return out;
}

/** 純邏輯的排名：全好組合多的在前；一樣多時含隊長的在前，再照座位。 */
function logicRanking(pv: PickView, size: number): number[][] {
  const worlds = logicModel.worlds(pv.view).map((w) => w.redMask);
  const clean = (team: readonly number[]): number => {
    const m = maskOf(team);
    return worlds.filter((w) => (w & m) === 0).length;
  };
  const me = pv.pick.seat;
  return combinations(10, size)
    .map((team) => ({ team, clean: clean(team), mine: team.includes(me) ? 1 : 0 }))
    .sort((a, b) => b.clean - a.clean || b.mine - a.mine || compareSeats(a.team, b.team))
    .map((x) => x.team);
}

function teamChoices(pv: PickView): number[][] {
  const p = pv.game.proposals[pv.pick.proposal as number];
  const size = TEAM_SIZES[p.round - 1];
  const picked: number[][] = [];
  const add = (team: readonly number[] | null | undefined): void => {
    if (!team || team.length !== size || picked.length >= 3) return;
    const t = sortSeats(team);
    if (!picked.some((x) => compareSeats(x, t) === 0)) picked.push(t);
  };
  add(p.teamSeats);
  const ranking = logicRanking(pv, size);
  // 純邏輯最好的那一隊（跟真人一樣就拿下一名）
  add(ranking.find((t) => compareSeats(t, sortSeats(p.teamSeats)) !== 0));
  // 這一局前一個隊長的隊，由近到遠
  const earlier = pv.shown.filter((e): e is Extract<PickView['shown'][number], { kind: 'proposal' }> => e.kind === 'proposal' && e.round === p.round);
  const before = picked.length;
  for (let i = earlier.length - 1; i >= 0 && picked.length === before; i--) add(earlier[i].teamSeats);
  // 這一局還沒有人派過：上一局出任務的隊（人數一樣就原隊，少一個就加隊長）
  if (picked.length === before) {
    const lastQuest = [...pv.shown].reverse().find((e) => e.kind === 'quest');
    if (lastQuest && lastQuest.kind === 'quest') {
      add(lastQuest.teamSeats);
      if (picked.length === before && !lastQuest.teamSeats.includes(pv.pick.seat)) add([...lastQuest.teamSeats, pv.pick.seat]);
    }
  }
  for (const t of ranking) add(t);
  return picked;
}

function assassinChoices(pv: PickView): number[][] {
  const roles = pv.game.seatRoles;
  const seatOf = (role: Role): number => roles.indexOf(role) + 1;
  const picked: number[] = [];
  const add = (seat: number | null | undefined): void => {
    if (!seat || picked.length >= 3 || picked.includes(seat) || isRed(roles[seat - 1])) return;
    picked.push(seat);
  };
  add(seatOf('merlin'));
  add(seatOf('percival'));
  add(pv.game.assassinTargetSeat);
  // 出最多次成功任務的好人（看起來最像梅林的忠臣），一樣多時座位小的
  const clean = (seat: number): number => pv.game.quests.filter((q) => !q.failed && q.teamSeats.includes(seat)).length;
  const rest = roles.map((_, i) => i + 1).filter((s) => !isRed(roles[s - 1])).sort((a, b) => clean(b) - clean(a) || a - b);
  for (const s of rest) add(s);
  return picked.map((s) => [s]);
}

/** 這一題的三個選項（照座位排，A、B、C）。 */
export function choicesFor(pv: PickView): Choices {
  const assassin = pv.pick.proposal === null;
  const raw = assassin ? assassinChoices(pv) : teamChoices(pv);
  const realSeats = assassin
    ? pv.game.assassinTargetSeat ? [pv.game.assassinTargetSeat] : []
    : sortSeats(pv.game.proposals[pv.pick.proposal as number].teamSeats);
  const items = raw
    .sort(compareSeats)
    .slice(0, 3)
    .map((seats, i) => ({ letter: CHOICE_LETTERS[i], seats, real: compareSeats(seats, realSeats) === 0 }));
  return { kind: assassin ? 'assassin' : 'team', items };
}

/** 真人選的是哪一個字母（刺殺題真人刺的不在三個選項裡、或沒有記錄時是 null）。 */
export function realLetter(c: Choices): ChoiceLetter | null {
  return c.items.find((x) => x.real)?.letter ?? null;
}

/** 選項的寫法：派隊題「2、4、5、0家」、刺殺題「5家」。 */
export function choiceLabel(c: Choices, item: Choice): string {
  return c.kind === 'assassin' ? seatLabel(item.seats[0]) : `${item.seats.map(seatChar).join('、')}家`;
}

/** 貼文裡「都不是」的那一行。 */
export function otherChoiceLine(c: Choices): string {
  return c.kind === 'assassin' ? '都不是？留言你覺得的座位' : '都不是？留言你的隊';
}

/** 貼文的 {選項}：一個選項一行，最後一行「都不是？…」。 */
export function choiceLines(c: Choices): string[] {
  const verb = c.kind === 'assassin' ? '刺' : '派';
  return [...c.items.map((x) => `${x.letter} ${verb} ${choiceLabel(c, x)}`), otherChoiceLine(c)];
}

/**
 * 公布答案時每個選項的真相：派隊題「A 1345（3 好 1 壞）」、刺殺題「A 3家（忠臣）」。
 * 只在完整公布的那天用（延續的日子同一局還在打，不能講）。
 */
export function choiceReveal(pv: PickView, c: Choices = choicesFor(pv)): { letter: ChoiceLetter; seats: number[]; real: boolean; text: string; reds: number[] }[] {
  const roles = pv.game.seatRoles;
  return c.items.map((x) => {
    const reds = x.seats.filter((s) => isRed(roles[s - 1]));
    const text = c.kind === 'assassin'
      ? `${x.letter} ${seatLabel(x.seats[0])}（${ROLE_ZH[roles[x.seats[0] - 1]]}）`
      : `${x.letter} ${teamDigits(x.seats)}（${x.seats.length - reds.length} 好 ${reds.length} 壞）`;
    return { letter: x.letter, seats: x.seats, real: x.real, text, reds };
  });
}
