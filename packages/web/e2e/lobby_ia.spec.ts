/**
 * #86 Lobby IA Smoke — 6 主按鈕 IA 結構驗證（v2 — 2026-04-22 urgent）
 *
 * 結構鎖定：
 *   Row 1: 建立房間 / 加入房間 / 數據排行
 *   Row 2: 個人資訊 / 百科攻略 / 系統設定
 *
 * 整合決策（hotfix 2026-04-22）：
 *   - 「數據排行」（原「戰績」）route 改指 `analytics`（勝率排行 / 雷達 / AI / 深度分析）
 *   - 「個人資訊」→ 資料設定頁（基本資料 + 綁定區塊）
 *   - 「系統設定」→ 資料設定頁（歷史/追蹤/登出區塊；命名區分「個人」/「系統」）
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

  test('數據排行按鈕 → 數據分析頁（tab 預設為 leaderboard）', async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-testid="home-btn-stats"]').click();
    // AnalyticsPage 的主要 heading
    await expect(page.locator('h1', { hasText: '數據分析' })).toBeVisible();
  });

  test('系統設定按鈕 → 資料設定頁 + FAQ 入口', async ({ page }) => {
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

  test('手機視窗 (iPhone SE 375px) 所有按鈕不被截掉', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/');
    const testIds = [
      'home-btn-create',
      'home-btn-join',
      'home-btn-stats',
      'home-btn-profile',
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
