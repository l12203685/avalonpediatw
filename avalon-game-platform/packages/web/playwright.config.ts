import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright E2E config for avalonpediatw web package.
 *
 * Scope: login flows only (LINE / Discord OAuth / Email-Firebase / Guest).
 * OAuth external redirects are intercepted by route mocking — no real
 * LINE or Discord production calls are made.
 *
 * WSL2 browser setup:
 *   The bundled chromium_headless_shell needs libnspr4/libnss3/libasound2 which
 *   are not system-installed in this WSL2. Download and set LD_LIBRARY_PATH:
 *
 *   # One-time setup (run as zero, no sudo needed):
 *   bash packages/web/e2e/setup_libs.sh
 *
 *   # Then run tests:
 *   LD_LIBRARY_PATH=/tmp/chrome_libs \
 *   /home/zero/.npm/_npx/e41f203b7505f1fb/node_modules/.bin/playwright test \
 *   --config=packages/web/playwright.config.ts
 *
 * Usage (CI / pre-installed browser):
 *   pnpm exec playwright test              # headless
 *   pnpm exec playwright test --reporter=html && pnpm exec playwright show-report
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['json', { outputFile: 'playwright-report/results.json' }],
  ],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // Auto-start the Vite dev server when it is not already running.
  // In CI, set PLAYWRIGHT_BASE_URL to a pre-started server and skip this.
  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 120_000,
    cwd: '/mnt/c/Users/admin/workspace/avalonpediatw/packages/web',
  },
});
