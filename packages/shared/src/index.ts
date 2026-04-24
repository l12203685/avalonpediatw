// Export all shared types
export * from './types/game';
export * from './types/game_v2';
export * from './types/auth';
export * from './types/database';

// Shared runtime helpers (pure, zero-dep — safe for both web and server).
export * from './tokenUtils';
export * from './game_v2_adapter';

// V2 派生指標 + i18n（Phase 2b）
export * from './derived/gameMetrics';
export * from './i18n/winReason.zh';
