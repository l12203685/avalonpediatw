import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/game/**', 'src/services/GameStatePersistence.ts', 'src/services/GameHistoryRepository.ts', 'src/routes/api.ts'],
      exclude: ['src/bots/**', 'src/services/firebase.ts', 'src/__tests__/**'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
      },
    },
  },
  resolve: {
    alias: {
      '@avalon/shared': path.resolve(__dirname, '../shared/src'),
    },
  },
});
