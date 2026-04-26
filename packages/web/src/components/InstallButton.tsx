// InstallButton — PWA「加到桌面」入口
//
// Edward 2026-04-26 16:42: 一鍵裝 PWA 按鈕，根據瀏覽器能力自動切換行為：
//   - 已裝過（standalone）→ 隱藏
//   - Chrome/Edge/Android（有 deferredPrompt）→ click 直接彈系統 install dialog
//   - iOS Safari → click 開 IOSInstallGuide modal 教手動加
//   - 其他不支援的瀏覽器 → 隱藏（避免按了沒反應）
//
// 放置：HomePage 左上 chip 同區（fixed top-left），與「登入/已登入」chip 並列。

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Smartphone } from 'lucide-react';
import { useInstallPrompt } from '../hooks/useInstallPrompt';
import IOSInstallGuide from './IOSInstallGuide';

interface InstallButtonProps {
  /** Optional className override for layout positioning */
  className?: string;
}

export default function InstallButton({ className }: InstallButtonProps): JSX.Element | null {
  const { t } = useTranslation();
  const { deferredPrompt, isStandalone, isIOS, promptInstall } = useInstallPrompt();
  const [showIosGuide, setShowIosGuide] = useState(false);

  // 已裝過 → 完全隱藏（不阻擋 layout）
  if (isStandalone) return null;

  // Chrome path：有 prompt event 可彈
  const canPromptNatively = deferredPrompt !== null;
  // iOS Safari path：必須走手動指引
  const showIosFallback = isIOS && !canPromptNatively;
  // 都不行 → 不顯示按鈕，避免空 click
  if (!canPromptNatively && !showIosFallback) return null;

  const handleClick = async (): Promise<void> => {
    if (canPromptNatively) {
      const outcome = await promptInstall();
      // outcome === 'accepted' / 'dismissed' / 'unavailable'
      // 不需 toast — 系統 dialog 已是 user feedback；'dismissed' 可能再次出現
      // (Chrome 在 user 互動後可能重新觸發 beforeinstallprompt)
      void outcome;
      return;
    }
    if (showIosFallback) {
      setShowIosGuide(true);
    }
  };

  const label = t('home.installApp', { defaultValue: '安裝 App' });

  return (
    <>
      <button
        type="button"
        onClick={() => { void handleClick(); }}
        data-testid="home-btn-install"
        title={label}
        className={
          className ??
          'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-900/40 border border-emerald-700/50 text-emerald-200 hover:bg-emerald-900/60 hover:text-emerald-100 text-[11px] font-semibold transition-colors'
        }
      >
        <Smartphone size={12} />
        <span>{label}</span>
      </button>

      <IOSInstallGuide isOpen={showIosGuide} onClose={() => setShowIosGuide(false)} />
    </>
  );
}
