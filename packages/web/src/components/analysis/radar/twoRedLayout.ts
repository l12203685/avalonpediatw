/**
 * 玩家雷達「兩紅之後」的版面常數（TwoRedPanel；測試直接讀這裡）。欄（每一局的分類）在 @avalon/shared TWO_RED_CATEGORIES。
 */
import type { TwoRedCategory } from '@avalon/shared/stats';

/** 次數低於這個值的格變淡（4 次以下，一次就差 25 個百分點以上）。 */
export const TWO_RED_MIN_N = 5;

/** 每一欄的統計名詞（statTerms.ts；表頭的滑鼠提示）。 */
export const TWO_RED_TERMS = {
  allGood: 'twoRedAllGood',
  mordred: 'twoRedMordred',
  thumb: 'twoRedThumb',
  oneThumb: 'twoRedOneThumb',
  twoPlusRed: 'twoRedTwoPlus',
} as const satisfies Record<TwoRedCategory, string>;

/** 每一欄的色調：全好藍、只有莫德雷德中性、有拇指／兩壞紅。 */
export const TWO_RED_TONES = {
  allGood: 'blue',
  mordred: 'amber',
  thumb: 'red',
  oneThumb: 'red',
  twoPlusRed: 'red',
} as const satisfies Record<TwoRedCategory, string>;
