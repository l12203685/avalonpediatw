/**
 * Threads 選局（2026-11-17）— 一局一列的牌譜表，給站長在選局頁用條件篩局。
 *
 * Edward 2026-11-17：「不能先用條列式表格呈現牌譜就好嗎 (像googlesheet 那樣) 我可以先用條件來篩出自己想要的
 * 欄位可能是 第一局~第五局任務結果… 5家身分/0家身分/派西維爾位置/派西維爾資訊 類似這樣 可以方便篩選」。
 * 這頁只有站長自己看（選局用），所以結果、角色都直接列出來；沒有玩家名字，題庫本來就不含模擬的局。
 * 每一列也列出這局能出哪幾種題目（跟產生器同一套池子），選局頁只讓它選主題對得上的日子。
 */

import type { Role } from '@avalon/shared';
import { recordUrl } from '../simulation/recordsIndex';
import { seatChar } from '../simulation/seats';
import type { SimGame } from '../simulation/scenario';
import { ROLE_ZH } from '../simulation/commands';
import type { ThreadsGenerator } from './generate';
import { addDays, weekdayOf, type PoolName } from './plan';
import { HIGH_LINEUP_S, lineupOf } from './strength';

/** 角色代碼字（百科的「刺7娜5莫3奧9派2梅1」）。 */
export const ROLE_CHAR: Readonly<Record<Role, string>> = {
  merlin: '梅', percival: '派', loyal: '忠', assassin: '刺', morgana: '娜', mordred: '莫', oberon: '奧', minion: '爪',
};

/** 池子 → 表上的題型名稱。 */
export const POOL_LABEL: Readonly<Record<PoolName, string>> = {
  assassin: '刺殺',
  percival: '派西',
  wedThu: '1-5→3-5',
  wed: '1-5',
  thu: '3-5',
  friSat: '2-5→4-5',
  fri: '2-5',
  sat: '第4局忠臣5人',
  final: '第5局',
};

export interface GameType {
  pool: PoolName;
  label: string;
  /** 能選的星期（0 = 週日）。 */
  weekday: number;
  exerciseId: string;
  nextExerciseId: string | null;
  seat: string;
  role: string;
  /** 0 忠臣／派西、1 梅林、2 紅方視角。 */
  tier: number;
}

export interface GameRow {
  id: string;
  s: number | null;
  high: boolean;
  url: string | null;
  /** 第 1–5 局任務結果（成功張數 o、失敗張數 x）；沒打到的局是 ''。 */
  m: string[];
  /** 三紅／三藍死／三藍活。 */
  res: string;
  /** 刺殺的座位（三藍才有）。 */
  kill: string;
  /** 座位 1..9、0 的角色代碼字。 */
  roles: string[];
  percival: string;
  /** 派西維爾看到的兩根拇指（梅林、莫甘娜的座位）。 */
  thumbs: string;
  merlin: string;
  /** 湖：持湖>目標＋宣告（o 好、x 壞、? 沒宣告）。 */
  lake: string;
  types: GameType[];
}

function seatOf(game: SimGame, role: Role): number {
  return game.seatRoles.indexOf(role) + 1;
}

function resultOf(game: SimGame): string {
  if (game.quests.filter((q) => q.failed).length >= 3) return '三紅';
  return game.winner === 'evil' ? '三藍死' : '三藍活';
}

export function gameRow(game: SimGame, lineup: ReadonlyMap<string, number>, recordId: string | undefined, types: GameType[]): GameRow {
  const s = lineupOf(game, lineup);
  const m = [1, 2, 3, 4, 5].map((r) => {
    const q = game.quests.find((x) => x.round === r);
    return q ? 'o'.repeat(q.successCount) + 'x'.repeat(q.failCount) : '';
  });
  const thumbs = [seatOf(game, 'merlin'), seatOf(game, 'morgana')].filter((x) => x > 0).sort((a, b) => (a === 10 ? 11 : a) - (b === 10 ? 11 : b));
  const percival = seatOf(game, 'percival');
  const merlin = seatOf(game, 'merlin');
  return {
    id: game.id,
    s,
    high: s !== null && s >= HIGH_LINEUP_S,
    url: recordId ? recordUrl(recordId) : null,
    m,
    res: resultOf(game),
    kill: game.assassinTargetSeat ? seatChar(game.assassinTargetSeat) : '',
    roles: game.seatRoles.map((r) => ROLE_CHAR[r]),
    percival: percival > 0 ? seatChar(percival) : '',
    thumbs: thumbs.map(seatChar).join(' '),
    merlin: merlin > 0 ? seatChar(merlin) : '',
    lake: game.lakes.map((l) => `${seatChar(l.holderSeat)}>${seatChar(l.targetSeat)}${l.claim === 'good' ? 'o' : l.claim === 'evil' ? 'x' : '?'}`).join(' '),
    types,
  };
}

/** 題庫每一局一列（S 高的在前），附上它能出的題型（跟產生器的池子一樣）。 */
export function gamesTable(gen: ThreadsGenerator, lineup: ReadonlyMap<string, number>, anyDate: string): GameRow[] {
  const types = new Map<string, GameType[]>();
  for (let i = 0; i < 7; i++) {
    const date = addDays(anyDate, i);
    const wd = weekdayOf(date);
    for (const o of gen.optionsFor(date)) {
      const g = gen.gameOf(o.pick.gameId);
      if (!g) continue;
      const list = types.get(o.pick.gameId) ?? [];
      list.push({
        pool: o.pool,
        label: POOL_LABEL[o.pool],
        weekday: wd,
        exerciseId: o.exerciseId,
        nextExerciseId: o.nextExerciseId ?? null,
        seat: `${seatChar(o.pick.seat)}家`,
        role: ROLE_ZH[g.game.seatRoles[o.pick.seat - 1]],
        tier: o.tier,
      });
      types.set(o.pick.gameId, list);
    }
  }
  const rows: GameRow[] = [];
  for (const gameId of gen.gameIndex().keys()) {
    const game = gen.gameOf(gameId)?.game;
    if (game) rows.push(gameRow(game, lineup, gen.recordIdOf(gameId), types.get(gameId) ?? []));
  }
  return rows.sort((a, b) => (b.s ?? -1) - (a.s ?? -1) || (a.id < b.id ? -1 : 1));
}
