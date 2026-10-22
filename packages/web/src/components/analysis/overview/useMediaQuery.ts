import { useCallback, useSyncExternalStore } from 'react';

/**
 * CSS media query 的布林值，視窗大小改變時跟著更新 (2026-10-14 總覽：桌機三表並排、手機改小分頁，
 * 只畫其中一種，不用 CSS 把兩份都掛在頁面上 — 圓餅與表格各畫兩次太重，小分頁的狀態也會分岔)。
 * 沒有 matchMedia 的環境 (伺服器端、舊測試環境) 回 `fallback`；舊 Safari 只有 addListener 也照樣訂閱。
 */
export function useMediaQuery(query: string, fallback = true): boolean {
  const supported = typeof window !== 'undefined' && typeof window.matchMedia === 'function';
  const subscribe = useCallback((onChange: () => void): (() => void) => {
    if (!supported) return () => undefined;
    const mql = window.matchMedia(query);
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    }
    mql.addListener(onChange);
    return () => mql.removeListener(onChange);
  }, [query, supported]);
  const read = (): boolean => (supported ? window.matchMedia(query).matches : fallback);
  return useSyncExternalStore(subscribe, read, () => fallback);
}
