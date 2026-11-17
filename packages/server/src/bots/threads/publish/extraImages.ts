/**
 * 題目卡之後的圖（輪播第二、三張），照發文順序：
 *   1. 牌譜續圖 renderGridPngs：題目那一局的牌譜放不進題目卡時才有（`grid-1`、`grid-2`…）；
 *   2. 前面幾局的回顧圖 renderRoundPngs：一局一張（`round-1`、`round-2`…；站長 11/18「每一局都只呈現該局的表格 & 湖中」）；
 *   3. 答案卡 renderAnswerPng：公布完整答案的那天（昨天不是同一局接著打）才有，延續的兩天一起公布。
 * prepareDaily 的 renderExtraImages 用它；題目卡本身由 renderImage 畫。
 */

import type { ThreadsDraft } from '../draft';
import type { ThreadsGenerator } from '../generate';
import { renderAnswerPng, renderGridPngs, renderRoundPngs } from '../image';
import { addDays, weekdayOf } from '../plan';

export function extraRenderers(gen: ThreadsGenerator): (date: string, draft: ThreadsDraft) => { suffix: string; png: Buffer | null }[] {
  return (date, draft) => {
    const out: { suffix: string; png: Buffer | null }[] = [];
    const pick = gen.pickFor(date);
    const pv = pick ? gen.viewOf(pick) : null;
    if (pv) renderGridPngs(pv, weekdayOf(date)).forEach((png, i) => out.push({ suffix: `grid-${i + 1}`, png }));
    if (pv) for (const { round, png } of renderRoundPngs(pv, weekdayOf(date))) out.push({ suffix: `round-${round}`, png });
    if (draft.answerToYesterday && !draft.continuesYesterday) {
      const yPick = gen.pickFor(addDays(date, -1));
      const yPv = yPick ? gen.viewOf(yPick) : null;
      if (yPv) {
        const before = yPick?.continues ? gen.pickFor(addDays(date, -2)) : null;
        const ids = before && before.gameId === yPv.pick.gameId ? [gen.viewOf(before)?.exerciseId, yPv.exerciseId].filter((x): x is string => !!x) : [yPv.exerciseId];
        out.push({ suffix: 'answer', png: renderAnswerPng(yPv, ids) });
      }
    }
    return out;
  };
}
