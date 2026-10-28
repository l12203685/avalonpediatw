/**
 * 有說明的統計名詞 (Term 元件)：每個 key 在 i18n `statTerms.<key>` 有 name / def (定義) / calc (算法) /
 * meaning (怎麼看)。加新名詞 = 這裡加 key + 兩個語系各加一段。
 */
export const STAT_TERMS = [
  'finalWinRate',
  'expectedWinRate',
  'excessWinRate',
  'redWinRate',
  'blueWinRate',
  'roleTheory',
  'positionTheory',
  'overallTheory',
  'missionWinRate',
  'assassinWinRate',
  'coWin',
  'winCorr',
  'coWinMinusLose',
  'lakeTruth',
  'anomalyVote',
  'topRoleWinRate',
  // 2026-10-28 分析分頁白話化
  'outcomeMix',
  'chiSquare',
  'threeRedRate',
  'killRate',
  'redGameWinRate',
  'missionSuccessRate',
  'failCards',
  'captainFaction',
  'firstProposal',
  'missionPath',
  'lakeCombo',
] as const;

export type StatTermKey = (typeof STAT_TERMS)[number];
