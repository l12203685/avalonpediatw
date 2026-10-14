// Export all shared types
export * from './types/game';
export * from './types/game_v2';
export * from './types/auth';
export * from './types/database';

// Shared runtime helpers (pure, zero-dep — safe for both web and server).
export * from './tokenUtils';
export * from './game_v2_adapter';
export * from './playPlatform';
export * from './playerNameMatch';

// V2 派生指標 + i18n（Phase 2b）
export * from './derived/gameMetrics';
export * from './derived/roleProbability';
// 三塊結果 (任務結果 / 刺殺結果 / 遊戲結果) — docs/stats/two_stage_outcome.md
export * from './derived/outcomeBlocks';
export * from './derived/playerVoting';
export * from './i18n/winReason.zh';
export * from './i18n/eloTag.zh';

// V2 Phase 2c — V1→V2 converter
export * from './derived/v1ToV2Converter';
