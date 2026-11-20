/**
 * 題庫重建時把接下來幾天的 Threads 題目釘住（2026-11-20），純函式。
 *
 * 題庫（sim_bank.json）改成每晚從牌譜總庫重建（scripts/buildSimBank.ts）。自動計畫照題庫的雜湊排序選題
 * （plan.ts），題庫多一局，之後的排序就可能變；可是接下來幾天的第一則留言（docs/threads/comments/<日期>.md）
 * 已經照原本計畫的那一局寫好了。所以重建時：舊題庫照計畫會出的題，新題庫算出來不一樣的日子，把舊的題號寫進
 * threads_picks.json（站長選題同一個檔，主控台看得到），讓那幾天照舊。
 *   - 只釘還沒有選題的日子；已經發出去的日子本來就以 threads-state 存下來的草稿為準，不受影響。
 *   - 週四、週六接前一天同一局的題不用釘（前一天釘住就跟著走）；釘了還是對不上（那一局不在新題庫、或不再是那天
 *     主題能出的題）就不釘，列進 `lost` 讓呼叫的一方報告。
 */

import { ThreadsGenerator, type GenerateBank } from './generate';
import { exerciseIdOfPick } from './plan';
import { pickOverrideOf } from './picksFile';

export interface PlanPinsResult {
  /** 要新增的選題（日期 → 題號）。 */
  pins: Map<string, string>;
  /** 新舊計畫一樣、不用釘的日子數。 */
  same: number;
  /** 對不上又釘不住的日子（舊題號）。 */
  lost: Map<string, string>;
}

function generatorFor(bank: GenerateBank, picks: ReadonlyMap<string, string>, startDate?: string): ThreadsGenerator {
  return new ThreadsGenerator({ bank, titles: new Map(), readSaved: () => null, pickOverride: pickOverrideOf(picks), ...(startDate ? { startDate } : {}) });
}

function exerciseOn(gen: ThreadsGenerator, date: string): { id: string; continues: boolean } | null {
  const pick = gen.pickFor(date);
  const g = pick ? gen.gameOf(pick.gameId) : null;
  return pick && g ? { id: exerciseIdOfPick(pick, g.game), continues: !!pick.continues } : null;
}

export function planPins(
  oldBank: GenerateBank,
  newBank: GenerateBank,
  picks: ReadonlyMap<string, string>,
  dates: readonly string[],
  startDate?: string,
): PlanPinsResult {
  const oldGen = generatorFor(oldBank, picks, startDate);
  const pins = new Map<string, string>();
  const lost = new Map<string, string>();
  let same = 0;
  for (const date of [...dates].sort()) {
    if (picks.has(date)) continue;
    const before = exerciseOn(oldGen, date);
    if (!before) continue;
    const merged = new Map([...picks, ...pins]);
    const now = exerciseOn(generatorFor(newBank, merged, startDate), date);
    if (now?.id === before.id) { same++; continue; }
    if (before.continues) { lost.set(date, before.id); continue; }
    merged.set(date, before.id);
    const pinned = exerciseOn(generatorFor(newBank, merged, startDate), date);
    if (pinned?.id === before.id) pins.set(date, before.id);
    else lost.set(date, before.id);
  }
  return { pins, same, lost };
}
