/**
 * Threads 選局（2026-11-17）— 未來幾週每天的題目與候選名單，給站長的選局頁用。
 *
 * Edward 2026-11-17：「我如果需要 看到未來一週 甚至一個月的文章安排 並且我可以自己選擇牌譜
 * (從候選名單中挑 盡量是S高一點的優先)」。S = 網站的陣容強度（strength.ts）。
 * 每一天：目前的題目（已經貼出去／站長選的／接前一天的／照計畫），加上照 S 由高到低排的候選。
 * 只有座位、角色、題號和網站牌譜連結，沒有玩家名字；題庫本來就不含模擬的局。
 */

import { ROLE_ZH } from '../simulation/commands';
import { recordUrl } from '../simulation/recordsIndex';
import { seatLabel } from '../simulation/replies';
import type { SimGame } from '../simulation/scenario';
import type { ThreadsGenerator, ThreadsOption } from './generate';
import { HIGH_LINEUP_S, lineupOf } from './strength';
import { addDays, dayNumber, exerciseIdOfPick, labelFor, themeOf, weekdayOf, type ThreadsPick } from './plan';

export interface CandidateRow {
  exerciseId: string;
  /** 陣容強度；對不上或不評分是 null。 */
  s: number | null;
  /** S ≥ 65（網站的高強度）。 */
  high: boolean;
  seat: string;
  role: string;
  /** 一句話的局面。 */
  situation: string;
  recordUrl: string | null;
  /** 選了這一局，隔天自動接同一局。 */
  chained: boolean;
  nextExerciseId: string | null;
}

export interface DayPlan {
  date: string;
  weekday: number;
  label: string;
  /** 已經貼出去或已經過了：不能再選。 */
  locked: boolean;
  /** 目前的題目從哪裡來。 */
  source: 'picked' | 'chain' | 'auto' | 'none';
  current: CandidateRow | null;
  /** 選了這一天以外的局，週四／週六就不接前一天（說明用）。 */
  breaksChain: boolean;
  candidates: CandidateRow[];
}

function roundsBefore(game: SimGame, round: number): string {
  const r = game.quests.filter((q) => q.round < round).map((q) => (q.failed ? 'x' : 'o')).join('');
  return r ? `前面任務 ${r}` : '第一局';
}

/** 一句話的局面（不劇透：不寫結果、不寫別人的角色）。 */
export function situationOf(game: SimGame, pick: ThreadsPick): string {
  if (pick.proposal === null) return `三藍，${seatLabel(pick.seat)}刺客要找梅林`;
  const p = game.proposals[pick.proposal];
  const forced = p.attempt === 5 ? '（強制出發）' : '';
  return `第 ${p.round} 局第 ${p.attempt} 次${forced}，${roundsBefore(game, p.round)}`;
}

export interface CandidatesDeps {
  gen: ThreadsGenerator;
  lineup: ReadonlyMap<string, number>;
  /** 今天（台北日期）：今天和之前的日子鎖住。 */
  today: string;
  /** 站長選的（日期 → 題號），用來標 source = picked。 */
  picked?: ReadonlyMap<string, string>;
}

function idOf(deps: CandidatesDeps, pick: ThreadsPick): string | null {
  const g = deps.gen.gameOf(pick.gameId);
  return g ? exerciseIdOfPick(pick, g.game) : null;
}

function rowOf(deps: CandidatesDeps, pick: ThreadsPick, extra: Partial<ThreadsOption> = {}): CandidateRow | null {
  const g = deps.gen.gameOf(pick.gameId);
  if (!g) return null;
  const s = lineupOf(g.game, deps.lineup);
  const rid = deps.gen.recordIdOf(pick.gameId);
  return {
    exerciseId: exerciseIdOfPick(pick, g.game),
    s,
    high: s !== null && s >= HIGH_LINEUP_S,
    seat: seatLabel(pick.seat),
    role: ROLE_ZH[g.game.seatRoles[pick.seat - 1]],
    situation: situationOf(g.game, pick),
    recordUrl: rid ? recordUrl(rid) : null,
    chained: !!extra.chained,
    nextExerciseId: extra.nextExerciseId ?? null,
  };
}

/** S 高的在前；沒有 S 的在後；同分時有網站牌譜的在前，再照題號。 */
export function byStrength(a: CandidateRow, b: CandidateRow): number {
  const sa = a.s ?? -1;
  const sb = b.s ?? -1;
  if (sa !== sb) return sb - sa;
  if (!!a.recordUrl !== !!b.recordUrl) return a.recordUrl ? -1 : 1;
  return a.exerciseId < b.exerciseId ? -1 : a.exerciseId > b.exerciseId ? 1 : 0;
}

/**
 * 從 start 起連續 days 天的計畫。候選只列藍方視角（忠臣、派西、梅林；刺殺題是刺客），
 * 照 S 由高到低取 top 個，再補最多 extraLinked 個有網站牌譜頁、S 最高的（答案才附得上牌譜連結）。
 */
export function planDays(deps: CandidatesDeps, start: string, days: number, top = 15, extraLinked = 5): DayPlan[] {
  const out: DayPlan[] = [];
  for (let i = 0; i < days; i++) {
    const date = addDays(start, i);
    const wd = weekdayOf(date);
    const pick = deps.gen.pickFor(date);
    const theme = themeOf(wd);
    let source: DayPlan['source'] = 'none';
    if (pick) {
      if (deps.picked?.get(date) && deps.picked.get(date) === idOf(deps, pick)) source = 'picked';
      else if (pick.continues) source = 'chain';
      else source = 'auto';
    }
    const all = deps.gen
      .optionsFor(date)
      .filter((o) => o.tier <= 1)
      .map((o) => rowOf(deps, o.pick, o))
      .filter((r): r is CandidateRow => r !== null)
      .sort(byStrength);
    const candidates = all.slice(0, top);
    candidates.push(...all.slice(top).filter((r) => r.recordUrl).slice(0, extraLinked));
    out.push({
      date,
      weekday: wd,
      label: pick ? labelFor(wd, pick) : theme.label,
      locked: dayNumber(date) <= dayNumber(deps.today),
      source,
      current: pick ? rowOf(deps, pick) : null,
      breaksChain: !!theme.continues,
      candidates,
    });
  }
  return out;
}
