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
  // 2026-10-30 網站唯一的 Elo (generate_cache.py compute_rating)
  'elo',
  'eloModelTheory',
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
  'evilTeamReject',
  'goodTeamApprove',
  'r3Reject',
  'flipRate',
  'signedEv',
  // 2026-11-11 玩家雷達「兩紅之後」：兩紅之後藍方隊長派出的隊（@avalon/shared stats/twoRed.ts）
  'twoRedAllGood',
  'twoRedMordred',
  'twoRedThumb',
  'twoRedOneThumb',
  'twoRedTwoPlus',
  // 2026-11-11 數據排行「關鍵外白／內黑」：真的決定了提議過不過的藍方投票（@avalon/shared stats/decisiveVotes.ts）
  'decisiveVote',
  'decisiveAccuracy',
  // 分組的「全部投票」：同樣的對錯算法套在每一張藍方票（DecisiveCohortView）
  'allVoteAccuracy',
  'decisiveShrunk',
  'decisiveOnYes',
  'decisiveOnNo',
  'decisiveOffYes',
  'decisiveOffNo',
  'decisiveNeutral',
  'decisiveYesRate',
  'decisiveNoRate',
  'decisivePerChance',
  'decisiveOnShare',
] as const;

export type StatTermKey = (typeof STAT_TERMS)[number];
