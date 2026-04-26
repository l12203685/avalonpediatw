// ForceUpdateButton — 「更新版本重新登入」清快取按鈕
//
// Edward 2026-04-26 16:46 final spec:
//   - HomePage 左上 chip 區，與 InstallButton 並列
//   - 按下：清 SW registrations + Cache API + localStorage + sessionStorage
//     + 同域 cookies → hard reload
//   - 永遠顯示（無條件渲染）
//   - 文案明示「重新登入」防誤點 (Edward「為什麼這樣命名」原因)

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';

interface ForceUpdateButtonProps {
  /** Optional className override for layout positioning */
  className?: string;
}

async function forceUpdate(): Promise<void> {
  // 1. SW unregister — 移除背景 SW，下次 reload 會重註冊新版
  if ('serviceWorker' in navigator) {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((r) => r.unregister()));
  }

  // 2. Cache API — 清 vite-plugin-pwa precache (workbox)
  if ('caches' in window) {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
  }

  // 3. localStorage / sessionStorage — 包含 auth token、Zustand persist 等
  localStorage.clear();
  sessionStorage.clear();

  // 4. Cookies (同域) — 對 path=/ 設 expires 過期清掉
  document.cookie.split(';').forEach((c) => {
    document.cookie = c
      .replace(/^ +/, '')
      .replace(/=.*/, `=;expires=${new Date().toUTCString()};path=/`);
  });

  // 5. Hard reload — 強制重新從 server 拉
  window.location.reload();
}

export default function ForceUpdateButton({ className }: ForceUpdateButtonProps): JSX.Element {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);

  const label = t('home.forceUpdate', { defaultValue: '更新版本重新登入' });
  const confirmText = t('home.forceUpdateConfirm', {
    defaultValue: '確定要清除快取並重新登入嗎？',
  });

  const handleClick = async (): Promise<void> => {
    if (busy) return;
    if (!window.confirm(confirmText)) return;
    setBusy(true);
    try {
      await forceUpdate();
    } catch (error: unknown) {
      // 即使中間失敗也嘗試 reload，確保 user 看到結果
      if (error instanceof Error) {
        window.console.warn('ForceUpdate failed:', error.message);
      }
      window.location.reload();
    }
  };

  return (
    <button
      type="button"
      onClick={() => {
        void handleClick();
      }}
      disabled={busy}
      data-testid="home-btn-force-update"
      title={label}
      className={
        className ??
        'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-orange-900/40 border border-orange-700/50 text-orange-200 hover:bg-orange-900/60 hover:text-orange-100 text-[11px] font-semibold transition-colors disabled:opacity-50 disabled:cursor-wait'
      }
    >
      <RefreshCw size={12} className={busy ? 'animate-spin' : ''} />
      <span>{label}</span>
    </button>
  );
}
