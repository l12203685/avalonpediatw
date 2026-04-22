/**
 * #86 Lobby IA Smoke — 6 主按鈕 IA 結構驗證
 *
 * 結構鎖定：
 *   Row 1: 開房 / 加入 / 戰績
 *   Row 2: 個人資訊 / 百科 / 設定
 *
 * 整合決策：
 *   - 戰績按鈕 → 戰績頁（header 右側帶數據分析入口）
 *   - 個人資訊、設定 皆 route 到 資料設定頁（settings 頁內依區塊區分）
 *   - FAQ 獨立按鈕已取消；FAQ 入口搬到 資料設定頁 header
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
      'home-btn-profile',
      'home-btn-wiki',
      'home-btn-settings',
    ];
    for (const id of testIds) {
      await expect(page.locator(`[data-testid="${id}"]`)).toBeVisible();
    }
  });

  test('戰績按鈕 → 戰績頁 + 數據分析入口', async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-testid="home-btn-stats"]').click();
    // 戰績頁 header 右側應出現數據分析按鈕
    await expect(page.locator('[data-testid="profile-btn-analysis"]')).toBeVisible();
  });

  test('設定按鈕 → 資料設定頁 + FAQ 入口', async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-testid="home-btn-settings"]').click();
    // 設定頁 header 右側應出現 FAQ 按鈕
    await expect(page.locator('[data-testid="settings-btn-faq"]')).toBeVisible();
  });

  test('個人資訊按鈕 → 資料設定頁', async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-testid="home-btn-profile"]').click();
    // 資料設定頁標題
    await expect(page.locator('h1', { hasText: '資料設定' })).toBeVisible();
  });
});
