/**
 * 題目卡之後的圖（輪播第二張起），照發文順序：
 *   1. 牌譜的圖 renderGridPngs：`grid-1` 是牌譜卡（整份牌譜的格子，一定有）；一張放不下時後面接續圖（`grid-2`…）；
 *   2. 答案卡 renderAnswerPng：公布完整答案的那天（昨天不是同一局接著打）才有，延續的兩天一起公布。
 * prepareDaily 的 renderExtraImages 用它；題目卡本身（card.ts 的 renderPuzzlePng）由 renderImage 畫。
 */

import type { ThreadsDraft } from '../draft';
import type { ThreadsGenerator } from '../generate';
import { renderAnswerPng } from '../card';
import { renderGridPngs } from '../image';
import { addDays, weekdayOf } from '../plan';

export function extraRenderers(gen: ThreadsGenerator): (date: string, draft: ThreadsDraft) => { suffix: string; png: Buffer | null }[] {
  return (date, draft) => {
    const out: { suffix: string; png: Buffer | null }[] = [];
    const pick = gen.pickFor(date);
    const pv = pick ? gen.viewOf(pick) : null;
    if (pv) renderGridPngs(pv, weekdayOf(date)).forEach((png, i) => out.push({ suffix: `grid-${i + 1}`, png }));
    if (draft.answerToYesterday && !draft.continuesYesterday) {
      const yPick = gen.pickFor(addDays(date, -1));
      const yPv = yPick ? gen.viewOf(yPick) : null;
      if (yPv) {
        const before = yPick?.continues ? gen.pickFor(addDays(date, -2)) : null;
        const earlier = before && before.gameId === yPv.pick.gameId ? gen.viewOf(before) : null;
        const ids = earlier ? [earlier.exerciseId, yPv.exerciseId] : [yPv.exerciseId];
        out.push({ suffix: 'answer', png: renderAnswerPng(yPv, ids, earlier ? { earlier } : {}) });
      }
    }
    return out;
  };
}
