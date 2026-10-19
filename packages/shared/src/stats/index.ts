/**
 * 複合篩選的計算引擎（Edward 2026-10-14「我希望所有數據都有可以複合篩選的功能」；設計見 r9 architecture）。
 *
 *   decodeGamesDataset(raw, gamesKey)      games_cache.json → 解碼後的局（與快取不同批時丟錯）
 *   computeStats(decoded, context, filter)  篩選後的 overview / players / playerDetails / leaderboard
 *                                          （沒有篩選時與 analysis_cache.json 逐欄相同）
 *   sanitizeFilter / encodeFilter / decodeFilter / canonicalFilterKey / PRESETS / METRICS
 *
 * 從 '@avalon/shared/stats' 匯入（不經主入口，網站的主程式不會被整個引擎拖大）。
 */
export * from './constants';
export * from './pyround';
export * from './fraction';
export * from './dataset';
export * from './theory';
export * from './players';
export * from './overview';
export * from './leaderboard';
export * from './details';
export * from './missions';
export * from './rounds';
export * from './captain';
export * from './seatOrder';
export * from './voting';
export * from './pairs';
export * from './lake';
export * from './featureL141';
export * from './build';
export * from './parity';
export * from './filter/types';
export * from './filter/predicates';
export * from './filter/metrics';
export * from './filter/apply';
export * from './filter/url';
export * from './filter/presets';
