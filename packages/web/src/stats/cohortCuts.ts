/**
 * 分組（九宮格）的四個切點（Edward 2026-11-11「這個也可以做成參數可調整嗎?」）：玩家 PR 的上下切點（強者／一般人／新手，
 * 預設 80／20）與桌 S 的上下切點（高端／普通／歡樂，預設 55／38）。定義與驗證在 @avalon/shared stats/cohort.ts。
 *
 * - 全站一份 (zustand)：每個九宮格、分組表、玩家雷達「跟自己的組比」都讀這裡，改一個地方全部跟著換。
 * - 每位訪客自己記住 (localStorage，讀寫失敗 = 只在這次有效、回到預設)。
 * - 跟著分享連結：不是預設時網址列的 #stats?…&c=80-20-55-38 (stats/sharedFilter.ts)。打開分享連結 = 看到分享的人的切點
 *   (沒有 c= 的連結 = 分享的人用預設)，但只在這次有效 (applyLinkCuts，不寫 localStorage)，不會蓋掉訪客自己記住的切點；
 *   訪客自己改切點或按回預設才記住。
 * - 切點不是篩選：只影響分組怎麼切，不改任何人的數字，不進篩選的標準鍵 (換切點不重算其他區塊)。
 */
import { create } from 'zustand';
import { DEFAULT_COHORT_CUTS, decodeCohortCuts, encodeCohortCuts, validCohortCuts, type CohortCuts } from '@avalon/shared/stats';

export const COHORT_CUTS_STORAGE_KEY = 'avalon.stats.cohortCuts';

function readCuts(): CohortCuts {
  try {
    return decodeCohortCuts(window.localStorage.getItem(COHORT_CUTS_STORAGE_KEY)) ?? { ...DEFAULT_COHORT_CUTS };
  } catch {
    return { ...DEFAULT_COHORT_CUTS };
  }
}

function writeCuts(cuts: CohortCuts): void {
  try {
    window.localStorage.setItem(COHORT_CUTS_STORAGE_KEY, encodeCohortCuts(cuts));
  } catch {
    // 私密視窗等：不記也沒關係
  }
}

export interface CohortCutsState {
  cuts: CohortCuts;
  /** 不合法的切點 (上 ≤ 下、超出 1–99…) 不會套用，回傳 false。 */
  setCuts: (cuts: CohortCuts) => boolean;
  reset: () => void;
  /** 分享連結的切點 (null = 連結沒帶 c=、分享的人用預設)：只在這次有效，不記住。 */
  applyLinkCuts: (cuts: CohortCuts | null) => boolean;
}

export const useCohortCuts = create<CohortCutsState>((set) => ({
  cuts: readCuts(),
  setCuts: (cuts: CohortCuts): boolean => {
    if (!validCohortCuts(cuts)) return false;
    const next = { prHi: cuts.prHi, prLo: cuts.prLo, sHi: cuts.sHi, sLo: cuts.sLo };
    writeCuts(next);
    set({ cuts: next });
    return true;
  },
  reset: (): void => {
    writeCuts({ ...DEFAULT_COHORT_CUTS });
    set({ cuts: { ...DEFAULT_COHORT_CUTS } });
  },
  applyLinkCuts: (cuts: CohortCuts | null): boolean => {
    const next = cuts ?? DEFAULT_COHORT_CUTS;
    if (!validCohortCuts(next)) return false;
    set({ cuts: { prHi: next.prHi, prLo: next.prLo, sHi: next.sHi, sLo: next.sLo } });
    return true;
  },
}));

/** 分享連結的參數 (不是預設時「80-20-55-38」，預設 = null)。 */
export function cohortCutsParam(cuts: CohortCuts): string | null {
  const d = DEFAULT_COHORT_CUTS;
  return cuts.prHi === d.prHi && cuts.prLo === d.prLo && cuts.sHi === d.sHi && cuts.sLo === d.sLo ? null : encodeCohortCuts(cuts);
}
