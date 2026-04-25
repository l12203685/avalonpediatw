/**
 * #86 Lobby IA Smoke — 6 主按鈕 IA 結構驗證（v3 — 2026-04-23 拆兩頁）
 *
 * 結構鎖定：
 *   Row 1: 建立房間 / 加入房間 / 數據排行
 *   Row 2: 個人戰績 / 百科攻略 / 系統設定
 *
 * 拆頁決策（2026-04-23）：
 *   - 「數據排行」route → `analytics`（勝率排行 / 雷達 / AI / 深度分析）
 *   - 「個人戰績」route → `personalStats`（= ProfilePage 歷史戰績 + 追蹤 / 對戰成績 placeholder）
 *   - 「系統設定」route → `settings`（基本資料 + 帳號綁定 + 登出）
 *   - FAQ 獨立按鈕取消；FAQ 入口保留在系統設定頁 header
 *
 * 注意：此 spec 被標記 skip 直到登入流程 E2E 基礎建設落地（mock socket + auto-login）。
 * 現階段目的是鎖定 data-testid 命名 + 6 按鈕存在性。
 */

import { test, expect } from '@playwright/test';

test.describe.skip('#86 Lobby IA — 6-button grid', () => {
  test('主頁有 6 個主按鈕', async ({ page }) => {
    await page.goto('/');
    // 登入流程略 — 等 infra 到位時補

    // 6 主按鈕各自 data-testid 都存在
    const testIds = [
      'home-btn-create',
      'home-btn-join',
      'home-btn-stats',
      'home-btn-personal-stats',
      'home-btn-wiki',
      'home-btn-settings',
    ];
    for (const id of testIds) {
      await expect(page.locator(`[data-testid="${id}"]`)).toBeVisible();
    }
  });

  test('數據排行按鈕 → 數據分析頁（tab 預設為 leaderboard）', async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-testid="home-btn-stats"]').click();
    // AnalyticsPage 的主要 heading
    await expect(page.locator('h1', { hasText: '數據分析' })).toBeVisible();
  });

  test('系統設定按鈕 → 系統設定頁 + FAQ 入口', async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-testid="home-btn-settings"]').click();
    // 設定頁 header 應顯示「系統設定」標題
    await expect(page.locator('h1', { hasText: '系統設定' })).toBeVisible();
    // Header 右側 FAQ 按鈕仍存在
    await expect(page.locator('[data-testid="settings-btn-faq"]')).toBeVisible();
  });

  test('個人戰績按鈕 → 個人戰績頁', async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-testid="home-btn-personal-stats"]').click();
    // 個人戰績頁標題
    await expect(page.locator('h1', { hasText: '個人戰績' })).toBeVisible();
    // 內建「數據分析」入口按鈕
    await expect(page.locator('[data-testid="personal-stats-btn-analytics"]')).toBeVisible();
  });

  test('手機視窗 (iPhone SE 375px) 所有按鈕不被截掉', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/');
    const testIds = [
      'home-btn-create',
      'home-btn-join',
      'home-btn-stats',
      'home-btn-personal-stats',
      'home-btn-wiki',
      'home-btn-settings',
    ];
    for (const id of testIds) {
      const el = page.locator(`[data-testid="${id}"]`);
      await expect(el).toBeVisible();
      const box = await el.boundingBox();
      // 按鈕左右邊界都應落在 viewport 內（允許 2px tolerance）
      expect(box!.x).toBeGreaterThanOrEqual(-2);
      expect(box!.x + box!.width).toBeLessThanOrEqual(377);
    }
  });
});
